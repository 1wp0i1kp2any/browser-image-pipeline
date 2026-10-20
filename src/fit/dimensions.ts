// Размерности поиска fit и их порядок по «визуальной цене» (наблюдение
// заказчика, ТЗ §4.1):
//
//   качество (вглубь, пока разрешит spec) → каналы → палитра
//
// Качество ищется стратегией ВНУТРИ плоскости; плоскость — это комбинация
// остальных размерностей: (формат × уровень палитры × канал). Стратегии
// перебирают плоскости одним общим порядком и друг от друга отличаются
// только поиском качества внутри плоскости. Следствие-расширяемость:
// новое измерение (как здесь канал) добавляется в buildPlanes, стратегии
// при этом не переписываются — они плоскостей не знают.

import type {
  ChromaSubsampling,
  Codec,
  EncodeOptions,
  FitDimension,
  FitDimensionValue,
  FitSpec,
} from '../types.js';
import { InvalidOptionsError } from '../errors.js';

/** Плоскость поиска: всё зафиксировано, кроме качества. */
export interface Plane {
  format: string;
  /** Канал кодека; undefined — канал по умолчанию ( опция не передаётся). */
  channel?: string;
  /** Субсемплинг; undefined — выбор кодека по умолчанию. */
  subsampling?: ChromaSubsampling;
  /** Вариант опций кодека из spec.variants; undefined — варианты не заданы. */
  variant?: EncodeOptions;
  /** Выбранные значения spec.dimensions; undefined — именованных измерений нет. */
  dimensions?: Readonly<Record<string, FitDimensionValue>>;
  /** Объединённые опции выбранных именованных измерений (ключи не пересекаются). */
  dimensionOptions?: EncodeOptions;
  /** Уровень палитры; undefined — без квантования. */
  colors?: number;
}

/** Уровни палитры от безобидного к грубому: нет, max, max/2, ... до min. */
function paletteLevels(spec: FitSpec): (number | undefined)[] {
  if (!spec.colors) return [undefined];
  const [min, max] = spec.colors;
  if (
    !Number.isInteger(min) ||
    !Number.isInteger(max) ||
    min < 2 ||
    max > 256 ||
    min > max
  ) {
    throw new InvalidOptionsError(
      `fit: colors must be [min, max] within [2, 256], got [${min}, ${max}]`,
    );
  }
  const levels: (number | undefined)[] = [undefined];
  // Половинное деление от max вниз; min включается всегда (пол перебора).
  let level = max;
  while (level > min) {
    levels.push(level);
    level = Math.floor(level / 2);
  }
  levels.push(min);
  return levels;
}

/**
 * Каналы перебора для формата: сначала канал кодека по умолчанию
 * (undefined), затем разрешённые spec.channels в их порядке — только те,
 * что кодек декларирует в codec.channels. Grayscale попадает сюда только
 * если вызывающий явно разрешил (opt-in: потеря цвета — его решение).
 *
 * Если кадр почти-монохромный и grayscale разрешён — он поднимается сразу
 * за каналом по умолчанию: для манги/скриншотов/документов это самый
 * большой выигрыш веса при нулевой визуальной цене, и пробовать его надо
 * раньше прочих каналов и тем более раньше палитры.
 */
function channelLevels(
  spec: FitSpec,
  codec: Codec,
  monochrome: boolean,
): (string | undefined)[] {
  const supported = codec.channels;
  if (!supported || supported.length === 0) return [undefined];
  const allowed = (spec.channels ?? [])
    .map((c) => c.toLowerCase())
    .filter(
      (c, idx, arr) =>
        supported.includes(c) && c !== supported[0] && arr.indexOf(c) === idx,
    );
  if (monochrome) {
    const gi = allowed.indexOf('grayscale');
    if (gi > 0) {
      allowed.splice(gi, 1);
      allowed.unshift('grayscale');
    }
  }
  return [undefined, ...allowed];
}

/**
 * Субсемплинги перебора для формата: сначала выбор кодека по умолчанию
 * (undefined), затем разрешённые spec.subsampling в их порядке — только те,
 * что кодек декларирует в codec.subsampling, и кроме дефолтного.
 */
