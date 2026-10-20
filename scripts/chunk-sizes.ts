// Фактические веса поставки: чанки библиотеки (dist/) и внешние зависимости.
// Запуск: npm run build && npm run sizes

import { readdir, readFile, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

function fmt(n: number): string {
  return n >= 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${n} B`;
}

async function row(label: string, file: string): Promise<string> {
  const buf = await readFile(file);
  return `| ${label} | ${fmt(buf.length)} | ${fmt(gzipSync(buf).length)} |`;
}

console.log('| Чанк / ассет | raw | gzip |');
console.log('|---|---|---|');

const dist = path.resolve('dist');
for (const name of (await readdir(dist)).sort()) {
  if (!name.endsWith('.js')) continue;
  console.log(await row(`dist/${name}`, path.join(dist, name)));
}

// Внешние зависимости: что реально прилетит потребителю по динамическим импортам.
const externals: [string, string][] = [
  ['image-q (JS, esm)', require.resolve('image-q')],
  ['@jsquash/jpeg encode.js', require.resolve('@jsquash/jpeg/encode')],
  ['@jsquash/jpeg mozjpeg_enc.js (glue)', require.resolve('@jsquash/jpeg/codec/enc/mozjpeg_enc.js')],
  ['@jsquash/png encode.js', require.resolve('@jsquash/png/encode')],
  ['@jsquash/png squoosh_png.js (glue)', require.resolve('@jsquash/png/codec/pkg/squoosh_png.js')],
  ['@jsquash/webp encode.js', require.resolve('@jsquash/webp/encode')],
  ['@jsquash/webp webp_enc_simd.js (glue)', require.resolve('@jsquash/webp/codec/enc/webp_enc_simd.js')],
  ['@jsquash/avif encode.js', require.resolve('@jsquash/avif/encode')],
  ['@jsquash/avif avif_enc.js (glue)', require.resolve('@jsquash/avif/codec/enc/avif_enc.js')],
  ['@jsquash/oxipng optimise.js', require.resolve('@jsquash/oxipng/optimise')],
  ['@jsquash/oxipng squoosh_oxipng.js (glue)', require.resolve('@jsquash/oxipng/codec/pkg/squoosh_oxipng.js')],
];
for (const [label, file] of externals) {
  console.log(await row(label, file).catch(() => `| ${label} | ? | ? |`));
}

console.log('\nWasm-ассеты (не код; грузятся при первом использовании кодека):\n');
for (const [label, file] of [
  ['mozjpeg_enc.wasm', require.resolve('@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm')],
  ['mozjpeg_dec.wasm', require.resolve('@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm')],
  ['squoosh_png_bg.wasm', require.resolve('@jsquash/png/codec/pkg/squoosh_png_bg.wasm')],
  ['webp_enc_simd.wasm', require.resolve('@jsquash/webp/codec/enc/webp_enc_simd.wasm')],
  ['webp_dec.wasm', require.resolve('@jsquash/webp/codec/dec/webp_dec.wasm')],
  ['avif_enc.wasm', require.resolve('@jsquash/avif/codec/enc/avif_enc.wasm')],
  ['avif_dec.wasm', require.resolve('@jsquash/avif/codec/dec/avif_dec.wasm')],
  ['squoosh_oxipng_bg.wasm (ST)', require.resolve('@jsquash/oxipng/codec/pkg/squoosh_oxipng_bg.wasm')],
] as [string, string][]) {
  const s = await stat(file);
  console.log(`- ${label}: ${fmt(s.size)} raw`);
}
