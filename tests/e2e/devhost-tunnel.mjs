// Туннель звонка (ADR-0008): приложение ↔ приложение (два zv-devhost, P2P iroh локально, сигналы — заглушка
// Worker). Сценарий 1 — ZV_TUNNEL_ONLY=1: ядра убирают из SDP собеседника все кандидаты, кроме туннеля, —
// звонок обязан соединиться через туннель (пакеты идут в обе стороны). Сценарий 2 — обычный: туннель есть,
// но браузеры выбирают прямой путь (локальная сеть); звонок соединяется, после завершения туннель закрыт.
//   node tests/e2e/devhost-tunnel.mjs [путь к zv-devhost] [каталог ui]
import { launch } from './pw.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const BIN = process.argv[2] || '/data/zv4-target/debug/zv-devhost';
const UI = process.argv[3] || new URL('../../ui', import.meta.url).pathname;
const PA = 8801;
const PB = 8802;
const PW = 8803;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zvtun-'));
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
function startHost(tag, port, extra, env) {
  const log = fs.openSync(path.join(tmp, `${tag}.log`), 'a');
  return spawn(BIN, ['--port', String(port), '--ui', UI, '--data', path.join(tmp, tag), '--p2p-local', ...extra], {
    stdio: ['ignore', log, log],
    env: { ...process.env, RUST_LOG: 'info,zv_core=debug', ...env },
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
const browser = await launch();

async function scenario(title, only) {
  console.log(`— ${title}`);
  const env = { ZV_TUNNEL_ONLY: only ? '1' : '0' };
  const ha = startHost(`a${only ? 1 : 0}`, PA, ['--mock-worker', String(PW), '--local', `worker=http://127.0.0.1:${PW}`], env);
  await waitHttp(PA);
  const hb = startHost(`b${only ? 1 : 0}`, PB, ['--local', `worker=http://127.0.0.1:${PW}`], env);
  await waitHttp(PB);
  const secret = crypto.randomBytes(16).toString('base64url');
  const mk = async (tag, port, name) => {
    const ctx = await browser.newContext({ permissions: ['microphone', 'camera'] });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log(`[${tag}] pageerror: ${e.message}`));
    const boot = encodeURIComponent(JSON.stringify({ auto: true, name }));
    await page.goto(`http://127.0.0.1:${port}/web/index.html?zvboot=${boot}#k=${secret}`, { waitUntil: 'load' });
    return { ctx, page, tag };
  };
  const a = await mk('a', PA, 'Аня');
  const b = await mk('b', PB, 'Боря');
  const ipc = (x, cmd, args = {}) => x.page.evaluate(([c, g]) => window.__zvIpc.call(c, g), [cmd, args]);
  const tunnels = async (x) => ((await ipc(x, 'p2p_status')) || {}).tunnels || [];
  await step('оба в звонке', async () => {
    await a.page.waitForSelector('#call:not(.hidden)', { timeout: 20000 });
    await b.page.waitForSelector('#call:not(.hidden)', { timeout: 20000 });
  });
  await step('соединились (качество связи на экране)', async () => {
    await Promise.all([a, b].map((x) => x.page.waitForSelector('#quality:not(.hidden)', { timeout: 90000 })));
    await a.page.waitForTimeout(4000);
    for (const x of [a, b]) console.log(`   ${x.tag}: ${(await x.page.innerText('#quality')).replace(/\s+/g, ' ').slice(0, 80)}`);
  });
  await step(only ? 'медиа идёт через туннель в обе стороны' : 'туннель поднят, звонок не сломан', async () => {
    const ta = await tunnels(a);
    const tb = await tunnels(b);
    console.log('   туннель A:', JSON.stringify(ta), '\n   туннель B:', JSON.stringify(tb));
    if (ta.length !== 1 || tb.length !== 1) throw new Error('нет туннеля у обоих');
    if (only) {
      for (const t of [...ta, ...tb]) if (t.rx < 100 || t.tx < 100) throw new Error('мало пакетов через туннель');
      const q = await a.page.innerText('#quality');
      if (/Мост|TURN/i.test(q)) throw new Error('путь не туннель: ' + q);
    }
  });
  await step('завершение — туннель закрыт', async () => {
    await a.page.click('#cHang');
    await a.page.waitForTimeout(2500);
    const ta = await tunnels(a);
    if (ta.length) throw new Error('туннель A остался: ' + JSON.stringify(ta));
  });
  await a.ctx.close();
  await b.ctx.close();
  ha.kill();
  hb.kill();
  await new Promise((r) => setTimeout(r, 800));
}

await scenario('только туннель (ZV_TUNNEL_ONLY=1)', true);
await scenario('обычный звонок (туннель как запасной путь)', false);
await browser.close();
console.log(failed ? `ОШИБОК: ${failed} (журналы: ${tmp})` : 'всё прошло');
if (!failed) fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
