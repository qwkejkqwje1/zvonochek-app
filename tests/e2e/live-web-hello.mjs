// Живой сайт ↔ zv-cli: веб входит в комнату, проверяем, что ядро видит его hello, а веб — наш.
import { chromium } from '/data/tools/node_modules/playwright-core/index.mjs';
const link = process.argv[2];
const browser = await chromium.launch({
  executablePath: '/usr/local/bin/chromium',
  args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
const ctx = await browser.newContext({ permissions: ['microphone', 'camera'] });
const page = await ctx.newPage();
const logs = [];
page.on('console', (m) => logs.push(m.type() + ': ' + m.text()));
await page.goto('https://qwkejkqwje1.github.io/zvonochek/', { waitUntil: 'load' });
await page.evaluate(() => localStorage.setItem('zvOnboarded', '1'));
await page.goto(link, { waitUntil: 'load' });
await page.reload({ waitUntil: 'load' });
await page.waitForSelector('#prejoin:not(.hidden)', { timeout: 15000 });
await page.fill('#name', 'Веб-тест');
await page.click('#btnJoin');
await page.waitForSelector('#call:not(.hidden)', { timeout: 15000 });
await page.waitForTimeout(14000);
const txt = await page.evaluate(() => {
  const l = document.querySelector('#log, #callLog, .log');
  return (l ? l.innerText : '').slice(-1500);
});
console.log('--- web log ---\n' + txt);
console.log('--- console (errors) ---\n' + logs.filter((l) => l.startsWith('error')).slice(0, 10).join('\n'));
await browser.close();
