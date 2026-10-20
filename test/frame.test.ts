import { describe, expect, it } from 'vitest';
import { applyFrameGeometry, probeSaturation } from '../src/frame.js';
import { InvalidOptionsError } from '../src/errors.js';
import { makeFrame, mangaFrame, photoFrame } from './helpers.js';

describe('frame geometry', () => {
  it('cover: результат ровно width×height, большая сторона режется по центру', () => {
    // Кадр 400×100: левая половина красная, правая синяя.
    const src = makeFrame(400, 100, (x) => (x < 200 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
    const out = applyFrameGeometry(src, { width: 100, height: 100, fit: 'cover' });
    expect(out.width).toBe(100);
    expect(out.height).toBe(100);
    // Центр исходника — граница красный/синий; после центрального кропа
    // левый край кадра красный, правый синий.
    const px = (x: number) => {
      const i = (50 * out.width + x) * 4;
      return [out.data[i], out.data[i + 2]];
    };
    expect(px(5)[0]).toBeGreaterThan(200); // красный слева
    expect(px(95)[1]).toBeGreaterThan(200); // синий справа
  });

  it('cover: меньшая сторона дотягивается (upscale разрешён)', () => {
    const out = applyFrameGeometry(photoFrame(50, 50), { width: 200, height: 200, fit: 'cover' });
    expect([out.width, out.height]).toEqual([200, 200]);
  });

  it('contain: вписывает целиком с сохранением пропорций', () => {
    const out = applyFrameGeometry(photoFrame(400, 100), { width: 200, height: 200, fit: 'contain' });
    expect(out.width).toBe(200);
    expect(out.height).toBe(50);
  });

  it('fit по умолчанию — cover', () => {
    const out = applyFrameGeometry(photoFrame(400, 100), { width: 64, height: 64 });
    expect([out.width, out.height]).toEqual([64, 64]);
  });

  it('некорректные размеры — InvalidOptionsError, а не молчаливый мусор', () => {
    expect(() => applyFrameGeometry(photoFrame(10, 10), { width: 0, height: 10 })).toThrow(InvalidOptionsError);
    expect(() => applyFrameGeometry(photoFrame(10, 10), { width: 10.5, height: 10 })).toThrow(InvalidOptionsError);
  });
});

describe('probeSaturation', () => {
  it('почти-монохромный кадр даёт насыщенность у нуля, цветной — заметно выше', () => {
    expect(probeSaturation(mangaFrame())).toBeLessThan(0.04);
    expect(probeSaturation(photoFrame())).toBeGreaterThan(0.2);
  });
});