function subsamplingLevels(
  spec: FitSpec,
  codec: Codec,
): (ChromaSubsampling | undefined)[] {
  const supported = codec.subsampling;
  if (!supported || supported.length === 0 || !spec.subsampling) return [undefined];
  const allowed = spec.subsampling.filter(
    (s, idx, arr) => supported.includes(s) && s !== supported[0] && arr.indexOf(s) === idx,
  );
  return [undefined, ...allowed];
}

/**
 * Внутренний вид измерения плоскости:
 * - fixed — ровно одно значение, применяется всегда и поиском не является;
 * - categorical — значения перечисляются плоскостями в порядке предпочтения,
 *   без обещания монотонности и без бинарного поиска по ним;
 * - frame-transform — значение меняет сам кадр до энкода (уровень палитры).
 * Quality сюда не входит: это особая ось внутри готовой плоскости.
 */
export type PlaneDimensionKind = 'fixed' | 'categorical' | 'frame-transform';

/** Фрагмент плоскости, который приносит одно значение одного измерения. */
export interface PlaneDimensionFragment {
  colors?: number;
  channel?: string;
  subsampling?: ChromaSubsampling;
  variant?: EncodeOptions;
  dimensionName?: string;
  dimensionValue?: FitDimensionValue;
}

/** Внутренний дескриптор измерения плоскости. */
export interface PlaneDimensionDescriptor {
  name: string;
  kind: PlaneDimensionKind;
  values: readonly PlaneDimensionFragment[];
}

const RESERVED_DIMENSION_NAMES = new Set([
  'format',
  'quality',
  'colors',
  'channel',
  'subsampling',
  'variant',
  'dimensions',
]);
const RESERVED_DIMENSION_OPTION_KEYS = new Set(['quality', 'channel', 'subsampling']);

/**
 * Похож ли value на объект опций энкодера (не null и не массив).
 *
 * @param value - проверяемое значение из spec.
 * @returns true, если это обычный объект опций.
 */
function isOptionObject(value: unknown): value is EncodeOptions {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Проверить имя измерения/значения: непустая строка без внешних пробелов.
 *
 * @param value - проверяемое имя.
 * @param where - что именно именуется, для текста ошибки.
 * @returns то же имя.
 * @throws InvalidOptionsError при пустом/пробельном имени.
 */
function assertCleanName(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.trim() !== value) {
    throw new InvalidOptionsError(`fit: ${where} must be a non-empty trimmed string`);
  }
  return value;
}

/**
 * Валидация именованных категориальных измерений до геометрии и энкодов.
 *
 * Ключи опций разных измерений обязаны быть непересекающимися: иначе
 * порядок слияния превратил бы два независимых измерения в скрытую
 * зависимость. С variants та же политика для нового API. Нормированные
 * quality/channel/subsampling здесь запрещены: у них есть собственные
 * измерения spec и собственная семантика поиска.
 *
 * @param spec - спецификация fit.
 * @returns валидные именованные измерения spec (пустой список, если не заданы).
 * @throws InvalidOptionsError при конфликтах ключей/имён или запрещённых ключах.
 */
