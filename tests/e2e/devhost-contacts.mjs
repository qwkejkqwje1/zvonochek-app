// Контакты между двумя zv-devhost (два ядра, P2P через iroh): приглашение → контакт у обоих → «в сети» →
// код безопасности → аудиозвонок контакту (ответ, соединение, завершение) → отклонение видеозвонка →
// «не беспокоить» → переименование → удаление → звонок по ссылке → «В контакты» из истории → P2P выкл/вкл.
//   node tests/e2e/devhost-contacts.mjs [http://127.0.0.1:8790] [http://127.0.0.1:8791]
// Оба хоста — со свежими каталогами данных.
import { launch } from './pw.mjs';
const HA = process.argv[2] || 'http://127.0.0.1:8790';
const HB = process.argv[3] || 'http://127.0.0.1:8791';
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
const mk = async (tag, host, name) => {
  const ctx = await browser.newContext({
    viewport: { width: 1000, height: 700 },
    permissions: ['clipboard-read', 'clipboard-write', 'microphone', 'camera'],
  });
  const watch = (p, t) => {
    p.on('console', (m) => m.type() === 'error' && !/WebSocket|429|ERR_|Failed to load resource/.test(m.text()) && errors.push(`[${t}] ${m.text()}`));
    p.on('pageerror', (e) => errors.push(`[${t}] pageerror: ${e.message}`));
  };
  const page = await ctx.newPage();
  watch(page, tag);
  ctx.on('page', (p) => watch(p, tag + ':call'));
  await page.goto(`${host}/shell/index.html`, { waitUntil: 'load' });
  await page.evaluate((n) => window.__zvIpc.call('settings_set', { patch: { name: n, onboarded: true } }), name);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.__zvIpc && document.querySelector('#ctList'));
  return { ctx, page, tag };
};
const A = await mk('A', HA, 'Аня');
const B = await mk('B', HB, 'Борис');
const go = (x, p) => x.page.click(`.nav[data-page="${p}"]`);
const rowOf = (x, name) => x.page.locator('#ctList .item', { hasText: name });
const callPage = (x) => x.ctx.waitForEvent('page', { timeout: 10000 });
const inCall = (p) => p.waitForSelector('#call:not(.hidden)', { timeout: 30000 });
const connected = (p) => p.waitForSelector('#quality:not(.hidden)', { timeout: 60000 });
const left = (p) =>
  p.waitForFunction(() => !/(^#|&)k=/.test(location.hash), null, { timeout: 20000 });
let code = '';

await step('A: пустые контакты и приглашение', async () => {
  await go(A, 'contacts');
  await A.page.waitForSelector('#ctList .empty');
  await A.page.click('#ctInviteBtn');
  await A.page.waitForSelector('.dialog [data-code]');
  code = (await A.page.textContent('.dialog [data-code]')).trim();
  if (!code.startsWith('zv4c:')) throw new Error('код: ' + code.slice(0, 20));
  if (!(await A.page.$('.dialog .qr svg'))) throw new Error('нет QR');
  await A.page.click('.dialog .linkbox .btn');
  const clip = await A.page.evaluate(() => navigator.clipboard.readText());
  if (clip !== code) throw new Error('в буфере не код');
  await A.page.click('.dialog .actions .btn.primary');
  console.log('   длина кода:', code.length);
});

await step('B: добавить по коду (из буфера)', async () => {
  await go(B, 'contacts');
  await B.page.evaluate((c) => navigator.clipboard.writeText(c), code);
  await B.page.click('#ctAddBtn');
  await B.page.waitForFunction(() => document.querySelector('.dialog .hint')?.textContent.includes('Приглашение от «Аня»'), null, {
    timeout: 5000,
  });
  const nm = await B.page.inputValue('.dialog input.field');
  if (nm !== 'Аня') throw new Error('имя: ' + nm);
  await B.page.click('.dialog .actions .btn.primary');
  await B.page.waitForSelector('.dialog', { state: 'detached', timeout: 60000 });
  await rowOf(B, 'Аня').waitFor({ timeout: 5000 });
  await rowOf(A, 'Борис').waitFor({ timeout: 10000 });
});

await step('повторное добавление — ошибка в диалоге', async () => {
  await B.page.click('#ctAddBtn');
  await B.page.fill('.dialog textarea', code);
  await B.page.waitForFunction(() => document.querySelector('.dialog .hint')?.textContent.includes('Приглашение'));
  await B.page.click('.dialog .actions .btn.primary');
  await B.page.waitForFunction(() => document.querySelector('.dialog .hint.bad')?.textContent.includes('Уже в контактах'), null, {
    timeout: 5000,
  });
  await B.page.keyboard.press('Escape');
});

await step('«в сети» у обоих', async () => {
  await B.page.waitForSelector('#ctList .item .pres.ok', { timeout: 25000 });
  await A.page.waitForSelector('#ctList .item .pres.ok', { timeout: 25000 });
  console.log('   B видит A:', await rowOf(B, 'Аня').locator('[data-pres]').textContent());
});

await step('код безопасности совпадает, отметка «проверен»', async () => {
  const read = async (x, name) => {
    await rowOf(x, name).locator('[data-act=more]').click();
    await x.page.click('.menu button:has-text("Код безопасности")');
    const d = await x.page.textContent('.dialog .safety .digits');
    const e = await x.page.textContent('.dialog .safety .emoji');
    return [d, e];
  };
  const [db, eb] = await read(B, 'Аня');
  await B.page.click('.dialog .actions .btn.primary');
  const [da, ea] = await read(A, 'Борис');
  await A.page.keyboard.press('Escape');
  if (da !== db || ea !== eb) throw new Error(`${da} ${ea} ≠ ${db} ${eb}`);
  await rowOf(B, 'Аня').locator('.vbadge').waitFor({ timeout: 5000 });
  console.log('   код:', ea, da);
});

let bCall, aCall;
await step('B звонит A (аудио), A отвечает, соединение', async () => {
  const pb = callPage(B);
  await rowOf(B, 'Аня').locator('[data-act=call]').click();
  bCall = await pb;
  await A.page.waitForSelector('#incOverlay .inc-card', { timeout: 20000 });
  const t = await A.page.textContent('#incOverlay .inc-card');
  if (!t.includes('Аудиозвонок · контакт') || !t.includes('Борис')) throw new Error('карточка: ' + t);
  const pa = callPage(A);
  await A.page.click('#incOverlay .inc-card .round.ok');
  aCall = await pa;
  await Promise.all([inCall(aCall), inCall(bCall)]);
  await Promise.all([connected(aCall), connected(bCall)]);
  const camA = await aCall.getAttribute('#cCam', 'title');
  console.log('   камера у A:', camA, '| B:', await bCall.getAttribute('#cCam', 'title'));
  if (camA !== 'Камера выключена') throw new Error('аудиозвонок, а камера включена');
  const ring = await bCall.evaluate(() => document.querySelector('#zvRing')?.textContent || '');
  console.log('   статус у B:', ring);
});

await step('B завершает — A тоже, история с именами контактов', async () => {
  await bCall.waitForTimeout(1500);
  await bCall.click('#cHang');
  await left(bCall);
  await aCall.waitForSelector('#call.hidden, #home:not(.hidden)', { timeout: 20000 });
  await go(A, 'history');
  await go(B, 'history');
  await A.page.waitForFunction(() => document.querySelector('#histList .item .title')?.textContent === 'Борис', null, { timeout: 8000 });
  const sa = await A.page.textContent('#histList .item .sub');
  const sb = await B.page.textContent('#histList .item .sub');
  console.log('   A:', sa, '| B:', sb);
  if (!sa.includes('Входящий') || !sa.includes('контакт')) throw new Error('A: ' + sa);
  if (!sb.includes('Исходящий')) throw new Error('B: ' + sb);
  await aCall.close();
  await bCall.close();
});

await step('A звонит B с видео — B отклоняет — у A «отклонил», окно звонка завершается', async () => {
  await go(A, 'contacts');
  const pa = callPage(A);
  await rowOf(A, 'Борис').locator('[data-act=video]').click();
  aCall = await pa;
  await B.page.waitForSelector('#incOverlay .inc-card', { timeout: 20000 });
  const t = await B.page.textContent('#incOverlay .inc-card');
  if (!t.includes('Видеозвонок · контакт')) throw new Error('карточка: ' + t);
  if (!(await B.page.$('#incOverlay .round.ok.alt'))) throw new Error('нет «ответить без видео»');
  await B.page.click('#incOverlay .inc-card .round.bad');
  await aCall.waitForFunction(() => /отклонил/.test(document.querySelector('#zvRing')?.textContent || ''), null, { timeout: 15000 });
  await left(aCall);
  await A.page.waitForFunction(() => /отклонил/.test(document.querySelector('.toast')?.textContent || ''), null, { timeout: 3000 }).catch(() => {});
  await go(A, 'history');
  await A.page.waitForFunction(() => document.querySelector('#histList .item .sub')?.textContent.includes('Отклонён'), null, {
    timeout: 8000,
  });
  await aCall.close();
});

await step('«не беспокоить» у B: звонок A сразу завершается', async () => {
  await go(B, 'settings');
  await B.page.click('#setDnd + span');
  await B.page.waitForFunction(() => document.querySelector('#setDnd').checked);
  await go(A, 'contacts');
  const pa = callPage(A);
  await rowOf(A, 'Борис').locator('[data-act=call]').click();
  aCall = await pa;
  await aCall.waitForFunction(() => /Не беспокоить/.test(document.querySelector('#zvRing')?.textContent || ''), null, {
    timeout: 20000,
  });
  await left(aCall);
  await go(B, 'history');
  await B.page.waitForFunction(() => document.querySelector('#histList .item .sub')?.textContent.includes('Пропущенный'), null, {
    timeout: 8000,
  });
  await go(B, 'settings');
  await B.page.click('#setDnd + span');
  await aCall.close();
});

await step('переименовать и удалить контакт', async () => {
  await go(A, 'contacts');
  await rowOf(A, 'Борис').locator('[data-act=more]').click();
  await A.page.click('.menu button:has-text("Переименовать")');
  await A.page.fill('.dialog input.field', 'Боря');
  await A.page.keyboard.press('Enter');
  await rowOf(A, 'Боря').waitFor({ timeout: 5000 });
  await rowOf(A, 'Боря').locator('[data-act=more]').click();
  await A.page.click('.menu button:has-text("Удалить")');
  await A.page.click('.dialog .btn.danger');
  await A.page.waitForSelector('#ctList .empty', { timeout: 5000 });
  await go(B, 'contacts');
  await rowOf(B, 'Аня').locator('[data-act=more]').click();
  await B.page.click('.menu button:has-text("Удалить")');
  await B.page.click('.dialog .btn.danger');
  await B.page.waitForSelector('#ctList .empty', { timeout: 5000 });
});

await step('звонок по ссылке A → история B → «Добавить в контакты» → A принимает', async () => {
  const link = await A.page.evaluate(() => window.__zvIpc.call('link_create', { name: 'Для Бориса', listen: true }));
  await go(B, 'call');
  await B.page.fill('#dialInput', link.url);
  await B.page.waitForFunction(() => !document.querySelector('#dialBtn').disabled);
  const pb = callPage(B);
  await B.page.click('#dialBtn');
  bCall = await pb;
  await A.page.waitForSelector('#incOverlay .inc-card', { timeout: 30000 });
  const pa = callPage(A);
  await A.page.click('#incOverlay .inc-card .round.ok');
  aCall = await pa;
  await Promise.all([connected(aCall), connected(bCall)]);
  // P2P привязался к комнате звонка
  const st = await B.page.evaluate(() => window.__zvIpc.call('p2p_status'));
  console.log('   P2P у B:', (st.links || []).map((l) => `${l.path} ${l.rttMs} мс`).join(', '), '| комнат:', (st.bound || []).map((b) => b.rooms.length));
  await bCall.waitForTimeout(1000);
  await bCall.click('#cHang');
  await left(bCall);
  await go(B, 'history');
  await B.page.waitForSelector('#histList .item [data-act=offer]', { timeout: 8000 });
  await B.page.click('#histList .item [data-act=offer]');
  await B.page.fill('.dialog input.field', 'Аня (ссылка)');
  await B.page.click('.dialog .actions .btn.primary');
  await go(A, 'contacts');
  await A.page.waitForSelector('#ctOffers [data-offer]', { timeout: 20000 });
  const badge = await A.page.textContent('#offerCount');
  if (badge !== '1') throw new Error('счётчик: ' + badge);
  await A.page.click('#ctOffers [data-offer] .btn.primary');
  await A.page.click('.dialog .actions .btn.primary');
  await rowOf(A, 'Борис').waitFor({ timeout: 10000 });
  await go(B, 'contacts');
  await rowOf(B, 'Аня (ссылка)').waitFor({ timeout: 15000 });
  await aCall.close().catch(() => {});
  await bCall.close().catch(() => {});
});

await step('P2P выкл → предупреждение → «Включить»', async () => {
  await go(A, 'settings');
  await A.page.click('#setP2p + span');
  await A.page.click('.dialog .btn.danger');
  await go(A, 'contacts');
  await A.page.waitForSelector('#ctP2p:not(.hidden)', { timeout: 5000 });
  await A.page.click('#ctP2p .btn.primary');
  await A.page.waitForSelector('#ctP2p.hidden', { state: 'attached', timeout: 15000 });
  await A.page.waitForSelector('#ctList .item .pres.ok', { timeout: 30000 });
});

await step('диагностика: карточка P2P', async () => {
  await go(A, 'diag');
  await A.page.waitForSelector('.diag-p2p', { timeout: 5000 });
  console.log('   ', (await A.page.textContent('.diag-p2p')).replace(/\s+/g, ' ').slice(0, 220));
});

await step('без вылезания за окно (контакты, 420 px)', async () => {
  for (const x of [A, B]) {
    await x.page.setViewportSize({ width: 420, height: 700 });
    await go(x, 'contacts');
    const bad = await x.page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('#page-contacts *')) {
        const r = el.getBoundingClientRect();
        if (r.width && r.right > innerWidth + 1) out.push(el.tagName + '.' + el.className + ' ' + Math.round(r.right));
      }
      return out.slice(0, 5);
    });
    if (bad.length) throw new Error(x.tag + ': ' + bad.join('; '));
  }
});

if (errors.length) console.log('ошибки консоли:\n  ' + errors.slice(0, 15).join('\n  '));
await browser.close();
console.log(failed ? `ПРОВАЛЕНО шагов: ${failed}` : 'все шаги пройдены');
process.exit(failed || errors.length ? 1 : 0);
