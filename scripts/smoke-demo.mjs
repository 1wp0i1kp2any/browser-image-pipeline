// Браузерный смоук демо-страницы (Playwright, Chromium):
// синтетическая картинка → ручная генерация → движение качества →
// автоподбор под вес → сравнение стратегий. Проверяется именно то, что
// заказчик будет делать руками: декод (createImageBitmap+EXIF путь),
// кадр, энкод (wasm в браузере), размер блоба, ход fit через state.
//
// Запуск: сначала `npm run demo:build`, затем поднять preview
// (`npx vite preview --config demo/vite.config.ts --port 4173`) и
// `node scripts/smoke-demo.mjs [baseUrl]`.

import { chromium, firefox, webkit } from 'playwright';

const base = process.argv[2] ?? 'http://127.0.0.1:4173/';
const browserName = (process.argv[3] ?? process.env.SMOKE_BROWSER ?? 'chromium').toLowerCase();
const engines = { chromium, firefox, webkit };
const engine = engines[browserName];
if (!engine) {
  console.error(`Unknown browser "${browserName}"; expected chromium, firefox or webkit`);
  process.exit(2);
}

const browser = await engine.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  // MozJPEG (emscripten) печатает в console.error безобидный caution
  // про грубые таблицы квантования на низком качестве — это не ошибка страницы.
  if (m.type() === 'error' && !m.text().includes('quantization tables are too coarse')) {
    errors.push(`console: ${m.text()}`);
  }
});
page.on('response', (response) => {
  if (response.status() >= 400) {
    errors.push(`http ${response.status()}: ${response.url()}`);
  }
});
page.on('requestfailed', (request) => {
  errors.push(`requestfailed: ${request.url()} ${request.failure()?.errorText ?? ''}`);
});

const text = (sel) => page.locator(sel).innerText();
const assertNoErrorText = (value, where) => {
  if (/ошибк|error|failed|exception/i.test(value)) {
    throw new Error(`${where} содержит статус ошибки: ${value}`);
  }
};
const parseBytes = (value, where) => {
  assertNoErrorText(value, where);
  const match = value.match(/\((\d+) B\)/);
  if (!match) throw new Error(`${where}: не найден размер Blob в байтах: ${value}`);
  const size = Number(match[1]);
  if (!Number.isFinite(size) || size <= 0) throw new Error(`${where}: Blob пустой: ${value}`);
  return size;
};
const step = async (name, fn) => {
  await fn();
  if (errors.length > 0) throw new Error(`ошибки браузера: ${errors.join('; ')}`);
  console.log(`✓ ${name}`);
};
let failure;

