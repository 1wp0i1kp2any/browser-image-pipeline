# Changelog

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
