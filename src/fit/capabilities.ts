// Разрешение capabilities кодека для fit.
//
// Старые пользовательские кодеки capabilities не объявляют. Для них
// сохраняется историческое поведение: quality поддерживается и считается
// монотонным по размеру. Встроенные кодеки объявляют фактическую семантику:
// PNG quality не имеет; WebP lossless трактует quality как усилие;
// AVIF lossless quality игнорирует (подтверждено замером и сообщением
// самого энкодера).

import type {
  Codec,
  CodecCapabilities,
  CodecQualityRole,
  EncodeOptions,
} from '../types.js';
import { InvalidOptionsError } from '../errors.js';

export interface ResolvedQualityCapability {
  /** Декларирует ли кодек влияние quality на кодирование. */
  supported: boolean;
  /** Роль quality в текущем режиме плоскости. */
  role: CodecQualityRole;
  /** Ищет ли fit по quality как по оси качества. */
  searchesQuality: boolean;
  /** Передавать ли quality в encode. */
  passesQuality: boolean;
  /** Считается ли размер монотонным по quality. */
  monotoneSize: boolean;
  /** Шаг внутренней шкалы quality, если кодек его объявил. */
  step?: number;
}

function resolveCodecCapabilities(
  codec: Codec,
  options: EncodeOptions = {},
): CodecCapabilities {
  const declared = codec.capabilities;
  if (declared === undefined) return {};
  const resolved = typeof declared === 'function' ? declared(options) : declared;
  if (!resolved || typeof resolved !== 'object') {
    throw new InvalidOptionsError('codec.capabilities must resolve to an object');
  }
  if (
    resolved.qualityStep !== undefined &&
    !(resolved.qualityStep > 0 && resolved.qualityStep <= 1)
  ) {
    throw new InvalidOptionsError(
      `codec.capabilities.qualityStep must be in (0, 1], got ${resolved.qualityStep}`,
    );
  }
  return resolved;
}

export function resolveQualityCapability(
  codec: Codec,
  options: EncodeOptions = {},
): ResolvedQualityCapability {
  const caps = resolveCodecCapabilities(codec, options);
  const supported = caps.quality ?? true;
  const role: CodecQualityRole = supported ? (caps.qualityRole ?? 'quality') : 'ignored';
  return {
    supported,
    role,
    searchesQuality: supported && role === 'quality',
    passesQuality: supported && role !== 'ignored',
    monotoneSize: caps.monotoneQualitySize ?? true,
    step: caps.qualityStep,
  };
}
