import { afterEach, describe, expect, it } from 'vitest';
import {
  analyzeFrame,
  computeAlphaMAE,
  computePremultipliedMAE,
  computeSSIM,
  image,
  optimizePngBlob,
  registerEncoder,
  resizeArea,
  resizeBilinear,
  resizeLanczos3,
  unregisterEncoder,
} from '../src/index.js';
import type { Codec, EncodeOptions, FitSpec, Frame } from '../src/index.js';
import { buildQualityGrid } from '../src/fit/dimensions.js';
import { buildFastPalette, quantizeFrame } from '../src/quantize.js';
import { decodePng } from '../src/codecs/png.js';
import { serializePngChunk } from '../src/png-chunks.js';
import {
  anyBlob,
  decoderFor,
  framesEqual,
  makeFrame,
  mangaFrame,
  photoFrame,
} from './helpers.js';

const registered: string[] = [];
function reg(format: string, codec: Codec): void {
  registerEncoder(format, codec);
  registered.push(format);
}
afterEach(() => {
  while (registered.length > 0) unregisterEncoder(registered.pop()!);
});

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function randomFrame(random: () => number, width: number, height: number, alpha = 255): Frame {
  return makeFrame(width, height, () => [
    Math.floor(random() * 256),
    Math.floor(random() * 256),
    Math.floor(random() * 256),
    alpha,
  ]);
}

describe('фаза 4: analyzeFrame и alpha-метрики', () => {
  it('полностью прозрачный RGB не делает кадр цветным и не попадает в корзины', () => {
    const frame = makeFrame(4, 1, (x) =>
      x < 2 ? [255, 0, 0, 0] : [10, 10, 10, 255],
    );
    const analysis = analyzeFrame(frame);
    expect(analysis.saturation).toBe(0);
    expect(analysis.nearMonochrome).toBe(true);
    expect(analysis.alphaCoverage).toBe(0.5);
    expect(analysis.visibleSampledPixels).toBe(2);
    expect(analysis.colorBuckets5Bit).toBe(1);
    expect(analysis.meanLuma).toBeCloseTo(10);
  });

  it('maxSamples ограничивает выборку, а аборт честно прерывает анализ и метрики', () => {
    const frame = photoFrame(100, 100);
    expect(analyzeFrame(frame, { maxSamples: 25 }).sampledPixels).toBeLessThanOrEqual(25);
    const controller = new AbortController();
    controller.abort();
    expect(() => analyzeFrame(frame, { signal: controller.signal })).toThrow(
      expect.objectContaining({ name: 'AbortError' }),
    );
    expect(() => computeSSIM(frame, frame, { signal: controller.signal })).toThrow(
      expect.objectContaining({ name: 'AbortError' }),
    );
  });

  it('premultiplied MAE игнорирует скрытый RGB, alpha MAE видит только альфу', () => {
    const a = makeFrame(2, 1, () => [255, 0, 0, 0]);
    const b = makeFrame(2, 1, () => [0, 0, 255, 0]);
    expect(computePremultipliedMAE(a, b)).toBe(0);
    expect(computeAlphaMAE(a, b)).toBe(0);
    const c = makeFrame(2, 1, () => [0, 0, 255, 255]);
    expect(computeAlphaMAE(a, c)).toBe(255);
    expect(computePremultipliedMAE(a, c)).toBeGreaterThan(0);
  });
});

