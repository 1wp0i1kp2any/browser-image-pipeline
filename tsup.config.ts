import { defineConfig } from 'tsup';

// Сборка библиотеки: ядро + ленивые чанки кодеков и квантования.
// Тяжёлые зависимости (@jsquash/*, image-q) остаются ВНЕШНИМИ: бандлер
// потребителя сам вынесет их wasm-ассеты и разрежет чанки. Библиотека
// гарантирует лишь точки динамического импорта (codecs/*, quantize).
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    state: 'src/state-collector.ts',
    testing: 'src/testing.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: true, // динамические импорты кодеков/квантования — отдельные чанки
  treeshake: true,
  minify: true,
  external: ['@jsquash/jpeg', '@jsquash/png', '@jsquash/webp', '@jsquash/avif', '@jsquash/oxipng', 'image-q'],
  target: 'es2022',
});
