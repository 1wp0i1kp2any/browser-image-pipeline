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

/** Непубличные (для ступени pipeline) параметры квантования. */
export interface QuantizeInternals {
  /** Алгоритм палитры (по умолчанию 'wuquant'). */
  algorithm?: PaletteAlgorithm;
  /** Формула расстояния image-q (по умолчанию 'euclidean-bt709'). */
  distance?: ColorDistanceFormula;
  /** Серпантин дизеринга (по умолчанию false). */
  serpentine?: boolean;
  /** Отмена долгих циклов по строкам. */
  signal?: AbortSignal;
}


interface FastPoint extends RGBA {
  key: number;
  count: number;
}

interface FastBox {
  points: FastPoint[];
  count: number;
  /**
   * Кэшированные разбросы каналов и взвешенные суммы бокса.
   * Классический median-cut (MMCQ/Leptonica, VBox в quantize.js) хранит
   * границы и счётчики бокса один раз при создании; прежняя версия
   * пересчитывала разбросы всех боксов перед каждым разрезом, что давало
   * O(colors × points) лишних проходов. Значения те же — выбор разреза и
   * средние цвета не меняются.
   */
  ranges: readonly [number, number, number, number];
  sums: readonly [number, number, number, number];
  logCount: number;
}

/**
 * Значение канала точки гистограммы по номеру канала.
 *
 * @param point - точка цвета с весом.
 * @param channel - 0=R, 1=G, 2=B, 3=A.
 * @returns значение канала 0..255.
 */
function fastChannelValue(point: FastPoint, channel: number): number {
  return channel === 0 ? point.r : channel === 1 ? point.g : channel === 2 ? point.b : point.a;
}

/**
 * Создать бокс median-cut с кэшированными статистиками.
 *
 * @param points - точки бокса (массив забирается во владение боксом).
 * @returns бокс с count, разбросами каналов, взвешенными суммами и logCount.
 */
function fastBox(points: FastPoint[]): FastBox {
  let count = 0;
  let minR = 255, minG = 255, minB = 255, minA = 255;
  let maxR = 0, maxG = 0, maxB = 0, maxA = 0;
  let sumR = 0, sumG = 0, sumB = 0, sumA = 0;
  for (const point of points) {
    count += point.count;
    if (point.r < minR) minR = point.r;
    if (point.r > maxR) maxR = point.r;
    if (point.g < minG) minG = point.g;
    if (point.g > maxG) maxG = point.g;
    if (point.b < minB) minB = point.b;
    if (point.b > maxB) maxB = point.b;
    if (point.a < minA) minA = point.a;
    if (point.a > maxA) maxA = point.a;
    sumR += point.r * point.count;
    sumG += point.g * point.count;
    sumB += point.b * point.count;
    sumA += point.a * point.count;
  }
  return {
    points,
    count,
    ranges: [maxR - minR, maxG - minG, maxB - minB, maxA - minA],
    sums: [sumR, sumG, sumB, sumA],
    logCount: Math.log1p(count),
  };
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
 *
 * @param frame - кадр для гистограммы.
 * @param colors - целевой размер палитры, целое 2..256.
 * @param signal - необязательная отмена (проверяется по выборке и разрезам).
 * @returns палитра до colors цветов, отсортированная по убыванию веса боксов.
 * @throws InvalidOptionsError при colors вне [2, 256].
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
      r: key >>> 24,
      g: (key >>> 16) & 255,
      b: (key >>> 8) & 255,
      a: key & 255,
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
        const score = box.ranges[channel] * box.logCount;
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
    .map((box) => ({
      r: Math.round(box.sums[0] / box.count),
      g: Math.round(box.sums[1] / box.count),
      b: Math.round(box.sums[2] / box.count),
      a: Math.round(box.sums[3] / box.count),
    }));
}

/**
 * Построить палитру кадра через image-q (ленивая загрузка модуля).
 *
 * @param frame - кадр целиком (image-q работает без выборки).
 * @param colors - целевой размер палитры 2..256.
 * @param algorithm - алгоритм image-q ('wuquant' и др., без fast-median-cut).
 * @param distance - формула цветового расстояния image-q.
 * @returns палитра RGBA в порядке image-q.
 * @throws InvalidOptionsError, если алгоритм честно упал на этом кадре.
 */
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

