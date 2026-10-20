// Браузерный benchmark-корпус и cold/warm профили кодеков.
//
// Перед запуском нужна production-сборка bench-страницы:
//   npm run bench:browser:build
// Затем:
//   ./node_modules/.bin/tsx scripts/benchmark-browser.ts [chromium|firefox|webkit|all]
//
// Каждый cold-замер выполняется в свежем BrowserContext и новой странице:
// первый encode/fit включает загрузку ленивого codec JS/wasm. Warm — второй
// запуск в той же странице. Результаты пишутся в benchmark-results/.

import { createServer, type Server } from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { chromium, firefox, webkit, type Browser, type Page } from 'playwright';
import { createBenchmarkCorpus } from './benchmark-frames.js';

const root = resolve(new URL('..', import.meta.url).pathname);
const benchDist = join(root, 'bench', 'dist');
const browserArg = (process.argv[2] ?? 'chromium').toLowerCase();
const engines = { chromium, firefox, webkit } as const;
type BrowserName = keyof typeof engines;
const browserNames: BrowserName[] =
  browserArg === 'all'
    ? ['chromium', 'firefox', 'webkit']
    : browserArg in engines
      ? [browserArg as BrowserName]
      : (() => {
          throw new Error(`unknown browser ${browserArg}`);
        })();

const mimeTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

async function startStaticServer(): Promise<{ server: Server; url: string }> {
  await stat(join(benchDist, 'index.html')).catch(() => {
    throw new Error('bench/dist/index.html not found; run npm run bench:browser:build first');
  });
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
      const relative = normalize(pathname === '/' ? 'index.html' : pathname.slice(1));
      const filePath = resolve(benchDist, relative);
      if (!filePath.startsWith(benchDist)) {
        response.writeHead(403).end('forbidden');
        return;
      }
      const data = await readFile(filePath);
      response.writeHead(200, {
        'content-type': mimeTypes[extname(filePath)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-embedder-policy': 'require-corp',
      });
      response.end(data);
    } catch {
      response.writeHead(404).end('not found');
    }
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('static server has no TCP address');
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

async function freshBenchPage(browser: Browser, url: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('requestfailed', (request) => {
    errors.push(`requestfailed: ${request.url()} ${request.failure()?.errorText ?? ''}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) errors.push(`HTTP ${response.status()}: ${response.url()}`);
  });
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => (window as any).__bipBench?.ready === true, null, {
    timeout: 30_000,
  });
  return {
    page,
    close: async () => {
      await context.close();
      if (errors.length > 0) throw new Error(errors.join('\n'));
    },
  };
}

async function runBrowser(name: BrowserName, url: string): Promise<void> {
  const browser = await engines[name].launch();
  const result: any = {
    generatedAt: new Date().toISOString(),
    browser: name,
    capabilities: null,
    formats: [],
    pngOptimizers: [],
    fit: [],
  };
  try {
    {
      const session = await freshBenchPage(browser, url);
      try {
        result.capabilities = await session.page.evaluate(() => (window as any).__bipBench.capabilities());
      } finally {
        await session.close();
      }
    }

    console.log(`\n## ${name}: cold/warm первого encode по форматам\n`);
    console.log('| Формат | cold first encode | warm median | размер | peak JS heap |');
    console.log('|---|---:|---:|---:|---:|');
    for (const format of ['image/jpeg', 'image/png', 'image/webp', 'image/avif']) {
      const session = await freshBenchPage(browser, url);
      try {
        const item: any = await session.page.evaluate(
          (value) => (window as any).__bipBench.profileFormat(value),
          format,
        );
        result.formats.push(item);
        if (!item.warmSizes.every((size: number) => size === item.firstSize)) {
          throw new Error(`${name}/${format}: warm size differs from cold size`);
        }
        const peak = Math.max(item.firstPeakUsedJsHeapBytes ?? 0, item.warmPeakUsedJsHeapBytes ?? 0);
        console.log(
          `| ${format} | ${item.firstEncodeMs.toFixed(1)} ms | ${median(item.warmEncodeMs).toFixed(1)} ms | ` +
            `${item.firstSize} B | ${peak ? `${(peak / 1024 / 1024).toFixed(1)} MiB` : 'n/a'} |`,
        );
      } finally {
        await session.close();
      }
    }

    console.log(`\n## ${name}: PNG optimizers\n`);
    console.log('| Движок | cold first optimize | warm median | вход | выход |');
    console.log('|---|---:|---:|---:|---:|');
    for (const engine of ['oxipng', 'compression-stream'] as const) {
      const session = await freshBenchPage(browser, url);
      try {
        const item: any = await session.page.evaluate(
          (value) => (window as any).__bipBench.profilePngOptimizer(value),
          engine,
        );
        result.pngOptimizers.push(item);
        if (!item.warmSizes.every((size: number) => size === item.firstSize)) {
          throw new Error(`${name}/${engine}: warm size differs from cold size`);
        }
        console.log(
          `| ${engine} | ${item.firstOptimizeMs.toFixed(1)} ms | ${median(item.warmOptimizeMs).toFixed(1)} ms | ` +
            `${item.inputSize} B | ${item.firstSize} B |`,
        );
      } finally {
        await session.close();
      }
    }

    console.log(`\n## ${name}: браузерный corpus стратегий\n`);
    console.log('| Кейс | Стратегия | attempts | q | размер | cold | warm | peak JS heap | совпадение |');
    console.log('|---|---|---:|---:|---:|---:|---:|---:|---|');
    const strategies = ['owner-loop', 'binary', 'secant', 'coarse-fine'] as const;
    for (const corpusCase of createBenchmarkCorpus()) {
      let ownerKey: string | undefined;
      for (const strategy of strategies) {
        const session = await freshBenchPage(browser, url);
        try {
          const item: any = await session.page.evaluate(
            ({ caseName, strategyName }) =>
              (window as any).__bipBench.runFitCaseTwice(caseName, strategyName),
            { caseName: corpusCase.name, strategyName: strategy },
          );
          result.fit.push(item);
          const coldKey = `${item.cold.quality}|${item.cold.size}|${item.cold.hit}`;
          const warmKey = `${item.warm.quality}|${item.warm.size}|${item.warm.hit}`;
          if (strategy === 'owner-loop') ownerKey = coldKey;
          const same =
            coldKey === warmKey &&
            item.cold.attempts === item.warm.attempts &&
            (ownerKey === undefined || coldKey === ownerKey);
          const peak = Math.max(
            item.cold.peakUsedJsHeapBytes ?? 0,
            item.warm.peakUsedJsHeapBytes ?? 0,
          );
          console.log(
            `| ${item.case} | ${strategy} | ${item.cold.attempts} | ${item.cold.quality ?? '—'} | ` +
              `${item.cold.size ?? 'null'} | ${item.cold.milliseconds.toFixed(1)} ms | ${item.warm.milliseconds.toFixed(1)} ms | ` +
              `${peak ? `${(peak / 1024 / 1024).toFixed(1)} MiB` : 'n/a'} | ${same ? 'да' : 'НЕТ'} |`,
          );
          if (!same) throw new Error(`${name}/${item.case}/${strategy}: mismatch with owner-loop or warm run`);
        } finally {
          await session.close();
        }
      }
    }
  } finally {
    await browser.close();
  }

  const outputDir = join(root, 'benchmark-results');
  await mkdir(outputDir, { recursive: true });
  const outputPath = join(outputDir, `browser-${name}.json`);
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`\nJSON: ${outputPath}`);
}

const { server, url } = await startStaticServer();
try {
  for (const name of browserNames) await runBrowser(name, url);
} finally {
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
}
