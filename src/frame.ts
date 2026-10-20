// Геометрия кадра на чистом TS (без canvas): билинейный ресайз + центральный кроп.
//
// Почему не OffscreenCanvas.drawImage:
//  1) качество сглаживания drawImage различается между браузерами и не
//     контролируется библиотекой — вес результата при одном качестве
//     «плавал» бы от среды;
//  2) чистый TS одинаково работает в браузере и в Node, значит геометрия
//     покрывается юнит-тестами без браузера.
// Плата — скорость на больших кадрах; ступень frame по контракту идёт первой
// и режет кадр до целевого, поэтому тяжёлым остаётся один проход по исходнику.

import type { Frame, FrameOptions, ResizeMethod } from './types.js';
import { InvalidOptionsError, throwIfAborted } from './errors.js';

const MAX_TYPED_ARRAY_LENGTH = 0x7fffffff;

function assertAllocationLength(length: number, where: string): void {
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_TYPED_ARRAY_LENGTH) {
    throw new InvalidOptionsError(
      `${where}: allocation is too large (${length} elements)`,
    );
  }
}

export function assertFrame(frame: Frame, where: string): void {
  const expected =
    frame && Number.isInteger(frame.width) && Number.isInteger(frame.height)
      ? frame.width * frame.height * 4
      : Number.NaN;
  if (
    !frame ||
    !Number.isInteger(frame.width) ||
    !Number.isInteger(frame.height) ||
    frame.width <= 0 ||
    frame.height <= 0 ||
    !Number.isSafeInteger(expected) ||
    frame.data.length !== expected
  ) {
    throw new InvalidOptionsError(
      `${where}: invalid frame (expected data.length === width*height*4)`,
    );
  }
}

export function cloneFrame(frame: Frame): Frame {
  return {
    data: new Uint8ClampedArray(frame.data),
    width: frame.width,
    height: frame.height,
  };
}

function assertResizeTarget(dstW: number, dstH: number): void {
  if (!Number.isInteger(dstW) || !Number.isInteger(dstH) || dstW <= 0 || dstH <= 0) {
    throw new InvalidOptionsError(
      `resize: target size must be positive integers, got ${dstW}x${dstH}`,
    );
  }
  assertAllocationLength(dstW * dstH * 4, 'resize');
}

/**
 * Билинейный ресайз кадра до dstW × dstH.
 *
 * Интерполяция идёт в premultiplied-альфе: невидимый RGB полностью
 * прозрачных пикселей не имеет права окрашивать видимых соседей.
 * При итоговой альфе ~0 RGB канонически остаётся нулевым.
 */
export function resizeBilinear(
  src: Frame,
  dstW: number,
  dstH: number,
  signal?: AbortSignal,
): Frame {
  assertFrame(src, 'resize');
  assertResizeTarget(dstW, dstH);
  throwIfAborted(signal);
  if (dstW === src.width && dstH === src.height) return cloneFrame(src);

  const { data: s, width: sw, height: sh } = src;
  const out = new Uint8ClampedArray(dstW * dstH * 4);
  // Центры пикселей: dst-пиксель (x,y) смотрит в src ((x+0.5)*scale-0.5).
  const xRatio = sw / dstW;
  const yRatio = sh / dstH;

  for (let y = 0; y < dstH; y++) {
    if ((y & 31) === 0) throwIfAborted(signal);
    const srcY = Math.min(Math.max((y + 0.5) * yRatio - 0.5, 0), sh - 1);
    const y0 = Math.floor(srcY);
    const y1 = Math.min(y0 + 1, sh - 1);
    const fy = srcY - y0;
    for (let x = 0; x < dstW; x++) {
      const srcX = Math.min(Math.max((x + 0.5) * xRatio - 0.5, 0), sw - 1);
      const x0 = Math.floor(srcX);
      const x1 = Math.min(x0 + 1, sw - 1);
      const fx = srcX - x0;

      const i00 = (y0 * sw + x0) * 4;
      const i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;
      const o = (y * dstW + x) * 4;

      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      const a00 = s[i00 + 3] / 255;
      r += s[i00] * a00 * w00;
      g += s[i00 + 1] * a00 * w00;
      b += s[i00 + 2] * a00 * w00;
      a += s[i00 + 3] * w00;

      const a10 = s[i10 + 3] / 255;
      r += s[i10] * a10 * w10;
      g += s[i10 + 1] * a10 * w10;
      b += s[i10 + 2] * a10 * w10;
      a += s[i10 + 3] * w10;

      const a01 = s[i01 + 3] / 255;
      r += s[i01] * a01 * w01;
      g += s[i01 + 1] * a01 * w01;
      b += s[i01 + 2] * a01 * w01;
      a += s[i01 + 3] * w01;

      const a11 = s[i11 + 3] / 255;
      r += s[i11] * a11 * w11;
      g += s[i11 + 1] * a11 * w11;
      b += s[i11 + 2] * a11 * w11;
      a += s[i11 + 3] * w11;

      if (a > 0.5) {
        const inv = 255 / a;
        out[o] = Math.max(0, Math.min(255, r * inv));
        out[o + 1] = Math.max(0, Math.min(255, g * inv));
        out[o + 2] = Math.max(0, Math.min(255, b * inv));
      }
      out[o + 3] = Math.max(0, Math.min(255, a));
    }
  }
  return { data: out, width: dstW, height: dstH };
}

