// Чаты между двумя zv-devhost (P2P iroh локально + заглушка Worker для почтовых ящиков). Хосты запускает сам тест:
// контакт → сообщение → доставлено/прочитано → «печатает…» → ответ (меню) → правка (↑) → удаление у всех →
// файл (скрепка) → скачивание → «Открыть» → опасный .exe (подтверждение) → картинка вставкой (автозагрузка, превью) →
// перетаскивание (host:drop) → непрочитанные (значок) → B не в сети: почтовый ящик → B вернулся → доставлено →
// узкое окно → ошибок в консоли нет.
//   node tests/e2e/devhost-chats.mjs [путь к zv-devhost] [каталог ui]
import { launch } from './pw.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const BIN = process.argv[2] || '/data/zv4-target/debug/zv-devhost';
const UI = process.argv[3] || new URL('../../ui', import.meta.url).pathname;
const PA = 8793;
const PB = 8794;
const PW = 8798;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zvchats-'));
const DA = path.join(tmp, 'a');
const DB = path.join(tmp, 'b');
const procs = {};
function startHost(tag, port, data, extra) {
  const log = fs.openSync(path.join(tmp, `${tag}.log`), 'a');
  const p = spawn(BIN, ['--port', String(port), '--ui', UI, '--data', data, '--p2p-local', ...extra], {
    stdio: ['ignore', log, log],
    env: { ...process.env, RUST_LOG: 'info' },
  });
  procs[tag] = p;
  return p;
}
async function waitHttp(port) {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/shell/index.html`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('devhost не запустился: ' + port);
}
startHost('a', PA, DA, ['--mock-worker', String(PW)]);
await waitHttp(PA);
startHost('b', PB, DB, ['--local', `worker=http://127.0.0.1:${PW}`]);
await waitHttp(PB);

const browser = await launch();
const errors = [];
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
const mk = async (tag, port, name) => {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 720 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && !/WebSocket|429|ERR_|Failed to load resource|ipc closed/.test(m.text()) && errors.push(`[${tag}] ${m.text()}`));
  page.on('pageerror', (e) => errors.push(`[${tag}] pageerror: ${e.message}`));
  await page.goto(`http://127.0.0.1:${port}/shell/index.html`, { waitUntil: 'load' });
  await page.evaluate((n) => window.__zvIpc.call('settings_set', { patch: { name: n, onboarded: true } }), name);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.__zvIpc && document.querySelector('#chList'));
  return { ctx, page, tag, port };
};
const ipc = (x, cmd, args = {}) => x.page.evaluate(([c, a]) => window.__zvIpc.call(c, a), [cmd, args]);
const go = (x, p) => x.page.click(`.nav[data-page="${p}"]`);
const bubble = (x, text) => x.page.locator('.msg .bubble', { hasText: text }).last();
const msgOf = (x, text) => x.page.locator('.msg', { has: x.page.locator('.bubble', { hasText: text }) }).last();
const typeSend = async (x, text) => {
  await x.page.fill('#chInput', text);
  await x.page.press('#chInput', 'Enter');
};

const A = await mk('A', PA, 'Аня');
const B = await mk('B', PB, 'Борис');

await step('контакт: A приглашает, B добавляет', async () => {
  await A.page.waitForFunction(() => window.__zvIpc.call('p2p_status').then((s) => s && s.running), null, { timeout: 20000 });
  await B.page.waitForFunction(() => window.__zvIpc.call('p2p_status').then((s) => s && s.running), null, { timeout: 20000 });
  const inv = await ipc(A, 'contact_invite');
  await ipc(B, 'contact_add', { code: inv.code, name: 'Аня' });
  await A.page.waitForFunction(() => window.__zvIpc.call('contacts_list').then((l) => l.length === 1), null, { timeout: 30000 });
  await B.page.waitForFunction(() => window.__zvIpc.call('contacts_list').then((l) => l.length === 1), null, { timeout: 30000 });
});

await step('A: страница «Чаты», чат с Борисом, пустая переписка', async () => {
  await go(A, 'chats');
  await A.page.waitForSelector('#chList .ch-item:has-text("Борис")');
  await A.page.click('#chList .ch-item:has-text("Борис")');
  await A.page.waitForSelector('.ch-hello');
  await A.page.waitForSelector('#chTop .who b:has-text("Борис")');
  const box = await A.page.locator('#chInput').boundingBox();
  if (!box || box.y + box.height > 720) throw new Error('поле ввода вне окна');
  const mainScroll = await A.page.evaluate(() => document.querySelector('.main').scrollHeight - document.querySelector('.main').clientHeight);
  if (mainScroll > 1) throw new Error('страница чатов прокручивается целиком: ' + mainScroll);
});

