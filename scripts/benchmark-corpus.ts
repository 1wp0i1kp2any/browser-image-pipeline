// Воспроизводимый benchmark-корпус фазы 4 и оценка прототипа SizeModel.
//
// Корпус полностью детерминирован и генерируется кодом: фото-подобный
// градиент с деталями, шум, плавный градиент, манга/документ, UI/скриншот,
// alpha, муар, панорама и высокий документ. Никаких внешних fixtures и
// лицензионной неопределённости.
//
// Прототип model-guided стратегии живёт только в этом скрипте. Он вправе
// выбирать лишь следующую точку внутри текущей вилки и при плохом
// предсказании падает в середину; результат обязан совпасть с owner-loop.
// В библиотеку прототип попадёт только если пройдёт критерий PLAN:
// 0 расхождений, медианный выигрыш >=15% attempts против secant и нет
// регрессии p95 attempts хуже 5%.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import '../test/setup-wasm.js';
import { compareFrames, getEncoder, image, registerEncoder, unregisterEncoder } from '../src/index.js';
import { quantizeFrame } from '../src/quantize.js';
import type { FitQualityStrategy, FitStrategyName, Frame } from '../src/index.js';
import { evaluateQualityStrategy } from '../src/testing.js';
import {
  anyBlob,
  decoderFor,
  makeFakeCodec,
  photoFrame,
  type FakeCodec,
} from '../test/helpers.js';
import { createBenchmarkCorpus, createQuantizerCorpus } from './benchmark-frames.js';

const root = resolve(dirname(new URL(import.meta.url).pathname), '..');

interface Observation {
  q: number;
  size: number;
  fits: boolean;
}

const modelGuidedPrototype: FitQualityStrategy = async (probe, grid) => {
  const observations: Observation[] = [];
  const seen = new Map<number, Observation>();
  const run = async (idx: number): Promise<Observation> => {
    const q = grid[idx];
    const old = seen.get(q);
    if (old) return old;
    const out = await probe(q);
    const observation = { q, size: out.size, fits: out.fits };
    seen.set(q, observation);
    observations.push(observation);
    return observation;
  };

  const hiIdx0 = grid.length - 1;
  const hi0 = await run(hiIdx0);
  if (hi0.fits) return { quality: grid[hiIdx0], blob: (await probe(grid[hiIdx0])).blob };
  if (hiIdx0 === 0) return null;
  const lo0 = await run(0);
  if (!lo0.fits) return null;

  let loIdx = 0;
  let hiIdx = hiIdx0;
  let lo = lo0;
  let hi = hi0;

  const predictIndex = (): number => {
    const fallback = (loIdx + hiIdx) >> 1;
    const targetSize = Math.sqrt(Math.max(1, lo.size) * Math.max(1, hi.size));
    const xs = observations.map((o) => -Math.log(Math.max(0.005, 1.02 - o.q)));
    const ys = observations.map((o) => Math.log(Math.max(1, o.size)));
    const n = xs.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
      num += (xs[i] - mx) * (ys[i] - my);
      den += (xs[i] - mx) * (xs[i] - mx);
    }
    if (den <= 1e-12) return fallback;
    const slope = num / den;
    if (!(slope > 0)) return fallback;
    const intercept = my - slope * mx;
    const xTarget = (Math.log(targetSize) - intercept) / slope;
    const qTarget = 1.02 - Math.exp(-xTarget);
    let best = fallback;
    let bestDistance = Infinity;
    for (let i = loIdx + 1; i < hiIdx; i++) {
      const distance = Math.abs(grid[i] - qTarget);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    }
    return best;
  };

  while (hiIdx - loIdx > 1) {
    const idx = predictIndex();
    const out = await run(idx);
    if (out.fits) {
      loIdx = idx;
      lo = out;
    } else {
      hiIdx = idx;
      hi = out;
    }
  }
  const final = await probe(grid[loIdx]);
  return { quality: grid[loIdx], blob: final.blob };
};

function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