// --- Сепарабельный ресемплинг (lanczos3 / area) ------------------------------
//
// Корректный даунскейл требует, чтобы окно усреднения росло вместе с
// коэффициентом уменьшения: фиксированное ядро 2×2/6×6 при сильном
// уменьшении пропускает высокие частоты, которые возвращаются алиасингом.
// Поэтому ядро масштабируется: support = radius * max(1, scale).
// Свёртка считается в premultiplied-альфе, чтобы цвет полностью прозрачных
// пикселей не «протекал» в соседи цветным ореолом.

type KernelFn = (x: number) => number;

function sinc(x: number): number {
  if (x === 0) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

const LANCZOS_A = 3;
const lanczosKernel: KernelFn = (x) =>
  Math.abs(x) >= LANCZOS_A ? 0 : sinc(x) * sinc(x / LANCZOS_A);
interface AxisPlan {
  // Для каждого выходного пикселя: начальный индекс и веса входных.
  starts: Int32Array;
  weights: Float32Array[]; // веса уже нормированы (сумма 1)
}

type AxisPlanner = (srcLen: number, dstLen: number) => AxisPlan;

function planKernelAxis(srcLen: number, dstLen: number, kernel: KernelFn, radius: number): AxisPlan {
  const scale = srcLen / dstLen;
  const support = radius * Math.max(1, scale);
  const starts = new Int32Array(dstLen);
  const weights: Float32Array[] = new Array(dstLen);
  for (let d = 0; d < dstLen; d++) {
    const center = (d + 0.5) * scale - 0.5;
    const from = Math.max(0, Math.ceil(center - support));
    const to = Math.min(srcLen - 1, Math.floor(center + support));
    const w = new Float32Array(to - from + 1);
    let sum = 0;
    for (let s = from; s <= to; s++) {
      const v = kernel((s - center) / Math.max(1, scale));
      w[s - from] = v;
      sum += v;
    }
    if (Math.abs(sum) > 1e-12) {
      for (let i = 0; i < w.length; i++) w[i] /= sum;
      starts[d] = from;
      weights[d] = w;
    } else {
      // Вырожденное окно не должно давать пустой/прозрачный пиксель:
      // детерминированно берём ближайший центр исходного пикселя.
      const nearest = Math.max(0, Math.min(srcLen - 1, Math.round(center)));
      starts[d] = nearest;
      weights[d] = new Float32Array([1]);
    }
  }
  return { starts, weights };
}

/**
 * Точный area-план одной оси.
 *
 * Исходный пиксель s занимает интервал [s, s+1), выходной d —
 * [d*scale, (d+1)*scale). Вес равен длине пересечения интервалов,
 * делённой на scale. Это честное интегрирование по площади, а не
 * точечная выборка box-ядра в центрах пикселей: постоянный сигнал
 * сохраняется при любом дробном масштабе, включая upscale.
 */
function planAreaAxis(srcLen: number, dstLen: number): AxisPlan {
  const scale = srcLen / dstLen;
  const starts = new Int32Array(dstLen);
  const weights: Float32Array[] = new Array(dstLen);
  for (let d = 0; d < dstLen; d++) {
    const start = d * scale;
    const end = (d + 1) * scale;
    let from = Math.max(0, Math.floor(start));
    let to = Math.min(srcLen - 1, Math.ceil(end - 1e-12) - 1);
    if (to < from) {
      const nearest = Math.max(
        0,
        Math.min(srcLen - 1, Math.floor(Math.min(srcLen - 1e-9, (start + end) / 2))),
      );
      from = nearest;
      to = nearest;
    }
    const w = new Float32Array(to - from + 1);
    let sum = 0;
    for (let s = from; s <= to; s++) {
      const overlap = Math.max(0, Math.min(end, s + 1) - Math.max(start, s));
      const value = overlap / scale;
      w[s - from] = value;
      sum += value;
    }
    if (sum > 1e-12) {
      // Нормировка убирает только накопленную float-погрешность на границах.
      for (let i = 0; i < w.length; i++) w[i] /= sum;
      starts[d] = from;
      weights[d] = w;
    } else {
      const nearest = Math.max(
        0,
        Math.min(srcLen - 1, Math.floor(Math.min(srcLen - 1e-9, (start + end) / 2))),
      );
      starts[d] = nearest;
      weights[d] = new Float32Array([1]);
    }
  }
  return { starts, weights };
}

function resizeSeparable(
  src: Frame,
  dstW: number,
  dstH: number,
  planner: AxisPlanner,
  signal?: AbortSignal,
): Frame {
  assertFrame(src, 'resize');
  assertResizeTarget(dstW, dstH);
  assertAllocationLength(dstW * src.height * 4, 'resize temporary buffer');
  throwIfAborted(signal);
  if (dstW === src.width && dstH === src.height) return cloneFrame(src);
  const planX = planner(src.width, dstW);
  const planY = planner(src.height, dstH);

  // Горизонтальный проход → float, premultiplied.
  const tmp = new Float32Array(dstW * src.height * 4);
  const s = src.data;
  for (let y = 0; y < src.height; y++) {
    if ((y & 31) === 0) throwIfAborted(signal);
    for (let x = 0; x < dstW; x++) {
      const from = planX.starts[x];
      const w = planX.weights[x];
      let r = 0, g = 0, b = 0, a = 0;
      for (let i = 0; i < w.length; i++) {
        const idx = (y * src.width + from + i) * 4;
        const alpha = s[idx + 3] / 255;
        const wi = w[i];
        r += s[idx] * alpha * wi;
        g += s[idx + 1] * alpha * wi;
        b += s[idx + 2] * alpha * wi;
        a += s[idx + 3] * wi;
      }
      const o = (y * dstW + x) * 4;
      tmp[o] = r; tmp[o + 1] = g; tmp[o + 2] = b; tmp[o + 3] = a;
    }
  }

  // Вертикальный проход + распремножение.
  const out = new Uint8ClampedArray(dstW * dstH * 4);
  for (let y = 0; y < dstH; y++) {
    if ((y & 31) === 0) throwIfAborted(signal);
    const from = planY.starts[y];
    const w = planY.weights[y];
    for (let x = 0; x < dstW; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let i = 0; i < w.length; i++) {
        const idx = ((from + i) * dstW + x) * 4;
        const wi = w[i];
        r += tmp[idx] * wi;
        g += tmp[idx + 1] * wi;
        b += tmp[idx + 2] * wi;
        a += tmp[idx + 3] * wi;
      }
      const o = (y * dstW + x) * 4;
      if (a > 0.5) {
        const inv = 255 / a;
        out[o] = Math.max(0, Math.min(255, r * inv));
        out[o + 1] = Math.max(0, Math.min(255, g * inv));
        out[o + 2] = Math.max(0, Math.min(255, b * inv));
      }
      out[o + 3] = Math.max(0, Math.min(255, a));
    }
  }
  return { data: out, width: dstW, height: dstH };
}

