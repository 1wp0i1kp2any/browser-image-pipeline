import { afterEach, describe, expect, it } from 'vitest';
import {
  FitBudgetExhaustedError,
  InvalidOptionsError,
  ResourceLimitError,
  getEncoder,
  image,
  registerEncoder,
  resizeArea,
  resizeBilinear,
  unregisterEncoder,
} from '../src/index.js';
import type {
  Codec,
  CodecCapabilities,
  EncodeOptions,
  FitWarning,
  Frame,
  PipelineEvent,
} from '../src/index.js';
import { resolveQualityCapability } from '../src/fit/capabilities.js';
import { buildPlanes, countPlanes, iteratePlanes } from '../src/fit/dimensions.js';
import { anyBlob, decoderFor, makeFakeCodec, photoFrame } from './helpers.js';

const registered: string[] = [];

function reg(format: string, codec: Codec): void {
  registerEncoder(format, codec);
  registered.push(format);
}

afterEach(() => {
  while (registered.length > 0) unregisterEncoder(registered.pop()!);
});

interface RecordingCodec extends Codec {
  encodes: number;
  calls: EncodeOptions[];
  reset(): void;
}

function recordingCodec(
  size: (options: EncodeOptions, frame: Frame) => number,
  capabilities?: Codec['capabilities'],
  overrides: Partial<Codec> = {},
): RecordingCodec {
  const codec: RecordingCodec = {
    encodes: 0,
    calls: [],
    channels: ['ycbcr', 'rgb', 'grayscale'],
    subsampling: ['4:2:0', '4:2:2', '4:4:4', '4:0:0'],
    capabilities,
    reset() {
      this.encodes = 0;
      this.calls = [];
    },
    async encode(frame: Frame, options: EncodeOptions = {}): Promise<Blob> {
      this.encodes += 1;
      this.calls.push({ ...options });
      return new Blob([new Uint8Array(size(options, frame))], { type: 'image/recording' });
    },
    ...overrides,
  };
  return codec;
}

