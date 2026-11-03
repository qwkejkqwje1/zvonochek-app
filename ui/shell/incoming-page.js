// Всплывающее окно входящего звонка (Tauri).
import { applyTheme, call } from './lib.js';
import { mountIncoming } from './incoming.js';
call('settings_get')
  .then((s) => applyTheme(s.theme))
  .catch(() => applyTheme('auto'));
mountIncoming(document.getElementById('inc'), { popup: true });
