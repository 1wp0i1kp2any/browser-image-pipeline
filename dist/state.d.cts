import { e as ChromaSubsampling, G as PipelineEvent, z as FitWarning, J as StateListener } from './types-BE1nZxM6.cjs';

/** Статус запуска в collector'е. */
type PipelineCollectorStatus = 'idle' | 'running' | 'done' | 'error';
/** Текущая стадия: тип последнего события конвейера или 'idle'. */
type PipelineCollectorStage = PipelineEvent['type'] | 'idle';
/** Одна попытка encode в снапшоте collector'а. */
interface PipelineAttemptSnapshot {
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
interface PipelineFitSnapshot {
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
interface PipelineTimingsSnapshot {
    startedAtMs?: number;
    updatedAtMs?: number;
    elapsedMs: number;
    stages: Readonly<Partial<Record<PipelineCollectorStage, number>>>;
}
/** Иммутабельный снаружи снимок текущего запуска. */
interface PipelineStateSnapshot {
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
/** Подписчик снапшотов collector'а: вызывается после каждого события. */
type PipelineStateSubscriber = (snapshot: PipelineStateSnapshot) => void;
/** Collector: listener в image(...), subscribe/getSnapshot — потребителю UI. */
interface StateCollector {
    /** Передайте как image(source, pipeline, { state: collector.listener }). */
    listener: StateListener;
    /** Подписаться на снапшоты после каждого события; возвращает отписку. */
    /**
     * Подписаться на обновления снапшота.
     *
     * @param subscriber - получатель снапшота после каждого события.
     * @returns функция отписки.
     */
    subscribe(subscriber: PipelineStateSubscriber): () => void;
    /** Текущий снапшот. Внутренние массивы наружу не отдаются. */
    /**
     * Текущий замороженный снапшот запуска.
     *
     * @returns иммутабельный снаружи снимок состояния.
     */
    getSnapshot(): PipelineStateSnapshot;
    /** Сбросить к idle (подписки сохраняются) и уведомить подписчиков. */
    /**
     * Сбросить состояние к idle (для повторного использования collector'а).
     */
    reset(): void;
}
/** Опции создания collector'а. */
interface CreateStateCollectorOptions {
    /** Источник монотонного времени в миллисекундах; шов для тестов. */
    now?: () => number;
}
/**
 * Создать state-collector поверх options.state.
 *
 * @param options - now: необязательный источник монотонного времени
 *   в миллисекундах (шов для тестов).
 * @returns collector: listener для image(..., { state }), subscribe,
 *   getSnapshot и reset для UI-слоя потребителя.
 */
declare function createStateCollector(options?: CreateStateCollectorOptions): StateCollector;

export { type CreateStateCollectorOptions, type PipelineAttemptSnapshot, type PipelineCollectorStage, type PipelineCollectorStatus, type PipelineFitSnapshot, type PipelineStateSnapshot, type PipelineStateSubscriber, type PipelineTimingsSnapshot, type StateCollector, createStateCollector };
