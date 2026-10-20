// Ядро: image(source, pipeline, options?) и ступени конвейера.
// Каждый вызов независим: состояние живёт в замыкании конкретного вызова,
// глобального состояния у библиотеки нет (кроме default-реестра кодеков —
// он конфигурация, а не состояние обработки; вызов может дать свой реестр).

import type {
  EncodeOptions,
  EncoderRegistry,
  FitOptions,
  FitResult,
  FitSpec,
  FitStrategyContext,
  FitWarning,
  Frame,
  FrameOptions,
  ImageOptions,
  Pipeline,
  PipelineEvent,
  QuantizeOptions,
  SharpenOptions,
  StateListener,
} from './types.js';
import {
  FitBudgetExhaustedError,
  InvalidOptionsError,
  ResourceLimitError,
  throwIfAborted,
  type FitBudgetReason,
} from './errors.js';
import { decodeWithBrowser } from './decode.js';
import { defaultEncoderRegistry } from './registry.js';
import {
  analyzeFrame,
  applyFrameGeometry,
  assertFrame,
  cloneFrame,
  MONOCHROME_SATURATION_THRESHOLD,
  sharpenFrame,
} from './frame.js';
import {
  buildQualityGrid,
  collectUnsupportedFitValues,
  countPlanes,
  iteratePlanes,
  validateFitDimensions,
} from './fit/dimensions.js';
import { resolveQualityCapability } from './fit/capabilities.js';
import {
  assertStrategyHit,
  resolveFitStrategy,
  STRATEGIES,
  type ProbeOutcome,
  type ResolvedFitStrategy,
} from './fit/strategies.js';


interface PipelineLimits {
  maxPixels?: number;
  maxDimension?: number;
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function validatePipelineLimits(limits: PipelineLimits): void {
  for (const key of ['maxPixels', 'maxDimension'] as const) {
    const value = limits[key];
    if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
      throw new InvalidOptionsError(`image: ${key} must be a positive integer, got ${value}`);
    }
  }
}

function assertDimensionsWithinLimits(
  width: number,
  height: number,
  limits: PipelineLimits,
  where: string,
): void {
  if (limits.maxDimension !== undefined) {
    const actual = Math.max(width, height);
    if (actual > limits.maxDimension) {
      throw new ResourceLimitError(where, 'maxDimension', actual, limits.maxDimension);
    }
  }
  if (limits.maxPixels !== undefined) {
    const actual = width * height;
    if (actual > limits.maxPixels) {
      throw new ResourceLimitError(where, 'maxPixels', actual, limits.maxPixels);
    }
  }
}

function assertFrameWithinLimits(frame: Frame, limits: PipelineLimits, where: string): void {
  assertDimensionsWithinLimits(frame.width, frame.height, limits, where);
}

function assertFrameOptionsWithinLimits(
  src: Frame,
  options: FrameOptions,
  limits: PipelineLimits,
  where: string,
): void {
  if (limits.maxPixels === undefined && limits.maxDimension === undefined) return;
  const { width: tw, height: th } = options;
  if (!Number.isInteger(tw) || !Number.isInteger(th) || tw <= 0 || th <= 0) return;
  assertDimensionsWithinLimits(tw, th, limits, where);
  const fit = options.fit ?? 'cover';
  if (fit === 'cover') {
    const scale = Math.max(tw / src.width, th / src.height);
    const scaledW = Math.max(tw, Math.round(src.width * scale));
    const scaledH = Math.max(th, Math.round(src.height * scale));
    assertDimensionsWithinLimits(scaledW, scaledH, limits, where);
  } else {
    const scale = Math.min(tw / src.width, th / src.height);
    const scaledW = Math.max(1, Math.round(src.width * scale));
    const scaledH = Math.max(1, Math.round(src.height * scale));
    assertDimensionsWithinLimits(scaledW, scaledH, limits, where);
  }
}

