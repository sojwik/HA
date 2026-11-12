'use strict';
// WYŁĄCZNIE syntetyczne dane. Automatyka nie oznacza zgadywania braków.
const assert = require('assert');
const D = require('../app/public/pv-data'), F = require('./pv-fixture');
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log('  ✓ ' + name); } catch (e) { failed++; console.error('  ✗ ' + name + '\n' + e.stack); } }
const clone = x => JSON.parse(JSON.stringify(x));
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
const make = patch => F.data(F.settings({ gridSource: 'auto', ...patch }));
const grid = f => D.parseGridCsvFiles([{ name: 'synthetic.csv', text: F.gridCsv(f.shared.hourlyElicznik) }]);
const prepare = (f, csv) => D.prepare(f.series, f.settings, f.shared, csv);
const key = h => '2026-09-01_' + String(h).padStart(2, '0');
function freeze(x) { if (x && typeof x === 'object') { Object.values(x).forEach(freeze); Object.freeze(x); } return x; }

test('PA01 nowa karta domyślnie auto; stare wybory migrują jawnie tylko w kopii', () => {
  assert.deepStrictEqual(D.restoreGridSelection(null), { gridSource: 'auto', gridPolicyVersion: 1, migrated: false });
  for (const old of [{}, { gridSource: 'csv' }, { gridSource: 'shared' }]) {
    const before = JSON.stringify(old); const n = D.restoreGridSelection(old);
    assert.strictEqual(n.gridSource, 'auto'); assert.strictEqual(n.migrated, true); assert.strictEqual(JSON.stringify(old), before);
  }
});
test('PA02 zapisane nowe jawne tryby zachowane, nieznana wersja/tryb bez fallback', () => {
  for (const source of ['auto', 'shared', 'csv']) assert.deepStrictEqual(D.restoreGridSelection({ gridSource: source, gridPolicyVersion: 1 }),
    { gridSource: source, gridPolicyVersion: 1, migrated: false });
  assert.throws(() => D.restoreGridSelection({ gridSource: 'bad' }), /źródło/);
  assert.throws(() => D.restoreGridSelection({ gridSource: 'auto', gridPolicyVersion: 99 }), /wersja/);
});
test('PA03 kompletne dane dodatku bez żadnego CSV ani sieci', () => {
  const f = make(), p = prepare(f); assert.ok(p.ok);
  assert.deepStrictEqual(p.diagnostics.grid.selection, { sharedBlocks: 24, csvBlocks: 0, unresolvedBlocks: 0 });
  assert.strictEqual(p.diagnostics.grid.csv, null);
});
test('PA04 744 stare rekordy + wcześniej zapisany CSV → kompletność bez dopisywania flag', () => {
  const f = make({ startDate: '2026-05-01', endDate: '2026-05-31' }), csv = grid(f), good = prepare(f);
  for (const r of Object.values(f.shared.hourlyElicznik)) { delete r.hasImport; delete r.hasExport; }
  const before = JSON.stringify(f.shared), p = prepare(f, csv);
  assert.ok(p.ok); assert.strictEqual(p.diagnostics.grid.selection.csvBlocks, 744);
  assert.strictEqual(p.diagnostics.grid.shared.missingImportFlags, 744); assert.deepStrictEqual(p.rows, good.rows);
  assert.strictEqual(JSON.stringify(f.shared), before);
});
test('PA05 auto łączy okresy per cały rekord, nigdy nie podwaja źródeł', () => {
  const f = make(), csv = grid(f), expected = prepare(f); csv.rows = csv.rows.slice(0, 12);
  for (let h = 0; h < 12; h++) { delete f.shared.hourlyElicznik[key(h)].hasImport; delete f.shared.hourlyElicznik[key(h)].hasExport; }
  const p = prepare(f, csv); assert.ok(p.ok); assert.deepStrictEqual(p.rows, expected.rows);
  assert.deepStrictEqual(p.diagnostics.grid.selection, { sharedBlocks: 12, csvBlocks: 12, unresolvedBlocks: 0 });
});
test('PA06 stare liczby bez flag i bez CSV nadal nieznane, brak nie staje się 0', () => {
  const f = make(); for (const r of Object.values(f.shared.hourlyElicznik)) { delete r.hasImport; delete r.hasExport; }
  const p = prepare(f); assert.ok(!p.ok); assert.strictEqual(p.diagnostics.errorCount, 24);
  assert.strictEqual(p.diagnostics.grid.selection.unresolvedBlocks, 24); assert.ok(p.rows.every(r => r.loadAcKwh === null));
});
test('PA07 dwa niepełne źródła nie składają poboru z jednego i eksportu z drugiego', () => {
  const f = make(), csv = grid(f);
  for (const r of Object.values(f.shared.hourlyElicznik)) r.hasExport = false;
  for (const r of csv.rows) { r.hasImport = false; r.importCount = 0; r.poborPoZbil = null; }
  const p = prepare(f, csv); assert.ok(!p.ok); assert.strictEqual(p.diagnostics.grid.selected.validBlocks, 0);
  assert.ok(p.rows.every(r => r.gridMeasuredImportKwh === null && r.gridMeasuredExportKwh === null));
});
test('PA08 zmierzone zero wymaga true, string/false/brak nie jest dowodem', () => {
  const f = make(); for (let h = 0; h < 3; h++) f.shared.hourlyElicznik[key(h)].hasImport = [false, 'true', undefined][h];
  const p = prepare(f); assert.strictEqual(p.diagnostics.grid.selection.unresolvedBlocks, 3);
  near(p.rows[3].gridMeasuredImportKwh, 0); assert.strictEqual(p.rows[0].gridMeasuredImportKwh, null);
});
test('PA09 błędny typ liczby nie jest konwertowany, pełny CSV może zastąpić cały rekord', () => {
  const f = make(), csv = grid(f); f.shared.hourlyElicznik[key(0)].poborPoZbil = '0';
  assert.ok(!prepare(f).ok); const p = prepare(f, csv); assert.ok(p.ok);
  assert.strictEqual(p.diagnostics.grid.selection.csvBlocks, 1); assert.strictEqual(f.shared.hourlyElicznik[key(0)].poborPoZbil, '0');
});
test('PA10 konflikt pełnych liczb blokuje auto mimo kompletności, bez wyboru wygodniejszej', () => {
  const f = make(), csv = grid(f); csv.rows[20].poborPoZbil += 1;
  const p = prepare(f, csv); assert.ok(!p.ok); assert.strictEqual(p.diagnostics.grid.selected.validBlocks, 24);
  assert.strictEqual(p.diagnostics.grid.conflictingBlocks, 1); const d = p.diagnostics.grid.conflictDetails[0];
  assert.strictEqual(d.key, key(20)); assert.deepStrictEqual(d.fields, ['poborPoZbil']); near(d.shared.poborPoZbil, 3); near(d.csv.poborPoZbil, 4);
});
test('PA11 konflikt ze starym bezflagowym zapisem także blokuje', () => {
  const f = make(), csv = grid(f); delete f.shared.hourlyElicznik[key(20)].hasImport; csv.rows[20].poborPoZbil += 1;
  const p = prepare(f, csv); assert.ok(!p.ok); assert.ok(p.issues.some(r => r.code === 'grid_source_conflict'));
});
test('PA12 konflikt stref nie jest ukryty wyborem źródła', () => {
  const f = make(), csv = grid(f); csv.rows[0].strefa = 'T3'; const p = prepare(f, csv);
  assert.ok(!p.ok); assert.deepStrictEqual(p.diagnostics.grid.conflictDetails[0].fields, ['strefa']);
});
test('PA13 poza wybranym zakresem konflikt nie blokuje danego przebiegu', () => {
  const f = make({ endDate: '2026-09-02' }), csv = grid(f); csv.rows[25].poborPoZbil += 1;
  f.settings.endDate = '2026-09-01'; const p = prepare(f, csv); assert.ok(p.ok); assert.strictEqual(p.diagnostics.grid.conflictingBlocks, 0);
});
test('PA14 identyczne pełne źródła: pierwszeństwo dodatku, brak podwojenia', () => {
  const f = make(), csv = grid(f), p = prepare(f, csv); assert.deepStrictEqual(p.rows, prepare(f).rows);
  assert.strictEqual(p.diagnostics.grid.selection.sharedBlocks, 24); assert.strictEqual(p.diagnostics.grid.selection.csvBlocks, 0);
});
test('PA15 brak strefy dodatku: cały kompletny CSV ze strefą zamiast doklejania pola', () => {
  const f = make(), csv = grid(f); f.shared.hourlyElicznik[key(20)].strefa = null;
  const p = prepare(f, csv); assert.ok(p.ok); near(p.rows[20].buyPlnKwh, 1.5);
  assert.strictEqual(p.diagnostics.grid.selection.csvBlocks, 1); assert.strictEqual(f.shared.hourlyElicznik[key(20)].strefa, null);
});
test('PA16 ręczny CSV bez fallback, ręczny shared ignoruje CSV jawnie', () => {
  const f = make(), csv = grid(f); csv.rows.shift(); f.settings.gridSource = 'csv';
  assert.ok(!prepare(f, csv).ok); f.settings.gridSource = 'shared'; assert.ok(prepare(f, csv).ok);
  delete f.shared.hourlyElicznik[key(1)].hasImport; assert.ok(!prepare(f, csv).ok);
  f.settings.gridSource = 'auto'; assert.ok(prepare(f, csv).ok);
});
test('PA17 uszkodzony CSV nie ukrywa się za kompletnym shared', () => {
  const f = make(), csv = grid(f); csv.rows[0].hasImport = false;
  assert.throws(() => prepare(f, csv), /kompletność/);
});
test('PA18 jesień: same flagi shared nie dowodzą dwóch rekordów, auto korzysta z CSV', () => {
  const f = make({ startDate: '2026-10-25', endDate: '2026-10-25', allowDstAggregation: true }), csv = grid(f);
  const r = f.shared.hourlyElicznik['2026-10-25_02']; delete r.expectedCount; delete r.importCount; delete r.exportCount;
  let p = prepare(f); assert.ok(!p.ok); assert.strictEqual(p.diagnostics.grid.shared.unconfirmedDstBlocks, 1);
  p = prepare(f, csv); assert.ok(p.ok); assert.strictEqual(p.diagnostics.grid.selection.csvBlocks, 1);
  assert.strictEqual(p.rows[2].durationHours, 2); assert.strictEqual(p.rows[2].rcePlnMwh, null); assert.strictEqual(p.hourly.length, 25);
});
test('PA19 jesienny CSV z jednym rekordem kierunku nie potwierdza kroku 2 h', () => {
  const f = make({ startDate: '2026-10-25', endDate: '2026-10-25', allowDstAggregation: true }), csv = grid(f);
  delete f.shared.hourlyElicznik['2026-10-25_02']; csv.rows[2].importCount = 1; csv.rows[2].hasImport = false;
  const p = prepare(f, csv); assert.ok(!p.ok); assert.strictEqual(p.diagnostics.grid.selected.unconfirmedDstBlocks, 1);
});
test('PA20 dwa potwierdzone rekordy nie zastępują osobnej zgody na przybliżenie DST', () => {
  const f = make({ startDate: '2026-10-25', endDate: '2026-10-25' }), p = prepare(f, grid(f));
  assert.ok(!p.ok); assert.ok(p.issues.some(r => r.code === 'dst_aggregate' && r.severity === 'error'));
});
test('PA21 wiosna 23 h — nie tworzy sztucznego braku i źródła 02', () => {
  const f = make({ startDate: '2026-03-29', endDate: '2026-03-29' }), p = prepare(f, grid(f));
  assert.ok(p.ok); assert.strictEqual(p.diagnostics.grid.selection.sharedBlocks, 23); assert.ok(!p.rows.some(r => r.key.endsWith('_02')));
});
test('PA22 zmiana trybu grid nie wymusza pobierania identycznej historii HA', () => {
  const f = make(); const sig = D.signature(f.settings);
  f.settings.gridSource = 'csv'; assert.strictEqual(D.signature(f.settings), sig);
});
test('PA23 zamrożone źródła, series i ustawienia pozostają bitowo nietknięte', () => {
  const f = make(), csv = grid(f); delete f.shared.hourlyElicznik[key(0)].hasImport;
  const before = JSON.stringify([f, csv]); freeze(f); freeze(csv); assert.ok(prepare(f, csv).ok);
  assert.strictEqual(JSON.stringify([f, csv]), before);
});
test('PA24 wszystkie sześć syntetycznych ujemnych H ma pełne składniki i UTC, bez wycinania', () => {
  const f = make();
  for (const h of [0, 1, 2, 3, 4, 5]) f.shared.hourlyElicznik[key(h)].oddaniePoZbil = 2 + h / 10;
  const p = prepare(f); assert.ok(!p.ok); assert.strictEqual(p.diagnostics.negativeHouseBlocks, 6); assert.strictEqual(p.rows.length, 24);
  assert.strictEqual(p.negativeHouseDetails.length, 6);
  for (const r of p.negativeHouseDetails) {
    near(r.acOutputKwh + r.gridImportKwh - r.gridExportKwh - r.acChargeKwh, r.houseKwh);
    near(r.endTs - r.ts, F.HOUR); assert.strictEqual(r.reason, 'export_exceeds_supply'); assert.strictEqual(r.gridSource, 'shared');
    near(p.rows.find(x => x.key === r.key).loadAcKwh, r.houseKwh);
  }
});
test('PA25 ujemne H przez licznik AC nie jest min(AC, import) ani korektą BMS', () => {
  const f = make(); f.series[f.settings.entities.acCharge][1].change = 3; f.shared.hourlyElicznik[key(0)].poborPoZbil = 1;
  F.sumSeries(f.series); const p = prepare(f), r = p.negativeHouseDetails[0];
  near(r.acChargeKwh, 3); near(r.beforeAcChargeKwh, 1); near(r.houseKwh, -2); assert.strictEqual(r.reason, 'charge_exceeds_remainder');
  near(p.hourly[0].bmsCharge, 0); near(p.hourly[0].residual, 3);
});
test('PA26 mała ujemna wartość H także pozostaje blokadą, nie próg reszty R', () => {
  const f = make(); f.shared.hourlyElicznik[key(0)].oddaniePoZbil = .000001;
  const p = prepare(f); assert.ok(!p.ok); near(p.negativeHouseDetails[0].houseKwh, -.000001);
});
test('PA27 brak składnika pozostaje null, bez pozornej pełnej tabeli H', () => {
  const f = make(); f.series[f.settings.entities.acOutput][1].change = null;
  const p = prepare(f); assert.ok(!p.ok); assert.strictEqual(p.rows[0].loadAcKwh, null); assert.strictEqual(p.negativeHouseDetails.length, 0);
});
test('PA28 tryb niezależnego domu nie odejmuje automatycznie składników H', () => {
  const e = F.settings().entities, f = make({ loadMode: 'meter', entities: { ...e, house: 'sensor.test_house' } });
  f.shared.hourlyElicznik[key(0)].oddaniePoZbil = 5; const p = prepare(f);
  assert.ok(p.ok); assert.strictEqual(p.negativeHouseDetails.length, 0); near(p.rows[0].loadAcKwh, 0);
});
test('PA29 pochodzenie H pokazuje CSV jeśli stare flagi brakują, reszta R niezmieniona', () => {
  const f = make(); f.shared.hourlyElicznik[key(0)].oddaniePoZbil = 2;
  const csv = grid(f), expected = prepare(f); delete f.shared.hourlyElicznik[key(0)].hasExport;
  const p = prepare(f, csv); assert.strictEqual(p.negativeHouseDetails[0].gridSource, 'csv');
  near(p.negativeHouseDetails[0].houseKwh, -2); near(p.diagnostics.residualSumKwh, expected.diagnostics.residualSumKwh);
  assert.deepStrictEqual(p.rows, expected.rows);
});
test('PA30 aktualizacja wspólnej migawki zostaje odczytana przy kolejnym obliczeniu', () => {
  const f = make(), csv = grid(f); delete f.shared.hourlyElicznik[key(0)].hasImport;
  assert.strictEqual(prepare(f, csv).diagnostics.grid.selection.csvBlocks, 1);
  f.shared.hourlyElicznik[key(0)].hasImport = true;
  assert.strictEqual(prepare(f, csv).diagnostics.grid.selection.csvBlocks, 0);
});
test('PA31 tylko jawnie brakujące źródła są nieznane, nie ma wartości z miesięcznych sum', () => {
  const f = make(); f.shared.hourlyElicznik = {}; f.shared.months = { '2026-09': { kwh: 10000 } };
  const p = prepare(f); assert.ok(!p.ok); assert.strictEqual(p.diagnostics.grid.selected.missingRows, 24);
  assert.strictEqual(p.historical['2026-09'].values.gridImportKwh.totalKwh, null);
});
console.log(`\nPV automatic sources: ${passed} przeszło, ${failed} nie przeszło`); process.exitCode = failed ? 1 : 0;
