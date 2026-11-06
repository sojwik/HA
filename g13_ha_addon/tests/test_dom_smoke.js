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
  async function loadWithCache(cacheValue, extraKv, apiConfig, apiCsv) {
    const kv = Object.assign({ 'rce-cache': cacheValue }, extraKv || {});
    const calls = [];
    const dom2 = await JSDOM.fromURL(`http://127.0.0.1:${port}/index.html`, {
      runScripts: 'dangerously',
      resources: 'usable',
      virtualConsole: vc,
      beforeParse(window) {
        window.XLSX = { read: () => ({ SheetNames: ['a'], Sheets: { a: {} } }), utils: { sheet_to_json: () => [] } };
        window.fetch = (url, opts) => {
          const u = String(url);
          calls.push(u);
          // F40: eksport encji. Odpowiedź podstawialna, żeby sprawdzić
          // ścieżkę pustą i ścieżkę z danymi.
          if (/api\/ha\/stats\.csv/.test(u)) {
            if (apiCsv === null || apiCsv === undefined) {
              return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ error: 'not_found' }), text: () => Promise.resolve('') });
            }
            return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(apiCsv), json: () => Promise.resolve({}) });
          }
          // F39: /api/config musi dać się podstawć, żeby sprawdzić, czy opcje
          // dodatku naprawdę docierają do walidatora w przeglądarce.
          if (apiConfig && /api\/config/.test(u)) {
            return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(apiConfig) });
          }
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
    dom2.__calls = calls;
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

  console.log('\n=== F31/F33/F36: zakładka Magazyn na realnych liczbach ===');
  // Liczby z rzeczywistego widoku użytkownika (stawka 0,63 zł/kWh).
  // Wrzesień i październik mają niemożliwy bilans magazynu.
  const ledger = {
    months: {
      '2026-05': { kosztEnergii: 630, poborKwh: 1000, haLadowanie: 346.2, haRozladowanie: 318.4, haHours: 744 },
      '2026-07': { kosztEnergii: 630, poborKwh: 1000, haLadowanie: 355.3, haRozladowanie: 327.2, haHours: 733 },
      '2026-09': { kosztEnergii: 630, poborKwh: 1000, haLadowanie: 347.5, haRozladowanie: 395.1, haHours: 720 },
      '2026-10': { kosztEnergii: 630, poborKwh: 1000, haLadowanie: 325.2, haRozladowanie: 453.7, haHours: 744 },
    },
    batCostPln: 5990,
    haBatteryCheck: {
      '2026-05': { plausible: true, ratio: 0.95, socRange: 13.7 },
      '2026-07': { plausible: true, ratio: 1.11, socRange: 15.9 },
      '2026-09': { plausible: false, ratio: 6.41, socRange: 91.9, hardImpossible: true, hardExcess: 33.26, reason: 'liczniki niespójne' },
      '2026-10': { plausible: false, ratio: 11.12, socRange: 159.4, hardImpossible: true, hardExcess: 114.06, reason: 'liczniki niespójne' },
    },
    haRejected: {
      '2026-05': { total: 23, rejectedKwh: -2.7, byRole: { poborHa: { count: 23 } } },
      '2026-07': { total: 42, rejectedKwh: 2949.2, byRole: { poborHa: { count: 42 } } },
    },
  };
  const dBat = await loadWithCache(null, { 'monthly-ledger': JSON.stringify(ledger) });
  const doc = dBat.window.document;
  const head = (doc.getElementById('readoutRealBatterySub') || {}).textContent || '';
  const note = (doc.getElementById('realBatteryNote') || {}).textContent || '';
  const foot = (doc.getElementById('realBatteryFoot') || {}).textContent || '';

  // SUMA wszystkich = (318,4+327,2+395,1+453,7) x 0,63 = 941,47 zł
  // Zaufane (maj+lipiec) = (318,4+327,2) x 0,63 = 406,73 zł
  t('D20 nagłówek ROI wyklucza miesiące z niemożliwym bilansem',
    head.includes('406,73') && head.includes('wiarygodnych'),
    'nagłówek: ' + head);
  t('D21 pod tabelą pokazane, ile odrzucono z sumy',
    note.includes('534,74') && note.includes('niemożliwym bilansem'),
    'nota: ' + note);
  t('D22 tabela nadal pokazuje pełną sumę (nic nie ukryte)',
    foot.includes('941,47'), 'stopka: ' + foot);
  t('D23 flagi usterek przetrwały restart (F36)',
    (doc.getElementById('realBatteryBody') || {}).textContent.includes('bilans niemożliwy'),
    'wiersze bez oznaczeń');
  const diag = (doc.getElementById('haDiagnostics') || {}).textContent || '';
  t('D24 licznik odrzuceń = 65 h, nie 65 × liczba miesięcy',
    diag.includes('Odrzucono 65 godzin') && !diag.includes('Odrzucono 130'),
    'diagnostyka: ' + diag.slice(0, 160));
  // Tabela odrzuceń to pierwsza <table> w panelu. Musi mieć 2 wiersze
  // (maj, lipiec), a nie 4 — wrzesień i październik nie odrzuciły godzin,
  // mają osobny problem (bilans baterii), pokazany niżej.
  const diagHtml = (doc.getElementById('haDiagnostics') || {}).innerHTML || '';
  const firstTable = diagHtml.slice(0, diagHtml.indexOf('</table>') + 8);
  const bodyRows = (firstTable.match(/<tr>/g) || []).length - 1; // minus nagłówek
  t('D25 tabela odrzuceń ma 2 wiersze, nie 4', bodyRows === 2,
    'wierszy: ' + bodyRows);
  dBat.window.close();

  // D26/D27: przebieg przez PRAWDZIWE wgranie pliku, nie przez seed KV.
  // Mutacja F31 (powrót do `= parsed.rejected`) nie była łapana przez D24/D25,
  // bo tam haRejected przychodziło już podzielone z KV.
  const { CSV } = require('./fixture');
  if (CSV) {
    console.log('\n=== F31 end-to-end: wgranie realnego eksportu HA ===');
    const dUp = await loadWithCache(null, {});
    const w = dUp.window, d = w.document;
    const csvText = fs.readFileSync(CSV, 'utf8');
    const file = new w.File([csvText], 'growatt-ha-auto-sync.csv', { type: 'text/csv' });
    // jsdom w tej wersji nie ma File.text() (przeglądarki mają) — uzupełniamy
    // wyłącznie brak harnessu, nie zachowanie aplikacji.
    if (typeof file.text !== 'function') file.text = () => Promise.resolve(csvText);
    const input = d.getElementById('fileHaStats');
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new w.Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 4000));
    const diagUp = (d.getElementById('haDiagnostics') || {}).textContent || '';
    const m = diagUp.match(/Odrzucono (\d+) godzin/);
    t('D26 nagłówek odrzuceń = 192 h (nie 192 × 9 = 1728)',
      m && m[1] === '192', 'nagłówek: ' + (m ? m[1] : 'brak'));
    const upHtml = (d.getElementById('haDiagnostics') || {}).innerHTML || '';
    const tbl = upHtml.slice(0, upHtml.indexOf('</table>') + 8);
    const nRows = (tbl.match(/<tr>/g) || []).length - 1;
    t('D27 tabela odrzuceń ma 5 wierszy (marzec–lipiec), nie 9',
      nRows === 5, 'wierszy: ' + nRows);
    const capDefault = diagUp.match(/pojemność ([\d.]+) kWh/);
    t('D28 domyślna pojemność w diagnozie = 14.34 kWh (nie 16.35)',
      capDefault && capDefault[1] === '14.34',
      'znaleziono: ' + (capDefault ? capDefault[1] : 'brak'));
    // D6: ostrzeżenie o niemożliwej SUMIE musi się wyrenderować po wgraniu,
    // a nie tylko istnieć jako funkcja w walidatorze.
    const noteTxt = (d.getElementById('realBatteryNote') || {}).textContent || '';
    t('D30 pod tabelą jest ostrzeżenie o fizycznie niemożliwej SUMIE',
      /SUMA jest fizycznie niemożliwy/.test(noteTxt),
      'notatka: ' + noteTxt.slice(0, 160));
    t('D31 ostrzeżenie podaje nadmiar w kWh',
      /nadmiar\s+[\d.,]+\s*kWh/i.test(noteTxt),
      'notatka: ' + noteTxt.slice(0, 200));
    dUp.window.close();

    // F39: opcja battery_capacity_kwh ustawiona w HA musi nadpisać domyślną
    // z validate.js. Wcześniej validateCfg powstawało raz z defaultów
    // i opcja była po stronie przeglądarki całkowicie ignorowana.
    console.log('\n=== F39: opcje dodatku docierają do walidatora ===');
    const dCfg = await loadWithCache(null, {}, { batteryCapacityKwh: 5, batteryEta: 0.92 });
    const wc = dCfg.window, dc = wc.document;
    const fileC = new wc.File([csvText], 'growatt-ha-auto-sync.csv', { type: 'text/csv' });
    if (typeof fileC.text !== 'function') fileC.text = () => Promise.resolve(csvText);
    const inputC = dc.getElementById('fileHaStats');
    Object.defineProperty(inputC, 'files', { value: [fileC], configurable: true });
    inputC.dispatchEvent(new wc.Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 4000));
    const diagCfg = (dc.getElementById('haDiagnostics') || {}).textContent || '';
    t('D29 pojemność z /api/config (5 kWh) nadpisuje domyślną 14.34',
      /pojemność 5\.00 kWh/.test(diagCfg),
      'fragment: ' + (diagCfg.match(/pojemność [\d.]+ kWh/) || ['brak'])[0]);
    dCfg.window.close();
  } else {
    console.log('\n  (pominięto D26–D29 — brak realnego CSV; ustaw G13_TEST_CSV)');
  }

  console.log('\n=== F40: eksport encji musi używać adresu WZGLĘDNEGO ===');
  // Regresja z produkcji: użytkownik składał adres ręcznie i trafiał w powłokę
  // SPA Home Assistant, bo prefiks nie był trasą do dodatku. Przycisk musi
  // wołać 'api/ha/stats.csv' względnie, tak jak window.storage woła 'api/kv'.
  const CSV_OK = 'statistic_id,start,start_utc,mean,min,max\n'
    + 'sensor.jk_bms_current,2026-09-28 02:00:00,2026-09-28T00:00:00Z,-5.4,-5.9,-5.1\n';
  const dExp = await loadWithCache(null, {}, undefined, CSV_OK);
  const we = dExp.window, de = we.document;
  // jsdom nie ma URL.createObjectURL — uzupełniamy wyłącznie brak harnessu.
  we.URL.createObjectURL = () => 'blob:stub';
  we.URL.revokeObjectURL = () => {};
  t('D32 przycisk eksportu istnieje', !!de.getElementById('btnExportEntities'));
  de.getElementById('inputExportEntities').value = '';
  de.getElementById('btnExportEntities').click();
  await new Promise(r => setTimeout(r, 200));
  t('D33 puste pole → ostrzeżenie, bez żadnego żądania',
    /Wpisz co najmniej jedno/.test(de.getElementById('exportEntitiesStatus').textContent)
    && !dExp.__calls.some(u => /api\/ha\/stats\.csv/.test(u)),
    'status: ' + de.getElementById('exportEntitiesStatus').textContent);
  de.getElementById('inputExportEntities').value = 'sensor.JK_BMS_Current';
  de.getElementById('btnExportEntities').click();
  await new Promise(r => setTimeout(r, 200));
  t('D34 wielkie litery w entity_id odrzucone przed żądaniem',
    /Nieprawidłowe entity_id/.test(de.getElementById('exportEntitiesStatus').textContent),
    'status: ' + de.getElementById('exportEntitiesStatus').textContent);
  de.getElementById('inputExportEntities').value = 'sensor.jk_bms_current, sensor.jk_bms_total_voltage';
  de.getElementById('inputExportStart').value = '2026-09-20';
  de.getElementById('inputExportEnd').value = '2026-10-16';
  de.getElementById('btnExportEntities').click();
  await new Promise(r => setTimeout(r, 400));
  const expCall = dExp.__calls.filter(u => /api\/ha\/stats\.csv/.test(u)).pop();
  t('D35 żądanie idzie pod adres WZGLĘDNY api/ha/stats.csv',
    !!expCall && expCall.startsWith('api/ha/stats.csv?'),
    'wołano: ' + expCall);
  t('D36 zakodowane entities, start, end i types=mean,min,max',
    !!expCall && /entities=sensor\.jk_bms_current(%2C|,)sensor\.jk_bms_total_voltage/.test(expCall)
    && /start=2026-09-20/.test(expCall) && /end=2026-10-16/.test(expCall)
    && /types=mean(%2C|,)min(%2C|,)max/.test(expCall),
    'wołano: ' + expCall);
  t('D37 sukces raportuje liczbę wierszy',
    /Pobrano 1 wierszy/.test(de.getElementById('exportEntitiesStatus').textContent),
    'status: ' + de.getElementById('exportEntitiesStatus').textContent);
  dExp.window.close();

  const dEmpty = await loadWithCache(null, {}, undefined, 'statistic_id,start,start_utc,mean,min,max\n');
  const wq = dEmpty.window, dq = wq.document;
  wq.URL.createObjectURL = () => 'blob:stub';
  wq.URL.revokeObjectURL = () => {};
  dq.getElementById('inputExportEntities').value = 'sensor.bez_state_class';
  dq.getElementById('btnExportEntities').click();
  await new Promise(r => setTimeout(r, 400));
  t('D38 pusty plik → podpowiedź o state_class, nie cichy sukces',
    /state_class/.test(dq.getElementById('exportEntitiesStatus').textContent),
    'status: ' + dq.getElementById('exportEntitiesStatus').textContent);
  dEmpty.window.close();

  srv.close();
  console.log(`\n${pass} przeszło, ${fail} nie przeszło`);
  if (errors.length) console.log('\nZebrane błędy (pierwsze 5):\n' + errors.slice(0, 5).join('\n'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('BŁĄD TESTU:', e); process.exit(1); });