/** Lanczos3-ресемплинг: самый резкий даунскейл фото (выбор Squoosh/Sharp). */
export function resizeLanczos3(
  src: Frame,
  dstW: number,
  dstH: number,
  signal?: AbortSignal,
): Frame {
  return resizeSeparable(
    src,
    dstW,
    dstH,
    (srcLen, dstLen) => planKernelAxis(srcLen, dstLen, lanczosKernel, LANCZOS_A),
    signal,
  );
}

/** Area-ресемплинг: точное усреднение по площади; лучше всех гасит муар при сильном уменьшении. */
export function resizeArea(
  src: Frame,
  dstW: number,
  dstH: number,
  signal?: AbortSignal,
): Frame {
  return resizeSeparable(src, dstW, dstH, planAreaAxis, signal);
}

function resizeByMethod(
  src: Frame,
  dstW: number,
  dstH: number,
  method: ResizeMethod,
  signal?: AbortSignal,
): Frame {
  switch (method) {
    case 'lanczos3':
      return resizeLanczos3(src, dstW, dstH, signal);
    case 'area':
      return resizeArea(src, dstW, dstH, signal);
    default:
      return resizeBilinear(src, dstW, dstH, signal);
  }
}

// --- Повышение резкости (unsharp mask) --------------------------------------

