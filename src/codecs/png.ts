// Встроенный кодек image/png: @jsquash/png (rust png crate, wasm) +
// опциональный пост-проход @jsquash/oxipng. ЛЕНИВЫЙ чанк; oxipng грузится
// только когда попросили оптимизацию.
//
// PNG — lossless: параметра quality у него нет, и библиотека это не маскирует.
// Вес PNG режется, по мере грубости: (1) геометрией, (2) oxipng (перебор
// фильтров и deflate — rust-png в одиночку сжимает слабо: на тестовом
// градиенте 64×64 oxipng level 2 дал 156 B против 6009 B у голого энкодера),
// (3) палитрой (ступень quantize — свойство пикселей, а не формата).
// В fit качество для png не является осью поиска (capabilities ниже):
// одна проба на плоскость с фиксированной верхней точкой сетки в отчёте.
//
// Пост-проход oxipng — НЕ «двойное перекодирование» из запрета исходного ТЗ:
// там запрещалась повторная lossy-обработка (JPEG через второй JPEG).
// oxipng пережимает PNG бит-в-бит без потерь (как Squoosh/ImageOptim).
//
// Опции: channel 'grayscale' — честное обесцвечивание кадра (плоскости
// R=G=B лучше жмутся); oxipngLevel 0..6 или effort 0..1 → уровень oxipng;
// oxipng: { level?, interlace?, optimiseAlpha? } — проброс в oxipng
// (interlace=Adam7 обычно УВЕЛИЧИВАЕТ вес, нужен для прогрессивной отрисовки).

import type {
  Codec,
  EncodeOptions,
  Frame,
  PngOptimizeOptions,
  PngOptimizeResult,
} from '../types.js';
import {
  InvalidOptionsError,
  UnsupportedChannelError,
  UnsupportedOptionError,
  throwIfAborted,
} from '../errors.js';
import { frameToImageData, imageDataToFrame, toGrayscale } from '../frame.js';
import { PRESERVED_COLOR_CHUNKS, listPngChunkTypes } from '../png-chunks.js';
import { PNG_CAPABILITIES, PNG_CHANNELS } from './declarations.js';
import { clamp01, splitNormalized } from './normalized.js';


interface OxipngRequest {
  level: number;
  interlace: boolean;
  optimiseAlpha: boolean;
}

function oxipngRequest(options: EncodeOptions, effort?: number): OxipngRequest | null {
  const raw = options.oxipng as Partial<OxipngRequest> | undefined;
  let level: number | undefined;
  if (typeof options.oxipngLevel === 'number') level = options.oxipngLevel;
  if (raw?.level !== undefined) level = raw.level;
  if (level === undefined && effort !== undefined) {
    level = Math.round(clamp01(effort, 'encode effort') * 6);
  }
  if (level === undefined || level <= 0) return null;
  if (!Number.isInteger(level) || level > 6) {
    throw new InvalidOptionsError(`png: oxipng level must be an integer in [0, 6], got ${level}`);
  }
  return {
    level,
    interlace: raw?.interlace ?? false,
    optimiseAlpha: raw?.optimiseAlpha ?? false,
  };
}

function normalizePngOptimizeRequest(options: PngOptimizeOptions): OxipngRequest {
  const level =
    options.level ??
    (options.effort !== undefined
      ? 1 + Math.round(clamp01(options.effort, 'optimizePngBlob effort') * 5)
      : 2);
  if (!Number.isInteger(level) || level < 1 || level > 6) {
    throw new InvalidOptionsError(
      `optimizePngBlob: level must be an integer in [1, 6], got ${level}`,
    );
  }
  for (const key of ['interlace', 'optimiseAlpha'] as const) {
    if (options[key] !== undefined && typeof options[key] !== 'boolean') {
      throw new InvalidOptionsError(`optimizePngBlob: ${key} must be a boolean`);
    }
  }
  return {
    level,
    interlace: options.interlace ?? false,
    optimiseAlpha: options.optimiseAlpha ?? false,
  };
}

