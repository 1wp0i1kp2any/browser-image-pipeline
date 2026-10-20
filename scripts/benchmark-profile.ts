// Cold/warm и peak-memory профиль Node/wasm.
//
// Почему дочерние процессы: в одном процессе первый кодек навсегда делает
// все следующие измерения «тёплыми», а maxrss становится общим максимумом
// всей истории. Поэтому родитель запускает отдельного ребёнка на каждый
// формат и на каждую пару «корпусный кейс × стратегия».
//
// Node-шов честно разделён на этапы: @jsquash в Node нельзя оставить
// самому загружать wasm через fetch(file://), поэтому скрипт отдельно
// измеряет import+init выбранного wasm, первый fit/encode после init и
// повторный тёплый запуск. Cold total = init + первый запуск.
//
// Результаты пишутся машиночитаемо в benchmark-results/node-profile.json.

import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createBenchmarkCorpus, createQuantizerCorpus } from './benchmark-frames.js';
import { anyBlob, decoderFor, makeFakeCodec, photoFrame } from '../test/helpers.js';
import type { FitStrategyName } from '../src/index.js';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const scriptPath = fileURLToPath(import.meta.url);
const root = resolve(dirname(scriptPath), '..');
const tsxPath = join(root, 'node_modules', '.bin', 'tsx');
const args = process.argv.slice(2);
const argValue = (name: string): string | undefined =>
  args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);

interface MemorySnapshot {
  rss: number;
  heapUsed: number;
  arrayBuffers: number;
  external: number;
  maxRssKiB: number;
}

function memorySnapshot(): MemorySnapshot {
  const memory = process.memoryUsage();
  const rawMaxRss = process.resourceUsage().maxrss;
  return {
    rss: memory.rss,
    heapUsed: memory.heapUsed,
    arrayBuffers: memory.arrayBuffers,
    external: memory.external,
    // Linux отдаёт maxrss в KiB, macOS — в байтах.
    maxRssKiB: process.platform === 'darwin' ? rawMaxRss / 1024 : rawMaxRss,
  };
}

async function measured<T>(run: () => Promise<T>): Promise<{
  value: T;
  milliseconds: number;
  peakRssBytes: number;
  peakHeapUsedBytes: number;
  after: MemorySnapshot;
}> {
  let peakRssBytes = process.memoryUsage().rss;
  let peakHeapUsedBytes = process.memoryUsage().heapUsed;
  const timer = setInterval(() => {
    const memory = process.memoryUsage();
    peakRssBytes = Math.max(peakRssBytes, memory.rss);
    peakHeapUsedBytes = Math.max(peakHeapUsedBytes, memory.heapUsed);
  }, 2);
  timer.unref();
  const started = performance.now();
  try {
    const value = await run();
    return {
      value,
      milliseconds: performance.now() - started,
      peakRssBytes,
      peakHeapUsedBytes,
      after: memorySnapshot(),
    };
  } finally {
    clearInterval(timer);
  }
}