/** Быстрое сепарабельное box-размытие premultiplied RGBA (sliding window), float на выходе. */
function boxBlurPremultiplied(src: Frame, radius: number, signal?: AbortSignal): Float32Array {
  const { width: w, height: h, data: s } = src;
  const premultiplied = new Float32Array(s.length);
  for (let i = 0; i < s.length; i += 4) {
    const alpha = s[i + 3] / 255;
    premultiplied[i] = s[i] * alpha;
    premultiplied[i + 1] = s[i + 1] * alpha;
    premultiplied[i + 2] = s[i + 2] * alpha;
    premultiplied[i + 3] = s[i + 3];
  }

  const tmp = new Float32Array(s.length);
  const out = new Float32Array(s.length);
  const win = radius * 2 + 1;
  // Горизонталь.
  for (let y = 0; y < h; y++) {
    if ((y & 31) === 0) throwIfAborted(signal);
    for (let c = 0; c < 4; c++) {
      let acc = 0;
      for (let x = -radius; x <= radius; x++) {
        acc += premultiplied[(y * w + Math.max(0, Math.min(w - 1, x))) * 4 + c];
      }
      for (let x = 0; x < w; x++) {
        tmp[(y * w + x) * 4 + c] = acc / win;
        const sub = premultiplied[(y * w + Math.max(0, x - radius)) * 4 + c];
        const add = premultiplied[(y * w + Math.min(w - 1, x + radius + 1)) * 4 + c];
        acc += add - sub;
      }
    }
  }
  // Вертикаль.
  for (let x = 0; x < w; x++) {
    if ((x & 31) === 0) throwIfAborted(signal);
    for (let c = 0; c < 4; c++) {
      let acc = 0;
      for (let y = -radius; y <= radius; y++) {
        acc += tmp[(Math.max(0, Math.min(h - 1, y)) * w + x) * 4 + c];
      }
      for (let y = 0; y < h; y++) {
        out[(y * w + x) * 4 + c] = acc / win;
        const sub = tmp[(Math.max(0, y - radius) * w + x) * 4 + c];
        const add = tmp[(Math.min(h - 1, y + radius + 1) * w + x) * 4 + c];
        acc += add - sub;
      }
    }
  }
  return out;
}

/**
 * Unsharp mask: out = src + amount * (src - blur(src)). Альфа не трогается.
 * Классический «output sharpening» после уменьшения: amount 0.2..0.6
 * возвращает воспринимаемую резкость без заметных ореолов.
 */
export function sharpenFrame(
  src: Frame,
  amount = 0.5,
  radius = 1,
  signal?: AbortSignal,
): Frame {
  assertFrame(src, 'sharpen');
  if (!(amount >= 0 && amount <= 5)) {
    throw new InvalidOptionsError(`sharpen: amount must be in [0, 5], got ${amount}`);
  }
  if (!Number.isInteger(radius) || radius < 1 || radius > 8) {
    throw new InvalidOptionsError(`sharpen: radius must be an integer in [1, 8], got ${radius}`);
  }
  if (amount === 0) return cloneFrame(src);
  throwIfAborted(signal);
  const blurred = boxBlurPremultiplied(src, radius, signal);
  const out = cloneFrame(src);
  const d = out.data;
  for (let i = 0; i < d.length; i += 4) {
    // Полностью прозрачный пиксель не виден: его скрытый RGB не трогаем,
    // а в размытии соседей он уже участвовал с нулевым premultiplied-вкладом.
    if (d[i + 3] === 0) continue;
    const blurredAlpha = blurred[i + 3];
    if (blurredAlpha <= 0.5) continue;
    for (let c = 0; c < 3; c++) {
      const blurredStraight = (blurred[i + c] * 255) / blurredAlpha;
      d[i + c] = Math.max(
        0,
        Math.min(255, d[i + c] + amount * (d[i + c] - blurredStraight)),
      );
    }
  }
  return out;
}

/** Обесцветить кадр (ITU-R BT.709 luma), альфа сохраняется. */
export function toGrayscale(frame: Frame): Frame {
  const out = cloneFrame(frame);
  const d = out.data;
  for (let i = 0; i < d.length; i += 4) {
    const y = Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]);
    d[i] = y;
    d[i + 1] = y;
    d[i + 2] = y;
  }
  return out;
}

