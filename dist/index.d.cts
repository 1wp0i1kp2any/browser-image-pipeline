import { P as Pipeline, I as ImageOptions, E as EncoderRegistry, C as Codec, F as Frame, a as FrameOptions, b as EncodeOptions, c as PngOptimizeOptions, d as PngOptimizeResult } from './types-BE1nZxM6.cjs';
export { e as ChromaSubsampling, f as CodecCapabilities, g as CodecCapabilitiesResolver, h as CodecQualityRole, i as ColorDistanceFormula, D as Decoder, j as FitDimension, k as FitDimensionValue, l as FitMonotonicity, m as FitOptions, n as FitParams, o as FitPlaneContext, p as FitProbe, q as FitProbeOutcome, r as FitQualityStrategy, s as FitResult, t as FitSpec, u as FitStrategy, v as FitStrategyContext, w as FitStrategyHit, x as FitStrategyName, y as FitStrategyObject, z as FitWarning, A as FitWarningCode, B as PaletteAlgorithm, G as PipelineEvent, H as PngOptimizerEngine, Q as QuantizeOptions, R as ResizeMethod, S as SharpenOptions, J as StateListener } from './types-BE1nZxM6.cjs';

/**
 * Запустить конвейер над источником.
 *
 * Декодирует источник один раз, затем исполняет callback со ступенями
 * frame/sharpen/quantize/encode/fit. Двойного перекодирования нет:
 * каждая ступень работает с кадром в памяти, encode выполняется один
 * раз на пробу/результат.
 *
 * @template T - тип значения, возвращаемого callback'ом.
 * @param source - исходный Blob/File изображения.
 * @param pipeline - callback ступеней; его возвращаемое значение
 *   (обычно Blob из p.encode или FitResult | null из p.fit) станет
 *   результатом image().
 * @param options - state/signal/decoder/registry и ресурсные лимиты.
 * @returns то, что вернул pipeline-callback.
 * @throws EnvironmentError вне браузера без options.decoder.
 * @throws ResourceLimitError при превышении заданных лимитов.
 * @throws AbortError при отмене через options.signal.
 */
declare function image<T>(source: Blob, pipeline: (p: Pipeline) => Promise<T> | T, options?: ImageOptions): Promise<T>;

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
declare function createEncoderRegistry(source?: EncoderRegistry): EncoderRegistry;
/** Глобальный реестр по умолчанию: сюда index.ts регистрирует встроенные кодеки. */
declare const defaultEncoderRegistry: EncoderRegistry;
/**
 * Зарегистрировать (или заменить) кодек формата в default-реестре.
 * Новый алгоритм кодирования = новая регистрация; ядро не правится.
 *
 * @param format - MIME-имя формата, например 'image/jpeg' (регистр не важен).
 * @param codec - реализация кодека с обязательным encode.
 * @throws Error, если формат пуст или у кодека нет encode.
 */
declare function registerEncoder(format: string, codec: Codec): void;
/**
 * Снять кодек формата из default-реестра.
 *
 * @param format - MIME-имя формата (регистр не важен).
 * @returns true, если кодек был зарегистрирован и удалён.
 */
declare function unregisterEncoder(format: string): boolean;
/**
 * Получить кодек default-реестра.
 *
 * @param format - MIME-имя формата (регистр не важен).
 * @returns зарегистрированный кодек.
 * @throws UnknownFormatError, если кодек формата не зарегистрирован.
 */
declare function getEncoder(format: string): Codec;
/**
 * Найти кодек default-реестра без ошибки.
 *
 * @param format - MIME-имя формата (регистр не важен).
 * @returns кодек или undefined, если формат не зарегистрирован.
 */
declare function findEncoder(format: string): Codec | undefined;
/**
 * Список форматов default-реестра.
 *
 * @returns нормализованные имена форматов в порядке регистрации.
 */
declare function registeredFormats(): string[];

