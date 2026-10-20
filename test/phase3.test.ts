import { afterEach, describe, expect, it } from 'vitest';
import {
  InvalidOptionsError,
  createEncoderRegistry,
  findEncoder,
  image,
  registerEncoder,
  unregisterEncoder,
} from '../src/index.js';
import type {
  Codec,
  EncodeOptions,
  EncoderRegistry,
  FitDimension,
  FitQualityStrategy,
  FitSpec,
  FitWarning,
  Frame,
  PipelineEvent,
} from '../src/index.js';
import {
  buildPlanes,
  compilePlaneDescriptors,
  countPlanes,
} from '../src/fit/dimensions.js';
import { createStateCollector } from '../src/state-collector.js';
import {
  assertQualityStrategyMatchesOwnerLoop,
  compareQualityStrategyToOwnerLoop,
  evaluateQualityStrategy,
} from '../src/testing.js';
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
): RecordingCodec {
  const codec: RecordingCodec = {
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
      this.calls.push({ ...options });
      return new Blob([new Uint8Array(size(options, frame))], { type: 'image/recording' });
    },
  };
  return codec;
}

describe('фаза 3: дескрипторы и golden-порядок плоскостей', () => {
  it('исторический порядок format → colors → channel → subsampling → variant не изменился', () => {
    const fake = makeFakeCodec({ baseAtQ80: 1000 });
    const spec: FitSpec = {
      formats: ['image/a', 'image/b'],
      quality: [0.8, 0.99],
      colors: [16, 16],
      channels: ['rgb'],
      subsampling: ['4:4:4'],
      variants: [{ smoothing: 0 }, { smoothing: 60 }],
    };
    const planes = buildPlanes(spec, () => fake, false);
    const compact = planes.map((p) =>
      [
        p.format,
        p.colors ?? 'none',
        p.channel ?? 'default',
        p.subsampling ?? 'default',
        p.variant?.smoothing,
      ].join('|'),
    );
    expect(compact.slice(0, 16)).toEqual([
      'image/a|none|default|default|0',
      'image/a|none|default|default|60',
      'image/a|none|default|4:4:4|0',
      'image/a|none|default|4:4:4|60',
      'image/a|none|rgb|default|0',
      'image/a|none|rgb|default|60',
      'image/a|none|rgb|4:4:4|0',
      'image/a|none|rgb|4:4:4|60',
      'image/a|16|default|default|0',
      'image/a|16|default|default|60',
      'image/a|16|default|4:4:4|0',
      'image/a|16|default|4:4:4|60',
      'image/a|16|rgb|default|0',
      'image/a|16|rgb|default|60',
      'image/a|16|rgb|4:4:4|0',
      'image/a|16|rgb|4:4:4|60',
    ]);
    expect(compact).toHaveLength(32);
    expect(compact.slice(16).every((line) => line.startsWith('image/b|'))).toBe(true);
  });

  it('почти-монохром по-прежнему поднимает grayscale сразу за default-каналом', () => {
    const fake = makeFakeCodec({ baseAtQ80: 1000 });
    const planes = buildPlanes(
      {
        formats: ['image/a'],
        quality: [0.8, 0.99],
        channels: ['rgb', 'grayscale'],
      },
      () => fake,
      true,
    );
    expect(planes.map((p) => p.channel ?? 'default')).toEqual(['default', 'grayscale', 'rgb']);
  });

  it('singleton-измерения компилируются в fixed, палитра — в frame-transform', () => {
    const fake = makeFakeCodec({ baseAtQ80: 1000 });
    const fixed = compilePlaneDescriptors(
      {
        formats: ['image/a'],
        quality: [0.8, 0.99],
        variants: [{ smoothing: 10 }],
        dimensions: [
          { name: 'fixedDim', values: [{ id: 'only', options: { effort: 0.5 } }] },
          {
            name: 'multiDim',
            values: [
              { id: 'a', options: { tune: 'auto' } },
              { id: 'b', options: { tune: 'ssim' } },
            ],
          },
        ],
      },
      fake,
      false,
    );
    expect(fixed.map((d) => [d.name, d.kind])).toEqual([
      ['colors', 'fixed'],
      ['channel', 'fixed'],
      ['subsampling', 'fixed'],
      ['variant', 'fixed'],
      ['fixedDim', 'fixed'],
      ['multiDim', 'categorical'],
    ]);

    const withPalette = compilePlaneDescriptors(
      { formats: ['image/a'], quality: [0.8, 0.99], colors: [16, 256] },
      fake,
      false,
    );
    expect(withPalette[0]).toMatchObject({ name: 'colors', kind: 'frame-transform' });
  });

  it('именованные измерения перечисляются после variants в заданном порядке', () => {
    const fake = makeFakeCodec({ baseAtQ80: 1000 });
    const spec: FitSpec = {
      formats: ['image/a'],
      quality: [0.9, 0.9],
      variants: [{ preset: 'v0' }, { preset: 'v1' }],
      dimensions: [
        {
          name: 'smooth',
          values: [
            { id: 's0', options: { smoothing: 0 } },
            { id: 's1', options: { smoothing: 50 } },
          ],
        },
        {
          name: 'quant',
          values: [
            { id: 'q0', options: { quant_table: 0 } },
            { id: 'q1', options: { quant_table: 1 } },
          ],
        },
      ],
    };
    const planes = buildPlanes(spec, () => fake, false);
    expect(countPlanes(spec, () => fake, false)).toBe(8);
    expect(
      planes.map(
        (p) => `${p.variant?.preset}/${p.dimensions?.smooth.id}/${p.dimensions?.quant.id}`,
      ),
    ).toEqual([
      'v0/s0/q0',
      'v0/s0/q1',
      'v0/s1/q0',
      'v0/s1/q1',
      'v1/s0/q0',
      'v1/s0/q1',
      'v1/s1/q0',
      'v1/s1/q1',
    ]);
    expect(planes[3].dimensionOptions).toEqual({ smoothing: 50, quant_table: 1 });
  });
});

