// Ошибки библиотеки. Все — обычные Error с различимым классом,
// чтобы вызывающий мог ветвиться по instanceof, а не по тексту.

/** Среда не поддерживает нужные браузерные API (SSR/Node без decoder-шовa). */
export class EnvironmentError extends Error {
  /**
   * @param message - что именно недоступно в среде и какой шов использовать.
   */
  constructor(message: string) {
    super(message);
    this.name = 'EnvironmentError';
  }
}

/** Для формата не зарегистрирован энкодер. */
export class UnknownFormatError extends Error {
  readonly format: string;
  /**
   * @param format - формат, для которого энкодер не зарегистрирован.
   */
  constructor(format: string) {
    super(
      `No encoder registered for format "${format}". ` +
        `Register one with registerEncoder("${format}", codec).`,
    );
    this.name = 'UnknownFormatError';
    this.format = format;
  }
}

/** Кодек не поддерживает запрошенный канал (options.channel). */
export class UnsupportedChannelError extends Error {
  readonly format: string;
  readonly channel: string;
  /**
   * @param format - формат кодека, отклонившего канал.
   * @param channel - запрошенный неподдерживаемый канал.
   * @param supported - необязательный список поддерживаемых каналов для подсказки.
   */
  constructor(format: string, channel: string, supported?: readonly string[]) {
    super(
      `Codec "${format}" does not support channel "${channel}"` +
        (supported && supported.length > 0
          ? `. Supported: ${supported.join(', ')}.`
          : '.'),
    );
    this.name = 'UnsupportedChannelError';
    this.format = format;
    this.channel = channel;
  }
}

/** Кодек не поддерживает нормированную опцию (subsampling/lossless/...). */
export class UnsupportedOptionError extends Error {
  readonly format: string;
  readonly option: string;
  /**
   * @param format - формат кодека, отклонившего опцию.
   * @param option - имя нормированной опции ('subsampling', 'lossless', ...).
   * @param value - запрошенное значение (попадает в текст через JSON.stringify).
   * @param hint - необязательная подсказка, что использовать вместо.
   */
  constructor(format: string, option: string, value: unknown, hint?: string) {
    super(
      `Codec "${format}" does not support ${option}=${JSON.stringify(value)}` +
        (hint ? `. ${hint}` : '.'),
    );
    this.name = 'UnsupportedOptionError';
    this.format = format;
    this.option = option;
  }
}

/** Некорректные аргументы ступени (диапазоны, размеры и т.п.). */
export class InvalidOptionsError extends Error {
  /**
   * @param message - какой аргумент некорректен и что ожидалось.
   */
  constructor(message: string) {
    super(message);
    this.name = 'InvalidOptionsError';
  }
}

/** Причина остановки fit по бюджету. */
export type FitBudgetReason = 'max-attempts' | 'deadline';

/**
 * fit остановлен бюджетом вызывающего до исчерпания пространства поиска.
 * Это НЕ «подходящего кандидата нет»: для доказанного no-fit fit по-прежнему
 * возвращает null.
 */
export class FitBudgetExhaustedError extends Error {
  readonly reason: FitBudgetReason;
  readonly attempts: number;
  readonly elapsedMs: number;
  readonly maxAttempts?: number;
  readonly deadlineMs?: number;

  /**
   * @param details - причина остановки, счётчик попыток, прошедшее время
   *   и копии заданных вызывающим лимитов для диагностики.
   */
  constructor(details: {
    reason: FitBudgetReason;
    attempts: number;
    elapsedMs: number;
    maxAttempts?: number;
    deadlineMs?: number;
  }) {
    super(
      `fit: budget exhausted (${details.reason}) after ${details.attempts} encode attempt(s), ` +
        `${Math.round(details.elapsedMs)} ms elapsed; search space was not exhausted`,
    );
    this.name = 'FitBudgetExhaustedError';
    this.reason = details.reason;
    this.attempts = details.attempts;
    this.elapsedMs = details.elapsedMs;
    this.maxAttempts = details.maxAttempts;
    this.deadlineMs = details.deadlineMs;
  }
}

/** Кадр превышает ресурсный лимит, заданный вызывающим кодом. */
export class ResourceLimitError extends Error {
  readonly limit: 'maxPixels' | 'maxDimension';
  readonly actual: number;
  readonly max: number;

  /**
   * @param where - ступень/контекст проверки ('image', 'frame', 'fit frame').
   * @param limit - какой лимит превышен.
   * @param actual - фактическое значение (пиксели или сторона кадра).
   * @param max - заданный вызывающим предел.
   */
  constructor(where: string, limit: 'maxPixels' | 'maxDimension', actual: number, max: number) {
    super(`${where}: ${limit} exceeded: ${actual} > ${max}`);
    this.name = 'ResourceLimitError';
    this.limit = limit;
    this.actual = actual;
    this.max = max;
  }
}

/**
 * Создать ошибку отмены. name === 'AbortError' — как в DOM.
 *
 * @returns DOMException 'AbortError', если доступна, иначе Error с тем же name.
 */
export function abortError(): Error {
  // DOMException есть и в браузерах, и в Node ≥ 17.
  if (typeof DOMException === 'function') {
    return new DOMException('The operation was aborted.', 'AbortError');
  }
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

/**
 * Бросить AbortError, если сигнал уже отменён; иначе ничего не делать.
 *
 * @param signal - необязательный AbortSignal вызывающего.
 * @throws AbortError (DOMException с name 'AbortError'), если signal.aborted.
 */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}