await step('сообщение: A → B, у B значок непрочитанных', async () => {
  await typeSend(A, 'Привет! Как дела? https://example.org/путь');
  await bubble(A, 'Привет! Как дела?').waitFor();
  await A.page.waitForSelector('.msg.out .tk:not(.wait)', { timeout: 20000 });
  await B.page.waitForFunction(() => document.querySelector('#chatCount:not(.hidden)')?.textContent === '1', null, { timeout: 20000 });
  const link = await A.page.locator('.msg.out .bubble a').getAttribute('href');
  if (!link.startsWith('https://example.org/')) throw new Error('ссылка: ' + link);
});

await step('B открывает чат → у A «прочитано» (синие ✓✓)', async () => {
  await go(B, 'chats');
  await B.page.waitForSelector('#chList .ch-item:has-text("Аня") .pill');
  await B.page.click('#chList .ch-item:has-text("Аня")');
  await bubble(B, 'Привет! Как дела?').waitFor();
  await B.page.waitForSelector('.ch-unread');
  await A.page.waitForSelector('.msg.out .tk.read', { timeout: 20000 });
  await B.page.waitForSelector('#chatCount.hidden', { state: 'attached', timeout: 5000 });
});

await step('«печатает…» у собеседника', async () => {
  await A.page.fill('#chInput', 'набираю');
  await A.page.type('#chInput', '…');
  await B.page.waitForSelector('#chTop small.typing', { timeout: 10000 });
  await A.page.fill('#chInput', '');
});

await step('ответ через меню (правый щелчок)', async () => {
  await bubble(B, 'Привет! Как дела?').click({ button: 'right' });
  await B.page.click('.menu button:has-text("Ответить")');
  await B.page.waitForSelector('#chCtx:not(.hidden)');
  await typeSend(B, 'Отлично 👍');
  await A.page.waitForSelector('.msg.in .quote:has-text("Привет")', { timeout: 15000 });
  await bubble(A, 'Отлично 👍').waitFor();
});

await step('правка последнего (↑) — у B «изменено»', async () => {
  await A.page.click('#chInput');
  await A.page.press('#chInput', 'ArrowUp');
  await A.page.waitForSelector('#chCtx:has-text("Изменение")');
  await A.page.fill('#chInput', 'Привет! Как ты?');
  await A.page.press('#chInput', 'Enter');
  await B.page.waitForSelector('.msg.in .bubble:has-text("Привет! Как ты?") .meta:has-text("изменено")', { timeout: 15000 });
});

await step('удаление у всех', async () => {
  await typeSend(A, 'Это сообщение удалим');
  await bubble(B, 'Это сообщение удалим').waitFor({ timeout: 15000 });
  await msgOf(A, 'Это сообщение удалим').hover();
  await msgOf(A, 'Это сообщение удалим').locator('.m-act').click();
  await A.page.click('.menu button:has-text("Удалить")');
  await A.page.click('.dialog .btn.danger');
  await A.page.waitForSelector('.bubble.del:has-text("Вы удалили сообщение")');
  await B.page.waitForSelector('.bubble.del:has-text("Сообщение удалено")', { timeout: 15000 });
});

const fileA = path.join(tmp, 'Отчёт за год.pdf');
const fileData = crypto.randomBytes(3 * 1024 * 1024 + 123);
fs.writeFileSync(fileA, fileData);
await step('файл скрепкой: B скачивает и открывает', async () => {
  await ipc(A, 'dev_set_pick', { paths: [fileA] });
  await A.page.click('#chAttach');
  await A.page.waitForSelector('.dialog .ch-sendlist:has-text("Отчёт за год.pdf")');
  await A.page.fill('.dialog input.field', 'годовой отчёт');
  await A.page.click('.dialog [data-act=send-files]');
  await A.page.waitForSelector('.msg.out .ch-file:has-text("Отчёт за год.pdf")');
  const card = B.page.locator('.msg.in .ch-file:has-text("Отчёт за год.pdf")');
  await card.waitFor({ timeout: 15000 });
  await bubble(B, 'годовой отчёт').waitFor();
  await card.locator('[data-act="Скачать"]').click();
  await B.page.waitForSelector('.msg.in .ch-file[data-st=done]:has-text("Отчёт за год.pdf")', { timeout: 30000 });
  await B.page.click('.msg.in .ch-file[data-st=done] [data-act="Открыть"]');
  await B.page.waitForFunction(() => window.__zvIpc.call('dev_opened').then((l) => l.length === 1), null, { timeout: 5000 });
  const opened = await ipc(B, 'dev_opened');
  const got = fs.readFileSync(opened[0].path);
  if (!got.equals(fileData)) throw new Error('содержимое файла не совпало');
  if (!opened[0].path.startsWith(path.join(DB, 'Downloads'))) throw new Error('не в папке загрузок: ' + opened[0].path);
  console.log('   ', path.basename(opened[0].path), got.length, 'байт');
});

