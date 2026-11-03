#!/usr/bin/env python3
"""THIRD-PARTY-NOTICES: лицензии всех сторонних компонентов сборки.

Rust — по `cargo metadata` (граф зависимостей для целей Windows x64/ARM64 и Android),
тексты берутся из файлов LICENSE*/COPYING*/NOTICE* самих пакетов; JS — из шапок vendor-файлов.
Пишет THIRD-PARTY-NOTICES.md (репозиторий/установщик) и ui/shell/licenses.html (окно «Лицензии»).

  python3 tools/gen-notices.py [--target x86_64-pc-windows-msvc ...]
"""
import hashlib, html, json, os, re, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
targets = [a for a in sys.argv[1:] if not a.startswith('-')] or [
    'x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc', 'aarch64-linux-android']

def metadata(target):
    out = subprocess.run(['cargo', 'metadata', '--format-version', '1', '--locked', '--filter-platform', target],
                         cwd=ROOT, capture_output=True, text=True, check=True).stdout
    return json.loads(out)

pkgs = {}
for t in targets:
    try:
        m = metadata(t)
    except subprocess.CalledProcessError as e:
        print('cargo metadata', t, e.stderr[-400:], file=sys.stderr)
        continue
    byid0 = {p['id']: p for p in m['packages']}
    # в приложение не входят инструменты разработки
    ws = {i for i in m['workspace_members'] if byid0[i]['name'] not in ('zv-cli', 'zv-devhost')}
    members = set(m['workspace_members'])
    # только то, что реально попадает в сборку: обычные зависимости (не dev), от членов workspace
    nodes = {n['id']: n for n in m['resolve']['nodes']}
    byid = {p['id']: p for p in m['packages']}
    seen = set()
    stack = list(ws)
    while stack:
        i = stack.pop()
        if i in seen:
            continue
        seen.add(i)
        for d in nodes[i]['deps']:
            if any(k.get('kind') in (None, 'build') for k in d['dep_kinds']):
                stack.append(d['pkg'])
    for i in seen - members:
        p = byid[i]
        pkgs[(p['name'], p['version'])] = p

LIC_RE = re.compile(r'^(licen[cs]e|copying|notice|copyright|unlicense)', re.I)
def license_texts(p):
    d = Path(p['manifest_path']).parent
    files = []
    for f in sorted(d.iterdir()):
        if f.is_file() and LIC_RE.match(f.name) and f.stat().st_size < 200_000:
            try:
                files.append((f.name, f.read_text(errors='replace').strip()))
            except Exception:
                pass
    if p.get('license_file'):
        f = d / p['license_file']
        if f.exists() and all(n != f.name for n, _ in files):
            files.append((f.name, f.read_text(errors='replace').strip()))
    return files

STD = {
 'MIT': 'Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.',
}

entries = []  # (title, license_id, texts[(name, text)])
for (name, ver), p in sorted(pkgs.items()):
    texts = license_texts(p)
    lic = p.get('license') or ('см. ' + p['license_file'] if p.get('license_file') else 'не указана')
    if not texts:
        authors = ', '.join(p.get('authors') or []) or name + ' developers'
        if 'MIT' in lic:
            texts = [('MIT (текст по лицензии пакета)', f'Copyright (c) {authors}\n\n' + STD['MIT'])]
    entries.append((f'{name} {ver}', lic, p.get('repository') or '', texts))

# JS, встроенные в веб-клиент
def js_header(path):
    try:
        txt = (ROOT / path).read_text(errors='replace')
    except FileNotFoundError:
        return ''
    m = re.match(r'\s*((?://[^\n]*\n|/\*.*?\*/\s*)+)', txt, re.S)
    return m.group(1).strip() if m else ''
js = [
    ('QR Code Generator for JavaScript (qrcode.js)', 'MIT', 'https://github.com/kazuhikoarase/qrcode-generator',
     'ui/web/vendor/qrcode.js', 'Copyright (c) 2009 Kazuhiko Arase'),
    ('noble-secp256k1', 'MIT', 'https://github.com/paulmillr/noble-secp256k1',
     'ui/web/vendor/secp256k1.js', 'Copyright (c) 2019 Paul Miller (https://paulmillr.com)'),
]
for title, lic, repo, path, copy in js:
    head = js_header(path)
    entries.append((title, lic, repo, [('LICENSE', f'{copy}\n\n' + STD['MIT'] + (f'\n\n— шапка файла:\n{head}' if head else ''))]))

