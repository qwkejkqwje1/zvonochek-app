// Оболочка в режиме телефона (zv-devhost --mobile, как Android): нижние вкладки, «Назад» (window.__zvBack),
// настройки телефона, без вылезания за экран 360×740 и без ошибок в консоли.
//   node tests/e2e/devhost-mobile.mjs [http://127.0.0.1:8790]   (хост — со свежим каталогом данных и --mobile)
import { launch } from './pw.mjs';
const HOST = process.argv[2] || 'http://127.0.0.1:8790';
const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
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
const back = () => page.evaluate(() => window.__zvBack());
const visible = (sel) => page.evaluate((s) => { const e = document.querySelector(s); return !!e && e.offsetParent !== null; }, sel);
await page.goto(`${HOST}/shell/index.html`, { waitUntil: 'load' });
await step('первый запуск: «Назад» закрывает приветствие', async () => {
  await page.waitForSelector('.dialog', { timeout: 8000 });
  if (!(await back())) throw new Error('__zvBack вернул false');
  await page.waitForSelector('.overlay', { state: 'detached' });
});
await step('режим телефона: нижние вкладки, без трея и диагностики в меню', async () => {
  if (!(await page.evaluate(() => document.body.classList.contains('mobile')))) throw new Error('нет body.mobile');
  const r = await page.evaluate(() => {
    const navs = [...document.querySelectorAll('.nav')].filter((n) => n.offsetParent !== null);
    return { n: navs.length, top: Math.min(...navs.map((n) => n.getBoundingClientRect().top)), h: innerHeight, pages: navs.map((n) => n.dataset.page) };
  });
  if (r.n !== 6 || r.pages.includes('diag')) throw new Error('вкладки: ' + r.pages.join(','));
  if (r.top < r.h - 90) throw new Error(`вкладки не внизу: top=${r.top}, h=${r.h}`);
  const label = await page.textContent('.nav[data-page="links"] .label');
  if (label.trim() !== 'Ссылки') throw new Error('подпись: ' + label);
});
for (const p of ['call', 'chats', 'contacts', 'links', 'history', 'settings']) {
  await step(`вкладка ${p}: без горизонтальной прокрутки`, async () => {
    await page.click(`.nav[data-page="${p}"]`);
    await page.waitForFunction((id) => !document.getElementById('page-' + id)?.classList.contains('hidden'), p);
    const bad = await overflow();
    if (bad.length) throw new Error(bad.join('; '));
  });
}
await step('настройки телефона: фон, выход, диагностика, страница релизов; без трея и папки загрузок', async () => {
  for (const s of ['#rowBackground', '#rowQuit', '#rowDiag']) if (!(await visible(s))) throw new Error('не видно ' + s);
  for (const s of ['#rowTray', '#setDlOpen']) if (await visible(s)) throw new Error('видно ' + s);
  const t = await page.textContent('#updBtn');
  if (!t.includes('Страница релизов')) throw new Error('кнопка обновления: ' + t);
  const about = await page.textContent('#aboutName');
  if (!about.includes('Android')) throw new Error(about);
});
await step('диагностика из настроек, «Назад» → настройки → главная → свернуть', async () => {
  await page.click('#diagBtn');
  await page.waitForFunction(() => !document.getElementById('page-diag').classList.contains('hidden'));
  if (!(await back())) throw new Error('из диагностики');
  await page.waitForFunction(() => !document.getElementById('page-settings').classList.contains('hidden'));
  if (!(await back())) throw new Error('из настроек');
  await page.waitForFunction(() => !document.getElementById('page-call').classList.contains('hidden'));
  if (await back()) throw new Error('на главной «Назад» должен свернуть приложение (false)');
});
await step('«Выйти»: подтверждение, «Назад» его закрывает', async () => {
  await page.click('.nav[data-page="settings"]');
  await page.click('#quitBtn');
  await page.waitForSelector('.dialog:has-text("Выйти из ZVONochek?")');
  if (!(await back())) throw new Error('__zvBack вернул false');
  await page.waitForSelector('.overlay', { state: 'detached' });
});
await step('новая ссылка в телефоне: диалог помещается, «Назад» закрывает', async () => {
  await page.click('.nav[data-page="call"]');
  await page.click('#newLinkBtn');
  await page.fill('.dialog input.field', 'Телефон');
  await page.click('.dialog .btn.primary');
  await page.waitForSelector('.dialog .qr svg', { timeout: 5000 });
  const bad = await overflow();
  if (bad.length) throw new Error(bad.join('; '));
  if (!(await back())) throw new Error('__zvBack вернул false');
  await page.waitForSelector('.overlay', { state: 'detached' });
});
await step('ошибок в консоли нет', async () => {
  if (errors.length) throw new Error(errors.join(' | '));
});
await browser.close();
const failed = errors.length > 0;
console.log(failed ? 'ЕСТЬ ОШИБКИ' : 'ВСЁ ПРОШЛО');
process.exit(failed ? 1 : 0);