/** Центральный кроп кадра до dstW × dstH (кадр должен быть не меньше). */
function cropCenter(src: Frame, dstW: number, dstH: number): Frame {
  assertFrame(src, 'crop');
  if (dstW > src.width || dstH > src.height) {
    throw new InvalidOptionsError(
      `crop: target ${dstW}x${dstH} is larger than frame ${src.width}x${src.height}`,
    );
  }
  if (dstW === src.width && dstH === src.height) return cloneFrame(src);
  const ox = Math.floor((src.width - dstW) / 2);
  const oy = Math.floor((src.height - dstH) / 2);
  const out = new Uint8ClampedArray(dstW * dstH * 4);
  for (let y = 0; y < dstH; y++) {
    const srcOff = ((y + oy) * src.width + ox) * 4;
    out.set(src.data.subarray(srcOff, srcOff + dstW * 4), y * dstW * 4);
  }
  return { data: out, width: dstW, height: dstH };
}

/**
 * Ступень геометрии.
 * cover:   меньшая (в относительном смысле) сторона дотягивается до целевой,
 *          большая режется по центру. Результат ровно width × height.
 * contain: кадр вписывается целиком; результат ≤ width × height, пропорции целы.
 * Масштабирование вверх разрешено (контракт: «сторона дотягивается до целевой»).
 */
export function applyFrameGeometry(
  src: Frame,
  options: FrameOptions,
  signal?: AbortSignal,
): Frame {
  assertFrame(src, 'frame');
  throwIfAborted(signal);
  const { width: tw, height: th } = options;
  const fit = options.fit ?? 'cover';
  const method = options.method ?? 'bilinear';
  if (!Number.isInteger(tw) || !Number.isInteger(th) || tw <= 0 || th <= 0) {
    throw new InvalidOptionsError(
      `frame: width/height must be positive integers, got ${tw}x${th}`,
    );
  }
  if (method !== 'bilinear' && method !== 'lanczos3' && method !== 'area') {
    throw new InvalidOptionsError(`frame: unknown resize method "${String(method)}"`);
  }
  if (fit === 'cover') {
    const scale = Math.max(tw / src.width, th / src.height);
    const scaledW = Math.max(tw, Math.round(src.width * scale));
    const scaledH = Math.max(th, Math.round(src.height * scale));
    const scaled = resizeByMethod(src, scaledW, scaledH, method, signal);
    return cropCenter(scaled, tw, th);
  }
  // contain
  const scale = Math.min(tw / src.width, th / src.height);
  const scaledW = Math.max(1, Math.round(src.width * scale));
  const scaledH = Math.max(1, Math.round(src.height * scale));
  return resizeByMethod(src, scaledW, scaledH, method, signal);
}

/**
 * Дешёвая проба цветности кадра: средний разброс каналов (max-min)/255
 * по подвыборке (не более ~4096 пикселей). Используется fit'ом:
 * почти-монохромный кадр (манга, скриншоты, документы) — кандидат на
 * ранний grayscale.
 *
 * Почему не HSL-насыщенность: у почти белых/чёрных пикселей HSL-S
 * взрывается даже при разбросе каналов в 2/255 (бумага скана с лёгким
 * оттенком дала бы S≈0.11). Абсолютный разброс каналов такой ловушки
 * не имеет и прямо отвечает на вопрос «много ли в кадре цвета».
 */
export function probeSaturation(frame: Frame): number {
  assertFrame(frame, 'probeSaturation');
  const total = frame.width * frame.height;
  const stride = Math.max(1, Math.floor(total / 4096));
  let sum = 0;
  let count = 0;
  const d = frame.data;
  for (let p = 0; p < total; p += stride) {
    const i = p * 4;
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    const max = r > g ? (r > b ? r : b) : (g > b ? g : b);
    const min = r < g ? (r < b ? r : b) : (g < b ? g : b);
    sum += (max - min) / 255;
    count++;
  }
  return count === 0 ? 0 : sum / count;
}

/**
 * Порог «почти монохромный»: средний разброс каналов ≤ ~10/255.
 * Сканы и скриншоты с оттенком бумаги/шумом сенсора сюда попадают,
 * цветное фото — нет.
 */
export const MONOCHROME_SATURATION_THRESHOLD = 0.04;

export interface FrameAnalysisOptions {
  /** Максимум sampled-пикселей. По умолчанию 4096 — как у внутренней пробы fit. */
  maxSamples?: number;
  /** Необязательная отмена долгого анализа очень большого кадра. */
  signal?: AbortSignal;
}

