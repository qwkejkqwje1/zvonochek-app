// Релиз Windows: подписать exe (Ed25519, секрет ZV_UPDATE_KEY — PEM) и собрать latest.json для самообновления
// (формат — crates/zv-core/src/update.rs). Вход: <папка> с ZVONochek_x64.exe / ZVONochek_arm64.exe.
// Выход: <папка>/out/ZVONochek_<версия>_<arch>.exe, latest.json; <папка>/notes.md — текст релиза из CHANGELOG.md.
//   ZV_UPDATE_KEY=… ZV_RELEASE_REPO=владелец/репозиторий node .github/scripts/sign-release.mjs dist v4.0.1
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const fail = (m) => {
  console.error('::error::' + m);
  process.exit(1);
};
const [dir, tag = ''] = process.argv.slice(2);
const version = JSON.parse(fs.readFileSync('app/tauri.conf.json', 'utf8')).version;
// версия внутри exe и в манифесте должны совпадать — иначе приложение обновлялось бы по кругу
if (/^v\d/.test(tag) && tag !== `v${version}`) fail(`тег ${tag} не совпадает с версией ${version} в app/tauri.conf.json`);
const pem = process.env.ZV_UPDATE_KEY;
if (!pem) fail('нет секрета ZV_UPDATE_KEY');
const key = crypto.createPrivateKey(pem);
const pub = crypto.createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
if (!fs.readFileSync('crates/zv-core/src/update.rs', 'utf8').includes(pub))
  fail(`открытый ключ ${pub} не записан в KEYS_HEX (crates/zv-core/src/update.rs) — приложение не примет обновление`);
const repo = process.env.ZV_RELEASE_REPO || process.env.GITHUB_REPOSITORY;
const out = path.join(dir, 'out');
fs.mkdirSync(out, { recursive: true });
const platforms = {};
for (const arch of ['x64', 'arm64']) {
  const src = path.join(dir, `ZVONochek_${arch}.exe`);
  if (!fs.existsSync(src)) fail(`нет ${src}`);
  const data = fs.readFileSync(src);
  if (data.subarray(0, 2).toString() !== 'MZ') fail(`${src} — не exe`);
  const name = `ZVONochek_${version}_${arch}.exe`;
  fs.copyFileSync(src, path.join(out, name));
  const sig = crypto.sign(null, data, key);
  if (!crypto.verify(null, data, crypto.createPublicKey(key), sig)) fail('подпись не проверилась');
  platforms[`windows-${arch}`] = {
    url: `https://github.com/${repo}/releases/download/v${version}/${name}`,
    size: data.length,
    sig: sig.toString('base64'),
    sha256: crypto.createHash('sha256').update(data).digest('hex'),
  };
  console.log(`${name}: ${data.length} байт`);
}
// что нового — раздел этой версии из CHANGELOG.md
const log = fs.readFileSync('CHANGELOG.md', 'utf8');
const m = log.match(new RegExp(`^## \\[?${version.replace(/\./g, '\\.')}\\]?[^\\n]*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm'));
const notes = (m ? m[1] : '').trim();
fs.writeFileSync(
  path.join(out, 'latest.json'),
  JSON.stringify({ version, notes: notes.slice(0, 3500), pub_date: new Date().toISOString(), platforms }, null, 2)
);
fs.writeFileSync(
  path.join(dir, 'notes.md'),
  `${notes || 'Что нового — в CHANGELOG.md.'}\n\n---\nWindows: ZVONochek_${version}_x64.exe — для обычных ПК, …_arm64.exe — для ПК на ARM (Snapdragon). ` +
    'Без установки: положите exe в папку (например, «Документы» или флешку) и запустите — данные будут в папке ZVONochek-data рядом с ним. ' +
    'Уже установленный ZVONochek обновится сам.\n'
);
console.log(`latest.json: ${version}, ${Object.keys(platforms).join(', ')} → ${repo}`);