export function validateFitDimensions(spec: FitSpec): readonly FitDimension[] {
  if (spec.dimensions === undefined) return [];
  if (!Array.isArray(spec.dimensions)) {
    throw new InvalidOptionsError('fit: dimensions must be an array');
  }

  const variantKeys = new Set<string>();
  for (const variant of spec.variants ?? []) {
    if (isOptionObject(variant)) {
      for (const key of Object.keys(variant)) variantKeys.add(key);
    }
  }

  const names = new Set<string>();
  const keyOwner = new Map<string, string>();
  for (const dimension of spec.dimensions) {
    if (!dimension || typeof dimension !== 'object') {
      throw new InvalidOptionsError('fit: each dimension must be an object');
    }
    const name = assertCleanName(dimension.name, 'dimension.name');
    if (RESERVED_DIMENSION_NAMES.has(name)) {
      throw new InvalidOptionsError(`fit: dimension name "${name}" is reserved`);
    }
    if (names.has(name)) {
      throw new InvalidOptionsError(`fit: duplicate dimension name "${name}"`);
    }
    names.add(name);
    if (!Array.isArray(dimension.values) || dimension.values.length === 0) {
      throw new InvalidOptionsError(`fit: dimension "${name}" must have at least one value`);
    }

    const ids = new Set<string>();
    for (const value of dimension.values) {
      if (!value || typeof value !== 'object') {
        throw new InvalidOptionsError(`fit: dimension "${name}" values must be objects`);
      }
      const id = assertCleanName(value.id, `dimension "${name}" value id`);
      if (ids.has(id)) {
        throw new InvalidOptionsError(`fit: duplicate value id "${id}" in dimension "${name}"`);
      }
      ids.add(id);
      if (!isOptionObject(value.options)) {
        throw new InvalidOptionsError(
          `fit: dimension "${name}" value "${id}" options must be an object`,
        );
      }
      for (const key of Object.keys(value.options)) {
        if (RESERVED_DIMENSION_OPTION_KEYS.has(key)) {
          throw new InvalidOptionsError(
            `fit: dimension "${name}" must not set normalized option "${key}"; use the dedicated fit dimension`,
          );
        }
        if (variantKeys.has(key)) {
          throw new InvalidOptionsError(
            `fit: option "${key}" conflicts between variants and dimension "${name}"`,
          );
        }
        const owner = keyOwner.get(key);
        if (owner && owner !== name) {
          throw new InvalidOptionsError(
            `fit: option "${key}" conflicts between dimensions "${owner}" and "${name}"`,
          );
        }
        keyOwner.set(key, name);
      }
    }
  }
  return spec.dimensions;
}

/**
 * Вид дескриптора измерения по имени и числу значений.
 *
 * @param name - имя измерения ('colors' — единственное frame-transform).
 * @param count - число значений измерения; 1 — фиксированное измерение.
 * @returns 'fixed' | 'categorical' | 'frame-transform'.
 */
function descriptorKind(name: string, count: number): PlaneDimensionKind {
  if (count === 1) return 'fixed';
  return name === 'colors' ? 'frame-transform' : 'categorical';
}

/**
 * Скомпилировать измерения одной format-плоскости в дескрипторы.
 * Порядок — исторический и закреплён golden-тестами:
 * палитра → канал → субсемплинг → variants → именованные измерения.
 *
 * @param spec - спецификация fit.
 * @param codec - кодек формата (его channels/subsampling фильтруют значения).
 * @param monochrome - результат пробы насыщенности: почти монохромному
 *   кадру grayscale предлагается раньше прочих каналов.
 * @returns дескрипторы измерений одной format-плоскости в порядке обхода.
 */
export function compilePlaneDescriptors(
  spec: FitSpec,
  codec: Codec,
  monochrome: boolean,
): PlaneDimensionDescriptor[] {
  const named = validateFitDimensions(spec);
  const variants: (EncodeOptions | undefined)[] =
    spec.variants && spec.variants.length > 0 ? spec.variants : [undefined];

  const colors = paletteLevels(spec);
  const channels = channelLevels(spec, codec, monochrome);
  const subsamplings = subsamplingLevels(spec, codec);
  const descriptors: PlaneDimensionDescriptor[] = [
    {
      name: 'colors',
      kind: descriptorKind('colors', colors.length),
      values: colors.map((value) => ({ colors: value })),
    },
    {
      name: 'channel',
      kind: descriptorKind('channel', channels.length),
      values: channels.map((channel) => ({ channel })),
    },
    {
      name: 'subsampling',
      kind: descriptorKind('subsampling', subsamplings.length),
      values: subsamplings.map((subsampling) => ({ subsampling })),
    },
    {
      name: 'variant',
      kind: descriptorKind('variant', variants.length),
      values: variants.map((variant) => ({ variant })),
    },
  ];

  for (const dimension of named) {
    descriptors.push({
      name: dimension.name,
      kind: descriptorKind(dimension.name, dimension.values.length),
      values: dimension.values.map((dimensionValue) => ({
        dimensionName: dimension.name,
        dimensionValue,
      })),
    });
  }
  return descriptors;
}

