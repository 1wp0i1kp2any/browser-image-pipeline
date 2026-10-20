// Заголовочная проба изображения: формат и размеры БЕЗ декодирования.
//
// Зачем: серверный приём фото (fallback без клиентской обработки) обязан
// отсекать «не картинки» и декомпрессионные бомбы до дорогого wasm-декода,
// а уже обработанное клиентом фото — принимать как есть, если оно внутри
// рамок, не перекодируя второй раз. Для обоих решений достаточно фактов
// из заголовков: формат по структуре контейнера, ширина/высота, EXIF-
// ориентация JPEG, первый COM-комментарий.
//
// Принципы (те же, что у остальной библиотеки):
// - только ФАКТЫ, никакой политики: лимиты байт/пикселей/сторон — решение
//   вызывающего (как предикат у fit). Функция не знает белых списков —
//   она сообщает, что удалось строго разобрать, или null.
// - никогда не бросает: любое несоответствие структуры → null.
// - ограничена по работе: число сканируемых сегментов/боксов ограничено,
//   каждое чтение проверяет границы; годится и для среза начала файла
//   (для JPEG со SOF за пределами среза вернёт null — давайте ≥256 KiB
//   головы или файл целиком: большие EXIF с миниатюрой сдвигают SOF).
// - ноль зависимостей и ноль DOM/wasm: работает в браузере, Node,
//   Vercel и Cloudflare Workers одинаково; поэтому отдельный subpath
//   `browser-image-pipeline/probe`, а не часть корневого бандла.

/** Факты об изображении, доказуемые по заголовкам без декодирования. */
export interface ImageHeaderInfo {
  /** Формат контейнера по структуре (не по расширению и не по MIME входа). */
  format: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/avif';
  /** Ширина в пикселях как записана в контейнере (до EXIF-поворота). */
  width: number;
  /** Высота в пикселях как записана в контейнере (до EXIF-поворота). */
  height: number;
  /** EXIF-ориентация JPEG, 1–8, если тег Orientation найден и валиден. */
  orientation?: number;
  /** JPEG: progressive (SOF2). Для прочих форматов отсутствует. */
  progressive?: boolean;
  /** Есть ли альфа по декларации контейнера (PNG color type/tRNS, WebP флаги). */
  hasAlpha?: boolean;
  /** JPEG: текст первого COM-сегмента (UTF-8 best-effort), если есть. */
  comment?: string;
}

const MAX_SEGMENTS = 512;

/**
 * У16 big-endian по смещению; вызывающий гарантирует границы.
 *
 * @param b - буфер.
 * @param off - смещение первого байта.
 * @returns значение 0..65535.
 */
function u16be(b: Uint8Array, off: number): number {
  return (b[off] << 8) | b[off + 1];
}

/**
 * У32 big-endian по смещению; вызывающий гарантирует границы.
 *
 * @param b - буфер.
 * @param off - смещение первого байта.
 * @returns беззнаковое значение.
 */
function u32be(b: Uint8Array, off: number): number {
  return (b[off] * 0x1000000 + ((b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3])) >>> 0;
}

/**
 * У24 little-endian по смещению; вызывающий гарантирует границы.
 *
 * @param b - буфер.
 * @param off - смещение первого байта.
 * @returns значение 0..16777215.
 */
function u24le(b: Uint8Array, off: number): number {
  return b[off] | (b[off + 1] << 8) | (b[off + 2] << 16);
}

/**
 * Прочитать EXIF Orientation из payload APP1-сегмента JPEG.
 *
 * @param b - весь буфер файла (или его голова).
 * @param start - начало payload сегмента APP1.
 * @param length - длина payload сегмента в байтах.
 * @returns ориентация 1–8 или undefined, если тега нет или TIFF невалиден.
 */
function readExifOrientation(b: Uint8Array, start: number, length: number): number | undefined {
  const end = Math.min(start + length, b.length);
  // 'Exif\0\0' + TIFF-заголовок: порядок байт, 42, смещение IFD0.
  if (end - start < 14) return undefined;
  if (b[start] !== 0x45 || b[start + 1] !== 0x78 || b[start + 2] !== 0x69 || b[start + 3] !== 0x66) {
    return undefined;
  }
  const tiff = start + 6;
  const le = b[tiff] === 0x49 && b[tiff + 1] === 0x49;
  const be = b[tiff] === 0x4d && b[tiff + 1] === 0x4d;
  if (!le && !be) return undefined;
  const u16 = (off: number): number =>
    le ? b[off] | (b[off + 1] << 8) : (b[off] << 8) | b[off + 1];
  const u32 = (off: number): number =>
    le
      ? (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0
      : u32be(b, off);
  if (u16(tiff + 2) !== 42) return undefined;
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > end) return undefined;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) return undefined;
    if (u16(entry) !== 0x0112) continue; // Orientation
    if (u16(entry + 2) !== 3 || u32(entry + 4) < 1) return undefined; // SHORT, ≥1
    const value = u16(entry + 8);
    return value >= 1 && value <= 8 ? value : undefined;
  }
  return undefined;
}

