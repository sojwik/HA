/* Wyłącznie wejścia nowej karty PV. Nie korzysta z legacy parsera HA i nie
 * zmienia progów/wartości istniejącego kalkulatora. Braki pozostają null. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.G13PvData = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const HOUR = 3600000, EPS = 1e-7;
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
  const finite = x => typeof x === 'number' && Number.isFinite(x);
  const own = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
  function localKey(ts) {
    const p = Object.create(null);
    for (const x of fmt.formatToParts(new Date(ts))) p[x.type] = x.value;
    return p.year + '-' + p.month + '-' + p.day + '_' + p.hour;
  }
  function validDate(s) {
    return typeof s === 'string' && /^20\d{2}-\d{2}-\d{2}$/.test(s)
      && Number.isFinite(Date.parse(s + 'T00:00:00Z'))
      && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
  }
  function nextDay(s) { return new Date(Date.parse(s + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10); }
  function midnight(s) {
    if (!validDate(s)) throw new Error('Nieprawidłowa data: ' + String(s));
    const base = Date.parse(s + 'T00:00:00Z');
    for (let h = -3; h <= 3; h++) if (localKey(base + h * HOUR) === s + '_00') return base + h * HOUR;
    throw new Error('Nie można ustalić północy Europe/Warsaw: ' + s);
  }
  function range(startDate, endDate) {
    if (!validDate(startDate) || !validDate(endDate) || endDate < startDate)
      throw new Error('Podaj prawidłowy zakres dat (oba dni włącznie).');
    const start = midnight(startDate), end = midnight(nextDay(endDate));
    if (end - start > 732 * 86400000) throw new Error('Jedno porównanie może obejmować najwyżej 732 dni.');
    return { start, end, hours: (end - start) / HOUR };
  }

  function csvRows(text) {
    // RFC4180, tylko separator przecinkowy z naszego endpointu; HTML 200 nie jest CSV.
    const rows = []; let row = [], cell = '', quoted = false;
    const s = String(text).replace(/^\uFEFF/, '');
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '"') {
        if (quoted && s[i + 1] === '"') { cell += '"'; i++; }
        else if (quoted || cell === '') quoted = !quoted;
        else throw new Error('Nieprawidłowy cudzysłów w CSV.');
      } else if (c === ',' && !quoted) { row.push(cell); cell = ''; }
      else if ((c === '\n' || c === '\r') && !quoted) {
        if (c === '\r' && s[i + 1] === '\n') i++;
        row.push(cell); if (row.some(x => x !== '')) rows.push(row); row = []; cell = '';
      } else cell += c;
    }
    if (quoted) throw new Error('Niepełny CSV (niezamknięty cudzysłów).');
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }
  function num(raw, context) {
    if (raw === undefined || raw === null || raw.trim() === '') return null;
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(raw.trim()) || !Number.isFinite(Number(raw)))
      throw new Error('Nieprawidłowa liczba w statystykach (' + context + ').');
    return Number(raw);
  }
  function parseStatsCsv(text) {
    const records = csvRows(text), head = records.shift() || [];
    for (const c of ['statistic_id', 'start_utc', 'change'])
      if (!head.includes(c)) throw new Error('To nie jest godzinowy eksport HA z start_utc i change (możliwa odpowiedź HTML zamiast CSV).');
    if (new Set(head).size !== head.length) throw new Error('Powtórzone kolumny CSV.');
    const series = Object.create(null), seen = new Set();
    for (const a of records) {
      if (a.length !== head.length) throw new Error('Nieprawidłowa liczba kolumn CSV.');
      const r = Object.create(null); head.forEach((k, i) => { r[k] = a[i]; });
      if (!/^[a-z_]+\.[a-z0-9_]+$/.test(r.statistic_id)) throw new Error('Nieprawidłowe statistic_id w CSV.');
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:00:00(?:\.000)?Z$/.test(r.start_utc))
        throw new Error('Brak jednoznacznego godzinowego czasu UTC: ' + r.start_utc);
      const ts = Date.parse(r.start_utc);
      if (!finite(ts) || new Date(ts).toISOString().replace('.000Z', 'Z') !== r.start_utc.replace('.000Z', 'Z'))
        throw new Error('Nieprawidłowa data UTC w CSV.');
      if (r.start && r.start !== localKey(ts).replace('_', ' ') + ':00:00')
        throw new Error('Etykieta lokalna CSV nie zgadza się z UTC/Europe/Warsaw.');
      const key = r.statistic_id + ':' + ts;
      if (seen.has(key)) throw new Error('Duplikat encji i czasu UTC: ' + r.statistic_id + ' ' + r.start_utc);
      seen.add(key);
      const v = { ts };
      for (const f of ['change', 'sum', 'mean', 'min', 'max']) v[f] = num(r[f], f + ', ' + r.start_utc);
      if (!series[r.statistic_id]) series[r.statistic_id] = [];
      series[r.statistic_id].push(v);
    }
    for (const a of Object.values(series)) a.sort((x, y) => x.ts - y.ts);
    if (!seen.size) throw new Error('HA zwrócił sam nagłówek, bez historii. Poprzedni zapis nie został zastąpiony.');
    return series;
  }
  function mergeSeries(parts) {
    const maps = Object.create(null);
    for (const part of parts) {
      if (!part || typeof part !== 'object' || Array.isArray(part)) throw new Error('Uszkodzony zapis PV (series).');
      for (const id of Object.keys(part)) {
        if (!/^[a-z_]+\.[a-z0-9_]+$/.test(id) || !Array.isArray(part[id])) throw new Error('Uszkodzony zapis encji PV.');
        if (!maps[id]) maps[id] = new Map();
        for (const raw of part[id]) {
          if (!raw || !finite(raw.ts) || raw.ts % HOUR !== 0) throw new Error('Uszkodzony czas w zapisie PV.');
          const r = { ts: raw.ts };
          for (const f of ['change', 'sum', 'mean', 'min', 'max']) {
            if (raw[f] !== null && !finite(raw[f])) throw new Error('Uszkodzona wartość w zapisie PV.');
            r[f] = raw[f];
          }
          const old = maps[id].get(r.ts);
          if (old && JSON.stringify(old) !== JSON.stringify(r)) throw new Error('Sprzeczne statystyki tej samej encji i czasu UTC.');
          maps[id].set(r.ts, r); // identyczny bufor między plikami/chunkami nie dubluje energii
        }
      }
    }
    const out = Object.create(null);
    for (const id of Object.keys(maps)) out[id] = Array.from(maps[id].values()).sort((a, b) => a.ts - b.ts);
    return out;
  }
  function entityIds(settings) {
    const e = settings.entities || {};
    const required = settings.loadMode === 'meter' ? ['pv', 'house'] : ['pv', 'acOutput', 'acCharge'];
    for (const f of required) if (!e[f]) throw new Error('Brak encji dla kanału: ' + f);
    const ids = Object.values(e).filter(Boolean);
    if (ids.some(x => typeof x !== 'string' || !/^[a-z_]+\.[a-z0-9_]+$/.test(x))) throw new Error('Nieprawidłowy identyfikator encji.');
    if (ids.length !== new Set(ids).size) throw new Error('Różne kanały PV/AC/BMS/domu nie mogą wskazywać tej samej encji.');
    if (!['conditional', 'meter'].includes(settings.loadMode)) throw new Error('Nieprawidłowy sposób ustalania zapotrzebowania.');
    return ids.sort();
  }
  function signature(settings) {
    return JSON.stringify({ startDate: settings.startDate, endDate: settings.endDate,
      entities: entityIds(settings), loadMode: settings.loadMode });
  }
  function sumOrNull(values) { return values.every(finite) ? values.reduce((s, v) => s + v, 0) : null; }

  function prepare(seriesInput, settings, shared) {
    const span = range(settings.startDate, settings.endDate);
    entityIds(settings);
    const series = mergeSeries([seriesInput]);
    const entities = settings.entities, maps = Object.create(null);
    for (const id of Object.keys(series)) maps[id] = new Map(series[id].map(r => [r.ts, r]));
    const issues = [], issueIndex = new Map();
    const grid = shared && shared.hourlyElicznik || {}, rce = shared && shared.rceHourly || {}, rates = shared && shared.zoneRates || {};
    function issue(code, ts, channel, severity, message, value) {
      const id = code + ':' + ts + ':' + channel;
      if (issueIndex.has(id)) {
        if (severity === 'error') issueIndex.get(id).severity = 'error';
        return;
      }
      const r = { code, ts, key: localKey(ts), channel, severity, message, value: value === undefined ? null : value };
      issueIndex.set(id, r); issues.push(r);
    }
    function energy(channel, ts, required) {
      const id = entities[channel], map = id && maps[id], row = map && map.get(ts);
      if (!id && !required) {
        issue('channel_not_configured', span.start, channel, 'warning', 'Nie skonfigurowano kanału diagnostycznego. Nie zastąpiono go zerami ani innym źródłem.');
        return null;
      }
      let v = null, code = null, message = '';
      if (!row || !finite(row.change)) { code = 'missing_energy'; message = 'Brak przyrostu change; nie użyto zera ani średniej mocy.'; }
      else if (row.change < 0) { code = 'negative_energy'; message = 'Ujemny przyrost energii — bez obcinania.'; }
      else if (!map.has(ts - HOUR)) { code = 'after_gap'; message = 'Brak poprzedniej godziny/bufora: nie przypisujemy energii po luce ostatniej godzinie.'; }
      else {
        const previous = map.get(ts - HOUR);
        if (finite(row.sum) && finite(previous.sum) && Math.abs(row.change - (row.sum - previous.sum)) > EPS) {
          code = 'sum_disagrees'; message = 'change różni się od Δsum; możliwy reset lub rozbieżność granic.';
        } else v = row.change;
      }
      if (code) issue(code, ts, channel, required ? 'error' : 'warning', message, row && row.change);
      return v;
    }
    const hourly = [], groups = new Map();
    let negativeResidualHours = 0, residualBelowMinus02Hours = 0, residualKnownHours = 0;
    let residualSum = 0, pvPowerKnownHours = 0, pvPowerApproxKwh = 0, socRangeFlags = 0;
    for (let ts = span.start; ts < span.end; ts += HOUR) {
      const key = localKey(ts), conditional = settings.loadMode === 'conditional';
      const h = { ts, key,
        pv: energy('pv', ts, true), acOutput: energy('acOutput', ts, conditional),
        acCharge: energy('acCharge', ts, conditional),
        bmsCharge: energy('bmsCharge', ts, false), bmsDischarge: energy('bmsDischarge', ts, false),
        house: settings.loadMode === 'meter' ? energy('house', ts, true) : null };
      if ([h.pv, h.acOutput, h.acCharge, h.bmsCharge, h.bmsDischarge].every(finite)) {
        h.residual = h.pv + h.bmsDischarge + h.acCharge - h.bmsCharge - h.acOutput;
        residualKnownHours++; residualSum += h.residual;
        if (h.residual < -EPS) negativeResidualHours++;
        if (h.residual < -0.2 - EPS) {
          residualBelowMinus02Hours++;
          issue('negative_residual', ts, 'balance', 'warning', 'Warunkowa reszta falownika < −0,2 kWh; NIE jest skorygowana ani uznana za ujemną stratę.', h.residual);
        }
      } else h.residual = null;
      const powerMap = maps[entities.pvPower], power = powerMap && powerMap.get(ts);
      if (power && finite(power.mean) && power.mean >= 0) {
        pvPowerKnownHours++; pvPowerApproxKwh += power.mean; // zadeklarowana jednostka kW, 1 h
        if (h.pv === 0 && power.mean > 0.1) issue('stalled_pv', ts, 'pv', 'warning', 'Zerowy przyrost PV mimo mean mocy >0,1 kW. Bez zastępowania licznika mocą.', power.mean);
        if (finite(h.pv) && Math.abs(h.pv - power.mean) > Math.max(0.2, power.mean * 0.2))
          issue('power_disagrees', ts, 'pv', 'warning', 'PV change różni się od przybliżenia mean mocy × 1 h (próg max 0,2 kWh / 20%).', h.pv - power.mean);
      }
      const socMap = maps[entities.soc], soc = socMap && socMap.get(ts);
      if (soc && [soc.min, soc.max].every(finite) && (soc.min < 0 || soc.max > 100 || soc.min > soc.max || soc.max - soc.min > 20)) {
        socRangeFlags++;
        issue('soc_range', ts, 'soc', 'warning', 'Nietypowy zakres min/max SOC; nie jest granicznym stanem baterii i nie steruje modelem.', { min: soc.min, max: soc.max });
      }
      hourly.push(h);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(h);
    }
    const rows = [], historical = Object.create(null);
    let dstBlocks = 0, zeroImportPositiveAcBlocks = 0, negativeHouseBlocks = 0;
    for (const [key, hs] of groups) {
      const ts = hs[0].ts, durationHours = hs.length, g = own(grid, key) ? grid[key] : null;
      const gridOk = !!g && g.hasImport === true && g.hasExport === true
        && finite(g.poborPoZbil) && g.poborPoZbil >= 0 && finite(g.oddaniePoZbil) && g.oddaniePoZbil >= 0;
      if (!gridOk) issue('grid_missing', ts, 'elicznik', settings.loadMode === 'conditional' ? 'error' : 'warning',
        'Brak pełnych nieujemnych kierunków eLicznika z flagami hasImport/hasExport. Stary/niepełny zapis nie oznacza 0.');
      if (durationHours !== 1) {
        dstBlocks++;
        issue('dst_aggregate', ts, 'time', settings.allowDstAggregation === true ? 'warning' : 'error',
          'Powtórzona godzina: obie godziny UTC zachowano, wspólny krok 2 h o średnich mocach. Brak przypisania eLicznika/cen do foldów. Wymaga jawnej zgody.');
      }
      const pv = sumOrNull(hs.map(h => h.pv)), output = sumOrNull(hs.map(h => h.acOutput)), ac = sumOrNull(hs.map(h => h.acCharge));
      const load = settings.loadMode === 'meter' ? sumOrNull(hs.map(h => h.house))
        : gridOk && finite(output) && finite(ac) ? output + g.poborPoZbil - g.oddaniePoZbil - ac : null;
      if (finite(load) && load < 0) {
        negativeHouseBlocks++;
        issue('negative_house', ts, 'house', 'error', 'Ujemne warunkowe zapotrzebowanie domu. Wartość zachowana; model zablokowany, bez clamp/wykluczania.', load);
      }
      if (gridOk && g.poborPoZbil === 0 && finite(ac) && ac > EPS) {
        zeroImportPositiveAcBlocks++;
        issue('ac_without_net_import', ts, 'acCharge', 'warning', 'Dodatni licznik ładowania AC przy zerowym imporcie po zbilansowaniu. AC nie oznacza fakturowanego zakupu.', ac);
      }
      const buy = g && own(rates, g.strefa) && finite(rates[g.strefa]) && rates[g.strefa] >= 0 ? rates[g.strefa] : null;
      // Legacy klucz RCE nie rozróżnia foldów. Nie stosujemy jednej/średniej
      // ceny do dwóch godzin o nieznanych przepływach i różnych cenach.
      const sale = durationHours === 1 && own(rce, key) && finite(rce[key]) ? rce[key] : null;
      rows.push({ ts, key, durationHours, pvDcKwh: pv, loadAcKwh: load,
        gridMeasuredImportKwh: gridOk ? g.poborPoZbil : null,
        gridMeasuredExportKwh: gridOk ? g.oddaniePoZbil : null,
        acOutputKwh: output, acChargeKwh: ac, buyPlnKwh: buy, rcePlnMwh: sale });
      const mk = key.slice(0, 7);
      if (!historical[mk]) historical[mk] = { hours: 0, buckets: 0, values: Object.create(null) };
      const m = historical[mk]; m.hours += durationHours; m.buckets++;
      for (const [f, v] of Object.entries({ pvDcKwh: pv, houseKwh: load, acOutputKwh: output, acChargeKwh: ac,
        gridImportKwh: gridOk ? g.poborPoZbil : null, gridExportKwh: gridOk ? g.oddaniePoZbil : null })) {
        if (!m.values[f]) m.values[f] = { knownKwh: 0, missingBlocks: 0, totalKwh: 0 };
        const cell = m.values[f]; if (finite(v)) cell.knownKwh += v; else cell.missingBlocks++;
        cell.totalKwh = cell.missingBlocks ? null : cell.knownKwh;
      }
    }
    const errors = issues.filter(x => x.severity === 'error');
    return { ok: errors.length === 0, physicalValidation: false, rows, hourly, historical, issues,
      diagnostics: { expectedHours: span.hours, intervalCount: rows.length, dstBlocks,
        residualKnownHours, residualMissingHours: span.hours - residualKnownHours,
        residualSumKwh: residualKnownHours === span.hours ? residualSum : null, residualKnownSumKwh: residualSum,
        negativeResidualHours, residualBelowMinus02Hours, zeroImportPositiveAcBlocks, negativeHouseBlocks,
        pvPowerKnownHours, pvPowerApproxKwh: pvPowerKnownHours === span.hours ? pvPowerApproxKwh : null,
        socRangeFlags, missingBuyPriceBlocks: rows.filter(r => r.buyPlnKwh === null).length,
        missingRcePriceBlocks: rows.filter(r => r.rcePlnMwh === null).length, errorCount: errors.length } };
  }
  return Object.freeze({ parseStatsCsv, mergeSeries, prepare, entityIds, signature, range, midnight, nextDay, localKey });
});