# одинаковые тексты — один раз (сравнение без учёта пробелов)
texts_by_key = {}
text_order = []
crate_refs = []
for title, lic, repo, texts in entries:
    refs = []
    for n, t in texts:
        key = hashlib.sha1(re.sub(r'\s+', ' ', t).strip().encode()).hexdigest()[:12]
        if key not in texts_by_key:
            texts_by_key[key] = (n, t, [])
            text_order.append(key)
        texts_by_key[key][2].append(title)
        refs.append(key)
    crate_refs.append((title, lic, repo, refs))

intro = ('ZVONochek для ПК © ZVONochek. Все права защищены.\n\n'
         'В программу входят сторонние компоненты с открытыми лицензиями; ниже — их список и тексты лицензий. '
         'Microsoft Edge WebView2 Runtime не входит в состав программы: он устанавливается из Windows '
         'или загрузчиком Microsoft по условиям Microsoft.')

md = ['# Сторонние компоненты (THIRD-PARTY-NOTICES)', '', intro, '',
      f'Всего компонентов: {len(entries)}.', '', '## Компоненты', '']
num = {k: i + 1 for i, k in enumerate(text_order)}
for t, lic, repo, refs in crate_refs:
    md.append(f'- **{t}** — {lic}' + (f' — {repo}' if repo else '') + (' — тексты: ' + ', '.join(f'[{num[r]}](#t{num[r]})' for r in refs) if refs else ''))
md += ['', '## Тексты лицензий', '']
for k in text_order:
    n, t, users = texts_by_key[k]
    md.append(f'<a id="t{num[k]}"></a>\n### [{num[k]}] {n} — ' + ', '.join(users[:8]) + (' …' if len(users) > 8 else ''))
    md.append(f'\n```\n{t}\n```\n')
(ROOT / 'THIRD-PARTY-NOTICES.md').write_text('\n'.join(md) + '\n')

h = ['<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Лицензии — ZVONochek</title>',
     '<style>body{font:13px/1.5 "Segoe UI",system-ui,sans-serif;margin:0;padding:18px 22px;color:#1a2633;background:#fff}'
     'h1{font-size:18px;margin:0 0 6px}h2{font-size:15px;margin:22px 0 6px}h3{font-size:13px;margin:16px 0 4px}'
     'ul{margin:4px 0 8px;padding-left:18px}pre{white-space:pre-wrap;background:#f5f7fa;border:1px solid #e3e8ee;'
     'border-radius:8px;padding:10px;font:11.5px/1.45 Consolas,monospace;max-height:320px;overflow:auto}'
     'a{color:#2569bd}.m{color:#6b7a89}</style></head><body>',
     '<h1>Сторонние компоненты</h1>', '<p>' + html.escape(intro).replace('\n\n', '</p><p>') + '</p>',
     f'<p class="m">Всего компонентов: {len(entries)}.</p><h2>Компоненты</h2><ul>']
for t, lic, repo, refs in crate_refs:
    h.append(f'<li><b>{html.escape(t)}</b> — {html.escape(lic)}' + (f' <span class="m">{html.escape(repo)}</span>' if repo else '')
             + (' — ' + ', '.join(f'<a href="#t{num[r]}">[{num[r]}]</a>' for r in refs) if refs else '') + '</li>')
h.append('</ul><h2>Тексты лицензий</h2>')
for k in text_order:
    n, t, users = texts_by_key[k]
    h.append(f'<h3 id="t{num[k]}">[{num[k]}] {html.escape(n)} <span class="m">— {html.escape(", ".join(users[:8]))}{" …" if len(users) > 8 else ""}</span></h3><pre>{html.escape(t)}</pre>')
h.append('</body></html>')
(ROOT / 'ui/shell/licenses.html').write_text('\n'.join(h))
print(f'компонентов: {len(entries)}, уникальных текстов: {len(text_order)}; без текста: '
      + ', '.join(t for t, _, _, x in entries if not x)[:600])
