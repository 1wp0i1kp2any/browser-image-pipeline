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

/**
 * Таблица alpha/255 для всех байтовых значений альфы.
 * Значения побитово равны делению `a / 255` (та же операция при заполнении),
 * но в горячих циклах свёртки деление на каждый тап заменяется чтением.
 */
const ALPHA_NORM = new Float64Array(256);
for (let i = 0; i < 256; i++) ALPHA_NORM[i] = i / 255;

/**
 * Проверить, что аллокация типизированного массива вообще возможна.
 *
 * @param length - число элементов будущего массива.
 * @param where - контекст операции для текста ошибки.
 * @throws InvalidOptionsError, если length не безопасное целое в пределах
 *   максимальной длины типизированного массива.
 */
function assertAllocationLength(length: number, where: string): void {
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_TYPED_ARRAY_LENGTH) {
    throw new InvalidOptionsError(
      `${where}: allocation too large (${length})`,
    );
  }
}

/**
 * Проверить структурную валидность кадра: положительные целые размеры
 * и data.length === width*height*4.
 *
 * @param frame - проверяемый кадр.
 * @param where - имя операции для текста ошибки.
 * @throws InvalidOptionsError при любом несоответствии.
 */
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
      `${where}: invalid frame (data.length !== width*height*4)`,
    );
  }
}

/**
 * Глубокая копия кадра (пиксели копируются в новый буфер).
 *
 * @param frame - исходный кадр; не изменяется.
 * @returns независимый кадр тех же размеров и пикселей.
 */
export function cloneFrame(frame: Frame): Frame {
  return {
    data: new Uint8ClampedArray(frame.data),
    width: frame.width,
    height: frame.height,
  };
}

/**
 * Проверить целевой размер ресайза и возможность его аллокации.
 *
 * @param dstW - целевая ширина в пикселях, положительное целое.
 * @param dstH - целевая высота в пикселях, положительное целое.
 * @throws InvalidOptionsError при невалидном размере или переполнении.
 */
