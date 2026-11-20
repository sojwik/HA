'use strict';
/* 0.4.4: weryfikacja rozliczenia M+1 FIFO w Depozycie, statusu „Wykorzystana”
 * i kolumny „Potencjalny zwrot” w Wygasaniu, kontroli pokrycia PV w Analizie
 * oraz ręcznego parsera CSV RCE (15-min PSE). */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM, ResourceLoader, VirtualConsole } = require('../app/node_modules/jsdom');

const PUB = path.resolve(__dirname, '../app/public');
let pass = 0, fail = 0;

async function test(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.error('  ✗ ' + name + '\n      ' + (e && e.stack ? e.stack : e)); fail++; }
}

async function openDom(kvData) {
  const kv = Object.assign({}, kvData);
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push(e.message));
  class Local extends ResourceLoader {
    fetch(url) {
      const u = new URL(url);
      if (u.host !== 'calc.test') return Promise.resolve(Buffer.from(''));
      const file = path.join(PUB, u.pathname.replace(/^\//, ''));
      if (!file.startsWith(PUB) || !fs.existsSync(file)) throw Error('asset ' + url);
      return Promise.resolve(fs.readFileSync(file));
    }
  }
  const dom = new JSDOM(fs.readFileSync(path.join(PUB, 'index.html'), 'utf8'), {
    url: 'https://calc.test/',
    runScripts: 'dangerously',
    resources: new Local(),
    virtualConsole: vc,
    beforeParse(w) {
      w.AbortController = AbortController;
      w.fetch = async (input, opts = {}) => {
        const u = new URL(String(input), w.location.href);
        const p = u.pathname;
        if (p === '/api/config') return new Response(JSON.stringify({ historyMonthsBack: 24, refreshIntervalMinutes: 60 }));
        if (p.startsWith('/api/growatt/')) return new Response(JSON.stringify({ error: 'offline' }), { status: 404 });
        if (p === '/api/kv') {
          const pre = u.searchParams.get('prefix') || '';
          return new Response(JSON.stringify({ keys: Object.keys(kv).filter(k => k.startsWith(pre)) }));
        }
        if (p.startsWith('/api/kv/')) {
          const key = decodeURIComponent(p.slice('/api/kv/'.length));
          const m = opts.method || 'GET';
          if (m === 'PUT') { kv[key] = JSON.parse(opts.body).value; return new Response(JSON.stringify({ key, value: kv[key] })); }
          if (m === 'DELETE') { delete kv[key]; return new Response(JSON.stringify({ key, deleted: true })); }
          if (kv[key] === undefined) return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
          return new Response(JSON.stringify({ key, value: kv[key] }));
        }
        return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
      };
    },
  });
  await new Promise(r => setTimeout(r, 350));
  return { dom, w: dom.window, $: id => dom.window.document.getElementById(id), errors };
}

(async () => {
  console.log('\n=== 0.4.4: Depozyt M+1 FIFO, Wygasanie (Wykorzystana + zwrot), Analiza PV ===');

  const ledger = {
    months: {
      '2026-03': { kwh: 345.5, przypis: 63.86, kosztEnergii: 124.17, kosztDystrybucji: 0, haZuzycieDomu: 50, haPobor: 10, haPvHours: 28, haHours: 351, haLadowanie: 152.7, haRozladowanie: 151.0 },
      '2026-04': { kwh: 516.6, przypis: 99.65, kosztEnergii: 30.22, kosztDystrybucji: 0, haPvHours: 700, haHours: 720 },
      '2026-05': { kwh: 660.2, przypis: 215.24, kosztEnergii: 19.96, kosztDystrybucji: 0 },
      '2026-06': { kwh: 560.0, przypis: 197.95, kosztEnergii: 6.35, kosztDystrybucji: 0 },
      '2026-07': { kwh: 582.8, przypis: 258.62, kosztEnergii: 20.03, kosztDystrybucji: 0 },
      '2026-08': { kwh: 653.7, przypis: 332.79, kosztEnergii: 13.21, kosztDystrybucji: 0 },
      '2026-09': { kwh: 408.1, przypis: 269.98, kosztEnergii: 68.94, kosztDystrybucji: 0 },
      '2026-10': { kwh: 347.0, przypis: 265.29, kosztEnergii: 123.40, kosztDystrybucji: 0 },
      '2026-11': { kwh: 148.0, przypis: 218.08, kosztEnergii: 0.00, kosztDystrybucji: 0 },
    },
    kosztInwestycji: 26000,
    refundRate: 0.30,
    refundCapBasis: 'base',
    zoneRates: { T1: 0.90, T2: 1.50, T3: 0.63 },
  };
  const marHa = [];
  const marEl = {};
  for (let h = 0; h < 48; h++) {
    const ts = Date.UTC(2026, 2, 10) + h * 3600000;
    const d = new Date(ts).toISOString().slice(0, 10);
    const hr = new Date(ts).getUTCHours();
    marHa.push({ ts, produkcja: 0, ladowanie: 0, rozladowanie: 0, oddanieHa: 2 });
    marEl[d + '_' + String(hr).padStart(2, '0')] = { date: d, hour: hr, poborPoZbil: 0, oddaniePoZbil: 2, strefa: 'T1', hasImport: true, hasExport: true };
  }

  const d = await openDom({
    'monthly-ledger': JSON.stringify(ledger),
    'ha-hourly-2026-03': JSON.stringify(marHa),
    'elicznik-hourly-2026-03': JSON.stringify(marEl),
  });

  await test('CALC01 Depozyt M+1 FIFO: marzec pokryte=0, dopłata=124,17, saldo=63,86, listopad=1639,35', () => {
    const rows = Array.from(d.$('ledgerBody').querySelectorAll('tr'));
    assert.strictEqual(rows.length, 9);
    const marCells = Array.from(rows[0].querySelectorAll('td')).map(x => x.textContent.trim());
    assert.strictEqual(marCells[5], '0,00 zł', JSON.stringify(marCells));
    assert.strictEqual(marCells[6], '124,17 zł');
    assert.strictEqual(marCells[7], '63,86 zł');
    const augCells = Array.from(rows[5].querySelectorAll('td')).map(x => x.textContent.trim());
    assert.strictEqual(augCells[7], '1078,34 zł');
    assert.strictEqual(d.$('readoutSaldo').textContent.trim(), '1639,35 zł');
  });

  await test('CALC02 Wygasanie: wykorzystane transze mają status „Wykorzystana” i 0,00 zł zwrotu', () => {
    const rows = Array.from(d.$('tranchesBody').querySelectorAll('tr'));
    const mar = Array.from(rows[0].querySelectorAll('td')).map(x => x.textContent.trim());
    const apr = Array.from(rows[1].querySelectorAll('td')).map(x => x.textContent.trim());
    assert.strictEqual(mar[3], 'Wykorzystana', JSON.stringify(mar));
    assert.strictEqual(mar[4], '0,00 zł', JSON.stringify(mar));
    assert.strictEqual(apr[3], 'Wykorzystana', JSON.stringify(apr));
    assert.strictEqual(apr[4], '0,00 zł', JSON.stringify(apr));
  });

  await test('CALC03 Wygasanie: najbliższe wygaśnięcie pomija wykorzystane transze i pokazuje maj 2026 → czerwiec 2027', () => {
    assert.strictEqual(d.$('readoutWygasanie').textContent.trim(), 'czerwiec 2027');
    const sub = d.$('readoutWygasanieSub').textContent;
    assert.ok(sub.includes('96,64 zł') && sub.includes('maj 2026') && sub.includes('do 52,50 zł'), sub);
  });

  await test('CALC04 Wygasanie: kolumna „Potencjalny zwrot” wylicza aktywne transze (base vs deposit) i stopkę', () => {
    const rows = Array.from(d.$('tranchesBody').querySelectorAll('tr'));
    const mayBase = Array.from(rows[2].querySelectorAll('td')).map(x => x.textContent.trim());
    const julBase = Array.from(rows[4].querySelectorAll('td')).map(x => x.textContent.trim());
    assert.ok(mayBase[3].includes('Aktywna') && mayBase[3].includes('96,64 zł'), mayBase[3]);
    assert.strictEqual(mayBase[4], 'do 52,50 zł', mayBase[4]);
    assert.strictEqual(julBase[4], 'do 63,08 zł', julBase[4]);
    assert.ok(d.$('tranchesFoot').textContent.includes('1639,35 zł'), d.$('tranchesFoot').textContent);
    assert.ok(d.$('tranchesFoot').textContent.includes('do 428,77 zł'), d.$('tranchesFoot').textContent);

    d.$('inputRefundCapBasis').value = 'deposit';
    d.$('inputRefundCapBasis').dispatchEvent(new d.w.Event('change', { bubbles: true }));
    const rowsDep = Array.from(d.$('tranchesBody').querySelectorAll('tr'));
    const mayDep = Array.from(rowsDep[2].querySelectorAll('td')).map(x => x.textContent.trim());
    const julDep = Array.from(rowsDep[4].querySelectorAll('td')).map(x => x.textContent.trim());
    assert.strictEqual(mayDep[4], 'do 64,57 zł', mayDep[4]);
    assert.strictEqual(julDep[4], 'do 77,59 zł', julDep[4]);
    assert.ok(d.$('tranchesFoot').textContent.includes('do 527,39 zł'), d.$('tranchesFoot').textContent);
  });

  await test('CALC05 Analiza (ROI): niepełne dane PV (marzec 28/351 h) → „brak danych PV”, nie ujemna autokonsumpcja', () => {
    const marRow = Array.from(d.$('roiBody').querySelectorAll('tr'))[0];
    const cells = Array.from(marRow.querySelectorAll('td')).map(x => x.textContent.trim());
    assert.ok(cells[2].includes('brak danych PV'), JSON.stringify(cells));
    assert.strictEqual(cells[3], '—', JSON.stringify(cells));
    assert.strictEqual(cells[4], '63,86 zł', JSON.stringify(cells));
  });

  await test('CALC06 brak zdublowanego zdania w opisie Analizy', () => {
    const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
    assert.strictEqual(html.split('„Zwrot” liczony jest jako suma przypisów').length - 1, 1);
  });

  await test('CALC07 brak błędów DOM', () => {
    assert.strictEqual(d.errors.length, 0, d.errors.join('\n'));
  });

  d.w.close();

  const expLedger = {
    months: {
      '2025-03': { kwh: 200, przypis: 100.00, kosztEnergii: 0, kosztDystrybucji: 0 },
      '2026-04': { kwh: 0, przypis: 0, kosztEnergii: 10.00, kosztDystrybucji: 0 },
    },
    refundRate: 0.30,
    refundCapBasis: 'deposit',
  };
  const d2 = await openDom({ 'monthly-ledger': JSON.stringify(expLedger) });
  await test('CALC08 wygasła transza po M+13 zeruje saldo w Depozycie i wylicza zwrot w Wygasaniu', () => {
    const depRows = Array.from(d2.$('ledgerBody').querySelectorAll('tr'));
    const aprDep = Array.from(depRows[1].querySelectorAll('td')).map(x => x.textContent.trim());
    assert.ok(aprDep[0].includes('wygasło 100,00 zł'), aprDep[0]);
    assert.strictEqual(aprDep[5], '0,00 zł');
    assert.strictEqual(aprDep[6], '10,00 zł');
    assert.strictEqual(aprDep[7], '0,00 zł');

    const trRows = Array.from(d2.$('tranchesBody').querySelectorAll('tr'));
    const tr = Array.from(trRows[0].querySelectorAll('td')).map(x => x.textContent.trim());
    assert.ok(tr[3].includes('Wygasła kwiecień 2026'), tr[3]);
    assert.strictEqual(tr[4], '30,00 zł', tr[4]);
  });
  d2.w.close();

  console.log('\nKalkulacje 0.4.4: ' + pass + ' przeszło, ' + fail + ' nie przeszło');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
