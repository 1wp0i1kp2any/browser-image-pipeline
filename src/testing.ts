// Тестовый harness для авторов пользовательских стратегий качества.
//
// Отдельный subpath `.../testing`: runtime-потребителю библиотеки harness
// не нужен. Он гоняет стратегию по синтетической кривой веса через тот же
// контракт пробы, что и fit (сетка, контекст, запрет выдуманных Blob),
// и сверяет результат с owner-loop.

import type {
  FitProbeOutcome,
  FitStrategy,
  FitStrategyContext,
  FitStrategyHit,
} from './types.js';
import {
  assertStrategyHit,
  ownerLoop,
  resolveFitStrategy,
  STRATEGIES,
} from './fit/strategies.js';

export { binary, coarseFine, ownerLoop, secant } from './fit/strategies.js';
export const builtInQualityStrategies = STRATEGIES;

/** Синтетическая кривая веса для одной плоскости качества. */
export interface SyntheticQualityCurve {
  /** Сетка качества по возрастанию. Пробы вне сетки запрещены. */
  grid: readonly number[];
  /** Размер Blob'а для качества. Для equivalence-тестов должен быть неубывающим. */
  sizeAt: (quality: number) => number;
  /** Порог по размеру. Укажите ровно один из maxSize/fits. */
  maxSize?: number;
  /** Произвольный предикат кандидата. Укажите ровно один из maxSize/fits. */
  fits?: (candidate: Blob) => boolean;
}

/** Результат прогона одной стратегии на синтетической кривой. */
export interface QualityStrategyEvaluation {
  hit: FitStrategyHit | null;
  /** Все вызовы probe по порядку, включая cache-hit'ы. */
  probes: readonly number[];
  /** Число уникальных проб — аналог реальных энкодов fit. */
  attempts: number;
}

/** Сверка стратегии с owner-loop на той же кривой. */
export interface QualityStrategyComparison {
  candidate: QualityStrategyEvaluation;
  ownerLoop: QualityStrategyEvaluation;
  matchesOwnerLoop: boolean;
}

function validateCurve(curve: SyntheticQualityCurve): void {
  if (!curve || !Array.isArray(curve.grid) || curve.grid.length === 0) {
    throw new Error('synthetic curve: grid must be a non-empty array');
  }
  if (typeof curve.sizeAt !== 'function') {
    throw new Error('synthetic curve: sizeAt must be a function');
  }
  if ((curve.maxSize === undefined) === (curve.fits === undefined)) {
    throw new Error('synthetic curve: specify exactly one of maxSize or fits');
  }
  let previous = -Infinity;
  for (const quality of curve.grid) {
    if (!Number.isFinite(quality) || quality < 0 || quality > 1 || quality <= previous) {
      throw new Error('synthetic curve: grid must be strictly ascending within [0, 1]');
    }
    previous = quality;
  }
}

/** Прогнать одну стратегию (имя/функцию/объект) на синтетической кривой. */
export async function evaluateQualityStrategy(
  strategy: FitStrategy,
  curve: SyntheticQualityCurve,
): Promise<QualityStrategyEvaluation> {
  validateCurve(curve);
  const resolved = resolveFitStrategy(strategy);
  const allowed = new Set(curve.grid);
  const cache = new Map<number, FitProbeOutcome>();
  const probes: number[] = [];
  const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();

  const context: FitStrategyContext = {
    plane: { format: 'image/synthetic' },
    planeIndex: 0,
    monotonicity: 'size',
    attempts: () => cache.size,
    remainingAttempts: () => undefined,
    elapsedMs: () =>
      (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt,
  };

  const probe = async (quality: number): Promise<FitProbeOutcome> => {
    if (!allowed.has(quality)) {
      throw new Error(
        `strategy "${resolved.name}" probed quality ${quality} outside the quality grid`,
      );
    }
    probes.push(quality);
    const cached = cache.get(quality);
    if (cached) return cached;
    const size = curve.sizeAt(quality);
    if (!Number.isInteger(size) || size < 0) {
      throw new Error(`synthetic curve: sizeAt(${quality}) must be a non-negative integer`);
    }
    const blob = new Blob([new Uint8Array(size)], { type: 'image/synthetic' });
    const outcome: FitProbeOutcome = {
      blob,
      size,
      fits: curve.fits ? !!curve.fits(blob) : size <= curve.maxSize!,
    };
    cache.set(quality, outcome);
    return outcome;
  };

  const rawHit = await resolved.search(probe, curve.grid, context);
  assertStrategyHit(rawHit, cache, resolved.name);
  return {
    hit: rawHit,
    probes: Object.freeze([...probes]),
    attempts: cache.size,
  };
}

/** Сравнить стратегию с owner-loop: та же точка при монотонной кривой. */
export async function compareQualityStrategyToOwnerLoop(
  strategy: FitStrategy,
  curve: SyntheticQualityCurve,
): Promise<QualityStrategyComparison> {
  const candidate = await evaluateQualityStrategy(strategy, curve);
  const reference = await evaluateQualityStrategy(ownerLoop, curve);
  const matchesOwnerLoop =
    candidate.hit === null || reference.hit === null
      ? candidate.hit === reference.hit
      : candidate.hit.quality === reference.hit.quality &&
        candidate.hit.blob.size === reference.hit.blob.size;
  return { candidate, ownerLoop: reference, matchesOwnerLoop };
}

/**
 * То же сравнение, но падает ошибкой при расхождении — удобно как
 * готовая проверка в тестах авторов стратегий.
 */
export async function assertQualityStrategyMatchesOwnerLoop(
  strategy: FitStrategy,
  curve: SyntheticQualityCurve,
): Promise<QualityStrategyComparison> {
  const comparison = await compareQualityStrategyToOwnerLoop(strategy, curve);
  if (!comparison.matchesOwnerLoop) {
    const describe = (hit: FitStrategyHit | null) =>
      hit ? `q=${hit.quality} size=${hit.blob.size}` : 'null';
    throw new Error(
      `strategy does not match owner-loop: candidate ${describe(comparison.candidate.hit)}, ` +
        `owner-loop ${describe(comparison.ownerLoop.hit)}`,
    );
  }
  return comparison;
}
