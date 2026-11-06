'use strict';
/* Testy frontendu: wyciąga funkcje z SERWOWANEGO app/public/index.html
 * i uruchamia je w VM z zaślepkami DOM. Sprawdza poprawki na realnych danych. */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

const HTML = fs.readFileSync(path.join(__dirname, '../app/public/index.html'), 'utf8');
const V = require('../app/lib/validate');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
}

/** Wyciąga funkcję po nazwie, dopasowując klamry. */
function extractFn(name) {
  const start = HTML.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('nie znaleziono funkcji ' + name);
  let i = HTML.indexOf('{', start), depth = 0;
  for (let j = i; j < HTML.length; j++) {
    if (HTML[j] === '{') depth++;
    else if (HTML[j] === '}') { depth--; if (depth === 0) return HTML.slice(start, j + 1); }
  }
  throw new Error('nie domknięto funkcji ' + name);
}

const NAMES = ['parsePlNumber', 'normalizeHeader', 'parseDateFlexible', 'extractHour',
  'classifyGrowattHaSensor', 'parseHaStatisticsCsv', 'estimateGridCharge',
  'hourlyDepositValue', 'addMonths', 'allHoursCoveredForDate', 'extractHourFromApiRecord',
  'runBatteryValidation', 'round2', 'formatMonthLabel', 'computeTranches'];

