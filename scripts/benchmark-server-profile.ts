// Замер автоматических профилей «клиент (3–5 с)» и «сервер (≤0.5 с)»
// на фото-подобном кадре 3000×2000 в Node (серверный путь: декодер-шов
// options.decoder на wasm-декодерах реестра). Запуск:
//   npx tsx scripts/benchmark-server-profile.ts
// Цифры — для машины запуска; на целевом железе (старый Xeon) прогнать
// у себя и масштабировать бюджеты профилей в PROFILES.md.

import { performance } from 'node:perf_hooks';
import { image, getEncoder, PRESETS } from '../src/index.js';
import { resizeBilinear } from '../src/frame.js';
import type { Frame } from '../src/types.js';

/** Детерминированный «фото»-кадр: градиенты + текстура + шум сенсора. */
function makePhotoFrame(width: number, height: number, seed = 12345): Frame {
  let state = seed >>> 0;
  const rand = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const tex = Math.sin(x * 0.11) * Math.cos(y * 0.07) * 28 + Math.sin((x + y) * 0.013) * 18;
      const noise = (rand() - 0.5) * 22;
      data[i] = 90 + (x / width) * 120 + tex + noise;
      data[i + 1] = 80 + (y / height) * 110 + tex * 0.7 + noise;
      data[i + 2] = 120 - (x / width) * 60 + (y / height) * 50 - tex * 0.5 + noise;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  const result = await fn();
  console.log(`${label}: ${(performance.now() - t0).toFixed(0)} ms`);
  return result;
}

/** Серверный декодер-шов: wasm-декодер формата из реестра по типу Blob. */
async function serverDecoder(blob: Blob): Promise<Frame> {
  const codec = getEncoder(blob.type);
  if (!codec.decode) throw new Error(`no decoder for ${blob.type}`);
  return codec.decode(blob);
}

/** Потолок стороны без апскейла: размеры источника — из события decode-done. */
function cappedFrame(maxSide: number, method: 'bilinear' | 'lanczos3') {
  let srcW = 0;
  let srcH = 0;
  return {
    state: (e: { type: string; width?: number; height?: number }) => {
      if (e.type === 'decode-done') {
        srcW = e.width ?? 0;
        srcH = e.height ?? 0;
      }
    },
    options: () => {
      const scale = Math.min(1, maxSide / Math.max(srcW, srcH));
      return {
        width: Math.max(1, Math.round(srcW * scale)),
        height: Math.max(1, Math.round(srcH * scale)),
        fit: 'contain' as const,
        method,
      };
    },
  };
}

// Серверный Node-шов доставки wasm: @jsquash по умолчанию грузит .wasm
// через fetch(file://) — Node это не умеет. Пред-инициализация байтами с
// диска один раз при старте процесса (тот же приём, что test/setup-wasm).
const tInit = performance.now();
await import('../test/setup-wasm.js');
console.log(`init всех wasm-кодеков (старт процесса): ${(performance.now() - tInit).toFixed(0)} ms`);

const source = makePhotoFrame(3000, 2000);
const jpeg = getEncoder('image/jpeg');

console.log('— подготовка источника 3000×2000 —');
const sourceBlob = await timed('jpeg encode q0.85 (первый после init)', () =>
  jpeg.encode(source, { quality: 0.85 }),
);
console.log(`источник: ${(sourceBlob.size / 1024).toFixed(0)} KiB`);
await timed('jpeg encode q0.85 (тёплый, полный размер)', () =>
  jpeg.encode(source, { quality: 0.85 }),
);

