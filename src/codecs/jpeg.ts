// Встроенный кодек image/jpeg поверх @jsquash/jpeg (MozJPEG, wasm).
// ЛЕНИВЫЙ чанк: модуль и wasm грузятся при первом encode/decode.
//
// Отображение нормированных опций в MozJPEG:
//  - quality 0..1 → 0..100;
//  - channel 'grayscale'|'rgb'|'ycbcr' → color_space (тот самый Channels из Squoosh);
//  - subsampling '4:4:4'|'4:2:0' → auto_subsample=false + chroma_subsample 1|2
//    (подтверждено по SOF-маркерам реальных файлов; 4:2:2 эта сборка не умеет);
//  - effort 0..1 → trellis-оптимизации MozJPEG (пороги ниже);
//  - lossless → UnsupportedOptionError (MozJPEG lossless не умеет);
//  - остальные поля пробрасываются как есть и СТАРШЕ нормированных:
//    progressive, arithmetic, optimize_coding, smoothing (0..100, сглаживание
//    зашумлённых/дизернутых исходников), quant_table (0 Annex K, 1 flat,
//    2 MS-SSIM, 3 Robidoux/ImageMagick — умолчание сборки, 4 PSNR-HVS, 5 KSC),
//    trellis_multipass/opt_zero/opt_table/loops, separate_chroma_quality +
//    chroma_quality, auto_subsample, chroma_subsample, color_space числом.
// Умолчания самой сборки @jsquash сильные (progressive, optimize_coding,
// quant_table 3, auto_subsample) — пресеты см. в presets.ts.

import type { Codec, EncodeOptions, Frame } from '../types.js';
import { UnsupportedChannelError, UnsupportedOptionError } from '../errors.js';
import { frameToImageData, imageDataToFrame } from '../frame.js';
import { JPEG_CAPABILITIES, JPEG_CHANNELS, JPEG_SUBSAMPLING } from './declarations.js';
import { clamp01, quality100, splitNormalized } from './normalized.js';

// MozJpegColorSpace из @jsquash/jpeg: GRAYSCALE=1, RGB=2, YCbCr=3.
const COLOR_SPACE: Record<string, number> = {
  grayscale: 1,
  rgb: 2,
  ycbcr: 3,
};

type MozJpegOptions = Record<string, unknown> & {
  quality?: number;
  color_space?: number;
};

export function mapJpegOptions(options: EncodeOptions = {}): MozJpegOptions {
  const n = splitNormalized(options);
  if (n.lossless) {
    throw new UnsupportedOptionError(
      'image/jpeg',
      'lossless',
      true,
      'MozJPEG has no lossless mode; use image/png, image/webp or image/avif.',
    );
  }
  const mapped: MozJpegOptions = {};

  if (n.subsampling !== undefined) {
    if (n.subsampling === '4:4:4' || n.subsampling === '4:2:0') {
      mapped.auto_subsample = false;
      mapped.chroma_subsample = n.subsampling === '4:4:4' ? 1 : 2;
    } else {
      throw new UnsupportedOptionError(
        'image/jpeg',
        'subsampling',
        n.subsampling,
        'This MozJPEG build supports 4:4:4 and 4:2:0 only.',
      );
    }
  }

  if (n.effort !== undefined) {
    // Trellis — rate-distortion оптимизация коэффициентов: время в обмен
    // на вес при том же зрительном качестве. Пороги — эвристика библиотеки.
    const e = clamp01(n.effort, 'encode effort');
    mapped.trellis_multipass = e >= 0.34;
    mapped.trellis_opt_table = e >= 0.5;
    mapped.trellis_opt_zero = e >= 0.67;
    mapped.trellis_loops = 1 + Math.round(e * 4);
  }

  // Поля конкретного кодека старше нормированных отображений.
  Object.assign(mapped, n.rest);

  if (n.quality !== undefined) mapped.quality = quality100(n.quality);
  if (n.channel !== undefined && mapped.color_space === undefined) {
    const cs = COLOR_SPACE[n.channel.toLowerCase()];
    if (cs === undefined) {
      throw new UnsupportedChannelError('image/jpeg', n.channel, JPEG_CHANNELS);
    }
    mapped.color_space = cs;
  }
  return mapped;
}

async function encodeJpeg(frame: Frame, options?: EncodeOptions): Promise<Blob> {
  const mapped = mapJpegOptions(options);
  const { default: encode } = await import('@jsquash/jpeg/encode');
  const buffer = await encode(
    frameToImageData(frame),
    mapped as Parameters<typeof encode>[1],
  );
  return new Blob([buffer], { type: 'image/jpeg' });
}

export async function decodeJpeg(blob: Blob): Promise<Frame> {
  const { default: decode } = await import('@jsquash/jpeg/decode');
  const imageData = await decode(await blob.arrayBuffer());
  return imageDataToFrame(imageData);
}

/** Кодек как объект реестра. Никаких привилегий перед пользовательскими. */
export const jpegCodec: Codec = {
  encode: encodeJpeg,
  decode: decodeJpeg,
  channels: JPEG_CHANNELS,
  subsampling: JPEG_SUBSAMPLING,
  capabilities: JPEG_CAPABILITIES,
};