describe('фаза 2: capabilities качества', () => {
  it('встроенные кодеки честно декларируют PNG/WebP-lossless/AVIF-lossless', () => {
    expect(resolveQualityCapability(getEncoder('image/png'))).toMatchObject({
      supported: false,
      role: 'ignored',
      searchesQuality: false,
      passesQuality: false,
    });
    expect(resolveQualityCapability(getEncoder('image/webp'), { lossless: true })).toMatchObject({
      role: 'effort',
      searchesQuality: false,
      passesQuality: true,
    });
    expect(resolveQualityCapability(getEncoder('image/avif'), { lossless: true })).toMatchObject({
      role: 'ignored',
      searchesQuality: false,
      passesQuality: false,
    });
    expect(resolveQualityCapability(getEncoder('image/jpeg'))).toMatchObject({
      role: 'quality',
      searchesQuality: true,
      step: 0.01,
    });
  });

  it('quality:false — одна проба на плоскость, quality кодеку не передаётся, в params верх сетки', async () => {
    const codec = recordingCodec(() => 100, { quality: false, qualityRole: 'ignored' });
    reg('image/no-quality', codec);
    const warnings: FitWarning[] = [];
    const hit = await image(
      anyBlob(),
      (p) =>
        p.fit({ formats: ['image/no-quality'], quality: [0.8, 0.99] }, () => true, {
          onWarning: (w) => warnings.push(w),
        }),
      { decoder: decoderFor(photoFrame(20, 20)) },
    );
    expect(hit).not.toBeNull();
    expect(hit!.attempts).toBe(1);
    expect(hit!.params.quality).toBe(0.99);
    expect(codec.calls[0].quality).toBeUndefined();
    expect(warnings.map((w) => w.code)).toContain('quality-axis-collapsed');
  });

  it('реальный PNG при недостижимом предикате делает одну пробу вместо двух концов сетки', async () => {
    const events: PipelineEvent[] = [];
    const hit = await image(
      anyBlob(),
      (p) => p.fit({ formats: ['image/png'], quality: [0.8, 0.99] }, () => false),
      { decoder: decoderFor(photoFrame(32, 32)), state: (e) => events.push(e) },
    );
    expect(hit).toBeNull();
    expect(events.filter((e) => e.type === 'encode')).toHaveLength(1);
  });

  it('WebP/AVIF lossless-варианты в реальном fit — по одной пробе на плоскость', async () => {
    for (const [format, effort] of [
      ['image/webp', 0.5],
      ['image/avif', 0],
    ] as const) {
      const events: PipelineEvent[] = [];
      const hit = await image(
        anyBlob(),
        (p) =>
          p.fit(
            {
              formats: [format],
              quality: [0.8, 0.99],
              variants: [{ lossless: true, effort }],
            },
            () => false,
          ),
        { decoder: decoderFor(photoFrame(32, 32)), state: (e) => events.push(e) },
      );
      expect(hit).toBeNull();
      expect(events.filter((e) => e.type === 'encode')).toHaveLength(1);
    }
  }, 120_000);

  it('qualityStep склеивает соседние точки сетки, которые кодек не различает', async () => {
    const codec = recordingCodec(() => 100, { qualityStep: 0.01 } satisfies CodecCapabilities);
    reg('image/stepped', codec);
    const hit = await image(
      anyBlob(),
      (p) =>
        p.fit({ formats: ['image/stepped'], quality: [0.805, 0.806] }, () => false, {
          strategy: 'owner-loop',
        }),
      { decoder: decoderFor(photoFrame(20, 20)) },
    );
    expect(hit).toBeNull();
    expect(codec.encodes).toBe(1);
  });

  it('неподдержанные channel/subsampling дают warnings и не попадают в encode', async () => {
    const codec = recordingCodec(() => 10, undefined, {
      channels: ['ycbcr'],
      subsampling: ['4:2:0'],
    });
    reg('image/limited', codec);
    const warnings: FitWarning[] = [];
    const hit = await image(
      anyBlob(),
      (p) =>
        p.fit(
          {
            formats: ['image/limited'],
            quality: [0.9, 0.9],
            channels: ['grayscale'],
            subsampling: ['4:4:4'],
          },
          () => true,
          { onWarning: (w) => warnings.push(w) },
        ),
      { decoder: decoderFor(photoFrame(20, 20)) },
    );
    expect(hit).not.toBeNull();
    expect(warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining(['unsupported-channel', 'unsupported-subsampling']),
    );
    expect(codec.calls[0].channel).toBeUndefined();
    expect(codec.calls[0].subsampling).toBeUndefined();
  });
});

