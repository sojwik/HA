'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path');
const { JSDOM, VirtualConsole, ResourceLoader } = require('../app/node_modules/jsdom');
const F = require('./pv-fixture');
const D = require('../app/public/pv-data');
const S = require('../app/public/pv-store');
const DIR = path.join(__dirname, '../app/public');
let passed = 0, failed = 0; const instances = [];
async function test(name, fn) { try { await fn(); console.log('  ✓ ' + name); passed++; } catch (e) { failed++; console.error('  ✗ ' + name + '\n' + e.stack); } }
async function until(fn, label = 'warunek', timeout = 5000) {
  const stop = Date.now() + timeout;
  while (!fn()) { if (Date.now() > stop) throw new Error('Timeout: ' + label); await new Promise(r => setTimeout(r, 10)); }
}
function txt(d, id) { const n = d.window.document.getElementById(id); return n ? n.textContent.replace(/\s+/g, ' ').trim() : ''; }
const baselineIds = ['ledgerBody', 'ledgerFoot', 'readoutSaldo', 'roiBody', 'realBatteryBody', 'realBatteryFoot', 'bmsCompareBody',
  'magazynBody', 'magazynFoot', 'readoutMagazyn', 'readoutRealBattery', 'readoutPayback', 'tranchesBody', 'strefyBody', 'strefyFoot'];
