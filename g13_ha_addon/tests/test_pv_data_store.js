'use strict';
const assert = require('assert');
const D = require('../app/public/pv-data');
const S = require('../app/public/pv-store');
const F = require('./pv-fixture');
let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); console.log('  ✓ ' + name); passed++; } catch (e) { failed++; console.error('  ✗ ' + name + '\n' + e.stack); } }
function near(a, b) { assert.ok(typeof a === 'number' && Math.abs(a - b) < 1e-7, `${a} != ${b}`); }
function prepare(f) { return D.prepare(f.series, f.settings, f.shared); }
function patch(f, field, hour, value) {
  const r = f.series[f.settings.entities[field]].find(r => D.localKey(r.ts) === f.settings.startDate + '_' + String(hour).padStart(2, '0'));
  r.change = value; F.sumSeries(f.series); return r;
}
function mockStorage(initial = {}) {
  const kv = Object.assign({}, initial), calls = [];
  const mock = {
    async get(k) { calls.push(['GET', k]); return Object.prototype.hasOwnProperty.call(kv, k) ? { value: kv[k] } : null; },
    async set(k, v) { calls.push(['PUT', k]); if (mock.reject && mock.reject(k, v)) throw new Error('test: zapis odrzucony'); kv[k] = v;
      if (mock.lostResponse && mock.lostResponse(k, v)) throw new Error('test: utrata odpowiedzi po zapisie'); },
    async delete(k) { calls.push(['DELETE', k]); if (mock.rejectDelete && mock.rejectDelete(k)) throw new Error('test: delete odrzucone'); delete kv[k]; },
    async list(prefix) { calls.push(['LIST', prefix]); return { keys: Object.keys(kv).filter(k => k.startsWith(prefix)).concat(mock.extraKeys || []) }; },
    kv, calls,
  };
  return mock;
}
(async () => {
  console.log('\n=== PV: parser, czas, niepewne pomiary, atomowy i osobny zapis ===');
  await test('PD01 parser przechowuje UTC, null i prawdziwe zero bez sum/mean fallback', () => {
    const f = F.data(), parsed = D.parseStatsCsv(F.csv(f.series));
    assert.strictEqual(JSON.stringify(parsed), JSON.stringify(f.series));
    const soc = parsed[f.settings.entities.soc][0]; assert.strictEqual(soc.change, null); near(soc.mean, 10);
    near(parsed[f.settings.entities.pv][0].change, 0);
  });
  await test('PD02 odpowiedź HTML 200 / pusty nagłówek / uszkodzona liczba odrzucone', () => {
    assert.throws(() => D.parseStatsCsv('<html>HA SPA</html>'), /eksport/);
    assert.throws(() => D.parseStatsCsv('statistic_id,start_utc,change\n'), /nagłówek/);
    const text = F.csv(F.data().series); assert.throws(() => D.parseStatsCsv(text.replace(',,,,0,0,\n', ',,,,banana,0,\n')), /liczba/);
  });
  await test('PD03 duplikat UTC jednej encji to błąd, nie podwójna energia', () => {
    const a = F.csv(F.data().series).trim().split('\n'); a.push(a[1]); assert.throws(() => D.parseStatsCsv(a.join('\n')), /Duplikat/);
  });
  await test('PD04 wymagane jawne UTC; niespójna etykieta lokalna nie przechodzi', () => {
    const a = F.csv(F.data().series);
    assert.throws(() => D.parseStatsCsv(a.replace('2026-08-31T21:00:00Z', '2026-08-31T21:00:00')), /UTC/);
    assert.throws(() => D.parseStatsCsv(a.replace('2026-08-31 23:00:00', '2026-08-31 22:00:00')), /lokalna/);
  });
  await test('PD05 BOM, CRLF i prawidłowe cudzysłowy są obsługiwane', () => {
    const a = F.csv(F.data().series).replace('sensor.test_pv,', '"sensor.test_pv",').replace(/\n/g, '\r\n');
    assert.ok(D.parseStatsCsv('\uFEFF' + a)['sensor.test_pv'].length > 0);
  });
  await test('PD06 IX–X = 1465 h; zmiany czasu 23/25 h bez zgadywania', () => {
    near(D.range('2026-09-01', '2026-10-31').hours, 1465);
    near(D.range('2026-03-29', '2026-03-29').hours, 23); near(D.range('2026-10-25', '2026-10-25').hours, 25);
    near(D.midnight('2026-09-01'), Date.parse('2026-08-31T22:00:00Z'));
  });
  await test('PD07 daty walidowane, odwrócony/długi okres odrzucony', () => {
    for (const a of [['2026-02-30', '2026-03-02'], ['x', '2026-09-01'], ['2026-09-02', '2026-09-01'], ['2020-01-01', '2026-01-01']]) assert.throws(() => D.range(...a));
  });
  await test('PD08 H warunkowe ma 5 kWh, PV 4; nie jest fizycznie zwalidowane', () => {
    const p = prepare(F.data()); assert.ok(p.ok); near(p.historical['2026-09'].values.houseKwh.totalKwh, 5);
    near(p.historical['2026-09'].values.pvDcKwh.totalKwh, 4); assert.strictEqual(p.physicalValidation, false);
  });
  await test('PD09 brak godziny oraz godzina po luce pozostają null; całość zablokowana', () => {
    const f = F.data(), id = f.settings.entities.pv; f.series[id].splice(6, 1);
    const p = prepare(f); assert.ok(!p.ok);
    assert.ok(p.issues.some(x => x.code === 'missing_energy' && x.channel === 'pv'));
    assert.ok(p.issues.some(x => x.code === 'after_gap' && x.channel === 'pv'));
    assert.strictEqual(p.historical['2026-09'].values.pvDcKwh.totalKwh, null);
  });
  await test('PD10 brak bufora pierwszej godziny nie tworzy energii startowej', () => {
    const f = F.data(); f.series[f.settings.entities.pv].shift(); const p = prepare(f);
    assert.ok(!p.ok); assert.strictEqual(p.rows[0].pvDcKwh, null);
  });
  await test('PD11 brak change przy dodatnim sum/mean nie daje zera ani mean×1h', () => {
    const f = F.data(); const r = patch(f, 'pv', 12, null); r.mean = 999; r.sum = 4;
    const p = prepare(f); assert.ok(!p.ok); assert.strictEqual(p.rows.find(x => x.key.endsWith('_12')).pvDcKwh, null);
  });
  await test('PD12 ujemne change zachowane w diagnozie; wynik zablokowany', () => {
    const f = F.data(); patch(f, 'pv', 12, -.1); const p = prepare(f);
    assert.ok(!p.ok); near(p.issues.find(x => x.code === 'negative_energy').value, -.1);
  });
  await test('PD13 rozbieżność change/Δsum nie jest automatycznie naprawiana', () => {
    const f = F.data(); f.series[f.settings.entities.pv][13].sum += 10;
    const p = prepare(f); assert.ok(!p.ok); assert.ok(p.issues.some(x => x.code === 'sum_disagrees'));
  });
  await test('PD14 ujemne H pozostaje ujemne, nigdy clamp ani usunięcie przedziału', () => {
    const f = F.data(); f.shared.hourlyElicznik['2026-09-01_12'].oddaniePoZbil = 5;
    const p = prepare(f); assert.ok(!p.ok); near(p.rows[12].loadAcKwh, -1); near(p.rows.length, 24);
  });
  await test('PD15 nie odejmujemy AC od BMS ani nie min(AC, import)', () => {
    const f = F.data(); patch(f, 'acCharge', 12, .4); patch(f, 'bmsCharge', 12, .3);
    const p = prepare(f); assert.ok(p.ok); near(p.rows[12].loadAcKwh, 1.6);
    near(p.hourly[12].bmsCharge, .3); near(p.hourly[12].residual, .1);
    near(p.diagnostics.zeroImportPositiveAcBlocks, 1);
  });
  await test('PD16 duża ujemna reszta jest zachowana jako ostrzeżenie, nie „strata 0”', () => {
    const f = F.data(); patch(f, 'acOutput', 12, 4.5);
    const p = prepare(f); assert.ok(p.ok); near(p.hourly[12].residual, -.5);
    near(p.diagnostics.residualBelowMinus02Hours, 1); near(p.diagnostics.residualSumKwh, -.5);
  });
  await test('PD17 próg −0,2 z tolerancją nie produkuje artefaktu zmiennoprzecinkowego', () => {
    const f = F.data(); patch(f, 'acOutput', 12, 4.2); near(prepare(f).diagnostics.residualBelowMinus02Hours, 0);
  });
  await test('PD18 brak BMS: bilans nieznany, nie udawane zero', () => {
    const f = F.data(); f.settings.entities.bmsCharge = ''; f.settings.entities.bmsDischarge = '';
    const p = prepare(f); assert.ok(p.ok); assert.strictEqual(p.diagnostics.residualSumKwh, null);
    near(p.diagnostics.residualMissingHours, 24); near(p.diagnostics.residualKnownHours, 0);
    near(p.issues.filter(x => x.code === 'channel_not_configured').length, 2);
  });
  await test('PD19 brak kierunku/legacy flag eLicznika blokuje H, nie zeruje', () => {
    for (const value of [false, undefined]) {
      const f = F.data(); f.shared.hourlyElicznik['2026-09-01_12'].hasImport = value;
      assert.ok(!prepare(f).ok); assert.strictEqual(prepare(f).rows[12].loadAcKwh, null);
    }
  });
  await test('PD20 niezależny dom: zero ładowania AC nie jest wymagane, brak grid to ostrzeżenie', () => {
    const s = F.settings(); s.loadMode = 'meter'; s.entities.house = 'sensor.test_house';
    const f = F.data(s); f.shared.hourlyElicznik = {};
    const p = prepare(f); assert.ok(p.ok); near(p.historical['2026-09'].values.houseKwh.totalKwh, 5);
    assert.strictEqual(p.rows[12].buyPlnKwh, null);
  });
  await test('PD21 różne kanały nie mogą czytać tego samego licznika', () => {
    const s = F.settings(); s.entities.pv = s.entities.acOutput; assert.throws(() => D.entityIds(s), /samej encji/);
  });
  await test('PD22 zmiana zakresu/encjii unieważnia podpis, zmiana mocy nie wymaga pobierania', () => {
    const s = F.settings(), sig = D.signature(s); s.chargeDcKw = 77; assert.strictEqual(D.signature(s), sig);
    s.entities.pv = 'sensor.another'; assert.notStrictEqual(D.signature(s), sig);
  });
  await test('PD23 brak RCE/G13 nie zmienia danych energii ani nie wstawia stawki zastępczej', () => {
    const f = F.data(); delete f.shared.zoneRates.T2; f.shared.rceHourly['2026-09-01_12'] = null;
    const p = prepare(f); assert.ok(p.ok); assert.strictEqual(p.rows[12].rcePlnMwh, null); assert.strictEqual(p.rows[12].buyPlnKwh, null);
    near(p.rows[12].loadAcKwh, 2);
  });
  await test('PD24 DST: zachowane 25 UTC, 24 kroki, suma podwójnej 02, bez rozdziału cen', () => {
    const f = F.data(F.settings({ startDate: '2026-10-25', endDate: '2026-10-25' }));
    const ids = f.settings.entities;
    for (const id of [ids.pv, ids.acOutput]) {
      const pair = f.series[id].filter(r => D.localKey(r.ts) === '2026-10-25_02');
      pair[0].change = 2; pair[1].change = 6;
    }
    F.sumSeries(f.series); f.shared.hourlyElicznik['2026-10-25_02'].poborPoZbil = 7;
    let p = prepare(f); assert.ok(!p.ok); near(p.hourly.length, 25);
    f.settings.allowDstAggregation = true; p = prepare(f); assert.ok(p.ok);
    const r = p.rows.find(r => r.key.endsWith('_02'));
    near(r.durationHours, 2); near(r.pvDcKwh, 8); near(r.loadAcKwh, 15);
    assert.strictEqual(r.rcePlnMwh, null); near(p.rows.length, 24);
    near(p.rows[3].ts - r.ts, 2 * F.HOUR);
  });
  await test('PD25 wiosna: brak 02, żadnej sztucznej luki ani zerowego dopisku', () => {
    const p = prepare(F.data(F.settings({ startDate: '2026-03-29', endDate: '2026-03-29' })));
    assert.ok(p.ok); near(p.rows.length, 23); assert.ok(!p.rows.some(x => x.key.endsWith('_02')));
  });
  await test('PD26 statystyki SOC nie są stanami granicznymi; zakres 0–100 to flaga', () => {
    const f = F.data(); const r = f.series[f.settings.entities.soc][8]; r.mean = 90; r.min = 0; r.max = 100;
    const p = prepare(f); assert.ok(p.ok); near(p.diagnostics.socRangeFlags, 1); assert.ok(!('initialStoredKwh' in p));
  });
  await test('PD27 zastój PV/moc widoczny; wartość licznika nie jest podmieniana', () => {
    const f = F.data(); patch(f, 'pv', 12, 0); const p = prepare(f);
    assert.ok(p.issues.some(x => x.code === 'stalled_pv')); near(p.rows[12].pvDcKwh, 0);
  });
  await test('PD28 scalanie identycznych buforów nie dubluje; konflikt nie jest nadpisany', () => {
    const f = F.data(); const m = D.mergeSeries([f.series, f.series]); near(m[f.settings.entities.pv].length, 25);
    const other = JSON.parse(JSON.stringify(f.series)); other[f.settings.entities.pv][0].change = 100;
    assert.throws(() => D.mergeSeries([f.series, other]), /Sprzeczne/);
  });
  await test('PD29 wszystkie wejścia pozostają niezmienione po diagnostyce', () => {
    const f = F.data(), before = JSON.stringify(f); prepare(f); assert.strictEqual(JSON.stringify(f), before);
  });
  await test('PS01 osobny zapis i restart, brak wpisów do ledger/eLicznik/RCE/HA', async () => {
    const f = F.data(), legacy = F.legacyKv(f), m = mockStorage(legacy), store = S.create(m);
    await store.saveSettings(f.settings); await store.saveDataset(f.series, D.signature(f.settings));
    const restored = await S.create(m).loadDataset();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(D.mergeSeries(restored.parts))), JSON.parse(JSON.stringify(f.series)));
    assert.strictEqual(restored.signature, D.signature(f.settings));
    assert.deepStrictEqual(await S.create(m).loadSettings(), f.settings);
    for (const k of Object.keys(legacy)) assert.strictEqual(m.kv[k], legacy[k]);
    assert.ok(m.calls.filter(([op]) => ['PUT', 'DELETE'].includes(op)).every(([, key]) => key.startsWith(S.prefix)));
  });
  await test('PS02 błąd drugiego sharda: stary manifest i dane nadal kompletne', async () => {
    const f = F.data(), m = mockStorage(), store = S.create(m); await store.saveDataset(f.series, 'old');
    const oldActive = m.kv[S.prefix + 'active']; const large = F.data(F.settings({ endDate: '2026-09-30' }));
    m.reject = k => /-0001$/.test(k); await assert.rejects(store.saveDataset(large.series, 'new'));
    assert.strictEqual(m.kv[S.prefix + 'active'], oldActive); const ds = await store.loadDataset(); assert.strictEqual(ds.signature, 'old');
    near(Object.values(D.mergeSeries(ds.parts))[0].length, 25);
  });
  await test('PS03 utrata odpowiedzi po commit: nie usuwamy aktywnych shardów', async () => {
    const f = F.data(), m = mockStorage(), store = S.create(m);
    m.lostResponse = k => k === S.prefix + 'active'; await store.saveDataset(f.series, 'saved');
    const ds = await store.loadDataset(); assert.strictEqual(ds.signature, 'saved'); assert.ok(ds.parts.length);
  });
  await test('PS04 błędny odczyt/corrupt nie usuwa danych i nie zapisuje pustego stanu', async () => {
    const m = mockStorage({ [S.prefix + 'settings']: '{oops' }), store = S.create(m);
    await assert.rejects(store.loadSettings()); assert.strictEqual(m.kv[S.prefix + 'settings'], '{oops');
    assert.ok(!m.calls.some(([op]) => op !== 'GET'));
  });
  await test('PS05 złośliwy manifest nie pozwala odczytać cudzych kluczy', async () => {
    const m = mockStorage({ [S.prefix + 'active']: JSON.stringify({ schema: 1, generation: 'test', signature: 'x', keys: ['monthly-ledger'] }), 'monthly-ledger': 'private' });
    await assert.rejects(S.create(m).loadDataset(), /klucz/); assert.ok(!m.calls.some(([, k]) => k === 'monthly-ledger'));
  });
  await test('PS06 reset filtruje prefix i obce wyniki list; legacy bajtowo bez zmian', async () => {
    const f = F.data(), legacy = F.legacyKv(f), m = mockStorage(legacy), store = S.create(m);
    await store.saveSettings(f.settings); await store.saveDataset(f.series, 'x');
    m.extraKeys = ['monthly-ledger', 'rce-cache', 'ha-hourly-2026-09', 'pv-other-namespace'];
    await store.reset(); assert.deepStrictEqual(m.kv, legacy);
    assert.ok(m.calls.filter(([op]) => op === 'DELETE').every(([, k]) => k.startsWith(S.prefix)));
  });
  await test('PS07 serializacja zapisów ustawień; ostatnia zmiana wygrywa', async () => {
    const m = mockStorage(), store = S.create(m);
    await Promise.all([store.saveSettings({ order: 1 }), store.saveSettings({ order: 2 }), store.saveSettings({ order: 3 })]);
    assert.strictEqual((await store.loadSettings()).order, 3);
  });
  await test('PS08 reset podczas zapisu kolejkuje się po commicie, nie wskrzesza historii', async () => {
    const f = F.data(), m = mockStorage(), store = S.create(m);
    await Promise.all([store.saveDataset(f.series, 'x'), store.reset()]); assert.deepStrictEqual(m.kv, {});
  });
  await test('PS09 obcy nieaktywny shard nie jest usuwany przy zwykłym zapisie (in-flight innej karty)', async () => {
    const f = F.data(), other = S.prefix + 'data-other-window-0000', m = mockStorage({ [other]: 'do-not-sweep' });
    await S.create(m).saveDataset(f.series, 'x'); assert.strictEqual(m.kv[other], 'do-not-sweep');
  });
  await test('PS10 błąd settings nie nadpisuje poprzednich ani żadnych innych kluczy', async () => {
    const m = mockStorage(), store = S.create(m); await store.saveSettings({ x: 1 });
    m.reject = () => true; await assert.rejects(store.saveSettings({ x: 2 })); assert.deepStrictEqual(await store.loadSettings(), { x: 1 });
  });
  console.log(`\nPV data/store: ${passed} przeszło, ${failed} nie przeszło`);
  process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
