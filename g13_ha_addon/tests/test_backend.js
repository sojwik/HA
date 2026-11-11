'use strict';
/* Testy backendu: KV (P0-4), ha-ws (P0-3), walidacja query. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

let pass = 0, fail = 0;
/* t() musiało nauczyć się Promise'ów. Wcześniej wołało fn() bez await,
 * więc testy `async` (H3–H6) zgłaszały sukces NIEZALEŻNIE od wyniku —
 * odrzucony Promise był niezauważony. Teraz wynik jest awaitowany przed
 * podsumowaniem i przed process.exit(). */
const pending = [];
function t(name, fn) {
  let r;
  try { r = fn(); }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; return; }
  if (r && typeof r.then === 'function') {
    pending.push(r.then(
      () => { console.log('  ✓ ' + name); pass++; },
      (e) => { console.log('  ✗ ' + name + '\n      ' + (e && e.message ? e.message : e)); fail++; }
    ));
    return;
  }
  console.log('  ✓ ' + name); pass++;
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'g13kv-'));
process.env.DATA_DIR = TMP;
const kv = require('../app/lib/kv');

console.log('\n=== KV: P0-4 uszkodzony plik nie kasuje historii ===');

t('K1 świeży magazyn zwraca undefined', () => {
  assert.strictEqual(kv.get('nic'), undefined);
});

t('K2 zapis i odczyt', () => {
  kv.set('ledger', '{"a":1}');
  assert.strictEqual(kv.get('ledger'), '{"a":1}');
});

t('K3 uszkodzony JSON → kopia zapasowa ZACHOWANA', () => {
  kv.set('cenne', 'dane których nie wolno stracić');
  fs.writeFileSync(kv.KV_FILE, '{"cenne": "dane które', 'utf8');   // ucięty JSON
  const v = kv.get('cenne');
  assert.strictEqual(v, undefined, 'po uszkodzeniu magazyn jest pusty');
  const backups = fs.readdirSync(TMP).filter(f => f.includes('.corrupt-'));
  assert.ok(backups.length >= 1, 'musi powstać plik .corrupt-<ts>');
  const saved = fs.readFileSync(path.join(TMP, backups[0]), 'utf8');
  assert.ok(saved.includes('dane które'), 'kopia musi zawierać oryginalną treść');
});

t('K4 health() raportuje degradację', () => {
  const h = kv.health();
  assert.strictEqual(h.ok, false);
  assert.ok(h.degraded.backupPath, 'health musi podać ścieżkę kopii');
});

t('K5 zapis po degradacji nie kasuje kopii', () => {
  const before = fs.readdirSync(TMP).filter(f => f.includes('.corrupt-'));
  kv.set('nowy', 'x');
  const after = fs.readdirSync(TMP).filter(f => f.includes('.corrupt-'));
  assert.deepStrictEqual(before, after, 'kopia musi przetrwać kolejne zapisy');
  assert.strictEqual(kv.get('nowy'), 'x');
});

t('K6 pusty plik to legalny stan, nie uszkodzenie', () => {
  kv.clearDegraded();
  fs.writeFileSync(kv.KV_FILE, '', 'utf8');
  assert.deepStrictEqual(kv.list(), []);
  assert.strictEqual(kv.health().ok, true);
});

t('K7 tablica zamiast obiektu → traktowana jako uszkodzenie', () => {
  fs.writeFileSync(kv.KV_FILE, '[1,2,3]', 'utf8');
  kv.get('x');
  assert.strictEqual(kv.health().ok, false);
});

t('K8 plik .tmp nie zostaje po zapisie', () => {
  kv.clearDegraded();
  fs.writeFileSync(kv.KV_FILE, '{}', 'utf8');
  kv.set('a', 'b');
  assert.ok(!fs.existsSync(kv.KV_FILE + '.tmp'), 'tmp musi być przemianowany');
});

console.log('\n=== ha-ws: P0-3 nieprawidłowe daty nie wywracają procesu ===');
const haWs = require('../app/lib/ha-ws');

t('H1 asValidDate odrzuca śmieci', () => {
  assert.strictEqual(haWs.asValidDate('nie-jest-data'), null);
  assert.strictEqual(haWs.asValidDate(new Date('xyz')), null);
  assert.strictEqual(haWs.asValidDate(NaN), null);
  assert.strictEqual(haWs.asValidDate(''), null);
  assert.strictEqual(haWs.asValidDate(undefined), null);
});

t('H2 asValidDate przyjmuje poprawne', () => {
  assert.ok(haWs.asValidDate('2026-07-01') instanceof Date);
  assert.ok(haWs.asValidDate(new Date()) instanceof Date);
  assert.ok(haWs.asValidDate(Date.now()) instanceof Date);
});

t('H3 fetchStatistics odrzuca Invalid Date przez Promise, nie wyjątek', async () => {
  let threw = false;
  try {
    await haWs.fetchStatistics(['sensor.x'], new Date('śmieć'), new Date());
  } catch (e) {
    threw = true;
    assert.ok(/nieprawidłowa data początkowa/i.test(e.message), 'komunikat musi nazywać problem: ' + e.message);
  }
  assert.ok(threw, 'musi odrzucić Promise');
});

t('H4 pusta lista encji odrzucona', async () => {
  let threw = false;
  try { await haWs.fetchStatistics([], new Date(0), new Date()); }
  catch (e) { threw = true; assert.ok(/pusta/i.test(e.message)); }
  assert.ok(threw);
});

t('H5 start >= end odrzucone', async () => {
  let threw = false;
  const d = new Date('2026-07-01');
  try { await haWs.fetchStatistics(['sensor.x'], d, d); }
  catch (e) { threw = true; assert.ok(/wcześniejsza/i.test(e.message)); }
  assert.ok(threw);
});

t('H6 encja bez kropki odrzucona', async () => {
  let threw = false;
  try { await haWs.fetchStatistics(['bez_kropki'], new Date(0), new Date()); }
  catch (e) { threw = true; assert.ok(/entity_id/i.test(e.message)); }
  assert.ok(threw);
});

console.log('\n=== growatt-csv: DST i kolumny ===');
const { statisticsToCsv, toUtcKey, toWarsawString } = require('../app/lib/growatt-csv');

t('G1 dwie godziny 02:00 przy zmianie czasu mają RÓŻNE klucze UTC', () => {
  const a = Date.parse('2026-10-25T02:00:00+02:00');
  const b = Date.parse('2026-10-25T02:00:00+01:00');
  assert.notStrictEqual(toUtcKey(a), toUtcKey(b));
  assert.strictEqual(toWarsawString(a).slice(11, 16), '02:00');
  assert.strictEqual(toWarsawString(b).slice(11, 16), '02:00');
});

