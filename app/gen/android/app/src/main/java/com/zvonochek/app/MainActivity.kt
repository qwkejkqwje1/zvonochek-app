package com.zvonochek.app

import android.content.Intent
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import java.lang.ref.WeakReference

/**
 * Единственное окно ZVONochek: оболочка и звонок по очереди в одном WebView (см. app/src/wins_mobile.rs).
 * Ядро (Rust) живёт в процессе, пока работает служба ZvService, — даже если окно закрыли.
 */
class MainActivity : TauriActivity() {
  companion object {
    const val EXTRA_INCOMING = "zvIncoming"
    const val EXTRA_ANSWER = "zvAnswer"

    /** В этом процессе окно уже открывали (ядро запущено; окно могли закрыть, а служба оставила процесс). */
    @Volatile var hadWindow = false
      private set
    @Volatile private var ref: WeakReference<MainActivity>? = null

    val current: MainActivity?
      get() = ref?.get()
  }

  var webView: WebView? = null
    private set
  private var backAdded = false

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge(
      statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
      navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
    )
    val again = hadWindow && savedInstanceState == null
    hadWindow = true
    super.onCreate(savedInstanceState)
    ref = WeakReference(this)
    // системные панели не перекрывают страницу: отступы по краям (и снизу — по клавиатуре)
    window.decorView.setBackgroundColor(0xFF0E1621.toInt())
    val root = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      v.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
      WindowInsetsCompat.CONSUMED
    }
    overLockScreen(intent)
    // окно открыли заново, а ядро уже работает: Tauri создаёт окно только при первом запуске — просим новое
    if (again) ZvNative.activityRecreated()
    answerFrom(intent)
  }

  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
    // после обработчика Tauri (AppPlugin): наш вызывается первым
    if (!backAdded) {
      backAdded = true
      onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() = back()
      })
    }
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    overLockScreen(intent)
    answerFrom(intent)
  }

  /** «Ответить» в уведомлении о входящем: ядро отвечает и открывает звонок в этом окне. */
  private fun answerFrom(intent: Intent?) {
    val id = intent?.getStringExtra(EXTRA_ANSWER) ?: return
    intent.removeExtra(EXTRA_ANSWER)
    ZvService.cancelIncoming(this)
    try {
      ZvNative.incomingAction(id, true)
    } catch (e: UnsatisfiedLinkError) {
      android.util.Log.w("ZVONochek", "ядро ещё не загружено: $e")
    }
  }

  override fun onPause() {
    super.onPause()
    // идёт звонок: WebView не ставим на паузу — звук продолжается, когда приложение свёрнуто или экран погас
    if (ZvService.inCall) webView?.onResume()
  }

  override fun onDestroy() {
    if (ref?.get() === this) ref = null
    super.onDestroy()
  }

  /** «Назад»: страница сама закрывает диалог или открытый чат; иначе — свернуть (звонок и ожидание продолжаются). */
  private fun back() {
    val wv = webView
    if (wv == null) {
      moveTaskToBack(true)
      return
    }
    wv.evaluateJavascript("(function(){try{return !!(window.__zvBack&&window.__zvBack())}catch(e){return false}})()") { r ->
      if (r != "true") moveTaskToBack(true)
    }
  }

  /** Входящий на заблокированном телефоне: окно поверх экрана блокировки и включить экран. */
  private fun overLockScreen(intent: Intent?) {
    if (intent?.getBooleanExtra(EXTRA_INCOMING, false) == true) setOverLock(true)
  }

  fun setOverLock(on: Boolean) {
    if (Build.VERSION.SDK_INT >= 27) {
      setShowWhenLocked(on)
      setTurnScreenOn(on)
    } else {
      @Suppress("DEPRECATION")
      val f = WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
      if (on) window.addFlags(f) else window.clearFlags(f)
    }
  }
}
