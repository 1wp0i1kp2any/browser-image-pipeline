// Живой стенд библиотеки: vanilla DOM, без фреймворков.
// Всё, что делает страница, — вызовы публичного API библиотеки
// (image + ступени + fit + state + AbortSignal + метрики), как в README.

import { applyFrameGeometry, compareFrames, image } from '../src/index.js';
import type {
  ChromaSubsampling,
  ColorDistanceFormula,
  EncodeOptions,
  FitResult,
  FitSpec,
  FitStrategyName,
  Frame,
  FrameOptions,
  PaletteAlgorithm,
  PipelineEvent,
  ResizeMethod,
} from '../src/index.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;
const input = (id: string) => $<HTMLInputElement>(id);
const select = (id: string) => $<HTMLSelectElement>(id);
const num = (id: string) => Number(input(id).value);
const checked = (id: string) => input(id).checked;

const fmtSize = (n: number): string =>
  n >= 1024 ? `${(n / 1024).toFixed(2)} КиБ (${n} B)` : `${n} B`;

let source: Blob | null = null;
let controller: AbortController | null = null;
let beforeUrl = '';
let afterUrl = '';

function setBusy(busy: boolean, text?: string): void {
  document.body.classList.toggle('busy', busy);
  $<HTMLButtonElement>('cancel-btn').disabled = !busy;
  if (text) $('status-text').textContent = text;
}

function setError(err: unknown): void {
  $('error').textContent = err ? `Ошибка: ${err instanceof Error ? err.message : String(err)}` : '';
}

function showAfter(blob: Blob, caption: string): void {
  if (afterUrl) URL.revokeObjectURL(afterUrl);
  afterUrl = URL.createObjectURL(blob);
  $<HTMLImageElement>('after-img').src = afterUrl;
  $('after-caption').textContent = caption;
}

// --- События состояния библиотеки --------------------------------------------

function onEvent(event: PipelineEvent): void {
  const status = $('status-text');
  switch (event.type) {
    case 'decode-start':
      status.textContent = 'Декодирование…';
      break;
    case 'decode-done':
      status.textContent = `Декодировано: ${event.width}×${event.height}`;
      break;
    case 'frame':
      status.textContent = `Кадр ${event.fit} (${event.method}): ${event.width}×${event.height}`;
      break;
    case 'sharpen':
      status.textContent = `Sharpen: amount ${event.amount}, radius ${event.radius}`;
      break;
    case 'quantize':
      status.textContent = `Квантование: ${event.colors} цветов, дизеринг ${event.dithering}`;
      break;
    case 'probe':
      status.textContent =
        `Проба насыщенности: ${event.saturation.toFixed(3)}` +
        (event.monochrome ? ' — почти монохром, grayscale поднимется в переборе' : '');
      break;
    case 'encode':
      status.textContent = event.attempt
        ? `Попытка #${event.attempt}: ${event.format}, q=${event.quality?.toFixed(2)}` +
          (event.colors ? `, цветов ${event.colors}` : '') +
          (event.channel ? `, канал ${event.channel}` : '') +
          (event.subsampling ? `, ${event.subsampling}` : '') +
          '…'
        : `Кодирование ${event.format}…`;
      break;
    case 'encode-done': {
      status.textContent = `Готово: ${event.format}, ${fmtSize(event.size)}`;
      if (event.attempt) addAttemptRow(event);
      break;
    }
    case 'fit-done':
      status.textContent = event.hit
        ? `Подбор попал за ${event.attempts} проб`
        : `Подбор не влез даже на полу (${event.attempts} проб) — null`;
      break;
    case 'done':
      status.textContent = 'Готово.';
      break;
    case 'error':
      status.textContent = 'Ошибка или отмена.';
      break;
  }
}