function median(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

interface CaseResult {
  name: string;
  ownerAttempts: number;
  secantAttempts: number;
  modelAttempts: number;
  same: boolean;
  milliseconds: number;
  ownerQuality?: number;
  ownerSize?: number;
}

const results: CaseResult[] = [];

interface QuantizerCaseResult {
  frame: string;
  algorithm: string;
  milliseconds: number;
  mae: number;
  blockSsim: number;
  pngSize: number;
  jpegSize: number;
}

const quantizerResults: QuantizerCaseResult[] = [];

async function syntheticCases(): Promise<void> {
  const grid = Array.from({ length: 50 }, (_, i) => (50 + i) / 100);
  const curves: { name: string; sizeAt: (q: number) => number; maxSize: number }[] = [
    {
      name: 'synthetic jpeg-like 1/(1.02-q)',
      sizeAt: (q) => Math.round(2200 / (1.02 - q)),
      maxSize: 20_000,
    },
    {
      name: 'synthetic exponential',
      sizeAt: (q) => Math.round(1200 * Math.exp(3.1 * q)),
      maxSize: 12_000,
    },
    {
      name: 'synthetic power',
      sizeAt: (q) => Math.round(900 + 38_000 * q ** 5),
      maxSize: 18_000,
    },
    {
      name: 'synthetic plateau',
      sizeAt: (q) => Math.round(5000 + Math.max(0, q - 0.72) * 95_000),
      maxSize: 16_000,
    },
    {
      name: 'synthetic knee',
      sizeAt: (q) => Math.round(q < 0.78 ? 4000 + q * 5000 : 7900 + (q - 0.78) * 120_000),
      maxSize: 17_000,
    },
  ];
  for (const curve of curves) {
    const started = performance.now();
    const owner = await evaluateQualityStrategy('owner-loop', { grid, ...curve });
    const secant = await evaluateQualityStrategy('secant', { grid, ...curve });
    const model = await evaluateQualityStrategy(modelGuidedPrototype, { grid, ...curve });
    results.push({
      name: curve.name,
      ownerAttempts: owner.attempts,
      secantAttempts: secant.attempts,
      modelAttempts: model.attempts,
      same:
        owner.hit?.quality === secant.hit?.quality &&
        owner.hit?.quality === model.hit?.quality &&
        owner.hit?.blob.size === model.hit?.blob.size,
      milliseconds: performance.now() - started,
      ownerQuality: owner.hit?.quality,
      ownerSize: owner.hit?.blob.size,
    });
  }
}

async function fitCase(
  name: string,
  frame: Frame,
  format: string,
  limit: number,
  fake?: FakeCodec,
): Promise<void> {
  const strategies: { name: string; strategy: FitStrategyName | FitQualityStrategy }[] = [
    { name: 'owner', strategy: 'owner-loop' },
    { name: 'secant', strategy: 'secant' },
    { name: 'model', strategy: modelGuidedPrototype },
  ];
  const byName = new Map<string, { attempts: number; quality?: number; size?: number }>();
  const started = performance.now();
  for (const item of strategies) {
    fake?.reset();
    let stateAttempts = 0;
    const hit = await image(
      anyBlob(),
      (p) =>
        p.fit(
          {
            formats: [format],
            quality: [0.5, 0.99],
            frame: { width: 220, height: 220, method: 'lanczos3' },
            ...(format === 'image/webp' ? { variants: [{ effort: 0.15 }] } : {}),
          },
          (c) => c.size <= limit,
          { strategy: item.strategy },
        ),
      {
        decoder: decoderFor(frame),
        state: (event) => {
          if (event.type === 'encode-done') stateAttempts += 1;
        },
      },
    );
    byName.set(item.name, {
      attempts: fake ? fake.encodes : stateAttempts,
      quality: hit?.params.quality,
      size: hit?.blob.size,
    });
  }
  const owner = byName.get('owner')!;
  const secant = byName.get('secant')!;
  const model = byName.get('model')!;
  results.push({
    name,
    ownerAttempts: owner.attempts,
    secantAttempts: secant.attempts,
    modelAttempts: model.attempts,
    same: owner.quality === secant.quality && owner.quality === model.quality && owner.size === model.size,
    milliseconds: performance.now() - started,
    ownerQuality: owner.quality,
    ownerSize: owner.size,
  });
}

await syntheticCases();

for (const item of createBenchmarkCorpus()) {
  await fitCase(item.name, item.frame, item.format, item.limit);
}

const fake = makeFakeCodec({ baseAtQ80: 20_000 }, 'image/corpus-fake');
registerEncoder('image/corpus-fake', fake);
try {
  await fitCase('fake photo palette-free', photoFrame(220, 220), 'image/corpus-fake', 28_000, fake);
} finally {
  unregisterEncoder('image/corpus-fake');
}

console.log('## Benchmark-корпус: attempts (Node/wasm, одна сетка и предикат)\n');
console.log('| Кейс | owner | secant | model-прототип | совпадение | время трёх прогонов |');
console.log('|---|---:|---:|---:|---|---:|');
for (const r of results) {
  console.log(
    `| ${r.name} | ${r.ownerAttempts} | ${r.secantAttempts} | ${r.modelAttempts} | ${r.same ? 'да' : 'НЕТ'} | ${r.milliseconds.toFixed(0)} ms |`,
  );
}


async function quantizerCases(): Promise<void> {
  const frames = createQuantizerCorpus();
  const png = getEncoder('image/png');
  const jpeg = getEncoder('image/jpeg');
  console.log('\n## Fast quantizer против image-q (палитра 64, без дизеринга)\n');
  console.log('| Кадр | алгоритм | время | MAE | блочный SSIM | PNG+oxipng2 | JPEG q0.80 |');
  console.log('|---|---|---:|---:|---:|---:|---:|');
  for (const { name, frame } of frames) {
    for (const algorithm of ['wuquant', 'fast-median-cut'] as const) {
      const started = performance.now();
      const quantized = await quantizeFrame(frame, 64, 0, { algorithm });
      const ms = performance.now() - started;
      const metrics = compareFrames(frame, quantized);
      const pngBlob = await png.encode(quantized, { oxipngLevel: 2 });
      const jpegBlob = await jpeg.encode(quantized, { quality: 0.8 });
      quantizerResults.push({
        frame: name,
        algorithm,
        milliseconds: ms,
        mae: metrics.mae,
        blockSsim: metrics.ssim,
        pngSize: pngBlob.size,
        jpegSize: jpegBlob.size,
      });
      console.log(
        `| ${name} | ${algorithm} | ${ms.toFixed(0)} ms | ${metrics.mae.toFixed(2)} | ${metrics.ssim.toFixed(4)} | ${pngBlob.size} B | ${jpegBlob.size} B |`,
      );
    }
  }
}

await quantizerCases();

const gains = results.map((r) => (r.secantAttempts - r.modelAttempts) / r.secantAttempts);
const ratios = results.map((r) => r.modelAttempts / r.secantAttempts);
const mismatches = results.filter((r) => !r.same).length;
const medianGain = median(gains);
const p95Ratio = percentile(ratios, 0.95);
const pass =
  mismatches === 0 && medianGain >= 0.15 && p95Ratio <= 1.05;

console.log('\n## Критерий SizeModel\n');
console.log(`- расхождений с owner-loop: ${mismatches}`);
console.log(`- медианный выигрыш attempts против secant: ${(medianGain * 100).toFixed(1)}%`);
console.log(`- p95 отношения attempts model/secant: ${p95Ratio.toFixed(3)}`);
console.log(`- RSS процесса к концу: ${(process.memoryUsage().rss / 1024 / 1024).toFixed(1)} MiB`);
console.log(
  pass
    ? '- ВЕРДИКТ: критерий выполнен, прототип можно рассматривать к включению.'
    : '- ВЕРДИКТ: критерий НЕ выполнен, SizeModel в библиотеку не включать.',
);

const outputDir = join(root, 'benchmark-results');
await mkdir(outputDir, { recursive: true });
const outputPath = join(outputDir, 'benchmark-corpus.json');
await writeFile(
  outputPath,
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      environment: { node: process.version, platform: process.platform, arch: process.arch },
      strategyCases: results,
      quantizerCases: quantizerResults,
      sizeModel: { mismatches, medianGain, p95Ratio, pass },
      finalRssBytes: process.memoryUsage().rss,
    },
    null,
    2,
  )}\n`,
);
console.log(`\nJSON: ${outputPath}`);
