// Стратегии поиска качества внутри одной плоскости параметров.
//
// Общее допущение (документировано в README): вес кандидата монотонен по
// качеству (больше качество — не легче), а предикат вызывающего — пороговый
// по весу (типично `candidate.size <= LIMIT`). Тогда на сетке качества есть
// граница: ниже неё всё влезает, выше — нет; стратегии ищут самую высокую
// влезшую точку сетки и отличаются только числом энкодов (проб). Результат
// у всех стратегий при этом ОДИН — та же точка, что у owner-loop: «не хуже
// базового цикла» выполнено по построению, а не по надежде.
//
// Если предикат не пороговый/не монотонный — честный выбор owner-loop:
// он идёт от лучшего качества вниз и вернёт первый влезший вариант.

import type {
  FitProbe,
  FitProbeOutcome,
  FitQualityStrategy,
  FitStrategy,
  FitStrategyHit,
  FitStrategyName,
} from '../types.js';
import { InvalidOptionsError } from '../errors.js';

/** Результат одной пробы (одного энкода). Внутренний алиас публичного типа. */
export type ProbeOutcome = FitProbeOutcome;

/** Проба качества внутри плоскости. Внутренний алиас публичного типа. */
export type Probe = FitProbe;

/** Стратегия качества. Внутренний алиас публичного типа. */
export type QualityStrategy = FitQualityStrategy;

/**
 * owner-loop — базовый цикл заказчика: качество от потолка к полу линейно,
 * первый влезший — return (ранний выход: нужен лучший ВЛЕЗШИЙ, а не
 * глобально минимальный вес). Уровни палитры и каналы перебирает общий
 * порядок плоскостей (см. dimensions.ts) — у исторического цикла каналов
 * не было, они вставлены по §4.1 ТЗ между качеством и палитрой.
 * Худший случай: вся сетка (на [0.80, 0.99] — 20 проб на плоскость).
 */
export const ownerLoop: QualityStrategy = async (probe, grid) => {
  for (let i = grid.length - 1; i >= 0; i--) {
    const out = await probe(grid[i]);
    if (out.fits) return { quality: grid[i], blob: out.blob };
  }
  return null;
};

/**
 * Вилка, с которой стартуют «умные» стратегии:
 *  - потолок влез → готово за 1 пробу (частый случай лёгких кадров);
 *  - пол не влез → плоскость мертва за 2 пробы (легче пола в этой плоскости нет);
 *  - иначе граница строго между полом (index 0, влез) и потолком (не влез).
 *
 * Дешёвая страховка: если вес пола больше веса потолка, наблюдаемые
 * данные уже противоречат монотонности по quality. Тогда стратегия
 * обязана откатиться к owner-loop по той же плоскости (пробы вилки
 * переиспользуются кэшем fit). Это ловит только инверсию на концах,
 * а не доказывает монотонность внутри.
 *
 * @param probe - проба fit: энкод точки сетки с кэшем и бюджетом.
 * @param grid - сетка качества плоскости по возрастанию.
 * @returns готовая точка/null, флаг отката к owner-loop или вилка
 *   [loIdx влез, hiIdx не влез] с результатами крайних проб.
 */
async function bracket(
  probe: Probe,
  grid: readonly number[],
): Promise<
  | { done: { quality: number; blob: Blob } | null }
  | { fallback: true }
  | { loIdx: number; hiIdx: number; lo: ProbeOutcome; hi: ProbeOutcome }
> {
  const hiIdx = grid.length - 1;
  const hi = await probe(grid[hiIdx]);
  if (hi.fits) return { done: { quality: grid[hiIdx], blob: hi.blob } };
  if (hiIdx === 0) return { done: null };
  const lo = await probe(grid[0]);
  if (lo.size > hi.size) return { fallback: true };
  if (!lo.fits) return { done: null };
  return { loIdx: 0, hiIdx, lo, hi };
}

/**
 * Довести уже найденную вилку [влез, не влез] бинарным поиском до соседних точек.
 *
 * @param probe - проба fit.
 * @param grid - сетка качества плоскости по возрастанию.
 * @param loIdx - индекс известной влезшей точки.
 * @param hiIdx - индекс известной невлезшей точки выше loIdx.
 * @param lo - результат пробы точки loIdx (её Blob и вернётся).
 * @returns самая высокая влезшая точка вилки.
 */