function addAttemptRow(event: Extract<PipelineEvent, { type: 'encode-done' }>): void {
  const box = $('attempts');
  if (event.attempt === 1) box.textContent = '';
  const div = document.createElement('div');
  div.className = event.fits ? 'ok' : 'bad';
  div.textContent =
    `#${event.attempt} ${event.format} q=${event.quality?.toFixed(2)}` +
    (event.colors ? ` цвета=${event.colors}` : ' цвета=—') +
    (event.channel ? ` канал=${event.channel}` : '') +
    (event.subsampling ? ` ${event.subsampling}` : '') +
    ` → ${fmtSize(event.size)} ${event.fits ? '✓ влез' : '✗ тяжело'}`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

// --- Исходник ----------------------------------------------------------------

function setSource(blob: Blob, name: string): void {
  source = blob;
  if (beforeUrl) URL.revokeObjectURL(beforeUrl);
  beforeUrl = URL.createObjectURL(blob);
  $<HTMLImageElement>('before-img').src = beforeUrl;
  $('before-caption').textContent = `До: ${name}, ${blob.type || '?'}, ${fmtSize(blob.size)}`;
  setError(null);
  void runManual();
}

async function syntheticImage(): Promise<Blob> {
  const canvas = new OffscreenCanvas(800, 600);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2d недоступен');
  const grad = ctx.createLinearGradient(0, 0, 800, 600);
  grad.addColorStop(0, '#e66465');
  grad.addColorStop(0.5, '#9198e5');
  grad.addColorStop(1, '#2a9d4a');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 800, 600);
  for (let i = 0; i < 40; i++) {
    ctx.fillStyle = `hsl(${(i * 47) % 360} 70% ${30 + ((i * 13) % 50)}%)`;
    ctx.beginPath();
    ctx.arc((i * 173) % 800, (i * 241) % 600, 12 + ((i * 29) % 48), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 44px system-ui, sans-serif';
  ctx.fillText('Синтетика 800×600', 36, 80);
  ctx.font = '22px system-ui, sans-serif';
  ctx.fillText('градиент, фигуры, текст — энтропийно честнее плоской заливки', 36, 120);
  ctx.fillStyle = '#ff0033';
  ctx.font = 'bold 20px system-ui, sans-serif';
  ctx.fillText('красный мелкий текст — проверка 4:4:4 против 4:2:0', 36, 560);
  return canvas.convertToBlob({ type: 'image/png' });
}

/** Декод блоба в Frame средствами браузера (для метрик на стороне демо). */
async function blobToFrame(blob: Blob): Promise<Frame> {
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('нет 2d-контекста');
    ctx.drawImage(bitmap, 0, 0);
    const d = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    return { data: new Uint8ClampedArray(d.data), width: d.width, height: d.height };
  } finally {
    bitmap.close();
  }
}

// --- Чтение контролов ---------------------------------------------------------

function frameOptions(): FrameOptions {
  return {
    width: num('geo-width'),
    height: num('geo-height'),
    fit: select('geo-fit').value as FrameOptions['fit'],
    method: select('geo-method').value as ResizeMethod,
  };
}

function encodeOptionsFor(format: string): EncodeOptions {
  const opts: EncodeOptions = { quality: num('enc-quality') };
  const channel = select('enc-channel').value;
  if (channel) opts.channel = channel;
  const subsampling = select('enc-subsampling').value;
  if (subsampling) opts.subsampling = subsampling as ChromaSubsampling;
  if (checked('enc-effort-enabled')) opts.effort = num('enc-effort');
  if (checked('enc-lossless')) opts.lossless = true;

  if (format === 'image/jpeg') {
    opts.progressive = checked('enc-progressive');
    opts.optimize_coding = checked('jpg-optimize');
    opts.smoothing = num('jpg-smoothing');
    const qt = select('jpg-quant-table').value;
    if (qt !== '') opts.quant_table = Number(qt);
    opts.trellis_multipass = checked('jpg-trellis-mp');
    opts.trellis_opt_zero = checked('jpg-trellis-oz');
    opts.trellis_opt_table = checked('jpg-trellis-ot');
    if (checked('jpg-chroma-separate')) {
      opts.separate_chroma_quality = true;
      opts.chroma_quality = num('jpg-chroma-quality');
    }
  } else if (format === 'image/webp') {
    opts.use_sharp_yuv = checked('webp-sharp-yuv') ? 1 : 0;
    opts.autofilter = checked('webp-autofilter') ? 1 : 0;
    opts.exact = checked('webp-exact') ? 1 : 0;
    opts.sns_strength = num('webp-sns');
    opts.filter_strength = num('webp-filter');
    opts.alpha_quality = num('webp-alpha');
  } else if (format === 'image/avif') {
    opts.tune = select('avif-tune').value;
    opts.enableSharpYUV = checked('avif-sharp-yuv');
    opts.chromaDeltaQ = checked('avif-chroma-dq');
    opts.denoiseLevel = num('avif-denoise');
    opts.sharpness = num('avif-sharpness');
    opts.qualityAlpha = num('avif-quality-alpha');
  } else if (format === 'image/png') {
    const level = select('png-oxipng-level').value;
    if (level !== '') {
      opts.oxipngLevel = Number(level);
      opts.oxipng = {
        optimiseAlpha: checked('png-oxipng-alpha'),
        interlace: checked('png-oxipng-interlace'),
      };
    }
  }
  return opts;
}

function fitSpec(): FitSpec {
  const formats: string[] = [];
  if (checked('fit-fmt-jpeg')) formats.push('image/jpeg');
  if (checked('fit-fmt-webp')) formats.push('image/webp');
  if (checked('fit-fmt-avif')) formats.push('image/avif');
  if (checked('fit-fmt-png')) formats.push('image/png');
  if (formats.length === 0) formats.push('image/jpeg');
  const channels: string[] = [];
  if (checked('fit-allow-gray')) channels.push('rgb', 'grayscale');
  return {
    formats,
    quality: [num('fit-qmin'), num('fit-qmax')],
    ...(checked('fit-use-palette')
      ? { colors: [num('fit-cmin'), num('fit-cmax')] as [number, number] }
      : {}),
    ...(channels.length ? { channels } : {}),
    ...(checked('fit-use-subsampling')
      ? { subsampling: ['4:4:4', '4:2:2', '4:0:0'] as ChromaSubsampling[] }
      : {}),
    ...(checked('fit-use-variants')
      ? { variants: [{ smoothing: 0 }, { smoothing: 30 }, { smoothing: 60 }] }
      : {}),
    frame: frameOptions(),
  };
}

const fitLimitBytes = (): number => Math.round(num('fit-limit') * 1024);

// --- Прогоны ------------------------------------------------------------------

async function guarded<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
  controller?.abort();
  controller = new AbortController();
  setBusy(true);
  setError(null);
  try {
    return await fn(controller.signal);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      $('status-text').textContent = 'Отменено пользователем.';
    } else {
      setError(err);
    }
    return undefined;
  } finally {
    setBusy(false);
  }
}

