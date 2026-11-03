// Генератор тест-векторов совместимости: исполняет crypto.js / ntfy.js веб-версии
// (Node 24 умеет WebCrypto, CompressionStream, atob/btoa) и пишет JSON.
//   WEB_DIR=../zvonochek node tools/gen-vectors.mjs > spec/vectors/web-v39.json
// Проверка обратного направления (Rust seal → JS open):
//   WEB_DIR=… node tools/gen-vectors.mjs --check rust-sealed.json
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const WEB = path.resolve(process.env.WEB_DIR || '../zvonochek');
const C = await import(pathToFileURL(path.join(WEB, 'crypto.js')).href + '?v=39');
const N = await import(pathToFileURL(path.join(WEB, 'ntfy.js')).href + '?v=39');

if (process.argv[2] === '--check') {
  const items = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  let ok = 0;
  for (const it of items) {
    const room = await C.deriveRoom(it.secret);
    if (room.topic !== it.topic) throw new Error('topic mismatch for ' + it.secret);
    const got = await C.open(room.key, it.sealed, room.topic);
    if (JSON.stringify(got) !== JSON.stringify(it.plain)) {
      throw new Error('open mismatch: ' + JSON.stringify({ got, want: it.plain }));
    }
    ok++;
  }
  console.log(`OK: веб открыл ${ok} конвертов от Rust`);
  process.exit(0);
}

const secrets = [
  'AbCdEfGhIjKlMnOpQrStUv', // минимальная длина 22 (16 байт)
  'q0-_Zx9Yb8Wc7Vd6Ue5Tf4Sg3Rh2Qi1Pj0Ok-NlMm_A', // 43 символа (32 байта), с - и _
  C.newSecret(),
];
const plains = [
  { type: 'hello', name: 'Аня 🙂', ver: 39, bc: 1 },
  { type: 'desc', gen: 2, desc: { type: 'offer', sdp: 'v=0\r\na=fingerprint:sha-256 AB:CD\r\n'.repeat(40) } },
  { type: 'voice2', sr: 48000, b64: 'QUJD'.repeat(120), _noZip: 1 },
  { type: 'bye', from: '0011223344556677', inst: 'aabbccddeeff', mid: '1-2', ts: 1700000000000 },
];
const out = { generator: 'tools/gen-vectors.mjs', web: process.env.WEB_COMMIT || 'a61b11e (v39)', rooms: [] };
for (const secret of secrets) {
  const room = await C.deriveRoom(secret);
  const sealed = [];
  for (const p of plains) sealed.push({ plain: p, sealed: await C.seal(room.key, p, room.topic) });
  out.rooms.push({
    secret,
    topic: room.topic,
    ntfy: await N.ntfyTopic('zv1-', room.topic),
    sealed,
  });
}
const sdpA = 'v=0\r\na=fingerprint:sha-256 AA:BB:CC\r\n';
const sdpB = 'v=0\r\na=fingerprint:sha-256 11:22:33\r\na=fingerprint:sha-1 de:ad\r\n';
out.safety = [{ sdpA, sdpB, ...(await C.safetyCode(sdpA, sdpB)) }];
console.log(JSON.stringify(out, null, 1));