console.log('\n— блоки серверного пути —');
if (!jpeg.decode) throw new Error('jpeg codec has no decode');
const decode = jpeg.decode.bind(jpeg);
await timed('decode 3000×2000 (первый после init)', () => decode(sourceBlob));
const decoded = await timed('decode 3000×2000 (тёплый)', () => decode(sourceBlob));
const small = resizeBilinear(decoded, 1600, 1067);
await timed('один jpeg encode 1600×1067 q0.8', () => jpeg.encode(small, { quality: 0.8 }));
const webp = getEncoder('image/webp');
await timed('один webp encode 1600×1067 q0.8 effort 0.17 (method 1, первый)', () =>
  webp.encode(small, { quality: 0.8, effort: 0.17 }),
);
await timed('один webp encode 1600×1067 q0.8 effort 0.17 (тёплый)', () =>
  webp.encode(small, { quality: 0.8, effort: 0.17 }),
);
await timed('один webp encode 1600×1067 q0.8 effort 0.66 (method 4)', () =>
  webp.encode(small, { quality: 0.8, effort: 0.66 }),
);

console.log('\n— AVIF (почему не на сервере) —');
const avif = getEncoder('image/avif');
const tiny = resizeBilinear(decoded, 1280, 853);
await timed('один avif encode 1280×853 q0.6 (первый после init)', () =>
  avif.encode(tiny, { quality: 0.6 }),
);
await timed('один avif encode 1280×853 q0.6 (тёплый)', () => avif.encode(tiny, { quality: 0.6 }));

console.log('\n— СЕРВЕРНЫЙ профиль целиком (цель ≤300 KiB) —');
async function serverRun(method: 'bilinear' | 'lanczos3', formats: string[], effortNote: string) {
  const cap = cappedFrame(1600, method);
  const t0 = performance.now();
  const result = await image(
    sourceBlob,
    async (p) => {
      await p.frame(cap.options());
      return p.fit(
        {
          formats,
          quality: [0.5, 0.9],
          // effort 0.17: WebP method 1; у MozJPEG отключает trellis (порог 0.34).
          variants: [{ effort: 0.17 }],
        },
        (b) => b.size <= 300 * 1024,
        { strategy: 'binary', maxAttempts: 6, deadlineMs: 400, onBudgetExhausted: 'return-null' },
      );
    },
    {
      decoder: serverDecoder,
      state: cap.state as never,
      maxPixels: 40_000_000,
      signal: AbortSignal.timeout(5000),
    },
  );
  const ms = performance.now() - t0;
  console.log(
    `${method} ${formats.join('+')} ${effortNote}: ${ms.toFixed(0)} ms, ` +
      (result
        ? `${(result.blob.size / 1024).toFixed(0)} KiB q=${result.params.quality} попыток=${result.attempts}`
        : 'null (бюджет/исчерпание)'),
  );
}
await serverRun('bilinear', ['image/jpeg'], '');
await serverRun('lanczos3', ['image/jpeg'], '');
await serverRun('bilinear', ['image/webp', 'image/jpeg'], 'webp effort 0.17');

console.log('\n— КЛИЕНТСКИЙ профиль целиком (цель ≤300 KiB, потолок 2048) —');
{
  const cap = cappedFrame(2048, 'lanczos3');
  const t0 = performance.now();
  const result = await image(
    sourceBlob,
    async (p) => {
      await p.frame(cap.options());
      await p.sharpen({ amount: 0.3, radius: 1 });
      return p.fit(
        {
          formats: ['image/webp', 'image/jpeg'],
          quality: [0.5, 0.92],
          // Один слитый вариант: ключи пресетов формато-специфичны, чужие
          // поля кодеки игнорируют. subsampling-измерение сюда НЕ добавляем:
          // jpeg-пресет несёт auto_subsample и перекрыл бы измерение.
          variants: [{ ...PRESETS['image/webp']?.photo, ...PRESETS['image/jpeg']?.photo }],
        },
        (b) => b.size <= 300 * 1024,
        { strategy: 'binary', maxAttempts: 24, deadlineMs: 4500, onBudgetExhausted: 'return-null' },
      );
    },
    { decoder: serverDecoder, state: cap.state as never },
  );
  const ms = performance.now() - t0;
  console.log(
    `client webp→jpeg: ${ms.toFixed(0)} ms, ` +
      (result
        ? `${result.params.format} ${(result.blob.size / 1024).toFixed(0)} KiB q=${result.params.quality} попыток=${result.attempts}`
        : 'null'),
  );
}

