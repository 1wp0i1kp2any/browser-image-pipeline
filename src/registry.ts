// Реестр энкодеров — публичный API расширяемости.
//
// Встроенные кодеки регистрируются в index.ts тем же самым механизмом,
// что доступен потребителю: ядро не знает о форматах ничего. Глобальные
// registerEncoder/getEncoder — обёртки над default-реестром; для изоляции
// создайте отдельный реестр и передайте его в image(..., { registry }).

import type { Codec, EncoderRegistry } from './types.js';
import { UnknownFormatError } from './errors.js';

function normalize(format: string): string {
  return format.trim().toLowerCase();
}

function assertRegistration(format: string, codec: Codec, where: string): void {
  if (!format || !normalize(format)) throw new Error(`${where}: format must not be empty`);
  if (!codec || typeof codec.encode !== 'function') {
    throw new Error(`${where}: codec must provide encode(frame, options)`);
  }
}

/**
 * Создать изолированный реестр кодеков.
 *
 * Без аргумента реестр пуст (встроенных кодеков в нём нет). Передайте
 * существующий реестр, чтобы скопировать его текущие регистрации;
 * дальнейшие изменения копии и оригинала независимы.
 */
export function createEncoderRegistry(source?: EncoderRegistry): EncoderRegistry {
  const codecs = new Map<string, Codec>();
  if (source) {
    for (const format of source.formats()) {
      const codec = source.find(format);
      if (codec) codecs.set(normalize(format), codec);
    }
  }

  const registry: EncoderRegistry = {
    register(format: string, codec: Codec): void {
      assertRegistration(format, codec, 'registry.register');
      codecs.set(normalize(format), codec);
    },
    unregister(format: string): boolean {
      return codecs.delete(normalize(format));
    },
    get(format: string): Codec {
      const codec = codecs.get(normalize(format));
      if (!codec) throw new UnknownFormatError(format);
      return codec;
    },
    find(format: string): Codec | undefined {
      return codecs.get(normalize(format));
    },
    formats(): string[] {
      return [...codecs.keys()];
    },
    clone(): EncoderRegistry {
      return createEncoderRegistry(registry);
    },
  };
  return registry;
}

/** Глобальный реестр по умолчанию: сюда index.ts регистрирует встроенные кодеки. */
export const defaultEncoderRegistry: EncoderRegistry = createEncoderRegistry();

/**
 * Зарегистрировать (или заменить) кодек формата в default-реестре.
 * Новый алгоритм кодирования = новая регистрация; ядро не правится.
 */
export function registerEncoder(format: string, codec: Codec): void {
  assertRegistration(format, codec, 'registerEncoder');
  defaultEncoderRegistry.register(format, codec);
}

/** Снять кодек формата из default-реестра. Возвращает true, если кодек был. */
export function unregisterEncoder(format: string): boolean {
  return defaultEncoderRegistry.unregister(format);
}

/** Кодек default-реестра или UnknownFormatError. */
export function getEncoder(format: string): Codec {
  return defaultEncoderRegistry.get(format);
}

/** Кодек default-реестра или undefined — мягкая проверка наличия. */
export function findEncoder(format: string): Codec | undefined {
  return defaultEncoderRegistry.find(format);
}

/** Форматы default-реестра. */
export function registeredFormats(): string[] {
  return defaultEncoderRegistry.formats();
}
