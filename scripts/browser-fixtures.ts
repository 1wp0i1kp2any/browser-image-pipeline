// Браузерные fixtures входных изображений.
//
// Покрытие:
// - EXIF-ориентации JPEG 1–8 через createImageBitmap(...,
//   { imageOrientation: 'from-image' });
// - встроенный sRGB ICC в PNG/JPEG/WebP;
// - настоящие PNG color type 0 (grayscale) и 3 (palette+tRNS);
// - прозрачность и Adam7 interlace;
// - анимированные GIF/APNG/WebP: браузерный путь библиотеки обязан дать
//   первый кадр, а не кадр по времени открытия;
// - AVIF-вход как capability-проба (не все движки обязаны его декодировать).
//
// Все байты генерируются детерминированно в этом файле из синтетических
// кадров. Запуск:
//   ./node_modules/.bin/tsx scripts/browser-fixtures.ts [chromium|firefox|webkit]

import { deflateSync } from 'node:zlib';
import '../test/setup-wasm.js';
import { chromium, firefox, webkit } from 'playwright';
import { image } from '../src/index.js';
import {
  PNG_SIGNATURE,
  concatBytes,
  parsePngChunks,
  serializePngChunk,
} from '../src/png-chunks.js';
import { anyBlob, decoderFor, makeFrame, photoFrame } from '../test/helpers.js';
import type { Frame } from '../src/index.js';

// 588-байтный built-in sRGB profile, сгенерированный Little CMS.
// Текст профиля прямо говорит «No copyright, use freely».
const SRGB_ICC_BASE64 =
  'AAACTGxjbXMEQAAAbW50clJHQiBYWVogB+oACgAUAAQAIQA1YWNzcEFQUEwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPbWAAEA' +
  'AAAA0y1sY21zAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAALZGVzYwAAAQgAAAA2Y3BydAAA' +
  'AUAAAABMd3RwdAAAAYwAAAAUY2hhZAAAAaAAAAAsclhZWgAAAcwAAAAUYlhZWgAAAeAAAAAUZ1hZWgAAAfQAAAAUclRSQwAAAggA' +
  'AAAgZ1RSQwAAAggAAAAgYlRSQwAAAggAAAAgY2hybQAAAigAAAAkbWx1YwAAAAAAAAABAAAADGVuVVMAAAAaAAAAHABzAFIARwBC' +
  'ACAAYgB1AGkAbAB0AC0AaQBuAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAADAAAAAcAE4AbwAgAGMAbwBwAHkAcgBpAGcAaAB0ACwA' +
  'IAB1AHMAZQAgAGYAcgBlAGUAbAB5WFlaIAAAAAAAAPbWAAEAAAAA0y1zZjMyAAAAAAABDEIAAAXe///zJQAAB5MAAP2Q///7of//' +
  '/aIAAAPcAADAblhZWiAAAAAAAABvoAAAOPUAAAOQWFlaIAAAAAAAACSfAAAPhAAAtsNYWVogAAAAAAAAYpcAALeHAAAY2XBhcmEA' +
  'AAAAAAMAAAACZmYAAPKnAAANWQAAE9AAAApbY2hybQAAAAAAAwAAAACj1wAAVHsAAEzNAACZmgAAJmYAAA9c';
const SRGB_ICC = new Uint8Array(Buffer.from(SRGB_ICC_BASE64, 'base64'));

// Двухкадровый GIF 4×2: первый кадр красный, второй синий, по 1 секунде.
const ANIMATED_GIF_BASE64 =
  'R0lGODlhBAACAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQAZAAAACwAAAAABAACAAAIBwABCBwoMCAAIfkE' +
  'AGQAAAAsAAAAAAQAAgCBAAD/AAAAAAAAAAAACAcAAQgcKDAgADs=';