/** Накапливаемая рекурсией частичная плоскость: выбранные фрагменты измерений. */
interface PlaneAccumulator {
  colors?: number;
  channel?: string;
  subsampling?: ChromaSubsampling;
  variant?: EncodeOptions;
  dimensions: Record<string, FitDimensionValue>;
  dimensionOptions: EncodeOptions;
  hasDimensions: boolean;
}

/**
 * Рекурсивно перебрать декартово произведение дескрипторов одного формата.
 *
 * @param format - MIME формата плоскостей.
 * @param descriptors - дескрипторы измерений в порядке обхода.
 * @param index - текущий дескриптор рекурсии.
 * @param acc - уже выбранные значения предыдущих измерений.
 * @returns генератор полных плоскостей формата.
 */
function* iterateDescriptorPlanes(
  format: string,
  descriptors: readonly PlaneDimensionDescriptor[],
  index: number,
  acc: PlaneAccumulator,
): Generator<Plane> {
  if (index === descriptors.length) {
    yield {
      format,
      colors: acc.colors,
      channel: acc.channel,
      subsampling: acc.subsampling,
      variant: acc.variant,
      ...(acc.hasDimensions
        ? { dimensions: acc.dimensions, dimensionOptions: acc.dimensionOptions }
        : {}),
    };
    return;
  }

  for (const fragment of descriptors[index].values) {
    const next: PlaneAccumulator = {
      colors: acc.colors,
      channel: acc.channel,
      subsampling: acc.subsampling,
      variant: acc.variant,
      dimensions: acc.dimensions,
      dimensionOptions: acc.dimensionOptions,
      hasDimensions: acc.hasDimensions,
    };
    if ('colors' in fragment) next.colors = fragment.colors;
    if ('channel' in fragment) next.channel = fragment.channel;
    if ('subsampling' in fragment) next.subsampling = fragment.subsampling;
    if ('variant' in fragment) next.variant = fragment.variant;
    if (fragment.dimensionName && fragment.dimensionValue) {
      next.dimensions = {
        ...acc.dimensions,
        [fragment.dimensionName]: fragment.dimensionValue,
      };
      next.dimensionOptions = {
        ...acc.dimensionOptions,
        ...fragment.dimensionValue.options,
      };
      next.hasDimensions = true;
    }
    yield* iterateDescriptorPlanes(format, descriptors, index + 1, next);
  }
}

/**
 * Плоскости поиска в порядке предпочтения, лениво:
 * формат (порядок spec) → дескрипторы compilePlaneDescriptors.
 * Палитра — внешнее измерение: все комбинации прочих размерностей на
 * уровне «без палитры» пробуются раньше, чем палитра начнёт резаться.
 *
 * Генератор важен при больших variants/dimensions: fit не материализует
 * декартово произведение целиком до первой пробы.
 *
 * @param spec - спецификация fit.
 * @param getCodec - получение кодека формата из реестра (бросает для
 *   незарегистрированного формата — честная ошибка до проб).
 * @param monochrome - проба насыщенности для порядка каналов.
 * @returns генератор плоскостей в порядке предпочтения поиска.
 */
export function* iteratePlanes(
  spec: FitSpec,
  getCodec: (format: string) => Codec,
  monochrome: boolean,
): Generator<Plane> {
  validateFitDimensions(spec);
  for (const format of spec.formats) {
    const codec = getCodec(format); // незарегистрированный формат — честная ошибка
    const descriptors = compilePlaneDescriptors(spec, codec, monochrome);
    yield* iterateDescriptorPlanes(format, descriptors, 0, {
      dimensions: {},
      dimensionOptions: {},
      hasDimensions: false,
    });
  }
}

/**
 * Все плоскости одним массивом (для тестов и небольших спецификаций).
 *
 * @param spec - спецификация fit.
 * @param getCodec - получение кодека формата из реестра.
 * @param monochrome - проба насыщенности для порядка каналов.
 * @returns все плоскости в том же порядке, что iteratePlanes.
 */
