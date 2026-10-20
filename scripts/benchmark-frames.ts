// Детерминированные кадры benchmark-корпуса, общие для Node и браузера.
//
// Никаких внешних изображений: фото-подобный градиент, шум, манга/документ,
// UI, alpha, муар, панорама и высокий документ генерируются кодом. Один и
// тот же модуль импортируют Node-скрипты и отдельная браузерная bench-
// страница, поэтому среды сравниваются на одинаковых входных пикселях.

import { makeFrame, mangaFrame, noiseFrame, photoFrame } from '../test/helpers.js';
import type { Frame } from '../src/index.js';

function uiFrame(width = 320, height = 240): Frame {
  return makeFrame(width, height, (x, y) => {
    if (y < 36) return [35, 91, 168, 255];
    if (x < 72) return [232, 238, 247, 255];
    const line = Math.floor((y - 52) / 18);
    if (y >= 52 && y % 18 < 8 && x > 88 && x < 88 + 80 + ((line * 37) % 130)) {
      return [45, 52, 64, 255];
    }
    if (x > width - 92 && y > 54 && y < 112) return [245, 166, 35, 255];
    return [250, 251, 252, 255];
  });
}

function alphaFrame(width = 256, height = 256): Frame {
  return makeFrame(width, height, (x, y) => {
    const dx = x - width * 0.42;
    const dy = y - height * 0.46;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < width * 0.24) return [230, 72, 54, 255];
    if (dist < width * 0.31) return [54, 116, 230, 128];
    if (x > width * 0.58 && y > height * 0.58) return [42, 180, 90, 210];
    return [250, 20, 240, 0]; // скрытый RGB прозрачности специально яркий
  });
}

function moireFrame(width = 320, height = 240): Frame {
  return makeFrame(width, height, (x, y) => {
    const v = 127 + Math.round(110 * Math.sin(x * 0.72) * Math.cos(y * 0.61));
    return [v, 255 - v, (x ^ y) & 255, 255];
  });
}

export interface BenchmarkCorpusCase {
  name: string;
  format: string;
  frame: Frame;
  limit: number;
}

/** Свежий набор кадров реального fit-корпуса на каждый вызов. */
export function createBenchmarkCorpus(): BenchmarkCorpusCase[] {
  return [
    { name: 'jpeg photo', format: 'image/jpeg', frame: photoFrame(320, 320), limit: 5_000 },
    { name: 'jpeg noise', format: 'image/jpeg', frame: noiseFrame(320, 320), limit: 24_000 },
    { name: 'jpeg manga', format: 'image/jpeg', frame: mangaFrame(320, 320), limit: 18_000 },
    { name: 'jpeg UI', format: 'image/jpeg', frame: uiFrame(), limit: 12_000 },
    { name: 'jpeg moire', format: 'image/jpeg', frame: moireFrame(), limit: 24_000 },
    { name: 'jpeg panorama', format: 'image/jpeg', frame: photoFrame(900, 180), limit: 5_000 },
    { name: 'jpeg tall document', format: 'image/jpeg', frame: mangaFrame(180, 900), limit: 10_000 },
    { name: 'webp alpha', format: 'image/webp', frame: alphaFrame(), limit: 2_500 },
    { name: 'webp gradient', format: 'image/webp', frame: photoFrame(256, 256), limit: 1_500 },
  ];
}

/** Кадры сравнения квантователей из фазы 4. */
export function createQuantizerCorpus(): { name: string; frame: Frame }[] {
  return [
    { name: 'photo 256', frame: photoFrame(256, 256) },
    { name: 'noise 256', frame: noiseFrame(256, 256) },
    { name: 'manga 256', frame: mangaFrame(256, 256) },
    { name: 'UI 320×240', frame: uiFrame() },
    { name: 'alpha 256', frame: alphaFrame() },
  ];
}