t('G2 CSV ma kolumnę start_utc', () => {
  const csv = statisticsToCsv({
    'sensor.x': [
      { start: Date.parse('2026-10-25T02:00:00+02:00'), sum: 10, change: 1 },
      { start: Date.parse('2026-10-25T02:00:00+01:00'), sum: 11, change: 1 },
    ],
  });
  const lines = csv.trim().split('\n');
  assert.strictEqual(lines[0], 'statistic_id,start,start_utc,sum,delta,delta_sum');
  assert.strictEqual(lines.length, 3, 'oba wiersze muszą przetrwać');
  const keys = lines.slice(1).map(l => l.split(',')[2]);
  assert.notStrictEqual(keys[0], keys[1]);
});

t('G3 północ nie daje „24:00”', () => {
  const s = toWarsawString(Date.parse('2026-01-15T00:00:00+01:00'));
  assert.ok(s.includes('00:00:00'), 'oczekiwano 00:00:00, jest: ' + s);
});

t('G4 delta z change, delta_sum z sum — osobno', () => {
  const csv = statisticsToCsv({
    'sensor.x': [
      { start: Date.parse('2026-07-01T10:00:00+02:00'), sum: 100, change: 5 },
      { start: Date.parse('2026-07-01T11:00:00+02:00'), sum: 103, change: 5 },
    ],
  });
  const row = csv.trim().split('\n')[2].split(',');
  assert.strictEqual(row[4], '5', 'delta = change');
  assert.strictEqual(row[5], '3', 'delta_sum = Δsum (103−100)');
});

t('G5 nieparsowalny timestamp pominięty, nie wyzerowany', () => {
  const csv = statisticsToCsv({ 'sensor.x': [{ start: 'śmieć', sum: 5, change: 5 }] });
  assert.strictEqual(csv.trim().split('\n').length, 1, 'tylko nagłówek');
});

console.log('\n=== anyStatsToCsv: eksport czujników chwilowych (JK-BMS) ===');
const { anyStatsToCsv } = require('../app/lib/growatt-csv');
const BMS_TS = Date.parse('2026-09-28T02:00:00+02:00');
// Encje BMS mają state_class: measurement, więc HA zwraca mean/min/max,
// a NIE change/sum. To jest cały powód, dla którego powstał ten eksport.
const BMS = { 'sensor.jkbms_current': [{ start: BMS_TS, mean: 5.4, min: 5.1, max: 5.9 }] };

t('G7 czujnik chwilowy (mean/min/max, bez change/sum) NIE jest odrzucany', () => {
  const csv = anyStatsToCsv(BMS, ['mean', 'min', 'max']);
  const rows = csv.trim().split('\n');
  assert.strictEqual(rows.length, 2, 'oczekiwano nagłówka + 1 wiersza, jest:\n' + csv);
  assert.strictEqual(rows[0], 'statistic_id,start,start_utc,mean,min,max');
  assert.ok(rows[1].includes('5.4,5.1,5.9'), rows[1]);
});

t('G8 statisticsToCsv ODRZUCA ten sam wiersz — dlatego potrzebny jest osobny eksport', () => {
  const csv = statisticsToCsv(BMS);
  assert.strictEqual(csv.trim().split('\n').length, 1, 'stary serializator powinien dać sam nagłówek');
});

t('G9 kolejność kolumn stała, niezależna od kolejności w "types"', () => {
  const a = anyStatsToCsv(BMS, ['max', 'mean', 'min']);
  const b = anyStatsToCsv(BMS, ['min', 'max', 'mean']);
  assert.strictEqual(a, b);
  assert.strictEqual(a.split('\n')[0], 'statistic_id,start,start_utc,mean,min,max');
});

t('G10 wiersz całkowicie pusty odpada, ale stan (state) wystarcza', () => {
  const csv = anyStatsToCsv({
    'sensor.x': [
      { start: BMS_TS },
      { start: BMS_TS + 3600000, state: 87 },
    ],
  }, ['mean', 'state']);
  const rows = csv.trim().split('\n');
  assert.strictEqual(rows.length, 2, csv);
  assert.ok(rows[1].endsWith(',87'), rows[1]);
});

t('G11 DST: dwie godziny 02:00 mają różne klucze UTC także w nowym eksporcie', () => {
  const csv = anyStatsToCsv({
    'sensor.x': [
      { start: Date.parse('2026-10-25T02:00:00+02:00'), mean: 1 },
      { start: Date.parse('2026-10-25T02:00:00+01:00'), mean: 2 },
    ],
  }, ['mean']);
  const rows = csv.trim().split('\n').slice(1);
  assert.strictEqual(rows.length, 2);
  assert.notStrictEqual(rows[0].split(',')[2], rows[1].split(',')[2]);
});

t('G12 fetchStatistics odrzuca niedozwolony typ statystyki', async () => {
  const haWs = require('../app/lib/ha-ws');
  let err = null;
  try { await haWs.fetchStatistics(['sensor.x'], new Date(0), new Date(1000), ['mean', 'median']); }
  catch (e) { err = e; }
  assert.ok(err, 'brak błędu dla typu "median"');
  assert.ok(/niedozwolone typy/i.test(err.message), err.message);
});


console.log('\n=== M: uzgodnienie źródeł baterii BMS vs Growatt (audyt cz. 12) ===');
const V = require('../app/lib/validate');   // ten zestaw dotąd nie używał walidatora
const RC = V.reconcileBatteryMonth;
const rcCfg = V.resolveConfig();

