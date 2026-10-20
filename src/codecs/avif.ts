// Встроенный кодек image/avif поверх @jsquash/avif (libaom, wasm).
// ЛЕНИВЫЙ чанк; wasm энкодера большой (~3.4 МиБ) и грузится только при
// первом avif. По исследованию AVIF даёт лучший вес на фото (ориентир
// Squoosh-практик — до ~50% легче JPEG при сопоставимом виде), но энкод
// заметно медленнее остальных кодеков: усилие надо выбирать осознанно.
//
// Нормированные опции:
//  - quality 0..1 → quality 0..100 (шкала @jsquash/avif; 100 — верх диапазона,
//    настоящий lossless — отдельным флагом). Помните: шкалы качества у
//    форматов НЕ эквивалентны (AVIF «50» визуально крепче JPEG «50»);
//  - effort 0..1 → speed 10..0 (инверсия: speed 0 — самый медленный/точный;
//    Squoosh-умолчание speed 6 ≈ effort 0.4);
//  - subsampling: '4:2:0'→1, '4:2:2'→2, '4:4:4'→3, '4:0:0'→0 (монохром);
//  - channel 'grayscale' → обесцвечивание + subsample 4:0:0 (цветовые
//    плоскости не пишутся вовсе), если subsampling не задан явно;
//  - lossless → флаг lossless кодека.
// Проброс полей libaom-обёртки: qualityAlpha, denoiseLevel (0..50),
// tileRowsLog2/tileColsLog2, chromaDeltaQ, sharpness (0..7), enableSharpYUV,
// tune: 0=auto | 1=psnr | 2=ssim (принимается и строкой 'auto'|'psnr'|'ssim').

import type { ChromaSubsampling, Codec, EncodeOptions, Frame } from '../types.js';
import { UnsupportedChannelError, UnsupportedOptionError } from '../errors.js';
import { frameToImageData, imageDataToFrame, toGrayscale } from '../frame.js';
import { AVIF_CHANNELS, AVIF_SUBSAMPLING, avifCapabilities } from './declarations.js';
import { clamp01, quality100, splitNormalized } from './normalized.js';

const SUBSAMPLE: Record<ChromaSubsampling, number> = {
  '4:0:0': 0,
  '4:2:0': 1,
  '4:2:2': 2,
  '4:4:4': 3,
};

const TUNE: Record<string, number> = { auto: 0, psnr: 1, ssim: 2 };

export function mapAvifOptions(options: EncodeOptions = {}): {
  mapped: Record<string, unknown>;
  grayscale: boolean;
} {
  const n = splitNormalized(options);
  const mapped: Record<string, unknown> = {};
  if (n.quality !== undefined) mapped.quality = quality100(n.quality);
  if (n.effort !== undefined) {
    mapped.speed = Math.round((1 - clamp01(n.effort, 'encode effort')) * 10);
  }
  if (n.lossless !== undefined) mapped.lossless = n.lossless;
  if (n.subsampling !== undefined) {
    const s = SUBSAMPLE[n.subsampling];
    if (s === undefined) {
      throw new UnsupportedOptionError('image/avif', 'subsampling', n.subsampling);
    }
    mapped.subsample = s;
  }
  Object.assign(mapped, n.rest);
  if (typeof mapped.tune === 'string') {
    const t = TUNE[mapped.tune.toLowerCase()];
    if (t === undefined) {
      throw new UnsupportedOptionError('image/avif', 'tune', mapped.tune, 'Use auto | psnr | ssim.');
    }
    mapped.tune = t;
  }

  let grayscale = false;
  if (n.channel !== undefined) {
    const ch = n.channel.toLowerCase();
    if (ch === 'grayscale') grayscale = true;
    else if (ch !== 'rgba') {
      throw new UnsupportedChannelError('image/avif', n.channel, AVIF_CHANNELS);
    }
  }
  if (grayscale && mapped.subsample === undefined) {
    mapped.subsample = 0; // 4:0:0 — цветовые плоскости не пишутся вовсе
  }
  return { mapped, grayscale };
}

async function encodeAvif(frame: Frame, options?: EncodeOptions): Promise<Blob> {
  const { mapped, grayscale } = mapAvifOptions(options);
  const { default: encode } = await import('@jsquash/avif/encode');
  const buffer = await encode(
    frameToImageData(grayscale ? toGrayscale(frame) : frame),
    mapped as Parameters<typeof encode>[1] & { bitDepth?: 8 },
  );
  return new Blob([buffer], { type: 'image/avif' });
}

export async function decodeAvif(blob: Blob): Promise<Frame> {
  const { default: decode } = await import('@jsquash/avif/decode');
  const imageData = await decode(await blob.arrayBuffer());
  return imageDataToFrame(imageData as ImageData);
}

/** Кодек как объект реестра. Никаких привилегий перед пользовательскими. */
export const avifCodec: Codec = {
  encode: encodeAvif,
  decode: decodeAvif,
  channels: AVIF_CHANNELS,
  subsampling: AVIF_SUBSAMPLING,
  capabilities: avifCapabilities,
};
