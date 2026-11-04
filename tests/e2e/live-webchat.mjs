// Чаты сайта в приложении (живой тест, нужен интернет): браузер на сайте ↔ окно «Чаты сайта» zv-devhost.
// Ссылка `#chat=` вставляется в оболочку → «Открыть» → встроенный веб-клиент; WebSocket к Worker — через ядро
// (прокси ws_open/ws_send, Worker отвергает чужой Origin). Сообщения в обе стороны, без резервного канала;
// затем кнопка «Чаты сайта» открывает список, в нём этот чат.
//   node tests/e2e/live-webchat.mjs [путь к zv-devhost] [каталог ui] [https://zvonochek.github.io/]
import { launch } from './pw.mjs';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BIN = process.argv[2] || '/data/zv4-target/debug/zv-devhost';
const UI = process.argv[3] || new URL('../../ui', import.meta.url).pathname;
const WEB = process.argv[4] || 'https://zvonochek.github.io/';
const PORT = 8805;
const HOST = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zvwc-'));
const seed = randomBytes(32).toString('base64url');
let failed = 0;
const step = async (name, fn) => {
  const t0 = Date.now();
  try {
    await fn();
    console.log('✓', name, `(${((Date.now() - t0) / 1000).toFixed(1)} с)`);
  } catch (e) {
    failed++;
    console.log('✗', name, '—', e.message.split('\n')[0]);
  }
};
const log = fs.openSync(path.join(tmp, 'host.log'), 'a');
const host = spawn(BIN, ['--port', String(PORT), '--ui', UI, '--data', path.join(tmp, 'a')], {
  stdio: ['ignore', log, log],
  env: { ...process.env, RUST_LOG: 'info' },
});
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`${HOST}/shell/index.html`)).ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 150));
}
const browser = await launch();
const watch = (page, tag) => {
  page.on('console', (m) => {
    if (m.type() === 'error' || /\[zv\]/.test(m.text())) console.log(`   [${tag}] ${m.type()}: ${m.text().slice(0, 200)}`);
  });
  page.on('pageerror', (e) => console.log(`   [${tag}] pageerror: ${e.message}`));
  return page;
};
const nicks = new Map();
const vis = (p, sel) => p.evaluate((s) => {
  const e = document.querySelector(s);
  return !!e && e.offsetParent !== null && !e.closest('.hidden');
}, sel);
const state = (p) =>
  p.evaluate(() => {
    const d = (s) => {
      const e = document.querySelector(s);
      return e ? `${s}:${e.offsetParent !== null ? 'видно' : 'скрыто'}${e.disabled ? ',выкл' : ''}` : `${s}:нет`;
    };
    const ov = [...document.querySelectorAll('.modal:not(.hidden), .overlay:not(.hidden), dialog[open], .sheet:not(.hidden)')]
      .filter((e) => e.offsetParent !== null)
      .map((e) => (e.id || e.className) + ': ' + e.innerText.slice(0, 80).replace(/\s+/g, ' '));
    return [d('#chatNickBox'), d('#chatInput'), d('#chatSend'), ...ov].join(' | ');
  });
const enter = async (p, nick) => {
  nicks.set(p, nick);
  await p.waitForSelector('#chatroom:not(.hidden)', { timeout: 30000 });
  for (let i = 0; i < 100 && !(await vis(p, '#chatNickBox')) && !(await vis(p, '#chatInput')); i++) await p.waitForTimeout(200);
  if (await vis(p, '#chatNickBox')) {
    await p.fill('#chatNickInput', nick);
    await p.click('#chatNickSave');
  }
  for (let i = 0; i < 100 && !(await vis(p, '#chatInput')); i++) await p.waitForTimeout(200);
  if (!(await vis(p, '#chatInput'))) throw new Error('нет поля ввода: ' + (await state(p)));
};
const send = async (p, text) => {
  // окно ника может появиться и после поля ввода (когда комната инициализировалась)
  for (let i = 0; i < 50 && !(await vis(p, '#chatInput')); i++) {
    if (await vis(p, '#chatNickBox')) {
      await p.fill('#chatNickInput', nicks.get(p) || 'Гость');
      await p.click('#chatNickSave');
    }
    await p.waitForTimeout(200);
  }
  if (!(await vis(p, '#chatInput'))) throw new Error('нет поля ввода: ' + (await state(p)));
  await p.fill('#chatInput', text);
  await p.click('#chatSend');
};
const waitText = (p, text, ms = 30000) =>
  p.waitForFunction((t) => (document.querySelector('#chatMessages')?.innerText || '').includes(t), text, { timeout: ms });