/** Среда не поддерживает нужные браузерные API (SSR/Node без decoder-шовa). */
declare class EnvironmentError extends Error {
    /**
     * @param message - что именно недоступно в среде и какой шов использовать.
     */
    constructor(message: string);
}
/** Для формата не зарегистрирован энкодер. */
declare class UnknownFormatError extends Error {
    readonly format: string;
    /**
     * @param format - формат, для которого энкодер не зарегистрирован.
     */
    constructor(format: string);
}
/** Кодек не поддерживает запрошенный канал (options.channel). */
declare class UnsupportedChannelError extends Error {
    readonly format: string;
    readonly channel: string;
    /**
     * @param format - формат кодека, отклонившего канал.
     * @param channel - запрошенный неподдерживаемый канал.
     * @param supported - необязательный список поддерживаемых каналов для подсказки.
     */
    constructor(format: string, channel: string, supported?: readonly string[]);
}
/** Кодек не поддерживает нормированную опцию (subsampling/lossless/...). */
declare class UnsupportedOptionError extends Error {
    readonly format: string;
    readonly option: string;
    /**
     * @param format - формат кодека, отклонившего опцию.
     * @param option - имя нормированной опции ('subsampling', 'lossless', ...).
     * @param value - запрошенное значение (попадает в текст через JSON.stringify).
     * @param hint - необязательная подсказка, что использовать вместо.
     */
    constructor(format: string, option: string, value: unknown, hint?: string);
}
/** Некорректные аргументы ступени (диапазоны, размеры и т.п.). */
declare class InvalidOptionsError extends Error {
    /**
     * @param message - какой аргумент некорректен и что ожидалось.
     */
    constructor(message: string);
}
/** Причина остановки fit по бюджету. */
type FitBudgetReason = 'max-attempts' | 'deadline';
/**
 * fit остановлен бюджетом вызывающего до исчерпания пространства поиска.
 * Это НЕ «подходящего кандидата нет»: для доказанного no-fit fit по-прежнему
 * возвращает null.
 */
declare class FitBudgetExhaustedError extends Error {
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
    });
}
/** Кадр превышает ресурсный лимит, заданный вызывающим кодом. */
declare class ResourceLimitError extends Error {
    readonly limit: 'maxPixels' | 'maxDimension';
    readonly actual: number;
    readonly max: number;
    /**
     * @param where - ступень/контекст проверки ('image', 'frame', 'fit frame').
     * @param limit - какой лимит превышен.
     * @param actual - фактическое значение (пиксели или сторона кадра).
     * @param max - заданный вызывающим предел.
     */
    constructor(where: string, limit: 'maxPixels' | 'maxDimension', actual: number, max: number);
}

/**
 * Глубокая копия кадра (пиксели копируются в новый буфер).
 *
 * @param frame - исходный кадр; не изменяется.
 * @returns независимый кадр тех же размеров и пикселей.
 */
declare function cloneFrame(frame: Frame): Frame;
/**
 * Билинейный ресайз кадра до dstW × dstH.
 *
 * Интерполяция идёт в premultiplied-альфе: невидимый RGB полностью
 * прозрачных пикселей не имеет права окрашивать видимых соседей.
 * При итоговой альфе ~0 RGB канонически остаётся нулевым.
 *
 * @param src - исходный кадр.
 * @param dstW - целевая ширина, положительное целое.
 * @param dstH - целевая высота, положительное целое.
 * @param signal - необязательная отмена (проверяется каждые 32 строки).
 * @returns новый кадр dstW × dstH (копия, если размеры совпали).
 * @throws InvalidOptionsError при невалидном кадре/цели.
 * @throws AbortError при отмене.
 */
declare function resizeBilinear(src: Frame, dstW: number, dstH: number, signal?: AbortSignal): Frame;
/**
 * Lanczos3-ресемплинг: самый резкий даунскейл фото (выбор Squoosh/Sharp).
 *
 * @param src - исходный кадр.
 * @param dstW - целевая ширина.
 * @param dstH - целевая высота.
 * @param signal - необязательная отмена.
 * @returns новый кадр dstW × dstH.
 */