describe('фаза 3: публичные именованные измерения', () => {
  it('независимые измерения перемножаются плоскостями и возвращаются в params', async () => {
    const codec = recordingCodec((options) =>
      options.smoothing === 50 && options.quant_table === 1 ? 10 : 100,
    );
    reg('image/named-dims', codec);
    const events: PipelineEvent[] = [];
    const hit = await image(
      anyBlob(),
      (p) =>
        p.fit(
          {
            formats: ['image/named-dims'],
            quality: [0.9, 0.9],
            dimensions: [
              {
                name: 'smooth',
                values: [
                  { id: 'off', options: { smoothing: 0 } },
                  { id: 'soft', options: { smoothing: 50 } },
                ],
              },
              {
                name: 'quant',
                values: [
                  { id: 'std', options: { quant_table: 0 } },
                  { id: 'flat', options: { quant_table: 1 } },
                ],
              },
            ],
          },
          (c) => c.size <= 20,
        ),
      { decoder: decoderFor(photoFrame(20, 20)), state: (e) => events.push(e) },
    );
    expect(hit).not.toBeNull();
    expect(hit!.attempts).toBe(4);
    expect(hit!.params.dimensions).toEqual({
      smooth: { id: 'soft', options: { smoothing: 50 } },
      quant: { id: 'flat', options: { quant_table: 1 } },
    });
    const lastEncode = events.filter((e) => e.type === 'encode').at(-1);
    expect(lastEncode).toMatchObject({
      type: 'encode',
      dimensions: { smooth: 'soft', quant: 'flat' },
    });
  });

  it('singleton-измерение fixed: единственное значение применяется всегда', async () => {
    const codec = recordingCodec((options) => (options.smoothing === 50 ? 10 : 100));
    reg('image/fixed-dim', codec);
    const hit = await image(
      anyBlob(),
      (p) =>
        p.fit(
          {
            formats: ['image/fixed-dim'],
            quality: [0.9, 0.9],
            dimensions: [
              { name: 'smooth', values: [{ id: 'soft', options: { smoothing: 50 } }] },
            ],
          },
          (c) => c.size <= 20,
        ),
      { decoder: decoderFor(photoFrame(20, 20)) },
    );
    expect(hit).not.toBeNull();
    expect(codec.calls[0].smoothing).toBe(50);
    expect(hit!.params.dimensions?.smooth.id).toBe('soft');
  });

  it('конфликты ключей и reserved-опции отклоняются до первого энкода', async () => {
    const codec = recordingCodec(() => 10);
    reg('image/dim-conflicts', codec);
    const badDimensions: FitDimension[][] = [
      [
        { name: 'a', values: [{ id: 'x', options: { smoothing: 0 } }] },
        { name: 'b', values: [{ id: 'y', options: { smoothing: 50 } }] },
      ],
      [{ name: 'a', values: [{ id: 'x', options: { quality: 0.5 } }] }],
      [{ name: 'channel', values: [{ id: 'x', options: { smoothing: 0 } }] }],
    ];
    for (const dimensions of badDimensions) {
      codec.reset();
      await expect(
        image(
          anyBlob(),
          (p) =>
            p.fit(
              { formats: ['image/dim-conflicts'], quality: [0.9, 0.9], dimensions },
              () => true,
            ),
          { decoder: decoderFor(photoFrame(20, 20)) },
        ),
      ).rejects.toThrow(InvalidOptionsError);
      expect(codec.encodes).toBe(0);
    }

    codec.reset();
    await expect(
      image(
        anyBlob(),
        (p) =>
          p.fit(
            {
              formats: ['image/dim-conflicts'],
              quality: [0.9, 0.9],
              variants: [{ smoothing: 0 }],
              dimensions: [
                { name: 'a', values: [{ id: 'x', options: { smoothing: 50 } }] },
              ],
            },
            () => true,
          ),
        { decoder: decoderFor(photoFrame(20, 20)) },
      ),
    ).rejects.toThrow(/conflicts between variants/);
    expect(codec.encodes).toBe(0);
  });
});