export interface FrameAnalysis {
  /** Средний абсолютный разброс RGB-каналов видимых пикселей, 0..1. */
  saturation: number;
  /** saturation <= MONOCHROME_SATURATION_THRESHOLD. */
  nearMonochrome: boolean;
  /** Средняя BT.709 яркость видимых пикселей, 0..255. */
  meanLuma: number;
  /** Доля sampled-пикселей с alpha > 0, 0..1. */
  alphaCoverage: number;
  /** Средняя альфа sampled-пикселей, 0..255. */
  meanAlpha: number;
  /** Сколько пикселей реально попало в выборку. */
  sampledPixels: number;
  /** Сколько sampled-пикселей видимы (alpha > 0). */
  visibleSampledPixels: number;
  /**
   * Число занятых 5-битных RGB-корзин видимой выборки (0..32768).
   * Это приближённый индикатор разнообразия цветов, а не точное число цветов.
   */
  colorBuckets5Bit: number;
  /** colorBuckets5Bit / 32768. */
  colorBucketRatio: number;
}

/**
 * Чистый дешёвый анализ кадра по ограниченной детерминированной выборке.
 *
 * Полностью прозрачные пиксели исключаются из насыщенности, яркости и
 * цветовых корзин: их скрытый RGB не виден и не должен делать прозрачный
 * кадр «цветным». Никаких автоматических решений о формате/пресете
 * функция не принимает — она только измеряет.
 */
export function analyzeFrame(frame: Frame, options: FrameAnalysisOptions = {}): FrameAnalysis {
  assertFrame(frame, 'analyzeFrame');
  throwIfAborted(options.signal);
  const maxSamples = options.maxSamples ?? 4096;
  if (!Number.isInteger(maxSamples) || maxSamples <= 0) {
    throw new InvalidOptionsError(
      `analyzeFrame: maxSamples must be a positive integer, got ${maxSamples}`,
    );
  }
  const total = frame.width * frame.height;
  const stride = Math.max(1, Math.ceil(total / maxSamples));
  const d = frame.data;
  const buckets = new Set<number>();
  let sampledPixels = 0;
  let visibleSampledPixels = 0;
  let saturationSum = 0;
  let lumaSum = 0;
  let alphaSum = 0;

  for (let p = 0; p < total; p += stride) {
    if ((sampledPixels & 1023) === 0) throwIfAborted(options.signal);
    const i = p * 4;
    const a = d[i + 3];
    sampledPixels++;
    alphaSum += a;
    if (a === 0) continue;
    visibleSampledPixels++;
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    const max = r > g ? (r > b ? r : b) : (g > b ? g : b);
    const min = r < g ? (r < b ? r : b) : (g < b ? g : b);
    saturationSum += (max - min) / 255;
    lumaSum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
    buckets.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
  }

  const saturation = visibleSampledPixels === 0 ? 0 : saturationSum / visibleSampledPixels;
  return {
    saturation,
    nearMonochrome: saturation <= MONOCHROME_SATURATION_THRESHOLD,
    meanLuma: visibleSampledPixels === 0 ? 0 : lumaSum / visibleSampledPixels,
    alphaCoverage: sampledPixels === 0 ? 0 : visibleSampledPixels / sampledPixels,
    meanAlpha: sampledPixels === 0 ? 0 : alphaSum / sampledPixels,
    sampledPixels,
    visibleSampledPixels,
    colorBuckets5Bit: buckets.size,
    colorBucketRatio: buckets.size / 32768,
  };
}

/**
 * Frame → ImageData для кодеков, ждущих ImageData (@jsquash/*).
 * Вне браузера (Node-тесты с реальными wasm-кодеками) возвращает
 * структурный объект { data, width, height } — jsquash читает только поля.
 */
export function frameToImageData(frame: Frame): ImageData {
  assertFrame(frame, 'frameToImageData');
  if (typeof ImageData === 'function') {
    // ImageData требует именно Uint8ClampedArray нужной длины — у нас он есть,
    // но конструктор не копирует: делаем копию, чтобы кодек не мутировал кадр.
    return new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height);
  }
  return {
    data: new Uint8ClampedArray(frame.data),
    width: frame.width,
    height: frame.height,
    colorSpace: 'srgb',
  } as ImageData;
}

export function imageDataToFrame(imageData: {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}): Frame {
  return {
    data: new Uint8ClampedArray(imageData.data),
    width: imageData.width,
    height: imageData.height,
  };
}
