# Автоматические профили: клиент (3–5 с) и сервер (≤0,5 с)

Оба профиля — «без крутилок»: пользователь ничего не настраивает, все
решения (формат, качество, геометрия, палитра, обесцвечивание) принимает
код вызова по фиксированному сценарию и свойствам самого кадра. Это
рецепты на стороне приложения поверх публичного API библиотеки; сама
библиотека по-прежнему не знает ни лимитов веса (их задаёт ваш предикат
`fits(candidate)`), ни ваших целевых размеров.

Цифры времени — замер `scripts/benchmark-server-profile.ts` на Xeon
2.6 GHz (2 ядра), детерминированный шумный «фото»-кадр 3000×2000 — это
пессимистичный по энтропии вход; реальные фото обычно легче. На своём
железе скрипт стоит прогнать ещё раз и подправить константы бюджетов.

## Что вообще влияет на итоговый вес в автоматике

В режиме `p.fit(...)` вес результата задаёт **ваш предикат**, а не
обработка: поиск возвращает самое качественное, что влезает под порог.
Обработка влияет на *качество при этом весе* и на *время поиска*. Вес
напрямую рычаги двигают только вне fit (одиночный `encode` с фиксированным
качеством — серверный профиль ниже) и косвенно — через достижимость
порога (влезет ли вообще при `quality[0]`).

Замерено на шумном кадре 1280×853, q=0.8, одиночный encode:

| Рычаг | Эффект на вес | Комментарий |
|---|---|---|
| Геометрия (сторона кадра) | квадратично, главный рычаг | 2048→1280 px — это ≈ ×0.4 пикселей |
| Формат при равном качестве | AVIF < WebP < JPEG | на фото WebP/JPEG при q0.8 близки; решает время энкода |
| Субсемплинг 4:2:0 против 4:4:4 | −19% (147→119 KiB) | на фото потеря почти незаметна, на цветном тексте — видна |
| Sharpen 0.5 после даунскейла | **+30%** (196→255 KiB WebP, 134→175 KiB JPEG) | шарп = высокочастотный сигнал = байты; в fit компенсируется снижением quality |
| MozJPEG `smoothing` 10/25 | −6% / −11% на шуме | давит шум сенсора ценой мелкой текстуры; есть в пресете `maxCompression` |
| WebP `sns_strength` 100 | +19% на шуме | сохраняет текстуру/шум — для веса держать низким/по умолчанию |
| Палитра (PNG/WebP-lossless) | решает для графики, бесполезна для фото | fit сам дойдёт до палитровых плоскостей, если разрешите `colors` |
| Grayscale для почти-монохрома | сильно легче + чище | fit определяет монохромность сам (проба насыщенности), если разрешён канал |

Из внешних идей прошлого исследования на вес в автоматике **не влияют**
(влияют на качество при том же весе или на время): линейный
(gamma-correct) ресайз, ядро Hamming против Lanczos3, порог unsharp,
k-means уточнение палитры, fixed-point арифметика. Поэтому в профили
ниже они не включены.

## Клиентский профиль (браузер, бюджет 3–5 с, приоритет — качество)

Идея: один богатый `fit`-spec описывает всё пространство автоматических
решений в порядке визуальной цены — формат → вариант пресета → канал
(grayscale только как сдача, но с приоритетом для почти-монохромных
кадров) → палитра (сдача для графики). Стратегия `binary` находит ту же
точку, что полный перебор, за ~6–8 проб на плоскость. `deadlineMs`
честно ограничивает поиск; если бюджет исчерпан или порог недостижим —
лесенка потолков геометрии, а не зависание.

