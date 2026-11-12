'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path');
const { JSDOM, VirtualConsole, ResourceLoader } = require('../app/node_modules/jsdom');
const F = require('./pv-fixture');
const D = require('../app/public/pv-data');
const S = require('../app/public/pv-store');
const DIR = path.join(__dirname, '../app/public');
let passed = 0, failed = 0; const instances = [];
async function test(name, fn) { try { await fn(); console.log('  ✓ ' + name); passed++; } catch (e) { failed++; console.error('  ✗ ' + name + '\n' + e.stack); if(process.env.PV_MUTATION_FAST==='1')throw e; } }
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
          if (control.mode === 'empty') return reply({}, 200, F.csv({}, []));
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
const R=require('../app/public/pv-available');
function avf(p={}){const f=F.data(F.settings({calculationMode:R.mode,addedKwp:3,exportPvToAcEta:1,availableAnnualAcKwhPerKwp:1000,costPln:4000,gridSource:'auto',...p}));for(const x of f.series[f.settings.entities.pv])x.change=D.localKey(x.ts).endsWith('_12')?9.54:0;F.sumSeries(f.series);for(const[k,g]of Object.entries(f.shared.hourlyElicznik))if(k.endsWith('_12'))g.poborPoZbil=1;return f;}
const histories=d=>Object.fromEntries(Object.entries(d.kv).filter(([k])=>k.startsWith(S.prefix)&&k!==S.prefix+'settings'));
const noHA=d=>assert.ok(!d.calls.some(c=>c.path.endsWith('/api/pv/stats.csv')));
async function fetchDone(d){d.window.document.getElementById('pvFetch').click();await until(()=>!d.window.document.getElementById('pvCalculate').disabled,'fetch finished');}
(async()=>{
console.log('\n=== PV dostępne godziny: rzeczywisty DOM i izolacja 0.4.0 ===');
const f=avf(),d=await open(f),b=baseline(d),h=histories(d);
await test('AVUI01 widoczny nowy tryb040, stare zapisy bez automatycznej migracji',()=>{assert.ok(txt(d,'tab-pv').includes('0.4.0'));assert.strictEqual(d.window.document.getElementById('pv-calculationMode').value,R.mode);assert.ok(d.window.G13PvAvailable);assert.ok(d.calls.every(x=>x.method==='GET'));isolated(d,b);});
await test('AVUI02 ukryte 0.30/±30/użycie/bateria; widoczne daty i roczneAC',()=>{for(const id of ['pv-annualDepositPlnKwh','pv-annualPriceSpreadFraction','pv-depositUseFraction','pv-annualYieldAcKwhPerKwp','pv-capacityKwh','pv-chargeCurrentA','pv-entity-acCharge','pv-entity-soc','pv-allowDstAggregation','pv-autoRefresh']){const n=d.window.document.getElementById(id);assert.ok(n.disabled,id);assert.ok(n.parentElement.hidden||n.closest('[hidden]'),id);}for(const id of ['pv-startDate','pv-endDate','pv-availableAnnualAcKwhPerKwp','pv-exportPvToAcEta','pv-addedKwp'])assert.ok(!d.window.document.getElementById(id).disabled,id);assert.ok(txt(d,'pvAvailableInfo').includes('nie archiwum'));});
await test('AVUI03 priorytet zużycia:1.50zakupu+0.984depo, nie eksportcałości',async()=>{await calc(d);assert.strictEqual(txt(d,'pvAvailablePurchase'),'1,50 zł');assert.strictEqual(txt(d,'pvAvailableDeposit'),'0,98 zł');assert.strictEqual(txt(d,'pvAvailableBenefit'),'2,48 zł');assert.strictEqual(txt(d,'pvAvailableCoverage'),'24 / 24');noHA(d);assert.deepStrictEqual(histories(d),h);isolated(d,b);});
await test('AVUI04 roczny wynik2484zł i1.61roku bez drugiegoeta/365',()=>{assert.strictEqual(txt(d,'pvAvailableAnnualBenefit'),'2484,00 zł');assert.strictEqual(txt(d,'pvAvailablePayback'),'1,61 lat');assert.strictEqual(txt(d,'pvAvailableAnnualRoi'),'62,10%');for(const x of ['nie archiwum zmian taryfy','NIE muszą reprezentować','Nie użyto 0,30 zł','nie mnożymy roku','Depozyt ≠ gotówka'])assert.ok(txt(d,'pvResults').toLowerCase().includes(x.toLowerCase()),x);isolated(d,b);});
await test('AVUI05 zmiana cen ręcznego estymatora nie zmienia cenhistorycznych',async()=>{await set(d,'pv-annualDepositPlnKwh','99');await set(d,'pv-depositUseFraction','30');await accept(d);await calc(d);assert.strictEqual(txt(d,'pvAvailableAnnualBenefit'),'2484,00 zł');assert.strictEqual(JSON.parse(d.kv[S.prefix+'settings']).settings.depositUseFraction,.3);assert.ok(txt(d,'pvAvailableInfo').includes('nie mnożnik wypłaty 30%'));isolated(d,b);});
await test('AVUI06 zmiana założeń unieważnia zgodę i wynik',async()=>{await set(d,'pv-costPln','8000');assert.ok(d.window.document.getElementById('pvResults').hidden);assert.ok(!d.window.document.getElementById('pv-acceptScenario').checked);await calc(d);assert.ok(txt(d,'pvStatus').includes('Zaznacz'));await accept(d);await calc(d);assert.strictEqual(txt(d,'pvAvailablePayback'),'3,22 lat');isolated(d,b);});
await test('AVUI07 brak rocznego uzysku nie blokuje historycznejpodsumy',async()=>{await set(d,'pv-availableAnnualAcKwhPerKwp','');await accept(d);await calc(d);assert.strictEqual(txt(d,'pvAvailableBenefit'),'2,48 zł');assert.strictEqual(txt(d,'pvAvailableAnnualBenefit'),'nieznane');assert.strictEqual(txt(d,'pvAvailablePayback'),'podaj roczny uzysk AC');isolated(d,b);});
await test('AVUI08 zerowy koszt to nie natychmiastowy zwrot',async()=>{await set(d,'pv-availableAnnualAcKwhPerKwp','1000');await set(d,'pv-costPln','0');await accept(d);await calc(d);assert.strictEqual(txt(d,'pvAvailableAnnualBenefit'),'2484,00 zł');assert.strictEqual(txt(d,'pvAvailablePayback'),'podaj dodatni koszt');isolated(d,b);});
await test('AVUI09 zerowa korzyść nie jest Infinity ani dodatnim ROI',async()=>{await set(d,'pv-costPln','4000');await set(d,'pv-addedKwp','0');await accept(d);await calc(d);assert.strictEqual(txt(d,'pvAvailableAnnualBenefit'),'0,00 zł');assert.strictEqual(txt(d,'pvAvailablePayback'),'brak zwrotu przy tych założeniach');isolated(d,b);});
await test('AVUI10 krótszy cache w dłuższym zakresie liczy znanączęść bezfetch',async()=>{await set(d,'pv-addedKwp','3');await set(d,'pv-endDate','2026-09-03');await accept(d);await calc(d);assert.ok(txt(d,'pvDataStatus').includes('24/72'));assert.strictEqual(txt(d,'pvAvailableCoverage'),'24 / 72');assert.strictEqual(txt(d,'pvAvailableBenefit'),'2,48 zł');assert.strictEqual(txt(d,'pvAvailableAnnualBenefit'),'2484,00 zł');noHA(d);assert.deepStrictEqual(histories(d),h);isolated(d,b);});
await test('AVUI11 ustawienia/tryb/precyzja przeżywają ponowneotwarcie',async()=>{await set(d,'pv-availableAnnualAcKwhPerKwp','987.1234567');const g=await open(f,d.kv);assert.strictEqual(g.window.document.getElementById('pv-calculationMode').value,R.mode);assert.strictEqual(g.window.document.getElementById('pv-availableAnnualAcKwhPerKwp').value,'987.1234567');assert.strictEqual(g.window.document.getElementById('pv-depositUseFraction').value,'30');assert.deepStrictEqual(histories(g),h);g.window.close();isolated(d,b);});
await test('AVUI12 przełączanie czterech trybów zachowuje stareety/parametry',async()=>{const before=JSON.parse(d.kv[S.prefix+'settings']).settings;for(const mode of ['export_only','dynamic_battery','annual_estimate',R.mode]){await set(d,'pv-calculationMode',mode);assert.ok(!d.window.document.getElementById('pv-acceptScenario').checked);}const after=JSON.parse(d.kv[S.prefix+'settings']).settings;for(const k of ['exportPvToAcEta','pvToAcEta','batteryVoltageV','chargeCurrentA','annualDepositPlnKwh','depositUseFraction','availableAnnualAcKwhPerKwp'])assert.strictEqual(after[k],before[k],k);assert.deepStrictEqual(histories(d),h);isolated(d,b);});
await test('AVUI13 zapis039 pozostaje roczny, nie przełączonydo nowegomodelu',async()=>{const ff=avf({calculationMode:'annual_estimate'}),g=await open(ff);assert.strictEqual(g.window.document.getElementById('pv-calculationMode').value,'annual_estimate');assert.ok(g.window.document.getElementById('pvAvailableInfo').hidden);assert.ok(g.window.document.getElementById('pv-availableAnnualAcKwhPerKwp').parentElement.hidden);assert.ok(g.calls.every(c=>c.method==='GET'));g.window.close();});
await test('AVUI14 brak RCE zostawia oszczędnośćzakupu, rocznywyniknieznany',async()=>{const ff=avf();delete ff.shared.rceHourly['2026-09-01_12'];const g=await open(ff),bb=baseline(g);await calc(g);assert.strictEqual(txt(g,'pvAvailablePurchase'),'1,50 zł');assert.strictEqual(txt(g,'pvAvailableDeposit'),'0,00 zł');assert.strictEqual(txt(g,'pvAvailableAnnualBenefit'),'nieznane');assert.ok(txt(g,'pvDiagnostics').includes('Brak RCE'));noHA(g);isolated(g,bb);g.window.close();});
await test('AVUI15 brak zakupu nie kasujeznanego depozytu, brakrocznegofallbacku',async()=>{const ff=avf();ff.shared.zoneRates={};const kv=await seed(ff);const l=JSON.parse(kv['monthly-ledger']);l.zoneRates={T1:null,T2:null,T3:null};kv['monthly-ledger']=JSON.stringify(l);const g=await open(ff,kv),bb=baseline(g);await calc(g);assert.strictEqual(txt(g,'pvAvailablePurchase'),'0,00 zł');assert.strictEqual(txt(g,'pvAvailableDeposit'),'0,98 zł');assert.strictEqual(txt(g,'pvAvailableAnnualBenefit'),'nieznane');isolated(g,bb);g.window.close();});
await test('AVUI16 brak poboru nie zamienia całegoPVweksport',async()=>{const ff=avf();delete ff.shared.hourlyElicznik['2026-09-01_12'].hasImport;const g=await open(ff),bb=baseline(g);await calc(g);assert.strictEqual(txt(g,'pvAvailableDeposit'),'0,00 zł');assert.strictEqual(txt(g,'pvAvailableAnnualBenefit'),'nieznane');assert.ok(txt(g,'pvDiagnostics').includes('Brak potwierdzonego poboru'));isolated(g,bb);g.window.close();});
await test('AVUI17 lukaPV nie blokuje pozostałychdni i jestwdiagnozie',async()=>{const ff=avf({endDate:'2026-09-03'});ff.series[ff.settings.entities.pv]=ff.series[ff.settings.entities.pv].filter(x=>x.ts!==ff.span.start+12*F.HOUR);const g=await open(ff),bb=baseline(g);await calc(g);assert.strictEqual(txt(g,'pvAvailableBenefit'),'4,97 zł');assert.ok(txt(g,'pvDiagnostics').includes('godzina po luce'));assert.strictEqual(txt(g,'pvAvailableCoverage'),'70 / 72');isolated(g,bb);g.window.close();});
await test('AVUI18 jesiennyDST nie wymaga zgody i nie przypisuje wspólnejceny',async()=>{const ff=avf({startDate:'2026-10-25',endDate:'2026-10-25'}),g=await open(ff),bb=baseline(g);await calc(g);assert.strictEqual(txt(g,'pvAvailableBenefit'),'2,48 zł');assert.strictEqual(txt(g,'pvAvailableCoverage'),'23 / 25');assert.ok(txt(g,'pvDiagnostics').includes('Powtórzona godzina DST'));isolated(g,bb);g.window.close();});
await test('AVUI19 limit eksportu0 nie blokuje oszczędnościzakupu',async()=>{const ff=avf({exportAcKw:0}),g=await open(ff),bb=baseline(g);await calc(g);assert.strictEqual(txt(g,'pvAvailablePurchase'),'1,50 zł');assert.strictEqual(txt(g,'pvAvailableDeposit'),'0,00 zł');assert.strictEqual(txt(g,'pvAvailableAnnualBenefit'),'1500,00 zł');isolated(g,bb);g.window.close();});
await test('AVUI20 fetch częściowy ma OSOBNY cache, stary pełny/eksport/CSVzachowane',async()=>{const short=avf(),ff=avf({endDate:'2026-09-03'}),kv=await seed(short);await saveGrid(kv,D.parseGridCsvFiles([{name:'synthetic.csv',text:F.gridCsv(ff.shared.hourlyElicznik)}]));ff.series[ff.settings.entities.pv]=ff.series[ff.settings.entities.pv].filter(x=>x.ts!==ff.span.start+12*F.HOUR);const g=await open(ff,kv),bb=baseline(g),old=histories(g);await set(g,'pv-endDate','2026-09-03');await fetchDone(g);assert.ok(txt(g,'pvStatus').includes('Zapisano osobno dostępne'));assert.ok(g.kv[S.prefix+'available-active']);for(const[k,v]of Object.entries(old))assert.strictEqual(g.kv[k],v);assert.ok(txt(g,'pvDataStatus').includes('osobna historia dostępnych'));assert.ok(txt(g,'pvDataStatus').includes('70/72'));const calls=g.calls.filter(c=>c.path.endsWith('/api/pv/stats.csv'));assert.ok(calls.length>0);for(const c of calls){const ids=new URL(c.url,'https://g13.test/ingress-test/').searchParams.get('entities').split(',');assert.deepStrictEqual(ids.sort(),[ff.settings.entities.pv,ff.settings.entities.pvPower].sort());}await accept(g);await calc(g);assert.ok(!g.window.document.getElementById('pvResults').hidden);const next=await open(ff,g.kv);assert.ok(txt(next,'pvDataStatus').includes('70/72'));next.window.close();isolated(g,bb);g.window.close();});
await test('AVUI21 HTTP200 tylko moc nie nadpisuje żadnejhistorii',async()=>{const ff=avf(),g=await open(ff),bb=baseline(g),old=histories(g);g.control.mode='power-only';await fetchDone(g);assert.ok(txt(g,'pvStatus').includes('Brak choćby'));assert.deepStrictEqual(histories(g),old);isolated(g,bb);g.window.close();});
await test('AVUI22 brak jednego bufora możezostaćzapisanyjako częściowy, niepełny',async()=>{const ff=avf(),g=await open(ff);g.control.mode='missing-buffer';await fetchDone(g);assert.ok(txt(g,'pvStatus').includes('23/24'));assert.ok(g.kv[S.prefix+'available-active']);g.window.close();});
await test('AVUI23 502 nie aktywuje zbioru i niekasuje starego',async()=>{const ff=avf(),g=await open(ff),bb=baseline(g),old=histories(g);g.control.mode='http-error';await fetchDone(g);assert.ok(txt(g,'pvStatus').includes('502'));assert.deepStrictEqual(histories(g),old);isolated(g,bb);g.window.close();});
await test('AVUI24 błąd nowegomanifestu nie rusza poprzednichdanych',async()=>{const ff=avf(),g=await open(ff),bb=baseline(g),old=histories(g);g.control.failKey=S.prefix+'available-active';await fetchDone(g);assert.ok(txt(g,'pvStatus').includes('503'));assert.deepStrictEqual(histories(g),old);isolated(g,bb);g.window.close();});
await test('AVUI25 zapisany autoRefreshnie uruchamia HA nowegotrybu',async()=>{const ff=avf({autoRefresh:true}),g=await open(ff);g.window.document.querySelector('[data-tab="pv"]').click();await new Promise(r=>setTimeout(r,30));noHA(g);assert.ok(!g.window.__intervalCallbacks.some(x=>x.fn.toString().includes('fetchData')));assert.strictEqual(JSON.parse(g.kv[S.prefix+'settings']).settings.autoRefresh,true);g.window.close();});
await test('AVUI26 stare wymaganie pełnegoPVnie zostałoosłabione',async()=>{const ff=avf({calculationMode:'export_only'});ff.series[ff.settings.entities.pv].shift();const g=await open(ff),old=histories(g);await fetchDone(g);assert.ok(txt(g,'pvStatus').includes('Nie aktywowano nowego profilu'));assert.deepStrictEqual(histories(g),old);g.window.close();});
await test('AVUI27 uszkodzony nowycache nie blokujestarychtrybów',async()=>{const ff=avf(),kv=await seed(ff);kv[S.prefix+'available-active']='not-json';const g=await open(ff,kv);assert.ok(txt(g,'pvDataStatus').includes('nie został odczytany'));assert.ok(g.window.document.getElementById('pvFetch').disabled);await calc(g);assert.strictEqual(txt(g,'pvAvailableBenefit'),'2,48 zł');await set(g,'pv-calculationMode','export_only');assert.ok(!g.window.document.getElementById('pvCalculate').disabled);assert.strictEqual(g.kv[S.prefix+'available-active'],'not-json');g.window.close();});
await test('AVUI28 brak całejhistorii daje informację, nie fikcyjneROI',async()=>{const ff=avf(),kv=await seed(ff);for(const k of Object.keys(kv))if(k.startsWith(S.prefix)&&k!==S.prefix+'settings')delete kv[k];const g=await open(ff,kv);await calc(g);assert.strictEqual(txt(g,'pvAvailableBenefit'),'0,00 zł');assert.strictEqual(txt(g,'pvAvailableAnnualBenefit'),'nieznane');assert.strictEqual(txt(g,'pvAvailableCoverage'),'0 / 24');noHA(g);g.window.close();});
await test('AVUI29 spóźniony odczyt nie publikuje wyniku starychzałożeń',async()=>{const ff=avf(),g=await open(ff,undefined,{holdBridge:true});g.window.document.getElementById('pvCalculate').click();await set(g,'pv-addedKwp','6');g.releaseBridge();await new Promise(r=>setTimeout(r,30));assert.ok(g.window.document.getElementById('pvResults').hidden);await accept(g);await calc(g);assert.ok(!g.window.document.getElementById('pvResults').hidden);g.window.close();});
await test('AVUI30 opóźniony odczyt po zmianietrybu nie nadpisuje rocznegoUI',async()=>{const ff=avf(),g=await open(ff,undefined,{holdBridge:true});g.window.document.getElementById('pvCalculate').click();await set(g,'pv-calculationMode','annual_estimate');g.releaseBridge();await new Promise(r=>setTimeout(r,30));assert.ok(g.window.document.getElementById('pvResults').hidden);assert.ok(g.window.document.getElementById('pvAvailableInfo').hidden);g.window.close();});
await test('AVUI31 brak zapisu ustawień jawny, nie twierdziże zapisano',async()=>{const ff=avf(),g=await open(ff),old=g.kv[S.prefix+'settings'];g.control.failPut=true;await set(g,'pv-availableAnnualAcKwhPerKwp','900');assert.ok(txt(g,'pvSaveStatus').includes('tylko w pamięci'));assert.strictEqual(g.kv[S.prefix+'settings'],old);await accept(g);await calc(g);assert.strictEqual(txt(g,'pvAvailableAnnualBenefit'),'2235,60 zł');g.window.close();});
await test('AVUI32 reset nadal dwukrotny, także nowycache, tylkoPV',async()=>{const ff=avf(),g=await open(ff),bb=baseline(g);await fetchDone(g);assert.ok(g.kv[S.prefix+'available-active']);const old={...g.kv};g.window.document.getElementById('pvReset').click();assert.deepStrictEqual(g.kv,old);g.window.document.getElementById('pvReset').click();await until(()=>txt(g,'pvStatus').includes('Usunięto wyłącznie'));assert.ok(!Object.keys(g.kv).some(k=>k.startsWith(S.prefix)));isolated(g,bb);g.window.close();});
await test('AVUI34 cały pusty pierwszy miesiąc nie blokuje dostępnego następnego',async()=>{const ff=avf({startDate:'2026-10-01',endDate:'2026-10-01'});for(const id of Object.keys(ff.series))ff.series[id]=ff.series[id].filter(x=>x.ts>=ff.span.start);const g=await open(ff),bb=baseline(g),old=histories(g);await set(g,'pv-startDate','2026-09-01');await fetchDone(g);assert.ok(txt(g,'pvStatus').includes('Zapisano osobno dostępne'),txt(g,'pvStatus'));assert.ok(txt(g,'pvStatus').includes('23/744'));assert.ok(g.kv[S.prefix+'available-active']);for(const[k,v]of Object.entries(old))assert.strictEqual(g.kv[k],v);assert.strictEqual(g.calls.filter(c=>c.path.endsWith('/api/pv/stats.csv')).length,2);await accept(g);await calc(g);assert.strictEqual(txt(g,'pvAvailableCoverage'),'23 / 744');assert.strictEqual(txt(g,'pvAvailableBenefit'),'2,48 zł');assert.ok(txt(g,'pvDiagnostics').includes('Brak przyrostu PV'));isolated(g,bb);g.window.close();});
await test('AVUI35 cały pusty zakres nie nadpisuje wcześniejszych zbiorów',async()=>{const ff=avf(),g=await open(ff),bb=baseline(g),old=histories(g);g.control.mode='empty';await fetchDone(g);assert.ok(txt(g,'pvStatus').includes('Brak choćby'),txt(g,'pvStatus'));assert.deepStrictEqual(histories(g),old);isolated(g,bb);g.window.close();});
await test('AVUI36 HTML200 nie jest prawidłową pustą częścią miesiąca',async()=>{const ff=avf(),g=await open(ff),bb=baseline(g),old=histories(g);g.control.mode='spa';await fetchDone(g);assert.ok(txt(g,'pvStatus').includes('To nie jest godzinowy eksport'));assert.deepStrictEqual(histories(g),old);isolated(g,bb);g.window.close();});
await test('AVUI33 brakbłędówDOM, ingress względny, braklegacywrite',()=>{for(const g of instances){assert.strictEqual(g.errors.length,0,g.errors.join('\n'));assert.ok(g.calls.every(c=>c.path.startsWith('/ingress-test/')));assert.ok(g.calls.filter(c=>c.method!=='GET').every(c=>c.key&&c.key.startsWith(S.prefix)));}isolated(d,b);});
for(const g of instances)g.window.close();console.log(`\nPV dostępne DOM: ${passed} przeszło, ${failed} nie przeszło`);process.exit(failed?1:0);
})().catch(e=>{for(const g of instances)g.window.close();console.error(e);process.exit(1);});
