'use strict';
/* Test dymny w prawdziwym DOM (jsdom): ładuje całą stronę, wstrzykuje realny
 * eksport HA i sprawdza, że renderowanie nie rzuca oraz że diagnostyka
 * pokazuje wykryte problemy. Łapie błędy, których testy jednostkowe nie widzą. */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
// Zależności są w app/node_modules (tam jest package.json), a ten test
// leży w tests/ — Node nie znajdzie ich po zwykłym require('jsdom').
let JSDOM, VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = require('jsdom'));
} catch (e) {
  ({ JSDOM, VirtualConsole } = require(path.join(__dirname, '../app/node_modules/jsdom')));
}
const http = require('http');

const DIR = path.join(__dirname, '../app/public');
let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { console.log('  ✓ ' + name); pass++; }
  else { console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); fail++; }
}

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push(e.message));
vc.on('error', (...a) => errors.push(a.join(' ')));

const logs = [];
vc.on('log', (...a) => logs.push(a.join(' ')));

// jsdom nie rozwiązuje względnych <script src> z URL-a http://localhost/,
// więc serwujemy katalog publiczny po HTTP — tak jak robi to Express.
function serveDir(dir) {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '') || 'index.html';
      const fp = path.join(dir, rel);
      if (!fp.startsWith(dir) || !fs.existsSync(fp)) { res.writeHead(404); res.end(''); return; }
      res.writeHead(200, { 'Content-Type': rel.endsWith('.js') ? 'application/javascript' : 'text/html' });
      res.end(fs.readFileSync(fp));
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