async function showMetrics(result: Blob, src: Blob, usedFrame: boolean): Promise<void> {
  const el = $('metrics-result');
  try {
    const srcFrame = await blobToFrame(src);
    const ref = usedFrame ? applyFrameGeometry(srcFrame, frameOptions()) : srcFrame;
    const outFrame = await blobToFrame(result);
    if (ref.width !== outFrame.width || ref.height !== outFrame.height) {
      el.textContent = `Метрики: размеры не совпали (${ref.width}×${ref.height} против ${outFrame.width}×${outFrame.height}).`;
      return;
    }
    const m = compareFrames(ref, outFrame);
    el.textContent =
      `Метрики против исходника в целевой геометрии: PSNR ${m.psnr === Infinity ? '∞' : m.psnr.toFixed(1)} дБ, ` +
      `блочный SSIM ${m.ssim.toFixed(4)}, MAE ${m.mae.toFixed(2)}` +
      (checked('q-enabled') || checked('sharp-enabled')
        ? ' (палитра/шарп входят в искажение — сравнивается с кадром до них).'
        : '.');
  } catch (err) {
    el.textContent = `Метрики: не посчитались (${err instanceof Error ? err.message : String(err)}).`;
  }
}

async function runManual(): Promise<void> {
  if (!source) return;
  const src = source;
  const useFrame = checked('geo-enabled');
  const useSharpen = checked('sharp-enabled');
  const useQuantize = checked('q-enabled');
  const format = select('enc-format').value;
  const encodeOpts = encodeOptionsFor(format);

  const blob = await guarded((signal) =>
    image(
      src,
      async (p) => {
        if (useFrame) await p.frame(frameOptions());
        if (useSharpen) await p.sharpen({ amount: num('sharp-amount'), radius: num('sharp-radius') });
        if (useQuantize) {
          await p.quantize({
            colors: num('q-colors'),
            dithering: num('q-dithering'),
            algorithm: select('q-algorithm').value as PaletteAlgorithm,
            distance: select('q-distance').value as ColorDistanceFormula,
            serpentine: checked('q-serpentine'),
          });
        }
        return p.encode(format, encodeOpts);
      },
      { state: onEvent, signal },
    ),
  );
  if (!blob) return;
  const paramsText =
    `${format}, q=${num('enc-quality').toFixed(2)}` +
    (useFrame ? `, кадр ${frameOptions().width}×${frameOptions().height} ${frameOptions().fit}/${frameOptions().method}` : '') +
    (useSharpen ? `, шарп ${num('sharp-amount')}` : '') +
    (useQuantize ? `, палитра ${num('q-colors')} (${select('q-algorithm').value})` : '') +
    (encodeOpts.channel ? `, канал ${String(encodeOpts.channel)}` : '') +
    (encodeOpts.subsampling ? `, ${encodeOpts.subsampling}` : '') +
    (encodeOpts.lossless ? ', lossless' : '') +
    (encodeOpts.effort !== undefined ? `, effort ${encodeOpts.effort.toFixed(2)}` : '');
  showAfter(blob, `После: ${paramsText} → ${fmtSize(blob.size)}`);
  $('manual-result').textContent =
    `Результат: ${fmtSize(blob.size)}; параметры: ${paramsText}; исходник был ${fmtSize(src.size)}.`;
  await showMetrics(blob, src, useFrame);
}

