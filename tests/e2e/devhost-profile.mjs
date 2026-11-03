// Перенос профиля через интерфейс на двух zv-devhost (хосты запускает сам тест): A сохраняет профиль в файл
// (проверка пароля, «Показать в папке») → C загружает (неверный пароль, верный) → перезапуск C → тот же ID
// устройства, имя, ссылки, контакт и переписка; сообщение о переносе; ошибок в консоли нет.
//   node tests/e2e/devhost-profile.mjs [путь к zv-devhost] [каталог ui]
import { launch } from './pw.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BIN = process.argv[2] || '/data/zv4-target/debug/zv-devhost';
const UI = process.argv[3] || new URL('../../ui', import.meta.url).pathname;
const PA = 8795;
const PB = 8796;
const PC = 8797;
const PW = 8799;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zvprof-'));
const DIR = { a: path.join(tmp, 'a'), b: path.join(tmp, 'b'), c: path.join(tmp, 'c') };
const procs = {};
function startHost(tag, port, extra) {
  const log = fs.openSync(path.join(tmp, `${tag}.log`), 'a');
  const p = spawn(BIN, ['--port', String(port), '--ui', UI, '--data', DIR[tag], '--p2p-local', ...extra], {
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
const local = ['--local', `worker=http://127.0.0.1:${PW}`];
startHost('a', PA, ['--mock-worker', String(PW)]);
await waitHttp(PA);
startHost('b', PB, local);
startHost('c', PC, local);
await waitHttp(PB);
await waitHttp(PC);

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
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 720 } });
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && !/WebSocket|429|ERR_|Failed to load resource|ipc closed/.test(m.text()) && errors.push(`[${tag}] ${m.text()}`));
  page.on('pageerror', (e) => errors.push(`[${tag}] pageerror: ${e.message}`));
  await page.goto(`http://127.0.0.1:${port}/shell/index.html`, { waitUntil: 'load' });
  await page.evaluate((n) => window.__zvIpc.call('settings_set', { patch: { name: n, onboarded: true } }), name);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.__zvIpc && document.querySelector('#profExport'));
  return { ctx, page, tag, port };
};
const ipc = (x, cmd, args = {}) => x.page.evaluate(([c, a]) => window.__zvIpc.call(c, a), [cmd, args]);
const go = (x, p) => x.page.click(`.nav[data-page="${p}"]`);
const until = async (fn, ms = 15000, what = 'условие') => {
  const t = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t > ms) throw new Error('не дождались: ' + what);
    await new Promise((r) => setTimeout(r, 200));
  }
};

const A = await mk('A', PA, 'Аня');
const B = await mk('B', PB, 'Борис');
let C = await mk('C', PC, 'Новый ПК');
let idA = null;
let file = null;
let chatA = null;

await step('у A: контакт, переписка и ссылка', async () => {
  const inv = await ipc(A, 'contact_invite');
  await ipc(B, 'contact_add', { code: inv.code });
  await until(async () => (await ipc(A, 'contacts_list')).length === 1, 15000, 'контакт у A');
  chatA = (await ipc(A, 'chats_list'))[0].chat;
  const m = await ipc(A, 'chat_send', { chat: chatA, text: 'до переноса' });
  await until(async () => (await ipc(A, 'chat_history', { chat: chatA })).msgs.find((x) => x.id === m.id)?.st >= 2, 15000, 'доставлено');
  await ipc(A, 'link_create', { name: 'Рабочая' });
  idA = (await ipc(A, 'p2p_status')).id;
  if (!idA) throw new Error('нет ID у A');
});

await step('A: сохранить профиль — проверка пароля', async () => {
  await go(A, 'settings');
  await A.page.click('#profExport');
  const d = A.page.locator('.dialog', { hasText: 'Сохранить профиль в файл' });
  await d.waitFor();
  const [p1, p2] = [d.locator('input[type=password]').nth(0), d.locator('input[type=password]').nth(1)];
  const ok = d.locator('button.primary');
  await p1.fill('123');
  if (!(await ok.isDisabled())) throw new Error('короткий пароль принят');
  if (!/Не короче 8/.test(await d.locator('.hint').innerText())) throw new Error('нет подсказки о длине');
  await p1.fill('секрет-пароль');
  await p2.fill('секрет-парол');
  if (!(await ok.isDisabled())) throw new Error('разные пароли приняты');
  if (!/не совпадают/.test(await d.locator('.hint').innerText())) throw new Error('нет подсказки о совпадении');
  await p2.fill('секрет-пароль');
  await ok.click();
  const done = A.page.locator('.dialog', { hasText: 'Профиль сохранён' });
  await done.waitFor({ timeout: 20000 });
  file = (await done.locator('.file-name').innerText()).trim();
  if (!/\.zvp$/.test(file) || !fs.existsSync(file)) throw new Error('файла нет: ' + file);
  await done.locator('button', { hasText: 'Показать в папке' }).click();
  const opened = await until(async () => (await ipc(A, 'dev_opened')).find((o) => o.reveal && o.path === file), 5000, 'показать в папке');
  if (!opened) throw new Error('не открылось');
  await done.locator('button', { hasText: 'Готово' }).click();
  const raw = fs.readFileSync(file);
  if (raw.includes(Buffer.from('до переноса')) || raw.includes(Buffer.from('Рабочая'))) throw new Error('данные видны открытым текстом');
});

