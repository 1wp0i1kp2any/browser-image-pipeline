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

/** Роль оси quality кодека для конкретной плоскости fit. */
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

/**
 * Разрешить capabilities кодека (объект или функция от опций) в объект.
 *
 * @param codec - кодек плоскости fit.
 * @param options - опции кодирования плоскости (для функциональной формы).
 * @returns объявленные capabilities; пустой объект для старых кодеков без них.
 * @throws InvalidOptionsError, если функция вернула не объект или qualityStep вне (0, 1].
 */
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

/**
 * Вычислить роль quality кодека для конкретной плоскости fit.
 *
 * @param codec - кодек плоскости.
 * @param options - базовые опции плоскости (вариант/измерения), от которых
 *   могут зависеть capabilities, например lossless.
 * @returns разрешённая семантика: искать ли по quality, передавать ли её
 *   в encode, монотонность и шаг внутренней шкалы.
 */
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
