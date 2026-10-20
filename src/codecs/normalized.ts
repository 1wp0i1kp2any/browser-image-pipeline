// Разбор нормированных опций EncodeOptions для кодеков: библиотека обещает
// вызывающему одни и те же quality/channel/subsample/effort/lossless у всех
// форматов, а отображение в шкалы и поля конкретного энкодера — дело кодека.

import type { ChromaSubsampling, EncodeOptions } from '../types.js';
import { InvalidOptionsError } from '../errors.js';

export interface NormalizedOptions {
  quality?: number;
  channel?: string;
  subsampling?: ChromaSubsampling;
  effort?: number;
  lossless?: boolean;
  /** Всё остальное — поля конкретного кодека, пробрасываются как есть. */
  rest: Record<string, unknown>;
}

export function splitNormalized(options: EncodeOptions = {}): NormalizedOptions {
  const { quality, channel, subsampling, effort, lossless, ...rest } = options;
  return { quality, channel, subsampling, effort, lossless, rest };
}

export function clamp01(value: number, what: string): number {
  if (!(value >= 0 && value <= 1)) {
    throw new InvalidOptionsError(`${what} must be in [0, 1], got ${value}`);
  }
  return value;
}

/** Нормированное качество 0..1 → шкала 0..100 (MozJPEG/libwebp/libaom через jSquash). */
export function quality100(quality: number): number {
  return Math.round(clamp01(quality, 'encode quality') * 100);
}