/**
 * Разобрать JPEG: маркеры до SOS, размеры из SOF, EXIF и первый COM.
 *
 * @param b - байты файла или его головы.
 * @returns факты или null, если структура не JPEG или SOF не найден.
 */
function probeJpeg(b: Uint8Array): ImageHeaderInfo | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let off = 2;
  let width = 0;
  let height = 0;
  let progressive: boolean | undefined;
  let orientation: number | undefined;
  let comment: string | undefined;

  for (let seg = 0; seg < MAX_SEGMENTS; seg++) {
    // Маркер: 0xFF (+ заполняющие 0xFF) и байт кода, не 0x00 и не 0xFF.
    if (off + 1 >= b.length || b[off] !== 0xff) break;
    let marker = b[off + 1];
    let at = off + 2;
    while (marker === 0xff && at < b.length) {
      marker = b[at];
      at++;
    }
    off = at;
    if (marker === 0xda) break; // SOS: заголовки кончились
    if (marker === 0xd9) break; // EOI без SOF — не картинка
    // Маркеры без полезной нагрузки: TEM, RST0–7, повторный SOI.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (off + 2 > b.length) break;
    const segLen = u16be(b, off);
    if (segLen < 2) return null;
    const payload = off + 2;
    const payloadLen = segLen - 2;

    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (payload + 5 > b.length) return null;
      height = u16be(b, payload + 1);
      width = u16be(b, payload + 3);
      progressive = marker === 0xc2;
      if (width === 0 || height === 0) return null;
    } else if (marker === 0xe1 && orientation === undefined) {
      orientation = readExifOrientation(b, payload, payloadLen);
    } else if (marker === 0xfe && comment === undefined && payloadLen > 0) {
      const avail = Math.min(payloadLen, b.length - payload);
      if (avail > 0) {
        comment = new TextDecoder('utf-8', { fatal: false }).decode(
          b.subarray(payload, payload + avail),
        );
      }
    }
    off = payload + payloadLen;
    if (off > b.length) break; // срез головы: дальше данных нет
  }

  if (width === 0 || height === 0) return null;
  return {
    format: 'image/jpeg',
    width,
    height,
    ...(orientation !== undefined ? { orientation } : {}),
    ...(progressive !== undefined ? { progressive } : {}),
    ...(comment !== undefined ? { comment } : {}),
  };
}

/**
 * Разобрать PNG: IHDR обязателен первым; лёгкий проход чанков ради tRNS.
 *
 * @param b - байты файла или его головы.
 * @returns факты или null, если сигнатура/IHDR невалидны.
 */
function probePng(b: Uint8Array): ImageHeaderInfo | null {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 29) return null;
  for (let i = 0; i < 8; i++) if (b[i] !== SIG[i]) return null;
  if (u32be(b, 8) !== 13) return null; // длина IHDR
  if (b[12] !== 0x49 || b[13] !== 0x48 || b[14] !== 0x44 || b[15] !== 0x52) return null; // 'IHDR'
  const width = u32be(b, 16);
  const height = u32be(b, 20);
  const colorType = b[25];
  if (width === 0 || height === 0) return null;
  if (![0, 2, 3, 4, 6].includes(colorType)) return null;
  let hasAlpha = colorType === 4 || colorType === 6;

  if (!hasAlpha) {
    let off = 8;
    for (let n = 0; n < 256 && off + 8 <= b.length; n++) {
      const len = u32be(b, off);
      const type =
        String.fromCharCode(b[off + 4], b[off + 5], b[off + 6], b[off + 7]);
      if (type === 'tRNS') {
        hasAlpha = true;
        break;
      }
      if (type === 'IDAT' || type === 'IEND') break;
      off += 12 + len;
    }
  }
  return { format: 'image/png', width, height, hasAlpha };
}

/**
 * Разобрать WebP: RIFF-контейнер и первый видео-чанк VP8X/VP8 /VP8L.
 *
 * @param b - байты файла или его головы.
 * @returns факты или null, если контейнер или кадр невалидны.
 */