const logs = [];
const sandbox = {
  V, validateCfg: V.resolveConfig(), console,
  state: { haHourly: {}, haBatteryCheck: {}, haRejected: {}, rceHourly: {}, months: {}, refundRate: 0.30, refundCapBasis: 'base' },
  log: (m, l) => logs.push({ m, l }),
  Math, Date, JSON, Number, String, Object, Array, Set, Map, isFinite, isNaN, parseInt, parseFloat, Infinity, NaN,
  MONTH_NAMES: ['styczeń','luty','marzec','kwiecień','maj','czerwiec','lipiec','sierpień','wrzesień','październik','listopad','grudzień'],
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext('const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;\n'
  + 'const MONTH_NAMES = ' + JSON.stringify(sandbox.MONTH_NAMES) + ';', sandbox);
for (const n of NAMES) {
  if (n === 'round2') continue;
  vm.runInContext(extractFn(n), sandbox);
}

console.log('\n=== F3: parsePlNumber ===');
t('P1 „1.234,56” → 1234.56 (było 1.234)', () => {
  assert.strictEqual(sandbox.parsePlNumber('1.234,56'), 1234.56);
});
t('P2 „1,5” → 1.5 oraz „1.5” → 1.5', () => {
  assert.strictEqual(sandbox.parsePlNumber('1,5'), 1.5);
  assert.strictEqual(sandbox.parsePlNumber('1.5'), 1.5);
});
t('P3 NBSP i jednostki', () => {
  assert.strictEqual(sandbox.parsePlNumber('1\u00a0234,56 kWh'), 1234.56);
});

console.log('\n=== F4: godzina RCE ze STARTU okresu (P0-2) ===');
t('R1 period wygrywa z dtime', () => {
  assert.strictEqual(sandbox.extractHourFromApiRecord({ period: '15:00 - 15:15', dtime: '2026-07-01 15:15:00' }), 15);
});
t('R2 sam dtime 15:00 (koniec) → 14', () => {
  assert.strictEqual(sandbox.extractHourFromApiRecord({ dtime: '2026-07-01 15:00:00' }), 14);
});
t('R3 dtime 00:00 (koniec doby) → 23', () => {
  assert.strictEqual(sandbox.extractHourFromApiRecord({ dtime: '2026-07-02 00:00:00' }), 23);
});

console.log('\n=== F5: mnożnik ×1,23 z bramką daty ===');
t('D1 2024-12 → bez mnożnika', () => {
  const v = sandbox.hourlyDepositValue(100, 500, '2024-12');
  assert.strictEqual(Math.round(v * 100) / 100, 50);
});
t('D2 2026-07 → ×1,23', () => {
  const v = sandbox.hourlyDepositValue(100, 500, '2026-07');
  assert.strictEqual(Math.round(v * 100) / 100, 61.5);
});
t('D3 ujemne RCE nie zmniejsza depozytu', () => {
  assert.strictEqual(sandbox.hourlyDepositValue(100, -500, '2026-07'), 0);
});

console.log('\n=== F7: wygasanie transzy M+13 ===');
t('T1 addMonths(2026-07, 13) → 2027-08', () => {
  assert.strictEqual(sandbox.addMonths('2026-07', 13), '2027-08');
});
t('T2 addMonths(2026-07, 1) → 2026-08 (miesiąc przypisania)', () => {
  assert.strictEqual(sandbox.addMonths('2026-07', 1), '2026-08');
});

console.log('\n=== F18: limit zwrotu nadpłaty (RCE godzinowe, 30%) ===');
// Lipiec 2026: depozyt 258,62 zł (po ×1,23, z poprawionym dtime)
const JUL_DEPOSIT = 258.62;
t('L1 podstawa bazowa: 30% od 210,26 zł = 63,08 zł', () => {
  const c = V.refundCap(1000, JUL_DEPOSIT, 0.30, 'base', '2026-07');
  assert.strictEqual(c.capBase, 210.26);
  assert.strictEqual(c.cap, 63.08);
  assert.strictEqual(c.refund, 63.08);
});
t('L2 podstawa depozytowa: 30% od 258,62 zł = 77,59 zł', () => {
  const c = V.refundCap(1000, JUL_DEPOSIT, 0.30, 'deposit', '2026-07');
  assert.strictEqual(c.cap, 77.59);
});
t('L3 różnica między interpretacjami to 23%', () => {
  const a = V.refundCap(1000, JUL_DEPOSIT, 0.30, 'base', '2026-07').cap;
  const b = V.refundCap(1000, JUL_DEPOSIT, 0.30, 'deposit', '2026-07').cap;
  assert.ok(Math.abs(b/a - 1.23) < 0.001, 'stosunek musi wynosić 1,23');
});
t('L4 zwrot nie przekracza niewykorzystanej kwoty', () => {
  const c = V.refundCap(20, JUL_DEPOSIT, 0.30, 'base', '2026-07');
  assert.strictEqual(c.refund, 20, 'zostaje tylko 20 zł, więc zwrot = 20, nie 63,08');
  assert.strictEqual(c.writtenOff, 0);
});
t('L5 nadwyżka ponad limit jest umarzana', () => {
  const c = V.refundCap(200, JUL_DEPOSIT, 0.30, 'base', '2026-07');
  assert.strictEqual(c.refund, 63.08);
  assert.strictEqual(c.writtenOff, 136.92);
});
t('L6 miesiąc sprzed 2025-02: mnożnik 1,0, więc obie podstawy równe', () => {
  const a = V.refundCap(1000, 100, 0.30, 'base', '2024-12');
  const b = V.refundCap(1000, 100, 0.30, 'deposit', '2024-12');
  assert.strictEqual(a.cap, 30);
  assert.strictEqual(b.cap, 30);
});
t('L7 RCEm 20% daje niższy limit niż RCE 30%', () => {
  const rce = V.refundCap(1000, JUL_DEPOSIT, 0.30, 'base', '2026-07').cap;
  const rcem = V.refundCap(1000, JUL_DEPOSIT, 0.20, 'base', '2026-07').cap;
  assert.ok(rcem < rce);
  assert.strictEqual(rcem, 42.05);
});
t('L8 domyślna stawka w stanie to 0.30 (RCE godzinowe)', () => {
  assert.ok(HTML.includes('refundRate: 0.30'));
});
t('L9 podstawa limitu jest utrwalana i odczytywana', () => {
  assert.ok(HTML.includes('refundCapBasis: state.refundCapBasis'), 'musi być w saveState');
  assert.ok(HTML.includes("state.refundCapBasis = parsed.refundCapBasis"), 'musi być w loadState');
});

const { CSV, skipBanner } = require('./fixture');
if (CSV) {
  console.log('  plik testowy: ' + CSV);
  console.log('\n=== F8: parser HA na REALNYM eksporcie ===');
  const raw = fs.readFileSync(CSV, 'utf8').replace(/^\uFEFF/, '');
  const rows = raw.split(/\r?\n/).filter(Boolean).map(l => l.split(','));
  logs.length = 0;
  const parsed = sandbox.parseHaStatisticsCsv(rows, 'bilans_growatt.csv');

  t('A1 odrzucono dokładnie 192 godziny', () => {
    assert.strictEqual(parsed.rejected.total, 192, 'otrzymano ' + parsed.rejected.total);
  });
  t('A2 188 ujemnych delt poboru', () => {
    assert.strictEqual(parsed.rejected.byRole.poborHa.negative, 188);
  });
  t('A3 4 przekroczenia progu', () => {
    assert.strictEqual(parsed.rejected.overLimitSamples.length, 4);
  });
  t('A4 lipiec: pobór po filtrze ≈ 70,5 kWh, nie 3019,7', () => {
    const jul = parsed.monthly['2026-07'];
    assert.ok(Math.abs(jul.poborHa - 70.5) < 0.2, 'otrzymano ' + jul.poborHa);
  });
  t('A5 kwiecień: pobór po filtrze ≈ 194,8 kWh, nie 41,2', () => {
    const apr = parsed.monthly['2026-04'];
    assert.ok(Math.abs(apr.poborHa - 194.8) < 0.5, 'otrzymano ' + apr.poborHa);
  });
  t('A6 produkcja lipca nie zawiera skoku 42,2 kWh', () => {
    const apr = parsed.monthly['2026-04'];
    assert.ok(Math.abs(apr.produkcja - (1241.7 - 42.2)) < 0.5, 'otrzymano ' + apr.produkcja);
  });
  t('A7 odrzucenia są ZALOGOWANE jako błąd', () => {
    assert.ok(logs.some(l => l.l === 'error' && /ODRZUCONO 192/.test(l.m)), 'brak komunikatu o odrzuceniach');
  });
  t('A8 duplikaty DST rozdzielone', () => {
    assert.ok(logs.some(l => /zduplikowanych godzin/.test(l.m)), 'brak informacji o DST');
  });

  console.log('\n=== F9: ponowny import NIE dubluje danych (S1) ===');
  function importInto(stateObj, parsed){
    Object.keys(parsed.monthly).forEach(function(mk){
      if (!stateObj.months[mk]) stateObj.months[mk] = {};
      const m = stateObj.months[mk], h = parsed.monthly[mk];
      m.haPobor = Math.round(h.poborHa*100)/100;
      m.haProdukcja = Math.round(h.produkcja*100)/100;
    });
  }
  const st1 = {months:{}};
  importInto(st1, parsed);
  const jul1 = st1.months['2026-07'].haPobor;
  const apr1 = st1.months['2026-04'].haProdukcja;
  importInto(st1, parsed);   // ten sam plik drugi raz
  t('A9 dwukrotny import: lipiec bez podwojenia', () => {
    assert.strictEqual(st1.months['2026-07'].haPobor, jul1);
  });
  t('A10 dwukrotny import: kwiecień bez podwojenia', () => {
    assert.strictEqual(st1.months['2026-04'].haProdukcja, apr1);
  });

  console.log('\n=== F16: miesięczny test baterii ===');
  sandbox.state.haHourly = parsed.hourly;
  sandbox.runBatteryValidation();
  t('B1 sierpień przechodzi (1,00× pojemność)', () => {
    const b = sandbox.state.haBatteryCheck['2026-08'];
    assert.ok(b.plausible, 'sierpień musi przejść');
    assert.ok(Math.abs(b.ratio - 1.0) < 0.05, 'ratio ' + b.ratio);
  });
  t('B2 wrzesień odrzucony (5,6×)', () => {
    const b = sandbox.state.haBatteryCheck['2026-09'];
    assert.ok(!b.plausible);
    assert.ok(Math.abs(b.ratio - 5.62) < 0.1, 'ratio ' + b.ratio);
  });
  t('B3 październik odrzucony (9,8×) i twardo niemożliwy', () => {
    const b = sandbox.state.haBatteryCheck['2026-10'];
    assert.ok(!b.plausible && b.hardImpossible);
    assert.ok(b.hardExcess > 100, 'nadmiar ' + b.hardExcess);
  });

  console.log('\n=== F16: szacunek ładowania z sieci ===');
  t('C1 sierpień = 0 kWh (brak ładowania z sieci)', () => {
    assert.strictEqual(sandbox.estimateGridCharge('2026-08').kwh, 0);
  });
  t('C2 wrzesień ≈ 62,5 kWh', () => {
    const g = sandbox.estimateGridCharge('2026-09');
    assert.ok(Math.abs(g.kwh - 62.5) < 0.5, 'otrzymano ' + g.kwh);
  });
  t('C3 październik ≈ 70,7 kWh i większość w dzień', () => {
    const g = sandbox.estimateGridCharge('2026-10');
    assert.ok(Math.abs(g.kwh - 70.7) < 0.5, 'otrzymano ' + g.kwh);
  });
  t('C4 wynik oznaczony jako szacunek', () => {
    assert.strictEqual(sandbox.estimateGridCharge('2026-10').estimated, true);
  });

} else {
  skipBanner('Testy frontendu na realnym eksporcie (A1–A10, B1–B3, C1–C4)');
}

console.log('\n=== F6: kompletność dnia przy zmianie czasu ===');
t('E1 dzień 25-godzinny wymaga 25 godzin', () => {
  sandbox.state.rceHourly = {};
  for (let h = 0; h < 24; h++) sandbox.state.rceHourly['2026-10-25_' + String(h).padStart(2, '0')] = 100;
  assert.strictEqual(sandbox.allHoursCoveredForDate('2026-10-25'), false, '24 h to za mało dla dnia 25-godzinnego');
});
t('E2 dzień 23-godzinny uznany za pełny przy 23 godzinach', () => {
  sandbox.state.rceHourly = {};
  for (let h = 0; h < 23; h++) sandbox.state.rceHourly['2026-03-29_' + String(h).padStart(2, '0')] = { date: '2026-03-29', v: 100 };
  assert.strictEqual(sandbox.allHoursCoveredForDate('2026-03-29'), true);
});

console.log('\n=== F14: XSS ===');
t('X1 escapeHtml neutralizuje wektor z nazwy strefy', () => {
  const evil = '"><img src=x onerror=alert(1)>';
  const out = V.escapeHtml(evil);
  assert.ok(!out.includes('<img'), 'tag musi być escaped');
  assert.ok(out.includes('&lt;img'), 'oczekiwano &lt;img');
});
t('X2 łatka XSS faktycznie jest w pliku', () => {
  assert.ok(HTML.includes("data-zone=\"' + zHtml + '\""), 'nazwa strefy musi być escaped w atrybucie');
  assert.ok(HTML.includes("'<th>Strefa ' + V.escapeHtml(z)"), 'nazwa strefy musi być escaped w nagłówku');
});
t('X3 SheetJS nie z CDN', () => {
  assert.ok(!HTML.includes('cdnjs.cloudflare.com'), 'CDN musi zniknąć');
  assert.ok(HTML.includes('vendor/xlsx.full.min.js'), 'lokalna kopia musi być');
});

console.log(`\n${pass} przeszło, ${fail} nie przeszło`);
module.exports = { pass, fail };
if (require.main === module) process.exit(fail ? 1 : 0);
