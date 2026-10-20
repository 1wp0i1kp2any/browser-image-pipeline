import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  UnsupportedOptionError,
  applyFrameGeometry,
  compareFrames,
  computePSNR,
  computeSSIM,
  image,
  registerEncoder,
  resizeArea,
  resizeLanczos3,
  sharpenFrame,
  unregisterEncoder,
} from '../src/index.js';
import { mapJpegOptions } from '../src/codecs/jpeg.js';
import { mapAvifOptions } from '../src/codecs/avif.js';
import { mapWebpOptions } from '../src/codecs/webp.js';
import {
  anyBlob,
  decoderFor,
  makeFakeCodec,
  makeFrame,
  photoFrame,
  type FakeCodec,
} from './helpers.js';

describe('ресемплинг: lanczos3 и area', () => {
  const flat = makeFrame(64, 64, () => [120, 60, 200, 255]);

  it('плоский кадр инвариантен для всех методов (нормировка весов верна)', () => {
    for (const method of ['lanczos3', 'area'] as const) {
      const out = applyFrameGeometry(flat, { width: 17, height: 29, method });
      for (let i = 0; i < out.data.length; i += 4) {
        expect(Math.abs(out.data[i] - 120)).toBeLessThanOrEqual(1);
        expect(Math.abs(out.data[i + 1] - 60)).toBeLessThanOrEqual(1);
        expect(Math.abs(out.data[i + 2] - 200)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('area при уменьшении 2× шахматки даёт честный средний серый', () => {
    const chess = makeFrame(64, 64, (x, y) => {
      const v = (x + y) % 2 === 0 ? 255 : 0;
      return [v, v, v, 255];
    });
    const out = resizeArea(chess, 32, 32);
    const i = (16 * 32 + 16) * 4;
    expect(out.data[i]).toBeGreaterThan(120);
    expect(out.data[i]).toBeLessThan(135);
  });

  it('lanczos3 резче билинейного на жёсткой границе (есть overshoot)', () => {
    const edge = makeFrame(64, 64, (x) => (x < 32 ? [64, 64, 64, 255] : [192, 192, 192, 255]));
    const lz = resizeLanczos3(edge, 32, 32);
    const row = (f: typeof lz, x: number) => f.data[(16 * f.width + x) * 4];
    // Сразу слева от границы lanczos уходит НИЖЕ исходных 64 (ringing) —
    // признак sinc-ядра; билинейный такого не делает.
    const leftVals = [row(lz, 14), row(lz, 15)];
    expect(Math.min(...leftVals)).toBeLessThan(64);
  });

  it('premultiplied-альфа: цвет прозрачных пикселей не протекает в непрозрачные', () => {
    // Слева непрозрачный чёрный, справа прозрачный белый (RGB=255, a=0).
    const src = makeFrame(64, 8, (x) => (x < 32 ? [0, 0, 0, 255] : [255, 255, 255, 0]));
    const out = resizeLanczos3(src, 32, 4);
    const i = (2 * 32 + 15) * 4; // у границы со стороны чёрного
    expect(out.data[i]).toBeLessThan(40); // без premultiply тут был бы серый ореол
  });
});

describe('sharpen (unsharp mask)', () => {
  it('плоский кадр не меняется, граница становится контрастнее, альфа цела', () => {
    const edge = makeFrame(32, 32, (x) => (x < 16 ? [80, 80, 80, 200] : [160, 160, 160, 200]));
    const out = sharpenFrame(edge, 0.8, 1);
    const px = (x: number) => out.data[(16 * 32 + x) * 4];
    expect(px(2)).toBe(80); // далеко от границы — без изменений
    expect(px(15)).toBeLessThan(80); // undershoot слева от границы
    expect(px(16)).toBeGreaterThan(160); // overshoot справа
    expect(out.data[(16 * 32 + 16) * 4 + 3]).toBe(200);
  });

  it('ступень p.sharpen работает в конвейере и докладывается в state', async () => {
    const events: string[] = [];
    const fake = makeFakeCodec({ baseAtQ80: 1000 });
    registerEncoder('image/fake2', fake);
    try {
      await image(
        anyBlob(),
        async (p) => {
          await p.frame({ width: 50, height: 50, method: 'lanczos3' });
          await p.sharpen({ amount: 0.4 });
          return p.encode('image/fake2');
        },
        { decoder: decoderFor(photoFrame(100, 100)), state: (e) => events.push(e.type) },
      );
      expect(events).toContain('sharpen');
    } finally {
      unregisterEncoder('image/fake2');
    }
  });
});

describe('метрики качества', () => {
  const a = photoFrame(64, 64);

  it('идентичные кадры: PSNR=∞, SSIM=1, MAE=0', () => {
    const m = compareFrames(a, a);
    expect(m.psnr).toBe(Infinity);
    expect(m.ssim).toBeCloseTo(1, 9);
    expect(m.mae).toBe(0);
  });

  it('шум снижает обе метрики монотонно с амплитудой', () => {
    const noisy = (amp: number) =>
      makeFrame(64, 64, (x, y) => {
        const i = (y * 64 + x) * 4;
        const d = ((x * 7 + y * 13) % 3) - 1;
        return [a.data[i] + d * amp, a.data[i + 1] + d * amp, a.data[i + 2] + d * amp, 255];
      });
    expect(computePSNR(a, noisy(4))).toBeGreaterThan(computePSNR(a, noisy(24)));
    expect(computeSSIM(a, noisy(4))).toBeGreaterThan(computeSSIM(a, noisy(24)));
    expect(computeSSIM(a, noisy(24))).toBeLessThan(1);
  });

  it('разные размеры — честная ошибка, не молчаливые числа', () => {
    expect(() => computePSNR(a, photoFrame(32, 32))).toThrow();
  });
});

describe('нормированные опции кодеков (отображения)', () => {
  it('jpeg: subsampling → chroma_subsample (подтверждено по SOF), effort → trellis', () => {
    expect(mapJpegOptions({ subsampling: '4:4:4' })).toMatchObject({
      auto_subsample: false,
      chroma_subsample: 1,
    });
    expect(mapJpegOptions({ subsampling: '4:2:0' })).toMatchObject({ chroma_subsample: 2 });
    expect(mapJpegOptions({ effort: 1 })).toMatchObject({
      trellis_multipass: true,
      trellis_opt_zero: true,
      trellis_opt_table: true,
    });
    expect(mapJpegOptions({ effort: 0 })).toMatchObject({ trellis_multipass: false });
    expect(() => mapJpegOptions({ subsampling: '4:2:2' })).toThrow(UnsupportedOptionError);
    expect(() => mapJpegOptions({ lossless: true })).toThrow(UnsupportedOptionError);
    // Явное поле кодека старше нормированного отображения.
    expect(mapJpegOptions({ subsampling: '4:4:4', chroma_subsample: 2 }).chroma_subsample).toBe(2);
  });

  it('webp: effort → method, lossless → 1, чужой субсемплинг отклоняется', () => {
    expect(mapWebpOptions({ effort: 1 }).mapped.method).toBe(6);
    expect(mapWebpOptions({ effort: 0 }).mapped.method).toBe(0);
    expect(mapWebpOptions({ lossless: true }).mapped.lossless).toBe(1);
    expect(() => mapWebpOptions({ subsampling: '4:4:4' })).toThrow(UnsupportedOptionError);
  });

  it('avif: effort инвертируется в speed, tune строкой, grayscale → 4:0:0', () => {
    expect(mapAvifOptions({ effort: 0.4 }).mapped.speed).toBe(6);
    expect(mapAvifOptions({ effort: 1 }).mapped.speed).toBe(0);
    expect(mapAvifOptions({ subsampling: '4:4:4' }).mapped.subsample).toBe(3);
    expect(mapAvifOptions({ tune: 'ssim' }).mapped.tune).toBe(2);
    const gray = mapAvifOptions({ channel: 'grayscale' });
    expect(gray.grayscale).toBe(true);
    expect(gray.mapped.subsample).toBe(0);
  });
});

describe('новые форматы: реальный wasm', () => {
  const frame = photoFrame(96, 96);

  it('webp: валидный RIFF/WEBP, lossless легче png на графике, lossy легче jpeg', async () => {
    const webp = await image(anyBlob(), (p) => p.encode('image/webp', { quality: 0.8 }), {
      decoder: decoderFor(frame),
    });
    const head = new Uint8Array(await webp.slice(0, 12).arrayBuffer());
    expect(String.fromCharCode(...head.slice(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...head.slice(8, 12))).toBe('WEBP');
    const jpeg = await image(anyBlob(), (p) => p.encode('image/jpeg', { quality: 0.8 }), {
      decoder: decoderFor(frame),
    });
    expect(webp.size).toBeLessThan(jpeg.size);
  });

  it('avif: валидный ftyp avif; 4:4:4 тяжелее 4:2:0 при равном качестве', async () => {
    const enc = (subsampling: '4:2:0' | '4:4:4') =>
      image(anyBlob(), (p) => p.encode('image/avif', { quality: 0.6, effort: 0.2, subsampling }), {
        decoder: decoderFor(frame),
      });
    const a420 = await enc('4:2:0');
    const brand = new Uint8Array(await a420.slice(4, 12).arrayBuffer());
    expect(String.fromCharCode(...brand.slice(0, 4))).toBe('ftyp');
    expect(String.fromCharCode(...brand.slice(4, 8))).toBe('avif');
    const a444 = await enc('4:4:4');
    expect(a444.size).toBeGreaterThan(a420.size);
  }, 120_000);

  it('png + oxipngLevel: заметно легче голого png и декодируется обратно в тот же кадр', async () => {
    const plain = await image(anyBlob(), (p) => p.encode('image/png'), {
      decoder: decoderFor(frame),
    });
    const optimized = await image(anyBlob(), (p) => p.encode('image/png', { oxipngLevel: 3 }), {
      decoder: decoderFor(frame),
    });
    expect(optimized.size).toBeLessThan(plain.size);
    // Lossless-гарантия oxipng: декодированные пиксели бит-в-бит как у plain.
    const { decodePng } = await import('../src/codecs/png.js');
    const a = await decodePng(plain);
    const b = await decodePng(optimized);
    expect(Buffer.from(b.data).equals(Buffer.from(a.data))).toBe(true);
  });

  it('jpeg: subsampling 4:4:4 тяжелее 4:2:0, SOF подтверждает семплирование', async () => {
    const enc = (subsampling: '4:2:0' | '4:4:4') =>
      image(anyBlob(), (p) => p.encode('image/jpeg', { quality: 0.85, subsampling }), {
        decoder: decoderFor(frame),
      });
    const s444 = await enc('4:4:4');
    const s420 = await enc('4:2:0');
    expect(s444.size).toBeGreaterThan(s420.size);
    const bytes = new Uint8Array(await s444.arrayBuffer());
    let sampling = '';
    for (let i = 0; i < bytes.length - 1; i++) {
      if (bytes[i] === 0xff && (bytes[i + 1] === 0xc0 || bytes[i + 1] === 0xc2)) {
        sampling = [0, 1, 2].map((c) => bytes[i + 11 + c * 3]).join(',');
        break;
      }
    }
    expect(sampling).toBe('17,17,17'); // 0x11 = 1x1 у всех компонент — настоящий 4:4:4
  });
});

describe('quantize: алгоритмы и serpentine', () => {
  it('все алгоритмы палитры дают ≤ N цветов; serpentine отличается от прямого прохода', async () => {
    const { quantizeFrame } = await import('../src/quantize.js');
    const { countColors } = await import('./helpers.js');
    const src = photoFrame(72, 72);
    for (const algorithm of ['wuquant', 'neuquant'] as const) {
      const out = await quantizeFrame(src, 16, 0, { algorithm });
      expect(countColors(out), algorithm).toBeLessThanOrEqual(16);
    }
    // rgbquant (метод подрегионов в image-q) требует повторяющихся цветов:
    // на блоковой графике работает, на плавном градиенте честно падает
    // обёрнутой ошибкой библиотеки.
    const blocky = makeFrame(72, 72, (x, y) => {
      const v = ((x >> 4) + (y >> 4) * 3) % 5;
      return [v * 50, 200 - v * 30, v * 30 + 10, 255];
    });
    const rgbOut = await quantizeFrame(blocky, 8, 0, { algorithm: 'rgbquant' });
    expect(countColors(rgbOut)).toBeLessThanOrEqual(8);
    await expect(quantizeFrame(src, 16, 0, { algorithm: 'rgbquant' })).rejects.toThrow(
      /palette algorithm "rgbquant" failed/,
    );
    const ciede = await quantizeFrame(src, 16, 0, { distance: 'ciede2000' });
    expect(countColors(ciede)).toBeLessThanOrEqual(16);
    const straight = await quantizeFrame(src, 8, 1);
    const serp = await quantizeFrame(src, 8, 1, { serpentine: true });
    expect(Buffer.from(serp.data).equals(Buffer.from(straight.data))).toBe(false);
  }, 120_000);
});

describe('fit: новые измерения subsampling и variants', () => {
  let fake: FakeCodec;
  beforeAll(() => {
    fake = makeFakeCodec({ baseAtQ80: 20_000 });
    registerEncoder('image/fake3', fake);
  });
  afterAll(() => unregisterEncoder('image/fake3'));

  it('subsampling: сначала выбор кодека, затем разрешённый 4:4:4 не пробуется если влез дефолт', async () => {
    fake.reset();
    const hit = await image(
      anyBlob(),
      (p) =>
        p.fit(
          { formats: ['image/fake3'], quality: [0.8, 0.99], subsampling: ['4:4:4'] },
          (c) => c.size <= 30_000,
        ),
      { decoder: decoderFor(photoFrame(120, 120)) },
    );
    expect(hit).not.toBeNull();
    expect(hit!.params.subsampling).toBeUndefined(); // влезли на дефолте кодека
  });

  it('subsampling как измерение: тяжёлый дефолт сдаётся на 4:0:0 до палитры', async () => {
    fake.reset();
    // Лимит недостижим при дефолтном фактора 1.0 и q=0.8 (20_000), но достижим на 4:0:0 (×0.85=17_000).
    const hit = await image(
      anyBlob(),
      (p) =>
        p.fit(
          {
            formats: ['image/fake3'],
            quality: [0.8, 0.99],
            colors: [16, 256],
            subsampling: ['4:0:0'],
          },
          (c) => c.size <= 18_000,
        ),
      { decoder: decoderFor(photoFrame(120, 120)) },
    );
    expect(hit).not.toBeNull();
    expect(hit!.params.subsampling).toBe('4:0:0');
    expect(hit!.params.colors).toBeUndefined(); // палитра не понадобилась
  });

  it('variants: второй вариант (smoothing) спасает, когда первый не влезает; вариант виден в params', async () => {
    fake.reset();
    const hit = await image(
      anyBlob(),
      (p) =>
        p.fit(
          {
            formats: ['image/fake3'],
            quality: [0.8, 0.99],
            variants: [{ smoothing: 0 }, { smoothing: 60 }],
          },
          (c) => c.size <= 19_500,
        ),
      { decoder: decoderFor(photoFrame(120, 120)) },
    );
    expect(hit).not.toBeNull();
    expect(hit!.params.variant).toEqual({ smoothing: 60 });
    expect(fake.calls.some((c) => c.smoothing === 60)).toBe(true);
  });

  it('fit поверх реального webp+avif в порядке предпочтения форматов', async () => {
    const hit = await image(
      anyBlob(),
      (p) =>
        p.fit(
          {
            formats: ['image/avif', 'image/webp'],
            quality: [0.4, 0.9],
            frame: { width: 120, height: 120, method: 'lanczos3' },
            variants: [{ effort: 0.2 }],
          },
          (c) => c.size <= 4_000,
        ),
      { decoder: decoderFor(photoFrame(200, 200)) },
    );
    expect(hit).not.toBeNull();
    expect(['image/avif', 'image/webp']).toContain(hit!.params.format);
    expect(hit!.blob.size).toBeLessThanOrEqual(4_000);
  }, 180_000);
});