await step('опасный .exe: «Открыть» спрашивает подтверждение', async () => {
  const exe = path.join(tmp, 'setup.exe');
  fs.writeFileSync(exe, crypto.randomBytes(2000));
  await ipc(A, 'chat_send_file', { chat: (await ipc(A, 'contacts_list'))[0].id, path: exe });
  const card = B.page.locator('.msg.in .ch-file:has-text("setup.exe")');
  await card.waitFor({ timeout: 15000 });
  await card.locator('[data-act="Скачать"]').click();
  await B.page.waitForSelector('.msg.in .ch-file[data-st=done]:has-text("setup.exe")', { timeout: 20000 });
  await B.page.click('.msg.in .ch-file[data-st=done]:has-text("setup.exe") [data-act="Открыть"]');
  await B.page.waitForSelector('.dialog:has-text("Это программа или скрипт")');
  await B.page.click('.dialog .btn.ghost');
  const opened = await ipc(B, 'dev_opened');
  if (opened.length !== 1) throw new Error('открыли без подтверждения');
});

await step('картинка вставкой: превью у A, автозагрузка и превью у B', async () => {
  await A.page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 320;
    c.height = 200;
    const g = c.getContext('2d');
    g.fillStyle = '#3390ec';
    g.fillRect(0, 0, 320, 200);
    g.fillStyle = '#fff';
    g.font = '40px sans-serif';
    g.fillText('ZV', 120, 115);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'image.png', { type: 'image/png' }));
    document.querySelector('#chInput').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await A.page.waitForSelector('.dialog .ch-sendlist:has-text("Вставка")');
  await A.page.click('.dialog [data-act=send-files]');
  await A.page.waitForSelector('.msg.out .ch-img.ready img', { timeout: 10000 });
  await B.page.waitForSelector('.msg.in .ch-img.ready img', { timeout: 20000 });
  const w = await B.page.$eval('.msg.in .ch-img.ready img', (i) => i.naturalWidth);
  if (w !== 320) throw new Error('ширина картинки ' + w);
  await B.page.click('.msg.in .ch-img.ready');
  await B.page.waitForSelector('.ch-lightbox img');
  await B.page.keyboard.press('Escape');
  await B.page.waitForSelector('.ch-lightbox', { state: 'detached' });
});

await step('перетаскивание файлов (host:drop) → диалог', async () => {
  await ipc(A, 'dev_emit', { event: 'host:drop', payload: { paths: [fileA, '/tmp/второй.txt'] } });
  await A.page.waitForSelector('.dialog h3:has-text("Отправить файлы: 2")');
  await A.page.click('.dialog .btn.ghost');
});

await step('непрочитанные: B на другой странице → значок и пилюля', async () => {
  await go(B, 'contacts');
  await typeSend(A, 'Ты тут?');
  await B.page.waitForFunction(() => document.querySelector('#chatCount:not(.hidden)')?.textContent === '1', null, { timeout: 15000 });
  await go(B, 'chats');
  await bubble(B, 'Ты тут?').waitFor();
  await B.page.waitForSelector('#chatCount.hidden', { state: 'attached', timeout: 5000 });
});