async function refineBinary(
  probe: Probe,
  grid: readonly number[],
  loIdx: number,
  hiIdx: number,
  lo: ProbeOutcome,
): Promise<{ quality: number; blob: Blob }> {
  while (hiIdx - loIdx > 1) {
    const mid = (loIdx + hiIdx) >> 1;
    const out = await probe(grid[mid]);
    if (out.fits) {
      loIdx = mid;
      lo = out;
    } else {
      hiIdx = mid;
    }
  }
  return { quality: grid[loIdx], blob: lo.blob };
}

/**
 * binary (умолчание): бинарный поиск границы по сетке.
 * На сетке [0.80..0.99] — ≤ 7 проб на плоскость против 20 у owner-loop.
 */
export const binary: QualityStrategy = async (probe, grid, context) => {
  const b = await bracket(probe, grid);
  if ('fallback' in b) return ownerLoop(probe, grid, context);
  if ('done' in b) return b.done;
  return refineBinary(probe, grid, b.loIdx, b.hiIdx, b.lo);
};

/**
 * secant: ложное положение по весу. Порог предиката библиотеке неизвестен,
 * но он лежит между весами вилки (влезший пол / невлезший потолок). Целься
 * в геометрическую середину весов вилки, предсказывая качество линейной
 * интерполяцией в координатах (1/q, ln size) — для JPEG вес близок к
 * линейному по 1/q, поэтому предсказание обычно попадает в границу за
 * 1–2 пробы после вилки. Каждая проба сужает вилку как в binary, поэтому
 * результат тот же; если интерполяция не даёт новой точки — середина вилки.
 */
export const secant: QualityStrategy = async (probe, grid, context) => {
  const b = await bracket(probe, grid);
  if ('fallback' in b) return ownerLoop(probe, grid, context);
  if ('done' in b) return b.done;
  let { loIdx, hiIdx, lo, hi } = b;
  // Страховочный предел: хуже линейного прохода стратегия стать не может.
  for (let guard = 0; guard <= grid.length && hiIdx - loIdx > 1; guard++) {
    const targetSize = Math.sqrt(Math.max(1, lo.size) * Math.max(1, hi.size));
    // Интерполяция в (1/q, ln size): по двум точкам вилки предсказать q.
    const xLo = 1 / grid[loIdx];
    const xHi = 1 / grid[hiIdx];
    const yLo = Math.log(Math.max(1, lo.size));
    const yHi = Math.log(Math.max(1, hi.size));
    let idx: number;
    if (Math.abs(yHi - yLo) < 1e-9 || Math.abs(xHi - xLo) < 1e-12) {
      idx = (loIdx + hiIdx) >> 1;
    } else {
      const x = xLo + ((Math.log(targetSize) - yLo) * (xHi - xLo)) / (yHi - yLo);
      const predictedQ = 1 / x;
      // Ближайшая непробованная точка сетки строго внутри вилки.
      idx = loIdx + 1;
      let bestDist = Infinity;
      for (let i = loIdx + 1; i < hiIdx; i++) {
        const dist = Math.abs(grid[i] - predictedQ);
        if (dist < bestDist) {
          bestDist = dist;
          idx = i;
        }
      }
    }
    const out = await probe(grid[idx]);
    if (out.fits) {
      loIdx = idx;
      lo = out;
    } else {
      hiIdx = idx;
      hi = out;
    }
  }
  return { quality: grid[loIdx], blob: lo.blob };
};

/**
 * coarse-fine: редкая сетка сверху вниз (каждая ~4-я точка), первый влезший
 * грубый интервал уточняется бинарно. Хорош, когда граница обычно высоко:
 * грубый проход быстро «приземляется» рядом с ней, а binary по всей сетке
 * тратил бы пробы на заведомо тяжёлую середину.
 */
export const coarseFine: QualityStrategy = async (probe, grid, context) => {
  const b = await bracket(probe, grid);
  if ('fallback' in b) return ownerLoop(probe, grid, context);
  if ('done' in b) return b.done;

  const step = Math.max(1, Math.round(grid.length / 4));
  let upperNotFit = b.hiIdx; // ближайший сверху невлезший индекс
  let fitIdx = b.loIdx;
  let fitOut: ProbeOutcome = b.lo;
  for (let i = b.hiIdx - step; i > b.loIdx; i -= step) {
    const out = await probe(grid[i]);
    if (out.fits) {
      fitIdx = i;
      fitOut = out;
      break;
    }
    upperNotFit = i;
  }
  return refineBinary(probe, grid, fitIdx, upperNotFit, fitOut);
};