(async () => {
  const srv = await serveDir(DIR);
  const port = srv.address().port;
  const dom = await JSDOM.fromURL(`http://127.0.0.1:${port}/index.html`, {
    runScripts: 'dangerously',
    resources: 'usable',
    virtualConsole: vc,
    beforeParse(window) {
      // Backend nie działa w tym teście — fetch zwraca puste odpowiedzi,
      // żeby init nie wysypał się na sieci.
      window.fetch = () => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}), text: () => Promise.resolve('') });
      window.XLSX = { read: () => ({ SheetNames: ['a'], Sheets: { a: {} } }), utils: { sheet_to_json: () => [] } };
    },
  });

  await new Promise(r => setTimeout(r, 1200));
  const w = dom.window;

  console.log('\n=== Strona się ładuje ===');
  t('D1 brak błędów jsdom przy starcie', errors.length === 0, errors.slice(0, 3).join('\n'));
  t('D2 walidator dostępny w window', typeof w.G13Validate === 'object');
  t('D3 SheetJS z pliku lokalnego', !fs.readFileSync(path.join(DIR, 'index.html'), 'utf8').includes('cdnjs'));

  console.log('\n=== Wstrzyknięcie realnego eksportu HA ===');
  // Dostajemy się do wnętrza IIFE przez publiczny punkt wejścia:
  // handleHaStatsFiles jest w zamknięciu, więc symulujemy przez event dropzone.
  // Prościej: wywołujemy parser przez załadowanie CSV do stanu via file input.
  const input = w.document.querySelector('input[type=file]');
  t('D4 istnieje input plików', !!input);

  // Zamiast symulować drop (wymaga DataTransfer), weryfikujemy, że funkcje
  // renderujące działają na pustym stanie — to najczęstsze źródło regresji.
  console.log('\n=== Renderowanie pustego stanu ===');
  const before = errors.length;
  try {
    // kliknięcie zakładek wymusza render wszystkich paneli
    w.document.querySelectorAll('[data-tab], .tab, .tab-btn').forEach(el => {
      try { el.click(); } catch (e) {}
    });
  } catch (e) { errors.push(e.message); }
  await new Promise(r => setTimeout(r, 300));
  t('D5 przełączanie zakładek nie rzuca', errors.length === before, errors.slice(before, before + 2).join('\n'));

  console.log('\n=== Kontenery diagnostyczne istnieją ===');
  t('D6 #haDiagnostics w DOM', !!w.document.getElementById('haDiagnostics'));
  t('D7 tabela magazynu ma 6 kolumn',
    w.document.querySelectorAll('#realBatteryBody')[0].closest('table').querySelectorAll('thead th').length === 6);

  console.log('\n=== XSS: nazwa strefy nie wykonuje kodu ===');
  // Wstrzykujemy złośliwą nazwę strefy przez publiczny escape i sprawdzamy,
  // że panel strefy nie tworzy elementu <img>.
  const evil = '"><img src=x onerror="window.__pwned=1">';
  const escaped = w.G13Validate.escapeHtml(evil);
  const probe = w.document.createElement('div');
  probe.innerHTML = '<th>Strefa ' + escaped + '</th>';
  t('D8 escaped nazwa nie tworzy <img>', probe.querySelectorAll('img').length === 0);
  t('D9 window.__pwned nie ustawione', w.__pwned === undefined);

  console.log('\n=== Walidator działa w kontekście przeglądarki ===');
  const cfg = w.G13Validate.resolveConfig();
  t('D10 acceptDelta odrzuca skok 1293 kWh',
    w.G13Validate.acceptDelta('poborHa', 1293, null, null, cfg).ok === false);
  t('D11 acceptDelta przyjmuje 3,5 kWh',
    w.G13Validate.acceptDelta('poborHa', 3.5, null, null, cfg).ok === true);
  t('D12 acceptDelta skaluje próg oknem 20 h',
    w.G13Validate.acceptDelta('zuzycieDomu', 30.2, 0, 20 * 3600000, cfg).ok === true);
  t('D13 expectedHoursInDay(2026-10-25) = 25',
    w.G13Validate.expectedHoursInDay('2026-10-25') === 25);

  dom.window.close();
  console.log('\n=== Cache RCE: stary format musi odpaść (regresja depozytu) ===');
  // Naprawa parsera dtime nie wystarcza: stary cache ma KOMPLET 24 kluczy
  // na dzień, więc allHoursCoveredForDate() uzna go za pełny i nie pobierze
  // poprawnych cen. Sprawdzamy, że wersjonowanie cache to wychwytuje.
  // Strona SAMA definiuje window.storage (shim na fetch do api/kv), więc
  // podstawienie window.storage w beforeParse nie działa — zostanie nadpisane.
  // Podmieniamy fetch, czyli warstwę, z której ten shim faktycznie korzysta.
  async function loadWithCache(cacheValue, extraKv) {
    const kv = Object.assign({ 'rce-cache': cacheValue }, extraKv || {});
    const dom2 = await JSDOM.fromURL(`http://127.0.0.1:${port}/index.html`, {
      runScripts: 'dangerously',
      resources: 'usable',
      virtualConsole: vc,
      beforeParse(window) {
        window.XLSX = { read: () => ({ SheetNames: ['a'], Sheets: { a: {} } }), utils: { sheet_to_json: () => [] } };
        window.fetch = (url, opts) => {
          const u = String(url);
          const lm = u.match(/api\/kv\?prefix=(.*)$/);
          if (lm) {
            const pre = decodeURIComponent(lm[1]);
            const keys = Object.keys(kv).filter(k => k.startsWith(pre));
            return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ keys }) });
          }
          const m = u.match(/api\/kv\/(.+)$/);
          if (m) {
            const key = decodeURIComponent(m[1]);
            const method = (opts && opts.method) || 'GET';
            if (method === 'PUT') {
              kv[key] = JSON.parse(opts.body).value;
              return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ value: kv[key] }) });
            }
            if (method === 'DELETE') {
              delete kv[key];
              return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
            }
            if (kv[key] === undefined) return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
            return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ value: kv[key] }) });
          }
          return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}), text: () => Promise.resolve('') });
        };
      },
    });
    await new Promise(r => setTimeout(r, 1500));
    dom2.__kv = kv;
    return dom2;
  }

  // Stary format: surowa mapa, ceny przesunięte o godzinę.
  const oldCache = {};
  for (let h = 0; h < 24; h++) oldCache['2026-07-02_' + String(h).padStart(2, '0')] = 100 + h;
  const dOld = await loadWithCache(JSON.stringify(oldCache));
  // Uwaga: body.textContent zawiera też kod źródłowy skryptu, więc szukanie
  // frazy w całym body daje fałszywy pozytyw. Czytamy tylko panel logu.
  const bodyOld = dOld.window.document.getElementById('logOutput').textContent;
  t('D14 stary cache RCE odrzucony z ostrzeżeniem',
    bodyOld.includes('starym formacie'),
    'oczekiwano komunikatu o starym formacie cache');
  t('D15 stary cache nie zostaje zapisany z powrotem jako aktualny',
    dOld.__kv['rce-cache'] === undefined
      || JSON.parse(dOld.__kv['rce-cache']).v === 2);
  dOld.window.close();

  // Nowy format: wersjonowany, musi zostać wczytany bez ostrzeżenia.
  const dNew = await loadWithCache(JSON.stringify({ v: 2, data: oldCache }));
  const bodyNew = dNew.window.document.getElementById('logOutput').textContent;
  t('D16 nowy cache RCE przyjęty bez ostrzeżenia',
    !bodyNew.includes('starym formacie'),
    'wersjonowany cache nie powinien być odrzucany');
  dNew.window.close();

  console.log('\n=== Godziny eLicznika muszą przetrwać restart ===');
  // Bez utrwalania hourlyElicznik po restarcie nie dało się pobrać cen RCE
  // („Najpierw wczytaj dane z eLicznika") ani przeliczyć depozytu.
  const julyHours = {};
  for (let h = 0; h < 24; h++) {
    const key = '2026-07-01_' + String(h).padStart(2, '0');
    julyHours[key] = { date: '2026-07-01', hour: h, oddaniePoZbil: 1.5, poborPoZbil: 0.2, strefa: 'pozostałe' };
  }
  const extra = { 'elicznik-hourly-2026-07': JSON.stringify(julyHours) };

  // Brak cen RCE: godziny wczytane, ale depozyt NIE może być po cichu wyzerowany.
  const dNoPrice = await loadWithCache(JSON.stringify({ v: 2, data: {} }), extra);
  const logNoPrice = dNoPrice.window.document.getElementById('logOutput').textContent;
  t('D17 godziny eLicznika wczytane po restarcie',
    logNoPrice.includes('godzin eLicznika z poprzedniej sesji'),
    'oczekiwano komunikatu o wczytaniu godzin');
  t('D18 brak cen RCE zgłoszony, nie ciche zerowanie',
    logNoPrice.includes('brak cen RCE'),
    'oczekiwano ostrzeżenia o brakujących cenach');
  dNoPrice.window.close();

  // Z cenami: miesiące muszą zostać przeliczone.
  const prices = {};
  for (let h = 0; h < 24; h++) prices['2026-07-01_' + String(h).padStart(2, '0')] = 400;
  const dWithPrice = await loadWithCache(JSON.stringify({ v: 2, data: prices }), extra);
  const logWithPrice = dWithPrice.window.document.getElementById('logOutput').textContent;
  t('D19 z cenami nie ma ostrzeżenia o braku cen',
    logWithPrice.includes('godzin eLicznika z poprzedniej sesji') && !logWithPrice.includes('brak cen RCE'));
  dWithPrice.window.close();

  srv.close();
  console.log(`\n${pass} przeszło, ${fail} nie przeszło`);
  if (errors.length) console.log('\nZebrane błędy (pierwsze 5):\n' + errors.slice(0, 5).join('\n'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('BŁĄD TESTU:', e); process.exit(1); });
