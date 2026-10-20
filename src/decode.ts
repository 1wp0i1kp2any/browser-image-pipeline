// Декодирование источника (Blob/File) в кадр.
//
// Браузерный путь: createImageBitmap с imageOrientation:'from-image'
// (EXIF-поворот честится) → OffscreenCanvas → getImageData.
// В средах без этих API честно бросаем EnvironmentError — молча работать
// неправильно запрещено контрактом. Для тестов и нестандартных сред есть
// шов options.decoder.

import type { Frame } from './types.js';
import { EnvironmentError } from './errors.js';
import { frameFromOwnedImageData } from './frame.js';

/**
 * Есть ли в среде браузерный декодер.
 *
 * @returns true, если доступны createImageBitmap и OffscreenCanvas.
 */
function hasBrowserDecoder(): boolean {
  return (
    typeof createImageBitmap === 'function' &&
    typeof OffscreenCanvas === 'function'
  );
}

/**
 * Декодировать Blob в кадр браузерным путём с учётом EXIF-ориентации.
 *
 * @param source - исходный Blob/File изображения любого формата, который
 *   понимает браузерный декодер среды.
 * @returns свежий кадр RGBA в ориентации 'from-image'.
 * @throws EnvironmentError вне браузера (SSR/Node без options.decoder)
 *   или если OffscreenCanvas не дал 2d-контекст.
 */
export async function decodeWithBrowser(source: Blob): Promise<Frame> {
  if (!hasBrowserDecoder()) {
    throw new EnvironmentError(
      'createImageBitmap + OffscreenCanvas are unavailable (SSR/Node?). ' +
        'Pass options.decoder to decode in your own way.',
    );
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(source, { imageOrientation: 'from-image' });
  } catch {
    // Часть браузеров (исторически Safari) не знает опций createImageBitmap.
    // Падаем в вызов без опций: EXIF тогда зависит от умолчаний браузера,
    // но конвейер хотя бы работает. Современные браузеры сюда не попадают.
    bitmap = await createImageBitmap(source);
  }

  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new EnvironmentError('OffscreenCanvas 2d context is unavailable.');
    }
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    return frameFromOwnedImageData(imageData);
  } finally {
    // Ресурс освобождаем всегда, в том числе при отмене/ошибке выше по стеку.
    bitmap.close();
  }
}
