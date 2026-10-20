// Синтетические кадры и модельный кодек для тестов.
//
// Модельный кодек не кодирует по-настоящему: он возвращает Blob ровно того
// размера, который предписывает модель кривой веса. Кривая монотонна по
// качеству (JPEG-подобно: вес ~ 1/(1.02-q)) и по числу цветов (логарифмически),
// каналы дают мультипликаторы (grayscale выбрасывает цветовые плоскости).
// Счётчик encodes в кодеке — независимая сверка с attempts из fit.

import type { Codec, EncodeOptions, Frame } from '../src/types.js';

export function makeFrame(width: number, height: number, fill: (x: number, y: number) => [number, number, number, number]): Frame {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const [r, g, b, a] = fill(x, y);
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return { data, width, height };
}

/** Побитовое равенство двух кадров, включая размеры. */
export function framesEqual(a: Frame, b: Frame): boolean {
  return (
    a.width === b.width &&
    a.height === b.height &&
    Buffer.from(a.data).equals(Buffer.from(b.data))
  );
}

/** «Фото»: плавные цветные градиенты + деталь. */
export function photoFrame(width = 200, height = 200): Frame {
  return makeFrame(width, height, (x, y) => [
    Math.round((x / width) * 255),
    Math.round((y / height) * 255),
    Math.round(((x + y) / (width + height)) * 255),
    255,
  ]);
}

/** «Манга/документ»: почти монохромные штрихи на белом. */
export function mangaFrame(width = 200, height = 200): Frame {
  return makeFrame(width, height, (x, y) => {
    const v = (x % 16 < 2 || y % 16 < 2) ? 30 : 245;
    return [v, v, v + 2, 255]; // +2 в синем — лёгкий оттенок, насыщенность ~0
  });
}

/** Шум: худший случай для энкодера. */
export function noiseFrame(width = 200, height = 200, seed = 42): Frame {
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s % 256;
  };
  return makeFrame(width, height, () => [rnd(), rnd(), rnd(), 255]);
}

export interface FakeCodec extends Codec {
  encodes: number;
  calls: { quality?: number; channel?: string; subsampling?: string; smoothing?: unknown }[];
  reset(): void;
}

export interface FakeCodecModel {
  /** Базовый вес при качестве 0.8 без палитры (байты). */
  baseAtQ80: number;
  /** Насыщенность модели кадра (для grayscale-выигрыша): 0 — монохром. */
  chroma?: number;
}

/**
 * Модельная кривая веса. qualityFactor монотонно растёт по q;
 * палитра определяется по факту квантования кадра вызывающим (fit передаёт
 * уже квантованный кадр, поэтому кодек «видит» цвета через frame.__colors —
 * см. makeFakeEncoder ниже: число цветов оценивается по кадру).
 */
export function modelSize(
  model: FakeCodecModel,
  quality: number,
  colors: number | undefined,
  channel: string | undefined,
  subsampling: string | undefined = undefined,
  smoothing = 0,
): number {
  const q = Math.max(0.01, Math.min(0.99, quality));
  // Нормировка: при q=0.8 множитель равен 1.
  const qFactor = (1 / (1.02 - q)) / (1 / (1.02 - 0.8));
  const paletteFactor = colors === undefined ? 1 : 0.25 + 0.75 * (Math.log2(colors) / 8);
  // Субсемплинг: 4:4:4 дороже 4:2:0, монохром дешевле всех.
  const subsamplingFactor =
    subsampling === '4:4:4' ? 1.3 : subsampling === '4:2:2' ? 1.12 : subsampling === '4:0:0' ? 0.85 : 1;
  // Сглаживание шума перед DCT чуть снижает вес (варианты в fit-тестах).
  const smoothingFactor = 1 - Math.min(0.3, Math.max(0, smoothing) / 200);
  let channelFactor = 1;
  if (channel === 'grayscale') {
    // Монохрому grayscale почти бесплатен по весу цветовых плоскостей нет:
    // выигрыш большой именно там, где цвета и не было.
    channelFactor = 0.45 + 0.4 * (model.chroma ?? 1);
  } else if (channel === 'rgb') {
    channelFactor = 1.15;
  }
  return Math.max(
    64,
    Math.round(model.baseAtQ80 * qFactor * paletteFactor * channelFactor * subsamplingFactor * smoothingFactor),
  );
}

/** Оценить число уникальных цветов кадра (для модельного кодека). */
export function countColors(frame: Frame, cap = 512): number {
  const seen = new Set<number>();
  const d = frame.data;
  for (let i = 0; i < d.length; i += 4) {
    seen.add((d[i] << 24) | (d[i + 1] << 16) | (d[i + 2] << 8) | d[i + 3]);
    if (seen.size > cap) return seen.size;
  }
  return seen.size;
}

export function makeFakeCodec(model: FakeCodecModel, mime = 'image/fake'): FakeCodec {
  const codec: FakeCodec = {
    encodes: 0,
    calls: [],
    channels: ['ycbcr', 'rgb', 'grayscale'],
    subsampling: ['4:2:0', '4:2:2', '4:4:4', '4:0:0'],
    reset() {
      this.encodes = 0;
      this.calls = [];
    },
    async encode(frame: Frame, options: EncodeOptions = {}): Promise<Blob> {
      this.encodes += 1;
      this.calls.push({
        quality: options.quality,
        channel: options.channel,
        subsampling: options.subsampling,
        smoothing: options.smoothing,
      });
      // fit квантует кадр сам; «цвета» кодек видит по реальному кадру.
      // Но для детерминированности бенчмарков позволяем передать colors
      // явно через недокументированное поле опций — в тестах fit его нет,
      // там считается честно по кадру.
      const fromFrame = countColors(frame);
      const colors = fromFrame > 256 ? undefined : fromFrame;
      const size = modelSize(
        model,
        options.quality ?? 0.9,
        colors,
        options.channel,
        options.subsampling,
        typeof options.smoothing === 'number' ? options.smoothing : 0,
      );
      return new Blob([new Uint8Array(size)], { type: mime });
    },
  };
  return codec;
}

/** decoder-шов: возвращает заранее заданный кадр. */
export const decoderFor = (frame: Frame) => async (_source: Blob): Promise<Frame> => frame;

export const anyBlob = () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/fake' });
