// Единые декларации встроенных кодеков: channels, subsampling, capabilities.
//
// Этот модуль не импортирует @jsquash и сами кодекные реализации, поэтому
// ядро может использовать декларации для планирования fit до загрузки
// ленивых чанков, а реальные кодеки используют ровно те же объекты/функции.
// Раньше декларации дублировались в index.ts и codecs/* и могли разойтись.

import type { ChromaSubsampling, CodecCapabilities, EncodeOptions } from '../types.js';

export const JPEG_CHANNELS = ['ycbcr', 'rgb', 'grayscale'] as const;
export const JPEG_SUBSAMPLING: readonly ChromaSubsampling[] = ['4:2:0', '4:4:4'];

export const PNG_CHANNELS = ['rgba', 'grayscale'] as const;

export const WEBP_CHANNELS = ['rgba', 'grayscale'] as const;
export const WEBP_SUBSAMPLING: readonly ChromaSubsampling[] = ['4:2:0'];

export const AVIF_CHANNELS = ['rgba', 'grayscale'] as const;
export const AVIF_SUBSAMPLING: readonly ChromaSubsampling[] = [
  '4:2:0',
  '4:2:2',
  '4:4:4',
  '4:0:0',
];

export const JPEG_CAPABILITIES: CodecCapabilities = {
  quality: true,
  qualityRole: 'quality',
  monotoneQualitySize: true,
  qualityStep: 0.01,
  lossless: false,
  effort: true,
};

export const PNG_CAPABILITIES: CodecCapabilities = {
  quality: false,
  qualityRole: 'ignored',
  lossless: true,
  effort: true,
};

/**
 * В lossless libwebp quality меняет усилие/упаковку, но не пиксели
 * (замерено: декодирование побитово точно при q=0 и q=1, размер может
 * отличаться). Поэтому fit не ищет по ней как по качеству.
 */
export function webpCapabilities(options: EncodeOptions = {}): CodecCapabilities {
  return options.lossless
    ? { quality: true, qualityRole: 'effort', qualityStep: 0.01, lossless: true, effort: true }
    : {
        quality: true,
        qualityRole: 'quality',
        monotoneQualitySize: true,
        qualityStep: 0.01,
        lossless: true,
        effort: true,
      };
}

/**
 * При AVIF lossless энкодер прямо сообщает, что quality игнорируется;
 * замер дал байт-в-байт одинаковые результаты при q=0/0.5/1.
 */
export function avifCapabilities(options: EncodeOptions = {}): CodecCapabilities {
  return options.lossless
    ? { quality: false, qualityRole: 'ignored', lossless: true, effort: true }
    : {
        quality: true,
        qualityRole: 'quality',
        monotoneQualitySize: true,
        qualityStep: 0.01,
        lossless: true,
        effort: true,
      };
}