t('M1 brak BMS → zostaje Growatt, bez alarmu', () => {
  const r = RC({ charge: 100, discharge: 92, hours: 720 }, { charge: 0, discharge: 0, hours: 0 }, rcCfg);
  assert.strictEqual(r.source, 'growatt');
  assert.strictEqual(r.bmsAvailable, false);
  assert.strictEqual(r.suspect, false);
  assert.strictEqual(r.charge, 100);
  assert.strictEqual(r.discharge, 92);
});
t('M2 zgodne źródła → BMS nadrzędny, bez alarmu', () => {
  const r = RC({ charge: 562.7, discharge: 514.9, hours: 1104 },
               { charge: 562.2, discharge: 524.9, hours: 1104 }, rcCfg);
  assert.strictEqual(r.source, 'bms');
  assert.strictEqual(r.suspect, false, 'strata falownika 1,9% to nie usterka');
  assert.ok(Math.abs(r.chargeDeltaPct - 0.09) < 0.02, 'ΔCH ' + r.chargeDeltaPct);
  assert.ok(Math.abs(r.dischargeDeltaPct + 1.91) < 0.02, 'ΔDIS ' + r.dischargeDeltaPct);
});
t('M3 realne okno 25.09–10.10 → alarm i BMS wygrywa', () => {
  // Dokładne sumy z audytu cz. 12: 16 dób, Growatt 124,6/342,0, BMS 158,0/158,7.
  const r = RC({ charge: 124.6, discharge: 342.0, hours: 384 },
               { charge: 158.0, discharge: 158.7, hours: 384 }, rcCfg);
  assert.strictEqual(r.source, 'bms');
  assert.strictEqual(r.suspect, true);
  assert.ok(Math.abs(r.dischargeDeltaPct - 115.5) < 0.2, 'ΔDIS ' + r.dischargeDeltaPct);
  assert.ok(Math.abs(r.chargeDeltaPct + 21.14) < 0.05, 'ΔCH ' + r.chargeDeltaPct);
  assert.strictEqual(r.charge, 158.0);
  assert.strictEqual(r.discharge, 158.7);
  assert.ok(/BMS/.test(r.reason), 'powód musi nazywać użyte źródło');
});
t('M4 BMS pokrywa połowę miesiąca → NIE podmienia (zaniżyłoby sumę)', () => {
  const r = RC({ charge: 100, discharge: 92, hours: 720 },
               { charge: 50, discharge: 46, hours: 360 }, rcCfg);
  assert.strictEqual(r.source, 'growatt');
  assert.strictEqual(r.partial, true);
  assert.ok(/50%/.test(r.reason), r.reason);
  assert.strictEqual(r.charge, 100);
});
t('M5 Growatt bez godzin, BMS z godzinami → BMS jedynym źródłem', () => {
  const r = RC({ charge: 0, discharge: 0, hours: 0 },
               { charge: 10, discharge: 9, hours: 24 }, rcCfg);
  assert.strictEqual(r.source, 'bms');
  assert.strictEqual(r.charge, 10);
  assert.strictEqual(r.coverage, 1);
});
t('M6 próg 10%: 9% przechodzi, 11% łapie', () => {
  const base = { charge: 100, discharge: 100, hours: 100 };
  const ok = RC(Object.assign({}, base, { discharge: 109 }), base, rcCfg);
  const bad = RC(Object.assign({}, base, { discharge: 111 }), base, rcCfg);
  assert.strictEqual(ok.suspect, false, '9% to jeszcze tolerancja');
  assert.strictEqual(bad.suspect, true, '11% musi być oznaczone');
});
t('M7 śmieciowe wejścia nie dają NaN', () => {
  const r = RC({ charge: 'x', discharge: null, hours: undefined },
               { charge: NaN, discharge: undefined, hours: 'y' }, rcCfg);
  assert.strictEqual(r.source, 'growatt');
  assert.strictEqual(r.charge, 0);
  assert.strictEqual(r.bmsAvailable, false);
  assert.ok(r.chargeDeltaPct === null, 'Δ bez BMS musi być null, nie NaN');
});
t('M8 pokrycie dokładnie na progu 90% → podmienia', () => {
  const r = RC({ charge: 100, discharge: 92, hours: 100 },
               { charge: 90, discharge: 83, hours: 90 }, rcCfg);
  assert.strictEqual(r.source, 'bms', 'granica należy do ścieżki BMS');
  assert.strictEqual(r.partial, false);
});
t('M10 bateria stoi: BMS 0/0 to pomiar, a fantom Growatt jest alarmem', () => {
  const r = RC({ charge: 12, discharge: 64.8, hours: 72 },
               { charge: 0, discharge: 0, hours: 72 }, rcCfg);
  assert.strictEqual(r.bmsAvailable, true, 'godziny są dowodem pomiaru, nie suma');
  assert.strictEqual(r.source, 'bms');
  assert.strictEqual(r.charge, 0);
  assert.strictEqual(r.discharge, 0);
  assert.strictEqual(r.suspect, true, 'procent wobec zera jest nieokreślony, ale różnica jest realna');
  assert.ok(/64,8|64\.8/.test(r.reason), r.reason);
});
t('M11 realny październik z BMS: próg AC odrzuca, próg DC przyjmuje', () => {
  // 347,8 kWh naładowane / 338,3 rozładowane — pomiar DC, w pełni poprawny.
  const oct = { ladowanie: 347.8, rozladowanie: 338.3 };
  const asAc = V.validateBatteryTotal([oct], rcCfg);
  const asDc = V.validateBatteryTotal([Object.assign({}, oct, { eta: rcCfg.batteryEtaDc })], rcCfg);
  assert.strictEqual(asAc.impossible, true, 'przy 0,92 wychodzi fałszywy alarm');
  assert.ok(Math.abs(asAc.excess - 5.13) < 0.05, 'nadmiar AC ' + asAc.excess);
  assert.strictEqual(asDc.impossible, false, 'przy 0,94 miesiąc musi przejść');
  assert.ok(asDc.excess < 0, 'nadmiar DC ' + asDc.excess);
});
t('M12 bez nadpisania sprawności wynik identyczny jak przed zmianą', () => {
  const r = V.validateBatteryTotal([{ ladowanie: 2398.9, rozladowanie: 2442.1 }], rcCfg);
  assert.ok(Math.abs(r.maxDischarge - 0.92 * (2398.9 + 14.34)) < 0.01, 'max ' + r.maxDischarge);
  assert.ok(Math.abs(r.excess - 221.92) < 0.05, 'nadmiar ' + r.excess);
  assert.strictEqual(r.eta, 0.92);
  assert.strictEqual(r.impossible, true);
});
t('M13 suma miesza źródła: każdy miesiąc z własną sprawnością', () => {
  const r = V.validateBatteryTotal([
    { ladowanie: 100, rozladowanie: 90, eta: 0.94 },   // z BMS (DC)
    { ladowanie: 100, rozladowanie: 90, eta: 0.92 },   // z Growatt (AC)
  ], rcCfg);
  // Σ ηᵢ×CHᵢ + max(ηᵢ)×cap = 186 + 0,94×14,34 = 199,48
  assert.ok(Math.abs(r.maxDischarge - 199.48) < 0.01, 'max ' + r.maxDischarge);
  assert.strictEqual(r.eta, 0.93, 'sprawność efektywna ważona ładowaniem');
  assert.strictEqual(r.impossible, false);
});
t('M14 marzec: Growatt 4 h, BMS 350 h → bez alarmu, wygrywa BMS', () => {
  // Realny marzec 2026: eksport Growatt startuje 30.03 20:00, liczniki BMS
  // działają od ~17.03. To NIE jest usterka — to różne okresy pomiaru.
  const r = RC({ charge: 5.7, discharge: 6.7, hours: 4 },
               { charge: 152.7, discharge: 151.0, hours: 350 }, rcCfg);
  assert.strictEqual(r.source, 'bms');
  assert.strictEqual(r.suspect, false, 'różne pokrycie to nie usterka licznika');
  assert.strictEqual(r.comparable, false);
  assert.strictEqual(r.chargeDeltaPct, null, 'procent byłby fikcją');
  assert.strictEqual(r.dischargeDeltaPct, null);
  assert.strictEqual(r.partial, false, 'BMS ma WIĘCEJ godzin, nie mniej');
  assert.ok(/4 h/.test(r.reason) && /350 h/.test(r.reason), r.reason);
});
t('M15 odwrotnie: Growatt 350 h, BMS 4 h → zostaje Growatt, partial', () => {
  const r = RC({ charge: 152.7, discharge: 151.0, hours: 350 },
               { charge: 5.7, discharge: 6.7, hours: 4 }, rcCfg);
  assert.strictEqual(r.source, 'growatt');
  assert.strictEqual(r.partial, true);
  assert.strictEqual(r.suspect, false);
  assert.strictEqual(r.comparable, false);
});
t('M16 przy zgodnym pokryciu prawdziwa usterka NADAL jest łapana', () => {
  const r = RC({ charge: 325.2, discharge: 453.7, hours: 744 },
               { charge: 347.8, discharge: 338.3, hours: 744 }, rcCfg);
  assert.strictEqual(r.comparable, true);
  assert.strictEqual(r.suspect, true, 'październik +34,1% musi zostać alarmem');
  assert.ok(Math.abs(r.dischargeDeltaPct - 34.1) < 0.1, String(r.dischargeDeltaPct));
});
t('M9 próg konfigurowalny przez resolveConfig', () => {
  const strict = V.resolveConfig({ bmsTolerancePct: 1 });
  const r = RC({ charge: 100, discharge: 102, hours: 10 },
               { charge: 100, discharge: 100, hours: 10 }, strict);
  assert.strictEqual(r.suspect, true, '2% przy progu 1% musi być alarmem');
  assert.strictEqual(strict.bmsTolerancePct, 1);
  assert.strictEqual(V.resolveConfig().bmsMinCoverage, 0.90);
});


