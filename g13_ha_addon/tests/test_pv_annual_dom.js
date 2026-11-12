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
function txt(d, id) { const n = d.window.document.getElementById(id); return n ? n.textContent.replace(/\s+/g, ' ').replace(/(\d) (?=\d)/g, '$1').trim() : ''; }
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
async function open(f, kvInput, bridgeOptions = {}) {
  const kv = Object.assign({}, kvInput || await seed(f)), calls = [], errors = [];
  const control = { mode: 'ok', failPut: false, delay: null, corruptList: false };
  let originalBridge = null, releaseBridge = null; const bridgeGate = new Promise(r => { releaseBridge = r; });
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
      if (bridgeOptions.holdBridge) {
        const define = w.Object.defineProperty;
        w.Object.defineProperty = function(target, key, descriptor) {
          if (target === w && key === 'G13PvReadOnly') {
            originalBridge = descriptor.value;
            descriptor = { ...descriptor, value: Object.freeze({ ...originalBridge,
              whenReady: Promise.all([originalBridge.whenReady, bridgeGate]),
              getSnapshot: bridgeOptions.failSnapshot ? () => { throw new Error('Annual must not read legacy snapshot'); } : originalBridge.getSnapshot }) };
            w.Object.defineProperty = define;
          }
          return define(target, key, descriptor);
        };
      }
      w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
      w.__intervalCallbacks=[]; const nativeInterval=w.setInterval.bind(w);
      w.setInterval=(fn,ms,...args)=>{w.__intervalCallbacks.push({fn,ms});return nativeInterval(fn,ms,...args);};
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
  d.releaseBridge = releaseBridge;
  await (originalBridge || d.window.G13PvReadOnly).whenReady;
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
const A = require('../app/public/pv-annual');
const af = (patch={}) => F.data(F.settings({ calculationMode:'annual_estimate', ...A.defaults, addedKwp:3.18, costPln:4000, depositUseFraction:1, exportPvToAcEta:.95, gridSource:'auto', ...patch }));
async function noHistory(f) { const kv=await seed(f); for(const k of Object.keys(kv))if(k.startsWith(S.prefix)&&k!==S.prefix+'settings')delete kv[k];return kv; }
function noHA(d){assert.ok(!d.calls.some(c=>c.path.endsWith('/api/pv/stats.csv')),'unexpected HA fetch');}
function histories(d){return Object.fromEntries(Object.entries(d.kv).filter(([k])=>k.startsWith(S.prefix)&&k!==S.prefix+'settings'));}
(async()=>{
 console.log('\n=== PV roczny: rzeczywisty DOM, niezależność od historii i izolacja ===');
 const f=af(); f.shared.hourlyElicznik={};f.shared.rceHourly={};f.shared.zoneRates={};
 const d=await open(f,await noHistory(f)),b=baseline(d);
 await test('ANUI01 osobny moduł/tryb039 i jawne założenia startowe',()=>{const doc=d.window.document;assert.ok(d.window.G13PvAnnual);assert.ok(txt(d,'tab-pv').includes('0.3.9'));assert.strictEqual(doc.getElementById('pv-calculationMode').value,'annual_estimate');assert.strictEqual(doc.getElementById('pv-annualYieldAcKwhPerKwp').value,'1000');assert.strictEqual(doc.getElementById('pv-annualDepositPlnKwh').value,'0.3');assert.ok(txt(d,'pvScenarioIntro').includes('przykładowe'));assert.ok(txt(d,'pvAnnualInfo').includes('NIE przedział ufności'));isolated(d,b);});
 await test('ANUI02 historia/topologia/limity/eta ukryte i nieużywane',()=>{const doc=d.window.document;assert.ok(doc.getElementById('pvDataSection').hidden);assert.ok(doc.getElementById('pvDiagnosticsSection').hidden);for(const id of ['pv-topology','pv-capacityKwh','pv-chargeCurrentA','pv-inverterAcKw','pv-exportAcKw','pv-exportPvToAcEta','pv-pvToAcEta','pvFetch','pv-startDate','pv-allowDstAggregation'])assert.ok(doc.getElementById(id).disabled,id);for(const id of ['pv-addedKwp','pv-costPln','pv-annualDepositPlnKwh','pv-annualYieldAcKwhPerKwp'])assert.ok(!doc.getElementById(id).disabled,id);isolated(d,b);});
 await test('ANUI03 obliczenie bez jakiejkolwiek historii/CSV/RCE/G13',async()=>{await calc(d);assert.strictEqual(txt(d,'pvAnnualEnergy'),'3180,00 kWh');assert.strictEqual(txt(d,'pvAnnualBenefit'),'954,00 zł');assert.strictEqual(txt(d,'pvAnnualPayback'),'4,19 lat');assert.strictEqual(txt(d,'pvAnnualRoi'),'23,85%');noHA(d);assert.ok(d.calls.every(c=>c.method==='GET'));isolated(d,b);});
 await test('ANUI04 tabela trzech wariantów:667.80/954/1240.20',()=>{const t=txt(d,'pvResults');for(const x of ['Ostrożny','Środkowy','Korzystny','667,80 zł','954,00 zł','1240,20 zł','5,99 lat','3,23 lat'])assert.ok(t.includes(x),x);assert.ok(t.includes('różnią się tylko'));isolated(d,b);});
 await test('ANUI05 jawne ograniczenia: bez podwójnegoeta/1.23, bez fikcyjnej historii',()=>{const t=txt(d,'pvResults')+' '+txt(d,'pvAnnualInfo');for(const x of ['Depozyt ≠ gotówka','nie annualizacja','nie stosujemy drugi raz','bez dodatkowego mnożnika 1,23','nie zostały uzupełnione zerami','Pomijamy degradację','Saldo depozytu nie zostało powiększone'])assert.ok(t.includes(x),x);assert.strictEqual(d.window.document.getElementById('pvDepositDelta'),null);assert.strictEqual(d.window.document.getElementById('pvHouseBreakdown'),null);isolated(d,b);});
 await test('ANUI06 zmiana założeń unieważnia zgodę/wynik, bez fetch',async()=>{await set(d,'pv-annualDepositPlnKwh','.25');assert.ok(d.window.document.getElementById('pvResults').hidden);assert.strictEqual(d.window.document.getElementById('pv-acceptScenario').checked,false);await calc(d);assert.ok(txt(d,'pvStatus').includes('Zaznacz akceptację'));await accept(d);await calc(d);assert.strictEqual(txt(d,'pvAnnualBenefit'),'795,00 zł');noHA(d);isolated(d,b);});
 await test('ANUI07 wykorzystanie50% działa raz, nie zmienia przypisu',async()=>{await set(d,'pv-annualDepositPlnKwh','.3');await set(d,'pv-depositUseFraction','50');await accept(d);await calc(d);assert.strictEqual(txt(d,'pvAnnualBenefit'),'477,00 zł');assert.strictEqual(txt(d,'pvAnnualPayback'),'8,39 lat');assert.ok(txt(d,'pvResults').includes('przypis 954,00 zł × 50,0%'));isolated(d,b);});
 await test('ANUI08 wykorzystanie0 daje brak zwrotu, nie Infinity',async()=>{await set(d,'pv-depositUseFraction','0');await accept(d);await calc(d);assert.strictEqual(txt(d,'pvAnnualBenefit'),'0,00 zł');assert.strictEqual(txt(d,'pvAnnualPayback'),'brak zwrotu przy tych założeniach');assert.strictEqual(txt(d,'pvAnnualRoi'),'0,00%');assert.ok(!txt(d,'pvResults').includes('Infinity'));isolated(d,b);});
 await test('ANUI09 puste/zerowe koszty nadal pokazują energię i korzyść',async()=>{await set(d,'pv-depositUseFraction','100');for(const value of ['', '0']){await set(d,'pv-costPln',value);await accept(d);await calc(d);assert.strictEqual(txt(d,'pvAnnualBenefit'),'954,00 zł');assert.strictEqual(txt(d,'pvAnnualPayback'),'podaj dodatni koszt');assert.strictEqual(txt(d,'pvAnnualRoi'),'podaj dodatni koszt');}isolated(d,b);});
 await test('ANUI10 jawna zerowa produkcja nie wymaga historii',async()=>{await set(d,'pv-costPln','4000');await set(d,'pv-addedKwp','0');await accept(d);await calc(d);assert.strictEqual(txt(d,'pvAnnualEnergy'),'0,00 kWh');assert.strictEqual(txt(d,'pvAnnualPayback'),'brak zwrotu przy tych założeniach');isolated(d,b);});
 await test('ANUI11 pusta cena lub uzysk nie są cicho zerem',async()=>{await set(d,'pv-addedKwp','3.18');for(const id of ['pv-annualDepositPlnKwh','pv-annualYieldAcKwhPerKwp']){const old=d.window.document.getElementById(id).value;await set(d,id,'');await accept(d);await calc(d);assert.ok(d.window.document.getElementById('pvResults').hidden);assert.ok(txt(d,'pvStatus').includes(id.slice(3)));await set(d,id,old);}isolated(d,b);});
 await test('ANUI12 niewłaściwe historyczne daty/encje nie blokują roku',async()=>{await set(d,'pv-startDate','');await set(d,'pv-endDate','');await set(d,'pv-entity-pv','bad entity');await accept(d);await calc(d);assert.strictEqual(txt(d,'pvAnnualBenefit'),'954,00 zł');noHA(d);isolated(d,b);});
 await test('ANUI13 autoRefresh zachowane, ale roczny nie planuje/wykonuje HA',async()=>{await set(d,'pv-autoRefresh',true);d.window.document.querySelector('[data-tab="pv"]').click();d.window.document.getElementById('pvFetch').click();assert.ok(!d.window.__intervalCallbacks.some(x=>x.fn.toString().includes('fetchData')));await accept(d);await calc(d);noHA(d);assert.strictEqual(JSON.parse(d.kv[S.prefix+'settings']).settings.autoRefresh,true);isolated(d,b);});
 await test('ANUI14 niedostępne odniesienie informacyjne, nadal oblicza',async()=>{d.window.document.getElementById('pvAnnualReference').click();await until(()=>/Odniesienie opcjonalne/.test(txt(d,'pvAnnualReferenceSummary')));assert.ok(d.window.document.getElementById('pvAnnualUseReference').disabled);await calc(d);assert.strictEqual(txt(d,'pvAnnualBenefit'),'954,00 zł');noHA(d);isolated(d,b);});
 await test('ANUI15 zapis/ponowne otwarcie zachowuje wartości i precyzję',async()=>{await set(d,'pv-annualDepositPlnKwh','.3123456789');await set(d,'pv-annualYieldAcKwhPerKwp','997.1234567');await set(d,'pv-annualPriceSpreadFraction','21.23456789');const raw=JSON.parse(d.kv[S.prefix+'settings']).settings;await set(d,'pv-costPln','4100');const sv=JSON.parse(d.kv[S.prefix+'settings']).settings;assert.strictEqual(sv.annualPriceSpreadFraction,raw.annualPriceSpreadFraction);const g=await open(f,d.kv);assert.strictEqual(g.window.document.getElementById('pv-annualDepositPlnKwh').value,'.3123456789'.replace(/^\./,'0.'));assert.strictEqual(g.window.document.getElementById('pv-annualYieldAcKwhPerKwp').value,'997.1234567');assert.strictEqual(JSON.parse(g.kv[S.prefix+'settings']).settings.annualPriceSpreadFraction,raw.annualPriceSpreadFraction);noHA(g);assert.ok(g.calls.every(c=>c.method==='GET'));g.window.close();isolated(d,b);});
 await test('ANUI16 niespójne stare limity i bateria nie są wejściem rocznym',async()=>{const ff=af({capacityKwh:null,chargeCurrentA:null,dischargeCurrentA:null,inverterAcKw:null,exportAcKw:null,topology:'',exportPvToAcEta:null,addedYieldFactor:null});const g=await open(ff,await noHistory(ff)),bb=baseline(g);await calc(g);assert.strictEqual(txt(g,'pvAnnualBenefit'),'954,00 zł');noHA(g);isolated(g,bb);g.window.close();});
 await test('ANUI17 przełączanie zachowuje trzy tryby, stare eta i cache',async()=>{const ff=af();ff.settings.pvToAcEta=.9412345678;ff.settings.exportPvToAcEta=.9345678912;const g=await open(ff),bb=baseline(g),old=histories(g);await set(g,'pv-calculationMode','export_only');assert.ok(!g.window.document.getElementById('pvDataSection').hidden);assert.ok(!g.window.document.getElementById('pv-exportPvToAcEta').parentElement.hidden);assert.ok(g.window.document.getElementById('pv-annualDepositPlnKwh').parentElement.hidden);await set(g,'pv-calculationMode','dynamic_battery');assert.ok(!g.window.document.getElementById('pv-capacityKwh').parentElement.hidden);await set(g,'pv-calculationMode','annual_estimate');assert.strictEqual(g.window.document.getElementById('pv-acceptScenario').checked,false);const sv=JSON.parse(g.kv[S.prefix+'settings']).settings;assert.strictEqual(sv.pvToAcEta,.9412345678);assert.strictEqual(sv.exportPvToAcEta,.9345678912);assert.deepStrictEqual(histories(g),old);isolated(g,bb);g.window.close();});
 await test('ANUI18 zapis038 nie jest automatycznie przełączany ani nadpisany',async()=>{const ff=xf(),g=await open(ff),bb=baseline(g);assert.strictEqual(g.window.document.getElementById('pv-calculationMode').value,'export_only');assert.strictEqual(g.window.document.getElementById('pv-annualYieldAcKwhPerKwp').value,'1000');assert.ok(g.calls.every(c=>c.method==='GET'));await set(g,'pv-calculationMode','annual_estimate');assert.strictEqual(g.window.document.getElementById('pv-acceptScenario').checked,false);isolated(g,bb);g.window.close();});
 await test('ANUI19 uszkodzona opcjonalna historia nie wymusza czyszczenia do ROI',async()=>{const ff=af(),kv=await seed(ff);kv[S.prefix+'export-active']='not-json';const g=await open(ff,kv),bb=baseline(g),old=histories(g);assert.ok(!g.window.document.getElementById('pvCalculate').disabled);assert.ok(txt(g,'pvAnnualInfo').includes('niedostępny/uszkodzony'));await calc(g);assert.strictEqual(txt(g,'pvAnnualBenefit'),'954,00 zł');await set(g,'pv-annualDepositPlnKwh','.4');await accept(g);await calc(g);assert.strictEqual(txt(g,'pvAnnualBenefit'),'1272,00 zł');assert.deepStrictEqual(histories(g),old);noHA(g);isolated(g,bb);g.window.close();});
 await test('ANUI20 przejście z zablokowanej historii na rok bez kasowania',async()=>{const ff=xf(),kv=await seed(ff);kv[S.prefix+'export-active']='not-json';const g=await open(ff,kv),bb=baseline(g),old=histories(g);assert.ok(g.window.document.getElementById('pvCalculate').disabled);assert.ok(!g.window.document.getElementById('pv-calculationMode').disabled);await set(g,'pv-calculationMode','annual_estimate');await accept(g);await calc(g);assert.ok(!g.window.document.getElementById('pvResults').hidden);assert.deepStrictEqual(histories(g),old);await set(g,'pv-calculationMode','export_only');assert.ok(g.window.document.getElementById('pvCalculate').disabled);isolated(g,bb);g.window.close();});
 await test('ANUI21 uszkodzone ustawienia nie są nadpisywane pod pretekstem uproszczenia',async()=>{const ff=af(),kv=await seed(ff);kv[S.prefix+'settings']='not-json';const g=await open(ff,kv),bb=baseline(g);assert.ok(g.window.document.getElementById('pvCalculate').disabled);assert.ok(g.window.document.getElementById('pv-calculationMode').disabled);assert.ok(g.calls.every(c=>c.method==='GET'));assert.strictEqual(g.kv[S.prefix+'settings'],'not-json');isolated(g,bb);g.window.close();});
 await test('ANUI22 awaria zapisu ustawień jawna, wyliczenie lokalne bez fałszu zapisu',async()=>{const ff=af(),g=await open(ff),bb=baseline(g),raw=g.kv[S.prefix+'settings'];g.control.failPut=true;await set(g,'pv-annualDepositPlnKwh','.4');assert.ok(txt(g,'pvSaveStatus').includes('tylko w pamięci'));assert.strictEqual(g.kv[S.prefix+'settings'],raw);await accept(g);await calc(g);assert.strictEqual(txt(g,'pvAnnualBenefit'),'1272,00 zł');isolated(g,bb);g.window.close();});
 const hf=af(),h=await open(hf),hb=baseline(h),hh=histories(h);
 await test('ANUI23 odniesienie tylko z zapisanej historii, bez pobrania i adopcji',async()=>{h.window.document.getElementById('pvAnnualReference').click();await until(()=>!h.window.document.getElementById('pvAnnualUseReference').disabled,'odniesienie');assert.ok(txt(h,'pvAnnualReferenceSummary').includes('0,492000 zł/kWh'));assert.ok(txt(h,'pvAnnualReferenceSummary').includes('2026-09-01'));assert.ok(txt(h,'pvAnnualReferenceSummary').includes('NIE średnia całego roku'));assert.strictEqual(h.window.document.getElementById('pv-annualDepositPlnKwh').value,'0.3');assert.ok(h.calls.every(c=>c.method==='GET'));noHA(h);assert.deepStrictEqual(histories(h),hh);isolated(h,hb);});
 await test('ANUI24 jawna adopcja ceny wymaga nowej zgody, nie annualizuje energii',async()=>{const before=h.calls.length;h.window.document.getElementById('pvAnnualUseReference').click();await until(()=>h.calls.slice(before).some(c=>c.method==='PUT'));assert.strictEqual(h.window.document.getElementById('pv-acceptScenario').checked,false);nearDOM(Number(h.window.document.getElementById('pv-annualDepositPlnKwh').value),.492);const sv=JSON.parse(h.kv[S.prefix+'settings']).settings;assert.strictEqual(sv.annualPriceOrigin.notAnnual,true);assert.strictEqual(sv.annualPriceOrigin.startDate,'2026-09-01');assert.strictEqual(sv.annualYieldAcKwhPerKwp,1000);await accept(h);await calc(h);assert.strictEqual(txt(h,'pvAnnualEnergy'),'3180,00 kWh');assert.strictEqual(txt(h,'pvAnnualBenefit'),'1564,56 zł');assert.ok(txt(h,'pvResults').includes('świadomie wybrane'));assert.deepStrictEqual(histories(h),hh);isolated(h,hb);});
 await test('ANUI25 pochodzenie i precyzja ceny przeżywają restart',async()=>{const g=await open(hf,h.kv);assert.ok(txt(g,'pvAnnualInfo').includes('2026-09-01'));await calc(g);assert.strictEqual(txt(g,'pvAnnualBenefit'),'1564,56 zł');noHA(g);g.window.close();});
 await test('ANUI26 ręczna zmiana ceny usuwa pochodzenie, nie historii',async()=>{await set(h,'pv-annualDepositPlnKwh','.31');assert.strictEqual(JSON.parse(h.kv[S.prefix+'settings']).settings.annualPriceOrigin,null);assert.ok(!txt(h,'pvAnnualInfo').includes('świadomie przepisano'));assert.deepStrictEqual(histories(h),hh);isolated(h,hb);});
 await test('ANUI27 niepełne ceny nie dają fałszywej średniej, ROI nadal działa',async()=>{const ff=af();delete ff.shared.rceHourly['2026-09-01_12'];const g=await open(ff),bb=baseline(g);g.window.document.getElementById('pvAnnualReference').click();await until(()=>/Odniesienie opcjonalne/.test(txt(g,'pvAnnualReferenceSummary')));assert.ok(txt(g,'pvAnnualReferenceSummary').includes('Brak pełnej wyceny'));assert.ok(g.window.document.getElementById('pvAnnualUseReference').disabled);await calc(g);assert.strictEqual(txt(g,'pvAnnualBenefit'),'954,00 zł');isolated(g,bb);g.window.close();});
 await test('ANUI28 braki PV/CSV blokują tylko odniesienie, nie rok',async()=>{const ff=af();ff.series[ff.settings.entities.pv]=ff.series[ff.settings.entities.pv].filter(r=>r.ts!==ff.span.start+12*F.HOUR);const g=await open(ff),bb=baseline(g);g.window.document.getElementById('pvAnnualReference').click();await until(()=>/Odniesienie opcjonalne/.test(txt(g,'pvAnnualReferenceSummary')));assert.ok(txt(g,'pvAnnualReferenceSummary').includes('NIE blokuje'));await calc(g);assert.strictEqual(txt(g,'pvAnnualBenefit'),'954,00 zł');noHA(g);isolated(g,bb);g.window.close();});
 await test('ANUI29 zerowy przypis jest prawidłowym odniesieniem0',async()=>{const ff=af();for(const k of Object.keys(ff.shared.rceHourly))ff.shared.rceHourly[k]=-50;const g=await open(ff);g.window.document.getElementById('pvAnnualReference').click();await until(()=>!g.window.document.getElementById('pvAnnualUseReference').disabled);assert.ok(txt(g,'pvAnnualReferenceSummary').includes('0,000000 zł/kWh'));g.window.document.getElementById('pvAnnualUseReference').click();await until(()=>g.window.document.getElementById('pv-annualDepositPlnKwh').value==='0');await accept(g);await calc(g);assert.strictEqual(txt(g,'pvAnnualPayback'),'brak zwrotu przy tych założeniach');g.window.close();});
 await test('ANUI30 roczny wynik nie czeka na most danych legacy',async()=>{const ff=af(),g=await open(ff,await noHistory(ff),{holdBridge:true,failSnapshot:true});await calc(g);assert.strictEqual(txt(g,'pvAnnualBenefit'),'954,00 zł');noHA(g);g.releaseBridge();g.window.close();});
 await test('ANUI31 spóźnione odniesienie nie nadpisuje nowych założeń',async()=>{const ff=af(),g=await open(ff,undefined,{holdBridge:true});g.window.document.getElementById('pvAnnualReference').click();await set(g,'pv-annualDepositPlnKwh','.37');g.releaseBridge();await new Promise(r=>setTimeout(r,20));assert.ok(g.window.document.getElementById('pvAnnualUseReference').disabled);assert.strictEqual(g.window.document.getElementById('pv-annualDepositPlnKwh').value,'0.37');await accept(g);await calc(g);assert.strictEqual(txt(g,'pvAnnualBenefit'),'1176,60 zł');g.window.close();});
 await test('ANUI32 zmiana trybu przy oczekiwaniu na odniesienie nie przepisuje ceny',async()=>{const ff=af(),g=await open(ff,undefined,{holdBridge:true});g.window.document.getElementById('pvAnnualReference').click();await set(g,'pv-calculationMode','export_only');g.releaseBridge();await new Promise(r=>setTimeout(r,20));assert.strictEqual(g.window.document.getElementById('pv-annualDepositPlnKwh').value,'0.3');assert.ok(g.window.document.getElementById('pvAnnualReferencePanel').hidden);g.window.close();});
 await test('ANUI33 reset nadal dwukrotny i wyłącznie PV',async()=>{const ff=af(),g=await open(ff),bb=baseline(g),old={...g.kv};g.window.document.getElementById('pvReset').click();assert.deepStrictEqual(g.kv,old);g.window.document.getElementById('pvReset').click();await until(()=>/Usunięto wyłącznie/.test(txt(g,'pvStatus')));assert.ok(!Object.keys(g.kv).some(k=>k.startsWith(S.prefix)));isolated(g,bb);g.window.close();});
 await test('ANUI35 zapisany autoRefresh z poprawnymi datami nigdy nie pobiera HA w trybie rocznym',async()=>{const ff=af({autoRefresh:true}),g=await open(ff),old=histories(g);g.window.document.querySelector('[data-tab="pv"]').click();await new Promise(r=>setTimeout(r,40));noHA(g);assert.ok(!g.window.__intervalCallbacks.some(x=>x.fn.toString().includes('fetchData')));assert.deepStrictEqual(histories(g),old);g.window.close();});
 await test('ANUI36 kolejność prostych pól, własne historyczne eta zachowane po edycji rocznej',async()=>{const ff=af();ff.settings.pvToAcEta=.9412345678;ff.settings.exportPvToAcEta=.9345678912;const g=await open(ff);const visible=Array.from(g.window.document.getElementById('pvParameters').children).filter(x=>!x.hidden).map(x=>x.querySelector('input').id);assert.deepStrictEqual(visible,['pv-addedKwp','pv-costPln','pv-annualYieldAcKwhPerKwp','pv-annualDepositPlnKwh']);await set(g,'pv-annualDepositPlnKwh','.35');await set(g,'pv-annualYieldAcKwhPerKwp','900');const sv=JSON.parse(g.kv[S.prefix+'settings']).settings;assert.strictEqual(sv.pvToAcEta,.9412345678);assert.strictEqual(sv.exportPvToAcEta,.9345678912);await set(g,'pv-calculationMode','export_only');const oldVisible=Array.from(g.window.document.getElementById('pvParameters').children).filter(x=>!x.hidden).map(x=>x.querySelector('input').id);assert.strictEqual(oldVisible[0],'pv-addedKwp');noHA(g);g.window.close();});
 await test('ANUI34 brak błędów DOM, absolutnych API i zapisów spozaPV',()=>{for(const g of instances){assert.strictEqual(g.errors.length,0,g.errors.join('\n'));assert.ok(g.calls.every(c=>c.path.startsWith('/ingress-test/')));assert.ok(g.calls.filter(c=>c.method!=='GET').every(c=>c.key&&c.key.startsWith(S.prefix)));}isolated(d,b);isolated(h,hb);});
 for(const g of instances)g.window.close();console.log(`\nPV roczny DOM: ${passed} przeszło, ${failed} nie przeszło`);process.exit(failed?1:0);
})().catch(e=>{for(const g of instances)g.window.close();console.error(e);process.exit(1);});
function nearDOM(a,b){assert.ok(Math.abs(a-b)<1e-9,`${a} != ${b}`);}