describe('фаза 2: бюджет и дедлайн fit', () => {
  async function runBudgetFit(options: {
    maxAttempts?: number;
    onBudgetExhausted?: 'throw' | 'return-null';
    limit?: number;
    events?: PipelineEvent[];
  }) {
    const fake = makeFakeCodec({ baseAtQ80: 20_000 });
    reg('image/budget', fake);
    const result = image(
      anyBlob(),
      (p) =>
        p.fit(
          { formats: ['image/budget'], quality: [0.8, 0.99] },
          (c) => c.size <= (options.limit ?? 30_000),
          {
            strategy: 'binary',
            maxAttempts: options.maxAttempts,
            onBudgetExhausted: options.onBudgetExhausted,
          },
        ),
      {
        decoder: decoderFor(photoFrame(200, 200)),
        state: options.events ? (e) => options.events!.push(e) : undefined,
      },
    );
    return { fake, result };
  }

  it('maxAttempts=1 при незавершённом поиске бросает FitBudgetExhaustedError, а не null', async () => {
    const events: PipelineEvent[] = [];
    const { fake, result } = await runBudgetFit({ maxAttempts: 1, events });
    await expect(result).rejects.toBeInstanceOf(FitBudgetExhaustedError);
    await expect(result).rejects.toMatchObject({ reason: 'max-attempts', attempts: 1 });
    expect(fake.encodes).toBe(1);
    expect(events.map((e) => e.type)).toContain('fit-start');
    expect(events.map((e) => e.type)).toContain('fit-exhausted');
    expect(events.map((e) => e.type)).not.toContain('fit-done');
  });

  it('return-null — только явный opt-in, с событием fit-exhausted', async () => {
    const events: PipelineEvent[] = [];
    const { fake, result } = await runBudgetFit({
      maxAttempts: 1,
      onBudgetExhausted: 'return-null',
      events,
    });
    await expect(result).resolves.toBeNull();
    expect(fake.encodes).toBe(1);
    expect(events.map((e) => e.type)).toContain('fit-exhausted');
    expect(events.at(-2)).toMatchObject({ type: 'fit-done', hit: false });
  });

  it('доказанный no-fit ровно в бюджет — обычный null без ошибки', async () => {
    const { fake, result } = await runBudgetFit({ maxAttempts: 2, limit: 10 });
    await expect(result).resolves.toBeNull();
    expect(fake.encodes).toBe(2); // binary: потолок + пол
  });

  it('попадание ровно в бюджет возвращается результатом', async () => {
    const { result } = await runBudgetFit({ maxAttempts: 1, limit: 200_000 });
    const hit = await result;
    expect(hit).not.toBeNull();
    expect(hit!.attempts).toBe(1);
  });

  it('deadline останавливает перед следующей пробой, уже запущенный энкод дорабатывает', async () => {
    let encodes = 0;
    reg('image/slow', {
      async encode() {
        encodes += 1;
        await new Promise((resolve) => setTimeout(resolve, 25));
        return new Blob([new Uint8Array(100)], { type: 'image/slow' });
      },
    });
    await expect(
      image(
        anyBlob(),
        (p) =>
          p.fit({ formats: ['image/slow'], quality: [0.8, 0.99] }, () => false, {
            strategy: 'owner-loop',
            deadlineMs: 5,
          }),
        { decoder: decoderFor(photoFrame(20, 20)) },
      ),
    ).rejects.toMatchObject({ name: 'FitBudgetExhaustedError', reason: 'deadline', attempts: 1 });
    expect(encodes).toBe(1);
  });

  it('некорректный бюджет — InvalidOptionsError до энкодов', async () => {
    const codec = recordingCodec(() => 10);
    reg('image/invalid-budget', codec);
    await expect(
      image(
        anyBlob(),
        (p) =>
          p.fit({ formats: ['image/invalid-budget'], quality: [0.8, 0.99] }, () => true, {
            maxAttempts: 0,
          }),
        { decoder: decoderFor(photoFrame(20, 20)) },
      ),
    ).rejects.toThrow(InvalidOptionsError);
    expect(codec.encodes).toBe(0);
  });
});

describe('фаза 2: монотонность и категориальные варианты', () => {
  it('инверсия весов на концах вилки откатывает binary к owner-loop внутри плоскости', async () => {
    const codec = recordingCodec((options) => {
      const q = options.quality ?? 0;
      if (q >= 0.99) return 90;
      if (q <= 0.8) return 100;
      return q === 0.9 ? 10 : 100;
    });
    reg('image/inverted', codec);
    const hit = await image(
      anyBlob(),
      (p) =>
        p.fit({ formats: ['image/inverted'], quality: [0.8, 0.99] }, (c) => c.size <= 20, {
          strategy: 'binary',
        }),
      { decoder: decoderFor(photoFrame(20, 20)) },
    );
    expect(hit).not.toBeNull();
    expect(hit!.params.quality).toBe(0.9);
  });

  it("monotonicity:'none' принудительно использует owner-loop для произвольного предиката", async () => {
    const codec = recordingCodec((options) => {
      const q = options.quality ?? 0.8;
      return Math.round(10 + ((q - 0.8) / 0.19) * 90);
    });
    reg('image/arbitrary', codec);
    const warnings: FitWarning[] = [];
    const hit = await image(
      anyBlob(),
      (p) =>
        p.fit(
          { formats: ['image/arbitrary'], quality: [0.8, 0.99] },
          (c) => c.size === 57,
          { strategy: 'binary', monotonicity: 'none', onWarning: (w) => warnings.push(w) },
        ),
      { decoder: decoderFor(photoFrame(20, 20)) },
    );
    expect(hit).not.toBeNull();
    expect(hit!.params.quality).toBe(0.9);
    expect(warnings.map((w) => w.code)).toContain('strategy-overridden');
  });

  it('variants перечисляются плоскостями: средний немонотонный вариант находится', async () => {
    const codec = recordingCodec((options) => (options.mode === 'b' ? 10 : 100));
    reg('image/variants-phase2', codec);
    const hit = await image(
      anyBlob(),
      (p) =>
        p.fit(
          {
            formats: ['image/variants-phase2'],
            quality: [0.9, 0.9],
            variants: [{ mode: 'a' }, { mode: 'b' }, { mode: 'c' }],
          },
          (c) => c.size <= 20,
        ),
      { decoder: decoderFor(photoFrame(20, 20)) },
    );
    expect(hit).not.toBeNull();
    expect(hit!.params.variant).toEqual({ mode: 'b' });
    expect(hit!.attempts).toBe(2);
  });
});