await step('B не в сети → почтовый ящик (✓) → B вернулся → доставлено', async () => {
  procs.b.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 500));
  await typeSend(A, 'Пока тебя не было');
  await A.page.waitForSelector('.msg.out:last-child .tk[title^="В почтовом ящике"]', { timeout: 40000 });
  startHost('b', PB, DB, ['--local', `worker=http://127.0.0.1:${PW}`]);
  await waitHttp(PB);
  await B.page.reload({ waitUntil: 'load' });
  await B.page.waitForFunction(() => document.querySelector('#chList'));
  await go(B, 'chats');
  await B.page.click('#chList .ch-item:has-text("Аня")');
  await bubble(B, 'Пока тебя не было').waitFor({ timeout: 40000 });
  await A.page.waitForFunction(
    () => {
      const t = [...document.querySelectorAll('.msg.out')].pop()?.querySelector('.tk');
      return t && !t.title.startsWith('В почтовом') && !t.classList.contains('wait');
    },
    null,
    { timeout: 30000 },
  );
  const via = (await ipc(B, 'chat_history', { chat: (await ipc(B, 'contacts_list'))[0].id, limit: 1 })).msgs[0].via;
  console.log('   получено через:', via || '—');
});

await step('история после перезапуска B на месте', async () => {
  for (const t of ['Привет! Как ты?', 'Отлично 👍', 'Отчёт за год.pdf', 'Сообщение удалено'])
    await B.page.locator('.msg', { hasText: t }).first().waitFor({ timeout: 5000 });
});

await step('вёрстка: пузыри у своих краёв, время не налезает на текст', async () => {
  await typeSend(A, 'Длинное' + 'слово'.repeat(300));
  await typeSend(A, 'Короткое');
  await bubble(A, 'Короткое').waitFor();
  const r = await A.page.evaluate(() => {
    const box = document.querySelector('#chMsgs').getBoundingClientRect();
    return [...document.querySelectorAll('.msg')].map((m) => {
      const b = m.querySelector('.bubble').getBoundingClientRect();
      const meta = m.querySelector('.meta').getBoundingClientRect();
      let overlap = false;
      const txt = m.querySelector('.txt');
      const tn = txt && [...txt.childNodes].filter((n) => n.nodeType === 3 || n.tagName === 'A').pop();
      if (tn) {
        const rg = document.createRange();
        rg.selectNodeContents(tn);
        const rs = [...rg.getClientRects()];
        const last = rs[rs.length - 1];
        overlap = !!last && last.right > meta.left + 1 && last.bottom > meta.top + 1;
      }
      return {
        out: m.classList.contains('out'),
        gap: m.classList.contains('out') ? box.right - b.right : b.left - box.left,
        metaIn: meta.right <= b.right + 0.5 && meta.bottom <= b.bottom + 0.5 && meta.left >= b.left,
        overlap,
        wide: b.width <= box.width,
      };
    });
  });
  for (const x of r) {
    if (x.gap > 24) throw new Error('пузырь не у своего края: ' + JSON.stringify(x));
    if (!x.metaIn) throw new Error('время вне пузыря: ' + JSON.stringify(x));
    if (x.overlap) throw new Error('время налезает на текст: ' + JSON.stringify(x));
    if (!x.wide) throw new Error('пузырь шире ленты');
  }
  console.log('   пузырей проверено:', r.length);
});

await step('узкое окно: список ↔ переписка', async () => {
  await A.page.setViewportSize({ width: 600, height: 700 });
  await A.page.waitForSelector('.ch-back', { state: 'visible' });
  await A.page.click('.ch-back');
  await A.page.waitForSelector('.ch-side', { state: 'visible' });
  if (await A.page.isVisible('.ch-conv')) throw new Error('переписка видна вместе со списком');
  await A.page.click('#chList .ch-item:has-text("Борис")');
  await A.page.waitForSelector('#chInput', { state: 'visible' });
  const over = await A.page.evaluate(() => {
    const s = document.querySelector('#chScroll');
    return s.scrollWidth - s.clientWidth;
  });
  if (over > 1) throw new Error('горизонтальная прокрутка: ' + over);
  await A.page.setViewportSize({ width: 1100, height: 720 });
});

await step('очистить историю (только у себя)', async () => {
  await A.page.click('#chTop .acts .btn:last-child');
  await A.page.click('.menu button:has-text("Очистить историю")');
  await A.page.click('.dialog .btn.danger');
  await A.page.waitForSelector('.ch-hello');
  await B.page.locator('.msg', { hasText: 'Отлично' }).first().waitFor({ timeout: 3000 });
});

if (errors.length) {
  failed++;
  console.log('✗ ошибки в консоли:\n  ' + errors.slice(0, 10).join('\n  '));
} else console.log('✓ ошибок в консоли нет');
await browser.close();
for (const p of Object.values(procs)) p.kill('SIGTERM');
console.log(failed ? `ИТОГ: ${failed} ошибок (логи: ${tmp})` : 'ИТОГ: всё прошло');
process.exit(failed ? 1 : 0);
