// Окно пароля профиля (Windows): до запуска ядра — только команда zv_unlock (app/src/lib.rs).
const $ = (id) => document.getElementById(id);
const light = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
document.documentElement.dataset.theme = light ? 'light' : 'dark';

const invoke = window.__TAURI__?.core?.invoke;

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = $('pw').value;
  if (!password) {
    $('pw').focus();
    return;
  }
  $('go').disabled = true;
  $('go').textContent = 'Проверяю…';
  $('err').textContent = '';
  try {
    if (!invoke) throw new Error('нет связи с приложением');
    await invoke('zv_unlock', { password, remember: $('remember').checked });
    $('go').textContent = 'Открываю…';
  } catch (err) {
    $('err').textContent = String(err?.message || err || 'Не получилось');
    $('go').disabled = false;
    $('go').textContent = 'Открыть';
    $('pw').select();
    $('pw').focus();
  }
});
