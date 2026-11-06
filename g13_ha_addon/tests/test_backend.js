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

// sprzątanie
fs.rmSync(TMP, { recursive: true, force: true });

Promise.all(pending).then(() => {
  console.log(`\n${pass} przeszło, ${fail} nie przeszło`);
  module.exports = { pass, fail };
  if (require.main === module) process.exit(fail ? 1 : 0);
});
