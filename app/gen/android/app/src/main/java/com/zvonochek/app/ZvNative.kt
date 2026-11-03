package com.zvonochek.app

/** Вызовы в ядро (Rust, app/src/android.rs) напрямую через JNI. */
object ZvNative {
  /** MainActivity создана заново в уже работающем процессе — создать в ней окно приложения. */
  @JvmStatic external fun activityRecreated()

  /** Кнопка уведомления о входящем: ответить (`answer`) или отклонить звонок `callId`. */
  @JvmStatic external fun incomingAction(callId: String, answer: Boolean)
}