/**
 * Линейный поиск ближайшего цвета по объектам палитры (евклид RGBA).
 *
 * Используется путём с дизерингом: замер в V8 показал, что в окружении
 * цикла Floyd–Steinberg этот вариант быстрее и плоского типизированного
 * сканирования, и VP-дерева (на diffused-значениях отсечение дерева
 * деградирует). Семантика та же: первый индекс с минимальной дистанцией.
 */
function nearestIndex(
  palette: readonly RGBA[],
  r: number,
  g: number,
  b: number,
  a: number,
): number {
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
 * Палитра одним плоским RGBA-массивом для VP-дерева точного пути.
 *
 * @param palette - цвета палитры объектами.
 * @returns Uint8ClampedArray [r,g,b,a, ...] в том же порядке.
 */
function flattenPalette(palette: readonly RGBA[]): Uint8ClampedArray {
  const flat = new Uint8ClampedArray(palette.length * 4);
  for (let i = 0; i < palette.length; i++) {
    const p = palette[i];
    const o = i * 4;
    flat[o] = p.r;
    flat[o + 1] = p.g;
    flat[o + 2] = p.b;
    flat[o + 3] = p.a;
  }
  return flat;
}

/** Узел VP-дерева поиска ближайшего цвета. */
interface VpNode {
  /** Индекс опорного цвета палитры. */
  idx: number;
  /** Пороговая дистанция раздела near/far (не квадрат). */
  radius: number;
  near: VpNode | null;
  far: VpNode | null;
  /** Лист: остальные индексы узла, проверяются линейно. */
  leaf: readonly number[] | null;
}

/**
 * Создать точный поиск ближайшего цвета палитры по евклидову расстоянию RGBA.
 *
 * Семантика прежнего линейного поиска сохранена побитово: возвращается
 * ПЕРВЫЙ индекс с минимальной дистанцией, ничьи — за меньшим индексом.
 * Для палитр больше 24 цветов строится vantage-point дерево — тот же
 * алгоритм, которым libimagequant (pngquant) заменил линейный поиск в
 * remap: опорный цвет делит остальные медианой дистанции, поиск идёт в
 * вероятную половину и заглядывает во вторую только когда граница по
 * неравенству треугольника не исключает там ответ не хуже текущего
 * (нестрогие сравнения + epsilon — ради ничьих за меньшим индексом).
 * Замер на research-корпусе 800×600/128 цветов: ~2.6× быстрее линейного
 * сканирования при нуле расхождений на всех пикселях. Малые палитры
 * дерево не окупают — там остаётся плоское сканирование.
 *
 * Дерево используется только точным путём (dithering=0): на значениях
 * после разнесённой ошибки Floyd–Steinberg его отсечение деградирует
 * (пиксели систематически между цветами палитры), и дизеринг-путь
 * оставлен на прежнем объектном линейном поиске — так быстрее по замеру.
 *
 * @param flat - плоская палитра (см. flattenPalette).
 * @param count - число цветов палитры.
 * @returns функция поиска: (r, g, b, a) → индекс ближайшего цвета.
 */
function createNearestSearch(
  flat: Uint8ClampedArray,
  count: number,
): (r: number, g: number, b: number, a: number) => number {
  const distSqTo = (idx: number, r: number, g: number, b: number, a: number): number => {
    const o = idx * 4;
    const dr = r - flat[o];
    const dg = g - flat[o + 1];
    const db = b - flat[o + 2];
    const da = a - flat[o + 3];
    return dr * dr + dg * dg + db * db + da * da;
  };

  if (count <= 24) {
    // Дистанция инлайнится прямо в цикл: вызов helper-функции на каждого
    // кандидата V8 в этом горячем цикле не инлайнит (замер: +60% времени).
    return (r, g, b, a) => {
      let best = 0;
      let bestDist = Infinity;
      for (let i = 0; i < count; i++) {
        const o = i * 4;
        const dr = r - flat[o];
        const dg = g - flat[o + 1];
        const db = b - flat[o + 2];
        const da = a - flat[o + 3];
        const dist = dr * dr + dg * dg + db * db + da * da;
        if (dist < bestDist) {
          bestDist = dist;
          best = i;
          if (dist === 0) break;
        }
      }
      return best;
    };
  }

  const LEAF_MAX = 6;
  const build = (indexes: number[]): VpNode => {
    const vp = indexes[0];
    const rest = indexes.slice(1);
    if (rest.length <= LEAF_MAX) {
      return { idx: vp, radius: 0, near: null, far: null, leaf: rest };
    }
    const withDist = rest.map((i) => ({
      i,
      d: distSqTo(i, flat[vp * 4], flat[vp * 4 + 1], flat[vp * 4 + 2], flat[vp * 4 + 3]),
    }));
    withDist.sort((x, y) => x.d - y.d || x.i - y.i);
    const half = withDist.length >> 1;
    return {
      idx: vp,
      radius: Math.sqrt(withDist[half].d),
      near: build(withDist.slice(0, half).map((x) => x.i)),
      far: build(withDist.slice(half).map((x) => x.i)),
      leaf: null,
    };
  };
  const root = build(Array.from({ length: count }, (_, i) => i));

  let best = 0;
  let bestSq = Infinity;
  const visit: (node: VpNode, r: number, g: number, b: number, a: number) => void = (
    node,
    r,
    g,
    b,
    a,
  ) => {
    const no = node.idx * 4;
    const ndr = r - flat[no];
    const ndg = g - flat[no + 1];
    const ndb = b - flat[no + 2];
    const nda = a - flat[no + 3];
    const dSq = ndr * ndr + ndg * ndg + ndb * ndb + nda * nda;
    if (dSq < bestSq || (dSq === bestSq && node.idx < best)) {
      bestSq = dSq;
      best = node.idx;
    }
    if (node.leaf) {
      for (const idx of node.leaf) {
        const o = idx * 4;
        const dr = r - flat[o];
        const dg = g - flat[o + 1];
        const db = b - flat[o + 2];
        const da = a - flat[o + 3];
        const dist = dr * dr + dg * dg + db * db + da * da;
        if (dist < bestSq || (dist === bestSq && idx < best)) {
          bestSq = dist;
          best = idx;
        }
      }
      return;
    }
    const d = Math.sqrt(dSq);
    if (d < node.radius) {
      visit(node.near as VpNode, r, g, b, a);
      if (node.radius - d <= Math.sqrt(bestSq) + 1e-9) {
        visit(node.far as VpNode, r, g, b, a);
      }
    } else {
      visit(node.far as VpNode, r, g, b, a);
      if (d - node.radius <= Math.sqrt(bestSq) + 1e-9) {
        visit(node.near as VpNode, r, g, b, a);
      }
    }
  };

  return (r, g, b, a) => {
    best = 0;
    bestSq = Infinity;
    visit(root, r, g, b, a);
    return best;
  };
}

/**
 * Применить палитру: nearest + Floyd–Steinberg с силой dithering.
 * serpentine=true — нечётные строки проходятся справа налево с зеркальным
 * ядром: меньше направленных артефактов на градиентах.
 *
 * @param frame - исходный кадр.
 * @param palette - палитра для применения.
 * @param dithering - сила Floyd–Steinberg 0..1; 0 — чистый nearest.
 * @param serpentine - зеркалить ядро на нечётных строках (только при dithering > 0).
 * @param signal - необязательная отмена.
 * @returns новый кадр, где каждый пиксель заменён ближайшим цветом палитры.
 *
 * Пути dithering=0 и dithering>0 — отдельные функции: кроме разной
 * алгоритмики (без дизеринга не нужен float-буфер ошибки), замер показал,
 * что V8 заметно хуже оптимизирует один большой цикл-функцию с ветвлением
 * по силе на каждом пикселе.
 */
export function applyPaletteWithDithering(
  frame: Frame,
  palette: readonly RGBA[],
  dithering: number,
  serpentine = false,
  signal?: AbortSignal,
): Frame {
  assertFrame(frame, 'quantize');
  const flat = flattenPalette(palette);
  // Точный кэш nearest по полному RGBA-ключу рабочего пикселя после
  // детерминированного clamp/round. Приближённый ключ по 5 бит/канал
  // склеивал разные цвета и делал результат зависимым от порядка
  // пикселей, поэтому здесь сознательно Map с ограниченным размером:
  // после порога новые записи не добавляются, но поиск остаётся точным.
  const cache = new Map<number, number>();
  return dithering === 0
    ? applyPaletteExact(frame, flat, cache, signal)
    : applyPaletteDithered(frame, palette, cache, dithering, serpentine, signal);
}

/** Лимит точного кэша nearest: после порога новые ключи не добавляются. */
const MAX_NEAREST_CACHE_ENTRIES = 1 << 16;

/**
 * Применение палитры без дизеринга по точным пикселям кадра.
 *
 * Рабочий float-буфер не нужен: прежний общий путь копировал кадр в
 * Float32Array (16 байт/пиксель), только чтобы читать те же байты
 * обратно. Порядок обхода и серпантин на результат не влияют —
 * отображение пикселей независимо. Результат побитово тот же.
 */
function applyPaletteExact(
  frame: Frame,
  flat: Uint8ClampedArray,
  cache: Map<number, number>,
  signal?: AbortSignal,
): Frame {
  const { width: w, height: h } = frame;
  const out = new Uint8ClampedArray(frame.data.length);
  const nearest = createNearestSearch(flat, flat.length / 4);
  const s = frame.data;
  for (let y = 0; y < h; y++) {
    if ((y & 31) === 0) throwIfAborted(signal);
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      const i = row + x * 4;
      const r = s[i];
      const g = s[i + 1];
      const b = s[i + 2];
      const a = s[i + 3];
      const key = (((r * 256 + g) * 256 + b) * 256 + a);
      let pi = cache.get(key);
      if (pi === undefined) {
        pi = nearest(r, g, b, a);
        if (cache.size < MAX_NEAREST_CACHE_ENTRIES) cache.set(key, pi);
      }
      const o = pi * 4;
      out[i] = flat[o];
      out[i + 1] = flat[o + 1];
      out[i + 2] = flat[o + 2];
      out[i + 3] = flat[o + 3];
    }
  }
  return { data: out, width: w, height: h };
}