async function runFit(strategy: FitStrategyName, updateUi: boolean): Promise<FitResult | null | undefined> {
  if (!source) return undefined;
  const src = source;
  const spec = fitSpec();
  const limit = fitLimitBytes();
  const hit = await guarded((signal) =>
    image(src, (p) => p.fit(spec, (candidate) => candidate.size <= limit, { strategy }), {
      state: onEvent,
      signal,
    }),
  );
  if (updateUi) {
    if (hit === undefined) {
      $('fit-result').textContent = 'Итог: отменено/ошибка.';
    } else if (hit === null) {
      $('fit-result').textContent =
        `Итог: null — не влезло даже на полу (q=${spec.quality[0]}` +
        (spec.colors ? `, цветов ${spec.colors[0]}` : '') +
        `) под лимит ${fmtSize(limit)}.`;
    } else {
      const pp = hit.params;
      $('fit-result').textContent =
        `Итог: ${fmtSize(hit.blob.size)} за ${hit.attempts} проб; ` +
        `params: format=${pp.format}, quality=${pp.quality}` +
        (pp.colors ? `, colors=${pp.colors}` : '') +
        (pp.channel ? `, channel=${pp.channel}` : '') +
        (pp.subsampling ? `, subsampling=${pp.subsampling}` : '') +
        (pp.variant ? `, variant=${JSON.stringify(pp.variant)}` : '') +
        `; лимит был ${fmtSize(limit)}.`;
      showAfter(hit.blob, `После (fit, ${strategy}): ${pp.format}, q=${pp.quality} → ${fmtSize(hit.blob.size)}`);
    }
  }
  return hit;
}

