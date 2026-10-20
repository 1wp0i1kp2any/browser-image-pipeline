// Ступень квантования палитры. ЛЕНИВЫЙ чанк: image-q подтягивается
// динамическим импортом при первом quantize(), ядро его не тащит.
//
// Разделение труда:
//  - палитру строит image-q: алгоритм (wuquant по умолчанию; также rgbquant,
//    neuquant, neuquant-float) и формула цветового расстояния (pngquant по
//    умолчанию; ciede2000 — самая перцептивно точная и медленная)
//    выбираются вызывающим через QuantizeOptions;
//  - применение палитры — своё: Floyd–Steinberg с непрерывным коэффициентом
//    силы dithering ∈ [0,1] и опциональным serpentine-проходом. У image-q
//    «силы» нет (только выбор алгоритма), а контракт — число. 0 = чистый
//    nearest-colour; это важно для fit: шум дизеринга ломает монотонность
//    кривой «цвета → вес», поэтому поиск всегда квантует с dithering=0.

import type { ColorDistanceFormula, Frame, PaletteAlgorithm } from './types.js';
import { InvalidOptionsError, throwIfAborted } from './errors.js';
import { assertFrame } from './frame.js';

interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

const PALETTE_ALGORITHMS: readonly PaletteAlgorithm[] = [
  'wuquant',
  'rgbquant',
  'neuquant',
  'neuquant-float',
  'fast-median-cut',
];

const DISTANCE_FORMULAS: readonly ColorDistanceFormula[] = [
  'pngquant',
  'euclidean',
  'euclidean-bt709',
  'euclidean-bt709-noalpha',
  'manhattan',
  'manhattan-bt709',
  'manhattan-nommyde',
  'color-metric',
  'cie94-textiles',
  'cie94-graphic-arts',
  'ciede2000',
];

export interface QuantizeInternals {
  algorithm?: PaletteAlgorithm;
  distance?: ColorDistanceFormula;
  serpentine?: boolean;
  signal?: AbortSignal;
}


interface FastPoint extends RGBA {
  key: number;
  count: number;
}

interface FastBox {
  points: FastPoint[];
  count: number;
}

function fastChannelValue(point: FastPoint, channel: number): number {
  return channel === 0 ? point.r : channel === 1 ? point.g : channel === 2 ? point.b : point.a;
}

function fastBox(points: FastPoint[]): FastBox {
  let count = 0;
  for (const point of points) count += point.count;
  return { points, count };
}

function fastBoxChannelRange(box: FastBox, channel: number): number {
  let min = 255;
  let max = 0;
  for (const point of box.points) {
    const v = fastChannelValue(point, channel);
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return max - min;
}

/**
 * Собственный быстрый median-cut без image-q.
 *
 * Это новая независимая реализация, а не порт чужого квантователя:
 * детерминированная выборка до 131072 пикселей, точная гистограмма RGBA
 * внутри выборки, разрезы боксов по медиане канала с наибольшим разбросом.
 * Если уникальных sampled-цветов не больше целевой палитры, они
 * возвращаются точно. Алгоритм сознательно opt-in: wuquant остаётся
 * умолчанием и обычно точнее, fast выигрывает время построения палитры.
 */
export function buildFastPalette(
  frame: Frame,
  colors: number,
  signal?: AbortSignal,
): RGBA[] {
  assertFrame(frame, 'quantize');
  if (!Number.isInteger(colors) || colors < 2 || colors > 256) {
    throw new InvalidOptionsError(
      `quantize: colors must be an integer in [2, 256], got ${colors}`,
    );
  }
  throwIfAborted(signal);
  const total = frame.width * frame.height;
  const MAX_SAMPLES = 131_072;
  const stride = Math.max(1, Math.ceil(total / MAX_SAMPLES));
  const histogram = new Map<number, number>();
  const d = frame.data;
  let sampled = 0;
  for (let p = 0; p < total; p += stride) {
    if ((sampled & 8191) === 0) throwIfAborted(signal);
    sampled++;
    const i = p * 4;
    const key = (((d[i] * 256 + d[i + 1]) * 256 + d[i + 2]) * 256 + d[i + 3]);
    histogram.set(key, (histogram.get(key) ?? 0) + 1);
  }

  const points: FastPoint[] = [...histogram.entries()]
    .map(([key, count]) => ({
      key,
      count,
      r: Math.floor(key / 16_777_216),
      g: Math.floor(key / 65_536) % 256,
      b: Math.floor(key / 256) % 256,
      a: key % 256,
    }))
    .sort((x, y) => y.count - x.count || x.key - y.key);

  if (points.length <= colors) {
    return points.map(({ r, g, b, a }) => ({ r, g, b, a }));
  }

  const boxes: FastBox[] = [fastBox(points)];
  while (boxes.length < colors) {
    throwIfAborted(signal);
    let splitIndex = -1;
    let splitChannel = 0;
    let bestScore = -1;
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (box.points.length < 2) continue;
      for (let channel = 0; channel < 4; channel++) {
        const range = fastBoxChannelRange(box, channel);
        const score = range * Math.log1p(box.count);
        if (score > bestScore) {
          bestScore = score;
          splitIndex = i;
          splitChannel = channel;
        }
      }
    }
    if (splitIndex < 0 || bestScore <= 0) break;

    const box = boxes[splitIndex];
    const sorted = [...box.points].sort(
      (x, y) =>
        fastChannelValue(x, splitChannel) - fastChannelValue(y, splitChannel) || x.key - y.key,
    );
    const half = box.count / 2;
    let cumulative = 0;
    let cut = 1;
    for (let i = 0; i < sorted.length - 1; i++) {
      cumulative += sorted[i].count;
      cut = i + 1;
      if (cumulative >= half) break;
    }
    boxes.splice(
      splitIndex,
      1,
      fastBox(sorted.slice(0, cut)),
      fastBox(sorted.slice(cut)),
    );
  }

  return boxes
    .sort((x, y) => y.count - x.count)
    .map((box) => {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (const point of box.points) {
        r += point.r * point.count;
        g += point.g * point.count;
        b += point.b * point.count;
        a += point.a * point.count;
      }
      return {
        r: Math.round(r / box.count),
        g: Math.round(g / box.count),
        b: Math.round(b / box.count),
        a: Math.round(a / box.count),
      };
    });
}