try {
  await step('страница открывается, синтетика генерируется автоматически', async () => {
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForFunction(
      () => /Результат: .+\(\d+ B\)/.test(document.querySelector('#manual-result')?.textContent ?? ''),
      null,
      { timeout: 60_000 },
    );
    const result = await text('#manual-result');
    parseBytes(result, 'первый ручной результат');
    console.log('   ', result);
  });

  await step('движение качества меняет вес результата', async () => {
    const before = await text('#manual-result');
    await page.locator('#enc-quality').fill('0.4');
    await page.waitForFunction(
      (prev) => {
        const t = document.querySelector('#manual-result')?.textContent ?? '';
        return t.includes('Результат:') && t !== prev && t.includes('q=0.40');
      },
      before,
      { timeout: 60_000 },
    );
    console.log('   ', await text('#manual-result'));
  });

  await step('квантование + png в ручном режиме', async () => {
    await page.locator('#q-enabled').check();
    await page.locator('#enc-format').selectOption('image/png');
    await page.waitForFunction(
      () => document.querySelector('#manual-result')?.textContent.includes('image/png'),
      null,
      { timeout: 60_000 },
    );
    console.log('   ', await text('#manual-result'));
    await page.locator('#enc-format').selectOption('image/jpeg');
  });

  await step('метрики PSNR/SSIM посчитаны для ручного результата', async () => {
    await page.waitForFunction(
      () => document.querySelector('#metrics-result')?.textContent.includes('SSIM'),
      null,
      { timeout: 60_000 },
    );
    const metrics = await text('#metrics-result');
    assertNoErrorText(metrics, 'метрики');
    if (!/PSNR\s+(?:\d+(?:\.\d+)?|∞)/.test(metrics) || !/SSIM\s+\d/.test(metrics)) {
      throw new Error(`метрики не содержат чисел PSNR/SSIM: ${metrics}`);
    }
    console.log('   ', metrics);
  });

  await step('webp: ручной энкод в браузере (libwebp wasm)', async () => {
    await page.locator('#enc-format').selectOption('image/webp');
    await page.waitForFunction(
      () => document.querySelector('#manual-result')?.textContent.includes('image/webp'),
      null,
      { timeout: 60_000 },
    );
    console.log('   ', await text('#manual-result'));
  });

  await step('avif: ручной энкод в браузере (libaom wasm)', async () => {
    await page.locator('#enc-format').selectOption('image/avif');
    await page.locator('#enc-quality').fill('0.6');
    await page.waitForFunction(
      () => document.querySelector('#manual-result')?.textContent.includes('image/avif'),
      null,
      { timeout: 180_000 },
    );
    console.log('   ', await text('#manual-result'));
  });

  await step('пресет оптимизатора применяет контролы и перегенерирует', async () => {
    await page.locator('#preset-select').selectOption('jpeg-compat');
    await page.locator('#preset-apply').click();
    await page.waitForFunction(
      () => document.querySelector('#manual-result')?.textContent.includes('image/jpeg, q=0.85'),
      null,
      { timeout: 60_000 },
    );
    console.log('   ', await text('#manual-result'));
  });

  await step('fit: подбор под 12 КиБ доводит до результата с параметрами и числом проб', async () => {
    await page.locator('#fit-btn').click();
    await page.waitForFunction(
      () => document.querySelector('#fit-result')?.textContent.includes('params:'),
      null,
      { timeout: 120_000 },
    );
    const fitResult = await text('#fit-result');
    const fitSize = parseBytes(fitResult, 'fit-результат');
    if (fitSize > 12 * 1024) throw new Error(`fit превысил лимит: ${fitResult}`);
    if (!/quality=\d/.test(fitResult)) throw new Error(`fit не отдал params.quality: ${fitResult}`);
    console.log('   ', fitResult);
    const attempts = await page.locator('#attempts > div').count();
    console.log(`    строк попыток в логе state: ${attempts}`);
    if (attempts === 0) throw new Error('лог попыток пуст — state не доходит до страницы');
  });

  await step('сравнение стратегий заполняет таблицу (4 строки)', async () => {
    await page.locator('#compare-btn').click();
    await page.waitForFunction(
      () => document.querySelectorAll('#compare-table tbody tr').length === 4,
      null,
      { timeout: 300_000 },
    );
    const rows = await page.locator('#compare-table tbody tr').allInnerTexts();
    for (const r of rows) {
      parseBytes(r, 'строка сравнения стратегий');
      if (!/q=\d/.test(r)) throw new Error(`строка сравнения не содержит q: ${r}`);
      console.log('   ', r.replaceAll('\t', ' | '));
    }
  });

  await page.screenshot({
    path: browserName === 'chromium' ? 'scripts/demo-smoke.png' : `scripts/demo-smoke-${browserName}.png`,
    fullPage: true,
  });
  console.log(`✓ скриншот: scripts/demo-smoke${browserName === 'chromium' ? '' : `-${browserName}`}.png`);
} catch (error) {
  failure = error;
} finally {
  await browser.close();
}

if (failure) {
  console.error(`СМОУК ПРОВАЛЕН (${browserName}):`, failure);
}
if (errors.length > 0) {
  console.error('Ошибки страницы:\n' + errors.join('\n'));
}
if (failure || errors.length > 0) process.exit(1);
console.log(`СМОУК ПРОЙДЕН (${browserName})`);
