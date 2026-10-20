// Публичные типы библиотеки. Всё, что видит вызывающий код, описано здесь;
// внутренних типов ступеней наружу не торчит.

/**
 * Кадр: ImageData-подобная структура (RGBA, 8 бит на канал).
 * Это валюта, которой ступени обмениваются друг с другом.
 */
export interface Frame {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Метод ресемплинга геометрии. */
export type ResizeMethod = 'bilinear' | 'lanczos3' | 'area';

/** Параметры ступени геометрии (`p.frame`). */
export interface FrameOptions {
  width: number;
  height: number;
  /**
   * cover   — накрыть целевой прямоугольник целиком, лишнее обрезать по центру.
   *           Результат — ровно width × height.
   * contain — вписать целиком с сохранением пропорций. Результат может быть
   *           меньше целевого по одной из сторон (полей библиотека не дорисовывает).
   * По умолчанию 'cover'.
   */
  fit?: 'cover' | 'contain';
  /**
   * Ядро ресемплинга:
   *  - 'bilinear' — быстро, мягко (историческое умолчание библиотеки);
   *  - 'lanczos3' — окно sinc(a=3) с масштабированием ядра при уменьшении:
   *    самая резкая картинка и лучшее подавление алиасинга при даунскейле
   *    фото (выбор Squoosh/Sharp); на жёсткой графике возможен лёгкий ringing;
   *  - 'area' — честное усреднение по площади исходных пикселей: лучше всего
   *    гасит муар/шум при сильном уменьшении скриншотов и текстур.
   * По умолчанию 'bilinear'.
   */
  method?: ResizeMethod;
}

/** Параметры ступени повышения резкости (`p.sharpen`, unsharp mask). */
export interface SharpenOptions {
  /** Сила 0..5. Типичный «output sharpening» после даунскейла — 0.2..0.6. По умолчанию 0.5. */
  amount?: number;
  /** Радиус размытия маски в пикселях (1..8). По умолчанию 1. */
  radius?: number;
}

/** Алгоритм построения палитры (image-q). */
export type PaletteAlgorithm =
  | 'wuquant'
  | 'rgbquant'
  | 'neuquant'
  | 'neuquant-float'
  | 'fast-median-cut';

/** Формула цветового расстояния (image-q). */
export type ColorDistanceFormula =
  | 'pngquant'
  | 'euclidean'
  | 'euclidean-bt709'
  | 'euclidean-bt709-noalpha'
  | 'manhattan'
  | 'manhattan-bt709'
  | 'manhattan-nommyde'
  | 'color-metric'
  | 'cie94-textiles'
  | 'cie94-graphic-arts'
  | 'ciede2000';

/** Параметры ступени квантования палитры (`p.quantize`). */
export interface QuantizeOptions {
  /** Целевое число цветов палитры (2..256). */
  colors: number;
  /**
   * Сила дизеринга 0..1 (Floyd–Steinberg с коэффициентом силы).
   * 0 — без дизеринга (nearest), 1 — полный. По умолчанию 0.
   */
  dithering?: number;
  /**
   * Алгоритм палитры: 'wuquant' (по умолчанию; быстрый и качественный),
   * 'rgbquant' (хорош на малых палитрах), 'neuquant'/'neuquant-float'
   * (нейросетевой, медленнее, иногда точнее на фото), 'fast-median-cut'
   * (собственный детерминированный median-cut без image-q: заметно быстрее
   * строит палитру, но обычно грубее wuquant; distance для него euclidean).
   */
  algorithm?: PaletteAlgorithm;
  /**
   * Формула цветового расстояния при построении палитры.
   * 'pngquant' (по умолчанию) — перцептивная эвристика pngquant;
   * 'ciede2000' — самая точная перцептивно и самая медленная.
   */
  distance?: ColorDistanceFormula;
  /**
   * Serpentine-проход дизеринга (строки поочерёдно в разные стороны):
   * меньше направленных артефактов-«червяков». По умолчанию false.
   */
  serpentine?: boolean;
}

/** Субсемплинг цветности в общепринятой записи J:a:b. */
export type ChromaSubsampling = '4:4:4' | '4:2:2' | '4:2:0' | '4:0:0';

/**
 * Опции энкодера. `quality`, `channel`, `subsampling`, `effort`, `lossless`
 * — нормированные библиотекой поля, всё остальное пробрасывается кодеку как
 * есть (например, у @jsquash/jpeg: `progressive`, `color_space`,
 * `quant_table`, `trellis_*`, `smoothing`; у webp: `sns_strength`,
 * `use_sharp_yuv`; у avif: `tune`, `denoiseLevel`; у png: `oxipngLevel`).
 */
export interface EncodeOptions {
  /**
   * Качество 0..1. Кодек сам отображает его в свою шкалу. Шкалы разных
   * форматов не эквивалентны: AVIF 0.5 визуально крепче JPEG 0.5.
   */
  quality?: number;
  /**
   * Канал/цветовое пространство энкодера в терминах кодека
   * (для jpeg: 'grayscale' | 'rgb' | 'ycbcr'). Кодек, не поддерживающий канал,
   * обязан бросить UnsupportedChannelError, а не молча игнорировать.
   */
  channel?: string;
  /**
   * Субсемплинг цветности. Поддержка по кодекам: jpeg — '4:4:4' и '4:2:0'
   * (без опции MozJPEG выбирает сам по качеству); avif — все четыре;
   * webp lossy всегда 4:2:0 (иное значение — UnsupportedOptionError);
   * png субсемплинга не имеет. 4:4:4 заметно сохраняет цветные края
   * (текст, логотипы) ценой веса; для фото обычно достаточно 4:2:0.
   */
  subsampling?: ChromaSubsampling;
  /**
   * Усилие энкодера 0..1: время в обмен на вес при ТОМ ЖЕ качестве.
   * Отображение: webp → method 0..6; avif → speed 10..0 (инверсия);
   * jpeg → trellis-оптимизации MozJPEG; png → уровень oxipng 0..6
   * (включает пост-оптимизацию). Визуального качества почти не меняет,
   * поэтому в fit измерением перебора не является — ставится константой.
   */
  effort?: number;
  /**
   * Без потерь. webp/avif — родной lossless; png lossless всегда;
   * jpeg (MozJPEG) lossless не умеет — UnsupportedOptionError.
   */
  lossless?: boolean;
  [option: string]: unknown;
}

/** Роль нормированного quality для конкретного режима кодека. */
export type CodecQualityRole = 'quality' | 'effort' | 'ignored';

/**
 * Возможности кодека, которые fit использует при построении поиска.
 * Все поля необязательны: старый кодек без capabilities трактуется как
 * поддерживающий монотонное по размеру quality (историческое поведение).
 */
export interface CodecCapabilities {
  /** Влияет ли options.quality на кодирование. По умолчанию true. */
  quality?: boolean;
  /**
   * Что означает quality в этом режиме:
   * 'quality' — обычная ось качества; 'effort' — усилие при неизменных
   * пикселях (WebP lossless), fit фиксирует верх сетки; 'ignored' — кодек
   * значение игнорирует (PNG, AVIF lossless), fit его не передаёт.
   */
  qualityRole?: CodecQualityRole;
  /**
   * Можно ли считать размер невозрастающим при снижении quality.
   * false заставляет fit использовать owner-loop внутри плоскости.
   */
  monotoneQualitySize?: boolean;
  /**
   * Шаг внутренней шкалы quality (например, 0.01 для шкалы 0..100).
   * fit использует его только чтобы не кодировать дважды соседние точки
   * сетки, которые кодек всё равно отображает в одно значение.
   */
  qualityStep?: number;
  /** Поддерживает ли кодек нормированный lossless. */
  lossless?: boolean;
  /** Поддерживает ли кодек нормированный effort. */
  effort?: boolean;
}

/**
 * Capabilities могут зависеть от режима кодирования (например, lossless
 * из варианта плоскости), поэтому кодек вправе вернуть функцию.
 */
export type CodecCapabilitiesResolver = (options: EncodeOptions) => CodecCapabilities;

/**
 * Кодек формата. Регистрируется через registerEncoder; встроенные jpeg/png
 * регистрируются ровно тем же механизмом и ничем не привилегированы.
 */
export interface Codec {
  encode(frame: Frame, options?: EncodeOptions): Promise<Blob>;
  decode?(blob: Blob): Promise<Frame>;
  /** Необязательные возможности для fit; см. CodecCapabilities. */
  capabilities?: CodecCapabilities | CodecCapabilitiesResolver;
  /**
   * Каналы, которые кодек умеет принимать в `options.channel`, в порядке
   * предпочтения кодека. Первый считается каналом по умолчанию.
   * `fit` пересекает этот список со spec.channels.
   */
  channels?: readonly string[];
  /**
   * Субсемплинги цветности, которые кодек умеет принимать в
   * `options.subsampling`; первый — по умолчанию. `fit` пересекает
   * этот список со spec.subsampling.
   */
  subsampling?: readonly ChromaSubsampling[];
}

/**
 * Изолированный реестр энкодеров. Глобальные registerEncoder/getEncoder —
 * обёртки над default-реестром; отдельный реестр позволяет двум вызовам
 * image() использовать разные кодеки одного MIME без протечек состояния.
 */
export interface EncoderRegistry {
  /** Зарегистрировать или заменить кодек формата в этом реестре. */
  register(format: string, codec: Codec): void;
  /** Снять кодек формата. true, если кодек был. */
  unregister(format: string): boolean;
  /** Кодек или UnknownFormatError. */
  get(format: string): Codec;
  /** Кодек или undefined. */
  find(format: string): Codec | undefined;
  /** Зарегистрированные форматы в порядке регистрации. */
  formats(): string[];
  /** Независимая копия текущих регистраций. */
  clone(): EncoderRegistry;
}

/** Движок lossless-оптимизации готового PNG. */
export type PngOptimizerEngine = 'oxipng' | 'compression-stream';

/** Опции lossless-оптимизации готового PNG. */
export interface PngOptimizeOptions {
  /**
   * Движок оптимизации. По умолчанию 'oxipng' (wasm). 'compression-stream'
   * использует отдельный ленивый модуль без wasm: он только пережимает
   * zlib-поток IDAT и сохраняет все остальные чанки байт-в-байт.
   */
  engine?: PngOptimizerEngine;
  /** Уровень oxipng 1..6. По умолчанию 2, если не задан effort. Только oxipng. */
  level?: number;
  /** Усилие 0..1 → уровень 1..6, если level не задан. Только oxipng. */
  effort?: number;
  /** Переписать как Adam7 interlaced. Обычно увеличивает вес. По умолчанию false. Только oxipng. */
  interlace?: boolean;
  /** Разрешить oxipng оптимизацию альфы. По умолчанию false. Только oxipng. */
  optimiseAlpha?: boolean;
  /**
   * Принимать результат только если он меньше входа. По умолчанию true.
   * Политика сохранения цветовых PNG-чанков действует в любом случае.
   */
  onlyIfSmaller?: boolean;
  /** Отмена долгой оптимизации. */
  signal?: AbortSignal;
}

/** Результат optimizePngBlob: optimized=false значит возвращён исходный Blob. */
export interface PngOptimizeResult {
  blob: Blob;
  optimized: boolean;
  originalSize: number;
  size: number;
  /** Фактически использованный движок; поле аддитивно добавлено в v0.6.0. */
  engine?: PngOptimizerEngine;
}

/** Декодер источника в кадр. Шов для тестов и нестандартных сред. */
export type Decoder = (source: Blob) => Promise<Frame>;

/** Одно значение именованного категориального измерения fit. */
export interface FitDimensionValue {
  /** Стабильный идентификатор значения внутри измерения (для params/state). */
  id: string;
  /** Опции энкодера, применяемые на плоскостях с этим значением. */
  options: EncodeOptions;
}

/** Именованное категориальное измерение fit: значения в порядке предпочтения. */
export interface FitDimension {
  name: string;
  values: readonly FitDimensionValue[];
}

/** Спецификация подбора (`p.fit`). */
export interface FitSpec {
  /** Форматы в порядке предпочтения: первый — самый желанный. */
  formats: string[];
  /** Диапазон качества [пол, потолок], обе границы 0..1. Пол задаёт вызывающий. */
  quality: [number, number];
  /**
   * Диапазон цветов палитры [минимум, максимум]. Не задан — палитра в переборе
   * не участвует. Уровни перебора: без квантования, затем max, max/2, ... до min.
   */
  colors?: [number, number];
  /**
   * Разрешённые каналы в порядке предпочтения (opt-in: потеря цвета через
   * 'grayscale' — решение вызывающего). Не задан — только канал кодека по умолчанию.
   */
  channels?: string[];
  /**
   * Разрешённые субсемплинги цветности в порядке предпочтения (opt-in
   * измерение после каналов): например ['4:4:4', '4:2:0'] — сначала пробуем
   * сохранить цветные края, потом сдаёмся на 4:2:0. Пересекается с
   * возможностями кодека (codec.subsampling); выбор кодека по умолчанию
   * идёт первым.
   */
  subsampling?: ChromaSubsampling[];
  /**
   * Произвольные варианты опций энкодера — универсальное измерение перебора
   * для любого параметра кодека (smoothing, quant_table, tune, near_lossless,
   * oxipngLevel...). Варианты пробуются в заданном порядке после
   * каналов/субсемплинга и до углубления палитры; quality/channel/subsample
   * из варианта НЕ перезатирают размерности поиска. Порядок вариантов —
   * от «красивее» к «легче»: вызывающий сам отвечает за монотонность смысла.
   */
  variants?: EncodeOptions[];
  /**
   * Именованные категориальные измерения: независимые наборы опций кодека.
   * Движок перечисляет их декартово произведение плоскостями в заданном
   * порядке после variants; монотонность этим значениям не приписывается
   * и бинарный поиск по ним не применяется. Singleton-измерение — fixed:
   * его единственное значение применяется всегда. Ключи опций разных
   * измерений (и variants) не должны пересекаться; normalized quality,
   * channel и subsampling задаются своими измерениями spec, а не здесь.
   */
  dimensions?: readonly FitDimension[];
  /**
   * Геометрия первым шагом подбора. Если `p.frame(...)` уже был вызван до fit,
   * можно не указывать. Если не указано ни там ни там — подбор идёт по кадру
   * исходного размера (не рекомендуется: вес будет зависеть от исходника).
   */
  frame?: FrameOptions;
}

/** Имена встроенных стратегий поиска качества внутри плоскости параметров. */
export type FitStrategyName = 'owner-loop' | 'binary' | 'secant' | 'coarse-fine';

/** Результат одной пробы качества, который fit отдаёт стратегии. */
export interface FitProbeOutcome {
  blob: Blob;
  size: number;
  fits: boolean;
}

/**
 * Проба одной точки сетки внутри текущей плоскости. Энкод, кэш, бюджет,
 * AbortSignal и сам Blob-предикат вызывающего принадлежат fit-движку;
 * стратегия видит только размер и вердикт fits. Качество вне переданной
 * сетки пробовать запрещено.
 */
export type FitProbe = (quality: number) => Promise<FitProbeOutcome>;

/** Точка, которую стратегия возвращает как лучшую влезшую в плоскости. */
export interface FitStrategyHit {
  quality: number;
  blob: Blob;
}

/** Снимок плоскости, внутри которой работает стратегия качества. */
export interface FitPlaneContext {
  format: string;
  colors?: number;
  channel?: string;
  subsampling?: ChromaSubsampling;
  variant?: EncodeOptions;
  dimensions?: Readonly<Record<string, FitDimensionValue>>;
}

/** Контекст одной плоскости для пользовательской стратегии качества. */
export interface FitStrategyContext {
  plane: FitPlaneContext;
  /** Индекс плоскости в общем порядке перебора, 0-based. */
  planeIndex: number;
  signal?: AbortSignal;
  monotonicity: FitMonotonicity;
  /** Сколько реальных энкодов уже выполнил весь fit к моменту вызова. */
  attempts(): number;
  /** Сколько энкодов осталось по maxAttempts; undefined — бюджет не задан. */
  remainingAttempts(): number | undefined;
  /** Сколько миллисекунд прошло от входа в fit к моменту вызова. */
  elapsedMs(): number;
  maxAttempts?: number;
  deadlineMs?: number;
}

/**
 * Пользовательская стратегия качества. Её власть ограничена одной
 * плоскостью и одной сеткой quality: форматами и порядком плоскостей
 * управляет fit. Возвращённый Blob обязан быть blob'ом выполненной пробы
 * с fits=true на возвращённом quality.
 */
export type FitQualityStrategy = (
  probe: FitProbe,
  grid: readonly number[],
  context: FitStrategyContext,
) => Promise<FitStrategyHit | null>;

/** Стратегия объектом: та же функция плюс необязательное имя для диагностики. */
export interface FitStrategyObject {
  readonly name?: string;
  search: FitQualityStrategy;
}

/** Стратегия fit: встроенное имя, функция или объект с search(). */
export type FitStrategy = FitStrategyName | FitQualityStrategy | FitStrategyObject;

/**
 * Что fit вправе предполагать о монотонности внутри плоскости:
 * 'size' — вес не убывает с ростом quality, предикат пороговый по весу
 * (условие ускоренных стратегий); 'none' — предикат произвольный или
 * вес немонотонен, поэтому внутри плоскости всегда owner-loop.
 */
export type FitMonotonicity = 'size' | 'none';

/** Код предупреждения fit (мягкая деградация вместо ошибки в поиске). */
export type FitWarningCode =
  | 'unsupported-channel'
  | 'unsupported-subsampling'
  | 'quality-axis-collapsed'
  | 'strategy-overridden';

/** Предупреждение fit: поиск продолжен, но не совсем так, как просил spec. */
export interface FitWarning {
  code: FitWarningCode;
  message: string;
  format?: string;
  values?: readonly string[];
}

export interface FitOptions {
  /**
   * Стратегия поиска внутри плоскости: встроенное имя, функция или объект.
   * По умолчанию 'binary'. При monotonicity:'none' или немонотонной
   * capabilities-оси fit принудительно заменяет её на owner-loop.
   */
  strategy?: FitStrategy;
  /**
   * Максимальное число реальных энкодов на весь fit (все форматы и
   * плоскости; cache-hit пробой не считается). Не задан — без лимита.
   */
  maxAttempts?: number;
  /**
   * Дедлайн поиска в миллисекундах от входа в fit. Проверяется между
   * плоскостями и пробами; уже запущенный wasm-энкод не прерывается.
   */
  deadlineMs?: number;
  /**
   * Что делать при исчерпании бюджета: 'throw' (по умолчанию, если
   * бюджет задан) — FitBudgetExhaustedError; 'return-null' — явный
   * opt-in вернуть null. Внимание: такой null НЕ доказывает, что
   * подходящего кандидата не существует: поиск был остановлен.
   */
  onBudgetExhausted?: 'throw' | 'return-null';
  /** Монотонность предиката/веса. По умолчанию 'size'. */
  monotonicity?: FitMonotonicity;
  /** Необязательный приёмник предупреждений (дублируются в state). */
  onWarning?: (warning: FitWarning) => void;
}

/** Параметры, на которых подбор попал в предикат. */
export interface FitParams {
  format: string;
  quality: number;
  /** Число цветов палитры; отсутствует — квантование не применялось. */
  colors?: number;
  /** Канал энкодера; отсутствует — канал кодека по умолчанию. */
  channel?: string;
  /** Субсемплинг; отсутствует — выбор кодека по умолчанию. */
  subsampling?: ChromaSubsampling;
  /** Применённый вариант из spec.variants; отсутствует — варианты не задавались. */
  variant?: EncodeOptions;
  /** Выбранные значения spec.dimensions по имени измерения. */
  dimensions?: Readonly<Record<string, FitDimensionValue>>;
}

export interface FitResult {
  blob: Blob;
  params: FitParams;
  /** Сколько энкодов реально выполнил поиск (счётчик для отчётов и демо). */
  attempts: number;
}

/** События состояния конвейера (options.state). */
export type PipelineEvent =
  | { type: 'decode-start' }
  | { type: 'decode-done'; width: number; height: number }
  | { type: 'frame'; width: number; height: number; fit: 'cover' | 'contain'; method: ResizeMethod }
  | { type: 'sharpen'; amount: number; radius: number }
  | { type: 'quantize'; colors: number; dithering: number }
  | {
      type: 'encode';
      format: string;
      quality?: number;
      colors?: number;
      channel?: string;
      subsampling?: ChromaSubsampling;
      /** id выбранных значений spec.dimensions по имени измерения. */
      dimensions?: Readonly<Record<string, string>>;
      /** Номер попытки внутри fit (1-based); вне fit — undefined. */
      attempt?: number;
    }
  | {
      type: 'encode-done';
      format: string;
      size: number;
      quality?: number;
      colors?: number;
      channel?: string;
      subsampling?: ChromaSubsampling;
      dimensions?: Readonly<Record<string, string>>;
      attempt?: number;
      /** Вердикт предиката вызывающего (только внутри fit). */
      fits?: boolean;
    }
  | { type: 'probe'; saturation: number; monochrome: boolean }
  | { type: 'warning'; warning: FitWarning }
  | {
      type: 'fit-start';
      formats: readonly string[];
      planes: number;
      gridSize: number;
      /** Верхняя оценка энкодов owner-loop: planes × gridSize. */
      ownerLoopUpperBound: number;
      maxAttempts?: number;
      deadlineMs?: number;
    }
  | {
      type: 'fit-exhausted';
      reason: 'max-attempts' | 'deadline';
      attempts: number;
      elapsedMs: number;
    }
  | { type: 'fit-done'; hit: boolean; attempts: number }
  | { type: 'done' }
  | { type: 'error'; error: unknown };

export type StateListener = (event: PipelineEvent) => void;

/** Опции вызова `image(...)`. */
export interface ImageOptions {
  /**
   * Подписка на этапы: синхронный callback, вызывается в точках прогресса.
   * Библиотека не тащит никакой реактивности — потребитель сам заворачивает
   * события в свой механизм (стор, сигнал, setState).
   */
  state?: StateListener;
  /**
   * Отмена: проверяется между ступенями и между пробами fit. При аборте
   * конвейер бросает AbortError и освобождает ресурсы (bitmap закрывается;
   * уже запущенный wasm-энкод дорабатывает, но результат выбрасывается).
   */
  signal?: AbortSignal;
  /**
   * Явный декодер источника. Шов для тестов (в Node нет createImageBitmap)
   * и сред со своим декодированием. По умолчанию — браузерный декодер
   * с честным EXIF-поворотом.
   */
  decoder?: Decoder;
  /**
   * Изолированный реестр кодеков для этого вызова. По умолчанию —
   * глобальный default-реестр со встроенными jpeg/png/webp/avif.
   */
  registry?: EncoderRegistry;
  /**
   * Необязательный лимит суммарного числа пикселей кадра (декодированный
   * источник и целевая геометрия frame/fit). Политика ресурсов вызывающего:
   * без лимита поведение прежнее. Превышение — ResourceLimitError.
   */
  maxPixels?: number;
  /** Необязательный лимит любой стороны кадра в пикселях. */
  maxDimension?: number;
}

/** Ступени конвейера, доступные внутри callback'а `image(...)`. */
export interface Pipeline {
  frame(options: FrameOptions): Promise<void>;
  /** Unsharp mask; типичный сценарий — мягкий шарп после frame-даунскейла. */
  sharpen(options?: SharpenOptions): Promise<void>;
  quantize(options: QuantizeOptions): Promise<void>;
  encode(format: string, options?: EncodeOptions): Promise<Blob>;
  fit(
    spec: FitSpec,
    fits: (candidate: Blob) => boolean,
    options?: FitOptions,
  ): Promise<FitResult | null>;
}
