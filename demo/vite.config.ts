import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const demoRoot = path.dirname(fileURLToPath(import.meta.url));

// Демо собирается ОТДЕЛЬНО от библиотеки и в поставку пакета не попадает
// (package.json "files" содержит только dist/, src/, README).
// Библиотека подключается исходниками — vite сам порежет ленивые чанки
// кодеков/квантования и вынесет wasm-ассеты @jsquash.
export default defineConfig({
  root: demoRoot,
  build: {
    outDir: path.join(demoRoot, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
  },
  server: {
    host: '0.0.0.0',
    allowedHosts: true,
  },
  preview: {
    host: '0.0.0.0',
    allowedHosts: true,
  },
  worker: {
    // Многопоточные сборки @jsquash (avif MT, oxipng parallel) тащат
    // emscripten-воркеры: с форматом по умолчанию (iife) rollup не умеет
    // code-splitting. В среде без crossOriginIsolated кодеки сами выберут
    // однопоточные варианты.
    format: 'es',
  },
  optimizeDeps: {
    // @jsquash грузят wasm через new URL(..., import.meta.url):
    // пре-бандлинг esbuild ломает относительные пути к wasm.
    exclude: ['@jsquash/jpeg', '@jsquash/png', '@jsquash/webp', '@jsquash/avif', '@jsquash/oxipng'],
  },
});