function exifOrientationSegment(orientation: number): Uint8Array {
  const tiff = new Uint8Array([
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, // II, magic, IFD0 offset
    0x01, 0x00, // one entry
    0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, orientation, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, // next IFD
  ]);
  const app1Payload = new Uint8Array(6 + tiff.length);
  app1Payload.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 0); // Exif\0\0
  app1Payload.set(tiff, 6);
  const segment = new Uint8Array(4 + app1Payload.length);
  segment[0] = 0xff;
  segment[1] = 0xe1;
  new DataView(segment.buffer).setUint16(2, app1Payload.length + 2);
  segment.set(app1Payload, 4);
  return segment;
}

function withOrientation(jpeg: Uint8Array, orientation: number): Uint8Array {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('base is not JPEG');
  const segment = exifOrientationSegment(orientation);
  const out = new Uint8Array(jpeg.length + segment.length);
  out.set(jpeg.subarray(0, 2), 0);
  out.set(segment, 2);
  out.set(jpeg.subarray(2), 2 + segment.length);
  return out;
}

function jpegWithIcc(jpeg: Uint8Array, icc: Uint8Array): Uint8Array {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('base is not JPEG');
  const identifier = new TextEncoder().encode('ICC_PROFILE\0');
  const maxPart = 65_519;
  const parts: Uint8Array[] = [];
  const count = Math.ceil(icc.length / maxPart);
  for (let i = 0; i < count; i++) {
    const part = icc.subarray(i * maxPart, (i + 1) * maxPart);
    const payload = concatBytes([identifier, new Uint8Array([i + 1, count]), part]);
    const segment = new Uint8Array(4 + payload.length);
    segment[0] = 0xff;
    segment[1] = 0xe2;
    new DataView(segment.buffer).setUint16(2, payload.length + 2);
    segment.set(payload, 4);
    parts.push(segment);
  }
  return concatBytes([jpeg.subarray(0, 2), ...parts, jpeg.subarray(2)]);
}

function pngWithIcc(png: Uint8Array, icc: Uint8Array): Uint8Array {
  const chunks = parsePngChunks(png);
  if (!chunks) throw new Error('base is not a valid PNG');
  const name = new TextEncoder().encode('sRGB built-in');
  const iccp = serializePngChunk(
    'iCCP',
    concatBytes([name, new Uint8Array([0, 0]), deflateSync(icc)]),
  );
  return concatBytes([
    PNG_SIGNATURE,
    chunks[0].raw,
    iccp,
    ...chunks.slice(1).map((chunk) => chunk.raw),
  ]);
}

interface RiffChunk {
  type: string;
  data: Uint8Array;
}

function parseRiff(bytes: Uint8Array): RiffChunk[] {
  const tag = (offset: number): string =>
    String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WEBP') throw new Error('base is not WebP');
  const chunks: RiffChunk[] = [];
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const type = tag(offset);
    const length =
      bytes[offset + 4] |
      (bytes[offset + 5] << 8) |
      (bytes[offset + 6] << 16) |
      (bytes[offset + 7] << 24);
    chunks.push({ type, data: bytes.subarray(offset + 8, offset + 8 + length) });
    offset += 8 + length + (length & 1);
  }
  return chunks;
}

function serializeRiffChunk(chunk: RiffChunk): Uint8Array {
  const out = new Uint8Array(8 + chunk.data.length + (chunk.data.length & 1));
  for (let i = 0; i < 4; i++) out[i] = chunk.type.charCodeAt(i);
  new DataView(out.buffer).setUint32(4, chunk.data.length, true);
  out.set(chunk.data, 8);
  return out;
}

function serializeWebp(chunks: RiffChunk[]): Uint8Array {
  const body = concatBytes(chunks.map(serializeRiffChunk));
  const out = new Uint8Array(12 + body.length);
  out.set(new TextEncoder().encode('RIFF'), 0);
  new DataView(out.buffer).setUint32(4, body.length + 4, true);
  out.set(new TextEncoder().encode('WEBP'), 8);
  out.set(body, 12);
  return out;
}