export function buildPlanes(
  spec: FitSpec,
  getCodec: (format: string) => Codec,
  monochrome: boolean,
): Plane[] {
  return [...iteratePlanes(spec, getCodec, monochrome)];
}

/**
 * Число плоскостей без материализации их комбинаций.
 *
 * @param spec - спецификация fit.
 * @param getCodec - получение кодека формата из реестра.
 * @param monochrome - проба насыщенности для порядка каналов.
 * @returns суммарное число плоскостей по всем форматам spec.
 */
export function countPlanes(
  spec: FitSpec,
  getCodec: (format: string) => Codec,
  monochrome: boolean,
): number {
  validateFitDimensions(spec);
  let total = 0;
  for (const format of spec.formats) {
    const codec = getCodec(format);
    const descriptors = compilePlaneDescriptors(spec, codec, monochrome);
    total += descriptors.reduce((product, descriptor) => product * descriptor.values.length, 1);
  }
  return total;
}

/** Запрошенные spec значения, которые кодек формата не поддерживает. */
export interface UnsupportedFitValues {
  format: string;
  channels: string[];
  subsampling: ChromaSubsampling[];
}

/**
 * Значения channels/subsampling, которые fit вынужден отфильтровать.
 * Раньше это делалось молча; pipeline превращает результат в warnings,
 * а поиск продолжает каналом/субсемплингом кодека по умолчанию.
 *
 * @param spec - спецификация fit.
 * @param getCodec - получение кодека формата из реестра.
 * @returns по записи на формат, где есть неподдерживаемые значения.
 */
export function collectUnsupportedFitValues(
  spec: FitSpec,
  getCodec: (format: string) => Codec,
): UnsupportedFitValues[] {
  const out: UnsupportedFitValues[] = [];
  for (const format of spec.formats) {
    const codec = getCodec(format);
    const supportedChannels = codec.channels ?? [];
    const channels = [...new Set((spec.channels ?? []).map((c) => c.toLowerCase()))].filter(
      (channel) => !supportedChannels.includes(channel),
    );
    const supportedSubsampling = codec.subsampling ?? [];
    const subsampling = [...new Set(spec.subsampling ?? [])].filter(
      (value) => !supportedSubsampling.includes(value),
    );
    if (channels.length > 0 || subsampling.length > 0) {
      out.push({ format, channels, subsampling });
    }
  }
  return out;
}

/**
 * Сетка качества: от пола к потолку с шагом 0.01, обе границы
 * включены точно как числа из spec. Внутренние точки выравниваются по
 * сотым и никогда не выходят за [qMin, qMax]: округление в шкалу
 * конкретного кодека — дело самого кодека, а не право поиска расширять
 * диапазон вызывающего. Все стратегии ищут на ОДНОЙ сетке — поэтому
 * «не хуже owner-loop» проверяется тестом как равенство результата,
 * а не «примерно не хуже».
 *
 * @param spec - спецификация fit с диапазоном quality [min, max].
 * @returns сетка по возрастанию с точными границами spec.
 * @throws InvalidOptionsError, если диапазон вне [0, 1] или min > max.
 */
export function buildQualityGrid(spec: FitSpec): number[] {
  const [qMin, qMax] = spec.quality;
  if (!(qMin >= 0 && qMax <= 1 && qMin <= qMax)) {
    throw new InvalidOptionsError(
      `fit: quality must be [min, max] within [0, 1], got [${qMin}, ${qMax}]`,
    );
  }
  if (qMin === qMax) return [qMin];

  const grid: number[] = [qMin];
  // Только строго внутренние сотые: границы добавляются отдельно и точно.
  // Небольшой epsilon защищает сотые значения от float-представления вида
  // 0.29 = 0.28999999999999998, не сдвигая саму границу.
  const firstHundredth = Math.ceil((qMin + 1e-9) * 100);
  const lastHundredth = Math.floor((qMax - 1e-9) * 100);
  for (let k = firstHundredth; k <= lastHundredth; k++) {
    const q = k / 100;
    if (q > qMin && q < qMax) grid.push(q);
  }
  grid.push(qMax);
  return grid;
}