describe('фаза 3: пользовательские стратегии качества', () => {
  it('функция-стратегия получает плоскость, сигнал и живой бюджет, но не предикат', async () => {
    const fake = makeFakeCodec({ baseAtQ80: 20_000 });
    reg('image/custom-strategy', fake);
    const seen: unknown[] = [];
    const descending: FitQualityStrategy = async (probe, grid, context) => {
      seen.push({
        plane: context.plane,
        planeIndex: context.planeIndex,
        attemptsAtStart: context.attempts(),
        remainingAtStart: context.remainingAttempts(),
        hasSignal: !!context.signal,
        monotonicity: context.monotonicity,
      });
      for (let i = grid.length - 1; i >= 0; i--) {
        const out = await probe(grid[i]);
        if (out.fits) return { quality: grid[i], blob: out.blob };
      }
      return null;
    };
    const controller = new AbortController();
    const hit = await image(
      anyBlob(),
      (p) =>
        p.fit({ formats: ['image/custom-strategy'], quality: [0.8, 0.99] }, (c) => c.size <= 30_000, {
          strategy: descending,
          maxAttempts: 30,
        }),
      { decoder: decoderFor(photoFrame(120, 120)), signal: controller.signal },
    );
    expect(hit).not.toBeNull();
    expect(hit!.attempts).toBe(fake.encodes);
    expect(seen).toEqual([
      {
        plane: { format: 'image/custom-strategy' },
        planeIndex: 0,
        attemptsAtStart: 0,
        remainingAtStart: 30,
        hasSignal: true,
        monotonicity: 'size',
      },
    ]);
  });

  it('объект-стратегия работает через search()', async () => {
    const codec = recordingCodec((options) => Math.round(10 + (options.quality ?? 0) * 100));
    reg('image/object-strategy', codec);
    const hit = await image(
      anyBlob(),
      (p) =>
        p.fit({ formats: ['image/object-strategy'], quality: [0.8, 0.99] }, (c) => c.size <= 120, {
          strategy: {
            name: 'ceiling-first',
            async search(probe, grid) {
              const q = grid[grid.length - 1];
              const out = await probe(q);
              return out.fits ? { quality: q, blob: out.blob } : null;
            },
          },
        }),
      { decoder: decoderFor(photoFrame(20, 20)) },
    );
    expect(hit).not.toBeNull();
    expect(hit!.params.quality).toBe(0.99);
    expect(hit!.attempts).toBe(1);
  });

  it('проба вне сетки и выдуманный/невлезший hit честно запрещены', async () => {
    const codec = recordingCodec(() => 100);
    reg('image/bad-strategy', codec);
    const run = (strategy: FitQualityStrategy) =>
      image(
        anyBlob(),
        (p) =>
          p.fit({ formats: ['image/bad-strategy'], quality: [0.8, 0.99] }, (c) => c.size <= 20, {
            strategy,
          }),
        { decoder: decoderFor(photoFrame(20, 20)) },
      );

    await expect(
      run(async (probe) => {
        await probe(0.12345);
        return null;
      }),
    ).rejects.toThrow(/outside the quality grid/);
    expect(codec.encodes).toBe(0);

    codec.reset();
    await expect(
      run(async () => ({ quality: 0.99, blob: new Blob([new Uint8Array(10)]) })),
    ).rejects.toThrow(/without probing/);
    expect(codec.encodes).toBe(0);

    codec.reset();
    await expect(
      run(async (probe, grid) => {
        const q = grid[grid.length - 1];
        const out = await probe(q);
        return { quality: q, blob: out.blob };
      }),
    ).rejects.toThrow(/non-fitting/);
    expect(codec.encodes).toBe(1);
  });

  it("monotonicity:'none' не запускает пользовательскую умную стратегию", async () => {
    const codec = recordingCodec((options) => {
      const q = options.quality ?? 0.8;
      return Math.round(10 + ((q - 0.8) / 0.19) * 90);
    });
    reg('image/custom-none', codec);
    let called = false;
    const warnings: FitWarning[] = [];
    const hit = await image(
      anyBlob(),
      (p) =>
        p.fit({ formats: ['image/custom-none'], quality: [0.8, 0.99] }, (c) => c.size === 57, {
          strategy: async () => {
            called = true;
            return null;
          },
          monotonicity: 'none',
          onWarning: (w) => warnings.push(w),
        }),
      { decoder: decoderFor(photoFrame(20, 20)) },
    );
    expect(hit).not.toBeNull();
    expect(hit!.params.quality).toBe(0.9);
    expect(called).toBe(false);
    expect(warnings.map((w) => w.code)).toContain('strategy-overridden');
  });

  it('harness сверяет стратегию с owner-loop и ловит пробы вне сетки/расхождения', async () => {
    const grid = Array.from({ length: 20 }, (_, i) => (80 + i) / 100);
    const curve = {
      grid,
      sizeAt: (q: number) => Math.round(1000 / (1.02 - q)),
      maxSize: 10_000,
    };
    const comparison = await compareQualityStrategyToOwnerLoop('binary', curve);
    expect(comparison.matchesOwnerLoop).toBe(true);
    expect(comparison.candidate.hit?.quality).toBe(0.92);
    expect(comparison.candidate.attempts).toBeLessThan(comparison.ownerLoop.attempts);

    await expect(
      assertQualityStrategyMatchesOwnerLoop(async (probe, g) => {
        const out = await probe(g[0]);
        return out.fits ? { quality: g[0], blob: out.blob } : null;
      }, curve),
    ).rejects.toThrow(/does not match owner-loop/);

    await expect(
      evaluateQualityStrategy(async (probe) => {
        await probe(0.5);
        return null;
      }, curve),
    ).rejects.toThrow(/outside the quality grid/);
  });
});

