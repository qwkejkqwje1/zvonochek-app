package com.zvonochek.app

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * Служба переднего плана «ZVONochek ждёт звонков»: без неё Android усыпит свёрнутое приложение и звонки по ссылкам
 * и от контактов не дойдут (push-серверов у ZVONochek нет). Во время звонка — тип «микрофон/камера», чтобы звук
 * не пропадал, когда приложение свёрнуто или экран погас.
 */
class ZvService : Service() {
  companion object {
    private const val CH_WAIT = "zv_wait"
    private const val CH_CALL = "zv_incoming"
    private const val ID_WAIT = 1001
    private const val ID_CALL = 1002

    @Volatile var inCall = false
    @Volatile private var instance: ZvService? = null

    fun start(ctx: Context) {
      channels(ctx)
      val s = instance
      if (s != null) {
        Handler(Looper.getMainLooper()).post { s.refresh() }
        return
      }
      try {
        ContextCompat.startForegroundService(ctx, Intent(ctx, ZvService::class.java))
      } catch (e: Exception) {
        // Android 12+: из фона службу не запустить — запустится при следующем открытии приложения
        android.util.Log.w("ZVONochek", "служба не запущена: $e")
      }
    }

    fun stop(ctx: Context) {
      ctx.stopService(Intent(ctx, ZvService::class.java))
    }

    fun channels(ctx: Context) {
      if (Build.VERSION.SDK_INT < 26) return
      val nm = ctx.getSystemService(NotificationManager::class.java) ?: return
      nm.createNotificationChannel(
        NotificationChannel(CH_WAIT, "Ожидание звонков", NotificationManager.IMPORTANCE_LOW).apply {
          description = "Постоянное уведомление: ZVONochek на связи и примет звонок"
          setShowBadge(false)
        }
      )
      nm.createNotificationChannel(
        NotificationChannel(CH_CALL, "Входящие звонки", NotificationManager.IMPORTANCE_HIGH).apply {
          description = "Звонок по вашей ссылке, от контакта или в группе"
          setSound(
            RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
            AudioAttributes.Builder()
              .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
              .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
              .build()
          )
          enableVibration(true)
          vibrationPattern = longArrayOf(0, 900, 700, 900, 700)
          lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        }
      )
    }

    private fun openApp(ctx: Context, incoming: Boolean): PendingIntent {
      val i = Intent(ctx, MainActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      if (incoming) i.putExtra(MainActivity.EXTRA_INCOMING, true)
      return PendingIntent.getActivity(
        ctx,
        if (incoming) 2 else 1,
        i,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      )
    }

    private fun canNotify(ctx: Context) =
      Build.VERSION.SDK_INT < 33 ||
        ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    /** Входящий, пока приложение не на экране: полноэкранное уведомление с мелодией (поверх экрана блокировки). */
    fun showIncoming(ctx: Context, title: String, text: String, callId: String) {
      channels(ctx)
      if (!canNotify(ctx)) return
      val open = openApp(ctx, true)
      val answer = PendingIntent.getActivity(
        ctx,
        3,
        Intent(ctx, MainActivity::class.java)
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
          .putExtra(MainActivity.EXTRA_INCOMING, true)
          .putExtra(MainActivity.EXTRA_ANSWER, callId),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      )
      val decline = PendingIntent.getBroadcast(
        ctx,
        4,
        Intent(ctx, ZvReceiver::class.java).setAction(ZvReceiver.DECLINE).putExtra("callId", callId),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      )
      val n = NotificationCompat.Builder(ctx, CH_CALL)
        .setSmallIcon(R.drawable.ic_stat_zv)
        .setContentTitle(title)
        .setContentText(text)
        .setPriority(NotificationCompat.PRIORITY_MAX)
        .setCategory(NotificationCompat.CATEGORY_CALL)
        .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
        .setOngoing(true)
        .setAutoCancel(true)
        .setContentIntent(open)
        .setFullScreenIntent(open, true)
        .addAction(0, "Отклонить", decline)
        .addAction(0, "Ответить", answer)
        .setTimeoutAfter(90_000)
        .build()
      n.flags = n.flags or Notification.FLAG_INSISTENT
      ctx.getSystemService(NotificationManager::class.java)?.notify(ID_CALL, n)
    }

    fun cancelIncoming(ctx: Context) {
      ctx.getSystemService(NotificationManager::class.java)?.cancel(ID_CALL)
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    instance = this
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    refresh()
    // процесс убит системой — без окна ядро не поднять, поэтому сами не перезапускаемся
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    if (instance === this) instance = null
    super.onDestroy()
  }

  private fun granted(p: String) = ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED

  /** Уведомление и тип службы — по состоянию (ожидание / звонок). */
  fun refresh() {
    channels(this)
    val call = inCall
    val n = NotificationCompat.Builder(this, CH_WAIT)
      .setSmallIcon(R.drawable.ic_stat_zv)
      .setContentTitle(if (call) "Идёт звонок" else "ZVONochek ждёт звонков")
      .setContentText(if (call) "Нажмите, чтобы вернуться к звонку" else "Звонки по вашим ссылкам и от контактов")
      .setOngoing(true)
      .setShowWhen(false)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setCategory(if (call) NotificationCompat.CATEGORY_CALL else NotificationCompat.CATEGORY_SERVICE)
      .setContentIntent(openApp(this, false))
      .build()
    var base = 0
    if (Build.VERSION.SDK_INT >= 34) base = ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
    var type = base
    if (call && Build.VERSION.SDK_INT >= 30) {
      if (granted(Manifest.permission.RECORD_AUDIO)) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
      if (granted(Manifest.permission.CAMERA)) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
    }
    try {
      ServiceCompat.startForeground(this, ID_WAIT, n, type)
    } catch (e: Exception) {
      // «микрофон/камера» разрешены только с открытым приложением — тогда пока без них
      try {
        ServiceCompat.startForeground(this, ID_WAIT, n, base)
      } catch (e2: Exception) {
        android.util.Log.w("ZVONochek", "служба: $e2")
        stopSelf()
      }
    }
  }
}
