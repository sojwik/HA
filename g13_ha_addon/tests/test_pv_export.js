'use strict';
// Wszystkie dane w tym zestawie są syntetyczne; brak prywatnych eksportów.
const assert = require('assert');
const X = require('../app/public/pv-export'), D = require('../app/public/pv-data'), M = require('../app/public/pv-model');
const F = require('./pv-fixture');
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); console.log('  ✓ ' + name); passed++; } catch (e) { failed++; console.error('  ✗ ' + name + '\n' + e.stack); } }
const near = (a, b, e = 1e-8) => assert.ok(typeof a === 'number' && Math.abs(a - b) < e, `${a} != ${b}`);
const clone = x => JSON.parse(JSON.stringify(x));
function cfg(p = {}) { return F.settings(Object.assign({ calculationMode: 'export_only', exportPvToAcEta: 1, gridSource: 'auto' }, p)); }
function row(p = {}, date = '2026-09-01', hour = 12) {
  const ts = D.midnight(date) + hour * F.HOUR;
  return Object.assign({ ts, key: D.localKey(ts), durationHours: 1, pvDcKwh: 4, gridMeasuredExportKwh: 2, rcePlnMwh: 400 }, p);
}
function run(p = {}, rp = {}) { return X.simulate([row(rp)], cfg(p)); }
function fixture(p = {}) { return F.data(cfg(p)); }
function prepare(f) { return X.prepare(f.series, f.settings, f.shared, f.csv); }
function csv(f) { return D.parseGridCsvFiles([{ name: 'synthetic.csv', text: F.gridCsv(f.shared.hourlyElicznik) }]); }
function cache(f, signature = D.signature(f.settings), fetchedAt = '2026-01-01T00:00:00Z') { return { series: f.series, signature, fetchedAt }; }
function at(f, channel, hour = 12) { return f.series[f.settings.entities[channel]].find(r => r.ts === f.span.start + hour * F.HOUR); }
console.log('\n=== PV: nowa produkcja wyceniona jako eksport, bez domu/baterii ===');
test('E01 przyrost z PV DC, NIE proporcja eksportu: 4 PV / 2 eksport → 4 dodatkowego eksportu', () => {
  const r = run(); near(r.total.extraExportKwh, 4); near(r.total.extraDeposit.totalPln, 1.968);
  near(r.total.historicalExport.totalKwh, 2); near(r.total.historicalPlusScenarioExportKwh, 6);
});
test('E02 zerowe eksport historyczny nie zeruje dodatkowego profilu', () => near(run({}, { gridMeasuredExportKwh: 0 }).total.extraExportKwh, 4));
test('E03 profil rośnie o dodane kWp / istniejące kWp i względny uzysk', () => near(run({ addedKwp: 3.18, addedYieldFactor: .8 }).total.extraExportKwh, 4 / 3 * .8));
test('E04 zero dołożonych kWp daje dokładnie zero energii/wyceny', () => { const r = run({ addedKwp: 0 }); near(r.total.extraExportKwh, 0); near(r.total.extraDeposit.totalPln, 0); });
test('E05 zero względnego uzysku daje zero przyrostu', () => near(run({ addedYieldFactor: 0 }).total.extraExportKwh, 0));
test('E06 jedna własna sprawność, bez strat baterii', () => { const r = run({ exportPvToAcEta: .5, pvToAcEta: .1, storeChargeEta: null }); near(r.total.extraExportKwh, 2); near(r.total.conversionLossKwh, 2); });
test('E07 brak wszystkich parametrów baterii, A/V i domu nie blokuje', () => {
  const c = cfg(); for (const k of ['capacityKwh', 'minSocPct', 'maxSocPct', 'initialSocPct', 'chargeDcKw', 'dischargeDcKw', 'chargeCurrentA', 'dischargeCurrentA', 'batteryVoltageV', 'loadScale', 'pvToBatteryEta', 'batteryToAcEta', 'acToBatteryEta', 'storeChargeEta', 'storeDischargeEta']) c[k] = null;
  near(X.simulate([row()], c).total.extraExportKwh, 4);
});
test('E08 wspólna hybryda ogranicza RÓŻNICĘ krzywych, nie tylko nowe panele', () => { const r = run({ inverterAcKw: 6 }); near(r.total.extraExportKwh, 2); near(r.total.inverterLimitedDcKwh, 2); });
test('E09 nasycona stara konwersja nie dostaje dodatkowego budżetu', () => near(run({ inverterAcKw: 3 }).total.extraExportKwh, 0));
test('E10 jawny brak limitu hybrydy, liczba null nie jest używana', () => near(run({ unlimitedInverter: true, inverterAcKw: null }).total.extraExportKwh, 4));
test('E11 dodatkowy falownik AC ma osobny limit, istniejąca hybryda nie jest wymagana', () => { const r = run({ topology: 'ac_added', inverterAcKw: null, addedInverterAcKw: 3 }); near(r.total.extraExportKwh, 3); near(r.total.inverterLimitedDcKwh, 1); });
test('E12 dodatkowy AC bez limitu tylko po jawnym wyborze', () => near(run({ topology: 'ac_added', addedInverterAcKw: null, unlimitedAddedInverter: true }).total.extraExportKwh, 4));
test('E13 dodatkowy AC i 0 kWp nie wymaga fikcyjnego nowego falownika', () => near(run({ topology: 'ac_added', addedKwp: 0, addedInverterAcKw: null }).total.extraExportKwh, 0));
test('E14 limit eksportu uwzględnia CAŁY historyczny eksport', () => { const r = run({ exportAcKw: 3 }); near(r.total.extraExportKwh, 1); near(r.total.exportLimitedDcKwh, 3); near(r.total.historicalPlusScenarioExportKwh, 3); });
test('E15 0 limitu daje 0 przyrostu, nie zeruje historii', () => { const r = run({ exportAcKw: 0 }); near(r.total.extraExportKwh, 0); near(r.total.historicalExport.totalKwh, 2); near(r.total.historicalPlusScenarioExportKwh, 2); assert.strictEqual(r.issues.length, 1); });
test('E16 historia ponad limitem jest jawna, nieclampowana, bez miejsca na przyrost', () => { const r = run({ exportAcKw: 1 }); assert.strictEqual(r.total.historicalExportAboveLimitIntervals, 1); near(r.intervals[0].historicalExportKwh, 2); near(r.intervals[0].exportHeadroomKwh, 0); });
test('E17 nieograniczony eksport dopuszcza brak punktu odniesienia, nie 0', () => { const r = run({ unlimitedExport: true, exportAcKw: null }, { gridMeasuredExportKwh: null }); near(r.total.extraExportKwh, 4); assert.strictEqual(r.total.historicalExport.totalKwh, null); assert.strictEqual(r.total.historicalPlusScenarioExportKwh, null); });
test('E18 bilans nowego profilu: eksport + strata + dwa niewykorzystane ekwiwalenty DC', () => {
  const t = run({ exportPvToAcEta: .9, inverterAcKw: 5, exportAcKw: 2.5 }).total;
  near(t.addedPvDcKwh, t.extraExportKwh + t.conversionLossKwh + t.inverterLimitedDcKwh + t.exportLimitedDcKwh); near(t.maxBalanceErrorKwh, 0);
});
test('E19 RCE ujemne według niezmienionej funkcji starej karty: 0', () => near(run({}, { rcePlnMwh: -100 }).total.extraDeposit.totalPln, 0));
test('E20 RCE 0 nie jest brakującą ceną', () => { const r = run({}, { rcePlnMwh: 0 }); near(r.total.extraDeposit.totalPln, 0); assert.strictEqual(r.total.extraDeposit.missingIntervals, 0); });
test('E21 brak RCE przy dodatnim przyroście pozostaje nieznany', () => { const r = run({}, { rcePlnMwh: null }); assert.strictEqual(r.total.extraDeposit.totalPln, null); assert.strictEqual(r.total.conditionalBenefitPln, null); near(r.total.extraDeposit.affectedKwh, 4); });
test('E22 zerowy przyrost nie potrzebuje ceny', () => { const r = run({ addedKwp: 0 }, { rcePlnMwh: null }); near(r.total.extraDeposit.totalPln, 0); assert.strictEqual(r.total.extraDeposit.missingIntervals, 0); });
test('E23 nawet bardzo mały dodatni przyrost bez ceny nie jest ukrytym zerem', () => assert.strictEqual(run({}, { pvDcKwh: 1e-12, rcePlnMwh: null }).total.extraDeposit.totalPln, null));
test('E24 wykorzystanie depozytu to założenie, nie gotówka', () => near(run({ depositUseFraction: .5 }).total.conditionalBenefitPln, .984));
test('E25 0 wykorzystania daje 0 korzyści, ale nie fałszywą pełną wycenę depozytu', () => { const r = run({ depositUseFraction: 0 }, { rcePlnMwh: null }); near(r.total.conditionalBenefitPln, 0); assert.strictEqual(r.total.extraDeposit.totalPln, null); });
test('E26 granica istniejącego mnożnika RCE przed/od lutego 2025', () => { near(X.simulate([row({}, '2025-01-31')], cfg()).total.extraDeposit.totalPln, 1.6); near(X.simulate([row({}, '2025-02-01')], cfg()).total.extraDeposit.totalPln, 1.968); });
test('E27 wynik nie udaje modelu domu, baterii, oszczędności G13 ani rocznego zwrotu', () => {
  const r = run(); assert.strictEqual(r.physicalValidation, false); assert.strictEqual(r.batteryModeled, false); assert.strictEqual(r.houseModeled, false); assert.strictEqual(r.avoidedPurchaseModeled, false); assert.strictEqual(r.annualized, false); assert.strictEqual(r.total.avoidedPurchase, undefined); assert.strictEqual(r.assumptions.capacityKwh, undefined);
});
test('E28 konfiguracja i szeregi wejściowe pozostają niezmienione', () => { const c = cfg(), rows = [row()], before = JSON.stringify({ c, rows }); Object.freeze(c); Object.freeze(rows[0]); X.simulate(rows, c); assert.strictEqual(JSON.stringify({ c, rows }), before); });
for (const [key, value] of [['existingKwp', 0], ['addedKwp', null], ['addedKwp', -1], ['addedYieldFactor', null], ['addedYieldFactor', -1], ['exportPvToAcEta', null], ['exportPvToAcEta', 0], ['exportPvToAcEta', 1.01], ['inverterAcKw', null], ['inverterAcKw', 0], ['exportAcKw', null], ['exportAcKw', -1], ['depositUseFraction', 1.1], ['depositUseFraction', null], ['costPln', -1], ['topology', ''], ['calculationMode', 'bogus']]) {
  test('E-config odrzuca ' + key + '=' + value, () => assert.throws(() => run({ [key]: value })));
}
test('E29 dodane AC wymaga jawnego limitu, brak nie oznacza Infinity', () => assert.throws(() => run({ topology: 'ac_added', addedInverterAcKw: null })));
test('E30 napis true nie jest zgodą na brak limitu', () => assert.throws(() => run({ unlimitedExport: 'true', exportAcKw: null })));
for (const [key, value] of [['pvDcKwh', null], ['pvDcKwh', -0.0001], ['pvDcKwh', NaN], ['durationHours', 0], ['durationHours', 1.5], ['ts', 1], ['key', '2026-09-01_13'], ['gridMeasuredExportKwh', null], ['gridMeasuredExportKwh', -1], ['rcePlnMwh', '400']]) {
  test('E-row odrzuca ' + key + '=' + value, () => assert.throws(() => run({}, { [key]: value })));
}
test('E31 pusty szereg blokuje, nie daje 0', () => assert.throws(() => X.simulate([], cfg())));
test('E32 przerwy i duplikaty nie są usuwane', () => { const a = row(), b = row({}, '2026-09-01', 14); assert.throws(() => X.simulate([a, b], cfg())); assert.throws(() => X.simulate([a, a], cfg())); });
test('E33 krok 2 h poza foldem nie jest ogólną agregacją naprawczą', () => assert.throws(() => run({ allowDstAggregation: true }, { durationHours: 2 })));
test('E34 dokładna własna sprawność nie jest zaokrąglana', () => near(run({ exportPvToAcEta: .9412345678 }).total.extraExportKwh, 4 * .9412345678, 1e-12));
test('E35 miesięczne sumy i braki cen bez przenoszenia nieznanych na zero', () => {
  const a = row({}, '2026-01-31', 23), b = row({ rcePlnMwh: null }, '2026-02-01', 0), r = X.simulate([a, b], cfg());
  near(r.monthly['2026-01'].extraDeposit.totalPln, 1.968); assert.strictEqual(r.monthly['2026-02'].extraDeposit.totalPln, null); assert.strictEqual(r.total.extraDeposit.totalPln, null); near(r.total.extraDeposit.knownPln, 1.968);
});
test('E36 ceny nie zmieniają przepływów', () => assert.deepStrictEqual(run({}, { rcePlnMwh: 0 }).intervals, run({}, { rcePlnMwh: 1000 }).intervals));
test('E37 1200 deterministycznych wariantów: bilans i ograniczenia obu topologii', () => {
  let seed = 38129; const rand = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < 1200; i++) {
    const c = cfg({ topology: i % 2 ? 'dc_shared' : 'ac_added', addedKwp: rand() * 15, addedYieldFactor: rand() * 2,
      exportPvToAcEta: .75 + rand() * .25, inverterAcKw: 1 + rand() * 20, addedInverterAcKw: 1 + rand() * 12,
      exportAcKw: rand() * 15, unlimitedInverter: i % 7 === 0, unlimitedAddedInverter: i % 11 === 0, unlimitedExport: i % 13 === 0 });
    const input = row({ pvDcKwh: rand() * 12, gridMeasuredExportKwh: rand() * 15 }); const t = X.simulate([input], c).total;
    near(t.addedPvDcKwh, t.extraExportKwh + t.conversionLossKwh + t.inverterLimitedDcKwh + t.exportLimitedDcKwh);
    assert.ok(t.extraExportKwh <= t.addedPvDcKwh * c.exportPvToAcEta + 1e-8);
    if (!c.unlimitedExport) assert.ok(t.extraExportKwh <= Math.max(0, c.exportAcKw - input.gridMeasuredExportKwh) + 1e-8);
    if (c.topology === 'dc_shared' && !c.unlimitedInverter) assert.ok(Math.min(input.pvDcKwh * c.exportPvToAcEta, c.inverterAcKw) + t.additionalAcAfterInverterKwh <= c.inverterAcKw + 1e-8);
    if (c.topology === 'ac_added' && !c.unlimitedAddedInverter) assert.ok(t.additionalAcAfterInverterKwh <= c.addedInverterAcKw + 1e-8);
  }
});
console.log('\n=== PV eksport: dane i automatyczne źródła ===');
test('ED01 pełny dzień tylko PV/moc/eksport/ceny, bez H lub G13', () => {
  const f = fixture(); f.shared.zoneRates = {}; const p = prepare(f); assert.ok(p.ok); assert.strictEqual(p.rows.length, 24); assert.strictEqual(p.rows[0].loadAcKwh, undefined); assert.strictEqual(p.rows[0].buyPlnKwh, undefined); near(X.simulate(p.rows, f.settings).total.extraExportKwh, 4);
});
test('ED02 ujemne H w starym modelu nadal blokuje STARY, nie nowy', () => {
  const f = fixture(); at(f, 'acOutput').change = 0; F.sumSeries(f.series); assert.ok(!D.prepare(f.series, f.settings, f.shared).ok); assert.ok(prepare(f).ok);
});
test('ED03 błędne/ujemne BMS, SOC i wyjście AC nie są odczytywane przez nowy prepare', () => {
  const f = fixture(); f.series[f.settings.entities.acOutput] = 'invalid-unused'; f.series[f.settings.entities.soc] = [null]; f.settings.entities.bmsCharge = '<invalid-unused>'; assert.ok(prepare(f).ok);
});
test('ED04 tylko PV jest obowiązkową encją, moc opcjonalna', () => {
  const f = fixture(); f.settings.entities = { pv: f.settings.entities.pv, pvPower: '' }; assert.deepStrictEqual(X.entityIds(f.settings), ['sensor.test_pv']); const p = prepare(f); assert.ok(p.ok); assert.strictEqual(p.diagnostics.powerMissingHours, 24);
});
test('ED05 identyfikator obowiązkowego PV nie jest zgadywany', () => { const c = cfg(); c.entities.pv = ''; assert.throws(() => X.entityIds(c)); c.entities.pv = '<script>'; assert.throws(() => X.entityIds(c)); });
test('ED06 PV i moc nie mogą być tą samą encją', () => { const c = cfg(); c.entities.pvPower = c.entities.pv; assert.throws(() => X.entityIds(c)); });
test('ED07 brak przyrostu PV blokuje, brak ceny nie jest blokadą energetyczną', () => { const f = fixture(); at(f, 'pv').change = null; delete f.shared.rceHourly['2026-09-01_12']; const p = prepare(f); assert.ok(!p.ok); assert.ok(p.issues.some(i => i.code === 'missing_energy')); });
test('ED08 ujemne PV nie jest obcinane', () => { const f = fixture(); at(f, 'pv').change = -.1; const p = prepare(f); assert.ok(!p.ok); assert.ok(p.issues.some(i => i.code === 'negative_energy')); });
test('ED09 brak bufora pierwszej godziny blokuje', () => { const f = fixture(); f.series[f.settings.entities.pv].shift(); const p = prepare(f); assert.ok(!p.ok); assert.ok(p.issues.some(i => i.code === 'after_gap')); });
test('ED10 brak godziny w środku i następny przyrost nie są przepisywane', () => { const f = fixture(); f.series[f.settings.entities.pv] = f.series[f.settings.entities.pv].filter(r => r.ts !== f.span.start + 10 * F.HOUR); const p = prepare(f); assert.ok(!p.ok); assert.ok(p.issues.some(i => i.code === 'missing_energy')); assert.ok(p.issues.some(i => i.code === 'after_gap')); });
test('ED11 change niezgodne z Δsum blokuje', () => { const f = fixture(); at(f, 'pv').sum += 1; assert.ok(prepare(f).issues.some(i => i.code === 'sum_disagrees' && i.severity === 'error')); });
test('ED12 duplikat sprzecznej godziny nie zastępuje oryginału', () => { const f = fixture(); f.series[f.settings.entities.pv].push({ ...at(f, 'pv'), change: 20 }); assert.throws(() => prepare(f), /Sprzeczne/); });
test('ED13 eksport bez importu/stawek jest kompletny dla NOWEGO trybu', () => {
  const f = fixture(); for (const g of Object.values(f.shared.hourlyElicznik)) { delete g.hasImport; g.poborPoZbil = null; g.strefa = null; }
  const p = prepare(f); assert.ok(p.ok); assert.strictEqual(p.diagnostics.grid.selected.validBlocks, 24); assert.ok(!D.prepare(f.series, f.settings, f.shared).ok);
});
test('ED14 stare brakujące flagi nie są dorabiane z wartości liczbowych', () => { const f = fixture(); for (const g of Object.values(f.shared.hourlyElicznik)) delete g.hasExport; assert.ok(!prepare(f).ok); });
test('ED15 auto używa zapisanego CSV bez zmiany flag/starych danych', () => {
  const f = fixture(); f.csv = csv(f); for (const g of Object.values(f.shared.hourlyElicznik)) delete g.hasExport;
  const before = JSON.stringify(f), p = prepare(f); assert.ok(p.ok); assert.strictEqual(p.diagnostics.grid.selection.csvBlocks, 24); near(p.historical['2026-09'].values.gridExportKwh.totalKwh, 2); assert.strictEqual(JSON.stringify(f), before);
});
test('ED16 kompletne eksporty shared mają pierwszeństwo, bez dublowania', () => { const f = fixture(); f.csv = csv(f); const p = prepare(f); assert.strictEqual(p.diagnostics.grid.selection.sharedBlocks, 24); near(p.historical['2026-09'].values.gridExportKwh.totalKwh, 2); });
test('ED17 konflikt eksportu blokuje nawet bez pełnych flag starszego źródła', () => { const f = fixture(); f.csv = csv(f); f.shared.hourlyElicznik['2026-09-01_12'].oddaniePoZbil = 3; delete f.shared.hourlyElicznik['2026-09-01_12'].hasExport; assert.ok(prepare(f).issues.some(i => i.code === 'grid_source_conflict')); });
test('ED18 same różnice importu i taryfy nie należą do nowego trybu', () => {
  const f = fixture(); f.csv = csv(f); f.shared.hourlyElicznik['2026-09-01_12'].poborPoZbil = 9; f.shared.hourlyElicznik['2026-09-01_12'].strefa = 'T1'; assert.ok(prepare(f).ok); assert.ok(!D.prepare(f.series, f.settings, f.shared, f.csv).ok);
});
test('ED19 jawne shared nie korzysta z CSV i nie naprawia flag', () => { const f = fixture({ gridSource: 'shared' }); f.csv = csv(f); delete f.shared.hourlyElicznik['2026-09-01_12'].hasExport; assert.ok(!prepare(f).ok); });
test('ED20 jawne CSV wymaga zapisu i zachowuje konflikt', () => { const f = fixture({ gridSource: 'csv' }); assert.throws(() => prepare(f)); f.csv = csv(f); f.shared.hourlyElicznik['2026-09-01_12'].oddaniePoZbil++; assert.ok(!prepare(f).ok); });
test('ED21 uszkodzony zapis CSV nie jest ukryty przez dobry shared', () => { const f = fixture(); f.csv = { broken: true }; assert.throws(() => prepare(f)); });
test('ED22 napis true nie dowodzi eksportu', () => { const f = fixture(); f.shared.hourlyElicznik['2026-09-01_12'].hasExport = 'true'; assert.ok(!prepare(f).ok); });
test('ED23 brak eLicznika przy limicie blokuje, po jawnej idealizacji tylko ostrzega', () => {
  const f = fixture(); f.shared.hourlyElicznik = {}; assert.ok(!prepare(f).ok); f.settings.unlimitedExport = true;
  const p = prepare(f); assert.ok(p.ok); assert.strictEqual(p.historical['2026-09'].values.gridExportKwh.totalKwh, null); near(X.simulate(p.rows, f.settings).total.extraExportKwh, 4);
});
test('ED24 jawne W/kW dają identyczną diagnostykę bez podwójnego skalowania energii', () => {
  const f = fixture(), a = prepare(f); for (const r of f.series[f.settings.entities.pvPower]) { r.mean *= 1000; r.powerUnit = 'W'; }
  const b = prepare(f); assert.deepStrictEqual(a.rows, b.rows); near(a.diagnostics.pvPowerApproxKwh, b.diagnostics.pvPowerApproxKwh);
});
test('ED25 brak jednostki mocy nie jest zgadywany ani używany jako energia', () => {
  const f = fixture(); for (const r of f.series[f.settings.entities.pvPower]) { r.mean *= 1000; delete r.powerUnit; }
  const p = prepare(f); assert.ok(p.ok); assert.strictEqual(p.diagnostics.powerUnknownUnitHours, 24); assert.strictEqual(p.diagnostics.pvPowerApproxKwh, null); near(p.diagnostics.pvDcKwh, 4); assert.ok(!p.issues.some(i => i.code === 'power_disagrees'));
});
test('ED26 zatrzymanie licznika przy znanej mocy pozostaje ostrzeżeniem, bez naprawy', () => { const f = fixture(); at(f, 'pv').change = 0; F.sumSeries(f.series); const p = prepare(f); assert.ok(p.ok); assert.ok(p.issues.some(i => i.code === 'stalled_pv')); near(p.diagnostics.pvDcKwh, 0); });
test('ED27 wiosna 23 godziny, bez sztucznego zera lub agregacji', () => { const f = fixture({ startDate: '2026-03-29', endDate: '2026-03-29' }), p = prepare(f); assert.ok(p.ok); assert.strictEqual(p.diagnostics.expectedHours, 23); assert.strictEqual(p.rows.length, 23); });
test('ED28 jesień wymaga zgody na 2 h, nie fałszuje ceny', () => {
  const f = fixture({ startDate: '2026-10-25', endDate: '2026-10-25' }); let p = prepare(f); assert.ok(!p.ok); f.settings.allowDstAggregation = true;
  p = prepare(f); assert.ok(p.ok); assert.strictEqual(p.diagnostics.expectedHours, 25); assert.strictEqual(p.rows.length, 24);
  const fold = p.rows.find(r => r.durationHours === 2); assert.ok(fold); assert.strictEqual(fold.rcePlnMwh, null);
  fold.pvDcKwh = 2; assert.strictEqual(X.simulate(p.rows, f.settings).total.extraDeposit.totalPln, null);
});
test('ED29 jesień: dwa eksporty są wymagane, import nie jest potrzebny', () => {
  const f = fixture({ startDate: '2026-10-25', endDate: '2026-10-25', allowDstAggregation: true });
  const g = f.shared.hourlyElicznik['2026-10-25_02']; delete g.importCount; delete g.hasImport;
  assert.ok(prepare(f).ok); g.exportCount = 1; assert.ok(!prepare(f).ok);
});
test('ED30 core odrzuca jedną cenę podstawioną do 2 h', () => {
  const f = fixture({ startDate: '2026-10-25', endDate: '2026-10-25', allowDstAggregation: true }); const p = prepare(f); p.rows.find(r => r.durationHours === 2).rcePlnMwh = 400; assert.throws(() => X.simulate(p.rows, f.settings));
});
test('ED31 nie można uruchomić gotowych 2 h bez zgody', () => {
  const f = fixture({ startDate: '2026-10-25', endDate: '2026-10-25', allowDstAggregation: true }); const p = prepare(f); f.settings.allowDstAggregation = false; assert.throws(() => X.simulate(p.rows, f.settings));
});
test('ED32 częściowa historia PV nie daje pełnej sumy miesiąca', () => { const f = fixture(); at(f, 'pv').change = null; assert.strictEqual(prepare(f).historical['2026-09'].values.pvDcKwh.totalKwh, null); });
console.log('\n=== PV eksport: istniejące cache i granice zakresów ===');
test('EC01 brak pola trybu zachowuje stary model, nie migruje go po cichu', () => assert.strictEqual(X.mode({}), 'dynamic_battery'));
test('EC02 nieznany/pusty tryb odrzucany', () => { assert.throws(() => X.mode({ calculationMode: '' })); assert.throws(() => X.mode({ calculationMode: null })); });
test('EC03 sygnatura minimalnego fetch nie zawiera BMS/AC/SOC ani loadMode', () => { const s = JSON.parse(X.signature(cfg())); assert.deepStrictEqual(s.entities, ['sensor.test_power', 'sensor.test_pv']); assert.strictEqual(s.loadMode, undefined); });
test('EC04 pełny wcześniejszy cache jest użyteczny bez ponownego fetch', () => { const f = fixture(), match = X.cacheMatch(cache(f), f.settings); assert.ok(match); assert.strictEqual(match.subset, false); });
test('EC05 cały miesiąc może dać podzakres tygodnia, bez kopiowania/sklejania', () => {
  const f = fixture({ endDate: '2026-09-30' }), c = cfg({ endDate: '2026-09-07' }); const h = cache(f); assert.strictEqual(X.cacheMatch(h, c).subset, true); assert.strictEqual(X.pickDataset(c, h, null).dataset, h);
});
test('EC06 tydzień nie udaje całego miesiąca', () => { const f = fixture({ endDate: '2026-09-07' }); assert.strictEqual(X.cacheMatch(cache(f), cfg({ endDate: '2026-09-30' })), null); });
test('EC07 granica początku również musi być objęta', () => { const f = fixture(); assert.strictEqual(X.cacheMatch(cache(f), cfg({ startDate: '2026-08-31' })), null); });
test('EC08 inna encja PV nie jest zastępowana dostępną energią', () => { const f = fixture(), c = cfg(); c.entities.pv = 'sensor.other'; assert.strictEqual(X.cacheMatch(cache(f), c), null); });
test('EC09 sam wpis encji w metadanych nie tworzy pomiarów', () => { const f = fixture(); f.series[f.settings.entities.pv] = []; assert.strictEqual(X.cacheMatch(cache(f), f.settings), null); });
test('EC10 sama zgodność sygnatury nie omija kontroli bufora', () => { const f = fixture(); f.series[f.settings.entities.pv].shift(); assert.ok(X.cacheMatch(cache(f), f.settings)); assert.ok(!prepare(f).ok); });
test('EC11 uszkodzona/nieznana sygnatura nie jest zgadywana', () => {
  const f = fixture(); assert.strictEqual(X.cacheMatch(cache(f, '{bad'), f.settings), null);
  const s = JSON.parse(D.signature(f.settings)); s.calculationMode = 'other'; assert.strictEqual(X.cacheMatch(cache(f, JSON.stringify(s)), f.settings), null);
});
test('EC12 nowa sygnatura wiąże jawnie rolę PV z encją', () => { const f = fixture(); const s = JSON.parse(X.signature(f.settings)); s.pvEntity = f.settings.entities.pvPower; assert.strictEqual(X.cacheMatch(cache(f, JSON.stringify(s)), f.settings), null); });
test('EC13 opcjonalny brak mocy nie blokuje ponownego użycia profilu PV', () => { const f = fixture(); const s = JSON.parse(D.signature(f.settings)); s.entities = [f.settings.entities.pv]; const m = X.cacheMatch(cache(f, JSON.stringify(s)), f.settings); assert.ok(m); assert.strictEqual(m.includesPower, false); });
test('EC14 najnowszy zgodny cały cache, nie mieszanka godzin', () => {
  const f = fixture(), full = cache(f, D.signature(f.settings), '2026-01-03T00:00:00Z'), exp = cache(f, X.signature(f.settings), '2026-01-02T00:00:00Z');
  const p = X.pickDataset(f.settings, full, exp); assert.strictEqual(p.dataset, full); assert.strictEqual(p.origin, 'full');
  exp.fetchedAt = '2026-01-04T00:00:00Z'; assert.strictEqual(X.pickDataset(f.settings, full, exp).dataset, exp);
});
test('EC15 nowy cache niepasujący do zakresu nie przesłania wcześniejszego zgodnego', () => { const f = fixture(), c = cfg({ endDate: '2026-09-30' }), larger = fixture(c); const full = cache(larger); assert.strictEqual(X.pickDataset(c, full, cache(f, X.signature(f.settings), '2027-01-01')).dataset, full); });
test('EC16 wybór cache nie modyfikuje zapisów ani sygnatur', () => { const f = fixture(), h = cache(f), text = JSON.stringify(h); X.pickDataset(f.settings, h, null); assert.strictEqual(JSON.stringify(h), text); });
test('EC17 stary silnik/model danych pozostają odrębne', () => { const f = fixture(); const p = D.prepare(f.series, f.settings, f.shared); assert.ok(p.ok); near(M.simulate(p.rows, f.settings).delta.conditionalBenefitPln, 1.5); });
console.log(`\nPV eksport: ${passed} przeszło, ${failed} nie przeszło`); process.exitCode = failed ? 1 : 0;
