// Группы между тремя zv-devhost (P2P iroh локально + заглушка Worker). Хосты запускает сам тест.
// A дружит с B и с C, B и C друг другу не контакты:
// «Новая группа» (выбор контактов) → у B и C группа и служебные строки → сообщения с именами авторов →
// B пишет C (не контакту) → ✓✓ «доставлено всем» → «Вера печатает…» → участники (не в контактах, администратор) →
// переименование → групповой звонок: входящее у B, «Присоединиться» у C → история «· группа» →
// исключение C (только чтение, удалить у себя) → B выходит → у A «1 участник», звонить некому → ошибок в консоли нет.
//   node tests/e2e/devhost-groups.mjs [путь к zv-devhost] [каталог ui]
import { launch } from './pw.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BIN = process.argv[2] || '/data/zv4-target/debug/zv-devhost';
const UI = process.argv[3] || new URL('../../ui', import.meta.url).pathname;
const [PA, PB, PC, PW] = [8801, 8802, 8803, 8809];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zvgroups-'));
const procs = {};
function startHost(tag, port, extra) {
  const log = fs.openSync(path.join(tmp, `${tag}.log`), 'a');
  procs[tag] = spawn(BIN, ['--port', String(port), '--ui', UI, '--data', path.join(tmp, tag), '--p2p-local', ...extra], {
    stdio: ['ignore', log, log],
    env: { ...process.env, RUST_LOG: 'info' },
  });
}
async function waitHttp(port) {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/shell/index.html`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('devhost не запустился: ' + port);
}
startHost('a', PA, ['--mock-worker', String(PW)]);
await waitHttp(PA);
startHost('b', PB, ['--local', `worker=http://127.0.0.1:${PW}`]);
startHost('c', PC, ['--local', `worker=http://127.0.0.1:${PW}`]);
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
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 720 }, permissions: ['microphone', 'camera'] });
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
const typeSend = async (x, text) => {
  await x.page.fill('#chInput', text);
  await x.page.press('#chInput', 'Enter');
};
const openGroup = async (x, name) => {
  await go(x, 'chats');
  await x.page.click(`#chList .ch-item:has-text("${name}")`);
  await x.page.waitForSelector(`#chTop .who b:has-text("${name}")`);
};
const popupOf = async (x, click) => {
  const [pop] = await Promise.all([x.ctx.waitForEvent('page', { timeout: 15000 }), click()]);
  await pop.waitForLoadState('load').catch(() => {});
  return pop;
};

const A = await mk('A', PA, 'Аня');
const B = await mk('B', PB, 'Борис');
const C = await mk('C', PC, 'Вера');

await step('контакты: A ↔ B, A ↔ C (B и C друг другу чужие)', async () => {
  for (const x of [A, B, C])
    await x.page.waitForFunction(() => window.__zvIpc.call('p2p_status').then((s) => s && s.running), null, { timeout: 20000 });
  for (const x of [B, C]) {
    const inv = await ipc(A, 'contact_invite');
    await ipc(x, 'contact_add', { code: inv.code, name: 'Аня' });
    await x.page.waitForFunction(() => window.__zvIpc.call('contacts_list').then((l) => l.length === 1), null, { timeout: 30000 });
  }
  await A.page.waitForFunction(() => window.__zvIpc.call('contacts_list').then((l) => l.length === 2), null, { timeout: 30000 });
});

await step('A: «Новая группа» — название и выбор контактов', async () => {
  await go(A, 'chats');
  await A.page.click('#chNewGroup');
  await A.page.waitForSelector('.dialog h3:has-text("Новая группа")');
  const ok = A.page.locator('.dialog .btn.primary:has-text("Создать")');
  if (!(await ok.isDisabled())) throw new Error('«Создать» доступна без участников');
  await A.page.fill('.dialog input.field', 'Семья');
  await A.page.check('.dialog label.gm-row:has-text("Борис") input');
  await A.page.check('.dialog label.gm-row:has-text("Вера") input');
  await A.page.waitForSelector('.dialog small:has-text("Выбрано 2 из 5")');
  await ok.click();
  await A.page.waitForSelector('#chTop .who b:has-text("Семья")');
  await A.page.waitForSelector('#chTop small:has-text("3 участника")');
  await A.page.waitForSelector('.ch-sys:has-text("Вы создали группу «Семья»")');
  await A.page.waitForSelector('#chList .ch-item.on:has-text("Семья") .av.grp');
});

