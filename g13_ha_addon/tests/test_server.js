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
  t('S26 pojemność baterii', r.json && r.json.batteryCapacityKwh === 16.35);

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