/** Построить палитру кадра через image-q (ленивая загрузка модуля). */
async function buildPalette(
  frame: Frame,
  colors: number,
  algorithm: Exclude<PaletteAlgorithm, 'fast-median-cut'>,
  distance: ColorDistanceFormula,
): Promise<RGBA[]> {
  const iq = await import('image-q');
  const container = iq.utils.PointContainer.fromUint8Array(
    frame.data,
    frame.width,
    frame.height,
  );
  let palette;
  try {
    palette = iq.buildPaletteSync([container], {
      colors,
      paletteQuantization: algorithm,
      colorDistanceFormula: distance,
    });
  } catch (err) {
    // Например, rgbquant (метод подрегионов) бросает 'No colors in image' на
    // плавных градиентах, где цвета почти не повторяются. Честно называем
    // алгоритм-виновник вместо сырого чужого стека; молча подменять алгоритм
    // на другой библиотека не будет.
    throw new InvalidOptionsError(
      `quantize: palette algorithm "${algorithm}" failed on this frame: ` +
        `${err instanceof Error ? err.message : String(err)}. Try "wuquant".`,
    );
  }
  return palette.getPointContainer().getPointArray().map((p) => ({
    r: p.r,
    g: p.g,
    b: p.b,
    a: p.a,
  }));
}

function nearestIndex(
  palette: readonly RGBA[],
  r: number,
  g: number,
  b: number,
  a: number,
): number {
  // Евклидово расстояние в RGBA. Палитра ≤ 256 цветов, кадр целевой
  // (уже после frame) — линейный поиск приемлем; точный кэш полного
  // RGBA-ключа — в applyPaletteWithDithering ниже.
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const p = palette[i];
    const dr = r - p.r;
    const dg = g - p.g;
    const db = b - p.b;
    const da = a - p.a;
    const dist = dr * dr + dg * dg + db * db + da * da;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
      if (dist === 0) break;
    }
  }
  return best;
}

/**
 * Применить палитру: nearest + Floyd–Steinberg с силой dithering.
 * serpentine=true — нечётные строки проходятся справа налево с зеркальным
 * ядром: меньше направленных артефактов на градиентах.
 */