declare function resizeLanczos3(src: Frame, dstW: number, dstH: number, signal?: AbortSignal): Frame;
/**
 * Area-ресемплинг: точное усреднение по площади; лучше всех гасит муар при сильном уменьшении.
 *
 * @param src - исходный кадр.
 * @param dstW - целевая ширина.
 * @param dstH - целевая высота.
 * @param signal - необязательная отмена.
 * @returns новый кадр dstW × dstH.
 */
declare function resizeArea(src: Frame, dstW: number, dstH: number, signal?: AbortSignal): Frame;
/**
 * Unsharp mask: out = src + amount * (src - blur(src)). Альфа не трогается.
 * Классический «output sharpening» после уменьшения: amount 0.2..0.6
 * возвращает воспринимаемую резкость без заметных ореолов.
 *
 * @param src - исходный кадр.
 * @param amount - сила шарпа 0..5; 0 — копия без изменений. По умолчанию 0.5.
 * @param radius - радиус box-размытия маски, целое 1..8. По умолчанию 1.
 * @param signal - необязательная отмена (проверяется каждые 32 строки).
 * @returns новый кадр с повышенной резкостью; альфа не меняется.
 * @throws InvalidOptionsError при amount/radius вне диапазонов.
 */
declare function sharpenFrame(src: Frame, amount?: number, radius?: number, signal?: AbortSignal): Frame;
/**
 * Обесцветить кадр (ITU-R BT.709 luma), альфа сохраняется.
 *
 * @param frame - исходный кадр; не изменяется.
 * @returns новый кадр с R=G=B=luma.
 */
declare function toGrayscale(frame: Frame): Frame;
/**
 * Ступень геометрии.
 * cover:   меньшая (в относительном смысле) сторона дотягивается до целевой,
 *          большая режется по центру. Результат ровно width × height.
 * contain: кадр вписывается целиком; результат ≤ width × height, пропорции целы.
 * Масштабирование вверх разрешено (контракт: «сторона дотягивается до целевой»).
 *
 * @param src - исходный кадр.
 * @param options - целевые ширина/высота, fit ('cover' по умолчанию),
 *   method ('bilinear' по умолчанию).
 * @param signal - необязательная отмена.
 * @returns новый кадр: ровно width × height при cover, ≤ при contain.
 * @throws InvalidOptionsError при невалидных размерах/методе.
 */
declare function applyFrameGeometry(src: Frame, options: FrameOptions, signal?: AbortSignal): Frame;
/**
 * Дешёвая проба цветности кадра: средний разброс каналов (max-min)/255
 * по подвыборке (не более ~4096 пикселей). Используется fit'ом:
 * почти-монохромный кадр (манга, скриншоты, документы) — кандидат на
 * ранний grayscale.
 *
 * Почему не HSL-насыщенность: у почти белых/чёрных пикселей HSL-S
 * взрывается даже при разбросе каналов в 2/255 (бумага скана с лёгким
 * оттенком дала бы S≈0.11). Абсолютный разброс каналов такой ловушки
 * не имеет и прямо отвечает на вопрос «много ли в кадре цвета».
 *
 * @param frame - анализируемый кадр.
 * @returns средняя насыщенность выборки 0..1.
 */
declare function probeSaturation(frame: Frame): number;
/**
 * Порог «почти монохромный»: средний разброс каналов ≤ ~10/255.
 * Сканы и скриншоты с оттенком бумаги/шумом сенсора сюда попадают,
 * цветное фото — нет.
 */
