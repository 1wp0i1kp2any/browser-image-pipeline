import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { image, optimizePngBlob } from '../src/index.js';
import type { Frame } from '../src/index.js';
import { decodePng } from '../src/codecs/png.js';
import { PNG_SIGNATURE, concatBytes, parsePngChunks, serializePngChunk } from '../src/png-chunks.js';
import { anyBlob, decoderFor, framesEqual, makeFrame, photoFrame } from './helpers.js';

function ihdr(
  width: number,
  height: number,
  bitDepth: number,
  colorType: number,
  interlace = 0,
): Uint8Array {
  const out = new Uint8Array(13);
  const view = new DataView(out.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  out[8] = bitDepth;
  out[9] = colorType;
  out[12] = interlace;
  return out;
}

function manualPng(args: {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  scanlines: Uint8Array;
  beforeIdat?: Uint8Array[];
  interlace?: number;
}): Blob {
  // level 0 намеренно даёт слабый zlib: CompressionStream обязан выиграть.
  const compressed = deflateSync(args.scanlines, { level: 0 });
  const split = Math.max(1, Math.floor(compressed.length / 2));
  const bytes = concatBytes([
    PNG_SIGNATURE,
    serializePngChunk(
      'IHDR',
      ihdr(args.width, args.height, args.bitDepth, args.colorType, args.interlace ?? 0),
    ),
    ...(args.beforeIdat ?? []),
    serializePngChunk('IDAT', compressed.subarray(0, split)),
    serializePngChunk('IDAT', compressed.subarray(split)),
    serializePngChunk('IEND', new Uint8Array()),
  ]);
  return new Blob([bytes], { type: 'image/png' });
}

function scanlines(frame: Frame, bytesPerPixel: number): Uint8Array {
  const rowLength = frame.width * bytesPerPixel;
  const out = new Uint8Array(frame.height * (rowLength + 1));
  for (let y = 0; y < frame.height; y++) {
    const outRow = y * (rowLength + 1) + 1;
    for (let x = 0; x < frame.width; x++) {
      const src = (y * frame.width + x) * 4;
      const dst = outRow + x * bytesPerPixel;
      if (bytesPerPixel === 4) out.set(frame.data.subarray(src, src + 4), dst);
      else out[dst] = frame.data[src];
    }
  }
  return out;
}

describe('PNG optimizer на CompressionStream', () => {
  it('пережимает RGBA только IDAT, сохраняет пиксели и все прочие чанки', async () => {
    const frame = photoFrame(48, 32);
    const gamma = new Uint8Array(4);
    new DataView(gamma.buffer).setUint32(0, 45455);
    const text = new TextEncoder().encode('Comment\0compression-stream fixture');
    const input = manualPng({
      width: frame.width,
      height: frame.height,
      bitDepth: 8,
      colorType: 6,
      scanlines: scanlines(frame, 4),
      beforeIdat: [serializePngChunk('gAMA', gamma), serializePngChunk('tEXt', text)],
    });

    const result = await optimizePngBlob(input, { engine: 'compression-stream' });
    expect(result.engine).toBe('compression-stream');
    expect(result.optimized).toBe(true);
    expect(result.size).toBeLessThan(input.size);
    expect(framesEqual(frame, await decodePng(result.blob))).toBe(true);

    const inputTypes = parsePngChunks(new Uint8Array(await input.arrayBuffer()))!
      .filter((chunk) => chunk.type !== 'IDAT')
      .map((chunk) => chunk.type);
    const outputTypes = parsePngChunks(new Uint8Array(await result.blob.arrayBuffer()))!
      .filter((chunk) => chunk.type !== 'IDAT')
      .map((chunk) => chunk.type);
    expect(outputTypes).toEqual(inputTypes);
    expect(outputTypes).toEqual(['IHDR', 'gAMA', 'tEXt', 'IEND']);
  });

  it('roundtrip grayscale и palette PNG без изменения декодированных пикселей', async () => {
    const gray = makeFrame(31, 17, (x, y) => {
      const v = (x * 11 + y * 7) % 256;
      return [v, v, v, 255];
    });
    const grayInput = manualPng({
      width: gray.width,
      height: gray.height,
      bitDepth: 8,
      colorType: 0,
      scanlines: scanlines(gray, 1),
    });
    const grayOut = await optimizePngBlob(grayInput, {
      engine: 'compression-stream',
      onlyIfSmaller: false,
    });
    expect(framesEqual(gray, await decodePng(grayOut.blob))).toBe(true);

    const palette = new Uint8Array([
      255, 0, 0,
      0, 255, 0,
      0, 0, 255,
      12, 34, 56,
    ]);
    const transparency = new Uint8Array([255, 128, 0, 255]);
    const width = 20;
    const height = 9;
    const indices = new Uint8Array(height * (width + 1));
    const expected = makeFrame(width, height, (x, y) => {
      const index = (x + y * 2) % 4;
      return [
        palette[index * 3],
        palette[index * 3 + 1],
        palette[index * 3 + 2],
        transparency[index],
      ];
    });
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) indices[y * (width + 1) + 1 + x] = (x + y * 2) % 4;
    }
    const paletteInput = manualPng({
      width,
      height,
      bitDepth: 8,
      colorType: 3,
      scanlines: indices,
      beforeIdat: [serializePngChunk('PLTE', palette), serializePngChunk('tRNS', transparency)],
    });
    const paletteOut = await optimizePngBlob(paletteInput, {
      engine: 'compression-stream',
      onlyIfSmaller: false,
    });
    expect(framesEqual(expected, await decodePng(paletteOut.blob))).toBe(true);
  });

  it('сохраняет Adam7 interlace и пиксели результата oxipng', async () => {
    const frame = photoFrame(37, 23);
    const interlaced = await image(
      anyBlob(),
      (p) => p.encode('image/png', { oxipng: { level: 1, interlace: true } }),
      { decoder: decoderFor(frame) },
    );
    const result = await optimizePngBlob(interlaced, {
      engine: 'compression-stream',
      onlyIfSmaller: false,
    });
    const output = parsePngChunks(new Uint8Array(await result.blob.arrayBuffer()))!;
    expect(output[0].data[12]).toBe(1);
    expect(framesEqual(frame, await decodePng(result.blob))).toBe(true);
  }, 120_000);

  it('отклоняет битый CRC, несовместимые опции и уже отменённый сигнал', async () => {
    const frame = photoFrame(8, 8);
    const good = manualPng({
      width: frame.width,
      height: frame.height,
      bitDepth: 8,
      colorType: 6,
      scanlines: scanlines(frame, 4),
    });
    const corruptedBytes = new Uint8Array(await good.arrayBuffer());
    corruptedBytes[corruptedBytes.length - 1] ^= 0xff;
    await expect(
      optimizePngBlob(new Blob([corruptedBytes], { type: 'image/png' }), {
        engine: 'compression-stream',
      }),
    ).rejects.toThrow(/not a valid PNG/);

    await expect(
      optimizePngBlob(good, { engine: 'compression-stream', level: 4 }),
    ).rejects.toThrow(/oxipng-only/);

    const controller = new AbortController();
    controller.abort();
    await expect(
      optimizePngBlob(good, { engine: 'compression-stream', signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