function validateFitOptions(options: FitOptions): void {
  if (
    options.maxAttempts !== undefined &&
    (!Number.isInteger(options.maxAttempts) || options.maxAttempts <= 0)
  ) {
    throw new InvalidOptionsError(
      `fit: maxAttempts must be a positive integer, got ${options.maxAttempts}`,
    );
  }
  if (
    options.deadlineMs !== undefined &&
    (!Number.isFinite(options.deadlineMs) || options.deadlineMs <= 0)
  ) {
    throw new InvalidOptionsError(
      `fit: deadlineMs must be a positive finite number, got ${options.deadlineMs}`,
    );
  }
  if (
    options.onBudgetExhausted !== undefined &&
    options.onBudgetExhausted !== 'throw' &&
    options.onBudgetExhausted !== 'return-null'
  ) {
    throw new InvalidOptionsError(
      `fit: onBudgetExhausted must be 'throw' or 'return-null', got ${String(options.onBudgetExhausted)}`,
    );
  }
  if (
    options.monotonicity !== undefined &&
    options.monotonicity !== 'size' &&
    options.monotonicity !== 'none'
  ) {
    throw new InvalidOptionsError(
      `fit: monotonicity must be 'size' or 'none', got ${String(options.monotonicity)}`,
    );
  }
  if (options.onWarning !== undefined && typeof options.onWarning !== 'function') {
    throw new InvalidOptionsError('fit: onWarning must be a function');
  }
}

function assertEncoderRegistry(registry: EncoderRegistry | undefined): void {
  if (registry !== undefined && (!registry || typeof registry.get !== 'function')) {
    throw new InvalidOptionsError('image: registry must provide get(format)');
  }
}

class PipelineImpl implements Pipeline {
  #current: Frame;
  #emit: StateListener;
  #signal: AbortSignal | undefined;
  #limits: PipelineLimits;
  #registry: EncoderRegistry;

  constructor(
    initial: Frame,
    emit: StateListener,
    signal?: AbortSignal,
    limits: PipelineLimits = {},
    registry: EncoderRegistry = defaultEncoderRegistry,
  ) {
    this.#current = initial;
    this.#emit = emit;
    this.#signal = signal;
    this.#limits = limits;
    this.#registry = registry;
  }

  /** Текущий кадр (для fit и тестов; снаружи конвейера не нужен). */
  get currentFrame(): Frame {
    return this.#current;
  }

