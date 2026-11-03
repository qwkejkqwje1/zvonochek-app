// Тестовое обновление для zv-devhost: ключ Ed25519, «exe», подписанный latest.json (как делает release.yml).
//   node tests/e2e/update-fixture.mjs <папка> <адрес папки по http> → печатает открытый ключ (hex) для ZV_UPDATE_KEY
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [dir, base] = process.argv.slice(2);
fs.mkdirSync(dir, { recursive: true });
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const exe = Buffer.concat([Buffer.from('MZ ZVONochek test update\n'), crypto.randomBytes(200_000)]);
fs.writeFileSync(path.join(dir, 'ZVONochek.exe'), exe);
const sig = crypto.sign(null, exe, privateKey).toString('base64');
const manifest = {
  version: '9.9.9',
  notes: 'Тестовое обновление: проверка загрузки и подписи.',
  platforms: { devhost: { url: `${base}/ZVONochek.exe`, size: exe.length, sig } },
};
fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(manifest, null, 2));
const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
console.log(raw.toString('hex'));