/* ===== F54: ekonomia magazynu po strefach + koszt alternatywny ===== */
const BE = V.batteryEconomicsMonth;
const ZR = { T1: 0.90, T2: 1.50, T3: 0.63 };
function hAt(hour, o) {
  return Object.assign({ date: '2026-07-01', hour: hour, produkcja: 0, ladowanie: 0, rozladowanie: 0 }, o || {});
}
t('M17 rozładowanie wyceniane po strefie godziny ODDANIA, nie płasko', () => {
  const r = BE([hAt(20, { rozladowanie: 2 }), hAt(2, { rozladowanie: 2 })],
    { zoneRates: ZR, zoneOf: (d, h) => (h === 20 ? 'T2' : 'T3'), rceOf: () => 400 });
  // 2 kWh × 1,50 + 2 kWh × 0,63 = 4,26 — płaska 0,63 dałaby 2,52
  assert.strictEqual(r.dischargePln, 4.26);
  assert.strictEqual(r.priced, true);
});
t('M18 utracony depozyt pomniejsza zysk przyrostowy', () => {
  const r = BE([hAt(12, { produkcja: 5, ladowanie: 4 }), hAt(20, { rozladowanie: 3.8 })],
    { zoneRates: ZR, zoneOf: (d, h) => (h === 20 ? 'T2' : 'T3'), rceOf: () => 500 });
  // brutto = 3,8 × 1,50 = 5,70; depozyt = 4 × 0,5 × 1,23 = 2,46
  assert.strictEqual(r.grossPln, 5.7);
  assert.strictEqual(r.lostDepositPln, 2.46);
  assert.strictEqual(r.incrementalPln, 3.24);
  assert.ok(r.incrementalPln < r.grossPln, 'przyrostowo musi być mniejsze od brutto');
});
t('M19 ujemne RCE nie powiększa kosztu alternatywnego', () => {
  const r = BE([hAt(12, { produkcja: 5, ladowanie: 4 }), hAt(20, { rozladowanie: 3.8 })],
    { zoneRates: ZR, zoneOf: () => 'T2', rceOf: () => -80 });
  assert.strictEqual(r.lostDepositPln, 0, 'ujemna cena → depozyt 0, nie ujemny koszt');
  assert.strictEqual(r.incrementalPln, r.grossPln);
});
t('M20 noc zeruje skażoną produkcję → ładowanie idzie z sieci', () => {
  // rejestr pokazuje 2 kWh "produkcji" o 23:00 przy rozładowaniu — to skażenie
  const r = BE([hAt(23, { produkcja: 2, ladowanie: 3 })],
    { zoneRates: ZR, zoneOf: () => 'T3', rceOf: () => 400 });
  assert.strictEqual(r.gridKwh, 3, 'w nocy całe ładowanie musi być z sieci');
  assert.strictEqual(r.pvChargeKwh, 0);
  assert.strictEqual(r.lostDepositPln, 0);
});
t('M21 brak stawek strefowych → brak wyceny, nie zero', () => {
  const r = BE([hAt(20, { rozladowanie: 3 })], { zoneRates: {}, zoneOf: () => 'T9' });
  assert.strictEqual(r.priced, false);
  assert.strictEqual(r.incrementalPln, null);
  assert.ok(/stawki strefowe/.test(r.reason), r.reason);
});
t('M22 brak RCE przy ładowaniu z PV → przyrostowo NULL, nie zawyżone brutto', () => {
  const r = BE([hAt(12, { produkcja: 5, ladowanie: 4 }), hAt(20, { rozladowanie: 3.8 })],
    { zoneRates: ZR, zoneOf: () => 'T2', rceOf: () => null });
  assert.strictEqual(r.priced, true, 'stawki są, więc brutto da się policzyć');
  assert.strictEqual(r.incrementalKnown, false);
  assert.strictEqual(r.incrementalPln, null, 'brakujący koszt nie może wyglądać jak zero');
  assert.ok(/RCE/.test(r.reason), r.reason);
  assert.strictEqual(r.pvChargeUnpriced, 4);
});
t('M23 bez ładowania z PV brak RCE nie blokuje wyniku', () => {
  const r = BE([hAt(20, { rozladowanie: 3 })],
    { zoneRates: ZR, zoneOf: () => 'T2', rceOf: () => null });
  assert.strictEqual(r.incrementalKnown, true, 'nie ma czego wyceniać po RCE');
  assert.strictEqual(r.incrementalPln, 4.5);
});
t('M24 współczynniki AC/DC skalują energię przed wyceną', () => {
  const r = BE([hAt(20, { rozladowanie: 10 })],
    { zoneRates: ZR, zoneOf: () => 'T2', rceOf: () => 400, scaleDischarge: 0.9520 });
  assert.strictEqual(r.discharge, 9.52);
  assert.strictEqual(r.dischargePln, 14.28);
});
t('M25 batteryAcDcFactors mierzy współczynniki z miesięcy zdrowych', () => {
  const f = V.batteryAcDcFactors([
    { growattCharge: 346.2, bmsCharge: 345.2, growattDischarge: 318.4, bmsDischarge: 333.5 },
    { growattCharge: 286.8, bmsCharge: 283.8, growattDischarge: 261.3, bmsDischarge: 273.9 },
    { growattCharge: 355.3, bmsCharge: 350.8, growattDischarge: 327.2, bmsDischarge: 344.3 },
    { growattCharge: 338.8, bmsCharge: 334.8, growattDischarge: 313.3, bmsDischarge: 330.1 },
  ]);
  assert.strictEqual(f.measured, true);
  assert.strictEqual(f.months, 4);
  assert.ok(Math.abs(f.charge - 1.0096) < 0.0002, String(f.charge));
  assert.ok(Math.abs(f.discharge - 0.9520) < 0.0002, String(f.discharge));
});
t('M26 batteryAcDcFactors bez danych → 1, nie zgadnięta stała', () => {
  const f = V.batteryAcDcFactors([]);
  assert.strictEqual(f.measured, false);
  assert.strictEqual(f.charge, 1);
  assert.strictEqual(f.discharge, 1);
});