```ts
import { image, PRESETS, type FitResult } from 'browser-image-pipeline';

const TARGET_BYTES = 300 * 1024; // ваш порог; библиотека о нём не знает

export async function processPhotoClient(file: Blob): Promise<Blob> {
  for (const maxSide of [2048, 1600, 1280]) {
    const hit = await runClientPass(file, maxSide);
    if (hit) return hit.blob;
  }
  // Последняя линия обороны: один энкод без поиска — быстро и предсказуемо,
  // вес как получится (обычно заметно ниже порога на 1280 px).
  return image(file, async (p) => {
    await p.frame({ width: 1280, height: 1280, fit: 'contain', method: 'bilinear' });
    return p.encode('image/jpeg', { quality: 0.72, effort: 0.17 });
  });
}

async function runClientPass(file: Blob, maxSide: number): Promise<FitResult | null> {
  let srcW = 0;
  let srcH = 0;
  return image(
    file,
    async (p) => {
      // Потолок стороны без апскейла: размеры источника — из decode-done.
      const scale = Math.min(1, maxSide / Math.max(srcW, srcH));
      const downscaled = scale < 1;
      await p.frame({
        width: Math.max(1, Math.round(srcW * scale)),
        height: Math.max(1, Math.round(srcH * scale)),
        fit: 'contain',
        method: 'lanczos3',
      });
      // Лёгкий output-sharpening только если реально уменьшали (+вес
      // fit скомпенсирует качеством ниже на ~сотые).
      if (downscaled) await p.sharpen({ amount: 0.3, radius: 1 });

      return p.fit(
        {
          // AVIF первым — только для малых потолков: одна его проба на
          // 1280 px ≈ 1 с даже тёплая (замер ниже). Для 2048 — WebP→JPEG.
          formats:
            maxSide <= 1280
              ? ['image/avif', 'image/webp', 'image/jpeg']
              : ['image/webp', 'image/jpeg'],
          quality: [0.5, 0.92],
          // Один слитый вариант пресетов: ключи формато-специфичны,
          // чужие поля кодеки игнорируют; effort общий (WebP method 4,
          // MozJPEG — trellis включён порогами ≥0.34).
          variants: [
            {
              ...PRESETS['image/webp']?.photo,
              ...PRESETS['image/avif']?.photo,
              ...PRESETS['image/jpeg']?.photo,
            },
          ],
          // Потеря цвета — только как сдача; для почти-монохрома fit
          // сам поднимет grayscale раньше (проба насыщенности внутри).
          channels: ['grayscale'],
          // Палитра — последняя сдача, для графики/скриншотов в фото-трубе.
          colors: [16, 256],
        },
        (candidate) => candidate.size <= TARGET_BYTES,
        {
          strategy: 'binary',
          maxAttempts: 32,
          deadlineMs: 4500,
          onBudgetExhausted: 'return-null', // дальше сработает лесенка потолков
        },
      );
    },
    {
      state: (e) => {
        if (e.type === 'decode-done') {
          srcW = e.width;
          srcH = e.height;
        }
      },
    },
  );
}
```

Честные оговорки по замеру (Node-прокси на Xeon 2.6; в браузере декод
нативный и быстрее, энкоды того же порядка):

- Прогон «2048 px, WebP method 4, очень шумный кадр, цель 300 KiB» занял
  5.7 с и вернул null по дедлайну — порог на таком входе достижим только
  у пола качества. Именно поэтому лесенка потолков и `return-null`
  обязательны: на 1600/1280 тот же вход находится за единицы проб.
- Одна проба AVIF 1280×853 q0.6 ≈ 1.0 с тёплая (первая 1.4–1.5 с).
  Полный поиск по AVIF-плоскости — 6–8 проб, т.е. весь клиентский бюджет
  на слабом устройстве. AVIF в профиле оправдан только для малых
  итоговых размеров (превью/аватары) или когда 3–5 с — мягкий бюджет.
- `deadlineMs` проверяется между пробами: уже запущенный wasm-энкод не
  прерывается. Худший перерасход — одна проба сверх дедлайна.

## Серверный профиль (Node, ≤0,5 с худший случай, приоритет — время)

Вывод замера жёсткий: **полноценный fit в 0,5 с на старом Xeon не
помещается** — одна проба MozJPEG 1600 px с trellis по умолчанию ≈
250 мс, декод 12 MP силами wasm ≈ 220 мс. Серверный сценарий поэтому не
ищет, а делает **один (максимум два) энкода с фиксированными
параметрами**, где вес управляется геометрией и калиброванным качеством.
Гарантии «ровно под порог» нет — есть гарантия времени и предсказуемый
вес; одна корректирующая проба по фактическому размеру возвращает
большую часть точности fit за +50 мс.

Бюджетная арифметика худшего случая (замер, Xeon 2.6):

| Этап | 6 MP вход | 12 MP вход |
|---|---:|---:|
| decode JPEG (wasm MozJPEG) | ~85 мс | ~220 мс |
| resize bilinear → 1280 px | ~30 мс | ~50 мс |
| encode WebP method 1 q0.8 | ~50 мс | ~50 мс |
| корректирующая проба WebP | +50 мс | +50 мс |
| **Итого** | **~215 мс** | **~370 мс** |

JPEG на выходе вместо WebP: один энкод 1280 px с выключенным trellis
(`effort: 0.17`) ≈ 210–220 мс — бюджет съедается целиком уже на 6 MP,
на 12 MP — перерасход. Если JPEG обязателен: потолок 1024 px и без
корректирующей пробы (≈120 мс энкод), либо честно признать бюджет 0,7 с.