const status = (p) => p.innerText('#chatStatus').catch(() => '');
const fallback = (p) => p.evaluate(() => !document.querySelector('#chatFallbackBadge')?.classList.contains('hidden'));

const webCtx = await browser.newContext();
const web = watch(await webCtx.newPage(), 'сайт');
const appCtx = await browser.newContext();
const shell = watch(await appCtx.newPage(), 'оболочка');
let chat;
await step('сайт: свой чат по ссылке', async () => {
  await web.goto(WEB, { waitUntil: 'load' });
  await web.evaluate(() => localStorage.setItem('zvOnboarded', '1'));
  await web.goto(WEB + '#chat=' + seed, { waitUntil: 'load' });
  await web.reload({ waitUntil: 'load' });
  await enter(web, 'Браузер');
});
await step('оболочка: ссылка #chat= → окно «Чаты сайта»', async () => {
  await shell.goto(`${HOST}/shell/index.html`, { waitUntil: 'load' });
  // первый запуск — окно знакомства
  if (await shell.waitForSelector('.dialog', { timeout: 8000 }).catch(() => null)) {
    await shell.keyboard.press('Escape');
    await shell.waitForSelector('.dialog', { state: 'detached' });
  }
  await shell.fill('#dialInput', WEB + '#chat=' + seed);
  await shell.waitForFunction(() => document.querySelector('#dialHint').textContent.includes('Чаты сайта'));
  const [p] = await Promise.all([appCtx.waitForEvent('page'), shell.click('#dialBtn')]);
  chat = watch(p, 'чаты сайта');
  await chat.waitForLoadState('load');
  await enter(chat, 'Приложение');
  const tabs = await chat.evaluate(() => getComputedStyle(document.querySelector('.tabbar')).display);
  if (tabs !== 'none') throw new Error('вкладки веб-клиента видны: ' + tabs);
});
await step('сайт → приложение', async () => {
  await send(web, 'привет из браузера');
  await waitText(chat, 'привет из браузера');
});
await step('приложение → сайт', async () => {
  await send(chat, 'ответ из приложения');
  await waitText(web, 'ответ из приложения');
});
await step('основной канал (WebSocket через ядро), не резервный', async () => {
  const [s, fb, native] = [await status(chat), await fallback(chat), await chat.evaluate(() => /native code/.test(String(WebSocket)))];
  console.log(`   статус приложения «${s.trim()}», резерв: ${fb}`);
  if (fb) throw new Error('приложение на резервном канале');
  if (native) throw new Error('подмена WebSocket не установлена');
});
await step('«Чаты сайта» на странице «Чаты»: список с этим чатом', async () => {
  await chat.close();
  await shell.click('.nav[data-page="chats"]');
  const [p] = await Promise.all([appCtx.waitForEvent('page'), shell.click('#chWeb')]);
  chat = watch(p, 'чаты сайта');
  await chat.waitForLoadState('load');
  await chat.waitForFunction(() => (document.querySelector('#chatRoomsList')?.children.length || 0) > 0, null, { timeout: 15000 });
});
await browser.close();
host.kill();
console.log(failed ? `ИТОГ: сбоев ${failed}` : 'ИТОГ: всё прошло');
process.exit(failed ? 1 : 0);
