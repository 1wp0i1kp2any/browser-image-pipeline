// Сравнение форматов и пресетов: вес + PSNR/SSIM против исходного кадра.
// «Сжать, сохранив качество» — измеримо: каждый кандидат декодируется
// обратно кодеком библиотеки и сравнивается с исходником метриками.
//
// Запуск: npx tsx scripts/compare-formats.ts → markdown-таблица.

import '../test/setup-wasm.js';
import {
  PRESETS,
  compareFrames,
  getEncoder,
  image,
} from '../src/index.js';
import type { EncodeOptions, Frame } from '../src/index.js';
import { anyBlob, decoderFor, mangaFrame, noiseFrame, photoFrame } from '../test/helpers.js';

interface Candidate {
  label: string;
  format: string;
  options?: EncodeOptions;
  quantizeColors?: number;
}

const CANDIDATES: Candidate[] = [
  { label: 'jpeg q0.80 (умолчания сборки)', format: 'image/jpeg', options: { quality: 0.8 } },
  { label: 'jpeg q0.80 + пресет photo (trellis)', format: 'image/jpeg', options: { ...PRESETS['image/jpeg'].photo, quality: 0.8 } },
  { label: 'jpeg q0.80 + пресет maxCompression', format: 'image/jpeg', options: { ...PRESETS['image/jpeg'].maxCompression, quality: 0.8 } },
  { label: 'jpeg q0.80, 4:4:4', format: 'image/jpeg', options: { quality: 0.8, subsampling: '4:4:4' } },
  { label: 'webp q0.80', format: 'image/webp', options: { quality: 0.8 } },
  { label: 'webp q0.80 + пресет photo', format: 'image/webp', options: { ...PRESETS['image/webp'].photo, quality: 0.8 } },
  { label: 'webp lossless', format: 'image/webp', options: { ...PRESETS['image/webp'].lossless, quality: 0.9 } },
  { label: 'webp lossless + палитра 256 (наш near-lossless путь)', format: 'image/webp', options: { ...PRESETS['image/webp'].lossless, quality: 0.9 }, quantizeColors: 256 },
  { label: 'avif q0.60', format: 'image/avif', options: { quality: 0.6, effort: 0.4 } },
  { label: 'avif q0.60 + пресет photo (tune ssim)', format: 'image/avif', options: { ...PRESETS['image/avif'].photo, quality: 0.6 } },
  { label: 'png (голый энкодер)', format: 'image/png' },
  { label: 'png + oxipng 3', format: 'image/png', options: { oxipngLevel: 3 } },
  { label: 'png палитра 128 + oxipng 3', format: 'image/png', options: { oxipngLevel: 3 }, quantizeColors: 128 },
];

const FRAMES: Record<string, Frame> = {
  'фото-градиент': photoFrame(200, 200),
  'шум': noiseFrame(200, 200),
  'манга (монохром)': mangaFrame(200, 200),
};

for (const [frameName, frame] of Object.entries(FRAMES)) {
  console.log(`\n### ${frameName} 200×200\n`);
  console.log('| Кандидат | Вес, B | PSNR, дБ | блочный SSIM |');
  console.log('|---|---|---|---|');
  for (const c of CANDIDATES) {
    const blob = await image(
      anyBlob(),
      async (p) => {
        if (c.quantizeColors) await p.quantize({ colors: c.quantizeColors, dithering: 0 });
        return p.encode(c.format, c.options);
      },
      { decoder: decoderFor(frame) },
    );
    const codec = getEncoder(c.format);
    let psnr = '—';
    let ssim = '—';
    if (codec.decode) {
      const back = await codec.decode(blob);
      const m = compareFrames(frame, back);
      psnr = m.psnr === Infinity ? '∞' : m.psnr.toFixed(1);
      ssim = m.ssim.toFixed(4);
    }
    console.log(`| ${c.label} | ${blob.size} | ${psnr} | ${ssim} |`);
  }
}
