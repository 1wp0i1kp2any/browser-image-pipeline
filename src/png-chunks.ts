// Минимальный строгий разбор PNG-чанков для lossless-оптимизаторов.
//
// Модуль намеренно не входит в публичный API и не импортируется ядром:
// его используют только ленивые PNG-чанки. Парсер проверяет сигнатуру,
// границы и CRC каждого чанка; сериализация сохраняет payload как есть.

/** 8-байтная сигнатура PNG. */
export const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

/** Цветовые чанки, потеря которых оптимизатором считается недопустимой. */
export const PRESERVED_COLOR_CHUNKS = new Set(['iCCP', 'gAMA', 'cHRM', 'sRGB', 'cICP']);

/** Один PNG-чанк разбора: тип, payload и полный исходный срез. */
export interface PngChunk {
  /** Четырёхсимвольный тип чанка ('IHDR', 'IDAT', ...). */
  type: string;
  /** Payload чанка (view в исходный буфер, без копии). */
  data: Uint8Array;
  /** Полный исходный срез чанка: length + type + data + CRC. */
  raw: Uint8Array;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * CRC32 (полином PNG/zlib) по срезу байт.
 *
 * @param bytes - байты type+payload чанка.
 * @returns беззнаковая контрольная сумма.
 */
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Прочитать big-endian uint32.
 *
 * @param bytes - буфер.
 * @param offset - смещение первого байта; вызывающий гарантирует границы.
 * @returns беззнаковое 32-битное значение.
 */
export function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

/**
 * Строго разобрать PNG на чанки: сигнатура, границы и CRC каждого чанка.
 *
 * @param bytes - полный PNG-файл байтами.
 * @returns чанки в исходном порядке (data/raw — view без копий) или null,
 *   если вход не является структурно валидным PNG с IHDR первым и IEND
 *   последним и без хвоста после IEND.
 */
export function parsePngChunks(bytes: Uint8Array): PngChunk[] | null {
  if (bytes.length < PNG_SIGNATURE.length) return null;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return null;
  }

  const chunks: PngChunk[] = [];
  let offset = PNG_SIGNATURE.length;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) return null;
    const length = readUint32(bytes, offset);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const nextOffset = dataEnd + 4;
    if (dataEnd < dataStart || nextOffset > bytes.length) return null;

    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    const type = String.fromCharCode(typeBytes[0], typeBytes[1], typeBytes[2], typeBytes[3]);
    const expectedCrc = readUint32(bytes, dataEnd);
    const crcInput = bytes.subarray(offset + 4, dataEnd);
    if (crc32(crcInput) !== expectedCrc) return null;

    chunks.push({
      type,
      data: bytes.subarray(dataStart, dataEnd),
      raw: bytes.subarray(offset, nextOffset),
    });
    offset = nextOffset;
    if (type === 'IEND') break;
  }

  if (offset !== bytes.length) return null;
  if (chunks.length < 2 || chunks[0]?.type !== 'IHDR' || chunks[chunks.length - 1]?.type !== 'IEND') {
    return null;
  }
  return chunks;
}

/**
 * Типы чанков PNG в исходном порядке.
 *
 * @param bytes - полный PNG-файл байтами.
 * @returns список типов ('IHDR', 'IDAT', ..., 'IEND') или null, если вход
 *   не проходит строгий разбор parsePngChunks.
 */
export function listPngChunkTypes(bytes: Uint8Array): string[] | null {
  return parsePngChunks(bytes)?.map((chunk) => chunk.type) ?? null;
}

/**
 * Сериализовать чанк: длина + тип + payload + CRC.
 *
 * @param type - четырёхсимвольный тип чанка.
 * @param data - payload чанка.
 * @returns новый буфер полного чанка.
 * @throws Error, если тип не из 4 символов.
 */
export function serializePngChunk(type: string, data: Uint8Array): Uint8Array {
  if (type.length !== 4) throw new Error(`PNG chunk type must have 4 characters: ${type}`);
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i) & 0x7f;
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * Склеить срезы байт в один новый буфер.
 *
 * @param parts - части в порядке склейки (view копируются).
 * @returns новый Uint8Array суммарной длины.
 */
export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
