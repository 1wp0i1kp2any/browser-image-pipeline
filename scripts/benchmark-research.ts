// Research-бенчмарк горячих чистых путей (геометрия, шарп, палитра, метрики).
//
// Зачем отдельный скрипт: исследовательские оптимизации принимаются только
// по замерам «до/после» на одном детерминированном корпусе и при побитово
// одинаковом результате. Поэтому каждый кейс пишет не только медианное
// время, но и FNV-1a хэш результата: сравнение JSON до/после обязано
// показать одинаковые хэши при меньшем времени.
//
// Запуск: tsx scripts/benchmark-research.ts <label>
// Результат: benchmark-results/research-<label>.json + таблица в stdout.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import type { Frame } from '../src/types.js';
import {
  analyzeFrame,
  cloneFrame,
  resizeArea,
  resizeBilinear,
  resizeLanczos3,
  sharpenFrame,
} from '../src/frame.js';
import { compareFrames, computeSSIM } from '../src/metrics.js';
import { applyPaletteWithDithering, buildFastPalette } from '../src/quantize.js';

/** Детерминированный LCG: корпус одинаков между прогонами и машинами. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Фото-подобный кадр: плавные пятна + шум + частичная альфа по краям. */
function photoFrame(width: number, height: number, seed = 42): Frame {
  const rnd = lcg(seed);
  const blobs = Array.from({ length: 24 }, () => ({
    x: rnd() * width,
    y: rnd() * height,
    r: 60 + rnd() * 220,
    cr: Math.floor(rnd() * 256),
    cg: Math.floor(rnd() * 256),
    cb: Math.floor(rnd() * 256),
  }));
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 30 + (x / width) * 60;
      let g = 40 + (y / height) * 50;
      let b = 90;
      for (const blob of blobs) {
        const dx = x - blob.x;
        const dy = y - blob.y;
        const d2 = dx * dx + dy * dy;
        const w = Math.exp(-d2 / (2 * blob.r * blob.r)) * 0.55;
        r += (blob.cr - r) * w;
        g += (blob.cg - g) * w;
        b += (blob.cb - b) * w;
      }
      const noise = (rnd() - 0.5) * 22;
      const i = (y * width + x) * 4;
      data[i] = r + noise;
      data[i + 1] = g + noise;
      data[i + 2] = b + noise;
      // Альфа: непрозрачный центр, полупрозрачные углы — premultiplied-пути заняты.
      const edge = Math.min(x, y, width - 1 - x, height - 1 - y);
      data[i + 3] = edge < 40 ? 90 + edge * 4 : 255;
    }
  }
  return { data, width, height };
}

/** FNV-1a по байтам кадра: дешёвая проверка побитовой идентичности. */
function hashBytes(data: Uint8ClampedArray): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    h ^= data[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

interface CaseResult {
  name: string;
  medianMs: number;
  runs: number[];
  hash: string;
}

/** Медиана по нескольким прогонам после прогрева; хэш — от последнего результата. */
function bench(name: string, runs: number, fn: () => string): CaseResult {
  let hash = '';
  for (let i = 0; i < 2; i++) hash = fn();
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    hash = fn();
    times.push(performance.now() - t0);
  }
  const sorted = [...times].sort((a, b) => a - b);
  return { name, medianMs: sorted[sorted.length >> 1], runs: times, hash };
}

const label = process.argv[2] ?? 'run';
const big = photoFrame(1600, 1200);
const mid = photoFrame(800, 600, 7);
const sharpened = sharpenFrame(cloneFrame(mid), 0.5, 2);
const palette128 = buildFastPalette(mid, 128);

const results: CaseResult[] = [
  bench('resizeBilinear 1600x1200->400x300', 7, () =>
    hashBytes(resizeBilinear(big, 400, 300).data)),
  bench('resizeLanczos3 1600x1200->400x300', 7, () =>
    hashBytes(resizeLanczos3(big, 400, 300).data)),
  bench('resizeArea 1600x1200->400x300', 7, () =>
    hashBytes(resizeArea(big, 400, 300).data)),
  bench('resizeLanczos3 800x600->1600x1200 (upscale)', 5, () =>
    hashBytes(resizeLanczos3(mid, 1600, 1200).data)),
  bench('sharpenFrame 800x600 r=2', 7, () =>
    hashBytes(sharpenFrame(mid, 0.5, 2).data)),
  bench('analyzeFrame 1600x1200 maxSamples=200000', 7, () => {
    const a = analyzeFrame(big, { maxSamples: 200_000 });
    return `${a.colorBuckets5Bit}:${a.sampledPixels}:${a.saturation.toFixed(6)}`;
  }),
  bench('buildFastPalette 800x600 colors=128', 5, () =>
    JSON.stringify(buildFastPalette(mid, 128))),
  bench('applyPalette dithering=0 800x600 pal=128', 5, () =>
    hashBytes(applyPaletteWithDithering(mid, palette128, 0).data)),
  bench('applyPalette dithering=1 800x600 pal=128', 5, () =>
    hashBytes(applyPaletteWithDithering(mid, palette128, 1).data)),
  bench('computeSSIM 800x600', 7, () => computeSSIM(mid, sharpened).toFixed(10)),
  bench('compareFrames 800x600', 7, () => {
    const m = compareFrames(mid, sharpened);
    return `${m.psnr.toFixed(6)}:${m.ssim.toFixed(10)}:${m.mae.toFixed(6)}`;
  }),
];

const outPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  `../benchmark-results/research-${label}.json`,
);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify({ label, results }, null, 2));

console.log(`\n## Research benchmark (${label})\n`);
console.log('| Кейс | медиана | хэш результата |');
console.log('|---|---:|---|');
for (const r of results) {
  console.log(`| ${r.name} | ${r.medianMs.toFixed(1)} ms | ${r.hash.slice(0, 24)} |`);
}
console.log(`\nJSON: ${outPath}`);