async function runCompare(): Promise<void> {
  if (!source) return;
  const tbody = $<HTMLTableElement>('compare-table').querySelector('tbody');
  if (!tbody) return;
  tbody.textContent = '';
  for (const strategy of ['owner-loop', 'binary', 'secant', 'coarse-fine'] as FitStrategyName[]) {
    $('fit-result').textContent = `Сравнение стратегий: идёт ${strategy}…`;
    const t0 = performance.now();
    const hit = await runFit(strategy, false);
    const ms = performance.now() - t0;
    const tr = document.createElement('tr');
    if (hit) {
      const pp = hit.params;
      tr.innerHTML =
        `<td>${strategy}</td><td>${hit.attempts}</td>` +
        `<td>${pp.format}, q=${pp.quality}${pp.colors ? `, c${pp.colors}` : ''}${pp.channel ? `, ${pp.channel}` : ''}${pp.subsampling ? `, ${pp.subsampling}` : ''}</td>` +
        `<td>${fmtSize(hit.blob.size)}</td><td>${ms.toFixed(0)} мс</td>`;
    } else {
      tr.innerHTML = `<td>${strategy}</td><td colspan="3">null (не влезло)</td><td>${ms.toFixed(0)} мс</td>`;
    }
    tbody.appendChild(tr);
  }
  $('fit-result').textContent = 'Сравнение завершено — см. таблицу ниже. Лог выше: попытки последней стратегии.';
}

// --- Пресеты оптимизаторов (выставляют контролы) --------------------------------

function setVal(id: string, value: string): void {
  const el = $(id) as HTMLInputElement | HTMLSelectElement;
  el.value = value;
}
function setCheck(id: string, on: boolean): void {
  input(id).checked = on;
}

const UI_PRESETS: Record<string, () => void> = {
  'avif-photo': () => {
    setVal('enc-format', 'image/avif');
    setVal('enc-quality', '0.6');
    setCheck('enc-effort-enabled', true); setVal('enc-effort', '0.4');
    setVal('avif-tune', 'ssim'); setCheck('avif-sharp-yuv', true);
    setVal('enc-subsampling', '4:2:0');
    setVal('geo-method', 'lanczos3'); setCheck('sharp-enabled', true); setVal('sharp-amount', '0.35');
    setCheck('q-enabled', false); setCheck('enc-lossless', false);
  },
  'webp-photo': () => {
    setVal('enc-format', 'image/webp');
    setVal('enc-quality', '0.8');
    setCheck('enc-effort-enabled', true); setVal('enc-effort', '0.65');
    setCheck('webp-sharp-yuv', true); setCheck('webp-autofilter', true);
    setVal('geo-method', 'lanczos3'); setCheck('sharp-enabled', true); setVal('sharp-amount', '0.35');
    setCheck('q-enabled', false); setCheck('enc-lossless', false);
  },
  'jpeg-compat': () => {
    setVal('enc-format', 'image/jpeg');
    setVal('enc-quality', '0.85');
    setCheck('jpg-trellis-mp', true); setCheck('jpg-trellis-ot', true); setCheck('jpg-trellis-oz', true);
    setCheck('enc-progressive', true); setCheck('jpg-optimize', true);
    setVal('jpg-quant-table', '3');
    setVal('geo-method', 'lanczos3'); setCheck('sharp-enabled', true);
    setCheck('q-enabled', false); setCheck('enc-lossless', false);
  },
  'screen-webp': () => {
    setVal('enc-format', 'image/webp');
    setCheck('enc-lossless', true);
    setVal('enc-quality', '0.9');
    setCheck('enc-effort-enabled', true); setVal('enc-effort', '0.85');
    setVal('webp-sns', '0');
    setVal('geo-method', 'lanczos3'); setCheck('sharp-enabled', false);
    setCheck('q-enabled', false);
  },
  'manga-png': () => {
    setVal('enc-format', 'image/png');
    setVal('png-oxipng-level', '4');
    setCheck('q-enabled', true); setVal('q-colors', '16'); setVal('q-dithering', '0');
    setVal('enc-channel', 'grayscale');
    setVal('geo-method', 'area');
  },
  'avif-max': () => {
    setVal('enc-format', 'image/avif');
    setVal('enc-quality', '0.5');
    setCheck('enc-effort-enabled', true); setVal('enc-effort', '0.8');
    setVal('avif-tune', 'ssim'); setCheck('avif-chroma-dq', true);
    setVal('enc-subsampling', '4:2:0');
    setCheck('q-enabled', false); setCheck('enc-lossless', false);
  },
  'webp-lossless': () => {
    setVal('enc-format', 'image/webp');
    setCheck('enc-lossless', true);
    setVal('enc-quality', '1');
    setCheck('enc-effort-enabled', true); setVal('enc-effort', '1');
    setCheck('q-enabled', false);
  },
};

