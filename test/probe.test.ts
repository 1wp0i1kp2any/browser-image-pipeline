import { describe, expect, it } from 'vitest';
import { probeImageHeader } from '../src/probe.js';
import { getEncoder } from '../src/index.js';
import { photoFrame } from './helpers.js';

/** Вставить JPEG-сегмент (маркер + длина + payload) сразу после SOI. */
function insertJpegSegment(jpeg: Uint8Array, marker: number, payload: Uint8Array): Uint8Array {
  const seg = new Uint8Array(4 + payload.length);
  seg[0] = 0xff;
  seg[1] = marker;
  seg[2] = ((payload.length + 2) >> 8) & 0xff;
  seg[3] = (payload.length + 2) & 0xff;
  seg.set(payload, 4);
  const out = new Uint8Array(jpeg.length + seg.length);
  out.set(jpeg.subarray(0, 2), 0);
  out.set(seg, 2);
  out.set(jpeg.subarray(2), 2 + seg.length);
  return out;
}

/** Минимальный EXIF APP1 payload с одной записью Orientation (big-endian TIFF). */
function exifOrientationPayload(orientation: number): Uint8Array {
  const p = new Uint8Array(6 + 8 + 2 + 12 + 4);
  p.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 0); // Exif\0\0
  p.set([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08], 6); // MM, 42, IFD0 @ 8
  p.set([0x00, 0x01], 14); // одна запись
  const e = 16;
  p.set([0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00], e);
  return p;
}

async function encodeBytes(format: string, quality = 0.8): Promise<Uint8Array> {
  const blob = await getEncoder(format).encode(photoFrame(64, 40), { quality });
  return new Uint8Array(await blob.arrayBuffer());
}

describe('probeImageHeader', () => {
  it('реальные энкоды: jpeg/png/webp распознаются с размерами', async () => {
    const jpeg = probeImageHeader(await encodeBytes('image/jpeg'));
    expect(jpeg).toMatchObject({ format: 'image/jpeg', width: 64, height: 40 });

    const png = probeImageHeader(await encodeBytes('image/png'));
    expect(png).toMatchObject({ format: 'image/png', width: 64, height: 40, hasAlpha: true });

    const webp = probeImageHeader(await encodeBytes('image/webp'));
    expect(webp?.format).toBe('image/webp');
    expect(webp?.width).toBe(64);
    expect(webp?.height).toBe(40);
  });

  it('JPEG: COM-сегмент и EXIF-ориентация читаются', async () => {
    let bytes = await encodeBytes('image/jpeg');
    bytes = insertJpegSegment(bytes, 0xfe, new TextEncoder().encode('bip:1;profile=client'));
    bytes = insertJpegSegment(bytes, 0xe1, exifOrientationPayload(6));
    const info = probeImageHeader(bytes);
    expect(info?.format).toBe('image/jpeg');
    expect(info?.comment).toBe('bip:1;profile=client');
    expect(info?.orientation).toBe(6);
  });

  it('JPEG: голова файла без SOF — null, со SOF — факты', async () => {
    const bytes = await encodeBytes('image/jpeg');
    expect(probeImageHeader(bytes.subarray(0, 4))).toBeNull();
    expect(probeImageHeader(bytes.subarray(0, 1024))?.width).toBe(64);
  });

  it('не картинки: zip, текст, пустота, случайные байты — null', () => {
    expect(probeImageHeader(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]))).toBeNull();
    expect(probeImageHeader(new TextEncoder().encode('not an image at all'))).toBeNull();
    expect(probeImageHeader(new Uint8Array(0))).toBeNull();
    expect(probeImageHeader(new Uint8Array([9, 8, 7]))).toBeNull();
    // JPEG-сигнатура без SOF — не картинка, а обещание.
    expect(probeImageHeader(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
    // PNG-сигнатура с нулевой шириной в IHDR.
    const badPng = new Uint8Array(29);
    badPng.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    badPng.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
    expect(probeImageHeader(badPng)).toBeNull();
  });

  it('WebP VP8L и VP8X: синтетические заголовки', () => {
    // VP8L: 300×200, alpha=1.
    const vp8l = new Uint8Array(21 + 5);
    vp8l.set(new TextEncoder().encode('RIFF'), 0);
    vp8l.set(new TextEncoder().encode('WEBPVP8L'), 8);
    const bits = (299 | (199 << 14) | (1 << 28)) >>> 0;
    vp8l[20] = 0x2f;
    vp8l[21] = bits & 0xff;
    vp8l[22] = (bits >> 8) & 0xff;
    vp8l[23] = (bits >> 16) & 0xff;
    vp8l[24] = (bits >> 24) & 0xff;
    expect(probeImageHeader(vp8l)).toMatchObject({
      format: 'image/webp',
      width: 300,
      height: 200,
      hasAlpha: true,
    });

    // VP8X: 1024×768, alpha-флаг выставлен.
    const vp8x = new Uint8Array(20 + 10);
    vp8x.set(new TextEncoder().encode('RIFF'), 0);
    vp8x.set(new TextEncoder().encode('WEBPVP8X'), 8);
    vp8x[20] = 0x10;
    vp8x.set([1023 & 0xff, (1023 >> 8) & 0xff, 0], 24);
    vp8x.set([767 & 0xff, (767 >> 8) & 0xff, 0], 27);
    expect(probeImageHeader(vp8x)).toMatchObject({
      format: 'image/webp',
      width: 1024,
      height: 768,
      hasAlpha: true,
    });
  });

  it('AVIF: синтетические боксы ftyp/meta/iprp/ipco/ispe', () => {
    const box = (type: string, payload: Uint8Array): Uint8Array => {
      const out = new Uint8Array(8 + payload.length);
      const size = out.length;
      out.set([(size >> 24) & 0xff, (size >> 16) & 0xff, (size >> 8) & 0xff, size & 0xff], 0);
      out.set(new TextEncoder().encode(type), 4);
      out.set(payload, 8);
      return out;
    };
    const cat = (...parts: Uint8Array[]): Uint8Array => {
      const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let off = 0;
      for (const p of parts) {
        out.set(p, off);
        off += p.length;
      }
      return out;
    };
    const ispePayload = new Uint8Array(12);
    ispePayload.set([0, 0, 0x07, 0x80], 4); // 1920
    ispePayload.set([0, 0, 0x04, 0x38], 8); // 1080
    const avif = cat(
      box('ftyp', cat(new TextEncoder().encode('avif'), new Uint8Array(4))),
      box('meta', cat(new Uint8Array(4), box('iprp', box('ipco', box('ispe', ispePayload))))),
    );
    expect(probeImageHeader(avif)).toMatchObject({
      format: 'image/avif',
      width: 1920,
      height: 1080,
    });
  });
});
