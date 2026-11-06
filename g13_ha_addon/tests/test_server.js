'use strict';
/* Test integracyjny serwera: uruchamia prawdziwy proces i strzela po HTTP. */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const PORT = 8199;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'g13srv-'));
let pass = 0, fail = 0, proc;

function t(name, cond, detail) {
  if (cond) { console.log('  ✓ ' + name); pass++; }
  else { console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); fail++; }
}

async function req(method, p, body, headers) {
  const r = await fetch(BASE + p, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  return { status: r.status, headers: r.headers, text, json };
}

function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function attempt() {
      fetch(BASE + '/api/health')
        .then(() => resolve())
        .catch(() => {
          if (Date.now() > deadline) return reject(new Error('serwer nie wystartował'));
          setTimeout(attempt, 150);
        });
    })();
  });
}

(async () => {
  proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '../app'),
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: TMP }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  proc.stdout.on('data', d => { serverLog += d; });
  proc.stderr.on('data', d => { serverLog += d; });
  let exitCode = null;
  proc.on('exit', c => { exitCode = c; });

  try {
    await waitForServer(15000);
  } catch (e) {
    console.error('NIE UDAŁO SIĘ wystartować serwera:\n' + serverLog);
    process.exit(1);
  }

  console.log('\n=== P0-3: nieprawidłowe daty → 400, proces żyje ===');
  let r = await req('GET', '/api/growatt/ha-stats.csv?start=nie-jest-data');
  t('S1 start=śmieć → 400', r.status === 400, 'status ' + r.status);
  t('S2 komunikat nazywa parametr', r.json && /start/.test(r.json.error || ''), JSON.stringify(r.json));
  t('S3 proces NIE padł', exitCode === null, 'exit code ' + exitCode);

  r = await req('GET', '/api/growatt/ha-stats.csv?end=xyz');
  t('S4 end=śmieć → 400', r.status === 400);

  r = await req('GET', '/api/growatt/ha-stats.csv?start=2026-07-31&end=2026-07-01');
  t('S5 start po end → 400', r.status === 400);

  r = await req('GET', '/api/growatt/ha-stats.csv?start=1900-01-01&end=2200-01-01');
  t('S6 zakres 300 lat → 400', r.status === 400, 'status ' + r.status);

  r = await req('GET', '/api/health');
  t('S7 serwer nadal odpowiada po błędnych żądaniach', r.status === 200 || r.status === 503);

  console.log('\n=== T19: nagłówki bezpieczeństwa ===');
  r = await req('GET', '/');
  t('S8 X-Content-Type-Options', r.headers.get('x-content-type-options') === 'nosniff');
  t('S9 CSP obecny', !!r.headers.get('content-security-policy'));
  t('S10 CSP blokuje zewnętrzne skrypty',
    /script-src 'self'/.test(r.headers.get('content-security-policy') || '')
    && !/cdnjs/.test(r.headers.get('content-security-policy') || ''));
  t('S11 Referrer-Policy', r.headers.get('referrer-policy') === 'no-referrer');
  t('S12 x-powered-by ukryty', r.headers.get('x-powered-by') === null);

  console.log('\n=== T20: limit ciała ===');
  const big = 'x'.repeat(3 * 1024 * 1024);
  r = await req('PUT', '/api/kv/duzy', { value: big });
  t('S13 3 MB → 413', r.status === 413, 'status ' + r.status);
  t('S14 proces żyje po dużym ciele', exitCode === null);

  console.log('\n=== T23: stare kopie nie są serwowane ===');
  r = await req('GET', '/index2.html');
  t('S15 index2.html → 404', r.status === 404, 'status ' + r.status);

  console.log('\n=== Serwowany plik to ten poprawiony ===');
  r = await req('GET', '/');
  t('S16 index.html zawiera walidator', r.text.includes('validate.js'));
  t('S17 index.html NIE zawiera CDN', !r.text.includes('cdnjs.cloudflare.com'));
  t('S18 index.html ma panel diagnostyczny', r.text.includes('haDiagnostics'));

  console.log('\n=== Zasoby lokalne ===');
  r = await req('GET', '/validate.js');
  t('S19 validate.js dostępny', r.status === 200);
  r = await req('GET', '/vendor/xlsx.full.min.js');
  t('S20 SheetJS lokalny dostępny', r.status === 200 && r.text.length > 500000);

  console.log('\n=== KV: podstawy i zdrowie ===');
  r = await req('PUT', '/api/kv/test', { value: '{"a":1}' });
  t('S21 PUT string działa', r.status === 200);
  r = await req('PUT', '/api/kv/test', { value: 123 });
  t('S22 PUT nie-string → 400', r.status === 400);
  r = await req('GET', '/api/kv/test');
  t('S23 GET zwraca wartość', r.json && r.json.value === '{"a":1}');
  r = await req('GET', '/api/health');
  t('S24 health.ok = true', r.json && r.json.ok === true);

  console.log('\n=== Konfiguracja zawiera progi ===');
  r = await req('GET', '/api/config');
  t('S25 limitsKw w konfiguracji', r.json && r.json.limitsKw && r.json.limitsKw.poborHa === 16.0);
  t('S26 pojemność baterii = nominalna 14,34 kWh', r.json && r.json.batteryCapacityKwh === 14.34);
  // Regresja: serwer miał własną wartość domyślną, niezależną od validate.js.
  // Przy zmianie pojemności trzeba by pamiętać o dwóch miejscach.
  // Regresja: przez chwilę lib/validate.js miał byMonth, a serwowana kopia
  // public/validate.js nie — frontend dostawał pusty podział odrzuceń.
  // Test end-to-end to złapał, ale tu wykrywamy to u źródła.
  t('S31 serwowana kopia validate.js identyczna z lib/',
    require('fs').readFileSync(require('path').join(__dirname, '../app/lib/validate.js'), 'utf8')
    === require('fs').readFileSync(require('path').join(__dirname, '../app/public/validate.js'), 'utf8'),
    'pliki się różnią — uruchom: cp app/lib/validate.js app/public/validate.js');

  const Vcheck = require('../app/lib/validate');
  t('S30 serwer i walidator zgadzają się co do pojemności',
    r.json && r.json.batteryCapacityKwh === Vcheck.resolveConfig().batteryCapacityKwh,
    'serwer: ' + (r.json && r.json.batteryCapacityKwh) + ', walidator: ' + Vcheck.resolveConfig().batteryCapacityKwh);

  console.log('\n=== F38: aktualizacja dodatku musi dotrzeć do przeglądarki ===');
  // Regresja z produkcji: no-cache był ustawiany TYLKO dla .html, więc po
  // aktualizacji przeglądarka uruchamiała nowy index.html ze starym
  // validate.js. Log pokazywał pojemność 16.35 kWh przy 14.34 w kodzie,
  // a jednocześnie nowe ostrzeżenie F37 z index.html działało.
  const idx = await req('GET', '/');
  t('S32 index.html wskazuje validate.js z wersją (?v=…)',
    idx.status === 200 && /<script src="validate\.js\?v=\d+"/.test(idx.text),
    'status ' + idx.status + ', fragment: ' + (idx.text.match(/<script src="validate[^>]*>/) || ['brak'])[0]);
  const vjs = await req('GET', '/validate.js');
  t('S33 validate.js serwowany z Cache-Control: no-cache',
    vjs.status === 200 && /no-cache/.test(vjs.headers.get('cache-control') || ''),
    'cache-control: ' + vjs.headers.get('cache-control'));
  const vend = await req('GET', '/vendor/xlsx.full.min.js');
  t('S34 vendor/*.js też rewalidowany',
    vend.status === 200 && /no-cache/.test(vend.headers.get('cache-control') || ''),
    'cache-control: ' + vend.headers.get('cache-control'));
  // Podmiana treści nie może uciąć pliku — index jest teraz czytany i wysyłany
  // ręcznie, więc sprawdzamy, że ogon dokumentu dotarł w całości.
  t('S35 serwowany index.html kompletny (nie ucięty)',
    idx.text.includes('setupGrowattAutoRefresh') && /<\/html>\s*$/.test(idx.text),
    'długość ' + idx.text.length + ', koniec: ' + JSON.stringify(idx.text.slice(-40)));

  console.log('\n=== /api/ha/stats.csv: walidacja PRZED połączeniem z HA ===');
  // Endpoint diagnostyczny (BMS). W tym teście nie ma SUPERVISOR_TOKEN, więc
  // poprawne żądanie musi dostać 502 z HA, a NIE 500/wywrócenie procesu.
  // Wszystko, co da się odrzucić lokalnie, musi być odrzucone jako 400.
  const noEnt = await req('GET', '/api/ha/stats.csv');
  t('S36 brak "entities" → 400 z instrukcją, nie zgadywanie',
    noEnt.status === 400 && /entities/.test(noEnt.text), 'status ' + noEnt.status + ': ' + noEnt.text.slice(0, 120));
  const badEnt = await req('GET', '/api/ha/stats.csv?entities=sensor ok;nazwa');
  t('S37 nieprawidłowe entity_id → 400', badEnt.status === 400, 'status ' + badEnt.status);
  const badTy = await req('GET', '/api/ha/stats.csv?entities=sensor.bms_current&types=median');
  t('S38 niedozwolony typ statystyki → 400 z listą dozwolonych',
    badTy.status === 400 && /mean/.test(badTy.text), 'status ' + badTy.status + ': ' + badTy.text.slice(0, 120));
  const many = Array.from({ length: 41 }, (_, i) => 'sensor.x' + i).join(',');
  const tooMany = await req('GET', '/api/ha/stats.csv?entities=' + many);
  t('S39 powyżej 40 encji → 400', tooMany.status === 400, 'status ' + tooMany.status);
  const badRange = await req('GET', '/api/ha/stats.csv?entities=sensor.bms_current&start=2026-10-01&end=2026-09-01');
  t('S40 start >= end → 400', badRange.status === 400, 'status ' + badRange.status);
  const badDate = await req('GET', '/api/ha/stats.csv?entities=sensor.bms_current&start=smiec');
  t('S41 śmieciowa data → 400, proces żyje', badDate.status === 400, 'status ' + badDate.status);
  const alive = await req('GET', '/api/health');
  t('S42 proces przeżył całą serię błędnych żądań', alive.status === 200, 'status ' + alive.status);

  console.log('\n=== CSP musi dopuszczać hosta, którego używa frontend ===');
  // Regresja: CSP miało api.pse.pl, a frontend api.raporty.pse.pl. Przeglądarka
  // blokowała natychmiast, więc wszystkie 31 dni RCE padały w tej samej sekundzie.
  const frontHtml = fs.readFileSync(path.join(__dirname, '../app/public/index.html'), 'utf8');
  const apiMatch = frontHtml.match(/PSE_API_BASE\s*=\s*['"](https?:\/\/[^/'"]+)/);
  t('S28 frontend ma jawnie zadeklarowany host API PSE', !!apiMatch);
  if (apiMatch) {
    const host = apiMatch[1];
    const cspHeader = (await req('GET', '/')).headers.get('content-security-policy') || '';
    const connectSrc = (cspHeader.match(/connect-src[^;]*/) || [''])[0];
    t('S29 CSP connect-src zawiera host API używany przez frontend',
      connectSrc.includes(host),
      'host: ' + host + '\nconnect-src: ' + connectSrc);
  }


  console.log('\n=== BMS: konfiguracja i scalanie źródeł (S43–S52) ===');
  r = await req('GET', '/api/config');
  t('S43 /api/config wystawia pola BMS',
    r.json && 'bmsChargeEntity' in r.json && 'bmsDischargeEntity' in r.json, JSON.stringify(r.json));
  t('S44 domyślnie BMS wyłączony (puste, nie undefined)',
    r.json.bmsChargeEntity === '' && r.json.bmsDischargeEntity === '', JSON.stringify(r.json));
  t('S45 /api/config wystawia próg tolerancji', r.json.bmsTolerancePct === 10, String(r.json.bmsTolerancePct));
  t('S53 /api/config wystawia sprawność DC osobno od AC',
    r.json.batteryEtaDc === 0.94 && r.json.batteryEta === 0.92,
    'DC=' + r.json.batteryEtaDc + ' AC=' + r.json.batteryEta);

  // Drugi i trzeci proces: PRAWDZIWY server.js, tylko ha-ws podstawiony, żeby
  // nie potrzebować Home Assistant. Testujemy scalanie, walidację opcji i
  // odporność na awarię BMS — nie sam transport WS (ten mają testy H3–H6).
  const APP_DIR = path.join(__dirname, '../app');
  const HA_WS_PATH = path.join(APP_DIR, 'lib/ha-ws.js');
  const stubPath = path.join(TMP, 'stub-ha-ws.js');
  const failFlag = path.join(TMP, 'bms-fail');
  fs.writeFileSync(stubPath, [
    "'use strict';",
    'const fs = require("fs");',
    'const HA = ' + JSON.stringify(HA_WS_PATH) + ';',
    'const FLAG = ' + JSON.stringify(failFlag) + ';',
    'const real = require(HA);',
    'const fake = {',
    '  asValidDate: real.asValidDate,',
    '  ALLOWED_STAT_TYPES: real.ALLOWED_STAT_TYPES,',
    '  fetchStatistics(ids, start){',
    '    if (fs.existsSync(FLAG) && ids.some(id => id.indexOf("sensor.bms_") === 0)) {',
    '      return Promise.reject(new Error("BMS niedostepny (test)"));',
    '    }',
    '    const out = {}; const t0 = new Date(start).getTime();',
    '    ids.forEach(id => { out[id] = [0,1,2].map(i => ({ start: t0 + i*3600000, sum: 10+i, change: 1 })); });',
    '    return Promise.resolve(out);',
    '  },',
    '};',
    'require.cache[HA] = { id: HA, filename: HA, loaded: true, children: [], exports: fake };',
  ].join('\n'));

  const extraProcs = [];
  async function spawnBms(optsObj, port) {
    const optFile = path.join(TMP, 'options-' + port + '.json');
    const dataDir = path.join(TMP, 'data-' + port);
    fs.writeFileSync(optFile, JSON.stringify(optsObj));
    fs.mkdirSync(dataDir, { recursive: true });
    const p = spawn(process.execPath, ['server.js'], {
      cwd: APP_DIR,
      env: Object.assign({}, process.env, {
        PORT: String(port), DATA_DIR: dataDir, OPTIONS_FILE: optFile,
        NODE_OPTIONS: '--require ' + stubPath,
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { out += d; });
    extraProcs.push(p);
    const deadline = Date.now() + 15000;
    for (;;) {
      try { const rr = await fetch('http://127.0.0.1:' + port + '/api/health'); if (rr.status) break; } catch (e) {}
      if (Date.now() > deadline) throw new Error('serwer BMS nie wystartował:\n' + out);
      await new Promise(res => setTimeout(res, 150));
    }
    return { port, log: () => out, proc: p };
  }

  const s1 = await spawnBms({
    bms_charge_entity: 'sensor.bms_ch_total',
    bms_discharge_entity: 'sensor.bms_dis_total',
  }, PORT + 1);
  const base1 = 'http://127.0.0.1:' + (PORT + 1);
  const c1 = await (await fetch(base1 + '/api/config')).json();
  t('S46 skonfigurowane encje BMS docierają do frontendu',
    c1.bmsChargeEntity === 'sensor.bms_ch_total' && c1.bmsDischargeEntity === 'sensor.bms_dis_total',
    JSON.stringify(c1));

  const csv1 = await (await fetch(base1 + '/api/growatt/ha-stats.csv?start=2026-10-01&end=2026-10-02')).text();
  t('S47 jeden CSV zawiera BMS obok Growatt',
    /sensor\.bms_ch_total/.test(csv1) && /sensor\.bms_dis_total/.test(csv1) && /sensor\.growatt_/.test(csv1),
    csv1.slice(0, 240));
  t('S48 dokładnie jeden nagłówek (jeden plik, jeden parser)',
    csv1.split('\n').filter(l => l.indexOf('statistic_id,') === 0).length === 1,
    csv1.split('\n').slice(0, 2).join(' | '));

  fs.writeFileSync(failFlag, '1');
  const respFail = await fetch(base1 + '/api/growatt/ha-stats.csv?start=2026-10-01&end=2026-10-02');
  const csv2 = await respFail.text();
  t('S49 awaria BMS NIE zabija danych Growatt',
    respFail.status === 200 && /sensor\.growatt_/.test(csv2) && !/sensor\.bms_/.test(csv2),
    'status ' + respFail.status + ': ' + csv2.slice(0, 200));
  t('S50 awaria BMS jest zalogowana, nie cicha',
    /Nie pobrałem statystyk BMS/.test(s1.log()), s1.log().slice(-400));
  fs.rmSync(failFlag, { force: true });

  const s2 = await spawnBms({
    bms_charge_entity: 'sensor.growatt_battery_battery_charge_total',   // kolizja
    bms_discharge_entity: 'Zly ID!',                                    // śmieć
  }, PORT + 2);
  const c2 = await (await fetch('http://127.0.0.1:' + (PORT + 2) + '/api/config')).json();
  t('S51 kolizja z growatt_entities odrzucona (inaczej BMS nigdy by nie zadziałał)',
    c2.bmsChargeEntity === '', JSON.stringify(c2));
  t('S52 nieprawidłowe entity_id odrzucone',
    c2.bmsDischargeEntity === '', JSON.stringify(c2));
  extraProcs.forEach(p => p.kill('SIGKILL'));

  console.log('\n=== Graceful shutdown (SIGTERM) ===');
  if (process.platform === 'win32') {
    // Windows nie dostarcza SIGTERM do handlerów procesu — Node zabija proces
    // natychmiast, więc kod wyjścia i tak nie byłby 0. Test nie ma tu sensu.
    // Docelowe środowisko dodatku to Linux (kontener), więc pomijamy świadomie,
    // ale jawnie, żeby nie udawać, że graceful shutdown został zweryfikowany.
    console.log('##G13-SKIP## Graceful shutdown SIGTERM (S27) — Windows nie dostarcza sygnału');
    console.log('  POMINIĘTO na Windows. Obsługa SIGTERM jest zweryfikowana tylko na Linuksie.');
    console.log('  Dodatek działa w kontenerze linuksowym, więc tam test ma zastosowanie.');
    proc.kill();
    await new Promise(res => { const to = setTimeout(res, 3000); proc.on('exit', () => { clearTimeout(to); res(); }); });
  } else {
    proc.kill('SIGTERM');
    const closed = await new Promise(res => {
      const to = setTimeout(() => res(false), 10000);
      proc.on('exit', c => { clearTimeout(to); res(c === 0); });
    });
    t('S27 SIGTERM → wyjście kodem 0', closed, 'log:\n' + serverLog.slice(-400));
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${pass} przeszło, ${fail} nie przeszło`);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('BŁĄD TESTU:', e);
  if (proc) proc.kill('SIGKILL');
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
});
