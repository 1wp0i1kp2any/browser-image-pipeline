// Bundle-budget библиотеки в двух честных разрезах:
//
// 1) root-all-exports — статическое замыкание dist/index.js со всеми
//    синхронными утилитами корневого API (метрики, анализ, пресеты);
// 2) pipeline-core — минифицированный consumer-bundle, импортирующий
//    только основной `image()` из исходников через Vite/Rollup. Именно
//    этот production-разрез сравнивается с историческим порогом 11 KiB:
//    опциональные метрики/пресеты tree-shaken, если приложение их не берёт.
//
// В обоих разрезах динамические чанки кодеков и квантования в статическое
// замыкание попадать не должны.

import { readFile, readdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const BUDGETS = {
  core: 11 * 1024,
  root: 13 * 1024,
  state: 3 * 1024,
  testing: 6 * 1024,
  probe: 2 * 1024,
};
const FORBIDDEN_STATIC = [
  /jpeg-.*\.js$/,
  /png-.*\.js$/,
  /png-compression-stream-.*\.js$/,
  /webp-.*\.js$/,
  /avif-.*\.js$/,
  /quantize-.*\.js$/,
];

const files = new Map();
for (const name of await readdir(dist)) {
  if (name.endsWith('.js')) files.set(name, await readFile(join(dist, name)));
}

function staticImports(name) {
  const text = files.get(name).toString('utf8');
  const dynamic = new Set(
    [...text.matchAll(/import\s*\(\s*["'](\.\/[^"']+)["']\s*\)/g)].map((m) => m[1].slice(2)),
  );
  const found = new Set();
  const patterns = [
    /(?:import|export)\s+(?:[^'";]*?\s+from\s*)?["'](\.\/[^"']+)["']/g,
    /(?:import|export)[^'";]*?from\s*["'](\.\/[^"']+)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const file = match[1].slice(2);
      if (!dynamic.has(file)) found.add(file);
    }
  }
  return [...found];
}

function closure(entry) {
  if (!files.has(entry)) throw new Error(`dist/${entry} not found; run npm run build first`);
  const seen = [];
  const stack = [entry];
  while (stack.length > 0) {
    const name = stack.pop();
    if (seen.includes(name)) continue;
    seen.push(name);
    stack.push(...staticImports(name));
  }
  return seen;
}

function measure(entry) {
  const names = closure(entry);
  let raw = 0;
  let gzip = 0;
  let text = '';
  for (const name of names) {
    const bytes = files.get(name);
    raw += bytes.length;
    gzip += gzipSync(bytes).length;
    text += bytes.toString('utf8');
  }
  return { names, raw, gzip, text };
}

let failed = false;
for (const [label, entry, budget] of [
  ['root-all-exports', 'index.js', BUDGETS.root],
  ['state', 'state.js', BUDGETS.state],
  ['testing', 'testing.js', BUDGETS.testing],
  ['probe', 'probe.js', BUDGETS.probe],
]) {
  const result = measure(entry);
  const ok = result.gzip <= budget;
  if (!ok) failed = true;
  console.log(
    `${ok ? '✓' : '✗'} ${label}: ${(result.raw / 1024).toFixed(1)} KiB raw, ` +
      `${(result.gzip / 1024).toFixed(1)} KiB gzip (budget ${(budget / 1024).toFixed(1)} KiB), ` +
      `chunks: ${result.names.join(', ')}`,
  );
  if (label === 'root-all-exports') {
    const forbiddenFiles = result.names.filter((name) => FORBIDDEN_STATIC.some((re) => re.test(name)));
    if (forbiddenFiles.length > 0) {
      failed = true;
      console.error(`✗ root statically includes lazy chunks: ${forbiddenFiles.join(', ')}`);
    }
    const heavyImport = /(?:from\s*|import\s*\(\s*)["'](@jsquash\/[^"']+|image-q)["']/.exec(result.text);
    if (heavyImport) {
      failed = true;
      console.error(`✗ root static closure imports heavy dependency: ${heavyImport[1]}`);
    }
  }
}

const built = await build({
  configFile: false,
  root,
  logLevel: 'silent',
  build: {
    write: false,
    emptyOutDir: false,
    target: 'es2022',
    minify: 'esbuild',
    rollupOptions: {
      input: join(root, 'scripts', 'budget-core-entry.ts'),
      external: [/^@jsquash\//, 'image-q'],
    },
  },
  worker: { format: 'es' },
});
const outputs = (Array.isArray(built) ? built.flatMap((item) => item.output) : built.output).filter(
  (item) => item.type === 'chunk',
);
const chunksByFile = new Map(outputs.map((chunk) => [chunk.fileName, chunk]));
const entryChunk = outputs.find((chunk) => chunk.isEntry);
if (!entryChunk) throw new Error('Vite budget build produced no entry chunk');
const coreNames = [];
const stack = [entryChunk.fileName];
while (stack.length > 0) {
  const fileName = stack.pop();
  if (!fileName || coreNames.includes(fileName)) continue;
  const chunk = chunksByFile.get(fileName);
  if (!chunk) continue;
  coreNames.push(fileName);
  stack.push(...chunk.imports);
}
let coreRaw = 0;
let coreGzip = 0;
for (const fileName of coreNames) {
  const code = chunksByFile.get(fileName).code;
  coreRaw += Buffer.byteLength(code);
  coreGzip += gzipSync(code).length;
}
const coreOk = coreGzip <= BUDGETS.core;
if (!coreOk) failed = true;
console.log(
  `${coreOk ? '✓' : '✗'} pipeline-core (Vite consumer, image only): ${(coreRaw / 1024).toFixed(1)} KiB raw, ` +
    `${(coreGzip / 1024).toFixed(1)} KiB gzip (budget ${(BUDGETS.core / 1024).toFixed(1)} KiB), ` +
    `chunks: ${coreNames.join(', ')}`,
);
const coreDynamicNames = new Set(outputs.flatMap((chunk) => chunk.dynamicImports ?? []));
const staticallyIncludedDynamic = coreNames.filter((name) => coreDynamicNames.has(name));
if (staticallyIncludedDynamic.length > 0) {
  failed = true;
  console.error(`✗ pipeline-core statically includes dynamic chunks: ${staticallyIncludedDynamic.join(', ')}`);
}
const coreHeavyStaticImport = outputs
  .filter((chunk) => coreNames.includes(chunk.fileName))
  .flatMap((chunk) => chunk.imports)
  .find((specifier) => specifier.startsWith('@jsquash/') || specifier === 'image-q');
if (coreHeavyStaticImport) {
  failed = true;
  console.error(`✗ pipeline-core statically imports heavy dependency: ${coreHeavyStaticImport}`);
}

if (failed) process.exit(1);
console.log('BUNDLE BUDGET PASSED');