console.log('\n— СЕРВЕР v2: потолок 1280, одиночные энкоды с низким effort —');
const s1280 = resizeBilinear(decoded, 1280, 853);
await timed('jpeg 1280×853 q0.8 effort 0.17 (trellis выкл)', () =>
  jpeg.encode(s1280, { quality: 0.8, effort: 0.17 }),
);
await timed('jpeg 1600×1067 q0.8 effort 0.17 (trellis выкл)', () =>
  jpeg.encode(small, { quality: 0.8, effort: 0.17 }),
);
await timed('webp 1280×853 q0.8 effort 0.17 (method 1)', () =>
  webp.encode(s1280, { quality: 0.8, effort: 0.17 }),
);
{
  const t0 = performance.now();
  resizeBilinear(decoded, 1280, 853);
  console.log(`resize bilinear 3000×2000→1280×853: ${(performance.now() - t0).toFixed(0)} ms`);
}

console.log('\n— СЕРВЕР v2: одношаблонный путь без fit (decode уже сделан) —');
async function singleShot(label: string, fmt: string, q: number) {
  const codec = getEncoder(fmt);
  const t0 = performance.now();
  const blob = await codec.encode(s1280, { quality: q, effort: 0.17 });
  console.log(
    `${label}: ${(performance.now() - t0).toFixed(0)} ms, ${(blob.size / 1024).toFixed(0)} KiB`,
  );
  return blob;
}
await singleShot('webp q0.8 m1', 'image/webp', 0.8);
await singleShot('jpeg q0.8 trellis-off', 'image/jpeg', 0.8);

console.log('\n— СЕРВЕР v2: ручная двухпробная коррекция к цели 200 KiB —');
{
  const target = 200 * 1024;
  const t0 = performance.now();
  let q = 0.8;
  let blob = await webp.encode(s1280, { quality: q, effort: 0.17 });
  let probes = 1;
  if (blob.size > target) {
    q = Math.max(0.3, Math.min(0.95, q * Math.pow(target / blob.size, 0.7)));
    blob = await webp.encode(s1280, { quality: q, effort: 0.17 });
    probes = 2;
  }
  console.log(
    `two-shot webp: ${(performance.now() - t0).toFixed(0)} ms, ${(blob.size / 1024).toFixed(0)} KiB, q=${q.toFixed(2)}, проб=${probes} (+ decode и resize сверху)`,
  );
}

console.log('\n— СЕРВЕР v2: fit с малым бюджетом (cap 1280, secant, 4 пробы, цель 200 KiB) —');
{
  const cap = cappedFrame(1280, 'bilinear');
  const t0 = performance.now();
  const result = await image(
    sourceBlob,
    async (p) => {
      await p.frame(cap.options());
      return p.fit(
        { formats: ['image/webp', 'image/jpeg'], quality: [0.4, 0.9], variants: [{ effort: 0.17 }] },
        (b) => b.size <= 200 * 1024,
        { strategy: 'secant', maxAttempts: 4, deadlineMs: 300, onBudgetExhausted: 'return-null' },
      );
    },
    { decoder: serverDecoder, state: cap.state as never, maxPixels: 40_000_000 },
  );
  console.log(
    `fit-secant-4: ${(performance.now() - t0).toFixed(0)} ms, ` +
      (result
        ? `${result.params.format} ${(result.blob.size / 1024).toFixed(0)} KiB q=${result.params.quality} попыток=${result.attempts}`
        : 'null (бюджет исчерпан раньше, чем стратегия вернула точку)'),
  );
}

console.log('\n— decode 12 MP (4032×3024, телефон) —');
{
  const big = makePhotoFrame(4032, 3024, 777);
  const bigBlob = await jpeg.encode(big, { quality: 0.85, effort: 0.17 });
  console.log(`источник 12MP: ${(bigBlob.size / 1024).toFixed(0)} KiB`);
  await timed('decode 4032×3024', () => decode(bigBlob));
}