async function wasmArrayBuffer(specifier: string): Promise<ArrayBuffer> {
  const bytes = await readFile(require.resolve(specifier));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function wasmBytes(specifier: string): Promise<Uint8Array> {
  return readFile(require.resolve(specifier));
}

/** Инициализировать в Node только encoder нужного формата. */
async function initEncoder(format: string): Promise<void> {
  switch (format) {
    case 'image/jpeg': {
      const mod = await import('@jsquash/jpeg/encode');
      await mod.init({
        wasmBinary: await wasmArrayBuffer('@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm'),
      });
      return;
    }
    case 'image/png': {
      const mod = await import('@jsquash/png/encode');
      await mod.init(await wasmBytes('@jsquash/png/codec/pkg/squoosh_png_bg.wasm'));
      return;
    }
    case 'image/webp': {
      const mod = await import('@jsquash/webp/encode');
      await mod.init({
        wasmBinary: await wasmArrayBuffer('@jsquash/webp/codec/enc/webp_enc_simd.wasm'),
      });
      return;
    }
    case 'image/avif': {
      const mod = await import('@jsquash/avif/encode');
      await mod.init({
        wasmBinary: await wasmArrayBuffer('@jsquash/avif/codec/enc/avif_enc.wasm'),
      });
      return;
    }
    default:
      throw new Error(`unsupported profile format ${format}`);
  }
}

async function runFormatChild(format: string): Promise<void> {
  const baseline = memorySnapshot();
  const init = await measured(() => initEncoder(format));
  const coreStarted = performance.now();
  const { image } = await import('../src/index.js');
  const coreImportMs = performance.now() - coreStarted;
  const frame = createQuantizerCorpus()[0].frame;
  const options =
    format === 'image/jpeg'
      ? { quality: 0.85 }
      : format === 'image/webp'
        ? { quality: 0.8 }
        : format === 'image/avif'
          ? { quality: 0.6 }
          : {};
  const encodeOnce = async (): Promise<number> => {
    const blob = await image(anyBlob(), (p) => p.encode(format, options), {
      decoder: decoderFor(frame),
    });
    return blob.size;
  };

  const first = await measured(encodeOnce);
  const warm = [] as Awaited<ReturnType<typeof measured<number>>>[];
  for (let i = 0; i < 3; i++) warm.push(await measured(encodeOnce));

  console.log(
    `PROFILE_JSON ${JSON.stringify({
      kind: 'format',
      format,
      baseline,
      wasmImportInitMs: init.milliseconds,
      wasmPeakRssBytes: init.peakRssBytes,
      afterWasmInit: init.after,
      coreImportMs,
      firstEncodeMs: first.milliseconds,
      coldTotalMs: init.milliseconds + coreImportMs + first.milliseconds,
      firstSize: first.value,
      firstPeakRssBytes: first.peakRssBytes,
      firstPeakHeapUsedBytes: first.peakHeapUsedBytes,
      warmEncodeMs: warm.map((item) => item.milliseconds),
      warmSizes: warm.map((item) => item.value),
      warmPeakRssBytes: Math.max(...warm.map((item) => item.peakRssBytes)),
      finalMemory: memorySnapshot(),
    })}`,
  );
}

async function runFitChild(caseName: string, strategy: FitStrategyName): Promise<void> {
  const corpusCase = createBenchmarkCorpus().find((item) => item.name === caseName);
  if (!corpusCase) throw new Error(`unknown corpus case ${caseName}`);
  const baseline = memorySnapshot();
  const init = await measured(() => initEncoder(corpusCase.format));
  const coreStarted = performance.now();
  const { image } = await import('../src/index.js');
  const coreImportMs = performance.now() - coreStarted;

  const runOnce = async () => {
    let attempts = 0;
    const hit = await image(
      anyBlob(),
      (p) =>
        p.fit(
          {
            formats: [corpusCase.format],
            quality: [0.5, 0.99],
            frame: { width: 220, height: 220, method: 'lanczos3' },
            ...(corpusCase.format === 'image/webp' ? { variants: [{ effort: 0.15 }] } : {}),
          },
          (candidate) => candidate.size <= corpusCase.limit,
          { strategy },
        ),
      {
        decoder: decoderFor(corpusCase.frame),
        state: (event) => {
          if (event.type === 'encode-done') attempts += 1;
        },
      },
    );
    return {
      hit: hit !== null,
      attempts: hit?.attempts ?? attempts,
      quality: hit?.params.quality,
      format: hit?.params.format,
      size: hit?.blob.size,
      params: hit?.params,
    };
  };

  const first = await measured(runOnce);
  const warm = await measured(runOnce);
  console.log(
    `PROFILE_JSON ${JSON.stringify({
      kind: 'fit',
      case: corpusCase.name,
      format: corpusCase.format,
      strategy,
      baseline,
      wasmImportInitMs: init.milliseconds,
      coreImportMs,
      cold: {
        ...first.value,
        milliseconds: first.milliseconds,
        totalWithInitMs: init.milliseconds + coreImportMs + first.milliseconds,
        peakRssBytes: first.peakRssBytes,
        peakHeapUsedBytes: first.peakHeapUsedBytes,
        after: first.after,
      },
      warm: {
        ...warm.value,
        milliseconds: warm.milliseconds,
        peakRssBytes: warm.peakRssBytes,
        peakHeapUsedBytes: warm.peakHeapUsedBytes,
        after: warm.after,
      },
      finalMemory: memorySnapshot(),
    })}`,
  );
}

async function runPaletteCacheChild(): Promise<void> {
  const baseline = memorySnapshot();
  const { createEncoderRegistry, image } = await import('../src/index.js');
  const registry = createEncoderRegistry();
  const fake = makeFakeCodec({ baseAtQ80: 1000 }, 'image/palette-cache');
  registry.register('image/palette-a', fake);
  registry.register('image/palette-b', fake);
  const frame = photoFrame(384, 384);
  const quantizedLevels: number[] = [];
  let attempts = 0;

  const run = await measured(async () =>
    image(
      anyBlob(),
      (p) =>
        p.fit(
          {
            formats: ['image/palette-a', 'image/palette-b'],
            quality: [0.8, 0.8],
            colors: [16, 128],
          },
          () => false,
        ),
      {
        decoder: decoderFor(frame),
        registry,
        state: (event) => {
          if (event.type === 'quantize') quantizedLevels.push(event.colors);
          if (event.type === 'encode-done') attempts += 1;
        },
      },
    ),
  );

  console.log(
    `PROFILE_JSON ${JSON.stringify({
      kind: 'palette-cache',
      baseline,
      frame: { width: frame.width, height: frame.height, bytes: frame.data.byteLength },
      maxCachedQuantizedFrames: 2,
      maxCachedQuantizedBytes: frame.data.byteLength * 2,
      quantizedLevels,
      attempts,
      result: run.value,
      milliseconds: run.milliseconds,
      peakRssBytes: run.peakRssBytes,
      peakHeapUsedBytes: run.peakHeapUsedBytes,
      after: run.after,
      finalMemory: memorySnapshot(),
    })}`,
  );
}

async function runChild(childArgs: string[]): Promise<unknown> {
  const { stdout, stderr } = await execFileAsync(tsxPath, [scriptPath, ...childArgs], {
    cwd: root,
    maxBuffer: 20 * 1024 * 1024,
    timeout: 300_000,
  });
  const line = stdout.split(/\r?\n/).find((item) => item.startsWith('PROFILE_JSON '));
  if (!line) {
    throw new Error(`child ${childArgs.join(' ')} produced no PROFILE_JSON\n${stdout}\n${stderr}`);
  }
  return JSON.parse(line.slice('PROFILE_JSON '.length));
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

async function runParent(): Promise<void> {
  const formatsOnly = args.includes('--formats-only');
  const fitOnly = args.includes('--fit-only');
  const onlyCase = argValue('--case');
  const onlyStrategy = argValue('--strategy') as FitStrategyName | undefined;
  const formats = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'];
  const strategies: FitStrategyName[] = ['owner-loop', 'binary', 'secant', 'coarse-fine'];
  const result = {
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    formats: [] as any[],
    paletteCache: null as any,
    fit: [] as any[],
  };

  if (!fitOnly) {
    console.log('## Node/wasm: cold/warm по форматам\n');
    console.log('| Формат | wasm init | первый encode | cold total | warm median | размер | peak RSS |');
    console.log('|---|---:|---:|---:|---:|---:|---:|');
    for (const format of formats) {
      const item: any = await runChild([`--child-format=${format}`]);
      result.formats.push(item);
      console.log(
        `| ${format} | ${item.wasmImportInitMs.toFixed(1)} ms | ${item.firstEncodeMs.toFixed(1)} ms | ` +
          `${item.coldTotalMs.toFixed(1)} ms | ${median(item.warmEncodeMs).toFixed(1)} ms | ${item.firstSize} B | ` +
          `${(Math.max(item.firstPeakRssBytes, item.warmPeakRssBytes) / 1024 / 1024).toFixed(1)} MiB |`,
      );
      if (!item.warmSizes.every((size: number) => size === item.firstSize)) {
        throw new Error(`${format}: warm encode size differs from cold encode`);
      }
    }
  }

  if (!formatsOnly && !onlyCase && !onlyStrategy) {
    const item: any = await runChild(['--child-palette-cache']);
    result.paletteCache = item;
    const expectedLevels = [128, 64, 32, 16, 128, 64, 32, 16];
    if (JSON.stringify(item.quantizedLevels) !== JSON.stringify(expectedLevels)) {
      throw new Error(`palette cache eviction sequence differs: ${item.quantizedLevels.join(',')}`);
    }
    console.log('\n## Node: профиль кэша квантованных кадров\n');
    console.log(
      `384×384, уровни ${item.quantizedLevels.join(' → ')}; лимит кэша ` +
        `${item.maxCachedQuantizedFrames} кадра (${(item.maxCachedQuantizedBytes / 1024 / 1024).toFixed(2)} MiB), ` +
        `peak RSS ${(item.peakRssBytes / 1024 / 1024).toFixed(1)} MiB, ${item.milliseconds.toFixed(1)} ms.`,
    );
  }

  if (!formatsOnly) {
    const cases = createBenchmarkCorpus().filter((item) => !onlyCase || item.name === onlyCase);
    const selectedStrategies = strategies.filter(
      (strategy) => !onlyStrategy || strategy === onlyStrategy,
    );
    console.log('\n## Node/wasm corpus: стратегии, cold/warm, peak RSS\n');
    console.log('| Кейс | Стратегия | attempts | q | размер | cold total | warm | peak RSS | совпадение |');
    console.log('|---|---|---:|---:|---:|---:|---:|---:|---|');
    for (const corpusCase of cases) {
      let ownerKey: string | undefined;
      for (const strategy of selectedStrategies) {
        const item: any = await runChild([
          '--child-fit',
          `--case=${corpusCase.name}`,
          `--strategy=${strategy}`,
        ]);
        result.fit.push(item);
        const coldKey = `${item.cold.quality}|${item.cold.size}|${item.cold.hit}`;
        const warmKey = `${item.warm.quality}|${item.warm.size}|${item.warm.hit}`;
        if (strategy === 'owner-loop') ownerKey = coldKey;
        const same = coldKey === warmKey && (ownerKey === undefined || coldKey === ownerKey);
        console.log(
          `| ${item.case} | ${strategy} | ${item.cold.attempts} | ${item.cold.quality ?? '—'} | ` +
            `${item.cold.size ?? 'null'} | ${item.cold.totalWithInitMs.toFixed(1)} ms | ` +
            `${item.warm.milliseconds.toFixed(1)} ms | ` +
            `${(Math.max(item.cold.peakRssBytes, item.warm.peakRssBytes) / 1024 / 1024).toFixed(1)} MiB | ${same ? 'да' : 'НЕТ'} |`,
        );
        if (!same) throw new Error(`${item.case}/${strategy}: result differs from owner-loop or warm run`);
        if (item.cold.attempts !== item.warm.attempts) {
          throw new Error(`${item.case}/${strategy}: cold/warm attempts differ`);
        }
      }
    }
  }

  const outputDir = join(root, 'benchmark-results');
  await mkdir(outputDir, { recursive: true });
  const outputPath = join(outputDir, 'node-profile.json');
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`\nJSON: ${outputPath}`);
}

const childFormat = argValue('--child-format');
if (childFormat) {
  await runFormatChild(childFormat);
} else if (args.includes('--child-palette-cache')) {
  await runPaletteCacheChild();
} else if (args.includes('--child-fit')) {
  await runFitChild(argValue('--case') ?? '', (argValue('--strategy') ?? 'owner-loop') as FitStrategyName);
} else {
  await runParent();
}
