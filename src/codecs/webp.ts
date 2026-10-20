// Встроенный кодек image/webp поверх @jsquash/webp (libwebp, wasm+SIMD).
// ЛЕНИВЫЙ чанк. По исследованию: lossy WebP обычно на ~25–34% легче JPEG
// при сопоставимом качестве, lossless — ~26% легче PNG; near-lossless —
// сильный режим для графики/скриншотов.
//
// Нормированные опции:
//  - quality 0..1 → 0..100 (в lossless libwebp трактует её как усилие);
//  - effort 0..1 → method 0..6 (Squoosh по умолчанию method 4);
//  - lossless → lossless 1/0. ВНИМАНИЕ: поле near_lossless пробрасывается,
//    но текущая сборка @jsquash/webp его ИГНОРИРУЕТ (замерено: размеры при
//    0/60/100 байт-в-байт одинаковы). «Почти без потерь» делайте палитрой:
//    p.quantize({colors: 256}) + lossless;
//  - channel 'grayscale' — обесцвечивание кадра (родного серого режима нет);
//  - subsampling: lossy WebP всегда 4:2:0 — иное значение честно отклоняется,
//    '4:4:4'-подобной точности цветных краёв служит use_sharp_yuv: 1.
// Остальные поля libwebp пробрасываются: target_size, target_PSNR,
// sns_strength, filter_strength/sharpness/type, autofilter, segments,
// alpha_quality/alpha_compression/alpha_filtering, exact (сохранять RGB
// под прозрачной альфой), use_delta_palette, pass, preprocessing...

import type { Codec, EncodeOptions, Frame } from '../types.js';
import { UnsupportedChannelError, UnsupportedOptionError } from '../errors.js';
import { frameToImageData, imageDataToFrame, toGrayscale } from '../frame.js';
import { WEBP_CHANNELS, WEBP_SUBSAMPLING, webpCapabilities } from './declarations.js';
import { clamp01, quality100, splitNormalized } from './normalized.js';

export function mapWebpOptions(options: EncodeOptions = {}): {
  mapped: Record<string, unknown>;
  grayscale: boolean;
} {
  const n = splitNormalized(options);
  if (n.subsampling !== undefined && n.subsampling !== '4:2:0') {
    throw new UnsupportedOptionError(
      'image/webp',
      'subsampling',
      n.subsampling,
      'Lossy WebP is always 4:2:0. For sharper chroma edges use use_sharp_yuv: 1; lossless WebP stores full RGB.',
    );
  }
  const mapped: Record<string, unknown> = {};
  if (n.quality !== undefined) mapped.quality = quality100(n.quality);
  if (n.effort !== undefined) mapped.method = Math.round(clamp01(n.effort, 'encode effort') * 6);
  if (n.lossless !== undefined) mapped.lossless = n.lossless ? 1 : 0;
  Object.assign(mapped, n.rest);
  // quality/effort/lossless нормированные старше одноимённого проброса по rest не бывает:
  // rest их уже не содержит (splitNormalized вынул). method из rest старше effort:
  // Object.assign выше это и дал — явный method вызывающего побеждает.

  let grayscale = false;
  if (n.channel !== undefined) {
    const ch = n.channel.toLowerCase();
    if (ch === 'grayscale') grayscale = true;
    else if (ch !== 'rgba') {
      throw new UnsupportedChannelError('image/webp', n.channel, WEBP_CHANNELS);
    }
  }
  return { mapped, grayscale };
}

async function encodeWebp(frame: Frame, options?: EncodeOptions): Promise<Blob> {
  const { mapped, grayscale } = mapWebpOptions(options);
  const { default: encode } = await import('@jsquash/webp/encode');
  const buffer = await encode(
    frameToImageData(grayscale ? toGrayscale(frame) : frame),
    mapped as Parameters<typeof encode>[1],
  );
  return new Blob([buffer], { type: 'image/webp' });
}

export async function decodeWebp(blob: Blob): Promise<Frame> {
  const { default: decode } = await import('@jsquash/webp/decode');
  const imageData = await decode(await blob.arrayBuffer());
  return imageDataToFrame(imageData);
}

/** Кодек как объект реестра. Никаких привилегий перед пользовательскими. */
export const webpCodec: Codec = {
  encode: encodeWebp,
  decode: decodeWebp,
  channels: WEBP_CHANNELS,
  subsampling: WEBP_SUBSAMPLING,
  capabilities: webpCapabilities,
};
