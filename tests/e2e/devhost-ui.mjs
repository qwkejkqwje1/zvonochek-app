// Оболочка в zv-devhost: прокликать все экраны и действия, без ошибок в консоли и без вылезания за окно.
//   node tests/e2e/devhost-ui.mjs [http://127.0.0.1:8790]
import { launch } from './pw.mjs';
const HOST = process.argv[2] || 'http://127.0.0.1:8790';
const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 1000, height: 680 }, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await ctx.newPage();
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
const overflow = () =>
  page.evaluate(() => {
    const bad = [];
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width && r.right > innerWidth + 1 && getComputedStyle(el).position !== 'fixed') bad.push(el.tagName + '.' + el.className + ' ' + Math.round(r.right));
    }
    return bad.slice(0, 5);
  });
await page.goto(`${HOST}/shell/index.html`, { waitUntil: 'load' });
await step('первый запуск: закрыть Esc', async () => {
  await page.waitForSelector('.dialog', { timeout: 8000 });
  await page.keyboard.press('Escape');
  await page.waitForSelector('.dialog', { state: 'detached' });
});
await step('создать ссылку', async () => {
  await page.click('#newLinkBtn');
  await page.fill('.dialog input.field', 'Для семьи');
  await page.click('.dialog .btn.primary');
  await page.waitForSelector('.dialog .qr svg', { timeout: 5000 });
  await page.click('.dialog .linkbox .btn');
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  if (!clip.includes('#k=')) throw new Error('в буфере нет ссылки: ' + clip);
  await page.click('.dialog .actions .btn.primary');
});
await step('быстрый набор показывает ссылку', async () => {
  const t = await page.textContent('#quick');
  if (!t.includes('Для семьи')) throw new Error(t);
});
await step('ссылки: переименовать', async () => {
  await page.click('.nav[data-page="links"]');
  await page.click('#mineList .item .acts .btn[title="Ещё"]');
  await page.click('.menu button:has-text("Переименовать")');
  await page.fill('.dialog input.field', 'Семья');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#mineList .title')?.textContent === 'Семья');
});
await step('ссылки: выключить и включить ожидание', async () => {
  await page.click('#mineList .switch span');
  await page.waitForFunction(() => document.querySelector('#mineList [data-st]')?.textContent === 'ожидание выключено');
  await page.click('#mineList .switch span');
  await page.waitForFunction(() => /ждёт|нет связи/.test(document.querySelector('#mineList [data-st]')?.textContent || ''), null, { timeout: 15000 });
});
await step('ссылки: новый адрес', async () => {
  const before = await page.evaluate(() => window.__zvIpc.call('links_list').then((l) => l[0].secret));
  await page.click('#mineList .item .acts .btn[title="Ещё"]');
  await page.click('.menu button:has-text("Новый адрес")');
  await page.click('.dialog .btn.primary');
  await page.waitForSelector('.dialog .linkbox');
  const after = await page.evaluate(() => window.__zvIpc.call('links_list').then((l) => l[0].secret));
  if (before === after) throw new Error('секрет не сменился');
  await page.click('.dialog .actions .btn.primary');
});
await step('звонок по ссылке: подсказки', async () => {
  await page.click('.nav[data-page="call"]');
  await page.fill('#dialInput', 'привет');
  await page.waitForFunction(() => document.querySelector('#dialHint').textContent.includes('Не похоже'));
  await page.fill('#dialInput', 'https://qwkejkqwje1.github.io/zvonochek/#chat=abc');
  await page.waitForTimeout(300);
  console.log('   chat-ссылка:', await page.textContent('#dialHint'));
  await page.fill('#dialInput', 'https://qwkejkqwje1.github.io/zvonochek/#k=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  await page.waitForFunction(() => !document.querySelector('#dialBtn').disabled);
});
await step('звонок по ссылке: открывается окно и сохраняется ссылка', async () => {
  await page.fill('#dialName', 'Тест');
  const [call] = await Promise.all([ctx.waitForEvent('page'), page.click('#dialBtn')]);
  await call.waitForLoadState('load');
  await call.waitForSelector('#call:not(.hidden)', { timeout: 15000 });
  await call.close();
  await page.waitForTimeout(800);
  const saved = await page.evaluate(() => window.__zvIpc.call('links_list').then((l) => l.filter((x) => x.kind === 'saved').map((x) => x.name)));
  if (!saved.includes('Тест')) throw new Error(JSON.stringify(saved));
});
await step('история: запись «Без ответа»', async () => {
  await page.click('.nav[data-page="history"]');
  await page.waitForFunction(() => document.querySelector('#histList').textContent.includes('Без ответа'), null, { timeout: 5000 });
});
await step('настройки: имя, тема, DND', async () => {
  await page.click('.nav[data-page="settings"]');
  await page.fill('#setName', 'Иван');
  await page.waitForTimeout(700);
  await page.click('#setTheme button[data-v="light"]');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await page.click('#setDnd + span');
  await page.waitForFunction(() => document.querySelector('#sideTitle').textContent === 'Не беспокоить');
  const s = await page.evaluate(() => window.__zvIpc.call('settings_get'));
  if (s.name !== 'Иван' || !s.dnd || s.theme !== 'light') throw new Error(JSON.stringify(s));
  console.log('   автозапуск скрыт в devhost:', await page.$eval('#rowAutostart', (e) => e.classList.contains('hidden')));
  await page.click('#setDnd + span');
  await page.click('#setTheme button[data-v="dark"]');
});
await step('лицензии открываются', async () => {
  await page.click('#licBtn');
  await page.waitForSelector('.dialog iframe');
  await page.waitForTimeout(500);
  const n = await page.frameLocator('.dialog iframe').locator('li').count();
  if (n < 50) throw new Error('компонентов ' + n);
  await page.click('.dialog .btn.primary');
});
await step('диагностика', async () => {
  await page.click('.nav[data-page="diag"]');
  await page.waitForSelector('.chan', { timeout: 8000 });
  await page.click('#diagCopy');
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  if (clip.includes('#k=') || /"secret"/.test(clip)) throw new Error('в отчёте секрет');
});
await step('диагностика: проверка сети звонков (STUN/TURN)', async () => {
  await page.click('#netTestBtn');
  await page.waitForFunction(() => document.querySelectorAll('.diag-net .lk').length >= 3, null, { timeout: 20000 });
  console.log('   ', (await page.textContent('.diag-net')).replace(/\s+/g, ' ').trim());
  await page.click('#diagCopy');
  const rep = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  if (!rep.net || !rep.net.stun || typeof rep.net.stun.host !== 'number') throw new Error('нет net в отчёте');
  if (/\b\d{1,3}(\.\d{1,3}){3}\b/.test(JSON.stringify(rep.net))) throw new Error('IP в отчёте');
});
for (const [w, h] of [
  [1000, 680],
  [720, 520],
  [420, 600],
]) {
  await page.setViewportSize({ width: w, height: h });
  for (const p of ['call', 'links', 'history', 'settings', 'diag']) {
    await page.click(`.nav[data-page="${p}"]`);
    await page.waitForTimeout(150);
    const o = await overflow();
    if (o.length) {
      console.log(`✗ вылезает за окно ${w}×${h} на «${p}»:`, o.join(' | '));
      errors.push('overflow');
    }
  }
}
await step('удалить ссылку', async () => {
  await page.setViewportSize({ width: 1000, height: 680 });
  await page.click('.nav[data-page="links"]');
  await page.click('#mineList .item .acts .btn[title="Ещё"]');
  await page.click('.menu button:has-text("Удалить")');
  await page.click('.dialog .btn.danger');
  await page.waitForFunction(() => document.querySelector('#mineList .empty'));
});
await step('история: очистить', async () => {
  await page.click('.nav[data-page="history"]');
  await page.click('#histClear');
  await page.click('.dialog .btn.danger');
  await page.waitForFunction(() => document.querySelector('#histList .empty'));
});
console.log(errors.length ? `ОШИБКИ (${errors.length}):\n` + errors.join('\n') : 'без ошибок');
await browser.close();
process.exit(errors.length ? 1 : 0);
