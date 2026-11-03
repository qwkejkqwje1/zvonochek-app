// Общий запуск Chromium для e2e: в CI — пакет playwright (npm), в песочнице — через переменные окружения.
//   PW_MODULE=/путь/к/playwright-core/index.mjs  CHROMIUM_PATH=/usr/bin/chromium
const mod = await import(process.env.PW_MODULE || 'playwright');
export const chromium = mod.chromium || mod.default.chromium;
export function launch(extra = []) {
  return chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: [
      '--no-sandbox',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      ...extra,
    ],
  });
}
