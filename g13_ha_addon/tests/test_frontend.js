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
  'classifyGrowattHaSensor', 'applyBmsEntityMap', 'parseHaStatisticsCsv', 'estimateGridCharge',
  'hourlyDepositValue', 'addMonths', 'allHoursCoveredForDate', 'extractHourFromApiRecord',
  'runBatteryValidation', 'round2', 'formatMonthLabel', 'computeTranches'];

const logs = [];
const sandbox = {
  V, validateCfg: V.resolveConfig(), console, bmsEntityMap: {},
  state: { haHourly: {}, haBatteryCheck: {}, haRejected: {}, bmsCheck: {}, rceHourly: {}, months: {}, refundRate: 0.30, refundCapBasis: 'base' },
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
  t('B1 sierpień przechodzi (1,14× pojemności nominalnej, tolerancja 20%)', () => {
    const b = sandbox.state.haBatteryCheck['2026-08'];
    assert.ok(b.plausible, 'sierpień musi przejść');
    assert.ok(Math.abs(b.ratio - 1.14) < 0.05, 'ratio ' + b.ratio);
  });
  t('B2 wrzesień odrzucony (6,4×)', () => {
    const b = sandbox.state.haBatteryCheck['2026-09'];
    assert.ok(!b.plausible);
    assert.ok(Math.abs(b.ratio - 6.41) < 0.1, 'ratio ' + b.ratio);
  });
  t('B3 październik odrzucony (9,8×) i twardo niemożliwy', () => {
    const b = sandbox.state.haBatteryCheck['2026-10'];
    assert.ok(!b.plausible && b.hardImpossible);
    assert.ok(b.hardExcess > 100, 'nadmiar ' + b.hardExcess);
  });

  console.log('\n=== D6: bilans ZBIORCZY (wiersz SUMA) ===');
  // Regresja: SUMA pokazywała 2452,3 kWh rozładowania z 2409,9 kWh ładowania
  // bez żadnego komentarza. Test miesięczny tego nie łapie, bo nadmiar
  // narasta dopiero w całym okresie.
  // Agregujemy z haHourly — w tym miejscu testu state.months nie ma jeszcze
  // przepisanych sum HA, a haHourly jest ustawione przez runBatteryValidation.
  const monthSums = {};
  Object.keys(sandbox.state.haHourly).forEach(k => {
    let c = 0, d = 0;
    sandbox.state.haHourly[k].forEach(h => { c += h.ladowanie || 0; d += h.rozladowanie || 0; });
    monthSums[k] = { ladowanie: c, rozladowanie: d };
  });
  const tot = V.validateBatteryTotal(Object.values(monthSums), V.resolveConfig());
  t('B4 bilans zbiorczy realnych danych jest niemożliwy', () => {
    assert.ok(tot.impossible, 'SUMA musi być oznaczona: ' + JSON.stringify(tot));
    assert.ok(tot.discharge > tot.charge, 'rozładowanie > ładowanie');
    assert.ok(tot.excess > 200 && tot.excess < 240, 'nadmiar ' + tot.excess);
  });
  t('B5 podzbiór wiarygodny domyka się przy η=0,92', () => {
    const trusted = Object.keys(monthSums).filter(k => {
      const bc = sandbox.state.haBatteryCheck[k];
      return !bc || bc.plausible;
    }).map(k => monthSums[k]);
    const tr = V.validateBatteryTotal(trusted, V.resolveConfig());
    assert.ok(!tr.impossible, 'wiarygodne miesiące nie mogą być niemożliwe');
    const eff = tr.discharge / tr.charge;
    assert.ok(Math.abs(eff - 0.92) < 0.01, 'sprawność podzbioru ' + eff.toFixed(4));
  });
  t('B6 start z pełnej paczki NIE jest fałszywym alarmem', () => {
    // 10 kWh naładowane, 20 kWh oddane, paczka 14,34 → max 0,92×24,34 = 22,4
    const r = V.validateBatteryTotal([{ ladowanie: 10, rozladowanie: 20 }], V.resolveConfig());
    assert.ok(!r.impossible, 'krótki okres z pełnym startem musi przejść: ' + JSON.stringify(r));
  });
  t('B7 pusty okres nie jest alarmem', () => {
    const r = V.validateBatteryTotal([], V.resolveConfig());
    assert.ok(!r.impossible);
    assert.strictEqual(r.months, 0);
  });

  console.log('\n=== F37: kompletność miesiąca (marzec 2026 = 743 h) ===');
  t('K1 marzec 2026 ma 743 h (zmiana czasu 29.03)', () => {
    let sum = 0;
    for (let d = 1; d <= 31; d++) sum += V.expectedHoursInDay('2026-03-' + String(d).padStart(2, '0'));
    assert.strictEqual(sum, 743, 'otrzymano ' + sum);
  });
  t('K2 październik 2026: 745 godzin rzeczywistych, 744 unikalne etykiety', () => {
    let real = 0, labels = 0;
    for (let d = 1; d <= 31; d++) {
      const e = V.expectedHoursInDay('2026-10-' + String(d).padStart(2, '0'));
      real += e; labels += Math.min(24, e);
    }
    assert.strictEqual(real, 745, 'rzeczywiste ' + real);
    // Kompletność eLicznika musi liczyć etykiety, inaczej październik
    // co miesiąc dostawałby fałszywe ostrzeżenie o brakującej godzinie.
    assert.strictEqual(labels, 744, 'etykiety ' + labels);
  });

  console.log('\n=== F31: odrzucenia MUSZĄ być podzielone na miesiące ===');
  // Regresja: wcześniej state.haRejected[mk] = parsed.rejected (jeden globalny
  // obiekt), więc 192 h pokazywało się w każdym z 9 miesięcy -> nagłówek 1728 h.
  t('R1 suma miesięcy równa się sumie globalnej', () => {
    const bm = parsed.rejected.byMonth;
    assert.ok(bm, 'brak byMonth');
    const sum = Object.values(bm).reduce((a, b) => a + b.total, 0);
    assert.strictEqual(sum, parsed.rejected.total, sum + ' != ' + parsed.rejected.total);
  });
  t('R2 miesiące NIE mają identycznych liczników', () => {
    const counts = Object.values(parsed.rejected.byMonth).map(b => b.total);
    assert.ok(new Set(counts).size > 1, 'wszystkie miesiące mają tyle samo: ' + counts);
  });
  t('R3 lipiec niesie prawie całość odrzuconych kWh', () => {
    const bm = parsed.rejected.byMonth;
    assert.ok(bm['2026-07'].rejectedKwh > 2900, 'lipiec ' + bm['2026-07'].rejectedKwh);
    assert.ok(Math.abs(bm['2026-04'].rejectedKwh) < 200, 'kwiecień ' + bm['2026-04'].rejectedKwh);
  });
  t('R4 sierpień/wrzesień/październik bez odrzuceń godzinowych', () => {
    const bm = parsed.rejected.byMonth;
    ['2026-08', '2026-09', '2026-10'].forEach(function(mk){
      assert.ok(!bm[mk] || bm[mk].total === 0, mk + ' ma ' + (bm[mk] && bm[mk].total));
    });
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


console.log('\n=== N: BMS jako źródło nadrzędne baterii (F41–F43) ===');
const GW_CH = 'sensor.growatt_battery_battery_charge_total';
const GW_DIS = 'sensor.growatt_battery_battery_discharge_total';
const BMS_CH = 'sensor.woda_lfp_charging_total';
const BMS_DIS = 'sensor.woda_lfp_discharging_total';

/* CSV w formacie backendu. Godziny UTC, etykieta lokalna +02:00 (październik
 * przed zmianą czasu), żeby monthKeyFromUtc trafiał w ten sam miesiąc. */
function bmsCsv(series, hours){
  const lines = ['statistic_id,start,start_utc,sum,delta,delta_sum'];
  const t0 = Date.UTC(2026, 9, 1, 0);
  series.forEach(function(s){
    let sum = 0;
    for (let i = 0; i < hours; i++){
      const ts = t0 + i * 3600000;
      const v = Array.isArray(s[1]) ? s[1][i] : s[1];
      sum += v;
      const utc = new Date(ts).toISOString().slice(0, 19) + 'Z';
      const loc = new Date(ts + 2 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
      lines.push([s[0], loc, utc, sum.toFixed(4), v, v].join(','));
    }
  });
  return lines.join('\n') + '\n';
}
function parseCsvSimple(text){
  return text.trim().split('\n').map(function(l){ return l.split(','); });
}
function runParse(series, hours, withBms){
  sandbox.applyBmsEntityMap(withBms === false ? {} : { bmsChargeEntity: BMS_CH, bmsDischargeEntity: BMS_DIS });
  return sandbox.parseHaStatisticsCsv(parseCsvSimple(bmsCsv(series, hours)), 'test-bms.csv');
}

t('N1 klasyfikator: BMS osobno, Growatt bez zmian, obcy → null', () => {
  sandbox.applyBmsEntityMap({ bmsChargeEntity: BMS_CH, bmsDischargeEntity: BMS_DIS });
  assert.strictEqual(sandbox.classifyGrowattHaSensor(BMS_CH), 'bmsLadowanie');
  assert.strictEqual(sandbox.classifyGrowattHaSensor(BMS_DIS), 'bmsRozladowanie');
  assert.strictEqual(sandbox.classifyGrowattHaSensor(GW_CH), 'ladowanie');
  assert.strictEqual(sandbox.classifyGrowattHaSensor('sensor.cokolwiek'), null);
  sandbox.applyBmsEntityMap({});
  assert.strictEqual(sandbox.classifyGrowattHaSensor(BMS_CH), null, 'bez konfiguracji BMS jest obcy');
});
t('N2 pełne pokrycie: miesiąc liczy się z BMS, Growatt zachowany do porównania', () => {
  const p = runParse([[GW_CH, 0.2], [GW_DIS, 0.9], [BMS_CH, 0.25], [BMS_DIS, 0.45]], 72);
  const m = p.monthly['2026-10'];
  assert.ok(Math.abs(m.ladowanie - 72 * 0.25) < 1e-6, 'ładowanie ' + m.ladowanie);
  assert.ok(Math.abs(m.rozladowanie - 72 * 0.45) < 1e-6, 'rozładowanie ' + m.rozladowanie);
  assert.ok(Math.abs(m.growattLadowanie - 72 * 0.2) < 1e-6, 'ślad Growatt musi zostać');
  assert.ok(Math.abs(m.growattRozladowanie - 72 * 0.9) < 1e-6);
  assert.strictEqual(p.bms['2026-10'].source, 'bms');
});
t('N3 oba źródła NIE są sumowane', () => {
  const p = runParse([[GW_CH, 0.2], [GW_DIS, 0.9], [BMS_CH, 0.25], [BMS_DIS, 0.45]], 72);
  const m = p.monthly['2026-10'];
  assert.ok(Math.abs(m.bmsLadowanie - 72 * 0.25) < 1e-6, 'BMS trzymany osobno');
  assert.ok(m.ladowanie < 72 * 0.45, 'gdyby sumowało, byłoby 0,45/h');
});
t('N4 godziny też podmienione — suma godzin równa sumie miesiąca', () => {
  const p = runParse([[GW_CH, 0.2], [GW_DIS, 0.9], [BMS_CH, 0.25], [BMS_DIS, 0.45]], 72);
  const hs = p.hourly['2026-10'];
  let c = 0, d = 0;
  hs.forEach(function(h){ c += h.ladowanie; d += h.rozladowanie; });
  assert.ok(Math.abs(c - p.monthly['2026-10'].ladowanie) < 1e-6, 'godziny ' + c);
  assert.ok(Math.abs(d - p.monthly['2026-10'].rozladowanie) < 1e-6);
  assert.ok(Math.abs(hs[0].rozladowanie - 0.45) < 1e-9, 'godzinowa wartość musi być z BMS');
});
t('N5 usterka Growatt wykryta i zalogowana jako błąd', () => {
  const before = logs.length;
  const p = runParse([[GW_CH, 0.2], [GW_DIS, 0.9], [BMS_CH, 0.25], [BMS_DIS, 0.45]], 72);
  assert.strictEqual(p.bms['2026-10'].suspect, true);
  assert.ok(Math.abs(p.bms['2026-10'].dischargeDeltaPct - 100) < 0.01,
    'ΔDIS ' + p.bms['2026-10'].dischargeDeltaPct);
  assert.ok(logs.slice(before).some(function(l){ return l.l === 'error' && /Kontrola krzyżowa/.test(l.m); }),
    'rozbieżność musi być widoczna w logu');
});
t('N6 luka w BMS: godzina uzupełniona z Growatt, nie wyzerowana', () => {
  const bCh = new Array(72).fill(0.25); bCh[10] = 0;
  const bDis = new Array(72).fill(0.45); bDis[10] = 0;
  // Godzina 10 istnieje w BMS z zerem, ale usuńmy ją z CSV zupełnie:
  const lines = ['statistic_id,start,start_utc,sum,delta,delta_sum'];
  const t0 = Date.UTC(2026, 9, 1, 0);
  [[GW_CH, 0.2], [GW_DIS, 0.9], [BMS_CH, 0.25], [BMS_DIS, 0.45]].forEach(function(s){
    let sum = 0;
    for (let i = 0; i < 72; i++){
      const isBms = s[0] === BMS_CH || s[0] === BMS_DIS;
      if (isBms && i === 10) continue;
      const ts = t0 + i * 3600000;
      sum += s[1];
      const utc = new Date(ts).toISOString().slice(0, 19) + 'Z';
      const loc = new Date(ts + 2 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
      lines.push([s[0], loc, utc, sum.toFixed(4), s[1], s[1]].join(','));
    }
  });
  sandbox.applyBmsEntityMap({ bmsChargeEntity: BMS_CH, bmsDischargeEntity: BMS_DIS });
  const p = sandbox.parseHaStatisticsCsv(parseCsvSimple(lines.join('\n') + '\n'), 'luka.csv');
  const dec = p.bms['2026-10'];
  assert.strictEqual(dec.source, 'bms', 'pokrycie 71/72 = 98,6% > 90%');
  assert.strictEqual(dec.hoursFromGrowatt, 1, 'dokładnie jedna godzina z Growatt');
  assert.strictEqual(dec.hoursFromBms, 71);
  const gap = p.hourly['2026-10'].filter(function(h){ return h.ts === t0 + 10 * 3600000; })[0];
  assert.ok(Math.abs(gap.rozladowanie - 0.9) < 1e-9, 'luka musi zostać z Growatt, nie zero');
});
t('N7 BMS podlega temu samemu progowi mocy co Growatt', () => {
  const absurd = new Array(72).fill(0.25); absurd[5] = 500;   // 500 kWh/h przy 14,6 kW
  const p = runParse([[GW_CH, 0.2], [GW_DIS, 0.9], [BMS_CH, absurd], [BMS_DIS, 0.45]], 72);
  assert.ok(p.rejected.byRole.bmsLadowanie, 'odrzucenie musi być przypisane roli BMS');
  assert.strictEqual(p.rejected.byRole.bmsLadowanie.count, 1);
  assert.ok(p.monthly['2026-10'].bmsLadowanie < 100, '500 kWh nie może wejść do sumy');
});
t('N8 BMS wyłączony → zachowanie identyczne jak przed zmianą', () => {
  const p = runParse([[GW_CH, 0.2], [GW_DIS, 0.9]], 72, false);
  const m = p.monthly['2026-10'];
  assert.ok(Math.abs(m.ladowanie - 72 * 0.2) < 1e-6);
  assert.ok(Math.abs(m.rozladowanie - 72 * 0.9) < 1e-6);
  assert.strictEqual(p.bms['2026-10'].source, 'growatt');
  assert.strictEqual(p.bms['2026-10'].bmsAvailable, false);
});
t('N9 zerowe godziny to nadal pomiar, nie brak pokrycia', () => {
  // Pierwsza doba bateria stoi: OBA kanały 0. Liczenie pokrycia z wartości
  // niezerowych zaniżyłoby je do 48/72 = 67% i cofnęło miesiąc do Growatt.
  const bCh = new Array(72).fill(0);
  const bDis = new Array(72).fill(0.45);
  for (let i = 0; i < 24; i++) bDis[i] = 0;
  const p = runParse([[GW_CH, 0.2], [GW_DIS, 0.9], [BMS_CH, bCh], [BMS_DIS, bDis]], 72);
  const dec = p.bms['2026-10'];
  assert.strictEqual(dec.bmsHours, 72, 'zero nie może obniżać pokrycia');
  assert.strictEqual(dec.source, 'bms');
  assert.strictEqual(p.monthly['2026-10'].ladowanie, 0);
  assert.ok(Math.abs(p.monthly['2026-10'].rozladowanie - 48 * 0.45) < 1e-6);
});
t('N10 bateria stoi cały miesiąc: fantom Growatt nie wchodzi do rozliczenia', () => {
  const zero = new Array(72).fill(0);
  const p = runParse([[GW_CH, 0.2], [GW_DIS, 0.9], [BMS_CH, zero], [BMS_DIS, zero]], 72);
  const dec = p.bms['2026-10'];
  assert.strictEqual(dec.source, 'bms');
  assert.strictEqual(dec.suspect, true, 'Growatt 64,8 kWh przy BMS 0 kWh to usterka');
  assert.strictEqual(p.monthly['2026-10'].rozladowanie, 0);
  assert.ok(Math.abs(p.monthly['2026-10'].growattRozladowanie - 64.8) < 1e-6, 'ślad Growatt zostaje');
});

console.log('\n=== F48: strażnik danych PV w szacunku ładowania z sieci ===');
function seedGridMonth(mk, pvHours, totalHours, chargePerHour){
  const t0 = Date.UTC(2026, 2, 17, 0);
  sandbox.state.haHourly[mk] = [];
  for (let i = 0; i < totalHours; i++){
    sandbox.state.haHourly[mk].push({ts: t0 + i*3600000, produkcja: 0,
      ladowanie: chargePerHour, rozladowanie: 0});
  }
  sandbox.state.months[mk] = {haPvHours: pvHours, haLadowanie: chargePerHour*totalHours,
    haHours: totalHours};
}
t('N11 brak danych PV → szacunek NIEWIARYGODNY, nie pełny', () => {
  // Realny marzec: 4 h z pomiarem produkcji na ~350 h ładowania z BMS.
  seedGridMonth('2026-03', 4, 350, 0.44);
  const g = sandbox.estimateGridCharge('2026-03');
  assert.strictEqual(g.reliable, false, 'przy 4/350 h PV nie wolno ufać szacunkowi');
  assert.ok(g.pvCoverage < 0.02, 'pokrycie ' + g.pvCoverage);
  assert.strictEqual(g.pvHours, 4);
});
t('N12 pełne dane PV → szacunek bez zmian', () => {
  seedGridMonth('2026-08', 744, 744, 0.1);
  const g = sandbox.estimateGridCharge('2026-08');
  assert.strictEqual(g.reliable, true);
  assert.strictEqual(g.pvCoverage, 1);
  assert.ok(Math.abs(g.kwh - 74.4) < 0.01, 'kwh ' + g.kwh);
});
t('N13 miesiąc bez ładowania nie potrzebuje danych PV', () => {
  seedGridMonth('2026-06', 0, 720, 0);
  const g = sandbox.estimateGridCharge('2026-06');
  assert.strictEqual(g.reliable, true, 'nie ma czego szacować');
  assert.strictEqual(g.kwh, 0);
});
t('N14 stan sprzed 0.3.1 (brak haPvHours) nie wywraca miesiąca', () => {
  seedGridMonth('2026-05', 700, 744, 0.2);
  delete sandbox.state.months['2026-05'].haPvHours;
  const g = sandbox.estimateGridCharge('2026-05');
  assert.strictEqual(g.pvCoverage, null);
  assert.strictEqual(g.reliable, true, 'brak informacji to nie dowód usterki');
});
t('N15 eksport encji prosi o change i sum, nie tylko mean', () => {
  assert.ok(HTML.includes("qs.set('types', 'mean,min,max,change,sum')"),
    'liczniki energii potrzebują change — mean z licznika to nie energia');
});

console.log(`\n${pass} przeszło, ${fail} nie przeszło`);
module.exports = { pass, fail };
if (require.main === module) process.exit(fail ? 1 : 0);
