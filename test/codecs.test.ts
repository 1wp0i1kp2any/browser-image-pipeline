import { describe, expect, it } from 'vitest';
import { image } from '../src/index.js';
import { mapJpegOptions } from '../src/codecs/jpeg.js';
import { UnsupportedChannelError } from '../src/errors.js';
import { anyBlob, decoderFor, photoFrame } from './helpers.js';

// Реальные wasm-кодеки @jsquash в Node: декодер источника подменён швом,
// но энкод — настоящий MozJPEG/PNG. Это самая честная проверка, доступная
// без браузера; браузерный смоук — отдельным шагом (см. README/отчёт).

describe('встроенные кодеки (реальный wasm)', () => {
  it('jpeg: валидный JPEG, вес монотонно растёт с качеством', async () => {
    const frame = photoFrame(120, 120);
    const encode = (quality: number) =>
      image(anyBlob(), (p) => p.encode('image/jpeg', { quality }), {
        decoder: decoderFor(frame),
      });
    const lo = await encode(0.5);
    const hi = await encode(0.95);
    expect(lo.type).toBe('image/jpeg');
    const head = new Uint8Array(await lo.slice(0, 3).arrayBuffer());
    expect([...head]).toEqual([0xff, 0xd8, 0xff]); // SOI-маркер JPEG
    expect(hi.size).toBeGreaterThan(lo.size);
  });

  it('jpeg: grayscale-канал легче цветного на том же качестве', async () => {
    const frame = photoFrame(120, 120);
    const encode = (channel?: string) =>
      image(anyBlob(), (p) => p.encode('image/jpeg', { quality: 0.9, channel }), {
        decoder: decoderFor(frame),
      });
    const color = await encode('ycbcr');
    const gray = await encode('grayscale');
    expect(gray.size).toBeLessThan(color.size);
  });

  it('png: валидный PNG; палитра (quantize) режет вес независимо от формата', async () => {
    const frame = photoFrame(120, 120);
    const plain = await image(anyBlob(), (p) => p.encode('image/png'), {
      decoder: decoderFor(frame),
    });
    const head = new Uint8Array(await plain.slice(0, 8).arrayBuffer());
    expect([...head]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG signature
    const quantized = await image(
      anyBlob(),
      async (p) => {
        await p.quantize({ colors: 16, dithering: 0 });
        return p.encode('image/png');
      },
      { decoder: decoderFor(frame) },
    );
    expect(quantized.size).toBeLessThan(plain.size);
  });

  it('fit поверх реального jpeg: попадает в лимит и докладывает параметры', async () => {
    const hit = await image(
      anyBlob(),
      (p) =>
        p.fit(
          { formats: ['image/jpeg'], quality: [0.5, 0.99], frame: { width: 200, height: 200 } },
          (c) => c.size <= 12_000,
        ),
      { decoder: decoderFor(photoFrame(400, 400)) },
    );
    expect(hit).not.toBeNull();
    expect(hit!.blob.type).toBe('image/jpeg');
    expect(hit!.blob.size).toBeLessThanOrEqual(12_000);
    expect(hit!.attempts).toBeGreaterThan(0);
  });
});

describe('отображение опций jpeg', () => {
  it('quality 0..1 → 0..100, channel → color_space, остальное пробрасывается', () => {
    expect(mapJpegOptions({ quality: 0.9, channel: 'grayscale', progressive: true })).toEqual({
      quality: 90,
      color_space: 1,
      progressive: true,
    });
    // Прямой color_space старше channel.
    expect(mapJpegOptions({ channel: 'grayscale', color_space: 3 }).color_space).toBe(3);
  });

  it('неизвестный канал — UnsupportedChannelError, не молчаливый игнор', () => {
    expect(() => mapJpegOptions({ channel: 'cmyk' })).toThrow(UnsupportedChannelError);
  });
});