await step('B и C: группа в списке, служебная строка о приглашении', async () => {
  for (const x of [B, C]) {
    await go(x, 'chats');
    await x.page.waitForSelector('#chList .ch-item:has-text("Семья")', { timeout: 30000 });
    await openGroup(x, 'Семья');
    await x.page.waitForSelector('.ch-sys:has-text("добавляет вас в группу «Семья»")', { timeout: 10000 });
    await x.page.waitForSelector('#chTop small:has-text("3 участника")');
  }
});

await step('сообщение A → у B и C пузырь с именем автора', async () => {
  await typeSend(A, 'Всем привет!');
  for (const x of [B, C]) {
    await bubble(x, 'Всем привет!').waitFor({ timeout: 20000 });
    const who = await bubble(x, 'Всем привет!').locator('.who').textContent();
    if (who !== 'Аня') throw new Error(`${x.tag}: автор «${who}»`);
  }
  if (await bubble(A, 'Всем привет!').locator('.who').count()) throw new Error('у своего сообщения подпись автора');
});

await step('B пишет C (не контакт): имя из профиля, у B ✓✓ «доставлено всем»', async () => {
  await typeSend(B, 'Привет, Вера!');
  await bubble(C, 'Привет, Вера!').waitFor({ timeout: 25000 });
  const who = await bubble(C, 'Привет, Вера!').locator('.who').textContent();
  if (who !== 'Борис') throw new Error('автор у C: ' + who);
  await bubble(A, 'Привет, Вера!').waitFor({ timeout: 20000 });
  await B.page.waitForSelector('.msg.out:has-text("Привет, Вера!") .tk[title="Доставлено всем"]', { timeout: 25000 });
  // серия: второе сообщение подряд — без подписи
  await typeSend(B, 'Как дела?');
  await bubble(C, 'Как дела?').waitFor({ timeout: 20000 });
  if (await bubble(C, 'Как дела?').locator('.who').count()) throw new Error('подпись у второго сообщения серии');
});

await step('«Вера печатает…» у A', async () => {
  await C.page.fill('#chInput', 'набираю');
  await C.page.type('#chInput', '…');
  await A.page.waitForSelector('#chTop small.typing:has-text("Вера печатает…")', { timeout: 10000 });
  await C.page.fill('#chInput', '');
});

await step('участники у C: администратор, «не в контактах», добавить в контакты', async () => {
  await C.page.click('#chTop .who.click');
  await C.page.waitForSelector('.dialog .gm-row:has-text("Вера (вы)")');
  if ((await C.page.locator('.dialog .gm-row').count()) !== 3) throw new Error('не 3 участника');
  await C.page.waitForSelector('.dialog .gm-row:has-text("Аня") small:has-text("администратор")');
  await C.page.waitForSelector('.dialog .gm-row:has-text("Борис") small:has-text("не в контактах")');
  await C.page.waitForSelector('.dialog .gm-row:has-text("Борис") button[title="Добавить в контакты"]');
  if (await C.page.locator('.dialog button[title="Исключить из группы"]').count()) throw new Error('исключать может не только администратор');
  if (await C.page.locator('.dialog .btn:has-text("Добавить")').count()) throw new Error('добавлять может не только администратор');
  await C.page.click('.dialog .btn.primary:has-text("Готово")');
});

await step('A переименовывает группу — у B новое название и служебная строка', async () => {
  await A.page.click('#chTop .acts button[title="Ещё"]');
  await A.page.click('.menu button:has-text("Переименовать")');
  await A.page.fill('.dialog input.field', 'Семья и друзья');
  await A.page.click('.dialog .btn.primary');
  await A.page.waitForSelector('#chTop .who b:has-text("Семья и друзья")');
  await B.page.waitForSelector('#chTop .who b:has-text("Семья и друзья")', { timeout: 20000 });
  await B.page.waitForSelector('#chList .ch-item:has-text("Семья и друзья")');
  await B.page.waitForSelector('.ch-sys:has-text("Семья и друзья")');
});

