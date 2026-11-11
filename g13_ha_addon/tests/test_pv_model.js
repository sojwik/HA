'use strict';
// Wyłącznie sztuczne wektory QA. Moce/sprawności z testów NIE są doborem WIT.
const assert = require('assert');
const M = require('../app/public/pv-model');
const D = require('../app/public/pv-data');
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); console.log('  ✓ ' + name); passed++; } catch (e) { failed++; console.error('  ✗ ' + name + '\n' + e.stack); } }
function near(a, b, eps = 1e-8) { assert.strictEqual(typeof a, 'number'); assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`); }
function config(patch) { return Object.assign({ topology: 'dc_shared', existingKwp: 10, addedKwp: 10, addedYieldFactor: 1,
  capacityKwh: 10, minSocPct: 0, maxSocPct: 100, initialSocPct: 0, chargeDcKw: 20, dischargeDcKw: 20,
  pvToAcEta: 1, pvToBatteryEta: 1, batteryToAcEta: 1, acToBatteryEta: 1, storeChargeEta: 1, storeDischargeEta: 1,
  inverterAcKw: 20, addedInverterAcKw: 20, exportAcKw: 20,
  depositUseFraction: 1, loadScale: 1, costPln: null }, patch); }
function rows(pairs, start = Date.parse('2026-09-01T00:00:00Z')) {
  let ts = start;
  return pairs.map(p => { const r = Object.assign({ ts, key: D.localKey(ts), durationHours: 1,
    pvDcKwh: p[0], loadAcKwh: p[1], buyPlnKwh: 1.5, rcePlnMwh: 400 }, p[2] || {}); ts += r.durationHours * 3600000; return r; });
}
function freeze(x) { if (x && typeof x === 'object') { Object.values(x).forEach(freeze); Object.freeze(x); } return x; }

console.log('\n=== PV: fizyka i ekonomia odizolowanego scenariusza ===');
test('PV01 ręczny dwugodzinny bilans: 1 kWh mniej zakupu, 3 kWh więcej na końcu', () => {
  const r = M.simulate(rows([[4, 2], [0, 3]]), config());
  near(r.current.gridImportKwh, 1); near(r.expanded.gridImportKwh, 0);
  near(r.current.finalStoredKwh, 0); near(r.expanded.finalStoredKwh, 3);
  near(r.delta.avoidedPurchase.totalPln, 1.5); near(r.delta.extraDeposit.totalPln, 0);
  near(r.delta.addedPvDcKwh, 4); near(r.delta.conditionalBenefitPln, 1.5);
});
test('PV02 rezerwa raz: 14,336 / 10–100 = 12,9024 kWh; start 1,4336', () => {
  const r = M.simulate(rows([[20, 0]]), config({ capacityKwh: 14.336, minSocPct: 10, initialSocPct: 10, addedKwp: 0 }));
  near(r.current.initialStoredKwh, 1.4336); near(r.current.batteryChargeDcKwh, 12.9024);
  near(r.current.finalStoredKwh, 14.336); near(r.current.gridExportKwh, 7.0976);
});
test('PV03 start pod rezerwą ODRZUCONY, bez darmowego clamp', () => assert.throws(() => M.simulate(rows([[0, 1]]), config({ minSocPct: 30, initialSocPct: 10 })), /initialSocPct/));
test('PV04 na rezerwie brak darmowego rozładowania', () => {
  const r = M.simulate(rows([[0, 3]]), config({ capacityKwh: 14.336, minSocPct: 10, initialSocPct: 10 }));
  near(r.current.gridImportKwh, 3); near(r.current.batteryDischargeDcKwh, 0); near(r.expanded.gridImportKwh, 3);
});
test('PV05 dynamiczna bateria, nie odtwarzanie zmierzonego rozładowania', () => {
  const rs = rows([[4, 2], [0, 3]]); rs[1].bmsDischarge = 1000; rs[1].historicalDischargeKwh = 1000;
  const r = M.simulate(rs, config()); near(r.current.batteryToHouseAcKwh, 2); near(r.expanded.batteryToHouseAcKwh, 3);
});
test('PV06 nie ma ładowania z sieci, także przy ujemnym RCE', () => {
  const r = M.simulate(rows([[0, 0, { rcePlnMwh: -9999 }], [0, 5]]), config());
  near(r.expanded.batteryChargeDcKwh, 0); near(r.expanded.gridImportKwh, 5);
  assert.ok(r.intervals.every(x => x.expanded.gridToBatteryKwh === 0));
});
test('PV07 różne sprawności torów nie są jednym mnożnikiem cyklu', () => {
  const r = M.simulate(rows([[10, 0], [0, 10]]), config({ addedKwp: 0, pvToBatteryEta: .9,
    storeChargeEta: .8, storeDischargeEta: .5, batteryToAcEta: .9 }));
  near(r.current.batteryChargeDcKwh, 9); near(r.current.batteryDischargeDcKwh, 3.6);
  near(r.current.batteryToHouseAcKwh, 3.24); near(r.current.gridImportKwh, 6.76);
  near(r.current.lossKwh, 6.76); near(r.current.finalStoredKwh, 0);
});
test('PV08 moc na zaciskach DC (nie energia zapisana/AC)', () => {
  const r = M.simulate(rows([[10, 0], [0, 10]]), config({ addedKwp: 0, chargeDcKw: 2, dischargeDcKw: 1,
    storeChargeEta: .5, storeDischargeEta: .8, batteryToAcEta: .5 }));
  near(r.current.batteryChargeDcKwh, 2); near(r.current.batteryDischargeDcKwh, .8);
  near(r.current.batteryToHouseAcKwh, .4);
});
test('PV09 limit hybrydy wspólny dla PV i baterii', () => {
  const r = M.simulate(rows([[1, 10]]), config({ initialSocPct: 100, inverterAcKw: 3, addedKwp: 0 }));
  near(r.current.pvToHouseAcKwh, 1); near(r.current.batteryToHouseAcKwh, 2); near(r.current.gridImportKwh, 7);
});
test('PV10 nasycenie hybrydy: DC może ładować przy niedoborze AC, bez zakupu dla baterii', () => {
  const r = M.simulate(rows([[10, 8]]), config({ inverterAcKw: 3, addedKwp: 0 }));
  near(r.current.gridImportKwh, 5); near(r.current.batteryChargeDcKwh, 7); near(r.current.batteryDischargeDcKwh, 0);
});
test('PV11 clipping bez baterii: dodatkowe DC nie staje się darmowym AC', () => {
  const r = M.simulate(rows([[10, 1]]), config({ chargeDcKw: 0, inverterAcKw: 3 }));
  near(r.current.gridExportKwh, 2); near(r.current.curtailedDcKwh, 7);
  near(r.expanded.curtailedDcKwh, 17); near(r.delta.conditionalBenefitPln, 0);
});
test('PV12 eksport 0 rzeczywiście blokuje, nie znaczy unlimited', () => {
  const r = M.simulate(rows([[10, 1]]), config({ chargeDcKw: 0, exportAcKw: 0 }));
  near(r.expanded.gridExportKwh, 0); near(r.expanded.curtailedDcKwh, 19);
});
test('PV13 brak limitu tylko jawnie zaakceptowany', () => {
  assert.throws(() => M.simulate(rows([[1, 0]]), config({ inverterAcKw: null })), /inverterAcKw/);
  const r = M.simulate(rows([[100, 0]]), config({ inverterAcKw: null, exportAcKw: null,
    unlimitedInverter: true, unlimitedExport: true, chargeDcKw: 0 }));
  near(r.expanded.gridExportKwh, 200);
});
test('PV14 brak sprawności nie jest 1 ani 0', () => {
  for (const field of ['pvToAcEta', 'pvToBatteryEta', 'batteryToAcEta', 'storeChargeEta', 'storeDischargeEta']) {
    for (const value of [null, undefined, NaN, 0, -1, 1.01, '0.95']) assert.throws(() => M.validateConfig(config({ [field]: value })), new RegExp(field));
  }
});
test('PV15 AC: nowe AC najpierw dom, stare PV DC ładuje, reszta przez AC→DC', () => {
  const r = M.simulate(rows([[2, 1]]), config({ topology: 'ac_added', addedKwp: 30, chargeDcKw: 5, acToBatteryEta: .5 }));
  near(r.current.finalStoredKwh, 1); near(r.expanded.finalStoredKwh, 4.5);
  near(r.expanded.lossKwh, 2.5); near(r.expanded.gridExportKwh, 0);
  near(r.intervals[0].expanded.batteryChargeFromAddedAcKwh, 5);
});
test('PV16 AC: ładowanie zwrotne dzieli limit hybrydy, nadwyżka eksportowana', () => {
  const r = M.simulate(rows([[2, 1]]), config({ topology: 'ac_added', addedKwp: 30, chargeDcKw: 5, acToBatteryEta: .5, inverterAcKw: 1 }));
  near(r.expanded.finalStoredKwh, 2.5); near(r.expanded.gridExportKwh, 4);
  near(r.intervals[0].expanded.hybridAcThroughputKwh, 1);
});
test('PV17 AC: oddzielny falownik ma własny clipping', () => {
  const r = M.simulate(rows([[10, 0]]), config({ topology: 'ac_added', chargeDcKw: 0, inverterAcKw: 2, addedInverterAcKw: 3 }));
  near(r.expanded.gridExportKwh, 5); near(r.expanded.curtailedDcKwh, 15);
});
test('PV18 AC: eksport ogranicza CAŁOŚĆ, nie każdą instalację osobno', () => {
  const r = M.simulate(rows([[10, 0]]), config({ topology: 'ac_added', chargeDcKw: 0, exportAcKw: 3 }));
  near(r.expanded.gridExportKwh, 3); near(r.expanded.curtailedDcKwh, 17);
});
test('PV19 AC: nie zaokrąglamy 95% × 95% do 95%', () => {
  const r = M.simulate(rows([[1, 0]]), config({ topology: 'ac_added', addedKwp: 90,
    pvToAcEta: .95, acToBatteryEta: .95, chargeDcKw: 20, capacityKwh: 20, storeChargeEta: .8 }));
  near(r.expanded.finalStoredKwh, .8 * (1 + 9 * .95 * .95));
});
test('PV20 ceny z godziny unikniętego poboru, nie płaska stawka 0,63', () => {
  const r = M.simulate(rows([[4, 2, { buyPlnKwh: .63 }], [0, 3, { buyPlnKwh: 1.5 }]]), config());
  near(r.delta.avoidedPurchase.totalPln, 1.5);
});
test('PV21 RCE godziny eksportu, 400 PLN/MWh × 1,23', () => {
  const r = M.simulate(rows([[4, 2], [0, 0, { rcePlnMwh: 99999 }]]), config({ chargeDcKw: 0 }));
  near(r.delta.extraExportKwh, 4); near(r.delta.extraDeposit.totalPln, 1.968);
});
test('PV22 ujemne RCE → zero, a nie ujemny depozyt/bonus', () => {
  const r = M.simulate(rows([[4, 2, { rcePlnMwh: -500 }]]), config({ chargeDcKw: 0 })); near(r.delta.extraDeposit.totalPln, 0);
});
test('PV23 depozyt osobno od gotówki; jawne wykorzystanie 50%', () => {
  const r = M.simulate(rows([[4, 2]]), config({ chargeDcKw: 0, depositUseFraction: .5 }));
  near(r.delta.extraDeposit.totalPln, 1.968); near(r.delta.conditionalBenefitPln, .984);
});
test('PV24 brak G13 z efektem → null mimo jakiejkolwiek stawki legacy', () => {
  const r = M.simulate(rows([[4, 2], [0, 3, { buyPlnKwh: null, manualRatePlnKwh: 99 }]]), config());
  assert.strictEqual(r.delta.avoidedPurchase.totalPln, null); assert.strictEqual(r.delta.conditionalBenefitPln, null);
  near(r.delta.avoidedPurchase.affectedKwh, 1);
});
test('PV25 brak RCE z efektem → null i znana podsuma oznaczona oddzielnie', () => {
  const r = M.simulate(rows([[4, 2], [4, 2, { rcePlnMwh: null }]]), config({ chargeDcKw: 0 }));
  assert.strictEqual(r.delta.extraDeposit.totalPln, null); near(r.delta.extraDeposit.knownPln, 1.968);
  assert.strictEqual(r.delta.conditionalBenefitPln, null);
});
test('PV26 0 kWp → zero różnicy także bez cen; nieznane kwoty absolutne zostają null', () => {
  const r = M.simulate(rows([[4, 2, { rcePlnMwh: null }], [0, 5, { buyPlnKwh: null }]]), config({ addedKwp: 0, chargeDcKw: 0 }));
  near(r.delta.conditionalBenefitPln, 0); near(r.delta.avoidedImportKwh, 0); near(r.delta.extraExportKwh, 0);
  assert.strictEqual(r.current.purchase.totalPln, null); assert.strictEqual(r.current.deposit.totalPln, null);
});
test('PV27 zerowa stawka jest znaną ceną, nie brakiem', () => {
  const r = M.simulate(rows([[4, 2], [0, 3, { buyPlnKwh: 0 }]]), config()); near(r.delta.avoidedPurchase.totalPln, 0);
});
test('PV28 nie wolno rocznie ekstrapolować ani wyceniać terminalnego zapasu', () => {
  const r = M.simulate(rows([[4, 0]]), config({ costPln: 12345 }));
  assert.strictEqual(r.annualized, false); assert.strictEqual(r.terminalEnergyValued, false);
  near(r.delta.conditionalBenefitPln, 0); near(r.delta.finalStoredDifferenceKwh, 4);
  assert.strictEqual(r.physicalValidation, false); assert.ok(!('paybackYears' in r));
});
test('PV29 szereg nie jest sortowany/naprawiany: odwrócenie, duplikat, luka → błąd', () => {
  const rs = rows([[2, 1], [0, 1], [0, 2]]);
  assert.throws(() => M.simulate([rs[1], rs[0]], config()), /Przerwa/);
  assert.throws(() => M.simulate([rs[0], rs[0]], config()), /Przerwa/);
  assert.throws(() => M.simulate([rs[0], rs[2]], config()), /Przerwa/);
});
test('PV30 null/ujemne PV lub H nie stają się zerami', () => {
  for (const key of ['loadAcKwh', 'pvDcKwh']) for (const value of [null, undefined, -0.000001, NaN, Infinity, '0']) {
    const rs = rows([[1, 1]]); rs[0][key] = value; assert.throws(() => M.simulate(rs, config()), /przedział/);
  }
});
test('PV31 krok 2 h: moce × 2, energia bez podwajania', () => {
  const r = M.simulate(rows([[10, 0, { durationHours: 2 }]]), config({ chargeDcKw: 2, addedKwp: 0 }));
  near(r.hours, 2); near(r.current.batteryChargeDcKwh, 4); near(r.current.gridExportKwh, 6);
});
test('PV32 SOC przenoszony przez granicę miesiąca, nie resetowany', () => {
  const r = M.simulate(rows([[5, 0], [0, 3]], Date.parse('2026-09-30T21:00:00Z')), config({ addedKwp: 0 }));
  near(r.monthly['2026-10'].current.initialStoredKwh, 5); near(r.current.finalStoredKwh, 2); near(r.current.gridImportKwh, 0);
});
test('PV33 zamrożone wejścia pozostają bajtowo niezmienione', () => {
  const rs = freeze(rows([[2, 1], [0, 1]])), c = freeze(config()); const before = JSON.stringify([rs, c]);
  M.simulate(rs, c); assert.strictEqual(JSON.stringify([rs, c]), before);
});
test('PV34 względny uzysk i mnożnik H są jawne i identycznie stosowane', () => {
  const r = M.simulate(rows([[2, 3]]), config({ addedYieldFactor: .5, loadScale: 2 }));
  near(r.current.pvDcKwh, 2); near(r.expanded.pvDcKwh, 3); near(r.current.loadAcKwh, 6); near(r.expanded.loadAcKwh, 6);
});
test('PV35 mnożnik depozytu zmienia się na granicy lutego 2025, nie G13', () => {
  near(M.sellPrice({ key: '2025-01-31_23', rcePlnMwh: 1000 }), 1);
  near(M.sellPrice({ key: '2025-02-01_00', rcePlnMwh: 1000 }), 1.23);
  assert.strictEqual(M.sellPrice({ key: '2026-10-01_12', rcePlnMwh: null }), null);
});
test('PV36 rozsądne zakresy: nie przyjmujemy ujemnej mocy/pojemności i nieznanej topologii', () => {
  for (const patch of [{ topology: '' }, { chargeDcKw: -1 }, { addedKwp: -1 }, { capacityKwh: 0 },
    { initialSocPct: 101 }, { maxSocPct: 0 }, { inverterAcKw: Infinity }, { loadScale: 0 }, { depositUseFraction: 2 }])
    assert.throws(() => M.validateConfig(config(patch)));
});
test('PV37 0% wykorzystania: nieznany depozyt wciąż osobno null, korzyść niezależna od niego', () => {
  const r = M.simulate(rows([[3, 0, { rcePlnMwh: null }]]), config({ chargeDcKw: 0, depositUseFraction: 0 }));
  assert.strictEqual(r.delta.extraDeposit.totalPln, null); near(r.delta.conditionalBenefitPln, 0);
});
test('PV38 AC wymaga sprawności AC→DC; DC nie zakłada jej po cichu', () => {
  M.validateConfig(config({ acToBatteryEta: null }));
  assert.throws(() => M.validateConfig(config({ topology: 'ac_added', acToBatteryEta: null })), /acToBatteryEta/);
});
test('PV39 zero mocy ładowania/rozładowania działa niezależnie', () => {
  const r = M.simulate(rows([[10, 0], [0, 5]]), config({ addedKwp: 0, chargeDcKw: 2, dischargeDcKw: 0 }));
  near(r.current.batteryChargeDcKwh, 2); near(r.current.gridImportKwh, 5); near(r.current.finalStoredKwh, 2);
});
test('PV40 eksport AC przeliczany z PV DC z osobną stratą', () => {
  const r = M.simulate(rows([[10, 0]]), config({ addedKwp: 0, chargeDcKw: 0, pvToAcEta: .9 }));
  near(r.current.gridExportKwh, 9); near(r.current.lossKwh, 1);
});
test('PV41 niezależne równania bilansu, granic, sum i zerowej rozbudowy: 400 losowych par scenariuszy', () => {
  let seed = 56871; const rnd = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < 400; i++) {
    const min = rnd() * 30, max = 70 + rnd() * 30;
    const c = config({ topology: i % 2 ? 'dc_shared' : 'ac_added', addedKwp: rnd() * 20, capacityKwh: 2 + rnd() * 20,
      minSocPct: min, maxSocPct: max, initialSocPct: min + rnd() * (max - min),
      chargeDcKw: rnd() * 8, dischargeDcKw: rnd() * 8, inverterAcKw: .1 + rnd() * 10,
      addedInverterAcKw: .1 + rnd() * 8, exportAcKw: rnd() * 8,
      pvToAcEta: .7 + rnd() * .3, pvToBatteryEta: .7 + rnd() * .3, batteryToAcEta: .7 + rnd() * .3,
      acToBatteryEta: .7 + rnd() * .3, storeChargeEta: .7 + rnd() * .3, storeDischargeEta: .7 + rnd() * .3 });
    const rs = rows(Array.from({ length: 48 }, () => [rnd() * 12, rnd() * 8]));
    const r = M.simulate(rs, c);
    for (const name of ['current', 'expanded']) {
      let energy = c.capacityKwh * c.initialSocPct / 100, imported = 0;
      for (const v of r.intervals.map(x => x[name])) {
        near(v.pvDcKwh + v.gridImportKwh - v.loadAcKwh - v.gridExportKwh - v.curtailedDcKwh - v.lossKwh, v.storedAfterKwh - energy, 1e-7);
        energy += v.batteryChargeDcKwh * c.storeChargeEta - v.batteryDischargeDcKwh / c.storeDischargeEta;
        near(energy, v.storedAfterKwh, 1e-7);
        assert.ok(v.batteryChargeDcKwh <= c.chargeDcKw + 1e-8);
        assert.ok(v.batteryDischargeDcKwh <= c.dischargeDcKw + 1e-8);
        assert.ok(energy >= c.capacityKwh * min / 100 - 1e-8 && energy <= c.capacityKwh * max / 100 + 1e-8);
        assert.ok(v.gridExportKwh <= c.exportAcKw + 1e-8 && v.hybridAcThroughputKwh <= c.inverterAcKw + 1e-8);
        assert.ok(!(v.batteryChargeDcKwh > 1e-8 && v.batteryDischargeDcKwh > 1e-8));
        imported += v.gridImportKwh;
      }
      near(imported, r[name].gridImportKwh); near(energy, r[name].finalStoredKwh, 1e-7);
    }
    const z = M.simulate(rs, Object.assign({}, c, { addedKwp: 0 }));
    near(z.delta.conditionalBenefitPln, 0); near(z.delta.finalStoredDifferenceKwh, 0);
  }
});
console.log(`\nPV model: ${passed} przeszło, ${failed} nie przeszło`);
process.exitCode = failed ? 1 : 0;