describe('фаза 3: изолированные реестры кодеков', () => {
  it('два параллельных image() с одним MIME не протекают друг в друга и в global', async () => {
    const format = 'image/isolated-phase3';
    const registryA = createEncoderRegistry();
    const registryB = createEncoderRegistry();
    registryA.register(format, recordingCodec(() => 11));
    registryB.register(format, recordingCodec(() => 22));

    const [a, b] = await Promise.all([
      image(anyBlob(), (p) => p.encode(format), {
        decoder: decoderFor(photoFrame(10, 10)),
        registry: registryA,
      }),
      image(anyBlob(), (p) => p.encode(format), {
        decoder: decoderFor(photoFrame(10, 10)),
        registry: registryB,
      }),
    ]);
    expect(a.size).toBe(11);
    expect(b.size).toBe(22);
    expect(findEncoder(format)).toBeUndefined();
  });

  it('fit тоже использует реестр вызова; clone независим от оригинала', async () => {
    const format = 'image/isolated-fit';
    const registry = createEncoderRegistry();
    registry.register(
      format,
      recordingCodec((options) => Math.round(10 + (options.quality ?? 0) * 100)),
    );
    const hit = await image(
      anyBlob(),
      (p) => p.fit({ formats: [format], quality: [0.8, 0.99] }, (c) => c.size <= 100),
      { decoder: decoderFor(photoFrame(10, 10)), registry },
    );
    expect(hit).not.toBeNull();
    expect(hit!.params.quality).toBe(0.9);

    const clone = registry.clone();
    expect(clone.unregister(format)).toBe(true);
    expect(clone.find(format)).toBeUndefined();
    expect(registry.find(format)).toBeDefined();
  });

  it('повторный вызов после отказа ленивого кодека не отравлен первым reject', async () => {
    const format = 'image/flaky-lazy';
    const registry: EncoderRegistry = createEncoderRegistry();
    let calls = 0;
    registry.register(format, {
      async encode() {
        calls += 1;
        if (calls === 1) throw new Error('simulated lazy load failure');
        return new Blob([new Uint8Array(7)], { type: format });
      },
    });
    await expect(
      image(anyBlob(), (p) => p.encode(format), {
        decoder: decoderFor(photoFrame(10, 10)),
        registry,
      }),
    ).rejects.toThrow(/lazy load failure/);
    const blob = await image(anyBlob(), (p) => p.encode(format), {
      decoder: decoderFor(photoFrame(10, 10)),
      registry,
    });
    expect(blob.size).toBe(7);
    expect(calls).toBe(2);
  });

  it('невалидный registry отклоняется до декодирования', async () => {
    let decoded = false;
    await expect(
      image(anyBlob(), (p) => p.encode('image/jpeg'), {
        decoder: async () => {
          decoded = true;
          return photoFrame(10, 10);
        },
        registry: {} as EncoderRegistry,
      }),
    ).rejects.toThrow(InvalidOptionsError);
    expect(decoded).toBe(false);
  });
});