declare const MONOCHROME_SATURATION_THRESHOLD = 0.04;
/** Опции анализа кадра: объём выборки и отмена. */
interface FrameAnalysisOptions {
    /** Максимум sampled-пикселей. По умолчанию 4096 — как у внутренней пробы fit. */
    maxSamples?: number;
    /** Необязательная отмена долгого анализа очень большого кадра. */
    signal?: AbortSignal;
}
/** Результат analyzeFrame: измерения кадра по статистической выборке. */
interface FrameAnalysis {
    /** Средний абсолютный разброс RGB-каналов видимых пикселей, 0..1. */
    saturation: number;
    /** saturation <= MONOCHROME_SATURATION_THRESHOLD. */
    nearMonochrome: boolean;
    /** Средняя BT.709 яркость видимых пикселей, 0..255. */
    meanLuma: number;
    /** Доля sampled-пикселей с alpha > 0, 0..1. */
    alphaCoverage: number;
    /** Средняя альфа sampled-пикселей, 0..255. */
    meanAlpha: number;
    /** Сколько пикселей реально попало в выборку. */
    sampledPixels: number;
    /** Сколько sampled-пикселей видимы (alpha > 0). */
    visibleSampledPixels: number;
    /**
     * Число занятых 5-битных RGB-корзин видимой выборки (0..32768).
     * Это приближённый индикатор разнообразия цветов, а не точное число цветов.
     */
    colorBuckets5Bit: number;
    /** colorBuckets5Bit / 32768. */
    colorBucketRatio: number;
}
/**
 * Чистый дешёвый анализ кадра по ограниченной детерминированной выборке.
 *
 * Полностью прозрачные пиксели исключаются из насыщенности, яркости и
 * цветовых корзин: их скрытый RGB не виден и не должен делать прозрачный
 * кадр «цветным». Никаких автоматических решений о формате/пресете
 * функция не принимает — она только измеряет.
 *
 * @param frame - анализируемый кадр.
 * @param options - maxSamples: предел выборки (по умолчанию 4096);
 *   signal: необязательная отмена.
 * @returns насыщенность, nearMonochrome, средняя яркость/альфа, покрытие
 *   альфы и индикатор разнообразия цветов по 5-битным корзинам.
 * @throws InvalidOptionsError при maxSamples не положительном целом.
 */
declare function analyzeFrame(frame: Frame, options?: FrameAnalysisOptions): FrameAnalysis;
/**
 * Frame → ImageData для кодеков, ждущих ImageData (@jsquash/*).
 * Вне браузера (Node-тесты с реальными wasm-кодеками) возвращает
 * структурный объект { data, width, height } — jsquash читает только поля.
 *
 * @param frame - кадр; данные копируются (результат можно мутировать).
 * @returns ImageData с копией пикселей кадра.
 */
declare function frameToImageData(frame: Frame): ImageData;
/**
 * ImageData → Frame с копией пикселей: результат независим от входа.
 *
 * @param imageData - объект с data/width/height (настоящий ImageData или структурный).
 * @returns новый кадр с копией данных.
 */
declare function imageDataToFrame(imageData: {
    data: Uint8ClampedArray;
    width: number;
    height: number;
}): Frame;

/** Набор базовых RGB-метрик compareFrames. */
interface FrameMetrics {
    /** Peak Signal-to-Noise Ratio, дБ. Infinity — кадры идентичны. */
    psnr: number;
    /** Блочная luma-аппроксимация SSIM (не эталонный Gaussian SSIM), 0..1. */
    ssim: number;
    /** Средняя абсолютная ошибка по каналам RGB, 0..255. */
    mae: number;
}
/** Опции метрик: только отмена длинных циклов по пикселям. */
interface MetricOptions {
    /** Проверяется периодически в длинных циклах метрик. */
    signal?: AbortSignal;
}
/**
 * PSNR по RGB (альфа не участвует).
 *
 * @param a - эталонный кадр.
 * @param b - сравниваемый кадр тех же размеров.
 * @param options - signal: необязательная отмена длинного цикла.
 * @returns PSNR в дБ; Infinity, если кадры побитово равны по RGB.
 */
declare function computePSNR(a: Frame, b: Frame, options?: MetricOptions): number;
/**
 * Блочная luma-аппроксимация SSIM (блоки 8×8, константы K1=0.01, K2=0.03).
 *
 * @param a - эталонный кадр.
 * @param b - сравниваемый кадр тех же размеров.
 * @param options - signal: необязательная отмена.
 * @returns среднее SSIM по блокам, обычно 0..1 (1 — идентичные кадры).
 */
