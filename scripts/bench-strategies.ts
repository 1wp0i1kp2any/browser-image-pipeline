// Бенчмарк стратегий fit: число энкодов (проб) до попадания.
//
// Прогоняется на синтетическом кодеке с модельной кривой веса (test/helpers):
// монотонна по качеству (~1/(1.02-q), JPEG-подобно), по цветам и по каналам.
// Число проб стратегии зависит от формы кривой и положения границы, а не от
// конкретного энкодера — поэтому модель честна для сравнения стратегий.
// В конце — один сценарий на РЕАЛЬНОМ MozJPEG для сверки порядка цифр.
//
// Запуск: npm run bench  → markdown-таблицы в stdout (копируются в README).

import '../test/setup-wasm.js';
import { image, registerEncoder, unregisterEncoder } from '../src/index.js';
import type { FitStrategyName } from '../src/index.js';
import {
  anyBlob,
  decoderFor,
  makeFakeCodec,
  mangaFrame,
  noiseFrame,
  photoFrame,
  type FakeCodec,
} from '../test/helpers.js';

const STRATEGIES: FitStrategyName[] = ['owner-loop', 'binary', 'secant', 'coarse-fine'];

interface Scenario {
  name: string;
  frame: ReturnType<typeof photoFrame>;
  baseAtQ80: number;
  chroma?: number;
  limit: number;
  channels?: string[];
}

const SCENARIOS: Scenario[] = [
  { name: 'лёгкий кадр, щедрый лимит', frame: photoFrame(200, 200), baseAtQ80: 20_000, limit: 200_000 },
  { name: 'фото, граница ≈ q0.87', frame: photoFrame(200, 200), baseAtQ80: 20_000, limit: 30_000 },
  { name: 'фото, граница у пола', frame: photoFrame(200, 200), baseAtQ80: 20_000, limit: 21_500 },
  { name: 'фото, нужна палитра', frame: photoFrame(200, 200), baseAtQ80: 20_000, limit: 13_000 },
  { name: 'шум (худший энтропийный случай)', frame: noiseFrame(200, 200), baseAtQ80: 60_000, limit: 40_000 },
  {
    name: 'манга (монохром, grayscale разрешён)',
    frame: mangaFrame(200, 200),
    baseAtQ80: 20_000,
    chroma: 0,
    limit: 5_000,
    channels: ['rgb', 'grayscale'],
  },
  { name: 'невозможный вес', frame: photoFrame(200, 200), baseAtQ80: 20_000, limit: 10 },
];

async function runScenario(s: Scenario, fake: FakeCodec): Promise<Record<string, string>> {
  const row: Record<string, string> = {};
  for (const strategy of STRATEGIES) {
    fake.reset();
    Object.assign(fake, {}); // модель кодека фиксирована на сценарий через замыкание ниже
    const hit = await image(
      anyBlob(),
      (p) =>
        p.fit(
          {
            formats: ['image/bench'],
            quality: [0.8, 0.99],
            colors: [16, 256],
            ...(s.channels ? { channels: s.channels } : {}),
          },
          (c) => c.size <= s.limit,
          { strategy },
        ),
      { decoder: decoderFor(s.frame) },
    );
    row[strategy] =
      hit === null
        ? `null (${fake.encodes})`
        : `${fake.encodes} → q${hit.params.quality.toFixed(2)}` +
          (hit.params.colors ? ` c${hit.params.colors}` : '') +
          (hit.params.channel ? ` ${hit.params.channel}` : '');
  }
  return row;
}

console.log('## Синтетический кодек (модельная кривая веса), пробы до попадания\n');
console.log(`| Сценарий | ${STRATEGIES.join(' | ')} |`);
console.log(`|---|${STRATEGIES.map(() => '---').join('|')}|`);
for (const s of SCENARIOS) {
  const fake = makeFakeCodec({ baseAtQ80: s.baseAtQ80, chroma: s.chroma }, 'image/bench');
  registerEncoder('image/bench', fake);
  const row = await runScenario(s, fake);
  unregisterEncoder('image/bench');
  console.log(`| ${s.name} | ${STRATEGIES.map((st) => row[st]).join(' | ')} |`);
}

console.log('\n## Реальный MozJPEG, шумный кадр 200×200, поиск только по качеству (сетка 0.50–0.99)\n');
console.log(`| Лимит | ${STRATEGIES.join(' | ')} |`);
console.log(`|---|${STRATEGIES.map(() => '---').join('|')}|`);
for (const limit of [30_000, 12_000, 8_500]) {
  const cells: string[] = [];
  for (const strategy of STRATEGIES) {
    const hit = await image(
      anyBlob(),
      (p) =>
        p.fit(
          { formats: ['image/jpeg'], quality: [0.5, 0.99] },
          (c) => c.size <= limit,
          { strategy },
        ),
      { decoder: decoderFor(noiseFrame(200, 200)) },
    );
    cells.push(
      hit === null
        ? 'null'
        : `${hit.attempts} → q${hit.params.quality.toFixed(2)}` +
            (hit.params.colors ? ` c${hit.params.colors}` : '') +
            `, ${hit.blob.size} B`,
    );
  }
  console.log(`| ${limit} B | ${cells.join(' | ')} |`);
}
