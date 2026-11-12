'use strict';
// WYŁĄCZNIE sztuczne dane; żadnej prywatnej historii w testach publikowalnych.
const assert = require('assert');
const D = require('../app/public/pv-data'), S = require('../app/public/pv-store'), F = require('./pv-fixture');
let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('  ✓ ' + name); } catch (e) { failed++; console.error('  ✗ ' + name + '\n' + e.stack); } }
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
const clone = x => JSON.parse(JSON.stringify(x));
const parse = text => D.parseGridCsvFiles([{ name: 'synthetic.csv', text }]);
const prepare = (f, grid) => D.prepare(f.series, f.settings, f.shared, grid);
function memory(initial = {}) {
  const kv = { ...initial }, calls = [];
  const m = { kv, calls, async get(k) { calls.push(['get', k]); return kv[k] === undefined ? null : { value: kv[k] }; },
    async set(k, v) { calls.push(['set', k]); if (m.fail && m.fail(k)) throw Error('synthetic PUT failure'); kv[k] = v; if (m.lost && m.lost(k)) throw Error('synthetic lost response'); },
    async delete(k) { calls.push(['delete', k]); if (m.failDelete) throw Error('synthetic DELETE failure'); delete kv[k]; },
    async list(pre) { return { keys: Object.keys(kv).filter(k => k.startsWith(pre)).concat(m.extra || []) }; } };
  return m;
}
(async () => {
  const f = F.data(), text = F.gridCsv(f.shared.hourlyElicznik), grid = parse(text);
  await test('PG01 jawny CSV obu kierunków, 24 rekordy i END24 → ta sama doba 23', () => {
    assert.strictEqual(grid.rows.length, 24); assert.strictEqual(grid.rows.at(-1).key, '2026-09-01_23');
    assert.ok(grid.rows.every(r => r.hasImport && r.hasExport && r.expectedCount === 1)); near(grid.rows[20].poborPoZbil, 3);
  });
  await test('PG02 prawdziwe zero ma potwierdzony wiersz; brak kierunku nie jest zerem', () => {
    const onlyImport = text.split('\n').filter(l => !l.includes('oddana')).join('\n'), a = parse(onlyImport);
    assert.strictEqual(a.rows[0].oddaniePoZbil, null); assert.strictEqual(a.rows[0].hasExport, false);
    near(a.rows[0].poborPoZbil, 0); assert.strictEqual(a.rows[0].hasImport, true);
    const p = prepare({ ...f, settings: { ...f.settings, gridSource: 'csv' } }, a);
    assert.ok(!p.ok); assert.strictEqual(p.rows[0].gridMeasuredExportKwh, null);
  });
  await test('PG03 brak godziny pozostaje luką, bez fallback do kompletnego starego zapisu', () => {
    const a = parse(text.split('\n').filter(l => !l.startsWith('2026-09-01 10:00;')).join('\n'));
    const p = prepare({ ...f, settings: { ...f.settings, gridSource: 'csv' } }, a);
    assert.strictEqual(p.diagnostics.grid.selected.missingRows, 1); assert.ok(!p.ok); assert.strictEqual(p.rows[9].loadAcKwh, null);
  });
  await test('PG04 brak/puste/ujemne/NaN/infinity nie są importowane jako 0', () => {
    for (const val of ['', '-1', 'NaN', 'Infinity', '1e309', '1 000', '1,2,3'])
      assert.throws(() => parse(text.replace(';0;pobrana', ';' + val + ';pobrana')), /energia/);
  });
  await test('PG05 nieznany kierunek, Wh oraz status szacowania są jawnie odrzucone', () => {
    for (const [a, b] of [['[kWh]', '[Wh]'], ['pobrana', 'inna'], [';licznik;', ';szacunek;']]) assert.throws(() => parse(text.replace(a, b)));
  });
  await test('PG06 BOM/cudzysłowy/przecinek dziesiętny działają, HTML i obcy nagłówek nie', () => {
    near(parse('\uFEFF' + text.replace(';3;pobrana', ';"3,25";pobrana').replace(/\n/g, '\r\n')).rows[20].poborPoZbil, 3.25);
    assert.throws(() => parse('<html>error</html>'), /oryginalny CSV/);
    assert.throws(() => parse(text.replace('Strefa', 'Data')), /oryginalny CSV/);
  });
  await test('PG07 daty i etykiety 1–24 ścisłe; 0,25,połówki,31 lutego odrzucone', () => {
    for (const value of ['2026-09-01 0:00', '2026-09-01 25:00', '2026-09-01 1:30', '2026-02-31 1:00']) assert.throws(() => parse(text.replace('2026-09-01 1:00', value)));
  });
  await test('PG08 wiosna 23 h: bez dopisywania brakującej 02', () => {
    const spring = F.data(F.settings({ startDate: '2026-03-29', endDate: '2026-03-29' })), a = parse(F.gridCsv(spring.shared.hourlyElicznik));
    assert.strictEqual(a.rows.length, 23); assert.ok(!a.rows.some(r => r.hour === 2));
    assert.throws(() => parse(F.gridCsv(spring.shared.hourlyElicznik).replace('2026-03-29 4:00', '2026-03-29 3:00')), /Nieistniejąca/);
  });
  await test('PG09 jesień: oba rekordy kierunku, suma w 2 h, zgoda DST nadal wymagana', () => {
    const fall = F.data(F.settings({ startDate: '2026-10-25', endDate: '2026-10-25', gridSource: 'csv' }));
    fall.shared.hourlyElicznik['2026-10-25_02'].poborPoZbil = 2.5;
    const a = parse(F.gridCsv(fall.shared.hourlyElicznik)), r = a.rows.find(r => r.hour === 2);
    assert.strictEqual(r.importCount, 2); assert.strictEqual(r.exportCount, 2); near(r.poborPoZbil, 2.5);
    assert.ok(!prepare(fall, a).ok); fall.settings.allowDstAggregation = true;
    const p = prepare(fall, a); assert.ok(p.ok); assert.strictEqual(p.hourly.length, 25); assert.strictEqual(p.rows.length, 24);
    assert.strictEqual(p.rows[2].durationHours, 2); assert.strictEqual(p.rows[2].rcePlnMwh, null);
  });
  await test('PG10 pojedynczy rekord jesiennej 02 nie jest uznany za kompletne 2 h', () => {
    const fall = F.data(F.settings({ startDate: '2026-10-25', endDate: '2026-10-25', gridSource: 'csv', allowDstAggregation: true }));
    const lines = F.gridCsv(fall.shared.hourlyElicznik).split('\n'), i = lines.findIndex(l => l.startsWith('2026-10-25 3:00;') && l.includes('pobrana'));
    lines.splice(i, 1); const a = parse(lines.join('\n'));
    assert.strictEqual(a.rows[2].hasImport, false); assert.strictEqual(a.rows[2].importCount, 1); assert.ok(!prepare(fall, a).ok);
  });
  await test('PG11 duplikaty godzin i powtórzony plik nie podwajają energii', () => {
    assert.throws(() => parse(text + text.split('\n')[1] + '\n'), /Duplikat/);
    assert.throws(() => D.parseGridCsvFiles([{ name: 'a.csv', text }, { name: 'b.csv', text }]), /Duplikat/);
  });
  await test('PG12 osobne pliki dwóch kierunków tworzą jawny kompletny zestaw', () => {
    const imp = text.split('\n').filter(l => !l.includes('oddana')).join('\n'), exp = text.split('\n').filter(l => !l.includes('pobrana')).join('\n');
    const a = D.parseGridCsvFiles([{ name: 'imp.csv', text: imp }, { name: 'exp.csv', text: exp }]);
    assert.ok(a.rows.every(r => r.hasImport && r.hasExport)); near(a.rows[20].poborPoZbil, 3);
  });
  await test('PG13 brak strefy oznacza nieznane G13; sprzeczne strefy są odrzucone', () => {
    assert.throws(() => parse(text.replace(';T2;', ';T1;')), /Sprzeczne strefy/);
    const a = parse(text.replaceAll(';T2;', ';;'));
    const p = prepare({ ...f, settings: { ...f.settings, gridSource: 'csv' } }, a);
    assert.strictEqual(p.rows[0].buyPlnKwh, null); assert.strictEqual(p.diagnostics.missingBuyPriceBlocks, 24);
  });
  await test('PG14 744 stare flagi: reprodukcja blokad i usunięcie ich tylko przez potwierdzony CSV', () => {
    const may = F.data(F.settings({ startDate: '2026-05-01', endDate: '2026-05-31' })), a = parse(F.gridCsv(may.shared.hourlyElicznik));
    for (const r of Object.values(may.shared.hourlyElicznik)) { delete r.hasImport; delete r.hasExport; }
    const before = JSON.stringify(may.shared), bad = prepare(may);
    assert.strictEqual(bad.diagnostics.errorCount, 744); assert.strictEqual(bad.diagnostics.grid.shared.missingImportFlags, 744);
    may.settings.gridSource = 'csv'; const good = prepare(may, a);
    assert.strictEqual(good.diagnostics.grid.selected.validBlocks, 744); assert.ok(good.ok);
    assert.strictEqual(JSON.stringify(may.shared), before);
    may.settings.gridSource = 'shared'; assert.strictEqual(prepare(may, a).diagnostics.errorCount, 744);
  });
  await test('PG15 niezgodna energia CSV kontra stary zapis blokuje, bez nadpisania historii', () => {
    const a = clone(grid); a.rows[20].poborPoZbil += 1; const old = JSON.stringify(f.shared);
    const p = prepare({ ...f, settings: { ...f.settings, gridSource: 'csv' } }, a);
    assert.ok(!p.ok); assert.strictEqual(p.diagnostics.grid.conflictingBlocks, 1); assert.ok(p.issues.some(i => i.code === 'grid_source_conflict'));
    assert.strictEqual(JSON.stringify(f.shared), old);
  });
  await test('PG16 uszkodzony cache/flag-only patch odrzucony; brak zaufania do gołego hasImport', () => {
    for (const mutate of [a => { a.rows[0].hasImport = false; }, a => { a.rows[0].importCount = 0; },
      a => { a.rows[0].key = '__proto__'; }, a => { a.rows[0].expectedCount = 2; }, a => { a.rows.push(a.rows[0]); }, a => { a.format = 'other'; }]) {
      const a = clone(grid); mutate(a); assert.throws(() => D.validateGridDataset(a));
    }
  });
  await test('PG17 wybór CSV bez zestawu nie przechodzi cicho na stare dane', () => {
    assert.throws(() => prepare({ ...f, settings: { ...f.settings, gridSource: 'csv' } }), /nie zapisano/);
    assert.throws(() => prepare({ ...f, settings: { ...f.settings, gridSource: 'bad' } }, grid), /źródło/);
  });
  await test('PG18 przegląd tylko do odczytu rozróżnia brak, false, typ i liczbę ujemną', () => {
    const shared = clone(f.shared); delete shared.hourlyElicznik['2026-09-01_00'];
    delete shared.hourlyElicznik['2026-09-01_01'].hasImport; shared.hourlyElicznik['2026-09-01_02'].hasExport = false;
    shared.hourlyElicznik['2026-09-01_03'].poborPoZbil = '0'; shared.hourlyElicznik['2026-09-01_04'].oddaniePoZbil = -1;
    const before = JSON.stringify(shared), q = D.inspectGrid(shared.hourlyElicznik, f.settings.startDate, f.settings.endDate);
    assert.strictEqual(q.missingRows, 1); assert.strictEqual(q.missingImportFlags, 1); assert.strictEqual(q.rejectedExportFlags, 1);
    assert.strictEqual(q.invalidImportValues, 1); assert.strictEqual(q.invalidExportValues, 1); assert.strictEqual(q.validBlocks, 19);
    assert.strictEqual(JSON.stringify(shared), before);
  });
  await test('PU01 jawne W i kW dają te same ostrzeżenia i NIE zmieniają energii/reszty', () => {
    const w = F.data(), kw = F.data();
    for (const r of w.series[w.settings.entities.pvPower]) { r.mean *= 1000; r.min *= 1000; r.max *= 1000; r.powerUnit = 'W'; }
    const a = prepare(w), b = prepare(kw); assert.deepStrictEqual(a.rows, b.rows); assert.deepStrictEqual(a.hourly, b.hourly);
    assert.deepStrictEqual(a.issues, b.issues); near(a.diagnostics.pvPowerApproxKwh, 4);
  });
  await test('PU02 stare rekordy bez jednostki nie są automatycznie uznane za kW', () => {
    const old = F.data(); for (const r of old.series[old.settings.entities.pvPower]) { delete r.powerUnit; r.mean *= 1000; }
    const p = prepare(old); assert.ok(p.ok); assert.strictEqual(p.diagnostics.powerUnknownUnitHours, 24);
    assert.strictEqual(p.diagnostics.pvPowerKnownHours, 0); assert.strictEqual(p.diagnostics.pvPowerApproxKwh, null);
    assert.ok(!p.issues.some(i => ['stalled_pv', 'power_disagrees'].includes(i.code)));
    assert.ok(p.issues.some(i => i.code === 'power_unit_unknown')); assert.deepStrictEqual(p.rows, prepare(F.data()).rows);
  });
  await test('PU03 jednostki nie zależą od wielkości: małe W i duże kW pozostają jawne', () => {
    const a = F.data(), rs = a.series[a.settings.entities.pvPower];
    rs[1].mean = .05; rs[1].powerUnit = 'W'; rs[2].mean = 2000; rs[2].powerUnit = 'kW';
    const p = prepare(a); assert.ok(!p.issues.some(i => i.code === 'stalled_pv' && i.ts === rs[1].ts));
    near(p.issues.find(i => i.code === 'power_disagrees' && i.ts === rs[2].ts).value, -2000);
  });
  await test('PU04 nieznane MW/% nie jest przeliczane na podstawie nazwy kanału', () => {
    for (const unit of ['MW', '%', 'unknown']) {
      const a = F.data(); for (const r of a.series[a.settings.entities.pvPower]) r.powerUnit = unit;
      const p = prepare(a); assert.strictEqual(p.diagnostics.powerUnknownUnitHours, 24); assert.strictEqual(p.diagnostics.pvPowerApproxKwh, null);
    }
  });
  await test('PU05 jednostka przechodzi przez CSV i merge, konflikt jednostek nie jest ukryty', () => {
    const a = D.parseStatsCsv(F.csv(f.series)); assert.strictEqual(a[f.settings.entities.pvPower][0].powerUnit, 'kW');
    const b = clone(a); b[f.settings.entities.pvPower][0].powerUnit = 'W'; assert.throws(() => D.mergeSeries([a, b]), /Sprzeczne/);
  });
  await test('PGS01 osobny CSV, restart i nienaruszone wszystkie obce klucze', async () => {
    const old = F.legacyKv(f), m = memory(old), st = S.create(m); await st.saveDataset(f.series, 'ha'); const ha = m.kv[S.prefix + 'active'];
    await st.saveGridDataset(grid); const a = D.validateGridDataset(await S.create(m).loadGridDataset()); assert.deepStrictEqual(a, grid);
    assert.strictEqual(m.kv[S.prefix + 'active'], ha); for (const k of Object.keys(old)) assert.strictEqual(m.kv[k], old[k]);
    assert.ok(m.calls.filter(c => c[0] === 'set' || c[0] === 'delete').every(c => c[1].startsWith(S.prefix)));
  });
  await test('PGS02 ponowny import zastępuje własny zestaw, nie sumuje go', async () => {
    const m = memory(), st = S.create(m); await st.saveGridDataset(grid); await st.saveGridDataset(grid);
    const a = D.validateGridDataset(await st.loadGridDataset()); assert.strictEqual(a.rows.length, 24); near(a.rows[20].poborPoZbil, 3);
  });
  await test('PGS03 awaria drugiego sharda zachowuje poprzedni kompletny CSV', async () => {
    const m = memory(), st = S.create(m); await st.saveGridDataset(grid); const old = m.kv[S.prefix + 'grid-active'];
    const big = F.data(F.settings({ endDate: '2027-03-01' })), data = parse(F.gridCsv(big.shared.hourlyElicznik));
    assert.ok(data.rows.length > 4000); m.fail = k => k.startsWith(S.prefix + 'grid-') && k.endsWith('-0001');
    await assert.rejects(st.saveGridDataset(data)); assert.strictEqual(m.kv[S.prefix + 'grid-active'], old);
    assert.deepStrictEqual(D.validateGridDataset(await st.loadGridDataset()), grid);
  });
  await test('PGS04 utrata odpowiedzi po commit nie usuwa aktywnych części CSV', async () => {
    const m = memory(), st = S.create(m); m.lost = k => k === S.prefix + 'grid-active'; await st.saveGridDataset(grid);
    assert.deepStrictEqual(D.validateGridDataset(await st.loadGridDataset()), grid);
  });
  await test('PGS05 złośliwy manifest grid nie czyta ledger ani shardów HA', async () => {
    const m = memory({ [S.prefix + 'grid-active']: JSON.stringify({ schema: 1, generation: 'x', signature: 'elicznik-end-v1', keys: ['monthly-ledger'] }) });
    await assert.rejects(S.create(m).loadGridDataset(), /klucz/); assert.ok(!m.calls.some(c => c[1] === 'monthly-ledger'));
  });
  await test('PGS06 reset usuwa obie historie PV, ale nie cudze klucze z listy', async () => {
    const legacy = F.legacyKv(f), m = memory(legacy), st = S.create(m); await st.saveGridDataset(grid); await st.saveDataset(f.series, 'ha');
    m.extra = ['monthly-ledger', 'rce-cache', 'elicznik-hourly-2026-09']; await st.reset(); assert.deepStrictEqual(m.kv, legacy);
  });
  await test('PGS07 błąd cleanup po nowym commicie jest ostrzeżeniem, nowy CSV czytelny', async () => {
    const m = memory(), st = S.create(m); await st.saveGridDataset(grid); m.failDelete = true;
    const saved = await st.saveGridDataset(grid); assert.strictEqual(saved.cleanupWarning, true);
    assert.deepStrictEqual(D.validateGridDataset(await st.loadGridDataset()), grid);
  });
  await test('PGS08 reset kolejkuje się za zapisem CSV, nie wskrzesza zestawu', async () => {
    const m = memory(), st = S.create(m); await Promise.all([st.saveGridDataset(grid), st.reset()]); assert.deepStrictEqual(m.kv, {});
  });
  console.log(`\nPV grid/units: ${passed} przeszło, ${failed} nie przeszło`); process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