const pops = [];
await step('групповой звонок: у B входящее «Семья и друзья», B отклоняет; C присоединяется из ленты', async () => {
  const pa = await popupOf(A, () => A.page.click('#chTop .acts button[title="Групповой звонок"]'));
  pops.push(pa);
  if (!/\/web\//.test(pa.url())) throw new Error('окно звонка: ' + pa.url());
  await A.page.waitForSelector('.ch-call.live:has-text("Вы")', { timeout: 10000 });
  const card = B.page.locator('#incOverlay .inc-card', { hasText: 'Семья и друзья' });
  await card.waitFor({ timeout: 20000 });
  const sub = await card.locator('small').first().textContent();
  if (!/Групповой звонок · Аня/.test(sub)) throw new Error('подпись входящего: ' + sub);
  await card.locator('button[title="Отклонить"]').click();
  await card.waitFor({ state: 'detached', timeout: 5000 });
  // C: входящее тоже есть — но присоединиться можно и из ленты
  await C.page.waitForSelector('.ch-call.live button:has-text("Присоединиться")', { timeout: 20000 });
  const pc = await popupOf(C, () => C.page.click('.ch-call.live button:has-text("Присоединиться")'));
  pops.push(pc);
  await C.page.waitForSelector('#incOverlay .inc-card', { state: 'detached', timeout: 10000 });
  const hist = await ipc(B, 'history_list');
  const e = hist.find((x) => x.groupId);
  if (!e || e.result !== 'declined') throw new Error('история B: ' + JSON.stringify(hist[0]));
});

await step('история звонков B: «Семья и друзья · группа», «Позвонить в группу»', async () => {
  await go(B, 'history');
  const row = B.page.locator('#histList .item', { hasText: 'Семья и друзья' }).first();
  await row.waitFor({ timeout: 5000 });
  await row.locator('.sub:has-text("группа")').waitFor();
  await row.locator('button[title="Позвонить в группу"]').waitFor();
  await go(B, 'chats');
});
for (const p of pops) await p.close().catch(() => {});

await step('A исключает C — у C «только чтение», C удаляет группу у себя', async () => {
  await A.page.click('#chTop .who.click');
  await A.page.click('.dialog .gm-row:has-text("Вера") button[title="Исключить из группы"]');
  await A.page.click('.dialog:has-text("Исключить «Вера»") .btn.danger');
  await A.page.waitForFunction(() => document.querySelectorAll('.dialog .gm-row').length === 2, null, { timeout: 10000 });
  await A.page.click('.dialog .btn.primary:has-text("Готово")');
  await A.page.waitForSelector('#chTop small:has-text("2 участника")', { timeout: 10000 });
  await C.page.waitForSelector('.ch-compose.ch-left:has-text("Вы больше не участник")', { timeout: 25000 });
  await C.page.waitForSelector('#chList .ch-item:has-text("Семья") :text("вы вышли")');
  if (await C.page.locator('#chInput').count()) throw new Error('у исключённого осталось поле ввода');
  await C.page.click('.ch-compose.ch-left .btn:has-text("Удалить группу")');
  await C.page.click('.dialog .btn.danger');
  await C.page.waitForSelector('#chList .ch-item:has-text("Семья")', { state: 'detached', timeout: 10000 });
});

await step('B выходит из группы — у A «1 участник», кнопок звонка нет', async () => {
  await B.page.click('#chTop .acts button[title="Ещё"]');
  await B.page.click('.menu button:has-text("Выйти из группы")');
  await B.page.click('.dialog .btn.danger');
  await B.page.waitForSelector('.ch-compose.ch-left', { timeout: 10000 });
  await A.page.waitForSelector('#chTop small:has-text("1 участник")', { timeout: 25000 });
  if (await A.page.locator('#chTop .acts button[title="Групповой звонок"]').count()) throw new Error('кнопка звонка без собеседников');
  await A.page.waitForSelector('.ch-sys:has-text("Борис")');
});

await step('узкое окно: шапка группы и ленты без горизонтальной прокрутки', async () => {
  await A.page.setViewportSize({ width: 420, height: 700 });
  await A.page.waitForSelector('.ch-back', { state: 'visible' });
  const over = await A.page.evaluate(() => {
    const s = document.querySelector('#chScroll');
    const t = document.querySelector('#chTop');
    return Math.max(s.scrollWidth - s.clientWidth, t.scrollWidth - t.clientWidth);
  });
  if (over > 1) throw new Error('горизонтальная прокрутка: ' + over);
  await A.page.setViewportSize({ width: 1100, height: 720 });
});

if (errors.length) {
  failed++;
  console.log('✗ ошибки в консоли:\n  ' + errors.slice(0, 10).join('\n  '));
} else console.log('✓ ошибок в консоли нет');
await browser.close();
for (const p of Object.values(procs)) p.kill('SIGTERM');
console.log(failed ? `ИТОГ: ${failed} ошибок (логи: ${tmp})` : 'ИТОГ: всё прошло');
process.exit(failed ? 1 : 0);
