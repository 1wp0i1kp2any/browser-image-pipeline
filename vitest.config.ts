import { defineConfig } from 'vitest/config';

// Vitest: тот же Vite-стек, что у демо, нативная работа с ESM/TS без
// трансформеров-костылей, среда node — библиотека в тестах ходит через
// decoder-шов и синтетические кодеки, браузер ей для юнит-тестов не нужен.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup-wasm.ts'],
    testTimeout: 60_000,
  },
});
