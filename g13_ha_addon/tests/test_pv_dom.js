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
        if (apiPath === 'api/ha/stats.csv') {
          if (control.delay) await control.delay;
          if (control.mode === 'http-error') return reply({ error: 'sztuczny błąd HA' }, 502);
          if (control.mode === 'spa') return reply({}, 200, '<html>Home Assistant SPA</html>');
          return reply({}, 200, F.csv(f.series, (u.searchParams.get('entities') || '').split(','),
            Date.parse(u.searchParams.get('start')), Date.parse(u.searchParams.get('end'))));
        }
        if (apiPath === 'api/kv') return reply({ keys: Object.keys(kv).filter(k => k.startsWith(u.searchParams.get('prefix') || '')).concat(control.corruptList ? ['monthly-ledger'] : []) });
        if (key !== null) {
          if (method === 'PUT') {
            if (control.failPut && key.startsWith(S.prefix)) return reply({ error: 'sztuczny błąd KV' }, 503);
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
  await until(() => !d.window.document.getElementById('pvResults').hidden || /Nie uruchomiono|Parametr|Zaznacz|różnią|Najpierw/.test(txt(d, 'pvStatus')), 'wynik PV');
}
(async () => {
  console.log('\n=== PV: prawdziwy DOM, izolacja operacji i osobna trwałość ===');
  const f = F.data(), d = await open(f), before = baseline(d);
  await test('UI01 wszystkie moduły lokalne i gotowy osobny panel, brak błędów startu', () => {
    assert.strictEqual(d.errors.length, 0, d.errors.join('\n'));
    assert.ok(d.window.G13PvModel && d.window.G13PvData && d.window.G13PvStore);
    d.window.document.querySelector('[data-tab="pv"]').click();
    assert.strictEqual(d.window.document.getElementById('tab-pv').hidden, false);
    assert.strictEqual(d.window.document.getElementById('tab-depozyt').hidden, true);
    assert.ok(/Nie jest to zwalidowana/.test(txt(d, 'tab-pv')));
  });
  await test('UI02 bridge nie ujawnia months/extraBattery i zwraca głęboko zamrożoną KOPIĘ', () => {
    const b = d.window.G13PvReadOnly, one = b.getSnapshot(), two = b.getSnapshot();
    assert.ok(one !== two && one.hourlyElicznik !== two.hourlyElicznik);
    assert.ok(Object.isFrozen(one) && Object.isFrozen(one.hourlyElicznik['2026-09-01_12']));
    assert.strictEqual(one.months, undefined); assert.strictEqual(one.extraBattery, undefined);
    assert.throws(() => { one.hourlyElicznik['2026-09-01_12'].poborPoZbil = 12345; });
    assert.throws(() => { d.window.G13PvReadOnly = {}; }); isolated(d, before);
  });
  await test('UI03 rzeczywisty przycisk → 1,50 zł, dynamiczna bateria i trzy osobne miary', async () => {
    await calc(d);
    assert.strictEqual(txt(d, 'pvBenefit'), '1,50 zł'); assert.strictEqual(txt(d, 'pvAvoidedPurchase'), '1,50 zł');
    assert.strictEqual(txt(d, 'pvDepositDelta'), '0,00 zł'); assert.strictEqual(txt(d, 'pvExtraEnergy'), '4,00 kWh');
    assert.ok(/3,00 kWh/.test(txt(d, 'pvResults'))); isolated(d, before);
  });
  await test('UI04 wycena ma okres, brak rocznego zwrotu i nie udaje gotówki', () => {
    const s = txt(d, 'pvResults'); assert.ok(s.includes('2026-09-01') && s.includes('Depozyt ≠ gotówka'));
    assert.ok(s.includes('Bez rocznego zwrotu')); assert.ok(!/zł\/rok|lat zwrotu/.test(s));
  });
  await test('UI05 zmiana własnej pojemności/SOC nie dotyka żadnego starego wyniku/zapisu', async () => {
    await set(d, 'pv-capacityKwh', '14.336'); await set(d, 'pv-minSocPct', '10'); await set(d, 'pv-initialSocPct', '10');
    assert.ok(txt(d, 'pvWindow').includes('12,9024')); assert.ok(txt(d, 'pvWindow').includes('1,4336'));
    await calc(d); assert.strictEqual(txt(d, 'pvBenefit'), '1,50 zł'); isolated(d, before);
  });
  await test('UI06 0 dodatkowych kWp → 0 zł; zmiana ustawień czyści stary wynik', async () => {
    await set(d, 'pv-addedKwp', '0'); assert.strictEqual(d.window.document.getElementById('pvResults').hidden, true);
    await calc(d); assert.strictEqual(txt(d, 'pvBenefit'), '0,00 zł'); isolated(d, before);
  });
  await test('UI07 pusta moc nie jest unlimited/zero; wynik zablokowany', async () => {
    await set(d, 'pv-addedKwp', '9.54'); await set(d, 'pv-chargeDcKw', ''); await calc(d);
    assert.ok(/chargeDcKw/.test(txt(d, 'pvStatus'))); assert.strictEqual(d.window.document.getElementById('pvResults').hidden, true);
    isolated(d, before); await set(d, 'pv-chargeDcKw', '20');
  });
  await test('UI08 wyzerowanie mocy daje eksport, osobny depozyt 1,97 zł', async () => {
    await set(d, 'pv-chargeDcKw', '0'); await calc(d);
    assert.strictEqual(txt(d, 'pvAvoidedPurchase'), '0,00 zł'); assert.strictEqual(txt(d, 'pvDepositDelta'), '1,97 zł'); isolated(d, before);
    await set(d, 'pv-chargeDcKw', '20');
  });
  await test('UI09 pobranie HA: względny ingress URL, osobne encje/types/bufor', async () => {
    d.window.document.getElementById('pvFetch').click();
    await until(() => /Zapisano wyłącznie/.test(txt(d, 'pvStatus')), 'pobranie i commit');
    const call = d.calls.filter(c => c.path.endsWith('/api/ha/stats.csv')).at(-1), url = new URL(call.url, d.window.location.href);
    assert.ok(call.url.startsWith('api/ha/stats.csv?')); assert.strictEqual(url.pathname, '/ingress-test/api/ha/stats.csv');
    assert.strictEqual(url.searchParams.get('start'), new Date(f.span.start - F.HOUR).toISOString());
    assert.ok(url.searchParams.get('types').includes('change') && url.searchParams.get('types').includes('sum'));
    assert.strictEqual(url.searchParams.get('entities').split(',').sort().join(','), D.entityIds(f.settings).join(','));
    isolated(d, before);
  });
  await test('UI10 ponowne pobranie nie dubluje energii', async () => {
    const n = d.calls.length; d.window.document.getElementById('pvFetch').click();
    await until(() => d.calls.slice(n).some(c => c.method === 'PUT' && c.key === S.prefix + 'active'), 'nowy manifest');
    await until(() => !d.window.document.getElementById('pvFetch').disabled, 'koniec pobrania');
    await calc(d); assert.strictEqual(txt(d, 'pvBenefit'), '1,50 zł'); assert.strictEqual(txt(d, 'pvExtraEnergy'), '4,00 kWh'); isolated(d, before);
  });
  await test('UI11 502 HA zachowuje poprzedni aktywny zapis i nie zmienia legacy', async () => {
    const active = d.kv[S.prefix + 'active']; d.control.mode = 'http-error'; d.window.document.getElementById('pvFetch').click();
    await until(() => /nie powiodły się/.test(txt(d, 'pvStatus')), 'błąd HA');
    assert.strictEqual(d.kv[S.prefix + 'active'], active); assert.ok(/502/.test(txt(d, 'pvStatus')));
    assert.strictEqual(d.window.document.getElementById('pvResults').hidden, true); isolated(d, before);
  });
  await test('UI12 HTML 200 nie jest uznane za poprawne dane', async () => {
    const active = d.kv[S.prefix + 'active']; d.control.mode = 'spa'; d.window.document.getElementById('pvFetch').click();
    await until(() => /odpowiedź HTML/.test(txt(d, 'pvStatus')), 'SPA'); assert.strictEqual(d.kv[S.prefix + 'active'], active); isolated(d, before);
    d.control.mode = 'ok';
  });
  await test('UI13 restart przywraca własne parametry/dane, bez nowego pobrania HA', async () => {
    const restarted = await open(f, d.kv); await calc(restarted);
    assert.strictEqual(restarted.window.document.getElementById('pv-capacityKwh').value, '14.336');
    assert.strictEqual(txt(restarted, 'pvBenefit'), '1,50 zł');
    assert.ok(!restarted.calls.some(c => c.path.endsWith('/api/ha/stats.csv'))); restarted.window.close();
  });
  await test('UI14 błąd własnego KV nie mówi „zapisano”, nie narusza legacy', async () => {
    const old = d.kv[S.prefix + 'settings']; d.control.failPut = true;
    await set(d, 'pv-costPln', '8000'); assert.ok(/Błąd zapisu/.test(txt(d, 'pvSaveStatus')));
    assert.strictEqual(d.kv[S.prefix + 'settings'], old); isolated(d, before); d.control.failPut = false;
  });
  await test('UI15 dwuklik pobierania i zablokowane pola w locie nie uruchamiają drugiego requestu', async () => {
    let release; d.control.delay = new Promise(r => { release = r; });
    const n = d.calls.filter(c => c.path.endsWith('/api/ha/stats.csv')).length;
    const button = d.window.document.getElementById('pvFetch'); button.click(); button.click();
    await until(() => button.disabled, 'blokada'); assert.strictEqual(d.window.document.getElementById('pv-addedKwp').disabled, true);
    near(d.calls.filter(c => c.path.endsWith('/api/ha/stats.csv')).length - n, 1);
    release(); d.control.delay = null; await until(() => !button.disabled, 'koniec'); isolated(d, before);
  });
  await test('UI16 brak akceptacji scenariusza blokuje liczby, nie diagnozę', async () => {
    await set(d, 'pv-acceptScenario', false); await calc(d); assert.ok(/Zaznacz akceptację/.test(txt(d, 'pvStatus')));
    assert.ok(txt(d, 'pvDiagnostics').includes('Reszta R')); isolated(d, before); await set(d, 'pv-acceptScenario', true);
  });
  await test('UI17 jawny wariant bez limitów jest opisany', async () => {
    await set(d, 'pv-unlimitedExport', true); await calc(d); assert.ok(/idealizowany/.test(txt(d, 'pvResults')));
    isolated(d, before); await set(d, 'pv-unlimitedExport', false);
  });
  await test('UI18 zmiana encji wymaga zgodnego zestawu; błąd identyfikatora bez XSS', async () => {
    await set(d, 'pv-entity-pv', '"><img src=x onerror="window.pwned=1">');
    d.window.document.getElementById('pvFetch').click(); await until(() => /identyfikator/.test(txt(d, 'pvStatus')));
    assert.strictEqual(d.window.document.querySelector('#tab-pv img'), null); assert.strictEqual(d.window.pwned, undefined); isolated(d, before);
    await set(d, 'pv-entity-pv', f.settings.entities.pv);
  });
  await test('UI19 reset wymaga drugiego kliknięcia i nie usuwa kluczy z obcej listy', async () => {
    d.control.corruptList = true; const n = Object.keys(d.kv).length;
    d.window.document.getElementById('pvReset').click(); assert.strictEqual(Object.keys(d.kv).length, n);
    d.window.document.getElementById('pvReset').click(); await until(() => /Usunięto wyłącznie/.test(txt(d, 'pvStatus')));
    assert.ok(!Object.keys(d.kv).some(k => k.startsWith(S.prefix))); isolated(d, before);
    assert.strictEqual(d.window.document.getElementById('pv-capacityKwh').value, '14.336');
    assert.strictEqual(d.window.document.getElementById('pv-minSocPct').value, '10');
    assert.strictEqual(d.window.document.getElementById('pv-chargeDcKw').value, '');
    assert.strictEqual(d.window.document.getElementById('pv-topology').value, '');
  });
  await test('UI20 corrupt settings: brak nadpisania, jawne czyszczenie tylko PV', async () => {
    const kv = F.legacyKv(f); kv[S.prefix + 'settings'] = '{corrupt';
    const bad = await open(f, kv), b = baseline(bad);
    assert.ok(/Nie udało się odczytać/.test(txt(bad, 'pvStatus')));
    assert.strictEqual(bad.window.document.getElementById('pvCalculate').disabled, true);
    assert.strictEqual(bad.kv[S.prefix + 'settings'], '{corrupt');
    bad.window.document.getElementById('pvReset').click(); bad.window.document.getElementById('pvReset').click();
    await until(() => /Usunięto wyłącznie/.test(txt(bad, 'pvStatus'))); isolated(bad, b); bad.window.close();
  });
  await test('UI21 nieznane RCE widoczne w prawdziwych komórkach, nie „0,00 zł”', async () => {
    const f2 = F.data(); f2.settings.chargeDcKw = 0; delete f2.shared.rceHourly['2026-09-01_12'];
    const noPrice = await open(f2); await calc(noPrice);
    assert.strictEqual(txt(noPrice, 'pvDepositDelta'), 'nieznane'); assert.strictEqual(txt(noPrice, 'pvBenefit'), 'nieznane');
    assert.ok(/NIE pełny wynik/.test(txt(noPrice, 'pvResults'))); noPrice.window.close();
  });
  await test('UI22 duża ujemna reszta widoczna; nie blokuje po akceptacji i nie jest „naprawiona”', async () => {
    const f2 = F.data(); const r = f2.series[f2.settings.entities.acOutput].find(r => D.localKey(r.ts) === '2026-09-01_12'); r.change = 4.5; F.sumSeries(f2.series);
    const diag = await open(f2); await calc(diag);
    assert.ok(txt(diag, 'pvDiagnostics').includes('reszta < −0,2 kWh: 1'));
    assert.ok(txt(diag, 'pvDiagnostics').includes('-0,500000')); assert.ok(!diag.window.document.getElementById('pvResults').hidden); diag.window.close();
  });
  await test('UI23 brak stawki G13, nie bierze 0,63 / wartości faktury / manualRate', async () => {
    const f2 = F.data(); f2.shared.zoneRates = {}; const np = await open(f2); await calc(np);
    assert.strictEqual(txt(np, 'pvAvoidedPurchase'), 'nieznane'); assert.strictEqual(txt(np, 'pvBenefit'), 'nieznane'); np.window.close();
  });
  await test('UI24 zmiana stawki w starej karcie jest wyłącznie odczytana przy ponownym liczeniu PV', async () => {
    const g = await open(f); await calc(g); assert.strictEqual(txt(g, 'pvBenefit'), '1,50 zł');
    await set(g, 'zoneRate_T2', '0.90'); const changedBaseline = baseline(g);
    await calc(g); assert.strictEqual(txt(g, 'pvBenefit'), '0,90 zł'); isolated(g, changedBaseline); g.window.close();
  });
  await test('UI25 automatyczne odświeżanie tylko w tej karcie i tylko po jawnym włączeniu', async () => {
    const g = await open(f), b = baseline(g); await set(g, 'pv-autoRefresh', true);
    const n = g.calls.length; g.window.document.querySelector('[data-tab="pv"]').click();
    await until(() => /Zapisano wyłącznie/.test(txt(g, 'pvStatus')));
    assert.ok(g.calls.slice(n).some(c => c.path.endsWith('/api/ha/stats.csv'))); isolated(g, b); g.window.close();
  });
  await test('UI26 żadnych nieobsłużonych błędów DOM/obcej sieci', () => {
    assert.strictEqual(d.errors.length, 0, d.errors.join('\n'));
    assert.ok(d.calls.every(c => c.path.startsWith('/ingress-test/')));
  });
  for (const x of instances) x.window.close();
  console.log(`\nPV DOM: ${passed} przeszło, ${failed} nie przeszło`); process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error(e); for (const x of instances) x.window.close(); process.exitCode = 1; });
function near(a, b) { assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`); }
