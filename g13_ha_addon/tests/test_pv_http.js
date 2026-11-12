'use strict';
// Prawdziwy Express + KV, ale HA zastąpione lokalnym stubem. Zero urządzeń/sieci HA.
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { spawn } = require('child_process');
const A = require('../app/public/pv-annual'), R = require('../app/public/pv-available');
const S = require('../app/public/pv-store'), D = require('../app/public/pv-data'), X = require('../app/public/pv-export'), F = require('./pv-fixture');
const APP = path.resolve(__dirname, '../app'), TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'g13pv-http-'));
const PORT = 8297, BASE = 'http://127.0.0.1:' + PORT;
let passed = 0, failed = 0, proc;
async function test(name, fn) { try { await fn(); console.log('  ✓ ' + name); passed++; } catch (e) { failed++; console.error('  ✗ ' + name + '\n' + e.stack); } }
async function jsonRequest(method, key, value) {
  const r = await fetch(BASE + '/api/kv/' + encodeURIComponent(key), { method,
    headers: { 'Content-Type': 'application/json' }, body: value === undefined ? undefined : JSON.stringify({ value }) });
  if (!r.ok && r.status !== 404) throw new Error('HTTP ' + r.status);
  return { response: r, body: await r.json() };
}
(async () => {
  const haPath = path.join(APP, 'lib/ha-ws.js'), calls = path.join(TMP, 'ha-calls.jsonl');
  const stub = path.join(TMP, 'ha-stub.js');
  fs.writeFileSync(stub, `const fs = require('fs'); const id = ${JSON.stringify(haPath)};
const original = require(id); const fake = Object.assign({}, original, {
 async fetchStatistics(entities, start, end, types) {
  fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({entities, start, end, types})+'\\n');
  return Object.fromEntries(entities.map(id => [id, [
    {start: +start, sum: 100, change: 0, mean: 0, min: 0, max: 0},
    {start: +start+3600000, sum: 100.5, change: .5, mean: .5, min: .1, max: 1}
  ]]));
 }
}); require.cache[id].exports = fake;\n`);
  const options = path.join(TMP, 'options.json'); fs.writeFileSync(options, JSON.stringify({ growatt_entities: ['sensor.legacy_only'], history_months_back: 1 }));
  let log = '';
  proc = spawn(process.execPath, ['--require', stub, 'server.js'], { cwd: APP,
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: TMP, OPTIONS_FILE: options, ADDON_TOKEN: '' }), stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => proc.once('exit', resolve));
  proc.stdout.on('data', d => { log += d; }); proc.stderr.on('data', d => { log += d; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Start HTTP timeout: ' + log)), 12000);
    const onData = d => { if (String(d).includes('nasłuchuje')) { clearTimeout(timer); proc.stdout.off('data', onData); resolve(); } };
    proc.stdout.on('data', onData); proc.once('exit', code => { clearTimeout(timer); reject(new Error('Exit ' + code + ': ' + log)); });
  });
  console.log('\n=== PV: prawdziwy HTTP/KV i cache zasobów ===');
  const html = await (await fetch(BASE + '/')).text();
  for (const asset of ['pv-model.js', 'pv-data.js', 'pv-store.js', 'pv-tab.js', 'pv-tab.css', 'pv-form.js', 'pv-export.js', 'pv-annual.js', 'pv-available.js']) {
    await test('HTTP asset ' + asset + ': lokalny, prawidłowy tag treści i no-cache', async () => {
      const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(APP, 'public', asset))).digest('hex');
      assert.ok(html.includes(asset + '?v=' + String(parseInt(hash.slice(0, 12), 16))));
      const response = await fetch(BASE + '/' + asset); assert.strictEqual(response.status, 200);
      assert.ok(/no-cache/.test(response.headers.get('cache-control')));
      assert.strictEqual(await response.text(), fs.readFileSync(path.join(APP, 'public', asset), 'utf8'));
      assert.ok(response.headers.get('content-type').includes(asset.endsWith('.css') ? 'text/css' : 'javascript'));
    });
  }
  await test('HTTP nieznany zasób nie jest SPA 200', async () => {
    const r = await fetch(BASE + '/pv-not-here.js'); assert.strictEqual(r.status, 404); assert.deepStrictEqual(await r.json(), { error: 'not_found' });
  });
  await test('HTTP dotychczasowy eksport zachowuje wybrane encje i jawny UTC/typy', async () => {
    const qs = new URLSearchParams({ entities: 'sensor.test_pv,sensor.test_ac_charge', start: '2026-08-31T21:00:00Z', end: '2026-09-01T22:00:00Z', types: 'change,sum,mean,min,max' });
    const response = await fetch(BASE + '/api/ha/stats.csv?' + qs); assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get('content-type').startsWith('text/csv'));
    const data = D.parseStatsCsv(await response.text()); assert.deepStrictEqual(Object.keys(data).sort(), ['sensor.test_ac_charge', 'sensor.test_pv']);
    assert.strictEqual(data['sensor.test_pv'][1].ts, Date.parse('2026-08-31T22:00:00Z'));
    const [call] = fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepStrictEqual(call.entities, ['sensor.test_pv', 'sensor.test_ac_charge']); assert.ok(call.types.includes('change') && call.types.includes('sum'));
    assert.strictEqual(call.start, '2026-08-31T21:00:00.000Z');
  });
  await test('HTTP pobranie PV nie podmienia growatt_entities / pliku opcji', async () => {
    const cfg = await (await fetch(BASE + '/api/config')).json(); assert.deepStrictEqual(cfg.growattEntities, ['sensor.legacy_only']);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(options, 'utf8')).growatt_entities, ['sensor.legacy_only']);
  });
  await test('HTTP walidacja dowolnych encji jest nadal aktywna', async () => {
    const response = await fetch(BASE + '/api/ha/stats.csv?entities=sensor.%3Cscript%3E'); assert.strictEqual(response.status, 400);
  });
  const kv = {
    async get(k) { const r = await jsonRequest('GET', k); return r.response.status === 404 ? null : { value: r.body.value }; },
    async set(k, v) { await jsonRequest('PUT', k, v); }, async delete(k) { await jsonRequest('DELETE', k); },
    async list(prefix) { return await (await fetch(BASE + '/api/kv?prefix=' + encodeURIComponent(prefix))).json(); },
  };
  const legacy = JSON.stringify({ months: { '2026-09': { kwh: 123, przypis: 456 } }, extraBattery: { capacityKwh: 5 }, zoneRates: { T2: 1.5 } });
  const f = F.data(F.settings({ endDate: '2026-09-30' }));
  await kv.set('monthly-ledger', legacy);
  await test('HTTP wieloczęściowa historia <2 MB i manifest aktywowane dopiero po zapisie', async () => {
    const store = S.create(kv); await store.saveSettings(f.settings); await store.saveDataset(f.series, D.signature(f.settings));
    const loaded = await S.create(kv).loadDataset(); assert.ok(loaded.parts.length > 1);
    const combined = D.mergeSeries(loaded.parts); assert.strictEqual(combined[f.settings.entities.pv].length, 721);
    assert.strictEqual((await kv.get('monthly-ledger')).value, legacy);
  });
  await test('HTTP osobny CSV eLicznika zapisany i odczytany przez prawdziwy KV bez zmiany ledger', async () => {
    const st = S.create(kv), grid = D.parseGridCsvFiles([{ name: 'synthetic-grid.csv', text: F.gridCsv(f.shared.hourlyElicznik) }]);
    await st.saveGridDataset(grid); const read = D.validateGridDataset(await S.create(kv).loadGridDataset());
    assert.deepStrictEqual(read, grid); assert.strictEqual((await kv.get('monthly-ledger')).value, legacy);
    assert.ok((await kv.get(S.prefix + 'active')).value); // historia HA również zachowana
  });
  await test('HTTP eksport ma osobny aktywny manifest, pełna historia i ledger zachowane', async () => {
    const st = S.create(kv), old = (await kv.get(S.prefix + 'active')).value;
    const minimal = Object.fromEntries(X.entityIds(f.settings).map(id => [id, f.series[id]]));
    await st.saveExportDataset(minimal, X.signature(f.settings));
    const cached = await st.loadExportDataset(); assert.deepStrictEqual(D.mergeSeries(cached.parts), D.mergeSeries([minimal]));
    assert.strictEqual((await kv.get(S.prefix + 'active')).value, old); assert.strictEqual((await kv.get('monthly-ledger')).value, legacy);
  });
  await test('HTTP eksportowe shardy mieszczą się w tym samym ograniczeniu 2 MB KV', async () => {
    const manifest = JSON.parse((await kv.get(S.prefix + 'export-active')).value);
    for (const key of manifest.keys) { const value = (await kv.get(key)).value; assert.ok(Buffer.byteLength(JSON.stringify({value})) < 1800000); }
  });
  await test('HTTP roczne założenia/pochodzenie: restart, trzy historie i ledger nietknięte', async () => {
    const st = S.create(kv), keys = ['active','grid-active','export-active'].map(x => S.prefix+x);
    const before = await Promise.all(keys.map(async k => (await kv.get(k)).value));
    const cfg = { ...f.settings, calculationMode:'annual_estimate', ...A.defaults, addedKwp:3.18, costPln:4000, depositUseFraction:1,
      annualPriceOrigin:{kind:'historical_reference',startDate:'2026-09-01',endDate:'2026-09-30',hours:720,valuePlnKwh:.3,notAnnual:true} };
    await st.saveSettings(cfg); const saved = await S.create(kv).loadSettings(); assert.deepStrictEqual(saved,cfg);
    const result = A.estimate(saved); assert.ok(Math.abs(result.variants[1].annualBenefitPln-954)<1e-9);
    assert.deepStrictEqual(await Promise.all(keys.map(async k => (await kv.get(k)).value)),before);
    assert.strictEqual((await kv.get('monthly-ledger')).value,legacy);
  });
  await test('HTTP częściowe PV ma osobny manifest, stare historie/CSV/ledger zachowane', async () => {
    const st=S.create(kv), keys=['active','export-active','grid-active'].map(x=>S.prefix+x);
    const old=await Promise.all(keys.map(async k=>(await kv.get(k)).value));
    const settings={...f.settings,calculationMode:R.mode}, sparse=Object.fromEntries(R.entityIds(settings).map(id=>[id,f.series[id].filter((r,i)=>i!==12)]));
    await st.saveAvailableDataset(sparse,R.signature(settings)); const loaded=await S.create(kv).loadAvailableDataset();
    assert.deepStrictEqual(D.mergeSeries(loaded.parts),D.mergeSeries([sparse]));
    assert.deepStrictEqual(await Promise.all(keys.map(async k=>(await kv.get(k)).value)),old);
    assert.strictEqual((await kv.get('monthly-ledger')).value,legacy);
    assert.ok((await kv.get(S.prefix+'available-active')).value);
  });
  await test('HTTP reset usuwa tylko PV; health/ledger i starsze zasoby pozostają poprawne', async () => {
    await S.create(kv).reset(); assert.deepStrictEqual((await kv.list(S.prefix)).keys, []);
    assert.strictEqual((await kv.get('monthly-ledger')).value, legacy);
    assert.strictEqual((await fetch(BASE + '/api/health')).status, 200);
    assert.ok(html.includes('validate.js?v=') && html.includes('vendor/xlsx.full.min.js?v='));
  });
  proc.kill('SIGTERM'); await exited;
  fs.rmSync(TMP, { recursive: true, force: true }); // wyłącznie własny katalog testowy mkdtemp
  console.log(`\nPV HTTP: ${passed} przeszło, ${failed} nie przeszło`); process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error(e); if (proc) proc.kill('SIGTERM'); process.exitCode = 1; });
