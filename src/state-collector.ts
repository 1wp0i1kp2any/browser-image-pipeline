// Необязательный state-collector поверх существующего options.state.
//
// Этот модуль намеренно отдельный (subpath `.../state`): кому достаточно
// синхронного callback'а ядра, тот не платит за снапшоты и подписки.
// Зависимостей от UI-фреймворков нет: React/Svelte/сигналы потребителя
// подписываются на getSnapshot/subscribe одной строкой.

import type {
  ChromaSubsampling,
  FitWarning,
  PipelineEvent,
  StateListener,
} from './types.js';

export type PipelineCollectorStatus = 'idle' | 'running' | 'done' | 'error';
export type PipelineCollectorStage = PipelineEvent['type'] | 'idle';

/** Одна попытка encode в снапшоте collector'а. */
export interface PipelineAttemptSnapshot {
  /** Номер попытки внутри fit; у прямого encode отсутствует. */
  attempt?: number;
  format: string;
  quality?: number;
  colors?: number;
  channel?: string;
  subsampling?: ChromaSubsampling;
  dimensions?: Readonly<Record<string, string>>;
  status: 'running' | 'done';
  size?: number;
  fits?: boolean;
  startedAtMs: number;
  endedAtMs?: number;
  durationMs?: number;
}

/** Диагностика fit, собранная из fit-start/fit-exhausted/fit-done. */
export interface PipelineFitSnapshot {
  formats: readonly string[];
  planes: number;
  gridSize: number;
  ownerLoopUpperBound: number;
  maxAttempts?: number;
  deadlineMs?: number;
  hit?: boolean;
  attempts?: number;
  exhaustedReason?: 'max-attempts' | 'deadline';
  exhaustedElapsedMs?: number;
}

/** Тайминги collector'а: суммарное время по стадиям между событиями. */
export interface PipelineTimingsSnapshot {
  startedAtMs?: number;
  updatedAtMs?: number;
  elapsedMs: number;
  stages: Readonly<Partial<Record<PipelineCollectorStage, number>>>;
}

/** Иммутабельный снаружи снимок текущего запуска. */
export interface PipelineStateSnapshot {
  status: PipelineCollectorStatus;
  stage: PipelineCollectorStage;
  width?: number;
  height?: number;
  saturation?: number;
  monochrome?: boolean;
  attempts: readonly PipelineAttemptSnapshot[];
  warnings: readonly FitWarning[];
  timings: PipelineTimingsSnapshot;
  fit?: PipelineFitSnapshot;
  error?: unknown;
}

export type PipelineStateSubscriber = (snapshot: PipelineStateSnapshot) => void;

/** Collector: listener в image(...), subscribe/getSnapshot — потребителю UI. */
export interface StateCollector {
  /** Передайте как image(source, pipeline, { state: collector.listener }). */
  listener: StateListener;
  /** Подписаться на снапшоты после каждого события; возвращает отписку. */
  subscribe(subscriber: PipelineStateSubscriber): () => void;
  /** Текущий снапшот. Внутренние массивы наружу не отдаются. */
  getSnapshot(): PipelineStateSnapshot;
  /** Сбросить к idle (подписки сохраняются) и уведомить подписчиков. */
  reset(): void;
}

export interface CreateStateCollectorOptions {
  /** Источник монотонного времени в миллисекундах; шов для тестов. */
  now?: () => number;
}

function defaultNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function cloneWarning(warning: FitWarning): FitWarning {
  return {
    ...warning,
    ...(warning.values ? { values: Object.freeze([...warning.values]) } : {}),
  };
}

