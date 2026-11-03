// Живой сайт (браузер) ↔ встроенный веб-клиент в zv-devhost (ядро на Rust): звонок должен соединиться.
//   node tests/e2e/devhost-live-call.mjs [http://127.0.0.1:8790] [https://qwkejkqwje1.github.io/zvonochek/]
import { launch } from './pw.mjs';
import { randomBytes } from 'node:crypto';
const HOST = process.argv[2] || 'http://127.0.0.1:8790';
const WEB = process.argv[3] || 'https://qwkejkqwje1.github.io/zvonochek/';
const secret = randomBytes(16).toString('base64url');
const browser = await launch();
const mk = async (tag) => {
  const ctx = await browser.newContext({ permissions: ['microphone', 'camera'] });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' || /\[zv\]/.test(t)) console.log(`[${tag}] ${m.type()}: ${t.slice(0, 300)}`);
  });
  page.on('pageerror', (e) => console.log(`[${tag}] pageerror: ${e.message}`));
  return page;
};
const web = await mk('web');
const app = await mk('app');
const t0 = Date.now();
await web.goto(WEB, { waitUntil: 'load' });
await web.evaluate(() => localStorage.setItem('zvOnboarded', '1'));
await web.goto(WEB + '#k=' + secret, { waitUntil: 'load' });
await web.reload({ waitUntil: 'load' });
await web.waitForSelector('#prejoin:not(.hidden)', { timeout: 15000 });
await web.fill('#name', 'Браузер');
await web.click('#btnJoin');
await web.waitForSelector('#call:not(.hidden)', { timeout: 15000 });
const boot = encodeURIComponent(JSON.stringify({ auto: true, name: 'ПК' }));
await app.goto(`${HOST}/web/index.html?zvboot=${boot}#k=${secret}`, { waitUntil: 'load' });
await app.waitForSelector('#call:not(.hidden)', { timeout: 20000 });
console.log('оба в звонке, ждём соединения…');
const ok = await Promise.all(
  [web, app].map((p) =>
    p.waitForSelector('#quality:not(.hidden)', { timeout: 60000 }).then(
      () => true,
      () => false
    )
  )
);
console.log('соединение: web=%s app=%s за %d с', ok[0], ok[1], Math.round((Date.now() - t0) / 1000));
const pcState = async (p) =>
  p.evaluate(() => {
    const q = document.querySelector('#quality');
    return (q ? q.innerText : '') + ' | ' + (document.querySelector('#cStatus, .call-status')?.innerText || '');
  });
console.log('web:', await pcState(web));
console.log('app:', await pcState(app));
await app.waitForTimeout(3000);
// завершение со стороны приложения
await app.click('#cHang').catch((e) => console.log('hang', e.message));
await app.waitForTimeout(2500);
console.log('app hash после завершения:', await app.evaluate(() => location.hash));
const webHome = await web
  .waitForSelector('#call.hidden, #home:not(.hidden)', { timeout: 15000 })
  .then(() => true, () => false);
console.log('веб заметил завершение:', webHome, await web.evaluate(() => document.querySelector('#callState, #cStatus')?.innerText || ''));
// журнал в ядре
const hist = await app.evaluate(() => window.__zvIpc.call('history_list', {}));
console.log('журнал:', JSON.stringify(hist.slice(0, 2)));
await browser.close();
process.exit(ok[0] && ok[1] ? 0 : 1);
