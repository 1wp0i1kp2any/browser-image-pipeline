// Lossless PNG-rewriter без wasm на CompressionStream/DecompressionStream.
//
// Алгоритм сознательно узкий и проверяемый:
// 1) строго парсим PNG и CRC;
// 2) склеиваем payload единственной непрерывной группы IDAT;
// 3) распаковываем zlib-поток в исходные отфильтрованные scanline-байты;
// 4) упаковываем те же байты обратно CompressionStream('deflate');
// 5) повторно распаковываем результат и сравниваем байт-в-байт;
// 6) все не-IDAT чанки переносим в исходном виде и порядке.
//
// Поэтому пиксели, фильтры, color type, bit depth, palette и interlace не
// меняются по построению. Модуль грузится только динамическим импортом из
// optimizePngBlob(..., { engine: 'compression-stream' }).

import { EnvironmentError, InvalidOptionsError, throwIfAborted } from '../errors.js';
import {
  PNG_SIGNATURE,
  concatBytes,
  parsePngChunks,
  readUint32,
  serializePngChunk,
  type PngChunk,
} from '../png-chunks.js';
import type { PngOptimizeOptions, PngOptimizeResult } from '../types.js';

const IDAT_CHUNK_SIZE = 32 * 1024;

function expectedFilteredByteLength(ihdr: Uint8Array): number {
  if (ihdr.length !== 13) {
    throw new InvalidOptionsError('optimizePngBlob: PNG IHDR must contain exactly 13 bytes');
  }
  const width = readUint32(ihdr, 0);
  const height = readUint32(ihdr, 4);
  const bitDepth = ihdr[8];
  const colorType = ihdr[9];
  const compression = ihdr[10];
  const filterMethod = ihdr[11];
  const interlace = ihdr[12];
  if (width === 0 || height === 0 || compression !== 0 || filterMethod !== 0 || interlace > 1) {
    throw new InvalidOptionsError('optimizePngBlob: unsupported or invalid PNG IHDR');
  }

  const channelsByColorType: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const depthsByColorType: Record<number, readonly number[]> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  };
  const channels = channelsByColorType[colorType];
  if (!channels || !depthsByColorType[colorType]?.includes(bitDepth)) {
    throw new InvalidOptionsError(
      `optimizePngBlob: invalid PNG color type/depth combination ${colorType}/${bitDepth}`,
    );
  }

  const rowBytes = (pixels: number): number => Math.ceil((pixels * channels * bitDepth) / 8);
  let total = 0;
  if (interlace === 0) {
    total = height * (1 + rowBytes(width));
  } else {
    const xStarts = [0, 4, 0, 2, 0, 1, 0];
    const yStarts = [0, 0, 4, 0, 2, 0, 1];
    const xSteps = [8, 8, 4, 4, 2, 2, 1];
    const ySteps = [8, 8, 8, 4, 4, 2, 2];
    for (let pass = 0; pass < 7; pass++) {
      const passWidth = width > xStarts[pass] ? Math.ceil((width - xStarts[pass]) / xSteps[pass]) : 0;
      const passHeight =
        height > yStarts[pass] ? Math.ceil((height - yStarts[pass]) / ySteps[pass]) : 0;
      total += passHeight * (1 + rowBytes(passWidth));
    }
  }
  if (!Number.isSafeInteger(total) || total <= 0 || total > 0xffffffff) {
    throw new InvalidOptionsError('optimizePngBlob: PNG filtered data size is outside supported range');
  }
  return total;
}

interface ByteTransform {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
}

async function transformBytes(
  input: Uint8Array,
  transform: ByteTransform,
  maxOutputBytes: number,
  signal: AbortSignal | undefined,
  operation: string,
): Promise<Uint8Array> {
  throwIfAborted(signal);
  const writer = transform.writable.getWriter();
  const reader = transform.readable.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;

  const writing = (async () => {
    await writer.write(input as Uint8Array<ArrayBuffer>);
    await writer.close();
  })();

  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const part = value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer);
      total += part.length;
      if (total > maxOutputBytes) {
        throw new InvalidOptionsError(
          `optimizePngBlob: ${operation} output exceeds expected size (${total} > ${maxOutputBytes})`,
        );
      }
      parts.push(part);
    }
    await writing;
  } catch (error) {
    writing.catch(() => undefined);
    try {
      await reader.cancel();
    } catch {
      // Исходная ошибка важнее ошибки отмены чтения.
    }
    try {
      await writer.abort();
    } catch {
      // Аналогично: не маскируем первопричину.
    }
    if (error instanceof InvalidOptionsError || (error as { name?: string })?.name === 'AbortError') {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new InvalidOptionsError(`optimizePngBlob: PNG ${operation} failed: ${message}`);
  } finally {
    reader.releaseLock();
    writer.releaseLock();
  }

  throwIfAborted(signal);
  return concatBytes(parts);
}