function vp8x(width: number, height: number, flags: number): RiffChunk {
  const data = new Uint8Array(10);
  data[0] = flags;
  const write24 = (offset: number, value: number) => {
    data[offset] = value & 0xff;
    data[offset + 1] = (value >> 8) & 0xff;
    data[offset + 2] = (value >> 16) & 0xff;
  };
  write24(4, width - 1);
  write24(7, height - 1);
  return { type: 'VP8X', data };
}

function webpWithIcc(bytes: Uint8Array, width: number, height: number, icc: Uint8Array): Uint8Array {
  const chunks = parseRiff(bytes).filter((chunk) => chunk.type !== 'ICCP');
  const existing = chunks.findIndex((chunk) => chunk.type === 'VP8X');
  if (existing >= 0) {
    const data = new Uint8Array(chunks[existing].data);
    data[0] |= 0x20;
    chunks[existing] = { type: 'VP8X', data };
    chunks.splice(existing + 1, 0, { type: 'ICCP', data: icc });
  } else {
    chunks.unshift({ type: 'ICCP', data: icc });
    chunks.unshift(vp8x(width, height, 0x20));
  }
  return serializeWebp(chunks);
}

function animatedWebp(stills: Uint8Array[], width: number, height: number): Uint8Array {
  const frames = stills.map((still) => {
    const bitstream = parseRiff(still).find(
      (chunk) => chunk.type === 'VP8L' || chunk.type === 'VP8 ',
    );
    if (!bitstream) throw new Error('still WebP has no VP8/VP8L bitstream');
    const header = new Uint8Array(16);
    const view = new DataView(header.buffer);
    const write24 = (offset: number, value: number) => {
      header[offset] = value & 0xff;
      header[offset + 1] = (value >> 8) & 0xff;
      header[offset + 2] = (value >> 16) & 0xff;
    };
    write24(6, width - 1);
    write24(9, height - 1);
    write24(12, 1000);
    view.setUint8(15, 0);
    return {
      type: 'ANMF',
      data: concatBytes([header, serializeRiffChunk(bitstream)]),
    } satisfies RiffChunk;
  });
  return serializeWebp([
    vp8x(width, height, 0x02),
    { type: 'ANIM', data: new Uint8Array([255, 255, 255, 255, 0, 0]) },
    ...frames,
  ]);
}

function pngIhdr(width: number, height: number, colorType: number): Uint8Array {
  const out = new Uint8Array(13);
  const view = new DataView(out.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  out[8] = 8;
  out[9] = colorType;
  return serializePngChunk('IHDR', out);
}

function manualPng(args: {
  width: number;
  height: number;
  colorType: number;
  scanlines: Uint8Array;
  beforeIdat?: Uint8Array[];
}): Uint8Array {
  return concatBytes([
    PNG_SIGNATURE,
    pngIhdr(args.width, args.height, args.colorType),
    ...(args.beforeIdat ?? []),
    serializePngChunk('IDAT', deflateSync(args.scanlines)),
    serializePngChunk('IEND', new Uint8Array()),
  ]);
}

function fctl(sequence: number, width: number, height: number): Uint8Array {
  const out = new Uint8Array(26);
  const view = new DataView(out.buffer);
  view.setUint32(0, sequence);
  view.setUint32(4, width);
  view.setUint32(8, height);
  view.setUint16(20, 100); // delay 100/100 = 1 s
  view.setUint16(22, 100);
  return serializePngChunk('fcTL', out);
}

function solidScanlines(
  width: number,
  height: number,
  rgba: readonly [number, number, number, number],
): Uint8Array {
  const out = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) out.set(rgba, y * (1 + width * 4) + 1 + x * 4);
  }
  return out;
}

