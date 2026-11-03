// Оболочка в zv-devhost: первый запуск → своя ссылка → браузер звонит по ней → входящий → ответ → разговор;
// затем пропущенный. Живой сайт и живые каналы.
//   node tests/e2e/devhost-shell.mjs [http://127.0.0.1:8790]
import { chromium } from '/data/tools/node_modules/playwright-core/index.mjs';
const HOST = process.argv[2] || 'http://127.0.0.1:8790';
const WEB = process.argv[3] || 'https://qwkejkqwje1.github.io/zvonochek/';
const browser = await chromium.launch({
  executablePath: '/usr/local/bin/chromium',
  args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
const quiet = (t) => /WebSocket connection to|status of 429|ERR_CONNECTION/.test(t);
const watch = (page, tag) => {
  page.on('console', (m) => {
    const t = m.text();
    if ((m.type() === 'error' || /\[zv\]/.test(t)) && !quiet(t)) console.log(`[${tag}] ${m.type()}: ${t.slice(0, 300)}`);
  });
  page.on('pageerror', (e) => console.log(`[${tag}] pageerror: ${e.message}`));
};
const appCtx = await browser.newContext({ permissions: ['microphone', 'camera'], viewport: { width: 1000, height: 680 } });
const shell = await appCtx.newPage();
watch(shell, 'shell');
await shell.goto(`${HOST}/shell/index.html`, { waitUntil: 'load' });
// первый запуск
await shell.waitForSelector('.dialog', { timeout: 10000 });
await shell.fill('.dialog input.field', 'Тестовый ПК');
await shell.click('.dialog .btn.primary');
await shell.waitForSelector('.dialog .linkbox', { timeout: 10000 });
const url = (await shell.textContent('.dialog .linkbox .mono')).trim();
console.log('своя ссылка:', url.replace(/k=.*/, 'k=…'));
await shell.screenshot({ path: '/tmp/shell-share.png' });
await shell.click('.dialog .actions .btn.primary');
// ждём, пока ожидание поднимется
await shell.waitForFunction(() => document.querySelector('#sideTitle')?.textContent === 'Ждём звонков', null, { timeout: 30000 });
console.log('слева:', await shell.textContent('#sideTitle'), '/', await shell.textContent('#sideText'));

// браузер звонит по ссылке
const webCtx = await browser.newContext({ permissions: ['microphone', 'camera'] });
const web = await webCtx.newPage();
watch(web, 'web');
const k = url.split('#k=')[1];
await web.goto(WEB, { waitUntil: 'load' });
await web.evaluate(() => localStorage.setItem('zvOnboarded', '1'));
await web.goto(WEB + '#k=' + k, { waitUntil: 'load' });
await web.reload({ waitUntil: 'load' });
await web.waitForSelector('#prejoin:not(.hidden)', { timeout: 15000 });
await web.fill('#name', 'Гость из браузера');
await web.click('#btnJoin');
const t0 = Date.now();
await shell.waitForSelector('#incOverlay .inc-card', { timeout: 30000 });
console.log('входящий через %d мс:', Date.now() - t0, (await shell.textContent('#incOverlay .inc-body')).replace(/\s+/g, ' '));
await shell.screenshot({ path: '/tmp/shell-incoming.png' });
// ответ → вкладка звонка
const [callPage] = await Promise.all([appCtx.waitForEvent('page'), shell.click('#incOverlay .round.ok')]);
watch(callPage, 'call');
await callPage.waitForLoadState('load');
const ok = await Promise.all(
  [web, callPage].map((p) => p.waitForSelector('#quality:not(.hidden)', { timeout: 60000 }).then(() => true, () => false))
);
console.log('соединение: web=%s app=%s за %d мс', ok[0], ok[1], Date.now() - t0);
console.log('оверлей скрыт:', await shell.$eval('#incOverlay', (e) => e.classList.contains('hidden')));
await callPage.waitForTimeout(3000);
await callPage.click('#cHang');
await shell.waitForTimeout(1500);
await shell.click('.nav[data-page="history"]');
await shell.waitForTimeout(500);
console.log('история:', (await shell.textContent('#histList')).replace(/\s+/g, ' ').slice(0, 200));

// пропущенный: браузер снова звонит и кладёт трубку, не дождавшись ответа
await shell.click('.nav[data-page="call"]');
await web.click('#cHang').catch(() => {});
await web.waitForTimeout(1000);
await web.goto(WEB + '#k=' + k, { waitUntil: 'load' });
await web.waitForSelector('#prejoin:not(.hidden)', { timeout: 15000 });
await web.click('#btnJoin');
await shell.waitForSelector('#incOverlay .inc-card', { timeout: 30000 });
console.log('второй входящий есть');
await web.waitForTimeout(2500);
await web.click('#cHang');
await shell.waitForSelector('#incOverlay.hidden', { state: 'attached', timeout: 25000 });
await shell.waitForTimeout(800);
console.log('счётчик пропущенных:', await shell.textContent('#missedCount'), 'скрыт:', await shell.$eval('#missedCount', (e) => e.classList.contains('hidden')));
await shell.click('.nav[data-page="history"]');
console.log('история:', (await shell.textContent('#histList')).replace(/\s+/g, ' ').slice(0, 260));
await shell.click('.nav[data-page="diag"]');
await shell.waitForTimeout(2500);
console.log('диагностика:', (await shell.textContent('#diagBody')).replace(/\s+/g, ' ').slice(0, 300));
await shell.screenshot({ path: '/tmp/shell-diag.png' });
await browser.close();
process.exit(ok[0] && ok[1] ? 0 : 1);
