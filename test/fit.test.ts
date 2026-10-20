import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { image, registerEncoder, unregisterEncoder } from '../src/index.js';
import type { FitResult, FitSpec, FitStrategyName, PipelineEvent } from '../src/index.js';
import {
  anyBlob,
  decoderFor,
  makeFakeCodec,
  mangaFrame,
  modelSize,
  photoFrame,
  type FakeCodec,
} from './helpers.js';

const ALL_STRATEGIES: FitStrategyName[] = ['owner-loop', 'binary', 'secant', 'coarse-fine'];

let fake: FakeCodec;

beforeAll(() => {
  fake = makeFakeCodec({ baseAtQ80: 20_000 });
  registerEncoder('image/fake', fake);
});
afterAll(() => unregisterEncoder('image/fake'));

async function runFit(
  strategy: FitStrategyName,
  limit: number,
  frame = photoFrame(200, 200),
  spec: Partial<FitSpec> = {},
): Promise<FitResult | null> {
  fake.reset();
  return image(
    anyBlob(),
    (p) =>
      p.fit(
        {
          formats: ['image/fake'],
          quality: [0.8, 0.99],
          colors: [16, 256],
          ...spec,
        },
        (candidate) => candidate.size <= limit,
        { strategy },
      ),
    { decoder: decoderFor(frame) },
  );
}

describe('fit: базовые контракты', () => {
  it('находит лучшее влезшее качество на сетке (пример из ТЗ)', async () => {
    // Модель: при q=0.87 вес ~29.3k, при 0.88 ~31.4k → граница ровно 0.87.
    const hit = await runFit('binary', 30_000);
    expect(hit).not.toBeNull();
    expect(hit!.params).toMatchObject({ format: 'image/fake', quality: 0.87 });
    expect(hit!.params.colors).toBeUndefined();
    expect(hit!.blob.size).toBeLessThanOrEqual(30_000);
    // attempts fit'а сверяется с независимым счётчиком кодека.
    expect(hit!.attempts).toBe(fake.encodes);
  });

  it('невозможный вес — null, и fit-done с hit:false', async () => {
    const events: PipelineEvent[] = [];
    const hit = await image(
      anyBlob(),
      (p) =>
        p.fit({ formats: ['image/fake'], quality: [0.8, 0.99], colors: [16, 256] }, (c) => c.size <= 10),
      { decoder: decoderFor(photoFrame(200, 200)), state: (e) => events.push(e) },
    );
    expect(hit).toBeNull();
    expect(events.at(-2)).toMatchObject({ type: 'fit-done', hit: false });
  });

  it('качество режется вглубь раньше палитры (визуальная цена, §4.1)', async () => {
    // Лимит достижим одним качеством ~0.81 без палитры:
    // палитра при этом не должна трогаться вовсе.
    const target = modelSize({ baseAtQ80: 20_000 }, 0.81, undefined, undefined) + 50;
    const hit = await runFit('binary', target);
    expect(hit).not.toBeNull();
    expect(hit!.params.colors).toBeUndefined();
    expect(hit!.params.quality).toBe(0.81);
  });

  it('порядок formats — порядок предпочтения', async () => {
    const heavy = makeFakeCodec({ baseAtQ80: 5_000_000 }, 'image/heavy');
    registerEncoder('image/heavy', heavy);
    try {
      const hit = await image(
        anyBlob(),
        (p) =>
          p.fit({ formats: ['image/heavy', 'image/fake'], quality: [0.8, 0.99] }, (c) => c.size <= 30_000),
        { decoder: decoderFor(photoFrame(200, 200)) },
      );
      expect(hit!.params.format).toBe('image/fake'); // первый не влез даже на полу
    } finally {
      unregisterEncoder('image/heavy');
    }
  });
});