/* ===== F50/F51: autokonsumpcja z jednego zbioru godzin ===== */
const SC = V.selfConsumptionMonth;
t('M27 autokonsumpcja = PV + rozład − ład − eksport, po strefie godziny', () => {
  const r = SC([hAt(12, { produkcja: 5, ladowanie: 4 }), hAt(20, { rozladowanie: 3.8 })],
    { zoneRates: ZR, zoneOf: (d, h) => (h === 12 ? 'T1' : 'T2'),
      exportOf: (d, h) => (h === 12 ? 1 : 0) });
  // 12:00 → 5+0−4−1 = 0 kWh ; 20:00 → 0+3,8−0−0 = 3,8 kWh × 1,50
  assert.strictEqual(r.kwh, 3.8);
  assert.strictEqual(r.pln, 5.7);
  assert.strictEqual(r.hours, 2);
});
t('M28 brak eksportu z eLicznika → godzina POMINIĘTA, nie zero', () => {
  const r = SC([hAt(12, { produkcja: 5 }), hAt(20, { rozladowanie: 3.8 })],
    { zoneRates: ZR, zoneOf: () => 'T2', exportOf: (d, h) => (h === 12 ? null : 0) });
  assert.strictEqual(r.hours, 1, 'godzina bez eksportu nie może wejść z zerem');
  assert.strictEqual(r.kwh, 3.8);
});
t('M29 noc zeruje skażoną produkcję w autokonsumpcji', () => {
  const r = SC([hAt(23, { produkcja: 2, rozladowanie: 3 })],
    { zoneRates: ZR, zoneOf: () => 'T3', exportOf: () => 0 });
  assert.strictEqual(r.kwh, 3, 'fałszywe 2 kWh PV nie może wejść');
});
t('M30 brak stawek strefowych → pln NULL, nie wycena zerowa', () => {
  const r = SC([hAt(20, { rozladowanie: 3.8 })],
    { zoneRates: {}, zoneOf: () => 'T9', exportOf: () => 0 });
  assert.strictEqual(r.priced, false);
  assert.strictEqual(r.pln, null);
  assert.ok(/stawki strefowe/.test(r.reason), r.reason);
});
t('M31 eksport ujemny nie podnosi autokonsumpcji', () => {
  const r = SC([hAt(12, { produkcja: 5 })],
    { zoneRates: ZR, zoneOf: () => 'T1', exportOf: () => -2 });
  assert.strictEqual(r.kwh, 5, 'max(0, eksport) — ujemny nie dodaje');
});


/* ===== F56: realna energia w odrzuconych godzinach ===== */
const RI = V.rejectionImpact;
// Klucze odrzuconych godzin w czasie LOKALNYM, tak jak eLicznik.
function rk(role, date, hour){ return { role, date, hour }; }
function elRow(imp, exp){ return { poborPoZbil: imp, oddaniePoZbil: exp }; }

t('M36 rejectionImpact odtwarza zmierzona energie, nie sume odrzuconych delt', () => {
  // Odrzucone delty to -153,6 kWh; licznik rozliczeniowy pokazuje 3,51 kWh.
  // Komunikat ma pokazywac 3,51, bo tyle realnie pominięto.
  const keys = [rk('poborHa','2026-04-05',11), rk('poborHa','2026-04-06',12)];
  const el = { '2026-04-05_11': elRow(1.75,0), '2026-04-06_12': elRow(1.76,0) };
  const r = RI(keys, el);
  assert.strictEqual(r.known, true);
  assert.strictEqual(r.matched, 2);
  assert.strictEqual(r.kwh, 3.51);
});

t('M37 brak eLicznika → known=false, nie "zero energii"', () => {
  const r = RI([rk('poborHa','2026-04-05',11)], {});
  assert.strictEqual(r.known, false, 'brak pomiaru nie moze wygladac jak zero');
  assert.strictEqual(r.matched, 0);
  assert.ok(/pokrywa 0%/.test(r.reason), r.reason);
});

t('M38 null/pusty pomiar nie wchodzi jako zero (Number(null) === 0)', () => {
  const keys = [rk('poborHa','2026-04-05',11), rk('poborHa','2026-04-05',12),
                rk('poborHa','2026-04-05',13)];
  const el = { '2026-04-05_11': elRow(2.5,0),
               '2026-04-05_12': elRow(null,0),
               '2026-04-05_13': elRow('',0) };
  const r = RI(keys, el);
  assert.strictEqual(r.matched, 1, 'null i "" to brak pomiaru, nie 0 kWh');
  assert.strictEqual(r.kwh, 2.5);
  assert.strictEqual(r.known, false, 'pokrycie 1/3 < 90%');
});