function animatedPng(width: number, height: number): Uint8Array {
  const actl = new Uint8Array(8);
  new DataView(actl.buffer).setUint32(0, 2);
  const secondSequence = new Uint8Array(4);
  new DataView(secondSequence.buffer).setUint32(0, 2);
  return concatBytes([
    PNG_SIGNATURE,
    pngIhdr(width, height, 6),
    serializePngChunk('acTL', actl),
    fctl(0, width, height),
    serializePngChunk('IDAT', deflateSync(solidScanlines(width, height, [255, 0, 0, 255]))),
    fctl(1, width, height),
    serializePngChunk(
      'fdAT',
      concatBytes([
        secondSequence,
        deflateSync(solidScanlines(width, height, [0, 0, 255, 255])),
      ]),
    ),
    serializePngChunk('IEND', new Uint8Array()),
  ]);
}

async function encodeBytes(
  frame: Frame,
  format: string,
  options?: Record<string, unknown>,
): Promise<Uint8Array> {
  const blob = await image(anyBlob(), (p) => p.encode(format, options), {
    decoder: decoderFor(frame),
  });
  return new Uint8Array(await blob.arrayBuffer());
}

type Pixel = readonly [number, number, number, number];

interface MediaCase {
  name: string;
  mime: string;
  bytes: Uint8Array;
  width: number;
  height: number;
  first: Pixel;
  last: Pixel;
  tolerance: number;
  required: boolean;
  firstAlphaOnly?: boolean;
}

const orientationFrame = makeFrame(4, 2, (x, y) => {
  const colors = [
    [255, 0, 0, 255],
    [0, 255, 0, 255],
    [0, 0, 255, 255],
    [255, 255, 0, 255],
  ] as const;
  return colors[(y * 2 + Math.min(1, Math.floor(x / 2))) % colors.length];
});
const baseJpegBytes = await encodeBytes(orientationFrame, 'image/jpeg', { quality: 0.95 });

const solidColor = [32, 160, 220, 255] as const;
const solidFrame = makeFrame(8, 8, () => solidColor);
const solidPng = await encodeBytes(solidFrame, 'image/png');
const solidJpeg = await encodeBytes(solidFrame, 'image/jpeg', { quality: 0.95 });
const solidWebp = await encodeBytes(solidFrame, 'image/webp', { lossless: true, quality: 1 });

const interlaceFrame = photoFrame(16, 12);
const interlacedPng = await encodeBytes(interlaceFrame, 'image/png', {
  oxipng: { level: 1, interlace: true },
});
const interlaceFirst = [...interlaceFrame.data.subarray(0, 4)] as unknown as Pixel;
const interlaceLast = [
  ...interlaceFrame.data.subarray(interlaceFrame.data.length - 4),
] as unknown as Pixel;

const grayWidth = 8;
const grayHeight = 4;
const grayScanlines = new Uint8Array(grayHeight * (grayWidth + 1));
const grayValue = (x: number, y: number): number => (17 + x * 23 + y * 41) % 256;
for (let y = 0; y < grayHeight; y++) {
  for (let x = 0; x < grayWidth; x++) {
    grayScanlines[y * (grayWidth + 1) + 1 + x] = grayValue(x, y);
  }
}
const grayFirstValue = grayValue(0, 0);
const grayLastValue = grayValue(grayWidth - 1, grayHeight - 1);
const grayscalePng = manualPng({
  width: grayWidth,
  height: grayHeight,
  colorType: 0,
  scanlines: grayScanlines,
});

const paletteWidth = 4;
const paletteHeight = 2;
const paletteScanlines = new Uint8Array(paletteHeight * (paletteWidth + 1));
for (let y = 0; y < paletteHeight; y++) {
  for (let x = 0; x < paletteWidth; x++) {
    paletteScanlines[y * (paletteWidth + 1) + 1 + x] = (x + y * 2) % 4;
  }
}
const palettePng = manualPng({
  width: paletteWidth,
  height: paletteHeight,
  colorType: 3,
  scanlines: paletteScanlines,
  beforeIdat: [
    serializePngChunk(
      'PLTE',
      new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 12, 34, 56]),
    ),
    serializePngChunk('tRNS', new Uint8Array([255, 128, 255, 255])),
  ],
});