/**
 * Применение палитры с разнесением ошибки Floyd–Steinberg силой strength.
 *
 * Рабочий буфер — float: в него прилетает разнесённая ошибка. Поиск
 * делается по байтовому представлению рабочего пикселя, дробный остаток
 * ошибки разносится из исходных float-значений.
 *
 * @param frame - исходный кадр.
 * @param palette - палитра объектами (объектный поиск — см. nearestIndex).
 * @param cache - общий точный кэш nearest вызывающего.
 * @param strength - сила дизеринга 0..1 (сюда попадают только значения > 0).
 * @param serpentine - зеркалить ядро на нечётных строках.
 * @param signal - необязательная отмена (проверяется каждые 32 строки).
 * @returns квантованный кадр тех же размеров.
 */
function applyPaletteDithered(
  frame: Frame,
  palette: readonly RGBA[],
  cache: Map<number, number>,
  strength: number,
  serpentine: boolean,
  signal?: AbortSignal,
): Frame {
  const { width: w, height: h } = frame;
  const out = new Uint8ClampedArray(frame.data.length);
  const work = new Float32Array(frame.data.length);
  work.set(frame.data);
  const clampRound = (value: number): number =>
    Math.round(Math.max(0, Math.min(255, value)));

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
      const chosen = palette[pi];
      out[i] = chosen.r;
      out[i + 1] = chosen.g;
      out[i + 2] = chosen.b;
      out[i + 3] = chosen.a;

      const er = (r - chosen.r) * strength;
      const eg = (g - chosen.g) * strength;
      const eb = (b - chosen.b) * strength;
      const ea = (a - chosen.a) * strength;
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
  return { data: out, width: w, height: h };
}

/**
 * Срезать палитру кадра до colors цветов. Формат кадра не меняется:
 * палитра — свойство пикселей, энкодер получит уже квантованный кадр.
 *
 * @param frame - исходный кадр.
 * @param colors - размер палитры, целое 2..256.
 * @param dithering - сила дизеринга 0..1 (по умолчанию 0).
 * @param internals - алгоритм/формула/серпантин/signal (см. QuantizeInternals).
 * @returns новый кадр с палитрой до colors цветов.
 * @throws InvalidOptionsError при невалидных colors/dithering/алгоритме/формуле.
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