await step('C: загрузить — неверный пароль, верный → просьба перезапустить', async () => {
  await go(C, 'settings');
  await ipc(C, 'dev_set_pick', { paths: [file] });
  await C.page.click('#profImport');
  const q = C.page.locator('.dialog', { hasText: 'Загрузить профиль из файла?' });
  await q.waitFor();
  await q.locator('button.primary', { hasText: 'Выбрать файл' }).click();
  const d = C.page.locator('.dialog', { hasText: 'Пароль от файла профиля' });
  await d.waitFor();
  if (!(await d.locator('.file-name').innerText()).includes('.zvp')) throw new Error('нет имени файла');
  await d.locator('input[type=password]').fill('не-тот-пароль');
  await d.locator('button.primary').click();
  await until(async () => /Неверный пароль/.test(await d.locator('.hint').innerText()), 20000, 'ошибка пароля');
  await d.locator('input[type=password]').fill('секрет-пароль');
  await d.locator('button.primary').click();
  await C.page.locator('.dialog', { hasText: 'Перезапустите приложение' }).waitFor({ timeout: 20000 });
  if (!(await ipc(C, 'dev_opened')).some((o) => o.restart)) throw new Error('перезапуск не запрошен');
  if (!fs.existsSync(path.join(DIR.c, 'import.pending'))) throw new Error('нет import.pending');
});

await step('C после перезапуска: тот же ID, имя, ссылка, контакт и переписка', async () => {
  // «старый компьютер» выключен
  procs.a.kill('SIGTERM');
  procs.c.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 800));
  startHost('c', PC, local);
  await waitHttp(PC);
  await C.page.reload({ waitUntil: 'load' });
  await C.page.waitForFunction(() => window.__zvIpc && document.querySelector('#profExport'));
  await C.page.locator('.toast', { hasText: 'Профиль перенесён («Аня»): 1 контакт' }).waitFor({ timeout: 5000 });
  const id = await until(async () => (await ipc(C, 'p2p_status')).id, 15000, 'P2P');
  if (id !== idA) throw new Error(`ID ${id} ≠ ${idA}`);
  const s = await ipc(C, 'settings_get');
  if (s.name !== 'Аня') throw new Error('имя: ' + s.name);
  if (!JSON.stringify(await ipc(C, 'links_list')).includes('Рабочая')) throw new Error('нет ссылки');
  const l = await ipc(C, 'contacts_list');
  if (l.length !== 1 || l[0].name !== 'Борис') throw new Error('контакты: ' + JSON.stringify(l));
  if (fs.existsSync(path.join(DIR.c, 'import.pending'))) throw new Error('import.pending остался');
  await go(C, 'chats');
  await C.page.locator('#chList .ch-item').first().click();
  await C.page.locator('.msg .bubble', { hasText: 'до переноса' }).waitFor({ timeout: 5000 });
});

await step('B получает сообщение с нового компьютера', async () => {
  await ipc(C, 'chat_send', { chat: chatA, text: 'я на новом ПК' });
  const chatB = (await ipc(B, 'chats_list'))[0].chat;
  await until(async () => (await ipc(B, 'chat_history', { chat: chatB })).msgs.some((m) => m.body === 'я на новом ПК'), 30000, 'сообщение у B');
});

await step('ошибок в консоли нет', async () => {
  if (errors.length) throw new Error(errors.slice(0, 3).join(' | '));
});

await browser.close();
for (const p of Object.values(procs)) p.kill('SIGTERM');
if (!failed) fs.rmSync(tmp, { recursive: true, force: true });
else console.log('логи:', tmp);
console.log(failed ? `ПРОВАЛЕНО: ${failed}` : 'ВСЁ ПРОШЛО');
process.exit(failed ? 1 : 0);