const transparentFrame = makeFrame(4, 2, (x) =>
  x === 0 ? [255, 0, 0, 0] : [0, 0, 255, 255],
);
const transparentPng = await encodeBytes(transparentFrame, 'image/png');

const webpRed = await encodeBytes(
  makeFrame(4, 2, () => [255, 0, 0, 255]),
  'image/webp',
  { lossless: true, quality: 1 },
);
const webpBlue = await encodeBytes(
  makeFrame(4, 2, () => [0, 0, 255, 255]),
  'image/webp',
  { lossless: true, quality: 1 },
);

let avifBytes: Uint8Array | undefined;
try {
  avifBytes = await encodeBytes(solidFrame, 'image/avif', { quality: 0.8 });
} catch {
  avifBytes = undefined;
}

const mediaCases: MediaCase[] = [
  {
    name: 'PNG + sRGB ICC',
    mime: 'image/png',
    bytes: pngWithIcc(solidPng, SRGB_ICC),
    width: 8,
    height: 8,
    first: solidColor,
    last: solidColor,
    tolerance: 1,
    required: true,
  },
  {
    name: 'JPEG + sRGB ICC',
    mime: 'image/jpeg',
    bytes: jpegWithIcc(solidJpeg, SRGB_ICC),
    width: 8,
    height: 8,
    first: solidColor,
    last: solidColor,
    tolerance: 10,
    required: true,
  },
  {
    name: 'WebP + sRGB ICC',
    mime: 'image/webp',
    bytes: webpWithIcc(solidWebp, 8, 8, SRGB_ICC),
    width: 8,
    height: 8,
    first: solidColor,
    last: solidColor,
    tolerance: 1,
    required: true,
  },
  {
    name: 'PNG grayscale color type 0',
    mime: 'image/png',
    bytes: grayscalePng,
    width: grayWidth,
    height: grayHeight,
    first: [grayFirstValue, grayFirstValue, grayFirstValue, 255],
    last: [grayLastValue, grayLastValue, grayLastValue, 255],
    tolerance: 0,
    required: true,
  },
  {
    name: 'PNG palette+tRNS color type 3',
    mime: 'image/png',
    bytes: palettePng,
    width: paletteWidth,
    height: paletteHeight,
    first: [255, 0, 0, 255],
    last: [0, 255, 0, 128],
    tolerance: 2,
    required: true,
  },
  {
    name: 'PNG Adam7 interlace',
    mime: 'image/png',
    bytes: interlacedPng,
    width: interlaceFrame.width,
    height: interlaceFrame.height,
    first: interlaceFirst,
    last: interlaceLast,
    tolerance: 0,
    required: true,
  },
  {
    name: 'PNG прозрачность: скрытый RGB не является контрактом',
    mime: 'image/png',
    bytes: transparentPng,
    width: 4,
    height: 2,
    first: [0, 0, 0, 0],
    last: [0, 0, 255, 255],
    tolerance: 0,
    required: true,
    firstAlphaOnly: true,
  },
  {
    name: 'GIF animation → первый кадр',
    mime: 'image/gif',
    bytes: new Uint8Array(Buffer.from(ANIMATED_GIF_BASE64, 'base64')),
    width: 4,
    height: 2,
    first: [255, 0, 0, 255],
    last: [255, 0, 0, 255],
    tolerance: 0,
    required: true,
  },
  {
    name: 'APNG animation → первый кадр',
    mime: 'image/png',
    bytes: animatedPng(4, 2),
    width: 4,
    height: 2,
    first: [255, 0, 0, 255],
    last: [255, 0, 0, 255],
    tolerance: 0,
    required: true,
  },
  {
    name: 'WebP animation → первый кадр',
    mime: 'image/webp',
    bytes: animatedWebp([webpRed, webpBlue], 4, 2),
    width: 4,
    height: 2,
    first: [255, 0, 0, 255],
    last: [255, 0, 0, 255],
    tolerance: 1,
    required: true,
  },
];

