// Объективные метрики искажения «кадр A против кадра B».
//
// Зачем: «сжать, сохранив качество» без чисел — вкусовщина. PSNR/SSIM дают
// вызывающему (и демо) измеримую цену каждого набора параметров и позволяют
// строить предикаты вида «вес ≤ X И SSIM ≥ 0.97» снаружи библиотеки.
// Метрики — чистые функции поверх Frame, в конвейер не вшиты.
//
// SSIM здесь — блочная аппроксимация: стандартные константы C1/C2, статистика
// по неперекрывающимся блокам 8×8 по яркости (BT.709 luma), усреднение по
// блокам. Это не эталонный гауссов SSIM из статьи Wang et al., но для
// сравнения вариантов сжатия одного кадра монотонность и масштаб те же;
// честно называем вещи своими именами в документации.

import type { Frame } from './types.js';
import { InvalidOptionsError, throwIfAborted } from './errors.js';
import { assertFrame } from './frame.js';

/** Набор базовых RGB-метрик compareFrames. */
export interface FrameMetrics {
  /** Peak Signal-to-Noise Ratio, дБ. Infinity — кадры идентичны. */
  psnr: number;
  /** Блочная luma-аппроксимация SSIM (не эталонный Gaussian SSIM), 0..1. */
  ssim: number;
  /** Средняя абсолютная ошибка по каналам RGB, 0..255. */
  mae: number;
}

/** Опции метрик: только отмена длинных циклов по пикселям. */
export interface MetricOptions {
  /** Проверяется периодически в длинных циклах метрик. */
  signal?: AbortSignal;
}

/**
 * Проверить, что два кадра валидны и одинаковых размеров.
 *
 * @param a - первый кадр.
 * @param b - второй кадр.
 * @param where - имя метрики для текста ошибки.
 * @throws InvalidOptionsError при невалидном кадре или разных размерах.
 */
function checkPair(a: Frame, b: Frame, where: string): void {
  assertFrame(a, where);
  assertFrame(b, where);
  if (a.width !== b.width || a.height !== b.height) {
    throw new InvalidOptionsError(
      `${where}: frames must have identical dimensions, got ${a.width}x${a.height} vs ${b.width}x${b.height}`,
    );
  }
}

/**
 * PSNR по RGB (альфа не участвует).
 *
 * @param a - эталонный кадр.
 * @param b - сравниваемый кадр тех же размеров.
 * @param options - signal: необязательная отмена длинного цикла.
 * @returns PSNR в дБ; Infinity, если кадры побитово равны по RGB.
 */
export function computePSNR(a: Frame, b: Frame, options: MetricOptions = {}): number {
  checkPair(a, b, 'computePSNR');
  throwIfAborted(options.signal);
  let se = 0;
  const da = a.data;
  const db = b.data;
  for (let i = 0; i < da.length; i += 4) {
    if ((i & 262143) === 0) throwIfAborted(options.signal);
    const dr = da[i] - db[i];
    const dg = da[i + 1] - db[i + 1];
    const db2 = da[i + 2] - db[i + 2];
    se += dr * dr + dg * dg + db2 * db2;
  }
  const mse = se / (a.width * a.height * 3);
  if (mse === 0) return Infinity;
  return 10 * Math.log10((255 * 255) / mse);
}

/**
 * Яркость BT.709 пикселя по смещению в RGBA-буфере.
 *
 * @param data - RGBA-буфер кадра.
 * @param i - байтовое смещение пикселя (кратно 4).
 * @returns luma 0..255 (float).
 */
function lumaAt(data: Uint8ClampedArray, i: number): number {
  return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
}

/**
 * Блочная luma-аппроксимация SSIM (блоки 8×8, константы K1=0.01, K2=0.03).
 *
 * @param a - эталонный кадр.
 * @param b - сравниваемый кадр тех же размеров.
 * @param options - signal: необязательная отмена.
 * @returns среднее SSIM по блокам, обычно 0..1 (1 — идентичные кадры).
 */
