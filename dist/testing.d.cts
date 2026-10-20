import { r as FitQualityStrategy, w as FitStrategyHit, u as FitStrategy, x as FitStrategyName } from './types-BE1nZxM6.cjs';

/** Стратегия качества. Внутренний алиас публичного типа. */
type QualityStrategy = FitQualityStrategy;
/**
 * owner-loop — базовый цикл заказчика: качество от потолка к полу линейно,
 * первый влезший — return (ранний выход: нужен лучший ВЛЕЗШИЙ, а не
 * глобально минимальный вес). Уровни палитры и каналы перебирает общий
 * порядок плоскостей (см. dimensions.ts) — у исторического цикла каналов
 * не было, они вставлены по §4.1 ТЗ между качеством и палитрой.
 * Худший случай: вся сетка (на [0.80, 0.99] — 20 проб на плоскость).
 */
declare const ownerLoop: QualityStrategy;
/**
 * binary (умолчание): бинарный поиск границы по сетке.
 * На сетке [0.80..0.99] — ≤ 7 проб на плоскость против 20 у owner-loop.
 */
declare const binary: QualityStrategy;
/**
 * secant: ложное положение по весу. Порог предиката библиотеке неизвестен,
 * но он лежит между весами вилки (влезший пол / невлезший потолок). Целься
 * в геометрическую середину весов вилки, предсказывая качество линейной
 * интерполяцией в координатах (1/q, ln size) — для JPEG вес близок к
 * линейному по 1/q, поэтому предсказание обычно попадает в границу за
 * 1–2 пробы после вилки. Каждая проба сужает вилку как в binary, поэтому
 * результат тот же; если интерполяция не даёт новой точки — середина вилки.
 */
declare const secant: QualityStrategy;
/**
 * coarse-fine: редкая сетка сверху вниз (каждая ~4-я точка), первый влезший
 * грубый интервал уточняется бинарно. Хорош, когда граница обычно высоко:
 * грубый проход быстро «приземляется» рядом с ней, а binary по всей сетке
 * тратил бы пробы на заведомо тяжёлую середину.
 */
declare const coarseFine: QualityStrategy;

/** Реестр встроенных стратегий качества по именам. */
declare const builtInQualityStrategies: Record<FitStrategyName, FitQualityStrategy>;
/** Синтетическая кривая веса для одной плоскости качества. */
interface SyntheticQualityCurve {
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
interface QualityStrategyEvaluation {
    hit: FitStrategyHit | null;
    /** Все вызовы probe по порядку, включая cache-hit'ы. */
    probes: readonly number[];
    /** Число уникальных проб — аналог реальных энкодов fit. */
    attempts: number;
}
/** Сверка стратегии с owner-loop на той же кривой. */
interface QualityStrategyComparison {
    candidate: QualityStrategyEvaluation;
    ownerLoop: QualityStrategyEvaluation;
    matchesOwnerLoop: boolean;
}
/**
 * Прогнать одну стратегию (имя/функцию/объект) на синтетической кривой.
 *
 * @param strategy - стратегия в любой форме FitStrategy.
 * @param curve - синтетическая кривая веса одной плоскости.
 * @returns результат стратегии, все пробы по порядку и число уникальных проб.
 * @throws Error, если стратегия пробует точки вне сетки или возвращает
 *   Blob не выполненной пробы (тот же контракт, что у fit).
 */
declare function evaluateQualityStrategy(strategy: FitStrategy, curve: SyntheticQualityCurve): Promise<QualityStrategyEvaluation>;
/**
 * Сравнить стратегию с owner-loop: та же точка при монотонной кривой.
 *
 * @param strategy - проверяемая стратегия.
 * @param curve - синтетическая кривая веса.
 * @returns оба прогона и совпала ли точка результата с owner-loop.
 */
declare function compareQualityStrategyToOwnerLoop(strategy: FitStrategy, curve: SyntheticQualityCurve): Promise<QualityStrategyComparison>;
/**
 * То же сравнение, но падает ошибкой при расхождении — удобно как
 * готовая проверка в тестах авторов стратегий.
 *
 * @param strategy - проверяемая стратегия.
 * @param curve - синтетическая кривая веса.
 * @returns сравнение с owner-loop, если точки совпали.
 * @throws Error с описанием обеих точек при расхождении.
 */
declare function assertQualityStrategyMatchesOwnerLoop(strategy: FitStrategy, curve: SyntheticQualityCurve): Promise<QualityStrategyComparison>;

export { type QualityStrategyComparison, type QualityStrategyEvaluation, type SyntheticQualityCurve, assertQualityStrategyMatchesOwnerLoop, binary, builtInQualityStrategies, coarseFine, compareQualityStrategyToOwnerLoop, evaluateQualityStrategy, ownerLoop, secant };