### Подготовка процесса (один раз при старте)

Библиотека браузерная; на сервере приложение обязано: (1) пред-
инициализировать wasm-кодеки байтами с диска — `@jsquash/*` по умолчанию
грузят `.wasm` через `fetch(file://)`, Node так не умеет; (2) дать
декодер через шов `options.decoder` или декодировать кодеком реестра
напрямую. Init всех кодеков ≈ 150 мс и делается один раз; процесс —
долгоживущий воркер, не «холодный старт на запрос».

```ts
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const wasm = async (spec: string) => (await readFile(require.resolve(spec))).buffer as ArrayBuffer;

export async function initServerCodecs(): Promise<void> {
  const jpegEnc = await import('@jsquash/jpeg/encode');
  await jpegEnc.init({ wasmBinary: await wasm('@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm') });
  const jpegDec = await import('@jsquash/jpeg/decode');
  await jpegDec.init({ wasmBinary: await wasm('@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm') });
  const webpEnc = await import('@jsquash/webp/encode');
  await webpEnc.init({ wasmBinary: await wasm('@jsquash/webp/codec/enc/webp_enc_simd.wasm') });
  const webpDec = await import('@jsquash/webp/decode');
  await webpDec.init({ wasmBinary: await wasm('@jsquash/webp/codec/dec/webp_dec.wasm') });
  const pngDec = await import('@jsquash/png/decode');
  await pngDec.init(new Uint8Array(await readFile(require.resolve('@jsquash/png/codec/pkg/squoosh_png_bg.wasm'))));
}
```

### Обработка одного фото

Тип входа определяйте по магическим байтам, а не по заявленному
Content-Type. Серверный путь работает на уровне «кодек + утилиты кадра»
мимо конвейера: так нет ни повторного декода, ни лишних копий кадра.

```ts
import { getEncoder, resizeBilinear, type Frame } from 'browser-image-pipeline';

const MAX_SIDE = 1280;
const TARGET_BYTES = 200 * 1024;
const MAX_INPUT_PIXELS = 40_000_000; // защита от декомпрессионных бомб

function sniffFormat(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50)
    return 'image/webp'; // 'WEBP' в RIFF-заголовке
  return null;
}

export async function processPhotoServer(bytes: Uint8Array): Promise<Blob> {
  const format = sniffFormat(bytes);
  if (!format) throw new Error('unsupported input format');
  const decoder = getEncoder(format).decode;
  if (!decoder) throw new Error(`no decoder for ${format}`);

  const decoded: Frame = await decoder(new Blob([bytes as BlobPart], { type: format }));
  if (decoded.width * decoded.height > MAX_INPUT_PIXELS) {
    throw new Error('input exceeds pixel limit');
  }
  // ВНИМАНИЕ: wasm-декодеры НЕ применяют EXIF-ориентацию (браузерный путь
  // применяет). Поворот по тегу Orientation — обязанность серверного
  // приложения, см. helper ниже; без него телефонные фото лягут набок.
  const oriented = orientFrame(decoded, readExifOrientation(bytes));

  const scale = Math.min(1, MAX_SIDE / Math.max(oriented.width, oriented.height));
  const frame =
    scale < 1
      ? resizeBilinear(
          oriented,
          Math.max(1, Math.round(oriented.width * scale)),
          Math.max(1, Math.round(oriented.height * scale)),
        )
      : oriented;

  const webp = getEncoder('image/webp');
  let quality = 0.8;
  let blob = await webp.encode(frame, { quality, effort: 0.17 /* method 1 */ });
  if (blob.size > TARGET_BYTES) {
    // Одна корректирующая проба: степенная модель размер(quality).
    quality = Math.max(0.3, Math.min(0.95, quality * Math.pow(TARGET_BYTES / blob.size, 0.7)));
    blob = await webp.encode(frame, { quality, effort: 0.17 });
  }
  return blob;
}
```

Поворот по EXIF (значения 3/6/8 покрывают подавляющее большинство
телефонных фото; зеркальные 2/4/5/7 — фронтальные камеры — при
необходимости добавляются той же таблицей отображений; покрыть тестом
на реальных фикстурах перед продакшеном). Чтение самого тега
Orientation из JPEG APP1 — ~30 строк парсера на стороне приложения или
любая крошечная exif-библиотека приложения (не библиотеки конвейера).