describe('фаза 4: fast-median-cut', () => {
  it('точная палитра, константный кадр и ограничение числа цветов', async () => {
    const palette = [
      [10, 20, 30, 255],
      [200, 10, 40, 255],
      [0, 255, 128, 128],
      [90, 90, 90, 0],
    ] as const;
    const frame = makeFrame(16, 16, (x, y) => palette[(x + y * 3) % palette.length]);
    const built = buildFastPalette(frame, 8);
    expect(built).toHaveLength(4);
    const out = await quantizeFrame(frame, 8, 0, { algorithm: 'fast-median-cut' });
    expect(framesEqual(frame, out)).toBe(true);

    const constant = makeFrame(8, 8, () => [12, 34, 56, 255]);
    const constantOut = await quantizeFrame(constant, 2, 0, { algorithm: 'fast-median-cut' });
    expect(framesEqual(constant, constantOut)).toBe(true);
  });

  it('фото квантуется до заданного числа цветов, чужая distance не маскируется', async () => {
    const out = await quantizeFrame(photoFrame(64, 64), 16, 0, {
      algorithm: 'fast-median-cut',
    });
    const colors = new Set<number>();
    for (let i = 0; i < out.data.length; i += 4) {
      colors.add(((out.data[i] * 256 + out.data[i + 1]) * 256 + out.data[i + 2]) * 256 + out.data[i + 3]);
    }
    expect(colors.size).toBeLessThanOrEqual(16);
    await expect(
      quantizeFrame(photoFrame(8, 8), 4, 0, {
        algorithm: 'fast-median-cut',
        distance: 'ciede2000',
      }),
    ).rejects.toThrow(/euclidean/);
  });
});

function insertPngChunk(png: Uint8Array, type: string, payload: Uint8Array): Uint8Array {
  const chunk = serializePngChunk(type, payload);
  const ihdrLength = new DataView(png.buffer, png.byteOffset, png.byteLength).getUint32(8);
  const insertAt = 8 + 12 + ihdrLength;
  const out = new Uint8Array(png.length + chunk.length);
  out.set(png.subarray(0, insertAt), 0);
  out.set(chunk, insertAt);
  out.set(png.subarray(insertAt), insertAt + chunk.length);
  return out;
}

describe('фаза 4: lossless PNG optimizer', () => {
  it('принимает только меньший результат и сохраняет пиксели побитово', async () => {
    const frame = photoFrame(64, 64);
    const raw = await image(anyBlob(), (p) => p.encode('image/png'), {
      decoder: decoderFor(frame),
    });
    const result = await optimizePngBlob(raw, { level: 3 });
    expect(result.optimized).toBe(true);
    expect(result.size).toBeLessThan(raw.size);
    expect(framesEqual(frame, await decodePng(result.blob))).toBe(true);

    const again = await optimizePngBlob(result.blob, { level: 1 });
    if (!again.optimized) expect(again.blob).toBe(result.blob);
  }, 120_000);

  it('roundtrip на grayscale, палитре и interlaced PNG', async () => {
    const gray = makeFrame(32, 32, (x, y) => {
      const v = (x * 7 + y * 3) % 256;
      return [v, v, v, 255];
    });
    const paletted = await quantizeFrame(photoFrame(32, 32), 16, 0, {
      algorithm: 'fast-median-cut',
    });
    for (const frame of [gray, paletted]) {
      const blob = await image(anyBlob(), (p) => p.encode('image/png', { oxipngLevel: 1 }), {
        decoder: decoderFor(frame),
      });
      const optimized = await optimizePngBlob(blob, { level: 2 });
      expect(framesEqual(frame, await decodePng(optimized.blob))).toBe(true);
    }

    const frame = photoFrame(32, 32);
    const interlaced = await image(
      anyBlob(),
      (p) => p.encode('image/png', { oxipng: { level: 1, interlace: true } }),
      { decoder: decoderFor(frame) },
    );
    const optimized = await optimizePngBlob(interlaced, { level: 2 });
    expect(framesEqual(frame, await decodePng(optimized.blob))).toBe(true);
  }, 120_000);

  it('цветовой gAMA-чанк не теряется молча; не-PNG отклоняется', async () => {
    const frame = photoFrame(32, 32);
    const raw = await image(anyBlob(), (p) => p.encode('image/png'), {
      decoder: decoderFor(frame),
    });
    const gammaPayload = new Uint8Array(4);
    new DataView(gammaPayload.buffer).setUint32(0, 45455);
    const withGamma = new Blob(
      [insertPngChunk(new Uint8Array(await raw.arrayBuffer()), 'gAMA', gammaPayload)],
      { type: 'image/png' },
    );
    const result = await optimizePngBlob(withGamma, { level: 3 });
    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    const text = new TextDecoder('latin1').decode(bytes);
    expect(text).toContain('gAMA');
    await expect(optimizePngBlob(new Blob(['not png']))).rejects.toThrow(/not a valid PNG/);
  }, 120_000);
});

