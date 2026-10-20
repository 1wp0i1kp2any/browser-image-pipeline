import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EnvironmentError,
  UnknownFormatError,
  image,
  registerEncoder,
  registeredFormats,
  unregisterEncoder,
} from '../src/index.js';
import type { PipelineEvent } from '../src/index.js';
import { anyBlob, decoderFor, makeFakeCodec, photoFrame } from './helpers.js';

const fake = makeFakeCodec({ baseAtQ80: 20_000 });

beforeAll(() => registerEncoder('image/fake', fake));
afterAll(() => unregisterEncoder('image/fake'));

describe('image(): контракт прямого использования', () => {
  it('frame → quantize → encode из примера заказчика', async () => {
    fake.reset();
    const out = await image(
      anyBlob(),
      async (p) => {
        await p.frame({ width: 200, height: 200, fit: 'cover' });
        await p.quantize({ colors: 64, dithering: 0.5 });
        return p.encode('image/fake', { quality: 0.9 });
      },
      { decoder: decoderFor(photoFrame(400, 300)) },
    );
    expect(out).toBeInstanceOf(Blob);
    expect(out.type).toBe('image/fake');
    expect(fake.encodes).toBe(1);
  });

  it('состояние: этапы приходят по порядку, потребитель не опрашивает ничего', async () => {
    const events: PipelineEvent[] = [];
    await image(
      anyBlob(),
      async (p) => {
        await p.frame({ width: 200, height: 200 });
        await p.quantize({ colors: 32 });
        return p.encode('image/fake', { quality: 0.85 });
      },
      { decoder: decoderFor(photoFrame(300, 300)), state: (e) => events.push(e) },
    );
    expect(events.map((e) => e.type)).toEqual([
      'decode-start',
      'decode-done',
      'frame',
      'quantize',
      'encode',
      'encode-done',
      'done',
    ]);
    const enc = events.find((e) => e.type === 'encode');
    expect(enc).toMatchObject({ format: 'image/fake', quality: 0.85 });
  });

  it('бросающий слушатель состояния не роняет конвейер', async () => {
    const out = await image(anyBlob(), (p) => p.encode('image/fake'), {
      decoder: decoderFor(photoFrame(20, 20)),
      state: () => {
        throw new Error('слушатель сломался');
      },
    });
    expect(out).toBeInstanceOf(Blob);
  });

  it('незарегистрированный формат — UnknownFormatError с именем формата', async () => {
    await expect(
      image(anyBlob(), (p) => p.encode('image/jxl'), {
        decoder: decoderFor(photoFrame(20, 20)),
      }),
    ).rejects.toThrow(UnknownFormatError);
  });

  it('встроенные jpeg/png/webp/avif зарегистрированы тем же реестром', () => {
    expect(registeredFormats()).toContain('image/jpeg');
    expect(registeredFormats()).toContain('image/png');
    expect(registeredFormats()).toContain('image/webp');
    expect(registeredFormats()).toContain('image/avif');
  });
});

describe('среда и отмена', () => {
  it('вне браузера и без decoder — честный EnvironmentError, не молчаливый мусор', async () => {
    // Среда тестов — Node: createImageBitmap/OffscreenCanvas нет.
    await expect(image(anyBlob(), (p) => p.encode('image/fake'))).rejects.toThrow(
      EnvironmentError,
    );
  });

  it('AbortSignal до старта — AbortError без единого энкода', async () => {
    fake.reset();
    const controller = new AbortController();
    controller.abort();
    await expect(
      image(anyBlob(), (p) => p.encode('image/fake'), {
        decoder: decoderFor(photoFrame(20, 20)),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fake.encodes).toBe(0);
  });

  it('отмена между пробами fit прекращает перебор', async () => {
    fake.reset();
    const controller = new AbortController();
    let seen = 0;
    await expect(
      image(
        anyBlob(),
        (p) =>
          p.fit(
            { formats: ['image/fake'], quality: [0.8, 0.99] },
            () => false, // никогда не влезает — fit шёл бы до конца сетки
            { strategy: 'owner-loop' },
          ),
        {
          decoder: decoderFor(photoFrame(200, 200)),
          signal: controller.signal,
          state: (e) => {
            if (e.type === 'encode-done') {
              seen += 1;
              if (seen === 3) controller.abort();
            }
          },
        },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fake.encodes).toBe(3); // остановился сразу, не докрутил 20 проб
  });

  it('кодек, вызвавший abort и вернувший Blob, не даёт успешный результат', async () => {
    const controller = new AbortController();
    registerEncoder('image/aborting', {
      async encode() {
        controller.abort();
        return new Blob([new Uint8Array([1])], { type: 'image/aborting' });
      },
    });
    try {
      await expect(
        image(anyBlob(), (p) => p.encode('image/aborting'), {
          decoder: decoderFor(photoFrame(20, 20)),
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      unregisterEncoder('image/aborting');
    }
  });

  it('декодер, вызвавший abort и вернувший кадр, не даёт успешный результат', async () => {
    const controller = new AbortController();
    await expect(
      image(anyBlob(), (p) => p.encode('image/fake'), {
        decoder: async () => {
          controller.abort();
          return photoFrame(20, 20);
        },
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('реестр кодеков', () => {
  it('свой кодек заменяет встроенный тем же registerEncoder', async () => {
    const replacement = makeFakeCodec({ baseAtQ80: 1234 }, 'image/jpeg');
    registerEncoder('image/jpeg', replacement);
    try {
      const out = await image(anyBlob(), (p) => p.encode('image/jpeg', { quality: 0.8 }), {
        decoder: decoderFor(photoFrame(30, 30)),
      });
      expect(replacement.encodes).toBe(1);
      expect(out.type).toBe('image/jpeg');
    } finally {
      // Вернуть встроенный ленивый jpeg: перерегистрируем через свежий импорт нельзя
      // (index уже выполнен), поэтому тест на замену идёт последним в файле и
      // восстанавливает кодек вручную.
      const { jpegCodec } = await import('../src/codecs/jpeg.js');
      registerEncoder('image/jpeg', jpegCodec);
    }
  });
});
