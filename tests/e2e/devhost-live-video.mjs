// Живой сайт (браузер) ↔ встроенный веб-клиент в zv-devhost: соединение WebRTC и видео в обе стороны.
//   node tests/e2e/devhost-live-video.mjs [http://127.0.0.1:8790] [https://zvonochek.github.io/]
import { launch } from './pw.mjs';
import { randomBytes } from 'node:crypto';
const HOST = process.argv[2] || 'http://127.0.0.1:8790';
const WEB = process.argv[3] || 'https://zvonochek.github.io/';
const secret = randomBytes(16).toString('base64url');
const browser = await launch();
const mk = async (tag) => {
  const ctx = await browser.newContext({ permissions: ['microphone', 'camera'] });
  const page = await ctx.newPage();
  // ZV_WEB_GUM_DELAY=мс: браузер «не отвечает» на запрос микрофона (как висящий запрос разрешения)
  if (tag === 'web' && process.env.ZV_WEB_GUM_DELAY) {
    await page.addInitScript((ms) => {
      const md = navigator.mediaDevices;
      const orig = md.getUserMedia.bind(md);
      md.getUserMedia = (c) => new Promise((r) => setTimeout(r, ms)).then(() => orig(c));
    }, Number(process.env.ZV_WEB_GUM_DELAY));
  }
  page.on('pageerror', (e) => console.log(`[${tag}] pageerror: ${e.message}`));
  return page;
};
const web = await mk('web');
const app = await mk('app');
const t0 = Date.now();
const sec = () => Math.round((Date.now() - t0) / 1000);
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
const ver = async (p) => p.evaluate(() => fetch('version.json', { cache: 'no-store' }).then((r) => r.json()).then((j) => j.v).catch(() => '?'));
console.log(`версии: сайт v${await ver(web)}, приложение v${await ver(app)}`);
const connected = await Promise.all(
  [web, app].map((p) => p.waitForSelector('#quality:not(.hidden)', { timeout: 60000 }).then(() => true, () => false))
);
console.log(`WebRTC: web=${connected[0]} app=${connected[1]} за ${sec()} с`);
const pill = (p) => p.evaluate(() => ({
  q: document.querySelector('#quality:not(.hidden)')?.innerText || '',
  bridge: !document.querySelector('#bridgeBadge')?.classList.contains('hidden'),
}));
console.log('web:', JSON.stringify(await pill(web)), 'app:', JSON.stringify(await pill(app)));
// камера: включаем на обеих сторонах
for (const p of [web, app]) {
  const on = await p.evaluate(() => document.querySelector('#cCam')?.getAttribute('aria-pressed') === 'true');
  if (!on) await p.click('#cCam');
}
await web.waitForTimeout(6000);
const frames = (p) => p.evaluate(() => {
  const v = document.querySelector('#remote');
  return { w: v?.videoWidth || 0, h: v?.videoHeight || 0, n: v?.getVideoPlaybackQuality?.().totalVideoFrames || 0 };
});
const f1 = { web: await frames(web), app: await frames(app) };
await web.waitForTimeout(3000);
const f2 = { web: await frames(web), app: await frames(app) };
const vid = (k) => f2[k].w > 0 && f2[k].n > f1[k].n;
console.log(`видео собеседника: в браузере=${vid('web')} ${JSON.stringify(f2.web)}; в приложении=${vid('app')} ${JSON.stringify(f2.app)}`);
const ok = connected.every(Boolean) && vid('web') && vid('app');
if (!ok || process.env.ZV_LOG) {
  for (const [tag, p] of [['web', web], ['app', app]]) {
    const l = await p.evaluate(() => document.querySelector('#diagLog')?.textContent || '');
    console.log(`--- журнал ${tag} (последние строки) ---\n` + l.split('\n').slice(-40).join('\n'));
  }
}
console.log(ok ? 'ИТОГ: OK' : 'ИТОГ: СБОЙ');
await browser.close();
process.exit(ok ? 0 : 1);
