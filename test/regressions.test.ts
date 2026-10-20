import { describe, expect, it } from 'vitest';
import {
  resizeArea,
  resizeBilinear,
  resizeLanczos3,
  sharpenFrame,
} from '../src/frame.js';
import { buildQualityGrid } from '../src/fit/dimensions.js';
import { applyPaletteWithDithering } from '../src/quantize.js';
import type { Frame } from '../src/types.js';
import { makeFrame } from './helpers.js';

function pixel(frame: Frame, x: number, y = 0): number[] {
  const i = (y * frame.width + x) * 4;
  return [frame.data[i], frame.data[i + 1], frame.data[i + 2], frame.data[i + 3]];
}

/** Детерминированный генератор для property-проверок без новой зависимости. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** Независимая медленная 2D-реализация area для сверки сепарабельной. */
function referenceArea(src: Frame, dstW: number, dstH: number): Frame {
  const out = new Uint8ClampedArray(dstW * dstH * 4);
  const scaleX = src.width / dstW;
  const scaleY = src.height / dstH;
  for (let y = 0; y < dstH; y++) {
    const y0 = y * scaleY;
    const y1 = (y + 1) * scaleY;
    for (let x = 0; x < dstW; x++) {
      const x0 = x * scaleX;
      const x1 = (x + 1) * scaleX;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = Math.floor(y0); sy < Math.min(src.height, Math.ceil(y1)); sy++) {
        const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
        if (wy <= 0) continue;
        for (let sx = Math.floor(x0); sx < Math.min(src.width, Math.ceil(x1)); sx++) {
          const wx = Math.min(x1, sx + 1) - Math.max(x0, sx);
          if (wx <= 0) continue;
          const w = (wx * wy) / (scaleX * scaleY);
          const i = (sy * src.width + sx) * 4;
          const alpha = src.data[i + 3] / 255;
          r += src.data[i] * alpha * w;
          g += src.data[i + 1] * alpha * w;
          b += src.data[i + 2] * alpha * w;
          a += src.data[i + 3] * w;
        }
      }
      const o = (y * dstW + x) * 4;
      if (a > 0.5) {
        const inv = 255 / a;
        out[o] = r * inv;
        out[o + 1] = g * inv;
        out[o + 2] = b * inv;
      }
      out[o + 3] = a;
    }
  }
  return { data: out, width: dstW, height: dstH };
}

