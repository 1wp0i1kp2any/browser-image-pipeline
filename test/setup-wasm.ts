// Тестовый шов для реальных wasm-кодеков в Node.
//
// @jsquash/* по умолчанию грузят .wasm через fetch(new URL(..., import.meta.url)).
// В браузере это работает; Node fetch file://-URL не поддерживает
// ("fetch failed / not implemented... yet..."). Поэтому в тестах кодеки
// пред-инициализируются байтами wasm с диска — сам энкод при этом настоящий
// (MozJPEG/PNG/libwebp/libaom/oxipng), подменяется только способ доставки
// модуля. Библиотека об этом не знает и знать не должна: она браузерная.

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

async function wasmBytes(specifier: string): Promise<Uint8Array> {
  return readFile(require.resolve(specifier));
}
const wasmBuffer = async (specifier: string): Promise<ArrayBuffer> =>
  (await wasmBytes(specifier)).buffer as ArrayBuffer;

const jpegEnc = await import('@jsquash/jpeg/encode');
await jpegEnc.init({ wasmBinary: await wasmBuffer('@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm') }).catch(() => undefined);

const jpegDec = await import('@jsquash/jpeg/decode');
await jpegDec.init({ wasmBinary: await wasmBuffer('@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm') }).catch(() => undefined);

const pngEnc = await import('@jsquash/png/encode');
await pngEnc.init(await wasmBytes('@jsquash/png/codec/pkg/squoosh_png_bg.wasm'));

const pngDec = await import('@jsquash/png/decode');
await pngDec.init(await wasmBytes('@jsquash/png/codec/pkg/squoosh_png_bg.wasm'));

// WebP: encode выбирает SIMD-сборку, ей и даём байты.
const webpEnc = await import('@jsquash/webp/encode');
await webpEnc.init({ wasmBinary: await wasmBuffer('@jsquash/webp/codec/enc/webp_enc_simd.wasm') }).catch(() => undefined);

const webpDec = await import('@jsquash/webp/decode');
await webpDec.init({ wasmBinary: await wasmBuffer('@jsquash/webp/codec/dec/webp_dec.wasm') }).catch(() => undefined);

const avifEnc = await import('@jsquash/avif/encode');
await avifEnc.init({ wasmBinary: await wasmBuffer('@jsquash/avif/codec/enc/avif_enc.wasm') }).catch(() => undefined);

const avifDec = await import('@jsquash/avif/decode');
await avifDec.init({ wasmBinary: await wasmBuffer('@jsquash/avif/codec/dec/avif_dec.wasm') }).catch(() => undefined);

// oxipng: вне воркера init выбирает однопоточную (ST) сборку.
const oxipng = await import('@jsquash/oxipng/optimise');
await oxipng.init(await wasmBytes('@jsquash/oxipng/codec/pkg/squoosh_oxipng_bg.wasm'));