t('M39 produkcja i bateria nie maja odpowiednika w eLiczniku', () => {
  const keys = [rk('produkcja','2026-07-01',12), rk('ladowanie','2026-07-01',13)];
  const r = RI(keys, { '2026-07-01_12': elRow(9,9) });
  assert.strictEqual(r.mapped, 0, 'nie wolno weryfikowac PV licznikiem sieci');
  assert.strictEqual(r.known, false);
  assert.ok(/nie maja odpowiednika/.test(r.reason), r.reason);
});

t('M40 oddanieHa czyta eksport, nie import', () => {
  const r = RI([rk('oddanieHa','2026-07-01',12)], { '2026-07-01_12': elRow(7.5, 2.25) });
  assert.strictEqual(r.kwh, 2.25, 'pomylona kolumna zawyzyloby wynik 3×');
  assert.strictEqual(r.byRole.oddanieHa.kwh, 2.25);
});

t('M41 pokrycie mieszane: czesc godzin bez pomiaru obniża known', () => {
  const keys = []; const el = {};
  for (let h = 0; h < 10; h++){
    keys.push(rk('poborHa','2026-04-05',h));
    if (h < 8) el['2026-04-05_' + String(h).padStart(2,'0')] = elRow(0.1, 0);
  }
  const r = RI(keys, el);
  assert.strictEqual(r.matched, 8);
  assert.strictEqual(r.coverage, 0.8);
  assert.strictEqual(r.known, false, '80% < 90% — nie wolno podawac jako pewne');
  assert.strictEqual(r.kwh, 0.8);
});

t('M42 createRejectionLog zapisuje klucze w czasie LOKALNYM (nie UTC)', () => {
  const rej = V.createRejectionLog();
  const cfg = V.resolveConfig();
  // 2026-07-01 00:30 lokalnie = 2026-06-30 22:30 UTC. Klucz musi byc 07-01_00.
  const ms = Date.UTC(2026, 5, 30, 22, 30);
  const v = V.acceptDelta('poborHa', -1.5, null, ms, cfg);
  assert.strictEqual(v.ok, false);
  rej.add('poborHa', ms, -1.5, v);
  const s = rej.summary();
  assert.strictEqual(s.rejectedKeys.length, 1);
  assert.strictEqual(s.rejectedKeys[0].date, '2026-07-01', 'UTC daloby 06-30');
  assert.strictEqual(s.rejectedKeys[0].hour, 0);
  assert.ok(s.byMonth['2026-07'], 'miesiac tez lokalny');
  assert.strictEqual(s.byMonth['2026-07'].keys.length, 1);
});

t('M43 pusty log → known=false bez wyjatku', () => {
  const r = RI([], {});
  assert.strictEqual(r.hours, 0);
  assert.strictEqual(r.known, false);
  assert.strictEqual(r.kwh, 0);
  const r2 = RI(null, null);
  assert.strictEqual(r2.known, false, 'null nie moze wywrócić renderu');
});


/* ===== F58: drugi magazyn, tylko przyrost względem resztkowego eLicznika ===== */
const XB = V.simulateAdditionalBattery;
function xh(date, hour, imp, exp, rest) {
  return Object.assign({ date, hour, poborPoZbil:imp, oddaniePoZbil:exp,
    hasImport:true, hasExport:true, rate:1.5, rce:400 }, rest || {});
}
function xs(rows, opts) {
  return XB(rows, Object.assign({ capacityKwh:5, efficiency:1, includeHourly:true,
    rateOf:(_d,_h,r)=>r.rate, rceOf:(_d,_h,r)=>r.rce }, opts || {}));
}
function xn(actual, expected, eps=1e-8) {
  assert.ok(typeof actual === 'number' && Math.abs(actual-expected)<eps, actual+' != '+expected);
}
const xPair = () => [xh('2026-07-01',12,0,5), xh('2026-07-01',13,3,0)];