describe('фаза 5: seeded property и equivalence', () => {
  it('константы и прозрачная альфа изолированы во всех resize-методах', () => {
    const random = seededRandom(1234);
    for (let trial = 0; trial < 20; trial++) {
      const color: [number, number, number, number] = [
        Math.floor(random() * 256),
        Math.floor(random() * 256),
        Math.floor(random() * 256),
        255,
      ];
      const frame = makeFrame(7, 5, () => color);
      for (const resize of [resizeBilinear, resizeLanczos3, resizeArea]) {
        const out = resize(frame, 3, 9);
        expect(out.width).toBe(3);
        expect(out.height).toBe(9);
        for (let i = 0; i < out.data.length; i += 4) {
          expect([...out.data.subarray(i, i + 4)]).toEqual(color);
        }
      }
    }

    const transparent = randomFrame(seededRandom(99), 16, 16, 0);
    for (const resize of [resizeBilinear, resizeLanczos3, resizeArea]) {
      const out = resize(transparent, 5, 5);
      for (let i = 0; i < out.data.length; i++) expect(out.data[i]).toBe(0);
    }
  });

  it('сетка качества на seeded границах отсортирована и не выходит за диапазон', () => {
    const random = seededRandom(777);
    for (let i = 0; i < 100; i++) {
      const a = random();
      const b = random();
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const grid = buildQualityGrid({ formats: ['x'], quality: [lo, hi] });
      expect(grid[0]).toBe(lo);
      expect(grid[grid.length - 1]).toBe(hi);
      for (let k = 1; k < grid.length; k++) expect(grid[k]).toBeGreaterThan(grid[k - 1]);
      for (const q of grid) {
        expect(q).toBeGreaterThanOrEqual(lo);
        expect(q).toBeLessThanOrEqual(hi);
      }
    }
  });

  it('accelerated-стратегии равны owner-loop на монотонной комбинации плоскостей', async () => {
    const calls: EncodeOptions[] = [];
    const codec: Codec = {
      channels: ['ycbcr', 'rgb', 'grayscale'],
      subsampling: ['4:2:0', '4:2:2', '4:4:4', '4:0:0'],
      async encode(_frame, options = {}) {
        calls.push({ ...options });
        const q = options.quality ?? 0.9;
        const qFactor = (1 / (1.02 - q)) / (1 / (1.02 - 0.8));
        let factor = 1;
        if (options.channel === 'grayscale') factor *= 0.62;
        if (options.subsampling === '4:0:0') factor *= 0.85;
        if (options.smoothing === 60) factor *= 0.9;
        if (options.quant_table === 1) factor *= 0.92;
        const size = Math.max(32, Math.round(20_000 * qFactor * factor));
        return new Blob([new Uint8Array(size)], { type: 'image/equiv' });
      },
    };
    reg('image/equiv', codec);
    const spec: FitSpec = {
      formats: ['image/equiv'],
      quality: [0.8, 0.99],
      channels: ['grayscale'],
      subsampling: ['4:0:0'],
      variants: [{ smoothing: 0 }, { smoothing: 60 }],
      dimensions: [
        {
          name: 'quant',
          values: [
            { id: 'std', options: { quant_table: 0 } },
            { id: 'flat', options: { quant_table: 1 } },
          ],
        },
      ],
    };
    const outcomes = new Map<string, unknown>();
    for (const strategy of ['owner-loop', 'binary', 'secant', 'coarse-fine'] as const) {
      calls.length = 0;
      const hit = await image(
        anyBlob(),
        (p) => p.fit(spec, (c) => c.size <= 15_000, { strategy }),
        { decoder: decoderFor(photoFrame(40, 40)) },
      );
      expect(hit).not.toBeNull();
      outcomes.set(strategy, {
        params: hit!.params,
        size: hit!.blob.size,
        calls: calls.length,
      });
    }
    const owner = outcomes.get('owner-loop') as { params: unknown; size: number; calls: number };
    for (const strategy of ['binary', 'secant', 'coarse-fine']) {
      const item = outcomes.get(strategy) as typeof owner;
      expect(item.params).toEqual(owner.params);
      expect(item.size).toBe(owner.size);
      expect(item.calls).toBeLessThan(owner.calls);
    }
  });

  it('stress: экстремальные пропорции, однопиксельный кадр, unknown format, много плоскостей с бюджетом', async () => {
    const panorama = makeFrame(100_000, 1, (x) => [x % 256, 20, 30, 255]);
    expect(analyzeFrame(panorama, { maxSamples: 128 }).sampledPixels).toBeLessThanOrEqual(128);
    expect(resizeArea(panorama, 100, 1).width).toBe(100);
    const tall = makeFrame(1, 100_000, (_x, y) => [40, y % 256, 30, 255]);
    expect(resizeBilinear(tall, 1, 100).height).toBe(100);

    const codec: Codec = {
      async encode() {
        return new Blob([new Uint8Array(5)], { type: 'image/one' });
      },
    };
    reg('image/one', codec);
    const blob = await image(anyBlob(), (p) => p.encode('image/one'), {
      decoder: decoderFor(makeFrame(1, 1, () => [1, 2, 3, 255])),
    });
    expect(blob.size).toBe(5);
    await expect(
      image(anyBlob(), (p) => p.encode('image/does-not-exist'), {
        decoder: decoderFor(makeFrame(1, 1, () => [1, 2, 3, 255])),
      }),
    ).rejects.toThrow(/No encoder registered/i);

    const never: Codec = {
      async encode() {
        return new Blob([new Uint8Array(100)], { type: 'image/many' });
      },
    };
    reg('image/many', never);
    const dimensions = Array.from({ length: 6 }, (_, i) => ({
      name: `dim${i}`,
      values: [
        { id: 'a', options: { [`opt${i}`]: 0 } },
        { id: 'b', options: { [`opt${i}`]: 1 } },
      ],
    }));
    await expect(
      image(
        anyBlob(),
        (p) =>
          p.fit(
            { formats: ['image/many'], quality: [0.8, 0.99], dimensions },
            () => false,
            { maxAttempts: 2 },
          ),
        { decoder: decoderFor(photoFrame(8, 8)) },
      ),
    ).rejects.toMatchObject({ name: 'FitBudgetExhaustedError', attempts: 2 });
  });

  it('кэш квантованных кадров в fit удерживает не более двух уровней палитры', async () => {
    const codec: Codec = {
      async encode() {
        return new Blob([new Uint8Array(100)], { type: 'image/cache' });
      },
    };
    reg('image/cache-a', codec);
    reg('image/cache-b', codec);
    const quantizedLevels: number[] = [];

    const result = await image(
      anyBlob(),
      (p) =>
        p.fit(
          {
            formats: ['image/cache-a', 'image/cache-b'],
            quality: [0.8, 0.8],
            colors: [16, 128],
          },
          () => false,
        ),
      {
        decoder: decoderFor(photoFrame(16, 16)),
        state: (event) => {
          if (event.type === 'quantize') quantizedLevels.push(event.colors);
        },
      },
    );

    expect(result).toBeNull();
    // Первый формат строит 128/64/32/16. Ко второму формату в кэше могут
    // остаться только два последних уровня, поэтому уровни строятся заново;
    // при неограниченном кэше здесь было бы только четыре события.
    expect(quantizedLevels).toEqual([128, 64, 32, 16, 128, 64, 32, 16]);
  }, 120_000);

  it('контрактная цепочка frame → quantize(fast) → encode на манге', async () => {
    const blob = await image(
      anyBlob(),
      async (p) => {
        await p.frame({ width: 32, height: 32, method: 'area' });
        await p.quantize({ colors: 16, dithering: 0, algorithm: 'fast-median-cut' });
        return p.encode('image/png', { oxipngLevel: 2 });
      },
      { decoder: decoderFor(mangaFrame(64, 64)) },
    );
    expect(blob.type).toBe('image/png');
    const decoded = await decodePng(blob);
    expect(decoded.width).toBe(32);
    expect(decoded.height).toBe(32);
  }, 120_000);
});