describe('фаза 3: state-collector', () => {
  it('собирает стадию, попытки, warnings, fit и тайминги; подписчики изолированы', () => {
    let now = 0;
    const collector = createStateCollector({ now: () => now });
    const snapshots: unknown[] = [];
    collector.subscribe(() => {
      throw new Error('bad subscriber');
    });
    const unsubscribe = collector.subscribe((snapshot) => snapshots.push(snapshot));

    const warningValues = ['grayscale'];
    collector.listener({ type: 'decode-start' });
    now = 10;
    collector.listener({ type: 'decode-done', width: 20, height: 10 });
    now = 15;
    collector.listener({
      type: 'warning',
      warning: {
        code: 'unsupported-channel',
        message: 'test',
        format: 'image/fake',
        values: warningValues,
      },
    });
    warningValues.push('rgb');
    now = 20;
    collector.listener({
      type: 'fit-start',
      formats: ['image/fake'],
      planes: 3,
      gridSize: 20,
      ownerLoopUpperBound: 60,
      maxAttempts: 5,
    });
    now = 25;
    collector.listener({
      type: 'encode',
      format: 'image/fake',
      quality: 0.9,
      dimensions: { smooth: 'soft' },
      attempt: 1,
    });
    now = 40;
    collector.listener({
      type: 'encode-done',
      format: 'image/fake',
      size: 123,
      quality: 0.9,
      dimensions: { smooth: 'soft' },
      attempt: 1,
      fits: true,
    });
    now = 50;
    collector.listener({ type: 'fit-done', hit: true, attempts: 1 });
    now = 60;
    collector.listener({ type: 'done' });

    const snapshot = collector.getSnapshot();
    expect(snapshot).toMatchObject({ status: 'done', stage: 'done', width: 20, height: 10 });
    expect(snapshot.warnings).toHaveLength(1);
    expect(snapshot.warnings[0].values).toEqual(['grayscale']);
    expect(snapshot.fit).toMatchObject({ planes: 3, hit: true, attempts: 1, maxAttempts: 5 });
    expect(snapshot.attempts).toEqual([
      expect.objectContaining({
        attempt: 1,
        status: 'done',
        size: 123,
        fits: true,
        durationMs: 15,
        dimensions: { smooth: 'soft' },
      }),
    ]);
    expect(snapshot.timings.elapsedMs).toBe(60);
    expect(snapshot.timings.stages).toMatchObject({
      'decode-start': 10,
      'decode-done': 5,
      warning: 5,
      'fit-start': 5,
      encode: 15,
      'encode-done': 10,
      'fit-done': 10,
    });
    expect(snapshots).toHaveLength(8);
    expect(Object.isFrozen(snapshot.attempts)).toBe(true);
    expect(Object.isFrozen(snapshot.warnings)).toBe(true);
    expect(collector.getSnapshot().attempts).not.toBe(snapshot.attempts);

    unsubscribe();
    collector.reset();
    expect(snapshots).toHaveLength(8);
    expect(collector.getSnapshot()).toMatchObject({ status: 'idle', stage: 'idle' });
    expect(collector.getSnapshot().attempts).toEqual([]);
  });

  it('интегрируется с image() как обычный state-listener', async () => {
    const format = 'image/collector-fit';
    const registry = createEncoderRegistry();
    registry.register(
      format,
      recordingCodec((options) => (options.smoothing === 50 ? 10 : 100)),
    );
    const collector = createStateCollector();
    const hit = await image(
      anyBlob(),
      (p) =>
        p.fit(
          {
            formats: [format],
            quality: [0.9, 0.9],
            dimensions: [
              {
                name: 'smooth',
                values: [
                  { id: 'off', options: { smoothing: 0 } },
                  { id: 'soft', options: { smoothing: 50 } },
                ],
              },
            ],
          },
          (c) => c.size <= 20,
        ),
      {
        decoder: decoderFor(photoFrame(10, 10)),
        registry,
        state: collector.listener,
      },
    );
    expect(hit).not.toBeNull();
    const snapshot = collector.getSnapshot();
    expect(snapshot.status).toBe('done');
    expect(snapshot.fit).toMatchObject({ planes: 2, hit: true, attempts: 2 });
    expect(snapshot.attempts.map((a) => a.dimensions?.smooth)).toEqual(['off', 'soft']);
  });
});