function equalBytes(a: Uint8Array, b: Uint8Array, signal: AbortSignal | undefined): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if ((i & 0xfffff) === 0) throwIfAborted(signal);
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function validateOptions(options: PngOptimizeOptions): void {
  if (options.engine !== undefined && options.engine !== 'compression-stream') {
    throw new InvalidOptionsError('optimizePngBlob: this module implements only compression-stream');
  }
  for (const key of ['level', 'effort', 'interlace', 'optimiseAlpha'] as const) {
    if (options[key] !== undefined) {
      throw new InvalidOptionsError(
        `optimizePngBlob: ${key} is an oxipng-only option and cannot be used with compression-stream`,
      );
    }
  }
  if (options.onlyIfSmaller !== undefined && typeof options.onlyIfSmaller !== 'boolean') {
    throw new InvalidOptionsError('optimizePngBlob: onlyIfSmaller must be a boolean');
  }
}

/**
 * Lossless-пережать IDAT готового PNG через CompressionStream без wasm.
 * Пиксельный поток после распаковки не изменяется; все прочие чанки
 * сохраняются байт-в-байт. По умолчанию принимается только меньший файл.
 */
export async function optimizePngBlobWithCompressionStream(
  blob: Blob,
  options: PngOptimizeOptions = {},
): Promise<PngOptimizeResult> {
  if (!(blob instanceof Blob)) {
    throw new InvalidOptionsError('optimizePngBlob: input must be a Blob');
  }
  validateOptions(options);
  throwIfAborted(options.signal);
  if (typeof CompressionStream !== 'function' || typeof DecompressionStream !== 'function') {
    throw new EnvironmentError(
      'optimizePngBlob: CompressionStream/DecompressionStream are unavailable in this environment.',
    );
  }

  const inputBytes = new Uint8Array(await blob.arrayBuffer());
  throwIfAborted(options.signal);
  const chunks = parsePngChunks(inputBytes);
  if (!chunks) {
    throw new InvalidOptionsError('optimizePngBlob: input is not a valid PNG');
  }

  const idatIndexes = chunks
    .map((chunk, index) => (chunk.type === 'IDAT' ? index : -1))
    .filter((index) => index >= 0);
  if (idatIndexes.length === 0) {
    throw new InvalidOptionsError('optimizePngBlob: PNG contains no IDAT chunks');
  }
  const firstIdat = idatIndexes[0];
  const lastIdat = idatIndexes[idatIndexes.length - 1];
  if (lastIdat - firstIdat + 1 !== idatIndexes.length) {
    throw new InvalidOptionsError('optimizePngBlob: PNG IDAT chunks must be consecutive');
  }

  const ihdr = chunks[0] as PngChunk;
  const expectedLength = expectedFilteredByteLength(ihdr.data);
  const compressedInput = concatBytes(
    chunks.slice(firstIdat, lastIdat + 1).map((chunk) => chunk.data),
  );
  const filtered = await transformBytes(
    compressedInput,
    new DecompressionStream('deflate') as ByteTransform,
    expectedLength,
    options.signal,
    'IDAT decompression',
  );
  if (filtered.length !== expectedLength) {
    throw new InvalidOptionsError(
      `optimizePngBlob: PNG filtered data has ${filtered.length} bytes, expected ${expectedLength}`,
    );
  }

  const maxCompressedLength = filtered.length + Math.ceil(filtered.length / 2) + 65_536;
  const recompressed = await transformBytes(
    filtered,
    new CompressionStream('deflate') as ByteTransform,
    maxCompressedLength,
    options.signal,
    'IDAT compression',
  );
  const verified = await transformBytes(
    recompressed,
    new DecompressionStream('deflate') as ByteTransform,
    expectedLength,
    options.signal,
    'IDAT verification',
  );
  if (!equalBytes(filtered, verified, options.signal)) {
    throw new InvalidOptionsError('optimizePngBlob: recompressed PNG data failed byte verification');
  }

  const outputParts: Uint8Array[] = [PNG_SIGNATURE];
  for (const chunk of chunks.slice(0, firstIdat)) outputParts.push(chunk.raw);
  for (let offset = 0; offset < recompressed.length; offset += IDAT_CHUNK_SIZE) {
    outputParts.push(
      serializePngChunk('IDAT', recompressed.subarray(offset, offset + IDAT_CHUNK_SIZE)),
    );
  }
  for (const chunk of chunks.slice(lastIdat + 1)) outputParts.push(chunk.raw);
  const outputBytes = concatBytes(outputParts);

  // Финальный структурный контроль: парсер и CRC обязаны принять результат,
  // а последовательность не-IDAT чанков — совпасть с входом по типам.
  const outputChunks = parsePngChunks(outputBytes);
  const inputNonIdat = chunks.filter((chunk) => chunk.type !== 'IDAT').map((chunk) => chunk.type);
  const outputNonIdat = outputChunks
    ?.filter((chunk) => chunk.type !== 'IDAT')
    .map((chunk) => chunk.type);
  if (!outputChunks || JSON.stringify(inputNonIdat) !== JSON.stringify(outputNonIdat)) {
    throw new InvalidOptionsError('optimizePngBlob: PNG rewrite failed structural verification');
  }

  if (options.onlyIfSmaller !== false && outputBytes.length >= inputBytes.length) {
    return {
      blob,
      optimized: false,
      originalSize: blob.size,
      size: blob.size,
      engine: 'compression-stream',
    };
  }

  const optimizedBlob = new Blob([outputBytes as Uint8Array<ArrayBuffer>], { type: 'image/png' });
  return {
    blob: optimizedBlob,
    optimized: true,
    originalSize: blob.size,
    size: optimizedBlob.size,
    engine: 'compression-stream',
  };
}