export function computeSSIM(a: Frame, b: Frame, options: MetricOptions = {}): number {
  checkPair(a, b, 'computeSSIM');
  throwIfAborted(options.signal);
  const { width: w, height: h } = a;
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  const BLOCK = 8;
  let sum = 0;
  let blocks = 0;
  // Яркости блока считаются один раз и переиспользуются вторым проходом:
  // прежняя версия дважды вычисляла luma каждого пикселя. Порядок
  // суммирования тот же, значения те же — результат побитово совпадает.
  const lumaA = new Float64Array(BLOCK * BLOCK);
  const lumaB = new Float64Array(BLOCK * BLOCK);
  for (let by = 0; by < h; by += BLOCK) {
    if ((by & 255) === 0) throwIfAborted(options.signal);
    for (let bx = 0; bx < w; bx += BLOCK) {
      const bw = Math.min(BLOCK, w - bx);
      const bh = Math.min(BLOCK, h - by);
      const n = bw * bh;
      let ma = 0;
      let mb = 0;
      let k = 0;
      for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) {
          const i = ((by + y) * w + (bx + x)) * 4;
          const la = lumaAt(a.data, i);
          const lb = lumaAt(b.data, i);
          lumaA[k] = la;
          lumaB[k] = lb;
          k++;
          ma += la;
          mb += lb;
        }
      }
      ma /= n;
      mb /= n;
      let va = 0;
      let vb = 0;
      let cov = 0;
      for (let j = 0; j < n; j++) {
        const da = lumaA[j] - ma;
        const db = lumaB[j] - mb;
        va += da * da;
        vb += db * db;
        cov += da * db;
      }
      // Выборочные дисперсии (n в знаменателе — как в большинстве реализаций SSIM для блоков).
      va /= n;
      vb /= n;
      cov /= n;
      const ssim =
        ((2 * ma * mb + C1) * (2 * cov + C2)) /
        ((ma * ma + mb * mb + C1) * (va + vb + C2));
      sum += ssim;
      blocks++;
    }
  }
  return blocks === 0 ? 1 : sum / blocks;
}

/**
 * Средняя абсолютная ошибка по RGB.
 *
 * @param a - эталонный кадр.
 * @param b - сравниваемый кадр тех же размеров.
 * @param options - signal: необязательная отмена.
 * @returns MAE по трём каналам, 0..255.
 */
export function computeMAE(a: Frame, b: Frame, options: MetricOptions = {}): number {
  checkPair(a, b, 'computeMAE');
  throwIfAborted(options.signal);
  let sum = 0;
  const da = a.data;
  const db = b.data;
  for (let i = 0; i < da.length; i += 4) {
    if ((i & 262143) === 0) throwIfAborted(options.signal);
    sum += Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]);
  }
  return sum / (a.width * a.height * 3);
}

/**
 * Средняя абсолютная ошибка только по альфа-каналу.
 *
 * @param a - эталонный кадр.
 * @param b - сравниваемый кадр тех же размеров.
 * @param options - signal: необязательная отмена.
 * @returns MAE альфы, 0..255.
 */
export function computeAlphaMAE(a: Frame, b: Frame, options: MetricOptions = {}): number {
  checkPair(a, b, 'computeAlphaMAE');
  throwIfAborted(options.signal);
  let sum = 0;
  const da = a.data;
  const db = b.data;
  for (let i = 3; i < da.length; i += 4) {
    if ((i & 262143) === 3) throwIfAborted(options.signal);
    sum += Math.abs(da[i] - db[i]);
  }
  return sum / (a.width * a.height);
}

/**
 * Alpha-aware MAE в premultiplied-пространстве: сравниваются
 * (r*a/255, g*a/255, b*a/255, a), среднее по четырём компонентам.
 * Скрытый RGB полностью прозрачных пикселей вклада не даёт.
 *
 * @param a - эталонный кадр.
 * @param b - сравниваемый кадр тех же размеров.
 * @param options - signal: необязательная отмена.
 * @returns MAE по premultiplied-компонентам и альфе, 0..255.
 */
export function computePremultipliedMAE(
  a: Frame,
  b: Frame,
  options: MetricOptions = {},
): number {
  checkPair(a, b, 'computePremultipliedMAE');
  throwIfAborted(options.signal);
  let sum = 0;
  const da = a.data;
  const db = b.data;
  for (let i = 0; i < da.length; i += 4) {
    if ((i & 262143) === 0) throwIfAborted(options.signal);
    const aa = da[i + 3] / 255;
    const ab = db[i + 3] / 255;
    sum +=
      Math.abs(da[i] * aa - db[i] * ab) +
      Math.abs(da[i + 1] * aa - db[i + 1] * ab) +
      Math.abs(da[i + 2] * aa - db[i + 2] * ab) +
      Math.abs(da[i + 3] - db[i + 3]);
  }
  return sum / (a.width * a.height * 4);
}

/**
 * Все базовые RGB-метрики одним вызовом (alpha-метрики — отдельными функциями).
 *
 * @param a - эталонный кадр.
 * @param b - сравниваемый кадр тех же размеров.
 * @param options - signal: необязательная отмена.
 * @returns объект { psnr, ssim, mae }.
 */
export function compareFrames(a: Frame, b: Frame, options: MetricOptions = {}): FrameMetrics {
  return {
    psnr: computePSNR(a, b, options),
    ssim: computeSSIM(a, b, options),
    mae: computeMAE(a, b, options),
  };
}