/** Встроенные стратегии качества по именам. */
export const STRATEGIES: Record<FitStrategyName, QualityStrategy> = {
  'owner-loop': ownerLoop,
  binary,
  secant,
  'coarse-fine': coarseFine,
};

/** Стратегия по умолчанию, если FitOptions.strategy не задана. */
export const DEFAULT_STRATEGY: FitStrategyName = 'binary';

/** Разрешённая fit-движком стратегия: имя для диагностики + функция поиска. */
export interface ResolvedFitStrategy {
  /** Имя стратегии для ошибок и диагностики. */
  name: string;
  /** Функция поиска точки качества внутри одной плоскости. */
  search: FitQualityStrategy;
  /** true, если стратегию дал вызывающий функцией/объектом. */
  custom: boolean;
}

const BUILT_IN_NAMES = new Set<string>(Object.keys(STRATEGIES));

/**
 * Привести FitOptions.strategy (имя/функция/объект) к одной форме.
 *
 * @param strategy - стратегия вызывающего; undefined — умолчание 'binary'.
 * @returns имя для диагностики, функция поиска и флаг пользовательской стратегии.
 * @throws InvalidOptionsError при неизвестном имени или невалидной форме.
 */
export function resolveFitStrategy(strategy: FitStrategy | undefined): ResolvedFitStrategy {
  if (strategy === undefined) {
    return { name: DEFAULT_STRATEGY, search: STRATEGIES[DEFAULT_STRATEGY], custom: false };
  }
  if (typeof strategy === 'string') {
    if (!BUILT_IN_NAMES.has(strategy)) {
      throw new InvalidOptionsError(`fit: unknown strategy "${strategy}"`);
    }
    const name = strategy as FitStrategyName;
    return { name, search: STRATEGIES[name], custom: false };
  }
  if (typeof strategy === 'function') {
    return { name: strategy.name || 'custom strategy', search: strategy, custom: true };
  }
  if (strategy && typeof strategy === 'object' && typeof strategy.search === 'function') {
    if (
      strategy.name !== undefined &&
      (typeof strategy.name !== 'string' || strategy.name.trim() === '')
    ) {
      throw new InvalidOptionsError('fit: strategy.name must be a non-empty string');
    }
    return {
      name: strategy.name ?? 'custom strategy',
      search: strategy.search.bind(strategy),
      custom: true,
    };
  }
  throw new InvalidOptionsError(
    'fit: strategy must be a built-in name, a function, or an object with search()',
  );
}

/**
 * Контракт возвращаемого стратегией результата: либо null, либо Blob
 * реально выполненной пробы с fits=true ровно на возвращённом quality.
 * Стратегия не вправе изобрести Blob или объявить влезшей непробованную точку.
 *
 * @param hit - значение, возвращённое стратегией (проверяется как unknown).
 * @param probed - все реально выполненные пробы плоскости по quality.
 * @param strategyName - имя стратегии для текста ошибки.
 * @throws InvalidOptionsError при любом нарушении контракта результата.
 */
export function assertStrategyHit(
  hit: unknown,
  probed: ReadonlyMap<number, FitProbeOutcome>,
  strategyName: string,
): asserts hit is FitStrategyHit | null {
  const fail = (detail: string): never => {
    throw new InvalidOptionsError(`fit strategy "${strategyName}" ${detail}`);
  };
  if (hit === null) return;
  if (!hit || typeof hit !== 'object') {
    fail('must return a hit object or null');
  }
  const candidate = hit as { quality?: unknown; blob?: unknown };
  if (typeof candidate.quality !== 'number' || !Number.isFinite(candidate.quality)) {
    fail('returned an invalid quality');
  }
  const outcome = probed.get(candidate.quality as number);
  if (!outcome) {
    fail(`returned quality ${candidate.quality} without probing it`);
  } else if (candidate.blob !== outcome.blob) {
    fail(`returned a Blob that does not match the probe at quality ${candidate.quality}`);
  } else if (!outcome.fits) {
    fail(`returned a non-fitting probe at quality ${candidate.quality}`);
  }
}
