// Стартовые пресеты энкодеров по итогам исследования оптимизаторов
// (Squoosh/MozJPEG/libwebp/libaom/oxipng). Это НЕ умолчания библиотеки —
// умолчания остаются у кодеков (@jsquash defaults уже сильные: MozJPEG с
// progressive+оптимизацией Хаффмана и таблицей Robidoux из коробки).
// Пресет — набор EncodeOptions БЕЗ quality: качество и вес по-прежнему
// принадлежат вызывающему. Применение: p.encode(fmt, {...PRESETS[fmt].photo, quality}).

import type { EncodeOptions } from './types.js';

/** Имена стартовых сценариев пресетов энкодеров. */
export type PresetName = 'photo' | 'screen' | 'maxCompression' | 'lossless' | 'nearLossless';

const jpegTrellis: EncodeOptions = {
  progressive: true,
  optimize_coding: true,
  quant_table: 3, // ImageMagick/Robidoux — баланс веса и восприятия
  trellis_multipass: true,
  trellis_opt_table: true,
};

/**
 * Стартовые пресеты EncodeOptions по форматам и сценариям.
 *
 * Quality пресеты НЕ содержат: качество и допустимый вес принадлежат
 * вызывающему. Применение: p.encode(fmt, { ...PRESETS[fmt].photo, quality }).
 */
export const PRESETS: Record<string, Partial<Record<PresetName, EncodeOptions>>> = {
  'image/jpeg': {
    // Фото для веба: полный trellis поверх и так хороших умолчаний Squoosh-сборки.
    photo: {
      ...jpegTrellis,
      trellis_opt_zero: true,
      auto_subsample: true, // MozJPEG сам решает 4:4:4 vs 4:2:0 по качеству
    },
    // Скриншоты/графика/текст: цветные края важнее веса — 4:4:4, без сглаживания.
    screen: {
      ...jpegTrellis,
      subsampling: '4:4:4',
      smoothing: 0,
    },
    // Максимальное сжатие: таблица под MS-SSIM, 4:2:0, лёгкое сглаживание шума.
    maxCompression: {
      ...jpegTrellis,
      quant_table: 2, // tuned for MS-SSIM
      subsampling: '4:2:0',
      smoothing: 10, // шум/дизеринг исходника — дорогие байты без пользы
      trellis_opt_zero: true,
      trellis_loops: 3,
    },
  },
  'image/webp': {
    photo: {
      effort: 0.66, // method 4 — рекомендация Squoosh по умолчанию
      use_sharp_yuv: 1, // точнее RGB→YUV на цветных краях
      autofilter: 1,
    },
    screen: {
      effort: 0.83, // method 5
      use_sharp_yuv: 1,
      sns_strength: 0, // не сглаживать пространственный шум — текст важнее
      filter_sharpness: 5,
    },
    lossless: {
      lossless: true,
      effort: 1, // method 6
      near_lossless: 100,
    },
    // Пресета nearLossless НЕТ сознательно: поле near_lossless у текущей
    // сборки @jsquash/webp игнорируется (проверено замером: размеры при
    // 0/60/100 идентичны). Рабочий «почти без потерь» путь в этой библиотеке —
    // p.quantize({colors: 256}) + lossless webp.
  },
  'image/avif': {
    photo: {
      effort: 0.4, // speed 6 — умолчание Squoosh; медленнее заметно дороже по времени
      tune: 'ssim',
      subsampling: '4:2:0',
      enableSharpYUV: true,
    },
    screen: {
      effort: 0.4,
      tune: 'ssim',
      subsampling: '4:4:4', // цветной текст без растекания
      enableSharpYUV: true,
      denoiseLevel: 0,
    },
    maxCompression: {
      effort: 0.8, // speed 2
      tune: 'ssim',
      subsampling: '4:2:0',
      chromaDeltaQ: true, // отдельное, более жёсткое квантование цветности
    },
    lossless: {
      lossless: true,
      effort: 0.6,
      subsampling: '4:4:4',
    },
  },
  'image/png': {
    // PNG из rust-png в @jsquash/png сжимается слабо; oxipng-постпроход —
    // главный рычаг веса у PNG после палитры.
    photo: { oxipngLevel: 3 },
    screen: { oxipngLevel: 4, oxipng: { optimiseAlpha: true } },
    maxCompression: { oxipngLevel: 6, oxipng: { optimiseAlpha: true } },
    lossless: { oxipngLevel: 3 },
  },
};
