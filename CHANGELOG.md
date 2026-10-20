# Changelog

## 0.7.0 — заголовочная проба `./probe` для серверного приёма фото

Аддитивно; существующий API и результаты не изменились.

- Новый subpath `browser-image-pipeline/probe`: `probeImageHeader(bytes)`
  строго разбирает JPEG/PNG/WebP/AVIF по заголовкам без декодирования —
  формат по структуре контейнера, ширина/высота, EXIF-ориентация и первый
  COM-комментарий JPEG, progressive, альфа по декларации. Только факты,
  без политики: лимиты байт/пикселей/сторон — решение вызывающего, как
  предикат у fit. Архив/текст/переименованный мусор дают null;
  декомпрессионная бомба видна по width*height до дорогого декода.
  Ноль зависимостей и DOM/wasm: одинаково работает в браузере, Node,
  Vercel и Cloudflare Workers. 3.9 KiB raw / 1.7 KiB gzip (бюджет 2 KiB).
- Назначение — серверный fallback приёма фото (no-JS): валидация до
  декода + принятие уже ужатого клиентом фото как есть по дешёвой
  проверке рамок, без второго перекодирования. Готовый сценарий под
  modals-kit (SvelteKit, ветка upgrade/kit3) — в его репозитории:
  `src/lib/server/photo.ts` + валидатор формы `check('photo')`.
- В exports добавлен `./package.json` (потребителям нужен резолв
  wasm-ассетов @jsquash от пакета библиотеки).

## 0.6.1 — исследовательская оптимизация горячих путей и полная JSDoc-документация

Публичный API и результаты не изменились: все оптимизации побитово
эквивалентны 0.6.0 (хэши research-бенчмарка совпали на каждом кейсе).

- Resize: оси separable-ресемплинга упаковываются в единый contiguous-план
  весов (идея pica), деление на альфу заменено таблицей обратных значений,
  bilinear предвычисляет горизонтальные пары. Lanczos-upscale ≈ −8%,
  bilinear ≈ −20%, sharpen (построчный premultiplied box blur) ≈ −28%.
- Квантование: точное применение палитры ищет ближайший цвет VP-деревом
  (подход libimagequant) — ≈ −44…−50% без дизеринга; путь с дизерингом
  замером оставлен на прежнем линейном поиске (дерево на diffused-пикселях
  деградирует). Построение fast-палитры ≈ −50% за счёт кэшируемых
  статистик боксов median-cut. Точный кэш nearest ограничен 65536 записями.
- Метрики и анализ: SSIM переиспользует luma-буферы блока (−15%),
  analyzeFrame отмечает корзины цветов битовой картой вместо Set (−61%).
- Кодеки получают ImageData без копии пикселей (wasm всё равно копирует
  вход в свою heap); публичный frameToImageData копию сохраняет.
- JSDoc: документированы все функции и параметры публичного и внутреннего
  API (`@param`/`@returns`/`@throws`) — подсказки IDE видны и в издаваемых
  `.d.ts` потребителя.
- Веса: pipeline-core 10.8 KiB gzip (бюджет 11), root-all-exports 13.0 KiB
  (бюджет 13; рост против 12.5 KiB в 0.6.0 — код оптимизаций при том же API).
  Добавлен детерминированный `scripts/benchmark-research.ts`
  (`benchmark-results/research-{before,after}.json`).

## 0.6.0 — закрытие хвостов production-hardening и быстрая очистка

- Добавлен отдельный ленивый PNG optimizer `engine:'compression-stream'` без wasm: пережимает только `IDAT`, сохраняет остальные PNG-чанки байт-в-байт, проверяет CRC и повторно распаковывает результат для байтовой верификации. В `PngOptimizeOptions` добавлены `engine`/`signal`, в результат — необязательный `engine`.
- Добавлены `bench:profile` и `bench:browser`: cold/warm по форматам, общий Node/браузерный corpus стратегий, peak-память, профиль кэша палитр и JSON-артефакты.
- Browser-fixtures покрывают EXIF 1–8, sRGB ICC в PNG/JPEG/WebP, grayscale/palette/interlaced PNG, прозрачность и первый кадр GIF/APNG/WebP. Фактически прогнаны Chromium, Firefox и Playwright WebKit; Playwright обновлён до 1.64.
- Релизная сборка теперь минифицируется. Pipeline-core для consumer с импортом только `image()` — 10.3 KiB gzip при CI-бюджете 11 KiB; полный root со всеми утилитами — 12.5 KiB при бюджете 13 KiB.
- Быстрая очистка без изменения публичного API: единые декларации кодеков, фабрика ленивых кодеков, общий binary-refine стратегий, общий PNG chunk-parser и удаление внутренних дублей/лишних экспортов.

## 0.5.0 — фаза 4 + production-hardening

- Добавлены `analyzeFrame`, alpha-метрики и abort-проверки метрик.
- Добавлен opt-in быстрый квантователь `fast-median-cut`; `wuquant` остаётся умолчанием.
- Добавлен `optimizePngBlob` поверх oxipng с политикой сохранения цветовых PNG-чанков и принятием только меньшего результата по умолчанию.
- Собран детерминированный benchmark-корпус. Прототип SizeModel не прошёл критерий против `secant` и в библиотеку не включён.
- Добавлены property/equivalence/stress-тесты, жёсткий browser-smoke для Chromium/Firefox, EXIF-fixtures 1–8, consumer-smoke установленного tarball, bundle-budget и GitHub Actions CI.

## 0.4.0 — фаза 3, расширяемость

- Внутренние дескрипторы плоскостей `fixed | categorical | frame-transform` и golden-порядок поиска.
- Именованные категориальные `spec.dimensions` с возвратом `params.dimensions`.
- Пользовательские стратегии качества функцией/объектом и harness в subpath `./testing`.
- Изолированные реестры кодеков: `createEncoderRegistry`, `defaultEncoderRegistry`, `ImageOptions.registry`.
- Отдельный state-collector в subpath `./state`.

## 0.3.0 — фаза 2, безопасный fit

- Capabilities качества кодеков, одна проба для PNG/lossless-плоскостей и `qualityStep`.
- Бюджет `maxAttempts`, `deadlineMs`, `FitBudgetExhaustedError`, события `fit-start`/`fit-exhausted` и warnings.
- Явная монотонность, ресурсные лимиты, ленивые плоскости и abort-проверки длинных циклов.

## 0.2.1 — фазы 0–1, корректность

- Исправлены точный area-resampling, premultiplied-альфа bilinear/sharpen, границы сетки качества и точный RGBA-кэш nearest в палитре.
- Публичный API не менялся.

## 0.2.0 — расширение форматов и измерений

- WebP, AVIF, oxipng, Lanczos3/area, sharpen, метрики, пресеты, subsampling и variants в fit.

## 0.1.0 — первая версия

- Браузерный конвейер frame → quantize → encode, реестр кодеков и fit по предикату `fits(candidate)` со стратегиями owner-loop/binary/secant/coarse-fine.