// --- Привязка контролов --------------------------------------------------------

function syncFormatBlocks(): void {
  const format = select('enc-format').value;
  $('block-jpeg').hidden = format !== 'image/jpeg';
  $('block-webp').hidden = format !== 'image/webp';
  $('block-avif').hidden = format !== 'image/avif';
  $('block-png').hidden = format !== 'image/png';
}

function syncLabels(): void {
  $('q-colors-val').textContent = input('q-colors').value;
  $('q-dithering-val').textContent = input('q-dithering').value;
  $('enc-quality-val').textContent = num('enc-quality').toFixed(2);
  $('enc-effort-val').textContent = num('enc-effort').toFixed(2);
  $('sharp-amount-val').textContent = num('sharp-amount').toFixed(2);
  $('jpg-smoothing-val').textContent = input('jpg-smoothing').value;
  $('jpg-chroma-quality-val').textContent = input('jpg-chroma-quality').value;
  $('webp-sns-val').textContent = input('webp-sns').value;
  $('webp-filter-val').textContent = input('webp-filter').value;
  $('webp-alpha-val').textContent = input('webp-alpha').value;
  $('avif-denoise-val').textContent = input('avif-denoise').value;
  $('avif-sharpness-val').textContent = input('avif-sharpness').value;
}

let debounce = 0;
function scheduleManual(): void {
  window.clearTimeout(debounce);
  debounce = window.setTimeout(() => void runManual(), 300);
}

const MANUAL_CONTROLS = [
  'geo-width', 'geo-height', 'geo-fit', 'geo-method', 'geo-enabled',
  'sharp-enabled', 'sharp-amount', 'sharp-radius',
  'q-enabled', 'q-colors', 'q-dithering', 'q-serpentine', 'q-algorithm', 'q-distance',
  'enc-format', 'enc-quality', 'enc-effort-enabled', 'enc-effort', 'enc-lossless',
  'enc-channel', 'enc-subsampling', 'enc-progressive',
  'jpg-optimize', 'jpg-smoothing', 'jpg-quant-table', 'jpg-trellis-mp', 'jpg-trellis-oz',
  'jpg-trellis-ot', 'jpg-chroma-separate', 'jpg-chroma-quality',
  'webp-sharp-yuv', 'webp-autofilter', 'webp-exact', 'webp-sns', 'webp-filter', 'webp-alpha',
  'avif-tune', 'avif-sharp-yuv', 'avif-chroma-dq', 'avif-denoise', 'avif-sharpness', 'avif-quality-alpha',
  'png-oxipng-level', 'png-oxipng-alpha', 'png-oxipng-interlace',
];
for (const id of MANUAL_CONTROLS) {
  $(id).addEventListener('input', () => {
    syncLabels();
    syncFormatBlocks();
    scheduleManual();
  });
}

$('run-manual').addEventListener('click', () => void runManual());
$('preset-apply').addEventListener('click', () => {
  UI_PRESETS[select('preset-select').value]?.();
  syncLabels();
  syncFormatBlocks();
  void runManual();
});
$('fit-btn').addEventListener('click', () =>
  void runFit(select('fit-strategy').value as FitStrategyName, true),
);
$('compare-btn').addEventListener('click', () => void runCompare());
$('cancel-btn').addEventListener('click', () => controller?.abort());
$('synthetic-btn').addEventListener('click', () => {
  syntheticImage()
    .then((blob) => setSource(blob, 'synthetic.png'))
    .catch(setError);
});

input('file-input').addEventListener('change', (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) setSource(file, file.name);
});

const drop = $('drop');
drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  drop.classList.add('over');
});
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const file = e.dataTransfer?.files?.[0];
  if (file) setSource(file, file.name);
});

syncLabels();
syncFormatBlocks();
// Удобство ручной проверки: страница сразу показывает синтетику.
syntheticImage()
  .then((blob) => setSource(blob, 'synthetic.png'))
  .catch(setError);