describe('fit: стратегии не хуже owner-loop и дешевле по пробам', () => {
  // Лимиты подобраны так, чтобы покрыть: попадание на потолке, середину сетки,
  // глубокое качество, уход в палитру и невозможный вес.
  const LIMITS = [200_000, 30_000, 21_500, 13_000, 10];

  for (const limit of LIMITS) {
    it(`лимит ${limit}: все стратегии дают результат owner-loop, проб — не больше`, async () => {
      const baseline = await runFit('owner-loop', limit);
      for (const strategy of ALL_STRATEGIES.slice(1)) {
        const hit = await runFit(strategy, limit);
        if (baseline === null) {
          expect(hit, strategy).toBeNull();
          continue;
        }
        expect(hit, strategy).not.toBeNull();
        // Тот же лучший влезший набор параметров — деградации нет.
        expect(hit!.params, strategy).toEqual(baseline.params);
        expect(hit!.blob.size, strategy).toBe(baseline.blob.size);
        // И достигнут он не дороже по энкодам.
        expect(hit!.attempts, strategy).toBeLessThanOrEqual(baseline.attempts);
      }
    });
  }

  it('binary укладывается в оценку худшего случая на одной плоскости', async () => {
    // Сетка [0.80..0.99] = 20 точек: вилка (2) + ceil(log2(19)) = ≤ 7 проб.
    const hit = await runFit('binary', 30_000);
    expect(hit!.attempts).toBeLessThanOrEqual(7);
    const owner = await runFit('owner-loop', 30_000);
    expect(owner!.attempts).toBe(13); // 0.99 → 0.87 линейно
  });
});

describe('fit: канал как измерение и проба монохромности', () => {
  it('почти-монохромный кадр: grayscale раньше rgb и раньше палитры', async () => {
    const manga = makeFakeCodec({ baseAtQ80: 20_000, chroma: 0 }, 'image/manga');
    registerEncoder('image/manga', manga);
    const events: PipelineEvent[] = [];
    try {
      const hit = await image(
        anyBlob(),
        (p) =>
          p.fit(
            {
              formats: ['image/manga'],
              quality: [0.8, 0.99],
              colors: [16, 256],
              channels: ['rgb', 'grayscale'], // в spec rgb первым — проба должна переставить
            },
            (c) => c.size <= 5_000,
          ),
        { decoder: decoderFor(mangaFrame(200, 200)), state: (e) => events.push(e) },
      );
      expect(events.find((e) => e.type === 'probe')).toMatchObject({ monochrome: true });
      expect(hit).not.toBeNull();
      expect(hit!.params.channel).toBe('grayscale');
      expect(hit!.params.colors).toBeUndefined(); // до палитры не дошло
      // rgb не пробовался вовсе: grayscale поднят пробой насыщенности.
      expect(manga.calls.some((c) => c.channel === 'rgb')).toBe(false);
    } finally {
      unregisterEncoder('image/manga');
    }
  });

  it('grayscale без opt-in в spec не пробуется (потеря цвета — не наш произвол)', async () => {
    const manga = makeFakeCodec({ baseAtQ80: 20_000, chroma: 0 }, 'image/manga2');
    registerEncoder('image/manga2', manga);
    try {
      await image(
        anyBlob(),
        (p) =>
          p.fit({ formats: ['image/manga2'], quality: [0.8, 0.99] }, (c) => c.size <= 5_000),
        { decoder: decoderFor(mangaFrame(200, 200)) },
      );
      expect(manga.calls.every((c) => c.channel === undefined)).toBe(true);
    } finally {
      unregisterEncoder('image/manga2');
    }
  });

  it('цветному кадру grayscale не форсится: проба говорит monochrome=false', async () => {
    const events: PipelineEvent[] = [];
    await image(
      anyBlob(),
      (p) =>
        p.fit(
          { formats: ['image/fake'], quality: [0.8, 0.99], channels: ['rgb', 'grayscale'] },
          (c) => c.size <= 200_000,
        ),
      { decoder: decoderFor(photoFrame(200, 200)), state: (e) => events.push(e) },
    );
    expect(events.find((e) => e.type === 'probe')).toMatchObject({ monochrome: false });
  });
});

describe('fit: геометрия первым шагом', () => {
  it('spec.frame применяется внутри fit и сообщается через state', async () => {
    const events: PipelineEvent[] = [];
    await image(
      anyBlob(),
      (p) =>
        p.fit(
          {
            formats: ['image/fake'],
            quality: [0.8, 0.99],
            frame: { width: 100, height: 100, fit: 'cover' },
          },
          (c) => c.size <= 200_000,
        ),
      { decoder: decoderFor(photoFrame(800, 600)), state: (e) => events.push(e) },
    );
    expect(events.find((e) => e.type === 'frame')).toMatchObject({ width: 100, height: 100 });
  });
});