t('X1 dodatkowe 0 kWh = dokładnie 0 efektu, nawet bez cen', () => {
  const z=xs(xPair(),{capacityKwh:0, rateOf:()=>null,rceOf:()=>null});
  xn(z.total.chargeKwh,0); xn(z.total.dischargeKwh,0); xn(z.total.netPln,0);
  xn(z.total.newImportKwh,z.total.oldImportKwh); xn(z.total.newExportKwh,z.total.oldExportKwh);
});
t('X2 pusty start nie daje darmowego rozładowania przed pierwszym eksportem', () => {
  const r=xs([xh('2026-07-01',11,3,0),xh('2026-07-01',12,0,5)]);
  xn(r.total.dischargeKwh,0); xn(r.total.newImportKwh,3);
  assert.ok(r.total.netPln<0, 'energia na końcu nie jest jeszcze oszczędnością');
});
t('X3 limit DODATKOWEJ pojemności, bez dodawania 14,34 kWh pierwszej baterii', () => {
  const r=xs([xh('2026-07-01',12,0,5),xh('2026-07-01',13,5,0)],{capacityKwh:2});
  xn(r.total.chargeKwh,2); xn(r.total.dischargeKwh,2);
  xn(r.total.newExportKwh,3); xn(r.total.newImportKwh,3);
});
t('X4 cykl 81%: 10 kWh AC wchodzi, 8,1 kWh wychodzi, straty 1,9 kWh', () => {
  const r=xs([xh('2026-07-01',12,0,10),xh('2026-07-01',13,10,0)],{capacityKwh:10,efficiency:.81});
  xn(r.total.chargeKwh,10); xn(r.total.dischargeKwh,8.1); xn(r.total.lossKwh,1.9);
  xn(r.total.endSocKwh,0); xn(r.total.balanceErrorKwh,0);
});
t('X5 osobne limity mocy AC ograniczają godzinę, nie pojemność', () => {
  const r=xs(xPair(),{chargeKw:2,dischargeKw:1});
  xn(r.total.chargeKwh,2); xn(r.total.dischargeKwh,1); xn(r.total.endSocKwh,1);
});
t('X6 limit mocy 0 to blokada kierunku, nie Infinity', () => {
  const a=xs(xPair(),{chargeKw:0}), b=xs(xPair(),{dischargeKw:0});
  xn(a.total.chargeKwh,0); xn(a.total.netPln,0);
  xn(b.total.dischargeKwh,0); assert.ok(b.total.netPln<0);
});
t('X7 dane pierwszego magazynu/BMS nie są doliczane drugi raz', () => {
  const rows=xPair(); const before=JSON.stringify(rows);
  const a=xs(rows);
  const b=xs(rows.map(r=>Object.assign({},r,{ladowanie:1000,rozladowanie:2000,produkcja:9999})),
    {existingCapacityKwh:500, existingProfitPln:999999,batCostPln:5000});
  assert.deepStrictEqual(a.total,b.total); assert.strictEqual(JSON.stringify(rows),before);
});
t('X8 SOC przechodzi przez granicę miesiąca; koszt w ładowaniu, zysk w rozładowaniu', () => {
  const r=xs([xh('2026-06-30',23,0,4,{rce:500}),xh('2026-07-01',0,3,0)]);
  xn(r.months['2026-06'].endSocKwh,4); xn(r.months['2026-07'].startSocKwh,4);
  xn(r.months['2026-06'].netPln,-2.46); xn(r.months['2026-07'].netPln,4.5);
  xn(r.total.netPln,2.04); assert.strictEqual(r.gapCount,0);
  Object.values(r.months).forEach(m=>xn(m.balanceErrorKwh,0));
});
t('X9 zakup po strefie godziny rozładowania, depozyt po cenie godziny ładowania', () => {
  const r=xs([xh('2026-07-01',18,0,5,{rce:400,rate:.9}),
    xh('2026-07-01',19,1,0,{rce:9999,rate:1.5}), xh('2026-07-01',20,2,0,{rce:9999,rate:.63})]);
  xn(r.total.purchaseSavingsPln,2.76); xn(r.total.lostDepositPln,2.46); xn(r.total.netPln,.30);
});
t('X10 RCE 0 jest znaną ceną; ujemne RCE zgodnie z Depozytem daje 0', () => {
  [0,-500].forEach(price=>{
    const r=xs([xh('2026-07-01',12,0,2,{rce:price}),xh('2026-07-01',13,2,0)]);
    assert.strictEqual(r.total.netKnown,true); xn(r.total.lostDepositPln,0); xn(r.total.netPln,3);
  });
});
t('X11 null/puste/undefined RCE nie może udawać darmowego ładowania', () => {
  [null,'',undefined].forEach(price=>{
    const r=xs(xPair(),{rceOf:()=>price});
    assert.strictEqual(r.total.lostDepositPln,null); assert.strictEqual(r.total.netPln,null);
    xn(r.total.unpricedChargeKwh,5);
  });
});
t('X12 brak G13 to nieznany zakup, nigdy stawka zastępcza', () => {
  [null,'',undefined].forEach(rate=>{
    const r=xs(xPair(),{rateOf:()=>rate,manualRatePlnKwh:9});
    assert.strictEqual(r.total.purchaseSavingsPln,null); assert.strictEqual(r.total.netPln,null);
    xn(r.total.unpricedDischargeKwh,3);
  });
});
t('X13 ceny zbędne przy zerowych ZMIANACH przepływów', () => {
  const r=xs([xh('2026-07-01',12,0,0)],{rateOf:()=>null,rceOf:()=>null});
  assert.strictEqual(r.total.netKnown,true); xn(r.total.netPln,0);
});
t('X14 nawet 90% pokrycia RCE nie wystarcza do pełnego wyniku rozbudowy', () => {
  const rows=Array.from({length:10},(_,h)=>xh('2026-07-01',h,0,.1,{rce:h===9?null:400}));
  rows.push(xh('2026-07-01',10,2,0)); const r=xs(rows);
  xn(r.total.unpricedChargeKwh,.1); assert.strictEqual(r.total.netKnown,false);
});
t('X15 luka odcina SOC — nie teleportuje darmowej energii przez brak danych', () => {
  const r=xs([xh('2026-07-01',12,0,4),xh('2026-07-01',14,3,0)]);
  xn(r.total.dischargeKwh,0); xn(r.total.discardedKwh,4); xn(r.total.balanceErrorKwh,0);
  assert.strictEqual(r.gapHours,1); assert.strictEqual(r.gapCount,1); assert.strictEqual(r.annualNetPln,null);
});
t('X16 znane godziny zerowe nie przerywają SOC', () => {
  const rows=Array.from({length:8},(_,i)=>xh('2026-07-01',12+i,0,0));
  rows[0].oddaniePoZbil=4; rows[7].poborPoZbil=3;
  const r=xs(rows); xn(r.total.dischargeKwh,3); assert.strictEqual(r.gapCount,0);
});
t('X17 wiosenna zmiana czasu 01->03 to ciągłość, nie luka', () => {
  const r=xs([xh('2026-03-29',1,0,4),xh('2026-03-29',3,3,0)]);
  assert.strictEqual(r.gapCount,0); assert.strictEqual(r.total.hours,2); xn(r.total.dischargeKwh,3);
});
t('X18 jesienna podwójna godzina bez przepływów jest neutralna (2 h)', () => {
  const r=xs([xh('2026-10-25',1,0,4),xh('2026-10-25',2,0,0),xh('2026-10-25',3,3,0)]);
  assert.strictEqual(r.gapCount,0); assert.strictEqual(r.total.hours,4);
  assert.strictEqual(r.dstNeutralKeys,1); xn(r.total.dischargeKwh,3); assert.strictEqual(r.total.netKnown,true);
});
t('X19 jesienna podwójna godzina Z przepływem: nie zgadujemy kolejności/ceny', () => {
  const r=xs([xh('2026-10-25',1,0,4),xh('2026-10-25',2,0,2),xh('2026-10-25',3,3,0)]);
  assert.strictEqual(r.total.badHours,2); assert.strictEqual(r.total.netPln,null);
  xn(r.total.dischargeKwh,0); xn(r.total.discardedKwh,4);
});
t('X20 jednoczesny import i eksport przerywa model, nie tworzy cyklu w ciemno', () => {
  const r=xs([xh('2026-07-01',12,0,4),xh('2026-07-01',13,2,2),xh('2026-07-01',14,3,0)]);
  assert.strictEqual(r.total.badHours,1); assert.strictEqual(r.total.netPln,null); xn(r.total.dischargeKwh,0);
});
t('X21 brak energii lub brak kierunku w nowym imporcie to nie zero', () => {
  [null,'',undefined,-1,NaN].forEach(val=>{
    const r=xs([xh('2026-07-01',12,val,2)]);
    assert.ok(r.total.badHours>0); assert.strictEqual(r.total.netPln,null);
  });
  const r=xs([xh('2026-07-01',12,0,2,{hasImport:false})]);
  assert.strictEqual(r.total.badHours,1); assert.strictEqual(r.total.netPln,null);
});
t('X22 duplikat godziny nie może podwoić ładowania', () => {
  const r=xs([xh('2026-07-01',12,0,2),xh('2026-07-01',12,0,2),xh('2026-07-01',13,4,0)]);
  assert.strictEqual(r.duplicateKeys,1); xn(r.total.chargeKwh,0); assert.strictEqual(r.total.netPln,null);
});
t('X23 chronologia niezależna od kolejności wejścia, bez mutowania tablicy', () => {
  const rows=xPair().reverse().map(Object.freeze); Object.freeze(rows);
  assert.deepStrictEqual(xs(rows).total,xs(xPair()).total);
  assert.strictEqual(rows[0].hour,13);
});
t('X24 niepoprawne parametry/daty blokują wynik zamiast cichego defaultu', () => {
  [{capacityKwh:null},{capacityKwh:-1},{efficiency:0},{efficiency:1.1},
    {chargeKw:-1},{dischargeKw:'x'},{startDate:'2026-07-32'},
    {startDate:'2026-08-01',endDate:'2026-07-01'}].forEach(o=>assert.strictEqual(xs(xPair(),o).valid,false));
});
t('X25 zakres dat zaczyna od pustego SOC, nie wnosi energii sprzed okresu', () => {
  const r=xs([xh('2026-06-30',23,0,4),xh('2026-07-01',0,3,0)],{startDate:'2026-07-01'});
  assert.strictEqual(r.firstDate,'2026-07-01'); xn(r.total.chargeKwh,0); xn(r.total.dischargeKwh,0);
});
t('X26 kapitał obu magazynów nie zmienia przepływów ani zysku okresu', () => {
  assert.deepStrictEqual(xs(xPair(),{costPln:2000,batCostPln:5000}).total,
    xs(xPair(),{costPln:20000,batCostPln:9999}).total);
});
t('X27 przeliczenie roczne po godzinach dopiero od 720 h, nie po liczbie miesięcy', () => {
  const rows=Array.from({length:720},(_,h)=>{
    const dt=new Date(Date.UTC(2026,3,1)+h*3600000);
    return xh(dt.toISOString().slice(0,10),dt.getUTCHours(),h===1?1:0,h===0?1:0);
  });
  const r=xs(rows); assert.strictEqual(r.total.hours,720); xn(r.annualNetPln,1.008*8760/720);
  assert.strictEqual(xs(rows.slice(0,719)).annualNetPln,null);
  const gap=rows.filter((_,i)=>i!==100); assert.strictEqual(xs(gap).annualNetPln,null);
});
t('X28 bilans i ograniczenia na 1000 deterministycznych godzinach z lukami', () => {
  let seed=58; function rnd(){seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;}
  const rows=[];
  for(let h=0;h<1000;h++){
    if(h%109===108)continue;
    const dt=new Date(Date.UTC(2026,5,1)+h*3600000), exp=rnd()>.48;
    const n=rnd()*9;
    rows.push(xh(dt.toISOString().slice(0,10),dt.getUTCHours(),exp?0:n,exp?n:0));
  }
  const r=xs(rows,{capacityKwh:7.3,efficiency:.88,chargeKw:3.2,dischargeKw:2.4});
  xn(r.total.balanceErrorKwh,0,1e-7);
  Object.values(r.months).forEach(m=>xn(m.balanceErrorKwh,0,1e-7));
  r.hourly.forEach(h=>{
    assert.ok(h.socKwh>=-1e-8 && h.socKwh<=7.3+1e-8);
    assert.ok(h.chargeKwh<=Math.min(h.oldExportKwh,3.2)+1e-8);
    assert.ok(h.dischargeKwh<=Math.min(h.oldImportKwh,2.4)+1e-8);
    assert.ok(h.newImportKwh>=-1e-8 && h.newExportKwh>=-1e-8);
  });
  assert.ok(r.total.dischargeKwh<=r.total.chargeKwh*.88+1e-8);
});
t('X29 wysoka cena sprzedaży może dać ujemny wynik — nie wymuszamy opłacalności', () => {
  const rows=[xh('2026-07-01',12,0,2,{rce:1500}),xh('2026-07-01',13,2,0,{rate:.63})];
  const r=xs(rows); xn(r.total.netPln,1.26-3.69); assert.ok(r.total.netPln<0);
});
t('X30 depozyt ×1,23 tylko od obowiązującej daty, nie zaszyty dla każdego roku', () => {
  const r=xs([xh('2025-01-01',12,0,2,{rce:500}),xh('2025-01-01',13,2,0)]);
  xn(r.total.lostDepositPln,1);
});
t('X31 brak danych wejściowych nie staje się prognozą z zerowym zyskiem', () => {
  const r=xs(null); assert.strictEqual(r.total.netPln,null); assert.strictEqual(r.annualNetPln,null);
  assert.ok(/Brak/.test(r.reason));
});
t('X32 nieistniejąca godzina wiosenna/niepoprawna data są wykrywane', () => {
  const r=xs([xh('2026-03-29',2,0,4),xh('2026-02-30',12,0,4)]);
  assert.strictEqual(r.invalidRows,2); assert.strictEqual(r.total.netPln,null);
});

