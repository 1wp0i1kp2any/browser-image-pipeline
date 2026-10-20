// Реестр энкодеров — публичный API расширяемости.
//
// Встроенные кодеки регистрируются в index.ts тем же самым механизмом,
// что доступен потребителю: ядро не знает о форматах ничего. Глобальные
// registerEncoder/getEncoder — обёртки над default-реестром; для изоляции
// создайте отдельный реестр и передайте его в image(..., { registry }).

import type { Codec, EncoderRegistry } from './types.js';
import { UnknownFormatError } from './errors.js';

/**
 * Нормализовать имя формата реестра: trim + lower-case (MIME регистронезависим).
 *
 * @param format - имя формата как дал вызывающий, например ' Image/JPEG '.
 * @returns канонический ключ реестра.
 */
function normalize(format: string): string {
  return format.trim().toLowerCase();
}

/**
 * Проверить аргументы регистрации кодека до записи в реестр.
 *
 * @param format - имя формата; не должно быть пустым после нормализации.
 * @param codec - кодек; обязан предоставлять encode(frame, options).
 * @param where - имя публичной точки входа для текста ошибки.
 * @throws Error, если формат пуст или у кодека нет encode.
 */
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
 *
 * @param source - необязательный реестр-источник для копирования регистраций.
 * @returns новый изолированный реестр.
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
 *
 * @param format - MIME-имя формата, например 'image/jpeg' (регистр не важен).
 * @param codec - реализация кодека с обязательным encode.
 * @throws Error, если формат пуст или у кодека нет encode.
 */
export function registerEncoder(format: string, codec: Codec): void {
  assertRegistration(format, codec, 'registerEncoder');
  defaultEncoderRegistry.register(format, codec);
}

/**
 * Снять кодек формата из default-реестра.
 *
 * @param format - MIME-имя формата (регистр не важен).
 * @returns true, если кодек был зарегистрирован и удалён.
 */
export function unregisterEncoder(format: string): boolean {
  return defaultEncoderRegistry.unregister(format);
}

/**
 * Получить кодек default-реестра.
 *
 * @param format - MIME-имя формата (регистр не важен).
 * @returns зарегистрированный кодек.
 * @throws UnknownFormatError, если кодек формата не зарегистрирован.
 */
export function getEncoder(format: string): Codec {
  return defaultEncoderRegistry.get(format);
}

/**
 * Найти кодек default-реестра без ошибки.
 *
 * @param format - MIME-имя формата (регистр не важен).
 * @returns кодек или undefined, если формат не зарегистрирован.
 */
export function findEncoder(format: string): Codec | undefined {
  return defaultEncoderRegistry.find(format);
}

/**
 * Список форматов default-реестра.
 *
 * @returns нормализованные имена форматов в порядке регистрации.
 */
export function registeredFormats(): string[] {
  return defaultEncoderRegistry.formats();
}