describe('регрессии v0.2.1: area и альфа', () => {
  it('area: постоянный красный кадр 2×1 → 3×1 не даёт прозрачную дыру', () => {
    const src = makeFrame(2, 1, () => [255, 0, 0, 255]);
    const out = resizeArea(src, 3, 1);
    expect(pixel(out, 0)).toEqual([255, 0, 0, 255]);
    expect(pixel(out, 1)).toEqual([255, 0, 0, 255]);
    expect(pixel(out, 2)).toEqual([255, 0, 0, 255]);
  });

  it('area: постоянный кадр инвариантен на случайных размерах 1..17', () => {
    const rnd = seeded(0x5eed);
    const colors: [number, number, number, number][] = [
      [255, 0, 0, 255],
      [12, 34, 56, 255],
      [200, 100, 50, 128],
      [1, 2, 3, 17],
    ];
    for (let n = 0; n < 40; n++) {
      const sw = 1 + Math.floor(rnd() * 17);
      const sh = 1 + Math.floor(rnd() * 17);
      const dw = 1 + Math.floor(rnd() * 17);
      const dh = 1 + Math.floor(rnd() * 17);
      const color = colors[n % colors.length];
      const out = resizeArea(makeFrame(sw, sh, () => color), dw, dh);
      for (let y = 0; y < dh; y++) {
        for (let x = 0; x < dw; x++) {
          const px = pixel(out, x, y);
          expect(Math.abs(px[0] - color[0]), `${sw}x${sh}->${dw}x${dh}`).toBeLessThanOrEqual(1);
          expect(Math.abs(px[1] - color[1])).toBeLessThanOrEqual(1);
          expect(Math.abs(px[2] - color[2])).toBeLessThanOrEqual(1);
          expect(Math.abs(px[3] - color[3])).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('area: сепарабельная реализация совпадает с независимым 2D-reference', () => {
    const src = makeFrame(5, 4, (x, y) => [
      (x * 47 + y * 19) % 256,
      (x * 11 + y * 61) % 256,
      (x * 83 + y * 7) % 256,
      255,
    ]);
    for (const [dw, dh] of [
      [3, 3],
      [7, 2],
      [2, 7],
      [9, 9],
    ] as const) {
      const actual = resizeArea(src, dw, dh);
      const expected = referenceArea(src, dw, dh);
      for (let i = 0; i < actual.data.length; i++) {
        expect(Math.abs(actual.data[i] - expected.data[i]), `${dw}x${dh} byte ${i}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('bilinear: непрозрачный красный + прозрачный синий остаётся красным', () => {
    const src = makeFrame(2, 1, (x) => (x === 0 ? [255, 0, 0, 255] : [0, 0, 255, 0]));
    expect(pixel(resizeBilinear(src, 1, 1), 0)).toEqual([255, 0, 0, 128]);
  });

  it('alpha isolation: RGB полностью прозрачных пикселей не влияет на видимый ресайз', () => {
    const make = (hidden: [number, number, number, number]) =>
      makeFrame(4, 1, (x) => (x === 1 ? hidden : [200, 30, 40, 255]));
    const a = make([0, 0, 255, 0]);
    const b = make([0, 255, 0, 0]);
    for (const resize of [resizeBilinear, resizeArea, resizeLanczos3]) {
      const left = resize(a, 3, 1);
      const right = resize(b, 3, 1);
      expect(Buffer.from(left.data).equals(Buffer.from(right.data))).toBe(true);
    }
  });

  it('sharpen: невидимый RGB прозрачного соседа не окрашивает видимые пиксели', () => {
    const make = (hidden: [number, number, number, number]) =>
      makeFrame(3, 1, (x) => (x === 1 ? hidden : [100, 100, 100, 255]));
    const blue = sharpenFrame(make([0, 0, 255, 0]), 1, 1);
    const green = sharpenFrame(make([0, 255, 0, 0]), 1, 1);
    expect(pixel(blue, 0)).toEqual(pixel(green, 0));
    expect(pixel(blue, 2)).toEqual(pixel(green, 2));
  });
});

describe('регрессии v0.2.1: сетка качества', () => {
  const grid = (quality: [number, number]) =>
    buildQualityGrid({ formats: ['image/fake'], quality });

  it('сохраняет точные узкие границы [0.805, 0.806]', () => {
    expect(grid([0.805, 0.806])).toEqual([0.805, 0.806]);
  });

  it('сохраняет прежнюю сетку для сотых границ и singleton', () => {
    const standard = grid([0.8, 0.99]);
    expect(standard).toHaveLength(20);
    expect(standard[0]).toBe(0.8);
    expect(standard.at(-1)).toBe(0.99);
    expect(grid([0.75, 0.75])).toEqual([0.75]);
  });

  it('property: сетка возрастает и никогда не выходит за границы', () => {
    const rnd = seeded(0x9a17);
    for (let n = 0; n < 100; n++) {
      const a = rnd();
      const b = rnd();
      const min = Math.min(a, b);
      const max = Math.max(a, b);
      const values = grid([min, max]);
      expect(values[0]).toBe(min);
      expect(values.at(-1)).toBe(max);
      for (let i = 0; i < values.length; i++) {
        expect(values[i]).toBeGreaterThanOrEqual(min);
        expect(values[i]).toBeLessThanOrEqual(max);
        if (i > 0) expect(values[i]).toBeGreaterThan(values[i - 1]);
      }
    }
  });
});

describe('регрессии v0.2.1: точный nearest палитры', () => {
  it('не склеивает чёрный и [7,7,7] из одной 5-битной ячейки', () => {
    const palette = [
      { r: 0, g: 0, b: 0, a: 255 },
      { r: 7, g: 7, b: 7, a: 255 },
    ];
    const src = makeFrame(2, 1, (x) => (x === 0 ? [0, 0, 0, 255] : [7, 7, 7, 255]));
    const out = applyPaletteWithDithering(src, palette, 0);
    expect(pixel(out, 0)).toEqual([0, 0, 0, 255]);
    expect(pixel(out, 1)).toEqual([7, 7, 7, 255]);

    const reversed = makeFrame(2, 1, (x) => (x === 0 ? [7, 7, 7, 255] : [0, 0, 0, 255]));
    const reversedOut = applyPaletteWithDithering(reversed, palette, 0);
    expect(pixel(reversedOut, 0)).toEqual([7, 7, 7, 255]);
    expect(pixel(reversedOut, 1)).toEqual([0, 0, 0, 255]);
  });

  it('не склеивает цвета, отличающиеся только альфой внутри 2-битной ячейки', () => {
    const palette = [
      { r: 10, g: 20, b: 30, a: 64 },
      { r: 10, g: 20, b: 30, a: 127 },
    ];
    const src = makeFrame(2, 1, (x) => (x === 0 ? [10, 20, 30, 64] : [10, 20, 30, 127]));
    const out = applyPaletteWithDithering(src, palette, 0);
    expect(pixel(out, 0)).toEqual([10, 20, 30, 64]);
    expect(pixel(out, 1)).toEqual([10, 20, 30, 127]);
  });
});