t('X33 jesienne 0,034+0,039 kWh importu: ta sama strefa, bez wiążącego limitu mocy', () => {
  const rows=[xh('2026-10-25',1,0,4),xh('2026-10-25',2,.073,0,{rate:.63}),xh('2026-10-25',3,0,0)];
  [null,.1,0].forEach(power=>{
    const r=xs(rows,{dischargeKw:power});
    assert.strictEqual(r.total.netKnown,true); assert.strictEqual(r.total.hours,4);
    xn(r.total.dischargeKwh,power===0?0:.073);
    xn(r.total.purchaseSavingsPln,(power===0?0:.073)*.63);
  });
  const limited=xs(rows,{dischargeKw:.05});
  assert.strictEqual(limited.total.netPln,null,'bez podziału na obie godziny limit 0,05 kW jest niejednoznaczny');
  xn(xs(rows,{capacityKwh:0}).total.netPln,0);
});

t('X34 dodatkowe 0 kWh także w jesiennej godzinie eksportu daje zero, nie cenę z domysłu', () => {
  const r=xs([xh('2026-10-25',2,0,3)],{capacityKwh:0,rceOf:()=>null});
  xn(r.total.netPln,0); xn(r.total.newExportKwh,3); assert.strictEqual(r.dstImportKeys,0);
});

// sprzątanie
fs.rmSync(TMP, { recursive: true, force: true });

Promise.all(pending).then(() => {
  console.log(`\n${pass} przeszło, ${fail} nie przeszło`);
  module.exports = { pass, fail };
  if (require.main === module) process.exit(fail ? 1 : 0);
});
