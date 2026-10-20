// Браузерная benchmark-страница для Playwright-раннера.
//
// Страница при загрузке тянет только ядро библиотеки. Каждый вызов
// profileFormat/runFitCase впервые обращается к кодеку, поэтому в свежем
// BrowserContext первый запуск честно включает загрузку ленивого JS/wasm,
// его инициализацию и первый encode/fit. Второй запуск в той же странице —
// тёплый. Корпус общий с Node: scripts/benchmark-frames.ts.

import { cloneFrame, image, optimizePngBlob } from '../src/index.js';
import type { FitStrategyName, Frame, PngOptimizerEngine } from '../src/index.js';
import { createBenchmarkCorpus, createQuantizerCorpus } from '../scripts/benchmark-frames.js';
import { anyBlob } from '../test/helpers.js';

interface MeasuredResult<T> {
  value: T;
  milliseconds: number;
  peakUsedJsHeapBytes: number | null;
}

interface FitRun {
  hit: boolean;
  attempts: number;
  quality?: number;
  format?: string;
  params?: unknown;
  size?: number;
  milliseconds: number;
  peakUsedJsHeapBytes: number | null;
}

interface BrowserBenchApi {
  ready: true;
  capabilities: () => Record<string, unknown>;
  profileFormat: (format: string) => Promise<Record<string, unknown>>;
  profilePngOptimizer: (engine: PngOptimizerEngine) => Promise<Record<string, unknown>>;
  runFitCaseTwice: (caseName: string, strategy: FitStrategyName) => Promise<{
    case: string;
    strategy: FitStrategyName;
    cold: FitRun;
    warm: FitRun;
  }>;
}

declare global {
  interface Window {
    __bipBench?: BrowserBenchApi;
  }
}

function usedJsHeapBytes(): number | null {
  const memory = (performance as Performance & {
    memory?: { usedJSHeapSize?: number };
  }).memory;
  return typeof memory?.usedJSHeapSize === 'number' ? memory.usedJSHeapSize : null;
}

async function measured<T>(run: () => Promise<T>): Promise<MeasureResult<T>> {
  let peak = usedJsHeapBytes();
  const timer = window.setInterval(() => {
    const current = usedJsHeapBytes();
    if (current !== null) peak = peak === null ? current : Math.max(peak, current);
  }, 2);
  const started = performance.now();
  try {
    const value = await run();
    return { value, milliseconds: performance.now() - started, peakUsedJsHeapBytes: peak };
  } finally {
    window.clearInterval(timer);
  }
}

function decoderForClone(frame: Frame): () => Promise<Frame> {
  return async () => cloneFrame(frame);
}

async function encodeOnce(frame: Frame, format: string): Promise<number> {
  const options =
    format === 'image/jpeg'
      ? { quality: 0.85 }
      : format === 'image/webp'
        ? { quality: 0.8 }
        : format === 'image/avif'
          ? { quality: 0.6 }
          : {};
  const blob = await image(anyBlob(), (p) => p.encode(format, options), {
    decoder: decoderForClone(frame),
  });
  return blob.size;
}

async function profileFormat(format: string): Promise<Record<string, unknown>> {
  const frame = createQuantizerCorpus()[0].frame;
  const first = await measured(() => encodeOnce(frame, format));
  const warm: MeasureResult<number>[] = [];
  for (let i = 0; i < 3; i++) warm.push(await measured(() => encodeOnce(frame, format)));
  return {
    format,
    firstEncodeMs: first.milliseconds,
    firstSize: first.value,
    firstPeakUsedJsHeapBytes: first.peakUsedJsHeapBytes,
    warmEncodeMs: warm.map((item) => item.milliseconds),
    warmSizes: warm.map((item) => item.value),
    warmPeakUsedJsHeapBytes: warm.reduce<number | null>((peak, item) => {
      if (item.peakUsedJsHeapBytes === null) return peak;
      return peak === null ? item.peakUsedJsHeapBytes : Math.max(peak, item.peakUsedJsHeapBytes);
    }, null),
  };
}

async function profilePngOptimizer(
  engine: PngOptimizerEngine,
): Promise<Record<string, unknown>> {
  const frame = createQuantizerCorpus()[0].frame;
  const setup = await measured(async () =>
    image(anyBlob(), (p) => p.encode('image/png'), { decoder: decoderForClone(frame) }),
  );
  const input = setup.value;
  const run = async () => optimizePngBlob(input, { engine, level: engine === 'oxipng' ? 2 : undefined });
  const first = await measured(run);
  const warm: MeasureResult<Awaited<ReturnType<typeof run>>>[] = [];
  for (let i = 0; i < 3; i++) warm.push(await measured(run));
  return {
    engine,
    setupPngEncodeMs: setup.milliseconds,
    inputSize: input.size,
    firstOptimizeMs: first.milliseconds,
    firstSize: first.value.size,
    firstOptimized: first.value.optimized,
    firstPeakUsedJsHeapBytes: first.peakUsedJsHeapBytes,
    warmOptimizeMs: warm.map((item) => item.milliseconds),
    warmSizes: warm.map((item) => item.value.size),
    warmOptimized: warm.map((item) => item.value.optimized),
  };
}

async function runFitCase(caseName: string, strategy: FitStrategyName): Promise<FitRun> {
  const corpusCase = createBenchmarkCorpus().find((item) => item.name === caseName);
  if (!corpusCase) throw new Error(`unknown corpus case ${caseName}`);
  let attempts = 0;
  const result = await measured(() =>
    image(
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
        decoder: decoderForClone(corpusCase.frame),
        state: (event) => {
          if (event.type === 'encode-done') attempts += 1;
        },
      },
    ),
  );
  const hit = result.value;
  return {
    hit: hit !== null,
    attempts: hit?.attempts ?? attempts,
    quality: hit?.params.quality,
    format: hit?.params.format,
    params: hit?.params,
    size: hit?.blob.size,
    milliseconds: result.milliseconds,
    peakUsedJsHeapBytes: result.peakUsedJsHeapBytes,
  };
}

window.__bipBench = {
  ready: true,
  capabilities: () => ({
    userAgent: navigator.userAgent,
    crossOriginIsolated,
    createImageBitmap: typeof createImageBitmap,
    OffscreenCanvas: typeof OffscreenCanvas,
    CompressionStream: typeof CompressionStream,
    DecompressionStream: typeof DecompressionStream,
    performanceMemory: usedJsHeapBytes() !== null,
  }),
  profileFormat,
  profilePngOptimizer,
  runFitCaseTwice: async (caseName, strategy) => ({
    case: caseName,
    strategy,
    cold: await runFitCase(caseName, strategy),
    warm: await runFitCase(caseName, strategy),
  }),
};

const status = document.querySelector('#status');
if (status) status.textContent = 'benchmark ready';