function assertResizeTarget(dstW: number, dstH: number): void {
  if (!Number.isInteger(dstW) || !Number.isInteger(dstH) || dstW <= 0 || dstH <= 0) {
    throw new InvalidOptionsError(
      `resize: target must be positive integers, got ${dstW}x${dstH}`,
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
 *
 * @param src - исходный кадр.
 * @param dstW - целевая ширина, положительное целое.
 * @param dstH - целевая высота, положительное целое.
 * @param signal - необязательная отмена (проверяется каждые 32 строки).
 * @returns новый кадр dstW × dstH (копия, если размеры совпали).
 * @throws InvalidOptionsError при невалидном кадре/цели.
 * @throws AbortError при отмене.
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

  // Проекция по X одинакова для всех строк — считаем один раз
  // (те же формулы и те же double-значения, что прежний попиксельный расчёт).
  const x0s = new Int32Array(dstW);
  const x1s = new Int32Array(dstW);
  const fxs = new Float64Array(dstW);
  for (let x = 0; x < dstW; x++) {
    const srcX = Math.min(Math.max((x + 0.5) * xRatio - 0.5, 0), sw - 1);
    const x0 = Math.floor(srcX);
    x0s[x] = x0;
    x1s[x] = Math.min(x0 + 1, sw - 1);
    fxs[x] = srcX - x0;
  }

  for (let y = 0; y < dstH; y++) {
    if ((y & 31) === 0) throwIfAborted(signal);
    const srcY = Math.min(Math.max((y + 0.5) * yRatio - 0.5, 0), sh - 1);
    const y0 = Math.floor(srcY);
    const y1 = Math.min(y0 + 1, sh - 1);
    const fy = srcY - y0;
    const row0 = y0 * sw * 4;
    const row1 = y1 * sw * 4;
    const outRow = y * dstW * 4;
    for (let x = 0; x < dstW; x++) {
      const x0 = x0s[x];
      const x1 = x1s[x];
      const fx = fxs[x];

      const i00 = row0 + x0 * 4;
      const i10 = row0 + x1 * 4;
      const i01 = row1 + x0 * 4;
      const i11 = row1 + x1 * 4;
      const o = outRow + x * 4;

      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      const a00 = ALPHA_NORM[s[i00 + 3]];
      r += s[i00] * a00 * w00;
      g += s[i00 + 1] * a00 * w00;
      b += s[i00 + 2] * a00 * w00;
      a += s[i00 + 3] * w00;

      const a10 = ALPHA_NORM[s[i10 + 3]];
      r += s[i10] * a10 * w10;
      g += s[i10 + 1] * a10 * w10;
      b += s[i10 + 2] * a10 * w10;
      a += s[i10 + 3] * w10;

      const a01 = ALPHA_NORM[s[i01 + 3]];
      r += s[i01] * a01 * w01;
      g += s[i01 + 1] * a01 * w01;
      b += s[i01 + 2] * a01 * w01;
      a += s[i01 + 3] * w01;

      const a11 = ALPHA_NORM[s[i11 + 3]];
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

/**
 * Нормированный sinc: sin(πx)/(πx), sinc(0)=1.
 *
 * @param x - аргумент в единицах исходных пикселей.
 * @returns значение ядра.
 */
function sinc(x: number): number {
  if (x === 0) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

const LANCZOS_A = 3;
const lanczosKernel: KernelFn = (x) =>
  Math.abs(x) >= LANCZOS_A ? 0 : sinc(x) * sinc(x / LANCZOS_A);
interface AxisPlan {
  // Для каждого выходного пикселя: начальный индекс входного окна и
  // отрезок [offsets[d], offsets[d+1]) в общем упакованном массиве весов.
  // Один contiguous Float32Array вместо массива из dstLen отдельных
  // Float32Array: меньше аллокаций и лучше локальность кэша в свёртке
  // (тот же приём packed-фильтров, что в pica, но без fixed-point —
  // значения весов сохраняются побитово).
  starts: Int32Array;
  offsets: Int32Array;
  weights: Float32Array; // веса уже нормированы (сумма по окну = 1)
}

/**
 * Упаковать построчные веса оси в contiguous-план, срезав точные нули по краям окон.
 *
 * @param starts - стартовые индексы окон по выходным пикселям (мутируется
 *   на величину срезанных слева нулей).
 * @param rows - нормированные веса окон по выходным пикселям.
 * @returns план с offsets в единый Float32Array весов.
 */
function packAxisPlan(starts: Int32Array, rows: Float32Array[]): AxisPlan {
  const offsets = new Int32Array(rows.length + 1);
  let total = 0;
  for (let d = 0; d < rows.length; d++) {
    const w = rows[d];
    let from = 0;
    let to = w.length - 1;
    // Точные нули по краям окна вклада не дают (x + 0 === x) — их срезание
    // не меняет результат, но укорачивает свёртку на выровненных масштабах.
    while (from < to && w[from] === 0) from++;
    while (to > from && w[to] === 0) to--;
    starts[d] += from;
    rows[d] = w.subarray(from, to + 1);
    offsets[d] = total;
    total += to - from + 1;
  }
  offsets[rows.length] = total;
  const weights = new Float32Array(total);
  for (let d = 0; d < rows.length; d++) weights.set(rows[d], offsets[d]);
  return { starts, offsets, weights };
}

type AxisPlanner = (srcLen: number, dstLen: number) => AxisPlan;

/**
 * План оси для ядерного ресемплинга (Lanczos3): окно растёт с масштабом.
 *
 * @param srcLen - длина исходной оси в пикселях.
 * @param dstLen - длина целевой оси в пикселях.
 * @param kernel - ядро фильтра (значение по нормированному смещению).
 * @param radius - радиус ядра при масштабе 1 (support = radius × max(1, scale)).
 * @returns упакованный план с нормированными весами окон.
 */
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
  return packAxisPlan(starts, weights);
}

/**
 * Точный area-план одной оси.
 *
 * Исходный пиксель s занимает интервал [s, s+1), выходной d —
 * [d*scale, (d+1)*scale). Вес равен длине пересечения интервалов,
 * делённой на scale. Это честное интегрирование по площади, а не
 * точечная выборка box-ядра в центрах пикселей: постоянный сигнал
 * сохраняется при любом дробном масштабе, включая upscale.
 *
 * @param srcLen - длина исходной оси в пикселях.
 * @param dstLen - длина целевой оси в пикселях.
 * @returns упакованный план с весами-площадями пересечений.
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
  return packAxisPlan(starts, weights);
}

/**
 * Сепарабельный ресемплинг двумя проходами (горизонталь → вертикаль)
 * в premultiplied-альфе по планам осей от planner.
 *
 * @param src - исходный кадр.
 * @param dstW - целевая ширина.
 * @param dstH - целевая высота.
 * @param planner - построитель плана одной оси (kernel или area).
 * @param signal - необязательная отмена (проверяется каждые 32 строки).
 * @returns новый кадр dstW × dstH (копия, если размеры совпали).
 */
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
  const weightsX = planX.weights;
  for (let y = 0; y < src.height; y++) {
    if ((y & 31) === 0) throwIfAborted(signal);
    const srcRow = y * src.width * 4;
    const tmpRow = y * dstW * 4;
    for (let x = 0; x < dstW; x++) {
      const from = planX.starts[x];
      const wFrom = planX.offsets[x];
      const wTo = planX.offsets[x + 1];
      let r = 0, g = 0, b = 0, a = 0;
      let idx = srcRow + from * 4;
      for (let k = wFrom; k < wTo; k++, idx += 4) {
        const alpha = ALPHA_NORM[s[idx + 3]];
        const wi = weightsX[k];
        r += s[idx] * alpha * wi;
        g += s[idx + 1] * alpha * wi;
        b += s[idx + 2] * alpha * wi;
        a += s[idx + 3] * wi;
      }
      const o = tmpRow + x * 4;
      tmp[o] = r; tmp[o + 1] = g; tmp[o + 2] = b; tmp[o + 3] = a;
    }
  }

  // Вертикальный проход + распремножение. Накопление — в локальных
  // переменных по пикселям (регистры), индекс тапа инкрементируется на
  // длину строки вместо прежнего умножения на каждый тап. Плоский
  // построчный аккумулятор Float64 замерялся и проиграл на upscale:
  // трафик чтения/записи аккумулятора дороже столбцовых чтений tmp.
  const out = new Uint8ClampedArray(dstW * dstH * 4);
  const weightsY = planY.weights;
  const rowLength = dstW * 4;
  for (let y = 0; y < dstH; y++) {
    if ((y & 31) === 0) throwIfAborted(signal);
    const from = planY.starts[y];
    const wFrom = planY.offsets[y];
    const wTo = planY.offsets[y + 1];
    const firstTapBase = from * rowLength;
    const outRow = y * rowLength;
    for (let x = 0; x < dstW; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      let idx = firstTapBase + x * 4;
      for (let k = wFrom; k < wTo; k++, idx += rowLength) {
        const wi = weightsY[k];
        r += tmp[idx] * wi;
        g += tmp[idx + 1] * wi;
        b += tmp[idx + 2] * wi;
        a += tmp[idx + 3] * wi;
      }
      const o = outRow + x * 4;
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

/**
 * Lanczos3-ресемплинг: самый резкий даунскейл фото (выбор Squoosh/Sharp).
 *
 * @param src - исходный кадр.
 * @param dstW - целевая ширина.
 * @param dstH - целевая высота.
 * @param signal - необязательная отмена.
 * @returns новый кадр dstW × dstH.
 */
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

/**
 * Area-ресемплинг: точное усреднение по площади; лучше всех гасит муар при сильном уменьшении.
 *
 * @param src - исходный кадр.
 * @param dstW - целевая ширина.
 * @param dstH - целевая высота.
 * @param signal - необязательная отмена.
 * @returns новый кадр dstW × dstH.
 */
export function resizeArea(
  src: Frame,
  dstW: number,
  dstH: number,
  signal?: AbortSignal,
): Frame {
  return resizeSeparable(src, dstW, dstH, planAreaAxis, signal);
}

/**
 * Диспетчер метода ресайза ступени геометрии.
 *
 * @param src - исходный кадр.
 * @param dstW - целевая ширина.
 * @param dstH - целевая высота.
 * @param method - 'bilinear' | 'lanczos3' | 'area'.
 * @param signal - необязательная отмена.
 * @returns новый кадр dstW × dstH выбранным методом.
 */
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

/**
 * Быстрое сепарабельное box-размытие premultiplied RGBA (sliding window), float на выходе.
 *
 * Оба прохода идут построчно и сразу по четырём каналам: прежняя схема
 * «канал внешним циклом» четырежды перечитывала каждую строку со шагом 4.
 * Вертикаль держит скользящую сумму целой строкой (Float64-аккумулятор),
 * поэтому порядок суммирования по окну для каждого элемента и все
 * промежуточные значения совпадают с поканальной версией побитово.
 *
 * @param src - исходный кадр.
 * @param radius - радиус окна размытия в пикселях (окно 2*radius+1).
 * @param signal - необязательная отмена (проверяется каждые 32 строки).
 * @returns premultiplied RGBA float-буфер после двух проходов.
 */
function boxBlurPremultiplied(src: Frame, radius: number, signal?: AbortSignal): Float32Array {
  const { width: w, height: h, data: s } = src;
  const premultiplied = new Float32Array(s.length);
  for (let i = 0; i < s.length; i += 4) {
    const alpha = ALPHA_NORM[s[i + 3]];
    premultiplied[i] = s[i] * alpha;
    premultiplied[i + 1] = s[i + 1] * alpha;
    premultiplied[i + 2] = s[i + 2] * alpha;
    premultiplied[i + 3] = s[i + 3];
  }

  const tmp = new Float32Array(s.length);
  const out = new Float32Array(s.length);
  const win = radius * 2 + 1;
  const rowLength = w * 4;
  // Горизонталь: одно скользящее окно на строку, 4 аккумулятора по каналам.
  for (let y = 0; y < h; y++) {
    if ((y & 31) === 0) throwIfAborted(signal);
    const row = y * rowLength;
    let acc0 = 0, acc1 = 0, acc2 = 0, acc3 = 0;
    for (let x = -radius; x <= radius; x++) {
      const idx = row + Math.max(0, Math.min(w - 1, x)) * 4;
      acc0 += premultiplied[idx];
      acc1 += premultiplied[idx + 1];
      acc2 += premultiplied[idx + 2];
      acc3 += premultiplied[idx + 3];
    }
    for (let x = 0; x < w; x++) {
      const o = row + x * 4;
      tmp[o] = acc0 / win;
      tmp[o + 1] = acc1 / win;
      tmp[o + 2] = acc2 / win;
      tmp[o + 3] = acc3 / win;
      const sub = row + Math.max(0, x - radius) * 4;
      const add = row + Math.min(w - 1, x + radius + 1) * 4;
      acc0 += premultiplied[add] - premultiplied[sub];
      acc1 += premultiplied[add + 1] - premultiplied[sub + 1];
      acc2 += premultiplied[add + 2] - premultiplied[sub + 2];
      acc3 += premultiplied[add + 3] - premultiplied[sub + 3];
    }
  }
  // Вертикаль: скользящая сумма — целая строка, плоские последовательные проходы.
  const accRow = new Float64Array(rowLength);
  for (let y = -radius; y <= radius; y++) {
    const rowBase = Math.max(0, Math.min(h - 1, y)) * rowLength;
    for (let j = 0; j < rowLength; j++) accRow[j] += tmp[rowBase + j];
  }
  for (let y = 0; y < h; y++) {
    if ((y & 31) === 0) throwIfAborted(signal);
    const rowBase = y * rowLength;
    for (let j = 0; j < rowLength; j++) out[rowBase + j] = accRow[j] / win;
    const subBase = Math.max(0, y - radius) * rowLength;
    const addBase = Math.min(h - 1, y + radius + 1) * rowLength;
    for (let j = 0; j < rowLength; j++) {
      accRow[j] += tmp[addBase + j] - tmp[subBase + j];
    }
  }
  return out;
}

/**
 * Unsharp mask: out = src + amount * (src - blur(src)). Альфа не трогается.
 * Классический «output sharpening» после уменьшения: amount 0.2..0.6
 * возвращает воспринимаемую резкость без заметных ореолов.
 *
 * @param src - исходный кадр.
 * @param amount - сила шарпа 0..5; 0 — копия без изменений. По умолчанию 0.5.
 * @param radius - радиус box-размытия маски, целое 1..8. По умолчанию 1.
 * @param signal - необязательная отмена (проверяется каждые 32 строки).
 * @returns новый кадр с повышенной резкостью; альфа не меняется.
 * @throws InvalidOptionsError при amount/radius вне диапазонов.
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
    throw new InvalidOptionsError(`sharpen: radius must be integer in [1, 8], got ${radius}`);
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

/**
 * Обесцветить кадр (ITU-R BT.709 luma), альфа сохраняется.
 *
 * @param frame - исходный кадр; не изменяется.
 * @returns новый кадр с R=G=B=luma.
 */
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

/**
 * Центральный кроп кадра до dstW × dstH (кадр должен быть не меньше).
 *
 * @param src - исходный кадр.
 * @param dstW - ширина окна кропа.
 * @param dstH - высота окна кропа.
 * @returns новый кадр центральной области.
 * @throws InvalidOptionsError, если окно больше кадра.
 */
function cropCenter(src: Frame, dstW: number, dstH: number): Frame {
  assertFrame(src, 'crop');
  if (dstW > src.width || dstH > src.height) {
    throw new InvalidOptionsError(
      `crop: target ${dstW}x${dstH} exceeds frame ${src.width}x${src.height}`,
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
 *
 * @param src - исходный кадр.
 * @param options - целевые ширина/высота, fit ('cover' по умолчанию),
 *   method ('bilinear' по умолчанию).
 * @param signal - необязательная отмена.
 * @returns новый кадр: ровно width × height при cover, ≤ при contain.
 * @throws InvalidOptionsError при невалидных размерах/методе.
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
      `frame: size must be positive integers, got ${tw}x${th}`,
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
 *
 * @param frame - анализируемый кадр.
 * @returns средняя насыщенность выборки 0..1.
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

/** Опции анализа кадра: объём выборки и отмена. */
export interface FrameAnalysisOptions {
  /** Максимум sampled-пикселей. По умолчанию 4096 — как у внутренней пробы fit. */
  maxSamples?: number;
  /** Необязательная отмена долгого анализа очень большого кадра. */
  signal?: AbortSignal;
}

/** Результат analyzeFrame: измерения кадра по статистической выборке. */
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
 *
 * @param frame - анализируемый кадр.
 * @param options - maxSamples: предел выборки (по умолчанию 4096);
 *   signal: необязательная отмена.
 * @returns насыщенность, nearMonochrome, средняя яркость/альфа, покрытие
 *   альфы и индикатор разнообразия цветов по 5-битным корзинам.
 * @throws InvalidOptionsError при maxSamples не положительном целом.
 */
export function analyzeFrame(frame: Frame, options: FrameAnalysisOptions = {}): FrameAnalysis {
  assertFrame(frame, 'analyzeFrame');
  throwIfAborted(options.signal);
  const maxSamples = options.maxSamples ?? 4096;
  if (!Number.isInteger(maxSamples) || maxSamples <= 0) {
    throw new InvalidOptionsError(
      `analyzeFrame: maxSamples must be positive integer, got ${maxSamples}`,
    );
  }
  const total = frame.width * frame.height;
  const stride = Math.max(1, Math.ceil(total / maxSamples));
  const d = frame.data;
  // Занятые 5-битные корзины отмечаем битовой картой 32768 бит (4 KiB):
  // Set на каждую выборку аллоцировал объект на корзину и хэшировал ключи.
  const bucketWords = new Uint32Array(1024);
  let bucketCount = 0;
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
    const bucket = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const word = bucket >> 5;
    const bit = 1 << (bucket & 31);
    if ((bucketWords[word] & bit) === 0) {
      bucketWords[word] |= bit;
      bucketCount++;
    }
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
    colorBuckets5Bit: bucketCount,
    colorBucketRatio: bucketCount / 32768,
  };
}

/**
 * Frame → ImageData для кодеков, ждущих ImageData (@jsquash/*).
 * Вне браузера (Node-тесты с реальными wasm-кодеками) возвращает
 * структурный объект { data, width, height } — jsquash читает только поля.
 *
 * @param frame - кадр; данные копируются (результат можно мутировать).
 * @returns ImageData с копией пикселей кадра.
 */
export function frameToImageData(frame: Frame): ImageData {
  assertFrame(frame, 'frameToImageData');
  // Конструктор ImageData не копирует: копия — чтобы вызывающий/кодек
  // не мог мутировать исходный кадр через результат.
  return toImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height);
}

/**
 * Собрать настоящий ImageData или структурный объект для сред без него.
 *
 * @param data - пиксели RGBA точной длины (владение — у результата).
 * @param width - ширина в пикселях.
 * @param height - высота в пикселях.
 * @returns ImageData поверх переданных данных (БЕЗ копии).
 */
function toImageData(data: Uint8ClampedArray, width: number, height: number): ImageData {
  if (typeof ImageData === 'function') {
    // Кадры библиотеки никогда не лежат в SharedArrayBuffer (все буферы
    // создаются обычными конструкторами типизированных массивов).
    return new ImageData(data as Uint8ClampedArray<ArrayBuffer>, width, height);
  }
  return { data, width, height, colorSpace: 'srgb' } as ImageData;
}

/**
 * Данные с точным буфером: исходный массив, если он уже покрывает свой
 * буфер целиком без смещения, иначе копия в точный буфер. Часть
 * @jsquash-обёрток читает `data.buffer` целиком, игнорируя byteOffset.
 *
 * @param data - пиксели RGBA (возможно, view в больший буфер).
 * @returns массив, чей buffer содержит ровно эти пиксели.
 */
function exactBufferData(data: Uint8ClampedArray): Uint8ClampedArray {
  return data instanceof Uint8ClampedArray &&
    data.byteOffset === 0 &&
    data.buffer.byteLength === data.byteLength
    ? data
    : new Uint8ClampedArray(data);
}

/**
 * ImageData → Frame с копией пикселей: результат независим от входа.
 *
 * @param imageData - объект с data/width/height (настоящий ImageData или структурный).
 * @returns новый кадр с копией данных.
 */
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

/**
 * ВНУТРЕННЯЯ конверсия Frame → ImageData для встроенных wasm-кодеков
 * (@jsquash/*) без копии пикселей.
 *
 * Почему без копии безопасно именно здесь: wasm-код не имеет доступа к
 * JS-памяти типизированного массива — Emscripten/wasm-bindgen при вызове
 * копируют вход в свою heap, поэтому мутировать исходный кадр кодек не
 * может физически. Публичный frameToImageData копию сохраняет: его
 * вызывающий вправе делать с результатом что угодно.
 *
 * Нормализация нужна только для view со смещением/лишним хвостом буфера:
 * часть @jsquash-обёрток читает `data.data.buffer` целиком, игнорируя
 * byteOffset, поэтому такой view один раз копируется в точный буфер.
 *
 * @param frame - кадр; при точном буфере пиксели НЕ копируются.
 * @returns ImageData поверх тех же данных (или нормализованной копии).
 */
export function frameToCodecImageData(frame: Frame): ImageData {
  assertFrame(frame, 'frameToCodecImageData');
  return toImageData(exactBufferData(frame.data), frame.width, frame.height);
}

/**
 * ВНУТРЕННЯЯ конверсия свежесозданного декодером ImageData → Frame без копии.
 *
 * Применима только когда ImageData создан самим декодером на этот вызов
 * (canvas getImageData, результат @jsquash decode) и больше никем не
 * удерживается: владение буфером переходит кадру. View со смещением,
 * лишним хвостом или не-Uint8ClampedArray данными нормализуется копией.
 *
 * @param imageData - свежий ImageData декодера, владение переходит кадру.
 * @returns кадр поверх тех же данных (или нормализованной копии).
 * @throws InvalidOptionsError, если размеры/данные не образуют валидный кадр.
 */
export function frameFromOwnedImageData(imageData: {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}): Frame {
  const frame: Frame = {
    data: exactBufferData(imageData.data),
    width: imageData.width,
    height: imageData.height,
  };
  assertFrame(frame, 'frameFromOwnedImageData');
  return frame;
}
