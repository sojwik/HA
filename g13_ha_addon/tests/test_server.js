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