```ts
function orientFrame(frame: Frame, orientation: number): Frame {
  if (orientation !== 3 && orientation !== 6 && orientation !== 8) return frame;
  const { width: w, height: h, data: src } = frame;
  const swap = orientation !== 3;
  const outW = swap ? h : w;
  const outH = swap ? w : h;
  const out = new Uint8ClampedArray(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = orientation === 3 ? w - 1 - x : orientation === 6 ? h - 1 - y : y;
      const dy = orientation === 3 ? h - 1 - y : orientation === 6 ? x : w - 1 - x;
      const s = (y * w + x) * 4;
      const d = (dy * outW + dx) * 4;
      out[d] = src[s];
      out[d + 1] = src[s + 1];
      out[d + 2] = src[s + 2];
      out[d + 3] = src[s + 3];
    }
  }
  return { data: out, width: outW, height: outH };
}
```

### Эксплуатация на сервере

- **Пул воркеров по числу ядер, очередь с отказом.** wasm-энкод —
  синхронный CPU-bound один поток на процесс: конкурентные запросы в
  одном процессе не параллелятся, а делят ядро и срывают бюджет друг
  другу. Один процесс — одна обработка, дальше очередь/503.
- **Жёсткий потолок входа до декода**: размер файла и, сразу после
  декода, `width*height` (в конвейерном пути для этого есть
  `ImageOptions.maxPixels/maxDimension`; на кодек-уровне — проверка
  выше). Декод — самая дорогая и неконтролируемая часть худшего случая.
- **AbortSignal не прерывает уже идущий wasm-энкод** — только шаги
  между этапами. Поэтому худший случай ограничивается геометрией
  (потолок стороны), а не таймером: при 1280 px самый дорогой одиночный
  шаг — декод 12 MP ≈ 220 мс.
- **Если fit на сервере всё же нужен** (гарантия веса важнее гарантии
  времени): потолок 1280, только WebP `effort: 0.17`, `strategy:
  'secant'`, `maxAttempts: 7–8`, `deadlineMs: ~300`,
  `onBudgetExhausted: 'return-null'` + одношаблонный фолбэк выше.
  Замер: 4 проб не хватает, чтобы стратегия успела вернуть точку
  (бюджет исчерпывается раньше — возвращается null, даже если влезшая
  проба уже была); 7–8 проб ≈ 350 мс только fit, плюс декод — на 12 MP
  суммарно за пределами 0,5 с.
- **Чего на сервере не делать**: AVIF (≈1 с одна проба 1280 px),
  Lanczos3 (+250–350 мс к прогону против bilinear на 6 MP), шарп
  (время + ~30% веса), палитра image-q на фото (построение палитры
  800×600 ≈ 160 мс даже fast-алгоритмом), oxipng (уровни ≥3 — секунды).

## Сводная таблица замеров (Xeon 2.6 GHz, Node 20, шумный кадр)

| Операция | Время |
|---|---:|
| init всех wasm при старте процесса | ~155 мс один раз |
| decode JPEG 3000×2000 / 4032×3024 | ~85 / ~220 мс |
| encode JPEG 1600×1067 q0.8, умолчания (trellis вкл) | ~250 мс |
| encode JPEG 1280×853 q0.8, `effort: 0.17` (trellis выкл) | ~210 мс |
| encode WebP 1600×1067 q0.8, method 1 / method 4 | ~75 / ~230 мс |
| encode WebP 1280×853 q0.8, method 1 | ~50 мс |
| encode AVIF 1280×853 q0.6, тёплый | ~1000 мс |
| resize bilinear 3000×2000→1280×853 | ~30 мс |
| fit целиком, серверная попытка (1600 px, JPEG, 6 проб, дедлайн 400) | 680–1100 мс, null |
| fit целиком, клиентская попытка (2048 px, WebP m4, дедлайн 4500) | 5700 мс, null на этом входе |

Полный протокол — вывод `scripts/benchmark-server-profile.ts`.

## Границы сценария

- Целевые числа в примерах (300 KiB клиент / 200 KiB сервер, потолки
  2048/1280) — placeholders: подставляются продуктовые значения,
  структура сценариев от них не меняется.
- Графика/скриншоты с альфой клиентским фото-профилем обрабатываются
  приемлемо (fit дойдёт до палитры), но отдельный графический сценарий
  (PNG + oxipng / WebP lossless, `optimizePngBlob`) даст лучше; сюда не
  включён сознательно — фото-профиль не должен тащить oxipng-wasm.
- Серверный профиль отдаёт WebP. Если потребителю результата нужен
  именно JPEG, см. оговорку про бюджет выше.

