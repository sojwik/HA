'use strict';
const assert = require('assert');
const S = require('../app/public/pv-store'), D = require('../app/public/pv-data'), X = require('../app/public/pv-export'), F = require('./pv-fixture');
let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); console.log('  ✓ ' + name); passed++; } catch (e) { failed++; console.error('  ✗ ' + name + '\n' + e.stack); } }
const f = F.data(F.settings({ calculationMode: 'export_only', exportPvToAcEta: .95, endDate: '2026-09-30' }));
const minimal = Object.fromEntries(X.entityIds(f.settings).map(id => [id, f.series[id]]));
function storage() {
  const map = { 'monthly-ledger': 'private-ledger', 'elicznik-hourly-2026-09': 'private-grid', 'rce-cache': 'private-prices' }, calls = [];
  const control = { fail: null, uncertain: false, badList: false };
  return { map, calls, control,
    async get(k) { calls.push(['get', k]); return map[k] === undefined ? null : { value: map[k] }; },
    async set(k, v) { calls.push(['set', k]); if (control.fail && control.fail(k)) { if (control.uncertain) map[k] = v; throw new Error('injected-write-failure'); } map[k] = v; },
    async delete(k) { calls.push(['delete', k]); delete map[k]; },
    async list(prefix) { return { keys: Object.keys(map).filter(k => k.startsWith(prefix)).concat(control.badList ? ['monthly-ledger', 'pv-sim-v1-export-data-../bad'] : []) }; }
  };
}
const own = m => Object.fromEntries(Object.entries(m).filter(([k]) => !k.startsWith(S.prefix)));
(async () => {
  console.log('\n=== PV eksport: osobny atomowy zapis, bez utraty pełnej historii ===');
  await test('ES01 minimalny zapis ma osobny manifest, pełna historia i legacy identyczne', async () => {
    const s = storage(), st = S.create(s), legacy = own(s.map);
    await st.saveDataset(f.series, D.signature(f.settings)); const old = { ...s.map };
    await st.saveExportDataset(minimal, X.signature(f.settings));
    for (const [k, v] of Object.entries(old)) assert.strictEqual(s.map[k], v);
    assert.ok(s.map[S.prefix + 'export-active']); assert.deepStrictEqual(own(s.map), legacy);
    const loaded = await st.loadExportDataset(); assert.deepStrictEqual(D.mergeSeries(loaded.parts), D.mergeSeries([minimal]));
  });
  await test('ES02 zapis pełnej historii nie kasuje osobnej historii eksportu', async () => {
    const s = storage(), st = S.create(s); await st.saveExportDataset(minimal, X.signature(f.settings)); const saved = { ...s.map };
    await st.saveDataset(f.series, D.signature(f.settings)); for (const [k, v] of Object.entries(saved)) assert.strictEqual(s.map[k], v);
  });
  await test('ES03 błąd sharda nie zmienia żadnego aktywnego manifestu', async () => {
    const s = storage(), st = S.create(s); await st.saveDataset(f.series, D.signature(f.settings)); await st.saveExportDataset(minimal, X.signature(f.settings)); const before = { ...s.map };
    s.control.fail = k => k.startsWith(S.prefix + 'export-data-'); await assert.rejects(st.saveExportDataset(minimal, X.signature(f.settings)));
    assert.deepStrictEqual(s.map, before);
  });
  await test('ES04 błąd przed commitem manifestu zachowuje poprzedni eksport', async () => {
    const s = storage(), st = S.create(s); await st.saveExportDataset(minimal, X.signature(f.settings)); const before = { ...s.map };
    s.control.fail = k => k === S.prefix + 'export-active'; await assert.rejects(st.saveExportDataset(minimal, X.signature(f.settings))); assert.deepStrictEqual(s.map, before);
  });
  await test('ES05 niepewna odpowiedź po commicie rozpoznana odczytem, aktywne części niekasowane', async () => {
    const s = storage(), st = S.create(s); s.control.uncertain = true; s.control.fail = k => k === S.prefix + 'export-active';
    await st.saveExportDataset(minimal, X.signature(f.settings)); assert.ok((await st.loadExportDataset()).parts.length);
  });
  await test('ES06 kolejne zapisanie eksportu usuwa tylko stare shardy eksportu', async () => {
    const s = storage(), st = S.create(s); await st.saveDataset(f.series, D.signature(f.settings)); await st.saveExportDataset(minimal, X.signature(f.settings));
    const oldFull = JSON.parse(s.map[S.prefix + 'active']).keys, oldExport = JSON.parse(s.map[S.prefix + 'export-active']).keys;
    await st.saveExportDataset(minimal, X.signature(f.settings)); oldFull.forEach(k => assert.ok(s.map[k])); oldExport.forEach(k => assert.strictEqual(s.map[k], undefined));
  });
  await test('ES07 reset obejmuje oba cache i CSV, nigdy obce klucze z listy', async () => {
    const s = storage(), st = S.create(s), legacy = own(s.map); await st.saveDataset(f.series, D.signature(f.settings)); await st.saveExportDataset(minimal, X.signature(f.settings));
    await st.saveGridDataset(D.parseGridCsvFiles([{ name: 'synthetic.csv', text: F.gridCsv(f.shared.hourlyElicznik) }]));
    s.control.badList = true; await st.reset(); assert.deepStrictEqual(s.map, legacy);
    assert.ok(s.calls.filter(x => x[0] === 'delete').every(x => x[1].startsWith(S.prefix) && !x[1].includes('..')));
  });
  await test('ES08 manifest eksportu nie może wskazywać sharda pełnej historii', async () => {
    const s = storage(), st = S.create(s); await st.saveDataset(f.series, D.signature(f.settings)); s.map[S.prefix + 'export-active'] = s.map[S.prefix + 'active'];
    await assert.rejects(st.loadExportDataset(), /klucz/);
  });
  await test('ES09 brak sharda nie jest odczytem pustego/zerowego profilu', async () => {
    const s = storage(), st = S.create(s); await st.saveExportDataset(minimal, X.signature(f.settings)); const m = JSON.parse(s.map[S.prefix + 'export-active']); delete s.map[m.keys[0]];
    await assert.rejects(st.loadExportDataset(), /Brak/);
  });
  await test('ES10 nieznany schemat manifestu blokuje bez nadpisania', async () => {
    const s = storage(), st = S.create(s); s.map[S.prefix + 'export-active'] = JSON.stringify({ schema: 99 }); const before = { ...s.map };
    await assert.rejects(st.loadExportDataset(), /format/); assert.deepStrictEqual(s.map, before);
  });
  await test('ES11 pusty minimalny zapis nie usuwa poprzedniego', async () => {
    const s = storage(), st = S.create(s); await st.saveExportDataset(minimal, X.signature(f.settings)); const before = { ...s.map };
    await assert.rejects(st.saveExportDataset({}, X.signature(f.settings)), /Pusta/); assert.deepStrictEqual(s.map, before);
  });
  await test('ES12 każda część mieści się w limicie backendu i powstaje przed manifestem', async () => {
    const ff = F.data(F.settings({ calculationMode: 'export_only', startDate: '2026-01-01', endDate: '2026-06-30' })), ss = storage(), st = S.create(ss);
    const mini = Object.fromEntries(X.entityIds(ff.settings).map(id => [id, ff.series[id]])); await st.saveExportDataset(mini, X.signature(ff.settings));
    const m = JSON.parse(ss.map[S.prefix + 'export-active']); assert.ok(m.keys.length > 1);
    m.keys.forEach(k => assert.ok(Buffer.byteLength(JSON.stringify({ value: ss.map[k] })) < 1800000));
    const writes = ss.calls.filter(x => x[0] === 'set').map(x => x[1]); assert.strictEqual(writes.at(-1), S.prefix + 'export-active');
  });
  await test('ES13 dwie kolejki zapisu nie mieszają manifestów', async () => {
    const s = storage(), st = S.create(s); await Promise.all([st.saveDataset(f.series, D.signature(f.settings)), st.saveExportDataset(minimal, X.signature(f.settings))]);
    assert.ok(await st.loadDataset()); assert.ok(await st.loadExportDataset());
  });
  await test('ES14 odczyty/ustawienia nie zapisują automatycznie migracji danych', async () => {
    const s = storage(), st = S.create(s); assert.strictEqual(await st.loadExportDataset(), null); assert.ok(s.calls.every(c => c[0] !== 'set' && c[0] !== 'delete'));
  });
  console.log(`\nPV eksport zapis: ${passed} przeszło, ${failed} nie przeszło`); process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
