import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const benchRoot = path.dirname(fileURLToPath(import.meta.url));

// Отдельная от демо production-сборка benchmark-страницы. Она не входит в
// npm-пакет и нужна только scripts/benchmark-browser.ts.
export default defineConfig({
  root: benchRoot,
  build: {
    outDir: path.join(benchRoot, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
  },
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    exclude: ['@jsquash/jpeg', '@jsquash/png', '@jsquash/webp', '@jsquash/avif', '@jsquash/oxipng'],
  },
});