  async frame(options: FrameOptions): Promise<void> {
    throwIfAborted(this.#signal);
    assertFrameOptionsWithinLimits(this.#current, options, this.#limits, 'frame');
    const next = applyFrameGeometry(this.#current, options, this.#signal);
    throwIfAborted(this.#signal);
    this.#current = next;
    this.#emit({
      type: 'frame',
      width: this.#current.width,
      height: this.#current.height,
      fit: options.fit ?? 'cover',
      method: options.method ?? 'bilinear',
    });
  }

  async sharpen(options: SharpenOptions = {}): Promise<void> {
    throwIfAborted(this.#signal);
    const amount = options.amount ?? 0.5;
    const radius = options.radius ?? 1;
    const next = sharpenFrame(this.#current, amount, radius, this.#signal);
    throwIfAborted(this.#signal);
    this.#current = next;
    this.#emit({ type: 'sharpen', amount, radius });
  }

  async quantize(options: QuantizeOptions): Promise<void> {
    throwIfAborted(this.#signal);
    // Ленивый чанк квантования: image-q грузится только при реальном вызове.
    const { quantizeFrame } = await import('./quantize.js');
    throwIfAborted(this.#signal);
    const quantized = await quantizeFrame(
      this.#current,
      options.colors,
      options.dithering ?? 0,
      {
        algorithm: options.algorithm,
        distance: options.distance,
        serpentine: options.serpentine,
        signal: this.#signal,
      },
    );
    throwIfAborted(this.#signal);
    this.#current = quantized;
    this.#emit({
      type: 'quantize',
      colors: options.colors,
      dithering: options.dithering ?? 0,
    });
  }

  async encode(format: string, options: EncodeOptions = {}): Promise<Blob> {
    throwIfAborted(this.#signal);
    this.#emit({
      type: 'encode',
      format,
      quality: options.quality,
      channel: options.channel,
      subsampling: options.subsampling,
    });
    const blob = await this.#registry.get(format).encode(this.#current, options);
    throwIfAborted(this.#signal);
    this.#emit({
      type: 'encode-done',
      format,
      size: blob.size,
      quality: options.quality,
      channel: options.channel,
      subsampling: options.subsampling,
    });
    return blob;
  }

  async fit(
    spec: FitSpec,
    fits: (candidate: Blob) => boolean,
    options: FitOptions = {},
  ): Promise<FitResult | null> {
    throwIfAborted(this.#signal);
    if (!spec || !Array.isArray(spec.formats) || spec.formats.length === 0) {
      throw new InvalidOptionsError('fit: spec.formats must be a non-empty array');
    }
    if (typeof fits !== 'function') {
      throw new InvalidOptionsError('fit: fits predicate must be a function');
    }
    validateFitOptions(options);
    validateFitDimensions(spec);
    const getCodec = (format: string) => this.#registry.get(format);

    const startedAt = nowMs();
    const elapsedMs = (): number => nowMs() - startedAt;
    let attempts = 0;

    const makeBudgetError = (reason: FitBudgetReason): FitBudgetExhaustedError =>
      new FitBudgetExhaustedError({
        reason,
        attempts,
        elapsedMs: elapsedMs(),
        maxAttempts: options.maxAttempts,
        deadlineMs: options.deadlineMs,
      });
    const assertDeadline = (): void => {
      if (options.deadlineMs !== undefined && elapsedMs() >= options.deadlineMs) {
        throw makeBudgetError('deadline');
      }
    };
    const assertBudgetAvailable = (): void => {
      assertDeadline();
      if (options.maxAttempts !== undefined && attempts >= options.maxAttempts) {
        throw makeBudgetError('max-attempts');
      }
    };

    const warned = new Set<string>();
    const emitWarning = (warning: FitWarning, dedupeKey?: string): void => {
      const key =
        dedupeKey ?? `${warning.code}|${warning.format ?? ''}|${(warning.values ?? []).join(',')}`;
      if (warned.has(key)) return;
      warned.add(key);
      this.#emit({ type: 'warning', warning });
      try {
        options.onWarning?.(warning);
      } catch {
        /* приёмник предупреждений не имеет права ронять поиск */
      }
    };

    const requestedStrategy = resolveFitStrategy(options.strategy);
    const ownerLoopStrategy: ResolvedFitStrategy = {
      name: 'owner-loop',
      search: STRATEGIES['owner-loop'],
      custom: false,
    };
    const monotonicity = options.monotonicity ?? 'size';
    const strategy = monotonicity === 'none' ? ownerLoopStrategy : requestedStrategy;
    if (monotonicity === 'none' && requestedStrategy.name !== 'owner-loop') {
      emitWarning({
        code: 'strategy-overridden',
        message:
          `Strategy "${requestedStrategy.name}" requires a monotone size predicate; ` +
          'owner-loop is used inside every plane because monotonicity is "none".',
      });
    }

    // Геометрия — рекомендуемый первый шаг подбора: иначе вес при одном
    // качестве будет зависеть ещё и от размера исходника. Если spec.frame
    // задан, он применяется к текущему кадру; если нет — подбор идёт по
    // текущему кадру как есть (в том числе после ранее вызванного p.frame(...)).
    let base = this.#current;
    if (spec.frame) {
      assertFrameOptionsWithinLimits(this.#current, spec.frame, this.#limits, 'fit frame');
      base = applyFrameGeometry(this.#current, spec.frame, this.#signal);
      throwIfAborted(this.#signal);
      assertFrameWithinLimits(base, this.#limits, 'fit frame');
      this.#emit({
        type: 'frame',
        width: base.width,
        height: base.height,
        fit: spec.frame.fit ?? 'cover',
        method: spec.frame.method ?? 'bilinear',
      });
    }

    // Дешёвая проба насыщенности: почти-монохром поднимает grayscale раньше
    // прочих каналов (см. fit/dimensions channelLevels). Полностью
    // прозрачные пиксели analyzeFrame из насыщенности исключает.
    const saturation = analyzeFrame(base, { signal: this.#signal }).saturation;
    const monochrome = saturation <= MONOCHROME_SATURATION_THRESHOLD;
    this.#emit({ type: 'probe', saturation, monochrome });

    const grid = buildQualityGrid(spec);

    for (const unsupported of collectUnsupportedFitValues(spec, getCodec)) {
      if (unsupported.channels.length > 0) {
        emitWarning({
          code: 'unsupported-channel',
          format: unsupported.format,
          values: unsupported.channels,
          message:
            `Codec "${unsupported.format}" does not support channel(s): ` +
            `${unsupported.channels.join(', ')}; fit will use supported channels only.`,
        });
      }
      if (unsupported.subsampling.length > 0) {
        emitWarning({
          code: 'unsupported-subsampling',
          format: unsupported.format,
          values: unsupported.subsampling,
          message:
            `Codec "${unsupported.format}" does not support subsampling: ` +
            `${unsupported.subsampling.join(', ')}; fit will use supported values only.`,
        });
      }
    }

    const planesCount = countPlanes(spec, getCodec, monochrome);
    this.#emit({
      type: 'fit-start',
      formats: [...spec.formats],
      planes: planesCount,
      gridSize: grid.length,
      ownerLoopUpperBound: planesCount * grid.length,
      maxAttempts: options.maxAttempts,
      deadlineMs: options.deadlineMs,
    });

    // Квантованные кадры дороги и по CPU, и по памяти. Удерживаем не
    // более двух уровней палитры: внутри формата уровни идут подряд и
    // переиспользуются каналами/субсемплингом/вариантами, а полный набор
    // уровней на большом кадре мог бы занять сотни мегабайт.
    const MAX_CACHED_QUANTIZED_FRAMES = 2;
    const frameByColors = new Map<number | undefined, Promise<Frame>>();
    const frameFor = (colors: number | undefined): Promise<Frame> => {
      let pending = frameByColors.get(colors);
      if (!pending) {
        pending = (async () => {
          if (colors === undefined) return base;
          const { quantizeFrame } = await import('./quantize.js');
          throwIfAborted(this.#signal);
          // В поиске — БЕЗ дизеринга: его шум ломает монотонность
          // кривой «цвета → вес», на которой стоят все стратегии.
          const quantized = await quantizeFrame(base, colors, 0, {
            signal: this.#signal,
          });
          throwIfAborted(this.#signal);
          this.#emit({ type: 'quantize', colors, dithering: 0 });
          return quantized;
        })();
        frameByColors.set(colors, pending);
        if (colors !== undefined) {
          const quantizedKeys = [...frameByColors.keys()].filter((key) => key !== undefined);
          while (quantizedKeys.length > MAX_CACHED_QUANTIZED_FRAMES) {
            const oldest = quantizedKeys.shift();
            if (oldest !== undefined && oldest !== colors) frameByColors.delete(oldest);
          }
        }
      }
      return pending;
    };

    let planeIndex = 0;
    try {
      for (const plane of iteratePlanes(spec, getCodec, monochrome)) {
        const currentPlaneIndex = planeIndex;
        planeIndex += 1;
        throwIfAborted(this.#signal);
        assertBudgetAvailable();

        const codec = getCodec(plane.format);
        const baseOptions: EncodeOptions = {
          ...(plane.variant ?? {}),
          ...(plane.dimensionOptions ?? {}),
        };
        const dimensionIds = plane.dimensions
          ? Object.fromEntries(
              Object.entries(plane.dimensions).map(([name, value]) => [name, value.id]),
            )
          : undefined;
        const qualityCapability = resolveQualityCapability(codec, baseOptions);
        const fixedQuality = grid[grid.length - 1];
        if (!qualityCapability.searchesQuality) {
          emitWarning(
            {
              code: 'quality-axis-collapsed',
              format: plane.format,
              values: [String(fixedQuality)],
              message:
                `Codec "${plane.format}" does not search quality in this mode ` +
                `(role: ${qualityCapability.role}); fit uses one probe at fixed quality ${fixedQuality}.`,
            },
            `quality-axis-collapsed|${plane.format}|${qualityCapability.role}|${String(baseOptions.lossless)}`,
          );
        }

        let planeStrategy = strategy;
        if (qualityCapability.searchesQuality && !qualityCapability.monotoneSize) {
          planeStrategy = ownerLoopStrategy;
          if (requestedStrategy.name !== 'owner-loop') {
            emitWarning(
              {
                code: 'strategy-overridden',
                format: plane.format,
                message:
                  `Codec "${plane.format}" does not declare monotone size over quality; ` +
                  'owner-loop is used inside its planes.',
              },
              `strategy-overridden|${plane.format}|nonmonotone-quality`,
            );
          }
        }

        const planeFrame = await frameFor(plane.colors);
        throwIfAborted(this.#signal);
        assertDeadline();

        const effectiveGrid = qualityCapability.searchesQuality ? grid : [fixedQuality];
        const allowedQualities = new Set(effectiveGrid);
        const probed = new Map<number, ProbeOutcome>();
        const strategyContext: FitStrategyContext = {
          plane: {
            format: plane.format,
            ...(plane.colors !== undefined ? { colors: plane.colors } : {}),
            ...(plane.channel !== undefined ? { channel: plane.channel } : {}),
            ...(plane.subsampling !== undefined ? { subsampling: plane.subsampling } : {}),
            ...(plane.variant !== undefined ? { variant: plane.variant } : {}),
            ...(plane.dimensions !== undefined ? { dimensions: plane.dimensions } : {}),
          },
          planeIndex: currentPlaneIndex,
          signal: this.#signal,
          monotonicity,
          attempts: () => attempts,
          remainingAttempts: () =>
            options.maxAttempts === undefined
              ? undefined
              : Math.max(0, options.maxAttempts - attempts),
          elapsedMs,
          maxAttempts: options.maxAttempts,
          deadlineMs: options.deadlineMs,
        };

        // Кэш проб плоскости: одна эффективная точка сетки никогда не
        // кодируется дважды. qualityStep кодека дополнительно склеивает
        // соседние точки, которые его внутренняя шкала не различает.
        const cache = new Map<number, ProbeOutcome>();
        const cacheKey = (quality: number): number =>
          qualityCapability.step ? Math.round(quality / qualityCapability.step) : quality;

        const probe = async (quality: number): Promise<ProbeOutcome> => {
          throwIfAborted(this.#signal);
          if (!allowedQualities.has(quality)) {
            throw new InvalidOptionsError(
              `fit strategy "${planeStrategy.name}" probed quality ${quality} outside the quality grid`,
            );
          }
          const key = cacheKey(quality);
          const cached = cache.get(key);
          if (cached) {
            probed.set(quality, cached);
            return cached;
          }

          assertBudgetAvailable();
          attempts += 1;
          const reportedQuality = qualityCapability.passesQuality ? quality : undefined;
          this.#emit({
            type: 'encode',
            format: plane.format,
            quality: reportedQuality,
            colors: plane.colors,
            channel: plane.channel,
            subsampling: plane.subsampling,
            dimensions: dimensionIds,
            attempt: attempts,
          });
          const encodeOptions: EncodeOptions = {
            // Вариант и именованные измерения — база; размерности поиска
            // (quality/channel/subsampling) старше полей legacy-варианта.
            ...baseOptions,
            ...(qualityCapability.passesQuality ? { quality } : {}),
            ...(plane.channel !== undefined ? { channel: plane.channel } : {}),
            ...(plane.subsampling !== undefined ? { subsampling: plane.subsampling } : {}),
          };
          if (!qualityCapability.passesQuality) delete encodeOptions.quality;

          const blob = await codec.encode(planeFrame, encodeOptions);
          throwIfAborted(this.#signal);
          const outcome: ProbeOutcome = { blob, size: blob.size, fits: !!fits(blob) };
          this.#emit({
            type: 'encode-done',
            format: plane.format,
            size: blob.size,
            quality: reportedQuality,
            colors: plane.colors,
            channel: plane.channel,
            subsampling: plane.subsampling,
            dimensions: dimensionIds,
            attempt: attempts,
            fits: outcome.fits,
          });
          cache.set(key, outcome);
          probed.set(quality, outcome);
          return outcome;
        };

        const rawHit = await planeStrategy.search(probe, effectiveGrid, strategyContext);
        assertStrategyHit(rawHit, probed, planeStrategy.name);
        const hit = rawHit;
        throwIfAborted(this.#signal);
        if (hit) {
          this.#emit({ type: 'fit-done', hit: true, attempts });
          return {
            blob: hit.blob,
            params: {
              format: plane.format,
              quality: hit.quality,
              ...(plane.colors !== undefined ? { colors: plane.colors } : {}),
              ...(plane.channel !== undefined ? { channel: plane.channel } : {}),
              ...(plane.subsampling !== undefined ? { subsampling: plane.subsampling } : {}),
              ...(plane.variant !== undefined ? { variant: plane.variant } : {}),
              ...(plane.dimensions !== undefined ? { dimensions: plane.dimensions } : {}),
            },
            attempts,
          };
        }
        // Плоскость мертва даже на полу качества — следующая по визуальной цене.
      }
    } catch (error) {
      if (error instanceof FitBudgetExhaustedError) {
        this.#emit({
          type: 'fit-exhausted',
          reason: error.reason,
          attempts: error.attempts,
          elapsedMs: error.elapsedMs,
        });
        if (options.onBudgetExhausted === 'return-null') {
          this.#emit({ type: 'fit-done', hit: false, attempts });
          return null;
        }
      }
      throw error;
    }

    // Не влезло даже на полу (минимальное качество × минимальные цвета),
    // и пространство поиска при этом действительно исчерпано.
    this.#emit({ type: 'fit-done', hit: false, attempts });
    return null;
  }
}

/**
 * Запустить конвейер над источником.
 * Возвращает то, что вернул pipeline-callback (обычно Blob из p.encode
 * или FitResult | null из p.fit).
 */
export async function image<T>(
  source: Blob,
  pipeline: (p: Pipeline) => Promise<T> | T,
  options: ImageOptions = {},
): Promise<T> {
  const emit: StateListener = (event: PipelineEvent) => {
    // Сломавшийся слушатель состояния не имеет права ронять обработку.
    try {
      options.state?.(event);
    } catch {
      /* слушатель сам отвечает за свои ошибки */
    }
  };

  try {
    throwIfAborted(options.signal);
    const limits: PipelineLimits = {
      maxPixels: options.maxPixels,
      maxDimension: options.maxDimension,
    };
    validatePipelineLimits(limits);
    assertEncoderRegistry(options.registry);
    if (!(source instanceof Blob)) {
      throw new InvalidOptionsError('image: source must be a Blob or File');
    }
    emit({ type: 'decode-start' });
    const decoder = options.decoder ?? decodeWithBrowser;
    const frame = await decoder(source);
    throwIfAborted(options.signal);
    assertFrame(frame, 'decoder result');
    assertFrameWithinLimits(frame, limits, 'image');
    emit({ type: 'decode-done', width: frame.width, height: frame.height });

    const p = new PipelineImpl(
      cloneFrame(frame),
      emit,
      options.signal,
      limits,
      options.registry ?? defaultEncoderRegistry,
    );
    const result = await pipeline(p);
    throwIfAborted(options.signal);
    emit({ type: 'done' });
    return result;
  } catch (error) {
    emit({ type: 'error', error });
    throw error;
  }
}