if (avifBytes) {
  mediaCases.push({
    name: 'AVIF still input (capability)',
    mime: 'image/avif',
    bytes: avifBytes,
    width: 8,
    height: 8,
    first: solidColor,
    last: solidColor,
    tolerance: 12,
    required: false,
  });
}

const browserName = (process.argv[2] ?? 'chromium').toLowerCase();
const engines = { chromium, firefox, webkit } as const;
const engine = engines[browserName as keyof typeof engines];
if (!engine) throw new Error(`unknown browser ${browserName}`);

const browser = await engine.launch();
try {
  const page = await browser.newPage();
  await page.goto('about:blank');
  let failed = false;

  for (let orientation = 1; orientation <= 8; orientation++) {
    const bytes = [...withOrientation(baseJpegBytes, orientation)];
    const result = await page.evaluate(async (data: number[]) => {
      const blob = new Blob([new Uint8Array(data)], { type: 'image/jpeg' });
      const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      try {
        return { width: bitmap.width, height: bitmap.height };
      } finally {
        bitmap.close();
      }
    }, bytes);
    const expected = orientation >= 5 ? { width: 2, height: 4 } : { width: 4, height: 2 };
    const ok = result.width === expected.width && result.height === expected.height;
    if (!ok) failed = true;
    console.log(
      `${ok ? '✓' : '✗'} EXIF ${orientation}: ${result.width}×${result.height} (ожидалось ${expected.width}×${expected.height})`,
    );
  }

  for (const mediaCase of mediaCases) {
    const payload = {
      mime: mediaCase.mime,
      bytes: [...mediaCase.bytes],
    };
    const result = await page.evaluate(async ({ mime, bytes }) => {
      let bitmap: ImageBitmap | undefined;
      try {
        const blob = new Blob([new Uint8Array(bytes)], { type: mime });
        try {
          bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
        } catch {
          bitmap = await createImageBitmap(blob);
        }
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext('2d');
        if (!context) throw new Error('OffscreenCanvas 2d context unavailable');
        context.drawImage(bitmap, 0, 0);
        const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
        return {
          ok: true as const,
          width: bitmap.width,
          height: bitmap.height,
          first: [...data.subarray(0, 4)],
          last: [...data.subarray(data.length - 4)],
        };
      } catch (error) {
        return {
          ok: false as const,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        };
      } finally {
        bitmap?.close();
      }
    }, payload);

    if (!result.ok) {
      if (mediaCase.required) failed = true;
      console.log(
        `${mediaCase.required ? '✗' : '○'} ${mediaCase.name}: не декодируется (${result.error})` +
          (mediaCase.required ? '' : ' — capability отсутствует, пропуск допустим'),
      );
      continue;
    }

    const close = (actual: number[], expected: Pixel, alphaOnly = false): boolean =>
      actual.length === 4 &&
      (alphaOnly
        ? Math.abs(actual[3] - expected[3]) <= mediaCase.tolerance
        : actual.every((value, index) => Math.abs(value - expected[index]) <= mediaCase.tolerance));
    const ok =
      result.width === mediaCase.width &&
      result.height === mediaCase.height &&
      close(result.first, mediaCase.first, mediaCase.firstAlphaOnly) &&
      close(result.last, mediaCase.last);
    if (!ok && mediaCase.required) failed = true;
    console.log(
      `${ok ? '✓' : mediaCase.required ? '✗' : '○'} ${mediaCase.name}: ` +
        `${result.width}×${result.height}, first=${result.first.join(',')}, last=${result.last.join(',')} ` +
        `(ожидалось ${mediaCase.width}×${mediaCase.height}, first=${mediaCase.first.join(',')}, last=${mediaCase.last.join(',')})`,
    );
  }

  if (failed) process.exitCode = 1;
  else console.log(`BROWSER FIXTURES PASSED (${browserName})`);
} finally {
  await browser.close();
}
