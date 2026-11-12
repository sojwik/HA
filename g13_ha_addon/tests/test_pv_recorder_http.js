'use strict';
/* Prawdziwy Express -> prawdziwy klient WS -> lokalny emulator protokołu HA.
 * NIE podmieniamy fetchStatistics. Dane i token są wyłącznie syntetyczne. */
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), net = require('net');
const { spawn } = require('child_process'), { once } = require('events');
const { WebSocketServer } = require('../app/node_modules/ws');
const F = require('./pv-fixture'), D = require('../app/public/pv-data');
const APP = path.resolve(__dirname, '../app'), TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-recorder-'));
let proc, ws, passed = 0, failed = 0, mode = 'W'; const messages = [];
async function test(name, fn) { try { await fn(); passed++; console.log('  ✓ ' + name); } catch (e) { failed++; console.error('  ✗ ' + name + '\n' + e.stack); } }
async function freePort() { const s = net.createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
(async () => {
  const f = F.data(), powerId = f.settings.entities.pvPower;
  ws = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(ws, 'listening');
  ws.on('connection', client => {
    client.send(JSON.stringify({ type: 'auth_required' }));
    client.on('message', raw => {
      const q = JSON.parse(raw);
      if (q.type === 'auth') { client.send(JSON.stringify({ type: q.access_token === 'synthetic-not-a-secret' ? 'auth_ok' : 'auth_invalid' })); return; }
      messages.push(q);
      if (q.type === 'recorder/get_statistics_metadata') {
        const nativeUnit = ['kW', 'modern-kW', 'modern-kW-display-W'].includes(mode) ? 'kW' : 'W';
        // Kształt modern wiernie odtwarza HA 2026.10:
        // recorder/statistics.py::_flatten_list_statistic_ids_metadata_result.
        const metadata = mode.startsWith('modern') ? {
          statistic_id: powerId, statistics_unit_of_measurement: nativeUnit,
          display_unit_of_measurement: mode.endsWith('display-W') ? 'W' : 'kW',
          unit_class: 'power', has_sum: false, has_mean: true, mean_type: 1, name: null, source: 'recorder'
        } : { statistic_id: powerId, unit_of_measurement: mode === 'unknown' ? '%' : nativeUnit, unit_class: mode === 'wrong-class' ? 'energy' : 'power' };
        if (mode === 'modern-both-same') metadata.unit_of_measurement = 'W';
        if (mode === 'modern-conflict') metadata.unit_of_measurement = 'kW';
        if (mode === 'modern-null') { metadata.statistics_unit_of_measurement = null; metadata.unit_of_measurement = 'W'; }
        if (mode === 'modern-unknown') metadata.statistics_unit_of_measurement = '%';
        if (mode === 'modern-wrong-class') metadata.unit_class = 'energy';
        if (mode === 'modern-no-class') delete metadata.unit_class;
        if (mode === 'modern-null-class') metadata.unit_class = null;
        if (mode === 'modern-display-only') delete metadata.statistics_unit_of_measurement;
        if (mode === 'modern-wrong-id') metadata.statistic_id = 'sensor.not_requested';
        const result = mode === 'missing' ? [] : ['duplicate', 'modern-duplicate'].includes(mode) ? [metadata, metadata]
          : mode === 'modern-object' ? { [powerId]: metadata } : [metadata];
        client.send(JSON.stringify({ id: q.id, type: 'result', success: mode !== 'metadata-error', result })); return;
      }
      if (q.type === 'recorder/statistics_during_period') {
        const result = Object.create(null);
        for (const id of q.statistic_ids) {
          result[id] = (f.series[id] || []).filter(r => r.ts >= Date.parse(q.start_time) && r.ts < Date.parse(q.end_time)).map(r => {
            const p = { start: r.ts, sum: r.sum, change: r.change, mean: r.mean, min: r.min, max: r.max };
            if (id === powerId) {
              const nativeFactor = ['kW', 'modern-kW', 'modern-kW-display-W'].includes(mode) ? 1 : 1000;
              const outputFactor = q.units && q.units.power === 'kW' && mode !== 'unknown' ? 1 / nativeFactor : 1;
              for (const k of ['mean', 'min', 'max']) p[k] *= nativeFactor * outputFactor;
            }
            return p;
          });
        }
        if (mode === 'extra-id') result['sensor.<script>'] = [{ start: f.span.start, mean: 9 }];
        client.send(JSON.stringify({ id: q.id, type: 'result', success: mode !== 'statistics-error', result: mode === 'empty' ? {} : result }));
        return;
      }
      client.send(JSON.stringify({ id: q.id, type: 'result', success: false, error: { message: 'unknown synthetic request' } }));
    });
  });
  const port = await freePort(), base = 'http://127.0.0.1:' + port;
  const options = path.join(TMP, 'options.json'); fs.writeFileSync(options, JSON.stringify({ growatt_entities: ['sensor.legacy_only'] }));
  const optionsBefore = fs.readFileSync(options, 'utf8');
  proc = spawn(process.execPath, ['server.js'], { cwd: APP, env: { ...process.env, PORT: String(port), DATA_DIR: TMP, OPTIONS_FILE: options,
    ADDON_TOKEN: '', SUPERVISOR_TOKEN: 'synthetic-not-a-secret', HA_WS_URL: 'ws://127.0.0.1:' + ws.address().port }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(proc, 'exit'); let log = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('HTTP startup timeout: ' + log)), 12000);
    proc.stdout.on('data', b => { log += b; if (String(b).includes('nasłuchuje')) { clearTimeout(timer); resolve(); } });
    proc.stderr.on('data', b => { log += b; }); proc.once('exit', () => { clearTimeout(timer); reject(Error('HTTP exited: ' + log)); });
  });
  const qs = new URLSearchParams({ entities: D.entityIds(f.settings).join(','), start: new Date(f.span.start - F.HOUR).toISOString(),
    end: new Date(f.span.end).toISOString(), types: 'change,sum,mean,min,max', power_entity: powerId });
  async function pv(query = qs) { return fetch(base + '/api/pv/stats.csv?' + query); }
  let parsedW;
  await test('PR01 recorder native W → żądane kW → CSV z jednostką → prawdziwy parser/diagnostyka', async () => {
    mode = 'W'; const r = await pv(); assert.strictEqual(r.status, 200); assert.strictEqual(r.headers.get('cache-control'), 'no-store');
    parsedW = D.parseStatsCsv(await r.text()); const p = D.prepare(parsedW, f.settings, f.shared);
    assert.strictEqual(parsedW[powerId][13].mean, 4); assert.strictEqual(parsedW[powerId][13].powerUnit, 'kW');
    assert.strictEqual(p.diagnostics.pvPowerApproxKwh, 4); assert.ok(!p.issues.some(i => i.code === 'power_disagrees'));
    const meta = messages.find(m => m.type === 'recorder/get_statistics_metadata'), stats = messages.find(m => m.type === 'recorder/statistics_during_period');
    assert.deepStrictEqual(meta.statistic_ids, [powerId]); assert.deepStrictEqual(stats.units, { energy: 'kWh', power: 'kW' });
    assert.deepStrictEqual(stats.statistic_ids, D.entityIds(f.settings)); assert.strictEqual(stats.period, 'hour');
  });
  await test('PR02 recorder native kW nie dzieli danych drugi raz', async () => {
    mode = 'kW'; const r = await pv(); assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(D.parseStatsCsv(await r.text()), parsedW);
  });
  for (const kind of ['modern-W', 'modern-kW', 'modern-kW-display-W', 'modern-both-same', 'modern-no-class', 'modern-null-class']) {
    await test('PR 0.3.7 rzeczywiste pole statistics_unit_of_measurement (' + kind + ') → kW bez podwójnego przeliczenia', async () => {
      mode = kind; const r = await pv(); assert.strictEqual(r.status, 200);
      const parsed = D.parseStatsCsv(await r.text()); assert.deepStrictEqual(parsed, parsedW);
      const p = D.prepare(parsed, f.settings, f.shared); assert.strictEqual(p.diagnostics.powerUnknownUnitHours, 0);
      assert.strictEqual(p.diagnostics.pvPowerKnownHours, 24); assert.strictEqual(p.diagnostics.pvPowerApproxKwh, 4);
    });
  }
  await test('PR03 stary endpoint i ha-ws zachowują energy-only oraz oryginalne W', async () => {
    mode = 'W'; const n = messages.length;
    const r = await fetch(base + '/api/ha/stats.csv?' + qs); assert.strictEqual(r.status, 200); const raw = await r.text();
    assert.ok(!raw.split('\n')[0].includes('power_unit'));
    const p = D.parseStatsCsv(raw); assert.strictEqual(p[powerId][13].mean, 4000); assert.strictEqual(p[powerId][13].powerUnit, undefined);
    assert.strictEqual(messages.length - n, 1); assert.deepStrictEqual(messages.at(-1).units, { energy: 'kWh' });
  });
  for (const kind of ['unknown', 'missing', 'wrong-class', 'duplicate', 'metadata-error', 'modern-conflict', 'modern-null', 'modern-unknown', 'modern-wrong-class', 'modern-display-only', 'modern-wrong-id', 'modern-duplicate', 'modern-object']) {
    await test('PR brak potwierdzonej jednostki (' + kind + ') nie jest domyślnym kW', async () => {
      mode = kind; const r = await pv(); assert.strictEqual(r.status, 200); const series = D.parseStatsCsv(await r.text());
      assert.strictEqual(series[powerId][13].powerUnit, undefined);
      const p = D.prepare(series, f.settings, f.shared); assert.strictEqual(p.diagnostics.powerUnknownUnitHours, 24);
      assert.strictEqual(p.diagnostics.pvPowerApproxKwh, null); assert.deepStrictEqual(p.rows, D.prepare(parsedW, f.settings, f.shared).rows);
      assert.ok(!p.issues.some(i => i.code === 'power_disagrees'));
    });
  }
  await test('PR09 błąd normalizacji/statystyk 502 bez fałszywego CSV i bez fallback units', async () => {
    mode = 'statistics-error'; const n = messages.length, r = await pv(); assert.strictEqual(r.status, 502);
    assert.ok((await r.json()).error.includes('normalizację')); assert.strictEqual(messages.length - n, 2);
  });
  await test('PR10 odpowiedź z obcymi encjami nie trafia do CSV', async () => {
    mode = 'extra-id'; const r = await pv(), text = await r.text(); assert.ok(!text.includes('<script>'));
    assert.deepStrictEqual(Object.keys(D.parseStatsCsv(text)).sort(), D.entityIds(f.settings));
  });
  await test('PR11 pusta historia nie staje się rekordami zerowymi', async () => {
    mode = 'empty'; const r = await pv(); assert.strictEqual(r.status, 200);
    const text = await r.text(); assert.throws(() => D.parseStatsCsv(text), /nagłówek/);
  });
  await test('PR12 walidacja query przed WS, brak żądań do urządzeń i zapisu opcji', async () => {
    mode = 'W'; const n = messages.length;
    for (const [key, value] of [['entities', 'sensor.<x>'], ['entities', 'sensor.a,sensor.a'], ['power_entity', 'sensor.not_requested'],
      ['start', 'bad'], ['start', '2026-09-01'], ['start', '2026-02-30T00:00:00Z'], ['end', '2026-09-02T00:00:00+02:00'], ['end', '2029-01-01'], ['types', 'state']]) {
      const q = new URLSearchParams(qs); q.set(key, value); const r = await pv(q); assert.strictEqual(r.status, 400, key);
    }
    assert.strictEqual(messages.length, n); assert.strictEqual(fs.readFileSync(options, 'utf8'), optionsBefore);
    const kv = await (await fetch(base + '/api/kv')).json(); assert.deepStrictEqual(kv.keys, []);
    assert.ok(messages.every(m => ['recorder/get_statistics_metadata', 'recorder/statistics_during_period'].includes(m.type)));
  });
  await test('PR13 brak wybranej mocy pomija metadane, nie blokuje liczników energii', async () => {
    const q = new URLSearchParams(qs); q.delete('power_entity'); const n = messages.length, r = await pv(q); assert.strictEqual(r.status, 200);
    assert.strictEqual(messages.length - n, 1); const data = D.parseStatsCsv(await r.text()); assert.strictEqual(data[powerId][13].powerUnit, undefined);
  });
  proc.kill('SIGTERM'); await exited; proc = null;
  await new Promise(resolve => ws.close(resolve)); ws = null; fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\nPV recorder/HTTP: ${passed} przeszło, ${failed} nie przeszło`); process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => {
  if (proc) proc.kill('SIGTERM');
  if (ws) { for (const c of ws.clients) c.terminate(); ws.close(); }
});