describe('фаза 2: плоскости, лимиты и длинные операции', () => {
  it('countPlanes считает без материализации, iteratePlanes сохраняет порядок buildPlanes', () => {
    const fake = makeFakeCodec({ baseAtQ80: 1000 });
    const spec = {
      formats: ['image/fake'],
      quality: [0.8, 0.99] as [number, number],
      colors: [16, 256] as [number, number],
      channels: ['rgb', 'grayscale'],
      variants: [{ mode: 'a' }, { mode: 'b' }, { mode: 'c' }],
    };
    const getCodec = () => fake;
    expect(countPlanes(spec, getCodec, false)).toBe(54);
    const iterated = [...iteratePlanes(spec, getCodec, false)];
    expect(iterated).toEqual(buildPlanes(spec, getCodec, false));
    expect(iterated[0].variant).toEqual({ mode: 'a' });
    expect(iterated.at(-1)).toMatchObject({ colors: 16, channel: 'grayscale' });
  });

  it('maxPixels на декодированном кадре — ResourceLimitError без энкодов', async () => {
    const codec = recordingCodec(() => 10);
    reg('image/limited-source', codec);
    await expect(
      image(anyBlob(), (p) => p.encode('image/limited-source'), {
        decoder: decoderFor(photoFrame(20, 20)),
        maxPixels: 100,
      }),
    ).rejects.toBeInstanceOf(ResourceLimitError);
    expect(codec.encodes).toBe(0);
  });

  it('maxDimension на целевой геометрии frame — отказ до encode', async () => {
    const codec = recordingCodec(() => 10);
    reg('image/limited-frame', codec);
    await expect(
      image(
        anyBlob(),
        async (p) => {
          await p.frame({ width: 20, height: 20 });
          return p.encode('image/limited-frame');
        },
        { decoder: decoderFor(photoFrame(10, 10)), maxDimension: 10 },
      ),
    ).rejects.toBeInstanceOf(ResourceLimitError);
    expect(codec.encodes).toBe(0);
  });

  it('гигантский целевой ресайз — понятная InvalidOptionsError, а не попытка аллокации', () => {
    expect(() => resizeBilinear(photoFrame(2, 2), 100_000, 100_000)).toThrow(InvalidOptionsError);
  });

  it('resize честно реагирует на уже абортированный сигнал', () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => resizeArea(photoFrame(4, 4), 2, 2, controller.signal)).toThrow(
      expect.objectContaining({ name: 'AbortError' }),
    );
  });
});

describe('фаза 2: реальная семантика lossless', () => {
  it('WebP lossless: q=0 и q=1 декодируются побитово в исходник', async () => {
    const frame = photoFrame(48, 48);
    const { decodeWebp } = await import('../src/codecs/webp.js');
    for (const quality of [0, 1]) {
      const blob = await image(
        anyBlob(),
        (p) => p.encode('image/webp', { lossless: true, quality, effort: 0.5 }),
        { decoder: decoderFor(frame) },
      );
      const decoded = await decodeWebp(blob);
      expect(Buffer.from(decoded.data).equals(Buffer.from(frame.data))).toBe(true);
    }
  });

  it('AVIF lossless: quality игнорируется — размеры равны, пиксели точны', async () => {
    const frame = photoFrame(48, 48);
    const { decodeAvif } = await import('../src/codecs/avif.js');
    const sizes: number[] = [];
    for (const quality of [0.1, 0.9]) {
      const blob = await image(
        anyBlob(),
        (p) => p.encode('image/avif', { lossless: true, quality, effort: 0 }),
        { decoder: decoderFor(frame) },
      );
      sizes.push(blob.size);
      const decoded = await decodeAvif(blob);
      expect(Buffer.from(decoded.data).equals(Buffer.from(frame.data))).toBe(true);
    }
    expect(sizes[0]).toBe(sizes[1]);
  }, 120_000);
});