function view(d) { return Object.fromEntries(baselineIds.map(id => [id, d.window.document.getElementById(id).innerHTML])); }
function legacyKv(kv) { return Object.fromEntries(Object.entries(kv).filter(([k]) => !k.startsWith(S.prefix))); }
function isolated(d, baseline) {
  assert.deepStrictEqual(view(d), baseline.view);
  assert.deepStrictEqual(legacyKv(d.kv), baseline.kv);
  assert.strictEqual(JSON.stringify(d.window.G13PvReadOnly.getSnapshot()), baseline.snapshot);
  assert.ok(d.calls.slice(baseline.callCount).filter(c => c.method !== 'GET').every(c => c.key && c.key.startsWith(S.prefix)));
}
function baseline(d) { return { view: view(d), kv: legacyKv(d.kv), snapshot: JSON.stringify(d.window.G13PvReadOnly.getSnapshot()), callCount: d.calls.length }; }
async function seed(f) {
  const kv = F.legacyKv(f);
  const storage = { async get(k) { return kv[k] === undefined ? null : { value: kv[k] }; }, async set(k, v) { kv[k] = v; },
    async delete(k) { delete kv[k]; }, async list(pre) { return { keys: Object.keys(kv).filter(k => k.startsWith(pre)) }; } };
  const store = S.create(storage); await store.saveSettings(f.settings); await store.saveDataset(f.series, D.signature(f.settings));
  return kv;
}
async function open(f, kvInput) {
  const kv = Object.assign({}, kvInput || await seed(f)), calls = [], errors = [];
  const control = { mode: 'ok', failPut: false, delay: null, corruptList: false };
  const vc = new VirtualConsole(); vc.on('jsdomError', e => errors.push(e.message)); vc.on('error', (...xs) => errors.push(xs.join(' ')));
  class LocalResources extends ResourceLoader {
    fetch(url) {
      const u = new URL(url);
      if (u.host !== 'g13.test') return Promise.resolve(Buffer.from('')); // żadnych fontów/sieci podczas testu
      const file = u.pathname.replace(/^\/ingress-test\//, '');
      const fp = path.join(DIR, file);
      if (!fp.startsWith(DIR) || !fs.existsSync(fp)) return Promise.reject(new Error('Nieznany asset: ' + url));
      return Promise.resolve(fs.readFileSync(fp));
    }
  }
  const d = new JSDOM(fs.readFileSync(path.join(DIR, 'index.html'), 'utf8'), {
    url: 'https://g13.test/ingress-test/', runScripts: 'dangerously', resources: new LocalResources(), virtualConsole: vc,
    beforeParse(w) {
      w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
      w.fetch = async (input, opts = {}) => {
        const raw = String(input), u = new URL(raw, w.location.href), method = opts.method || 'GET';
        const apiPath = u.pathname.replace(/^\/ingress-test\//, '');
        const key = apiPath.startsWith('api/kv/') ? decodeURIComponent(apiPath.slice(7)) : null;
        calls.push({ url: raw, path: u.pathname, method, key });
        const reply = (value, status = 200, text) => ({ ok: status >= 200 && status < 300, status,
          async json() { return value; }, async text() { return text === undefined ? JSON.stringify(value) : text; } });
        if (!u.pathname.startsWith('/ingress-test/')) return reply({ error: 'lost ingress prefix' }, 404);
        if (apiPath === 'api/config') return reply({ growattEntities: [], historyMonthsBack: 1, refreshIntervalMinutes: 60,
          bmsChargeEntity: f.settings.entities.bmsCharge, bmsDischargeEntity: f.settings.entities.bmsDischarge });
        if (apiPath === 'api/growatt/ha-stats.csv') return reply({}, 404);
        if (apiPath === 'api/pv/stats.csv') {
          if (control.delay) await control.delay;
          if (control.mode === 'http-error') return reply({ error: 'sztuczny błąd HA' }, 502);
          if (control.mode === 'spa') return reply({}, 200, '<html>Home Assistant SPA</html>');
          if (control.mode === 'power-only') return reply({}, 200, F.csv(f.series, [f.settings.entities.pvPower],
            Date.parse(u.searchParams.get('start')), Date.parse(u.searchParams.get('end'))));
          if (control.mode === 'missing-buffer') return reply({}, 200, F.csv(f.series, (u.searchParams.get('entities') || '').split(','),
            Date.parse(u.searchParams.get('start')) + F.HOUR, Date.parse(u.searchParams.get('end'))));
          return reply({}, 200, F.csv(f.series, (u.searchParams.get('entities') || '').split(','),
            Date.parse(u.searchParams.get('start')), Date.parse(u.searchParams.get('end'))));
        }
        if (apiPath === 'api/kv') return reply({ keys: Object.keys(kv).filter(k => k.startsWith(u.searchParams.get('prefix') || '')).concat(control.corruptList ? ['monthly-ledger'] : []) });
        if (key !== null) {
          if (method === 'PUT') {
            if ((control.failPut && key.startsWith(S.prefix)) || control.failKey === key) return reply({ error: 'sztuczny błąd KV' }, 503);
            kv[key] = JSON.parse(opts.body).value; return reply({ value: kv[key] });
          }
          if (method === 'DELETE') { delete kv[key]; return reply({ deleted: true }); }
          return kv[key] === undefined ? reply({}, 404) : reply({ value: kv[key] });
        }
        return reply({}, 404);
      };
    },
  });
  d.kv = kv; d.calls = calls; d.errors = errors; d.control = control; instances.push(d);
  await until(() => d.window.document.getElementById('tab-pv')?.dataset.ready === 'true', 'gotowość PV');
  await d.window.G13PvReadOnly.whenReady;
  await new Promise(r => setTimeout(r, 25)); // końcówka niezmienionego startu starej karty
  return d;
}
async function set(d, id, value) {
  const n = d.window.document.getElementById(id), before = d.calls.filter(x => x.method === 'PUT').length;
  if (n.type === 'checkbox') n.checked = value; else n.value = value;
  n.dispatchEvent(new d.window.Event('change', { bubbles: true }));
  await until(() => d.calls.filter(x => x.method === 'PUT').length > before, 'zapis ' + id);
  await new Promise(r => setTimeout(r, 10));
}
async function calc(d) {
  d.window.document.getElementById('pvCalculate').click();
  await new Promise(r => setTimeout(r, 15)); // await handler after resolved read-only bridge
  await until(() => !d.window.document.getElementById('pvResults').hidden || /Nie uruchomiono|Parametr|Podaj|Zaznacz|różnią|Najpierw/.test(txt(d, 'pvStatus')), 'wynik PV');
}
const X = require('../app/public/pv-export');
function xf(p = {}) { return F.data(F.settings(Object.assign({ calculationMode: 'export_only', exportPvToAcEta: .95, gridSource: 'auto' }, p))); }
async function accept(d) { if (!d.window.document.getElementById('pv-acceptScenario').checked) await set(d, 'pv-acceptScenario', true); }
function pvOwned(d) { return Object.fromEntries(Object.entries(d.kv).filter(([k]) => k.startsWith(S.prefix))); }
async function saveGrid(kv, data) {
  await S.create({ async get(k) { return kv[k] === undefined ? null : { value: kv[k] }; }, async set(k, v) { kv[k] = v; },
    async delete(k) { delete kv[k]; }, async list(pre) { return { keys: Object.keys(kv).filter(k => k.startsWith(pre)) }; } }).saveGridDataset(data);
}
(async () => {
  console.log('\n=== PV eksport: prawdziwy DOM, przełączanie i ponowne użycie danych ===');
  const f = xf(); f.settings.capacityKwh = null; f.settings.chargeDcKw = null; f.settings.dischargeDcKw = null;
  for (const r of f.series[f.settings.entities.acOutput]) r.change = 0; F.sumSeries(f.series);
  const d = await open(f), b = baseline(d);
  await test('EXUI01 nowy moduł lokalny, etykieta 0.3.9 i wybrany prosty tryb', () => {
    assert.ok(d.window.G13PvExport); assert.strictEqual(d.errors.length, 0, d.errors.join('\n'));
    assert.ok(txt(d, 'tab-pv').includes('0.3.9')); assert.strictEqual(d.window.document.getElementById('pv-calculationMode').value, 'export_only'); isolated(d, b);
  });
  await test('EXUI02 parametry/encje baterii i domu ukryte i nieaktywne, ale zachowane', () => {
    const doc = d.window.document;
    for (const id of ['pv-capacityKwh', 'pv-chargeCurrentA', 'pv-dischargeCurrentA', 'pv-batteryVoltageV', 'pv-loadScale', 'pv-entity-acOutput', 'pv-entity-acCharge', 'pv-entity-soc']) {
      assert.ok(doc.getElementById(id).parentElement.hidden, id); assert.ok(doc.getElementById(id).disabled, id);
    }
    assert.ok(doc.getElementById('pvLoadModeField').hidden); assert.ok(doc.getElementById('pvEfficiencyControl').hidden);
    assert.ok(!doc.getElementById('pv-exportPvToAcEta').parentElement.hidden); assert.ok(!doc.getElementById('pv-exportPvToAcEta').disabled);
    assert.ok(doc.getElementById('pvExportAssumptions').textContent.includes('Nie skalujemy eksportu')); isolated(d, b);
  });
  await test('EXUI03 ujemne H / brak parametrów baterii nie blokują nowej wyceny', async () => {
    await calc(d); assert.strictEqual(txt(d, 'pvExtraExport'), '3,80 kWh'); assert.strictEqual(txt(d, 'pvDepositDelta'), '1,87 zł');
    assert.strictEqual(txt(d, 'pvBenefit'), '1,87 zł'); assert.strictEqual(d.window.document.getElementById('pvAvoidedPurchase'), null);
    assert.strictEqual(d.window.document.getElementById('pvHouseBreakdown'), null); assert.ok(txt(d, 'pvDiagnostics').includes('Nie obliczamy H ani R'));
    assert.ok(txt(d, 'pvDiagnostics').includes('Błędów blokujących: 0')); isolated(d, b);
  });
  await test('EXUI04 wynik jawnie nie jest gotówką, prognozą pomiaru lub rocznym zwrotem', () => {
    const t = txt(d, 'pvResults');
    assert.ok(t.includes('Depozyt ≠ gotówka')); assert.ok(t.includes('Bez rocznego przeliczenia')); assert.ok(t.includes('NIE prognoza pomiaru'));
    assert.ok(t.includes('Nie liczymy oszczędności G13')); assert.ok(!t.includes('Końcowy SOC:')); isolated(d, b);
  });
  await test('EXUI05 istniejąca pełna historia użyta bez fetch i startup nie zapisuje niczego', () => {
    assert.ok(txt(d, 'pvDataStatus').includes('wcześniejsza historia PV')); assert.ok(!d.calls.some(c => c.path.endsWith('/api/pv/stats.csv')));
    assert.ok(d.calls.every(c => c.method === 'GET')); isolated(d, b);
  });
  await test('EXUI06 nowe pobranie żąda tylko PV DC i opcjonalnej mocy, zachowuje pełny cache', async () => {
    const old = pvOwned(d), n = d.calls.length; d.window.document.getElementById('pvFetch').click();
    await until(() => /Zapisano wyłącznie/.test(txt(d, 'pvStatus')), 'minimalny fetch');
    const call = d.calls.slice(n).find(c => c.path.endsWith('/api/pv/stats.csv')), u = new URL(call.url, d.window.location.href);
    assert.deepStrictEqual(u.searchParams.get('entities').split(',').sort(), X.entityIds(f.settings));
    assert.strictEqual(u.searchParams.get('power_entity'), f.settings.entities.pvPower);
    assert.strictEqual(u.searchParams.get('start'), new Date(f.span.start - F.HOUR).toISOString());
    assert.ok(call.url.startsWith('api/')); for (const [k, v] of Object.entries(old)) assert.strictEqual(d.kv[k], v, k);
    assert.ok(d.kv[S.prefix + 'export-active']); assert.ok(txt(d, 'pvDataStatus').includes('osobna historia prostego trybu')); isolated(d, b);
  });
  await test('EXUI07 502 minimalnego fetch nie podmienia żadnej aktywnej historii', async () => {
    const old = pvOwned(d); d.control.mode = 'http-error'; d.window.document.getElementById('pvFetch').click();
    await until(() => /nie powiodły się/.test(txt(d, 'pvStatus'))); assert.deepStrictEqual(pvOwned(d), old); d.control.mode = 'ok'; isolated(d, b);
  });
  await test('EXUI08 przełączenie na stary model wymaga zgody i nadal pokazuje ujemne H', async () => {
    await set(d, 'pv-calculationMode', 'dynamic_battery'); assert.strictEqual(d.window.document.getElementById('pvResults').hidden, true);
    assert.strictEqual(d.window.document.getElementById('pv-acceptScenario').checked, false);
    assert.strictEqual(d.window.document.getElementById('pv-capacityKwh').parentElement.hidden, false);
    await calc(d); assert.ok(txt(d, 'pvDiagnostics').includes('składniki ujemnego H')); assert.strictEqual(d.window.document.getElementById('pvResults').hidden, true);
    assert.ok(d.kv[S.prefix + 'active']); assert.ok(d.kv[S.prefix + 'export-active']); isolated(d, b);
  });
  await test('EXUI09 powrót do nowego trybu i restart zachowują oba cache/wybór', async () => {
    await set(d, 'pv-calculationMode', 'export_only'); await accept(d); await calc(d); const next = await open(f, d.kv), n = baseline(next);
    assert.strictEqual(next.window.document.getElementById('pv-calculationMode').value, 'export_only'); await calc(next);
    assert.strictEqual(txt(next, 'pvDepositDelta'), '1,87 zł'); assert.ok(!next.calls.some(c => c.path.endsWith('/api/pv/stats.csv'))); isolated(next, n); next.window.close(); isolated(d, b);
  });
  await test('EXUI10 zmiana założeń eksportu unieważnia zgodę i wynik', async () => {
    await set(d, 'pv-addedKwp', '0'); assert.strictEqual(d.window.document.getElementById('pv-acceptScenario').checked, false); await calc(d);
    assert.ok(txt(d, 'pvStatus').includes('Zaznacz akceptację')); await accept(d); await calc(d); assert.strictEqual(txt(d, 'pvExtraExport'), '0,00 kWh'); assert.strictEqual(txt(d, 'pvBenefit'), '0,00 zł'); isolated(d, b);
  });
  await test('EXUI11 0 limitu nie zeruje historii i daje jawną listę przekroczeń', async () => {
    await set(d, 'pv-addedKwp', '9.54'); await set(d, 'pv-exportAcKw', '0'); await accept(d); await calc(d);
    assert.strictEqual(txt(d, 'pvExtraExport'), '0,00 kWh'); assert.ok(txt(d, 'pvResults').includes('historyczny eksport przekracza')); assert.ok(txt(d, 'pvResults').includes('2,00 kWh')); isolated(d, b);
  });
  await test('EXUI12 pusta jedyna sprawność pozostaje nieznana i blokuje', async () => {
    await set(d, 'pv-exportPvToAcEta', ''); assert.ok(txt(d, 'pvExportEtaInfo').includes('nieznane')); await accept(d); await calc(d);
    assert.ok(txt(d, 'pvStatus').includes('exportPvToAcEta')); assert.ok(d.window.document.getElementById('pvResults').hidden); isolated(d, b);
  });
  await test('EXUI13 brak limitu wymaga jawnego checkboxa, nie bierze go z 12 kW/umowy', async () => {
    await set(d, 'pv-exportPvToAcEta', '95'); await set(d, 'pv-exportAcKw', ''); await accept(d); await calc(d);
    assert.ok(txt(d, 'pvStatus').includes('exportAcKw')); await set(d, 'pv-unlimitedExport', true); await accept(d); await calc(d);
    assert.ok(txt(d, 'pvResults').includes('jawnie bez limitu')); assert.strictEqual(txt(d, 'pvExtraExport'), '3,80 kWh'); isolated(d, b);
  });
  await test('EXUI14 stare ustawienia bez pola trybu nie są cicho przełączone', async () => {
    const ff = F.data(), old = await open(ff), bb = baseline(old); assert.strictEqual(old.window.document.getElementById('pv-calculationMode').value, 'dynamic_battery');
    assert.ok(txt(old, 'pvModeMigration').includes('bez cichej zmiany')); assert.ok(old.calls.every(c => c.method === 'GET')); await calc(old); assert.strictEqual(txt(old, 'pvBenefit'), '1,50 zł'); isolated(old, bb); old.window.close();
  });
  await test('EXUI15 jedna sprawność eksportu nie zmienia precyzji ani wartości starego zestawu', async () => {
    const ff = F.data(); ff.settings.pvToAcEta = .9412345678; const g = await open(ff), bb = baseline(g);
    await set(g, 'pv-calculationMode', 'export_only'); assert.strictEqual(g.window.document.getElementById('pv-exportPvToAcEta').value, '94.123457');
    await set(g, 'pv-costPln', '4000'); let sv = JSON.parse(g.kv[S.prefix + 'settings']).settings; assert.strictEqual(sv.exportPvToAcEta, .9412345678); assert.strictEqual(sv.pvToAcEta, .9412345678);
    const old = { ...sv.customEfficiencies }; await set(g, 'pv-exportPvToAcEta', '92'); sv = JSON.parse(g.kv[S.prefix + 'settings']).settings;
    assert.strictEqual(sv.exportPvToAcEta, .92); assert.strictEqual(sv.pvToAcEta, .9412345678); assert.deepStrictEqual(sv.customEfficiencies, old);
    await set(g, 'pv-calculationMode', 'dynamic_battery'); assert.strictEqual(g.window.document.getElementById('pv-pvToAcEta').value, '94.123457'); isolated(g, bb); g.window.close();
  });
  await test('EXUI16 nowy niezapisany formularz proponuje eksport bez narzucania prądów', async () => {
    const ff = xf(), g = await open(ff, F.legacyKv(ff)); assert.strictEqual(g.window.document.getElementById('pv-calculationMode').value, 'export_only');
    assert.strictEqual(g.window.document.getElementById('pv-chargeCurrentA').value, ''); assert.strictEqual(g.window.document.getElementById('pv-exportPvToAcEta').value, '95'); assert.strictEqual(g.window.document.getElementById('pv-acceptScenario').checked, false);
    assert.ok(g.calls.every(c => c.method === 'GET')); g.window.close();
  });
  await test('EXUI17 zakres tygodnia z cache miesiąca bez pobrania i bez usuwania godzin', async () => {
    const ff = xf({ endDate: '2026-09-30' }), g = await open(ff), bb = baseline(g), active = g.kv[S.prefix + 'active'];
    await set(g, 'pv-endDate', '2026-09-07'); await accept(g); await calc(g);
    assert.ok(txt(g, 'pvDataStatus').includes('podzakres')); assert.ok(txt(g, 'pvResults').includes('168 h')); assert.strictEqual(g.kv[S.prefix + 'active'], active); assert.ok(!g.calls.some(c => c.path.endsWith('/api/pv/stats.csv'))); isolated(g, bb); g.window.close();
  });
  await test('EXUI18 tydzień nie udaje pełnego miesiąca, prosi tylko o brakujący zakres HA', async () => {
    const ff = xf({ endDate: '2026-09-07' }), g = await open(ff), bb = baseline(g), active = g.kv[S.prefix + 'active'];
    await set(g, 'pv-endDate', '2026-09-30'); await accept(g); await calc(g);
    assert.ok(txt(g, 'pvStatus').includes('Krótka historia')); assert.ok(g.window.document.getElementById('pvResults').hidden); assert.strictEqual(g.kv[S.prefix + 'active'], active); isolated(g, bb); g.window.close();
  });
  await test('EXUI19 zapisany CSV automatycznie wystarcza przy starych brakujących flagach', async () => {
    const ff = xf(), grid = D.parseGridCsvFiles([{ name: 'saved.csv', text: F.gridCsv(ff.shared.hourlyElicznik) }]);
    for (const v of Object.values(ff.shared.hourlyElicznik)) { delete v.hasExport; delete v.hasImport; }
    const kv = await seed(ff); await saveGrid(kv, grid); const g = await open(ff, kv), bb = baseline(g), gridActive = g.kv[S.prefix + 'grid-active']; await calc(g);
    assert.ok(txt(g, 'pvGridAutoStatus').includes('tylko eksport')); assert.ok(txt(g, 'pvGridAutoStatus').includes('z zapisanego CSV PV: 24'));
    assert.strictEqual(txt(g, 'pvDepositDelta'), '1,87 zł'); assert.strictEqual(g.kv[S.prefix + 'grid-active'], gridActive); assert.ok(g.calls.every(c => c.method === 'GET')); isolated(g, bb); g.window.close();
  });
  await test('EXUI20 brak importu/stawek nie blokuje potwierdzonego eksportu', async () => {
    const ff = xf(); ff.shared.zoneRates = {}; for (const v of Object.values(ff.shared.hourlyElicznik)) delete v.hasImport;
    const g = await open(ff), bb = baseline(g); await calc(g); assert.strictEqual(txt(g, 'pvDepositDelta'), '1,87 zł'); assert.ok(txt(g, 'pvGridReport').includes('Import i G13 nie są kontrolą')); isolated(g, bb); g.window.close();
  });
  await test('EXUI21 konflikt eksportu pokazany w UI, bez wyboru wygodniejszej wartości', async () => {
    const ff = xf(), grid = D.parseGridCsvFiles([{ name: 'saved.csv', text: F.gridCsv(ff.shared.hourlyElicznik) }]); ff.shared.hourlyElicznik['2026-09-01_12'].oddaniePoZbil = 3;
    const kv = await seed(ff); await saveGrid(kv, grid); const g = await open(ff, kv), bb = baseline(g); await calc(g);
    assert.ok(g.window.document.getElementById('pvResults').hidden); assert.ok(txt(g, 'pvGridReport').includes('3,000000')); assert.ok(txt(g, 'pvGridReport').includes('2,000000')); isolated(g, bb); g.window.close();
  });
  await test('EXUI22 brak ceny przy dodatnim przyroście widoczny jako nieznane, nie 0', async () => {
    const ff = xf(); delete ff.shared.rceHourly['2026-09-01_12']; const g = await open(ff), bb = baseline(g); await calc(g);
    assert.strictEqual(txt(g, 'pvDepositDelta'), 'nieznane'); assert.strictEqual(txt(g, 'pvBenefit'), 'nieznane'); assert.ok(txt(g, 'pvResults').includes('NIE pełny wynik')); isolated(g, bb); g.window.close();
  });
  await test('EXUI23 nieznana jednostka mocy nie jest naprawiana w starym cache', async () => {
    const ff = xf(); for (const rs of ff.series[ff.settings.entities.pvPower]) delete rs.powerUnit;
    const g = await open(ff), bb = baseline(g), before = pvOwned(g); await calc(g);
    assert.ok(txt(g, 'pvDiagnostics').includes('bez potwierdzonej jednostki: 24 h')); assert.strictEqual(txt(g, 'pvExtraEnergy'), '4,00 kWh'); assert.deepStrictEqual(pvOwned(g), before); isolated(g, bb); g.window.close();
  });
  await test('EXUI24 dodatkowy AC nie wymaga hybrydy i nie twierdzi, że WIT będzie ładował', async () => {
    const ff = xf({ topology: 'ac_added', inverterAcKw: null, addedInverterAcKw: 2 }); const g = await open(ff), bb = baseline(g); await calc(g);
    assert.strictEqual(txt(g, 'pvExtraExport'), '2,00 kWh'); assert.ok(g.window.document.getElementById('pv-inverterAcKw').parentElement.hidden);
    assert.ok(txt(g, 'pvResults').includes('Bez modelowania ładowania baterii z AC')); isolated(g, bb); g.window.close();
  });
  await test('EXUI25 osobny błąd zapisu eksportu zachowuje poprzedni manifest i stary cache', async () => {
    const old = pvOwned(d); d.control.failKey = S.prefix + 'export-active'; d.window.document.getElementById('pvFetch').click();
    await until(() => /nie powiodły się/.test(txt(d, 'pvStatus'))); assert.deepStrictEqual(pvOwned(d), old); d.control.failKey = null; isolated(d, b);
  });
  await test('EXUI26 powtórzona godzina wymaga zgody i nie zgaduje ceny', async () => {
    const ff = xf({ startDate: '2026-10-25', endDate: '2026-10-25' });
    for (const r of ff.series[ff.settings.entities.pv]) if (D.localKey(r.ts) === '2026-10-25_02') r.change = 1;
    F.sumSeries(ff.series); const g = await open(ff), bb = baseline(g); await calc(g); assert.ok(g.window.document.getElementById('pvResults').hidden);
    await set(g, 'pv-allowDstAggregation', true); await accept(g); await calc(g); assert.strictEqual(txt(g, 'pvDepositDelta'), 'nieznane');
    assert.ok(txt(g, 'pvDiagnostics').includes('kroki 2 h: 1')); isolated(g, bb); g.window.close();
  });
  await test('EXUI27 nowy uszkodzony cache nie jest cicho kasowany, reset nadal dostępny', async () => {
    const ff = xf(), kv = await seed(ff); kv[S.prefix + 'export-active'] = '{bad'; const g = await open(ff, kv), bb = baseline(g);
    assert.ok(txt(g, 'pvStatus').includes('Nie udało się odczytać')); assert.ok(g.window.document.getElementById('pvCalculate').disabled);
    assert.ok(!g.window.document.getElementById('pvReset').disabled); assert.strictEqual(g.kv[S.prefix + 'export-active'], '{bad'); isolated(g, bb); g.window.close();
  });
  await test('EXUI28 nieznany tryb w zapisie odrzucany bez migracji/zapisu', async () => {
    const ff = xf({ calculationMode: 'unknown' }), kv = await seed(ff), g = await open(ff, kv), bb = baseline(g);
    assert.ok(txt(g, 'pvStatus').includes('Nieznany tryb')); assert.ok(g.window.document.getElementById('pvCalculate').disabled); assert.ok(g.calls.every(c => c.method === 'GET')); isolated(g, bb); g.window.close();
  });
  await test('EXUI31 HTTP 200 z samą mocą nie kasuje starego profilu i nie udaje świeżego PV', async () => {
    const old = pvOwned(d); d.control.mode = 'power-only'; d.window.document.getElementById('pvFetch').click();
    await until(() => /Nie aktywowano nowego profilu/.test(txt(d, 'pvStatus'))); assert.deepStrictEqual(pvOwned(d), old);
    assert.ok(d.window.document.getElementById('pvResults').hidden); d.control.mode = 'ok'; isolated(d, b);
  });
  await test('EXUI32 brak bufora nowego fetch nie aktywuje niepełnej historii', async () => {
    const old = pvOwned(d); d.control.mode = 'missing-buffer'; d.window.document.getElementById('pvFetch').click();
    await until(() => /Nie aktywowano nowego profilu/.test(txt(d, 'pvStatus'))); assert.deepStrictEqual(pvOwned(d), old);
    d.control.mode = 'ok'; isolated(d, b);
  });
  await test('EXUI29 reset dwuklikiem usuwa oba cache tylko z przestrzeni PV', async () => {
    assert.ok(d.kv[S.prefix + 'active'] && d.kv[S.prefix + 'export-active']); const old = pvOwned(d); d.window.document.getElementById('pvReset').click(); assert.deepStrictEqual(pvOwned(d), old);
    d.window.document.getElementById('pvReset').click(); await until(() => /Usunięto wyłącznie/.test(txt(d, 'pvStatus')));
    assert.deepStrictEqual(pvOwned(d), {}); assert.strictEqual(d.window.document.getElementById('pv-calculationMode').value, 'export_only'); isolated(d, b);
  });
  await test('EXUI30 żadnych błędów DOM, obcej sieci i zapisów poza PV', () => {
    assert.strictEqual(d.errors.length, 0, d.errors.join('\n')); assert.ok(d.calls.every(c => c.path.startsWith('/ingress-test/'))); isolated(d, b);
  });
  for (const i of instances) i.window.close();
  console.log(`\nPV eksport DOM: ${passed} przeszło, ${failed} nie przeszło`); process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error(e); for (const i of instances) i.window.close(); process.exitCode = 1; });
