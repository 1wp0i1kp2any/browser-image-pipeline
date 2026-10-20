// Точка входа библиотеки.
//
// Ядро лёгкое: статический импорт этого модуля НЕ тащит ни один кодек и ни
// квантование. Встроенные кодеки регистрируются здесь ленивыми обёртками —
// реальные модули (и их wasm) подгружаются динамическим импортом при первом
// использовании. Регистрация — тот же публичный registerEncoder, что и у
// потребителя: jpeg и png ничем не привилегированы, их можно заменить.

import { registerEncoder } from './registry.js';
import {
  AVIF_CHANNELS,
  AVIF_SUBSAMPLING,
  JPEG_CAPABILITIES,
  JPEG_CHANNELS,
  JPEG_SUBSAMPLING,
  PNG_CAPABILITIES,
  PNG_CHANNELS,
  WEBP_CHANNELS,
  WEBP_SUBSAMPLING,
  avifCapabilities,
  webpCapabilities,
} from './codecs/declarations.js';
import type {
  Codec,
  EncodeOptions,
  Frame,
  PngOptimizeOptions,
  PngOptimizeResult,
} from './types.js';

export { image } from './pipeline.js';
export {
  createEncoderRegistry,
  defaultEncoderRegistry,
  registerEncoder,
  unregisterEncoder,
  getEncoder,
  findEncoder,
  registeredFormats,
} from './registry.js';
export {
  EnvironmentError,
  UnknownFormatError,
  UnsupportedChannelError,
  UnsupportedOptionError,
  InvalidOptionsError,
  FitBudgetExhaustedError,
  ResourceLimitError,
} from './errors.js';
export type { FitBudgetReason } from './errors.js';
// Чистые утилиты кадра: пригодятся потребительским кодекам и тестам.
export {
  analyzeFrame,
  applyFrameGeometry,
  resizeBilinear,
  resizeLanczos3,
  resizeArea,
  sharpenFrame,
  toGrayscale,
  probeSaturation,
  MONOCHROME_SATURATION_THRESHOLD,
  frameToImageData,
  imageDataToFrame,
  cloneFrame,
} from './frame.js';
// Объективные метрики искажения (цена сжатия в числах).
export {
  compareFrames,
  computeAlphaMAE,
  computeMAE,
  computePremultipliedMAE,
  computePSNR,
  computeSSIM,
} from './metrics.js';
export type { FrameMetrics, MetricOptions } from './metrics.js';
export type { FrameAnalysis, FrameAnalysisOptions } from './frame.js';
// Стартовые пресеты энкодеров по итогам исследования оптимизаторов.
export { PRESETS } from './presets.js';
export type { PresetName } from './presets.js';
export type {
  Frame,
  FrameOptions,
  ResizeMethod,
  SharpenOptions,
  QuantizeOptions,
  PaletteAlgorithm,
  ColorDistanceFormula,
  EncodeOptions,
  ChromaSubsampling,
  Codec,
  CodecCapabilities,
  CodecCapabilitiesResolver,
  CodecQualityRole,
  Decoder,
  EncoderRegistry,
  PngOptimizeOptions,
  PngOptimizeResult,
  PngOptimizerEngine,
  FitSpec,
  FitDimension,
  FitDimensionValue,
  FitOptions,
  FitPlaneContext,
  FitProbe,
  FitProbeOutcome,
  FitQualityStrategy,
  FitStrategy,
  FitStrategyContext,
  FitStrategyHit,
  FitStrategyObject,
  FitMonotonicity,
  FitWarning,
  FitWarningCode,
  FitParams,
  FitResult,
  FitStrategyName,
  ImageOptions,
  Pipeline,
  PipelineEvent,
  StateListener,
} from './types.js';

/**
 * Lossless-оптимизировать готовый PNG-Blob.
 *
 * По умолчанию используется oxipng/wasm. С `engine:'compression-stream'`
 * динамически грузится отдельный модуль без wasm, который пережимает
 * только IDAT и сохраняет остальные PNG-чанки байт-в-байт.
 *
 * @param blob - готовый PNG-Blob.
 * @param options - движок и параметры оптимизации (см. PngOptimizeOptions).
 * @returns результат: Blob (оптимизированный или оригинал), размеры, движок.
 * @throws InvalidOptionsError, если вход не PNG или опции несовместимы с движком.
 */
export async function optimizePngBlob(
  blob: Blob,
  options?: PngOptimizeOptions,
): Promise<PngOptimizeResult> {
  if (options?.engine === 'compression-stream') {
    const mod = await import('./optimizers/png-compression-stream.js');
    return mod.optimizePngBlobWithCompressionStream(blob, options);
  }
  const mod = await import('./codecs/png.js');
  return mod.optimizePngBlob(blob, options);
}

// --- Встроенные кодеки (ленивая регистрация) ---------------------------------

type LoadedCodec = Required<Pick<Codec, 'encode' | 'decode'>>;

/**
 * Собрать ленивую обёртку встроенного кодека для default-реестра.
 *
 * @param meta - декларации кодека (capabilities/channels/subsampling),
 *   доступные ядру до загрузки тяжёлого модуля.
 * @param load - динамический импорт реального кодекного модуля.
 * @returns Codec, чей encode/decode при первом вызове грузят реализацию.
 */
function lazyCodec(
  meta: Pick<Codec, 'capabilities' | 'channels' | 'subsampling'>,
  load: () => Promise<LoadedCodec>,
): Codec {
  return {
    ...meta,
    async encode(frame: Frame, options?: EncodeOptions): Promise<Blob> {
      return (await load()).encode(frame, options);
    },
    async decode(blob: Blob): Promise<Frame> {
      return (await load()).decode(blob);
    },
  };
}

const lazyJpeg = lazyCodec(
  {
    channels: JPEG_CHANNELS,
    subsampling: JPEG_SUBSAMPLING,
    capabilities: JPEG_CAPABILITIES,
  },
  async () => {
    const mod = await import('./codecs/jpeg.js');
    return { encode: mod.jpegCodec.encode, decode: mod.decodeJpeg };
  },
);

const lazyPng = lazyCodec(
  { channels: PNG_CHANNELS, capabilities: PNG_CAPABILITIES },
  async () => {
    const mod = await import('./codecs/png.js');
    return { encode: mod.pngCodec.encode, decode: mod.decodePng };
  },
);

const lazyWebp = lazyCodec(
  {
    channels: WEBP_CHANNELS,
    subsampling: WEBP_SUBSAMPLING,
    capabilities: webpCapabilities,
  },
  async () => {
    const mod = await import('./codecs/webp.js');
    return { encode: mod.webpCodec.encode, decode: mod.decodeWebp };
  },
);

const lazyAvif = lazyCodec(
  {
    channels: AVIF_CHANNELS,
    subsampling: AVIF_SUBSAMPLING,
    capabilities: avifCapabilities,
  },
  async () => {
    const mod = await import('./codecs/avif.js');
    return { encode: mod.avifCodec.encode, decode: mod.decodeAvif };
  },
);

registerEncoder('image/jpeg', lazyJpeg);
registerEncoder('image/png', lazyPng);
registerEncoder('image/webp', lazyWebp);
registerEncoder('image/avif', lazyAvif);