function probeWebp(b: Uint8Array): ImageHeaderInfo | null {
  if (b.length < 21) return null;
  const riff = String.fromCharCode(b[0], b[1], b[2], b[3]);
  const wave = String.fromCharCode(b[8], b[9], b[10], b[11]);
  if (riff !== 'RIFF' || wave !== 'WEBP') return null;
  const fourcc = String.fromCharCode(b[12], b[13], b[14], b[15]);
  const p = 20;

  if (fourcc === 'VP8X') {
    if (b.length < p + 10) return null;
    const flags = b[p];
    const width = u24le(b, p + 4) + 1;
    const height = u24le(b, p + 7) + 1;
    return { format: 'image/webp', width, height, hasAlpha: (flags & 0x10) !== 0 };
  }
  if (fourcc === 'VP8 ') {
    // Lossy: frame tag (3B), start code 9D 01 2A, далее 14-битные размеры.
    if (b.length < p + 10) return null;
    if ((b[p] & 1) !== 0) return null; // не ключевой кадр
    if (b[p + 3] !== 0x9d || b[p + 4] !== 0x01 || b[p + 5] !== 0x2a) return null;
    const width = (b[p + 6] | (b[p + 7] << 8)) & 0x3fff;
    const height = (b[p + 8] | (b[p + 9] << 8)) & 0x3fff;
    if (width === 0 || height === 0) return null;
    return { format: 'image/webp', width, height, hasAlpha: false };
  }
  if (fourcc === 'VP8L') {
    if (b.length < p + 5 || b[p] !== 0x2f) return null;
    const bits = (b[p + 1] | (b[p + 2] << 8) | (b[p + 3] << 16) | (b[p + 4] << 24)) >>> 0;
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >>> 14) & 0x3fff) + 1;
    return { format: 'image/webp', width, height, hasAlpha: ((bits >>> 28) & 1) !== 0 };
  }
  return null;
}

/**
 * Найти дочерний ISOBMFF-бокс заданного типа в диапазоне байт.
 *
 * @param b - буфер.
 * @param from - начало диапазона (первый дочерний бокс).
 * @param to - конец диапазона (не включительно).
 * @param type - четырёхсимвольный тип бокса.
 * @returns [начало payload, конец бокса) или null.
 */
function findBox(
  b: Uint8Array,
  from: number,
  to: number,
  type: string,
): readonly [number, number] | null {
  let off = from;
  for (let n = 0; n < 256 && off + 8 <= to && off + 8 <= b.length; n++) {
    let size = u32be(b, off);
    const boxType = String.fromCharCode(b[off + 4], b[off + 5], b[off + 6], b[off + 7]);
    let header = 8;
    if (size === 1) {
      if (off + 16 > b.length) return null;
      size = u32be(b, off + 12); // старшие 32 бита largesize для наших целей — 0
      header = 16;
    } else if (size === 0) {
      size = to - off;
    }
    if (size < header) return null;
    if (boxType === type) return [off + header, Math.min(off + size, to, b.length)];
    off += size;
  }
  return null;
}

/**
 * Разобрать AVIF: ftyp-бренд и размеры из meta/iprp/ipco/ispe.
 *
 * @param b - байты файла или его головы.
 * @returns факты или null, если бренд не AVIF или ispe не найден.
 */
function probeAvif(b: Uint8Array): ImageHeaderInfo | null {
  if (b.length < 16) return null;
  if (String.fromCharCode(b[4], b[5], b[6], b[7]) !== 'ftyp') return null;
  const brand = (off: number): string =>
    String.fromCharCode(b[off], b[off + 1], b[off + 2], b[off + 3]);
  const major = brand(8);
  let isAvif = major === 'avif' || major === 'avis';
  if (!isAvif) {
    const ftypSize = Math.min(u32be(b, 0), b.length);
    for (let off = 16; off + 4 <= ftypSize; off += 4) {
      if (brand(off) === 'avif' || brand(off) === 'avis') {
        isAvif = true;
        break;
      }
    }
  }
  if (!isAvif) return null;

  const meta = findBox(b, 0, b.length, 'meta');
  if (!meta) return null;
  const iprp = findBox(b, meta[0] + 4, meta[1], 'iprp'); // meta: 4 байта version/flags
  if (!iprp) return null;
  const ipco = findBox(b, iprp[0], iprp[1], 'ipco');
  if (!ipco) return null;
  const ispe = findBox(b, ipco[0], ipco[1], 'ispe');
  if (!ispe || ispe[0] + 12 > b.length) return null;
  const width = u32be(b, ispe[0] + 4); // после version/flags
  const height = u32be(b, ispe[0] + 8);
  if (width === 0 || height === 0) return null;
  return { format: 'image/avif', width, height };
}

/**
 * Определить формат и размеры изображения по заголовкам, без декодирования.
 *
 * Строгий структурный разбор JPEG/PNG/WebP/AVIF: архив, текст или
 * переименованный мусор дадут null, а не «похоже на картинку». Размеры
 * берутся как записаны в контейнере (для JPEG — до EXIF-поворота;
 * ориентация возвращается отдельно, визуальная ширина/высота при
 * orientation 5–8 меняются местами). Функция ничего не решает за
 * вызывающего: что делать с форматом и размерами (лимиты байт, пикселей,
 * сторон) — его политика.
 *
 * @param bytes - файл целиком или его голова (для JPEG желательно
 *   ≥256 KiB головы: SOF обязана попасть в срез).
 * @returns факты об изображении или null, если вход не разбирается как
 *   одно из поддерживаемых изображений.
 */
export function probeImageHeader(bytes: Uint8Array): ImageHeaderInfo | null {
  if (!(bytes instanceof Uint8Array) || bytes.length < 4) return null;
  return probeJpeg(bytes) ?? probePng(bytes) ?? probeWebp(bytes) ?? probeAvif(bytes);
}