/**
 * Lossless-оптимизация готового PNG-Blob через oxipng без decode/encode.
 *
 * Политика чанков: метаданные библиотека сама не удаляет; если oxipng
 * потерял входной цветовой чанк (iCCP/gAMA/cHRM/sRGB/cICP), результат
 * не принимается и возвращается оригинал. По умолчанию результат также
 * принимается только если он меньше входа.
 */
export async function optimizePngBlob(
  blob: Blob,
  options: PngOptimizeOptions = {},
): Promise<PngOptimizeResult> {
  if (!(blob instanceof Blob)) {
    throw new InvalidOptionsError('optimizePngBlob: input must be a Blob');
  }
  if (options.engine !== undefined && options.engine !== 'oxipng') {
    throw new InvalidOptionsError('optimizePngBlob: this module implements only oxipng');
  }
  throwIfAborted(options.signal);
  const buffer = await blob.arrayBuffer();
  throwIfAborted(options.signal);
  const inputBytes = new Uint8Array(buffer);
  const inputChunks = listPngChunkTypes(inputBytes);
  if (!inputChunks) {
    throw new InvalidOptionsError('optimizePngBlob: input is not a valid PNG');
  }
  const request = normalizePngOptimizeRequest(options);
  const { default: optimise } = await import('@jsquash/oxipng/optimise');
  throwIfAborted(options.signal);
  const optimizedBuffer = await optimise(buffer, request);
  throwIfAborted(options.signal);
  const optimizedBytes = new Uint8Array(optimizedBuffer);
  const outputChunks = listPngChunkTypes(optimizedBytes);
  const outputChunkSet = new Set(outputChunks ?? []);
  const lostColorChunk = inputChunks.some(
    (chunk) => PRESERVED_COLOR_CHUNKS.has(chunk) && !outputChunkSet.has(chunk),
  );
  if (!outputChunks || lostColorChunk) {
    return { blob, optimized: false, originalSize: blob.size, size: blob.size, engine: 'oxipng' };
  }
  if (options.onlyIfSmaller !== false && optimizedBytes.length >= inputBytes.length) {
    return { blob, optimized: false, originalSize: blob.size, size: blob.size, engine: 'oxipng' };
  }
  const optimizedBlob = new Blob([optimizedBuffer], { type: 'image/png' });
  return {
    blob: optimizedBlob,
    optimized: true,
    originalSize: blob.size,
    size: optimizedBlob.size,
    engine: 'oxipng',
  };
}

async function encodePng(frame: Frame, options: EncodeOptions = {}): Promise<Blob> {
  const n = splitNormalized(options);
  if (n.subsampling !== undefined) {
    throw new UnsupportedOptionError('image/png', 'subsampling', n.subsampling, 'PNG has no chroma subsampling.');
  }
  if (n.lossless === false) {
    throw new UnsupportedOptionError(
      'image/png',
      'lossless',
      false,
      'PNG is always lossless; lossy PNG-like compression is palette quantization (p.quantize).',
    );
  }
  const channel = n.channel?.toLowerCase();
  let effective = frame;
  if (channel !== undefined && channel !== 'rgba') {
    if (channel === 'grayscale') {
      effective = toGrayscale(frame);
    } else {
      throw new UnsupportedChannelError('image/png', n.channel ?? '', PNG_CHANNELS);
    }
  }
  const { default: encode } = await import('@jsquash/png/encode');
  let buffer = await encode(frameToImageData(effective));

  const request = oxipngRequest(options, n.effort);
  if (request) {
    const { default: optimise } = await import('@jsquash/oxipng/optimise');
    buffer = await optimise(buffer, request);
  }
  return new Blob([buffer], { type: 'image/png' });
}

export async function decodePng(blob: Blob): Promise<Frame> {
  const { default: decode } = await import('@jsquash/png/decode');
  const imageData = await decode(await blob.arrayBuffer());
  return imageDataToFrame(imageData as ImageData);
}

/** Кодек как объект реестра. Никаких привилегий перед пользовательскими. */
export const pngCodec: Codec = {
  encode: encodePng,
  decode: decodePng,
  channels: PNG_CHANNELS,
  capabilities: PNG_CAPABILITIES,
};
