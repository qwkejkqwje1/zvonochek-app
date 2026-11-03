package com.zvonochek.app

import android.Manifest
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.OpenableColumns
import android.provider.Settings
import android.webkit.WebView
import androidx.activity.result.ActivityResult
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

/**
 * Мост ядра (app/src/android.rs) к Android: служба ожидания звонков, уведомление о входящем, выбор и открытие файлов,
 * перезапуск. Команды вызывает только Rust (не страницы).
 */
@TauriPlugin
class ZvPlugin(private val activity: Activity) : Plugin(activity) {
  private val ctx: Context = activity.applicationContext
  private val main = Handler(Looper.getMainLooper())

  private fun visible(): Boolean =
    ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)

  private fun ui(f: () -> Unit) = main.post { f() }

  override fun load(webView: WebView) {
    ui { askNotifications() }
  }

  /** Android 13+: без разрешения не будет ни уведомления о входящем, ни о сообщениях. */
  private fun askNotifications(): Boolean {
    if (Build.VERSION.SDK_INT < 33) return true
    if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return true
    val a = MainActivity.current ?: return false
    ActivityCompat.requestPermissions(a, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 7101)
    return false
  }

  /** Один раз: попросить не ограничивать работу в фоне (иначе в глубоком сне звонки могут не дойти). */
  private fun askBatteryOnce() {
    if (Build.VERSION.SDK_INT < 23) return
    val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
    if (pm.isIgnoringBatteryOptimizations(ctx.packageName)) return
    val prefs = ctx.getSharedPreferences("zvonochek", Context.MODE_PRIVATE)
    if (prefs.getBoolean("askedBattery", false)) return
    val a = MainActivity.current ?: return
    prefs.edit().putBoolean("askedBattery", true).apply()
    try {
      @Suppress("BatteryLife")
      a.startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + ctx.packageName)))
    } catch (e: Exception) {
      android.util.Log.w("ZVONochek", "battery: $e")
    }
  }

  /** Старые копии выбранных файлов (отправка давно закончилась). */
  private fun cleanPicked() {
    val dir = File(ctx.cacheDir, "picked")
    val old = System.currentTimeMillis() - 3L * 24 * 3600 * 1000
    dir.listFiles()?.filter { it.lastModified() < old }?.forEach { it.deleteRecursively() }
  }

  @Command
  fun startService(invoke: Invoke) {
    ZvService.start(ctx)
    ui {
      // сначала разрешение на уведомления, просьба о фоне — при следующем запуске
      if (askNotifications()) askBatteryOnce()
    }
    Thread { cleanPicked() }.start()
    invoke.resolve()
  }

  /** Кнопка «Работа в фоне»: системный запрос «без ограничений батареи» или настройки приложения. */
  @Command
  fun backgroundSettings(invoke: Invoke) {
    ui {
      val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
      val pkg = Uri.parse("package:" + ctx.packageName)
      val i = if (Build.VERSION.SDK_INT >= 23 && !pm.isIgnoringBatteryOptimizations(ctx.packageName)) {
        @Suppress("BatteryLife")
        Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, pkg)
      } else {
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg)
      }
      try {
        val a = MainActivity.current
        if (a != null) a.startActivity(i) else ctx.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        invoke.resolve()
      } catch (e: Exception) {
        invoke.reject(e.message ?: "Не открылось")
      }
    }
  }

  @Command
  fun stopService(invoke: Invoke) {
    ZvService.inCall = false
    ZvService.cancelIncoming(ctx)
    ZvService.stop(ctx)
    invoke.resolve()
  }

  @Command
  fun bringToFront(invoke: Invoke) {
    try {
      ctx.startActivity(
        Intent(ctx, MainActivity::class.java)
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
      )
    } catch (e: Exception) {
      android.util.Log.w("ZVONochek", "bringToFront: $e")
    }
    invoke.resolve()
  }

  @Command
  fun incoming(invoke: Invoke) {
    val a = invoke.getArgs()
    val title = a.getString("title", "Входящий звонок") ?: "Входящий звонок"
    val text = a.getString("text", "") ?: ""
    val id = a.getString("callId", "") ?: ""
    ui {
      // приложение на экране — звонит карточка в оболочке; иначе (или поверх идущего звонка) — уведомление
      if (!visible() || ZvService.inCall) ZvService.showIncoming(ctx, title, text, id)
    }
    invoke.resolve()
  }

  @Command
  fun incomingDone(invoke: Invoke) {
    ZvService.cancelIncoming(ctx)
    ui { if (!ZvService.inCall) MainActivity.current?.setOverLock(false) }
    invoke.resolve()
  }

  @Command
  fun callState(invoke: Invoke) {
    val active = invoke.getArgs().getBoolean("active", false) ?: false
    ZvService.inCall = active
    ZvService.cancelIncoming(ctx)
    ZvService.start(ctx)
    if (!active) ui { MainActivity.current?.setOverLock(false) }
    invoke.resolve()
  }

  override fun onResume() {
    // окно на экране: звонит карточка в нём, уведомление с мелодией больше не нужно
    ZvService.cancelIncoming(ctx)
    // во время звонка могли разрешить микрофон/камеру — обновить тип службы
    if (ZvService.inCall) ZvService.start(ctx)
  }

  // ---------- файлы ----------

  @Command
  fun pickFiles(invoke: Invoke) {
    val multiple = invoke.getArgs().getBoolean("multiple", true) ?: true
    val i = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      type = "*/*"
      putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple)
    }
    startActivityForResult(invoke, i, "picked")
  }

  @ActivityCallback
  fun picked(invoke: Invoke, result: ActivityResult) {
    val data = result.data
    val uris = ArrayList<Uri>()
    if (result.resultCode == Activity.RESULT_OK && data != null) {
      val clip = data.clipData
      if (clip != null) for (k in 0 until clip.itemCount) clip.getItemAt(k).uri?.let { uris.add(it) }
      if (uris.isEmpty()) data.data?.let { uris.add(it) }
    }
    // ядру нужны обычные пути: копии в кэше приложения (в фоне — файлы бывают большими)
    Thread {
      val out = JSArray()
      try {
        val dir = File(ctx.cacheDir, "picked/" + System.currentTimeMillis())
        for (u in uris) {
          dir.mkdirs()
          val f = freeName(dir, safeName(displayName(u) ?: "file"))
          ctx.contentResolver.openInputStream(u)?.use { inp -> f.outputStream().use { inp.copyTo(it, 256 * 1024) } }
          out.put(f.absolutePath)
        }
        val r = JSObject()
        r.put("paths", out)
        invoke.resolve(r)
      } catch (e: Exception) {
        invoke.reject("Не удалось прочитать файл: ${e.message}")
      }
    }.start()
  }

  private fun displayName(u: Uri): String? {
    try {
      ctx.contentResolver.query(u, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
        if (c.moveToFirst()) {
          val i = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
          if (i >= 0) return c.getString(i)
        }
      }
    } catch (e: Exception) {
      android.util.Log.w("ZVONochek", "имя файла: $e")
    }
    return u.lastPathSegment?.substringAfterLast('/')
  }

  private fun safeName(n: String): String {
    val s = n.replace(Regex("[\\\\/:*?\"<>|\\u0000-\\u001f]"), "_").trim().trimStart('.')
    return if (s.isEmpty()) "file" else s.take(120)
  }

  private fun freeName(dir: File, name: String): File {
    var f = File(dir, name)
    if (!f.exists()) return f
    val dot = name.lastIndexOf('.').takeIf { it > 0 } ?: name.length
    var n = 2
    while (f.exists()) {
      f = File(dir, name.substring(0, dot) + " ($n)" + name.substring(dot))
      n++
    }
    return f
  }

  @Command
  fun openFile(invoke: Invoke) = view(invoke, false)

  @Command
  fun shareFile(invoke: Invoke) = view(invoke, true)

  /** Открыть в подходящем приложении или «Поделиться» (сохранить в «Файлы», отправить) — через FileProvider. */
  private fun view(invoke: Invoke, share: Boolean) {
    val a = invoke.getArgs()
    val f = File(a.getString("path", "") ?: "")
    if (!f.isFile) {
      invoke.reject("Файл не найден")
      return
    }
    val uri = try {
      FileProvider.getUriForFile(ctx, ctx.packageName + ".fileprovider", f)
    } catch (e: IllegalArgumentException) {
      invoke.reject("Этот файл нельзя открыть")
      return
    }
    var mime = a.getString("mime", "*/*") ?: "*/*"
    if (mime == "*/*") mime = ctx.contentResolver.getType(uri) ?: "*/*"
    val i = if (share) {
      val send = Intent(Intent.ACTION_SEND).apply {
        type = mime
        putExtra(Intent.EXTRA_STREAM, uri)
        clipData = ClipData.newRawUri(f.name, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      Intent.createChooser(send, f.name)
    } else {
      Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, mime)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
    }
    ui {
      try {
        val from = MainActivity.current
        if (from != null) from.startActivity(i) else ctx.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        invoke.resolve()
      } catch (e: ActivityNotFoundException) {
        invoke.reject(if (share) "Некуда отправить файл" else "Нет приложения, чтобы открыть этот файл")
      } catch (e: Exception) {
        invoke.reject(e.message ?: "Не открылось")
      }
    }
  }

  // ---------- перезапуск (перенос профиля) ----------

  @Command
  fun restart(invoke: Invoke) {
    invoke.resolve()
    main.postDelayed({
      val launch = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)
      val comp = launch?.component
      ZvService.stop(ctx)
      if (comp != null) ctx.startActivity(Intent.makeRestartActivityTask(comp))
      Runtime.getRuntime().exit(0)
    }, 300)
  }
}
