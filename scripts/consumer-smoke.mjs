// Consumer-smoke: пакет глазами потребителя, а не из исходников репозитория.
//
// 1) npm pack текущего пакета;
// 2) установка tarball в чистый временный проект;
// 3) ESM и CJS импорты основного входа и subpath state/testing;
// 4) TypeScript-проверка .d.ts потребительским файлом;
// 5) Vite-сборка маленького браузерного потребителя и проверка, что
//    динамические wasm-ассеты разрешились без ручного копирования.
//
// Временный проект и tarball удаляются. KEEP_CONSUMER_SMOKE=1 оставляет
// каталог для ручной диагностики.

import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const keep = process.env.KEEP_CONSUMER_SMOKE === '1';
let tarballPath;
let consumerDir;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    stdio: options.capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
    env: { ...process.env, ...options.env },
  });
  if (result.status !== 0) {
    if (options.capture) {
      process.stderr.write(result.stdout ?? '');
      process.stderr.write(result.stderr ?? '');
    }
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
  return result.stdout ?? '';
}

async function findFiles(dir, predicate, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await findFiles(path, predicate, out);
    else if (predicate(path)) out.push(path);
  }
  return out;
}

try {
  const packed = JSON.parse(run('npm', ['pack', '--json'], { capture: true }));
  tarballPath = join(root, packed[0].filename);
  consumerDir = await mkdtemp(join(tmpdir(), 'bip-consumer-'));

  await writeFile(
    join(consumerDir, 'package.json'),
    JSON.stringify(
      {
        name: 'bip-consumer-smoke',
        private: true,
        version: '0.0.0',
        type: 'module',
      },
      null,
      2,
    ),
  );
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarballPath], {
    cwd: consumerDir,
  });

  run(
    'node',
    [
      '--input-type=module',
      '-e',
      `
        import { createEncoderRegistry, registeredFormats } from 'browser-image-pipeline';
        import { createStateCollector } from 'browser-image-pipeline/state';
        import { evaluateQualityStrategy } from 'browser-image-pipeline/testing';
        const formats = registeredFormats();
        for (const f of ['image/jpeg','image/png','image/webp','image/avif']) {
          if (!formats.includes(f)) throw new Error('missing built-in ' + f);
        }
        if (createEncoderRegistry().formats().length !== 0) throw new Error('isolated registry is not empty');
        if (!createStateCollector || !evaluateQualityStrategy) throw new Error('subpath export missing');
        console.log('ESM consumer ok:', formats.join(', '));
      `,
    ],
    { cwd: consumerDir },
  );

  run(
    'node',
    [
      '-e',
      `
        const lib = require('browser-image-pipeline');
        const state = require('browser-image-pipeline/state');
        const testing = require('browser-image-pipeline/testing');
        if (!lib.image || !state.createStateCollector || !testing.ownerLoop) throw new Error('CJS export missing');
        console.log('CJS consumer ok:', lib.registeredFormats().join(', '));
      `,
    ],
    { cwd: consumerDir },
  );

  await writeFile(
    join(consumerDir, 'consumer.ts'),
    `
      import { createEncoderRegistry, image, type FitQualityStrategy } from 'browser-image-pipeline';
      import { createStateCollector } from 'browser-image-pipeline/state';
      import { assertQualityStrategyMatchesOwnerLoop } from 'browser-image-pipeline/testing';

      const registry = createEncoderRegistry();
      const collector = createStateCollector();
      const strategy: FitQualityStrategy = async (probe, grid) => {
        const quality = grid[grid.length - 1];
        const outcome = await probe(quality);
        return outcome.fits ? { quality, blob: outcome.blob } : null;
      };
      void image;
      void registry;
      void collector;
      void strategy;
      void assertQualityStrategyMatchesOwnerLoop;
    `,
  );
  await mkdir(join(consumerDir, 'empty-types'));
  run(
    join(root, 'node_modules/.bin/tsc'),
    [
      '--strict',
      '--noEmit',
      '--skipLibCheck',
      'false',
      '--target',
      'ES2022',
      '--module',
      'ESNext',
      '--moduleResolution',
      'Bundler',
      '--lib',
      'ES2022,DOM',
      '--typeRoots',
      './empty-types',
      'consumer.ts',
    ],
    { cwd: consumerDir },
  );
  console.log('DTS consumer ok');

  await writeFile(
    join(consumerDir, 'index.html'),
    '<!doctype html><html><body><div id="result">pending</div><script type="module" src="/main.ts"></script></body></html>',
  );
  await writeFile(
    join(consumerDir, 'main.ts'),
    `
      import { image } from 'browser-image-pipeline';

      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 64;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no 2d context');
      const gradient = ctx.createLinearGradient(0, 0, 64, 64);
      gradient.addColorStop(0, '#2456a6');
      gradient.addColorStop(1, '#f2a541');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 64, 64);
      const source = await new Promise<Blob>((resolveBlob, reject) => {
        canvas.toBlob((blob) => blob ? resolveBlob(blob) : reject(new Error('canvas blob failed')), 'image/png');
      });
      const result = await image(source, async (p) => {
        await p.frame({ width: 32, height: 32, method: 'lanczos3' });
        return p.encode('image/jpeg', { quality: 0.82 });
      });
      document.querySelector('#result')!.textContent = 'ok ' + result.size;
    `,
  );
  await writeFile(
    join(consumerDir, 'vite.config.ts'),
    `
      export default {
        logLevel: 'warn',
        worker: { format: 'es' },
        build: { outDir: 'dist', target: 'es2022' },
      };
    `,
  );
  run(join(root, 'node_modules/.bin/vite'), ['build'], { cwd: consumerDir });
  const dist = join(consumerDir, 'dist');
  const wasm = await findFiles(dist, (path) => path.endsWith('.wasm'));
  if (wasm.length === 0) throw new Error('Vite consumer build produced no wasm assets');
  const js = await findFiles(dist, (path) => path.endsWith('.js'));
  if (js.length === 0) throw new Error('Vite consumer build produced no JS assets');
  console.log(`Vite consumer ok: ${js.length} JS assets, ${wasm.length} wasm assets`);
  console.log('CONSUMER SMOKE PASSED');
} finally {
  if (!keep) {
    if (consumerDir) await rm(consumerDir, { recursive: true, force: true });
    if (tarballPath) await rm(tarballPath, { force: true });
  } else {
    console.log('KEEP_CONSUMER_SMOKE=1:', consumerDir, tarballPath);
  }
}
