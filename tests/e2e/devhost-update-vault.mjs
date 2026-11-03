// Настройки Windows в zv-devhost (`--vault`, тестовое обновление — tests/e2e/update-vault.sh):
// пароль профиля (задать, «не спрашивать здесь», убрать) и обновление (проверка → загрузка с подписью → перезапуск).
//   node tests/e2e/devhost-update-vault.mjs [http://127.0.0.1:8791]
import { launch } from './pw.mjs';
const HOST = process.argv[2] || 'http://127.0.0.1:8791';
const browser = await launch();
const page = await (await browser.newContext({ viewport: { width: 1000, height: 680 } })).newPage();
const errors = [];
page.on('console', (m) => m.type() === 'error' && !/WebSocket|429|ERR_/.test(m.text()) && errors.push(m.text()));
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
const step = async (name, fn) => {
  try {
    await fn();
    console.log('✓', name);
  } catch (e) {
    console.log('✗', name, '—', e.message.split('\n')[0]);
    errors.push(name + ': ' + e.message.split('\n')[0]);
  }
};
const ipc = (cmd, args) => page.evaluate(([c, a]) => window.__zvIpc.call(c, a), [cmd, args]);
const hidden = (sel) => page.$eval(sel, (e) => e.classList.contains('hidden'));
await page.goto(`${HOST}/shell/index.html`, { waitUntil: 'load' });
await step('первый запуск: закрыть Esc', async () => {
  await page.waitForSelector('.dialog', { timeout: 8000 });
  await page.keyboard.press('Escape');
  await page.waitForSelector('.dialog', { state: 'detached' });
  await page.click('.nav[data-page="settings"]');
});
await step('пароль профиля: задать', async () => {
  if (await hidden('#rowVault')) throw new Error('строка пароля скрыта');
  if (!/Не задан/.test(await page.textContent('#vaultText'))) throw new Error(await page.textContent('#vaultText'));
  await page.click('#vaultSet');
  const pw = page.locator('.dialog input[type=password]');
  await pw.nth(0).fill('пароль-1');
  await pw.nth(1).fill('пароль-1');
  await page.click('.dialog .btn.primary');
  await page.waitForSelector('.dialog', { state: 'detached', timeout: 20000 });
  if (!/Задан/.test(await page.textContent('#vaultText'))) throw new Error(await page.textContent('#vaultText'));
  if (await hidden('#rowVaultRemember')) throw new Error('нет «Не спрашивать на этом компьютере»');
  const st = await ipc('vault_status');
  if (!st.password || !st.remember) throw new Error(JSON.stringify(st));
});
await step('пароль профиля: спрашивать при запуске, потом убрать', async () => {
  await page.click('#vaultRemember + span');
  await page.waitForFunction(() => /каждом запуске/.test(document.querySelector('#vaultText').textContent), null, { timeout: 5000 });
  if ((await ipc('vault_status')).remember) throw new Error('remember не выключен');
  await page.click('#vaultDel');
  await page.click('.dialog .btn.danger');
  await page.waitForFunction(() => /Не задан/.test(document.querySelector('#vaultText').textContent), null, { timeout: 5000 });
  const st = await ipc('vault_status');
  if (st.password || !st.remember) throw new Error(JSON.stringify(st));
});
await step('обновление: найти, скачать с проверкой подписи, перезапустить', async () => {
  if (await hidden('#rowAutoUpd')) throw new Error('нет «Обновлять автоматически»');
  if (!(await page.isChecked('#setAutoUpd'))) throw new Error('автообновление выключено по умолчанию');
  await page.click('#updBtn');
  await page.waitForSelector('.dialog h3:has-text("9.9.9")', { timeout: 15000 });
  await page.click('.dialog .btn.primary');
  await page.waitForSelector('.dialog h3:has-text("установлена")', { timeout: 30000 });
  await page.click('.dialog .btn.primary');
  await page.waitForTimeout(500);
  const opened = await ipc('dev_opened');
  const upd = opened.find((o) => o.update);
  if (!upd || upd.version !== '9.9.9' || !/ZVONochek-9\.9\.9\.exe$/.test(upd.update)) throw new Error(JSON.stringify(opened));
  if (!opened.some((o) => o.host === 'host_update_restart')) throw new Error('не вызван перезапуск');
  if ((await page.textContent('#updBtn')).trim() !== 'Перезапустить') throw new Error(await page.textContent('#updBtn'));
  console.log('   скачано:', upd.update);
});
await step('обновление: автообновление выключается', async () => {
  await page.click('#setAutoUpd + span');
  await page.waitForTimeout(400);
  if ((await ipc('settings_get')).autoUpdate !== false) throw new Error('autoUpdate не выключен');
});
await browser.close();
if (errors.length) {
  console.log('ОШИБКИ:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('OK');