export function applyPaletteWithDithering(
  frame: Frame,
  palette: readonly RGBA[],
  dithering: number,
  serpentine = false,
  signal?: AbortSignal,
): Frame {
  assertFrame(frame, 'quantize');
  const { width: w, height: h } = frame;
  // Рабочий буфер во float: в него прилетает разнесённая ошибка.
  const work = new Float32Array(frame.data.length);
  work.set(frame.data);
  const out = new Uint8ClampedArray(frame.data.length);

  // Точный кэш nearest по полному RGBA-ключу рабочего пикселя после
  // детерминированного clamp/round. Приближённый ключ по 5 бит/канал
  // склеивал разные цвета и делал результат зависимым от порядка
  // пикселей, поэтому здесь сознательно Map с ограниченным размером:
  // после порога новые записи не добавляются, но поиск остаётся точным.
  const MAX_NEAREST_CACHE_ENTRIES = 1 << 16;
  const cache = new Map<number, number>();
  const clampRound = (value: number): number =>
    Math.round(Math.max(0, Math.min(255, value)));
  const strength = dithering;

  const spread = (idx: number, er: number, eg: number, eb: number, ea: number, k: number) => {
    work[idx] += er * k;
    work[idx + 1] += eg * k;
    work[idx + 2] += eb * k;
    work[idx + 3] += ea * k;
  };

  for (let y = 0; y < h; y++) {
    if ((y & 31) === 0) throwIfAborted(signal);
    const ltr = !serpentine || y % 2 === 0;
    for (let xi = 0; xi < w; xi++) {
      const x = ltr ? xi : w - 1 - xi;
      const i = (y * w + x) * 4;
      const r = work[i];
      const g = work[i + 1];
      const b = work[i + 2];
      const a = work[i + 3];

      // Поиск делается по байтовому представлению рабочего пикселя;
      // дробный остаток ошибки Floyd–Steinberg ниже по-прежнему
      // разносится из исходных float-значений r/g/b/a.
      const qr = clampRound(r);
      const qg = clampRound(g);
      const qb = clampRound(b);
      const qa = clampRound(a);
      const key = (((qr * 256 + qg) * 256 + qb) * 256 + qa);
      let pi = cache.get(key);
      if (pi === undefined) {
        pi = nearestIndex(palette, qr, qg, qb, qa);
        if (cache.size < MAX_NEAREST_CACHE_ENTRIES) cache.set(key, pi);
      }
      const p = palette[pi];
      out[i] = p.r;
      out[i + 1] = p.g;
      out[i + 2] = p.b;
      out[i + 3] = p.a;

      if (strength > 0) {
        const er = (r - p.r) * strength;
        const eg = (g - p.g) * strength;
        const eb = (b - p.b) * strength;
        const ea = (a - p.a) * strength;
        // Ядро Floyd–Steinberg 7/16, 3/16, 5/16, 1/16; dirAb — шаг «вперёд»
        // по строке в байтах (зеркалится при serpentine).
        const dirAb = ltr ? 4 : -4;
        const hasAhead = ltr ? x + 1 < w : x > 0;
        const hasBehind = ltr ? x > 0 : x + 1 < w;
        if (hasAhead) spread(i + dirAb, er, eg, eb, ea, 7 / 16);
        if (y + 1 < h) {
          if (hasBehind) spread(i + w * 4 - dirAb, er, eg, eb, ea, 3 / 16);
          spread(i + w * 4, er, eg, eb, ea, 5 / 16);
          if (hasAhead) spread(i + w * 4 + dirAb, er, eg, eb, ea, 1 / 16);
        }
      }
    }
  }
  return { data: out, width: w, height: h };
}

/**
 * Срезать палитру кадра до colors цветов. Формат кадра не меняется:
 * палитра — свойство пикселей, энкодер получит уже квантованный кадр.
 */
export async function quantizeFrame(
  frame: Frame,
  colors: number,
  dithering = 0,
  internals: QuantizeInternals = {},
): Promise<Frame> {
  assertFrame(frame, 'quantize');
  if (!Number.isInteger(colors) || colors < 2 || colors > 256) {
    throw new InvalidOptionsError(
      `quantize: colors must be an integer in [2, 256], got ${colors}`,
    );
  }
  if (!(dithering >= 0 && dithering <= 1)) {
    throw new InvalidOptionsError(
      `quantize: dithering must be in [0, 1], got ${dithering}`,
    );
  }
  const algorithm = internals.algorithm ?? 'wuquant';
  if (!PALETTE_ALGORITHMS.includes(algorithm)) {
    throw new InvalidOptionsError(`quantize: unknown palette algorithm "${String(algorithm)}"`);
  }
  const distance = internals.distance ?? 'pngquant';
  if (!DISTANCE_FORMULAS.includes(distance)) {
    throw new InvalidOptionsError(`quantize: unknown color distance formula "${String(distance)}"`);
  }
  let palette: RGBA[];
  if (algorithm === 'fast-median-cut') {
    if (internals.distance !== undefined && internals.distance !== 'euclidean') {
      throw new InvalidOptionsError(
        'quantize: fast-median-cut uses euclidean RGBA distance; omit distance or set "euclidean"',
      );
    }
    palette = buildFastPalette(frame, colors, internals.signal);
  } else {
    palette = await buildPalette(frame, colors, algorithm, distance);
  }
  throwIfAborted(internals.signal);
  if (palette.length === 0) {
    throw new InvalidOptionsError('quantize: empty palette (empty frame?)');
  }
  return applyPaletteWithDithering(
    frame,
    palette,
    dithering,
    internals.serpentine ?? false,
    internals.signal,
  );
}
