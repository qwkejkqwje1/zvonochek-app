package com.zvonochek.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** «Отклонить» в уведомлении о входящем. */
class ZvReceiver : BroadcastReceiver() {
  companion object {
    const val DECLINE = "com.zvonochek.app.DECLINE"
  }

  override fun onReceive(ctx: Context, intent: Intent) {
    if (intent.action != DECLINE) return
    ZvService.cancelIncoming(ctx)
    val id = intent.getStringExtra("callId") ?: return
    // процесс начат заново (ядра нет) — звонок и так закончился
    if (!MainActivity.hadWindow) return
    try {
      ZvNative.incomingAction(id, false)
    } catch (e: UnsatisfiedLinkError) {
      android.util.Log.w("ZVONochek", "ядро не загружено: $e")
    }
  }
}