declare function computeSSIM(a: Frame, b: Frame, options?: MetricOptions): number;
/**
 * Средняя абсолютная ошибка по RGB.
 *
 * @param a - эталонный кадр.
 * @param b - сравниваемый кадр тех же размеров.
 * @param options - signal: необязательная отмена.
 * @returns MAE по трём каналам, 0..255.
 */
declare function computeMAE(a: Frame, b: Frame, options?: MetricOptions): number;
/**
 * Средняя абсолютная ошибка только по альфа-каналу.
 *
 * @param a - эталонный кадр.
 * @param b - сравниваемый кадр тех же размеров.
 * @param options - signal: необязательная отмена.
 * @returns MAE альфы, 0..255.
 */
declare function computeAlphaMAE(a: Frame, b: Frame, options?: MetricOptions): number;
/**
 * Alpha-aware MAE в premultiplied-пространстве: сравниваются
 * (r*a/255, g*a/255, b*a/255, a), среднее по четырём компонентам.
 * Скрытый RGB полностью прозрачных пикселей вклада не даёт.
 *
 * @param a - эталонный кадр.
 * @param b - сравниваемый кадр тех же размеров.
 * @param options - signal: необязательная отмена.
 * @returns MAE по premultiplied-компонентам и альфе, 0..255.
 */
declare function computePremultipliedMAE(a: Frame, b: Frame, options?: MetricOptions): number;
/**
 * Все базовые RGB-метрики одним вызовом (alpha-метрики — отдельными функциями).
 *
 * @param a - эталонный кадр.
 * @param b - сравниваемый кадр тех же размеров.
 * @param options - signal: необязательная отмена.
 * @returns объект { psnr, ssim, mae }.
 */
declare function compareFrames(a: Frame, b: Frame, options?: MetricOptions): FrameMetrics;

/** Имена стартовых сценариев пресетов энкодеров. */
type PresetName = 'photo' | 'screen' | 'maxCompression' | 'lossless' | 'nearLossless';
/**
 * Стартовые пресеты EncodeOptions по форматам и сценариям.
 *
 * Quality пресеты НЕ содержат: качество и допустимый вес принадлежат
 * вызывающему. Применение: p.encode(fmt, { ...PRESETS[fmt].photo, quality }).
 */
declare const PRESETS: Record<string, Partial<Record<PresetName, EncodeOptions>>>;

/**
 * Lossless-оптимизировать готовый PNG-Blob.
 *
 * По умолчанию используется oxipng/wasm. С `engine:'compression-stream'`
 * динамически грузится отдельный модуль без wasm, который пережимает
 * только IDAT и сохраняет остальные PNG-чанки байт-в-байт.
 *
 * @param blob - готовый PNG-Blob.
 * @param options - движок и параметры оптимизации (см. PngOptimizeOptions).
 * @returns результат: Blob (оптимизированный или оригинал), размеры, движок.
 * @throws InvalidOptionsError, если вход не PNG или опции несовместимы с движком.
 */
declare function optimizePngBlob(blob: Blob, options?: PngOptimizeOptions): Promise<PngOptimizeResult>;

export { Codec, EncodeOptions, EncoderRegistry, EnvironmentError, FitBudgetExhaustedError, type FitBudgetReason, Frame, type FrameAnalysis, type FrameAnalysisOptions, type FrameMetrics, FrameOptions, ImageOptions, InvalidOptionsError, MONOCHROME_SATURATION_THRESHOLD, type MetricOptions, PRESETS, Pipeline, PngOptimizeOptions, PngOptimizeResult, type PresetName, ResourceLimitError, UnknownFormatError, UnsupportedChannelError, UnsupportedOptionError, analyzeFrame, applyFrameGeometry, cloneFrame, compareFrames, computeAlphaMAE, computeMAE, computePSNR, computePremultipliedMAE, computeSSIM, createEncoderRegistry, defaultEncoderRegistry, findEncoder, frameToImageData, getEncoder, image, imageDataToFrame, optimizePngBlob, probeSaturation, registerEncoder, registeredFormats, resizeArea, resizeBilinear, resizeLanczos3, sharpenFrame, toGrayscale, unregisterEncoder };
