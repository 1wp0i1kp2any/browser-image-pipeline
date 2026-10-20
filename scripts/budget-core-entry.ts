// Минимальный consumer-вход для bundle-budget: только основной конвейер.
// Назначение в globalThis не даёт бандлеру выкинуть импорт как мёртвый.
import { image } from '../src/index.js';

(globalThis as { __browserImagePipeline?: typeof image }).__browserImagePipeline = image;
