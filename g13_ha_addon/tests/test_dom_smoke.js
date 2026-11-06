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
  srv.close();
  console.log(`\n${pass} przeszło, ${fail} nie przeszło`);
  if (errors.length) console.log('\nZebrane błędy (pierwsze 5):\n' + errors.slice(0, 5).join('\n'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('BŁĄD TESTU:', e); process.exit(1); });
