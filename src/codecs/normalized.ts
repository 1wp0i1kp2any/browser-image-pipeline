// Разбор нормированных опций EncodeOptions для кодеков: библиотека обещает
// вызывающему одни и те же quality/channel/subsample/effort/lossless у всех
// форматов, а отображение в шкалы и поля конкретного энкодера — дело кодека.

import type { ChromaSubsampling, EncodeOptions } from '../types.js';
import { InvalidOptionsError } from '../errors.js';

/** Результат разбора EncodeOptions кодеком: нормированная часть + проброс. */
export interface NormalizedOptions {
  /** Нормированное качество 0..1, если задано. */
  quality?: number;
  /** Нормированный канал ('grayscale', 'rgb', ...), если задан. */
  channel?: string;
  /** Нормированный субсемплинг цветности, если задан. */
  subsampling?: ChromaSubsampling;
  /** Нормированное усилие 0..1, если задано. */
  effort?: number;
  /** Нормированный lossless-флаг, если задан. */
  lossless?: boolean;
  /** Всё остальное — поля конкретного кодека, пробрасываются как есть. */
  rest: Record<string, unknown>;
}

/**
 * Разделить EncodeOptions на нормированные поля и проброс конкретного кодека.
 *
 * @param options - опции кодирования вызывающего; по умолчанию пустые.
 * @returns нормированные quality/channel/subsampling/effort/lossless и `rest`
 *   со всеми остальными полями без изменений.
 */
export function splitNormalized(options: EncodeOptions = {}): NormalizedOptions {
  const { quality, channel, subsampling, effort, lossless, ...rest } = options;
  return { quality, channel, subsampling, effort, lossless, rest };
}

/**
 * Проверить, что нормированное значение лежит в [0, 1], и вернуть его.
 *
 * @param value - проверяемое значение (quality/effort и подобные шкалы).
 * @param what - человекочитаемое имя параметра для текста ошибки.
 * @returns то же значение, если оно в диапазоне.
 * @throws InvalidOptionsError, если значение вне [0, 1] или NaN.
 */
export function clamp01(value: number, what: string): number {
  if (!(value >= 0 && value <= 1)) {
    throw new InvalidOptionsError(`${what} must be in [0, 1], got ${value}`);
  }
  return value;
}

/**
 * Нормированное качество 0..1 → шкала 0..100 (MozJPEG/libwebp/libaom через jSquash).
 *
 * @param quality - нормированное качество 0..1.
 * @returns целое качество 0..100 с обычным округлением.
 * @throws InvalidOptionsError, если quality вне [0, 1].
 */
export function quality100(quality: number): number {
  return Math.round(clamp01(quality, 'encode quality') * 100);
}
