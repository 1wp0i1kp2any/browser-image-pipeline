import { describe, expect, it } from 'vitest';
import { quantizeFrame } from '../src/quantize.js';
import { InvalidOptionsError } from '../src/errors.js';
import { countColors, photoFrame } from './helpers.js';

describe('quantize (реальный image-q + свой Floyd–Steinberg)', () => {
  it('срезает палитру до заданного числа цветов, формат кадра не меняет', async () => {
    const src = photoFrame(120, 120);
    const out = await quantizeFrame(src, 16, 0);
    expect(out.width).toBe(src.width);
    expect(out.height).toBe(src.height);
    expect(out.data.length).toBe(src.data.length);
    expect(countColors(out)).toBeLessThanOrEqual(16);
  });

  it('dithering=0 — чистый nearest: повторный прогон бит-в-бит тот же', async () => {
    const src = photoFrame(80, 80);
    const a = await quantizeFrame(src, 32, 0);
    const b = await quantizeFrame(src, 32, 0);
    expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(true);
  });

  it('dithering>0 меняет пиксели, но не число цветов палитры', async () => {
    const src = photoFrame(80, 80);
    const plain = await quantizeFrame(src, 8, 0);
    const dithered = await quantizeFrame(src, 8, 1);
    expect(countColors(dithered)).toBeLessThanOrEqual(8);
    expect(Buffer.from(dithered.data).equals(Buffer.from(plain.data))).toBe(false);
  });

  it('валидация диапазонов', async () => {
    const src = photoFrame(8, 8);
    await expect(quantizeFrame(src, 1, 0)).rejects.toThrow(InvalidOptionsError);
    await expect(quantizeFrame(src, 300, 0)).rejects.toThrow(InvalidOptionsError);
    await expect(quantizeFrame(src, 16, 1.5)).rejects.toThrow(InvalidOptionsError);
  });
});