export function createStateCollector(
  options: CreateStateCollectorOptions = {},
): StateCollector {
  const now = options.now ?? defaultNow;
  const subscribers = new Set<PipelineStateSubscriber>();

  let status: PipelineCollectorStatus = 'idle';
  let stage: PipelineCollectorStage = 'idle';
  let width: number | undefined;
  let height: number | undefined;
  let saturation: number | undefined;
  let monochrome: boolean | undefined;
  let attempts: PipelineAttemptSnapshot[] = [];
  let warnings: FitWarning[] = [];
  let fit: PipelineFitSnapshot | undefined;
  let error: unknown;
  let hasError = false;
  let startedAtMs: number | undefined;
  let updatedAtMs: number | undefined;
  let stageDurations = new Map<PipelineCollectorStage, number>();

  function clearRun(): void {
    status = 'idle';
    stage = 'idle';
    width = undefined;
    height = undefined;
    saturation = undefined;
    monochrome = undefined;
    attempts = [];
    warnings = [];
    fit = undefined;
    error = undefined;
    hasError = false;
    startedAtMs = undefined;
    updatedAtMs = undefined;
    stageDurations = new Map();
  }

  function getSnapshot(): PipelineStateSnapshot {
    const current = now();
    const stages: Partial<Record<PipelineCollectorStage, number>> = {};
    for (const [name, duration] of stageDurations) stages[name] = duration;
    if (status === 'running' && updatedAtMs !== undefined && stage !== 'idle') {
      stages[stage] = (stages[stage] ?? 0) + Math.max(0, current - updatedAtMs);
    }
    const elapsedMs =
      startedAtMs === undefined
        ? 0
        : Math.max(0, (status === 'running' ? current : (updatedAtMs ?? current)) - startedAtMs);

    const attemptCopies = attempts.map((attempt) =>
      Object.freeze({
        ...attempt,
        ...(attempt.dimensions
          ? { dimensions: Object.freeze({ ...attempt.dimensions }) }
          : {}),
      }),
    );
    const warningCopies = warnings.map((warning) => Object.freeze(cloneWarning(warning)));
    const fitCopy = fit
      ? Object.freeze({ ...fit, formats: Object.freeze([...fit.formats]) })
      : undefined;

    return Object.freeze({
      status,
      stage,
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
      ...(saturation !== undefined ? { saturation } : {}),
      ...(monochrome !== undefined ? { monochrome } : {}),
      attempts: Object.freeze(attemptCopies),
      warnings: Object.freeze(warningCopies),
      timings: Object.freeze({
        ...(startedAtMs !== undefined ? { startedAtMs } : {}),
        ...(updatedAtMs !== undefined ? { updatedAtMs } : {}),
        elapsedMs,
        stages: Object.freeze(stages),
      }),
      ...(fitCopy ? { fit: fitCopy } : {}),
      ...(hasError ? { error } : {}),
    });
  }

  function notify(): void {
    if (subscribers.size === 0) return;
    const snapshot = getSnapshot();
    for (const subscriber of [...subscribers]) {
      try {
        subscriber(snapshot);
      } catch {
        /* сбой подписчика не роняет обработку и других подписчиков */
      }
    }
  }

  const listener: StateListener = (event) => {
    try {
      // Повторное использование collector'а: новый decode-start после
      // терминального статуса начинает новый снимок, подписки живут.
      if ((status === 'done' || status === 'error') && event.type === 'decode-start') {
        clearRun();
      }
      const timestamp = now();
      if (startedAtMs === undefined) startedAtMs = timestamp;
      if (updatedAtMs !== undefined && stage !== 'idle') {
        stageDurations.set(
          stage,
          (stageDurations.get(stage) ?? 0) + Math.max(0, timestamp - updatedAtMs),
        );
      }
      updatedAtMs = timestamp;
      stage = event.type;
      status = event.type === 'done' ? 'done' : event.type === 'error' ? 'error' : 'running';

      switch (event.type) {
        case 'decode-done':
        case 'frame':
          width = event.width;
          height = event.height;
          break;
        case 'probe':
          saturation = event.saturation;
          monochrome = event.monochrome;
          break;
        case 'warning':
          warnings.push(cloneWarning(event.warning));
          break;
        case 'fit-start':
          fit = {
            formats: [...event.formats],
            planes: event.planes,
            gridSize: event.gridSize,
            ownerLoopUpperBound: event.ownerLoopUpperBound,
            maxAttempts: event.maxAttempts,
            deadlineMs: event.deadlineMs,
          };
          break;
        case 'fit-exhausted':
          if (fit) {
            fit = {
              ...fit,
              attempts: event.attempts,
              exhaustedReason: event.reason,
              exhaustedElapsedMs: event.elapsedMs,
            };
          }
          break;
        case 'fit-done':
          if (fit) fit = { ...fit, hit: event.hit, attempts: event.attempts };
          break;
        case 'encode':
          attempts.push({
            ...(event.attempt !== undefined ? { attempt: event.attempt } : {}),
            format: event.format,
            ...(event.quality !== undefined ? { quality: event.quality } : {}),
            ...(event.colors !== undefined ? { colors: event.colors } : {}),
            ...(event.channel !== undefined ? { channel: event.channel } : {}),
            ...(event.subsampling !== undefined ? { subsampling: event.subsampling } : {}),
            ...(event.dimensions ? { dimensions: { ...event.dimensions } } : {}),
            status: 'running',
            startedAtMs: timestamp,
          });
          break;
        case 'encode-done': {
          let match: PipelineAttemptSnapshot | undefined;
          for (let i = attempts.length - 1; i >= 0; i--) {
            const candidate = attempts[i];
            if (
              candidate.status === 'running' &&
              candidate.format === event.format &&
              candidate.attempt === event.attempt
            ) {
              match = candidate;
              break;
            }
          }
          if (!match) {
            match = {
              ...(event.attempt !== undefined ? { attempt: event.attempt } : {}),
              format: event.format,
              status: 'running',
              startedAtMs: timestamp,
            };
            attempts.push(match);
          }
          match.status = 'done';
          match.size = event.size;
          if (event.fits !== undefined) match.fits = event.fits;
          if (event.quality !== undefined) match.quality = event.quality;
          if (event.colors !== undefined) match.colors = event.colors;
          if (event.channel !== undefined) match.channel = event.channel;
          if (event.subsampling !== undefined) match.subsampling = event.subsampling;
          if (event.dimensions) match.dimensions = { ...event.dimensions };
          match.endedAtMs = timestamp;
          match.durationMs = Math.max(0, timestamp - match.startedAtMs);
          break;
        }
        case 'error':
          error = event.error;
          hasError = true;
          break;
        default:
          break;
      }
    } catch {
      /* collector — наблюдатель: его внутренняя ошибка не роняет конвейер */
    }
    notify();
  };

  return {
    listener,
    subscribe(subscriber) {
      subscribers.add(subscriber);
      return () => {
        subscribers.delete(subscriber);
      };
    },
    getSnapshot,
    reset() {
      clearRun();
      notify();
    },
  };
}
