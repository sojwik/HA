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

  function csvRows(text, separator = ',') {
    // Jawny separator: przecinek dla własnego endpointu HA, średnik dla eLicznika.
    const rows = []; let row = [], cell = '', quoted = false;
    const s = String(text).replace(/^\uFEFF/, '');
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '"') {
        if (quoted && s[i + 1] === '"') { cell += '"'; i++; }
        else if (quoted || cell === '') quoted = !quoted;
        else throw new Error('Nieprawidłowy cudzysłów w CSV.');
      } else if (c === separator && !quoted) { row.push(cell); cell = ''; }
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
      if (r.power_unit && r.power_unit.trim()) v.powerUnit = r.power_unit.trim();
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
          if (raw.powerUnit !== undefined) {
            if (typeof raw.powerUnit !== 'string' || raw.powerUnit.length > 32) throw new Error('Uszkodzona jednostka mocy PV.');
            r.powerUnit = raw.powerUnit;
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

  // Osobny, jawny format Tauron eLicznik: etykieta KOŃCA godziny 1–24.
  // Żadnego wywołania parsera, akumulatora ani saveState starej karty.
  const GRID_FORMAT = 'elicznik-end-v1';
  function gridCalendar() {
    const days = new Map();
    return function (day) {
      if (!validDate(day)) throw new Error('Nieprawidłowa data eLicznika.');
      if (!days.has(day)) {
        const counts = Object.create(null), a = midnight(day), b = midnight(nextDay(day));
        for (let t = a; t < b; t += HOUR) { const h = Number(localKey(t).slice(-2)); counts[h] = (counts[h] || 0) + 1; }
        days.set(day, counts);
      }
      return days.get(day);
    };
  }
  function validateGridDataset(data) {
    if (!data || data.format !== GRID_FORMAT || !Array.isArray(data.rows) || !data.rows.length || data.rows.length > 18000
      || !Array.isArray(data.sources) || !data.sources.length || data.sources.length > 48
      || data.sources.some(s => typeof s !== 'string' || !s || s.length > 256)) throw new Error('Uszkodzony format osobnego eLicznika PV.');
    const calendar = gridCalendar(), seen = new Set(), rows = [];
    for (const r of data.rows) {
      if (!r || !validDate(r.date) || !Number.isInteger(r.hour) || r.hour < 0 || r.hour > 23) throw new Error('Uszkodzona godzina eLicznika PV.');
      const key = r.date + '_' + String(r.hour).padStart(2, '0'), count = calendar(r.date)[r.hour];
      if (!count || r.key !== key || seen.has(key) || r.expectedCount !== count) throw new Error('Powtórzona/niespójna godzina eLicznika PV.');
      seen.add(key);
      if (r.strefa !== null && (typeof r.strefa !== 'string' || !/^T\d{1,3}$/.test(r.strefa))) throw new Error('Nieprawidłowa strefa eLicznika PV.');
      for (const [n, value, flag] of [['importCount', 'poborPoZbil', 'hasImport'], ['exportCount', 'oddaniePoZbil', 'hasExport']]) {
        if (!Number.isInteger(r[n]) || r[n] < 0 || r[n] > count || r[flag] !== (r[n] === count)
          || (r[n] === 0 ? r[value] !== null : !finite(r[value]) || r[value] < 0)) throw new Error('Nieprawidłowy kierunek/kompletność eLicznika PV.');
      }
      if (!r.importCount && !r.exportCount) throw new Error('Pusty rekord eLicznika PV.');
      rows.push({ key, date: r.date, hour: r.hour, strefa: r.strefa, expectedCount: count,
        importCount: r.importCount, exportCount: r.exportCount, hasImport: r.hasImport, hasExport: r.hasExport,
        poborPoZbil: r.poborPoZbil, oddaniePoZbil: r.oddaniePoZbil });
    }
    rows.sort((a, b) => a.key.localeCompare(b.key));
    if (range(rows[0].date, rows.at(-1).date).hours > 732 * 25) throw new Error('Za długi zakres eLicznika PV.');
    return { format: GRID_FORMAT, sources: data.sources.slice(), rows };
  }
  function parseGridCsvFiles(files) {
    if (!Array.isArray(files) || !files.length || files.length > 48) throw new Error('Wybierz 1–48 oryginalnych CSV eLicznika.');
    let bytes = 0;
    const calendar = gridCalendar(), map = new Map(), sources = [];
    for (const file of files) {
      if (!file || typeof file.text !== 'string' || typeof file.name !== 'string' || !file.name || file.name.length > 256) throw new Error('Nieprawidłowy plik eLicznika.');
      bytes += new TextEncoder().encode(file.text).byteLength;
      if (bytes > 16 * 1024 * 1024) throw new Error('CSV eLicznika: limit 16 MB łącznie.');
      const records = csvRows(file.text, ';'), head = (records.shift() || []).map(s => s.trim().toLowerCase());
      if (new Set(head).size !== head.length || !['data', 'strefa', 'wartość', 'rodzaj', 'status'].every(x => head.includes(x)))
        throw new Error('Wymagany oryginalny CSV eLicznika: Data;Strefa;Wartość;Rodzaj;Status (godziny końcowe 1–24).');
      if (!records.length) throw new Error('Pusty CSV eLicznika: ' + file.name);
      sources.push(file.name);
      for (let i = 0; i < records.length; i++) {
        const cells = records[i].map(x => x.trim()), ctx = file.name + ', wiersz ' + (i + 2);
        if (cells.length !== head.length) throw new Error('Liczba kolumn eLicznika: ' + ctx);
        const get = name => cells[head.indexOf(name)];
        const match = /^(20\d{2}-\d{2}-\d{2}) (\d{1,2}):00$/.exec(get('data'));
        if (!match || !validDate(match[1]) || +match[2] < 1 || +match[2] > 24) throw new Error('Wymagana data i końcowa godzina 1–24: ' + ctx);
        const date = match[1], hour = +match[2] - 1, expected = calendar(date)[hour];
        if (!expected) throw new Error('Nieistniejąca godzina Europe/Warsaw: ' + ctx);
        const type = get('rodzaj').toLowerCase().replace(/\s+/g, ' ');
        const direction = type === 'pobrana po zbilansowaniu [kwh]' ? 'import'
          : type === 'oddana po zbilansowaniu [kwh]' ? 'export' : null;
        if (!direction) throw new Error('Nieznany kierunek/jednostka eLicznika: ' + ctx);
        if (get('status').toLowerCase() !== 'licznik') throw new Error('Niepotwierdzony status pomiaru (wymagany „licznik”): ' + ctx);
        const raw = get('wartość');
        if (!/^\d+(?:[.,]\d+)?$/.test(raw) || !finite(Number(raw.replace(',', '.')))) throw new Error('Brak/ujemna/niepoprawna energia eLicznika: ' + ctx);
        const value = Number(raw.replace(',', '.')), zone = get('strefa') || null;
        if (zone !== null && !/^T\d{1,3}$/.test(zone)) throw new Error('Niepoprawna strefa eLicznika: ' + ctx);
        const key = date + '_' + String(hour).padStart(2, '0');
        if (!map.has(key)) map.set(key, { key, date, hour, strefa: zone, expectedCount: expected,
          importCount: 0, exportCount: 0, poborPoZbil: null, oddaniePoZbil: null, hasImport: false, hasExport: false });
        const r = map.get(key);
        if (r.strefa !== zone) throw new Error('Sprzeczne strefy w jednej godzinie: ' + ctx);
        const count = direction + 'Count', energy = direction === 'import' ? 'poborPoZbil' : 'oddaniePoZbil';
        if (r[count] >= expected) throw new Error('Duplikat kierunku/godziny (także między plikami): ' + ctx);
        r[count]++; r[energy] = (r[energy] === null ? 0 : r[energy]) + value;
        r.hasImport = r.importCount === expected; r.hasExport = r.exportCount === expected;
      }
    }
    return validateGridDataset({ format: GRID_FORMAT, sources, rows: Array.from(map.values()) });
  }
  // Wybór źródła dotyczy CAŁEGO rekordu godziny, nigdy osobnych kierunków.
  // Nie dopisujemy flag do legacy; oryginalny CSV pozostaje osobnym dowodem.
  const GRID_POLICY_VERSION = 1;
  function restoreGridSelection(saved) {
    if (!saved) return { gridSource: 'auto', gridPolicyVersion: GRID_POLICY_VERSION, migrated: false };
    const source = saved.gridSource === undefined ? 'shared' : saved.gridSource;
    if (!['auto', 'shared', 'csv'].includes(source)) throw new Error('Nieprawidłowe źródło eLicznika PV.');
    if (saved.gridPolicyVersion === undefined) return { gridSource: 'auto', gridPolicyVersion: GRID_POLICY_VERSION,
      migrated: true, previousSource: source };
    if (saved.gridPolicyVersion !== GRID_POLICY_VERSION) throw new Error('Nieznana wersja wyboru źródeł PV. Nie zastąpiono jej domyślną.');
    return { gridSource: source, gridPolicyVersion: GRID_POLICY_VERSION, migrated: false };
  }
  function gridCounts(startDate, endDate) {
    const span = range(startDate, endDate), counts = new Map();
    for (let t = span.start; t < span.end; t += HOUR) {
      const key = localKey(t); counts.set(key, (counts.get(key) || 0) + 1);
    }
    return { span, counts };
  }
  function gridRowComplete(r, count) {
    return !!r && r.hasImport === true && r.hasExport === true
      && finite(r.poborPoZbil) && r.poborPoZbil >= 0 && finite(r.oddaniePoZbil) && r.oddaniePoZbil >= 0
      && (count === 1 || (r.expectedCount === count && r.importCount === count && r.exportCount === count));
  }
  function inspectGrid(grid, startDate, endDate) {
    const { span, counts } = gridCounts(startDate, endDate);
    const out = { expectedHours: span.hours, expectedBlocks: counts.size, presentBlocks: 0, validBlocks: 0,
      missingRows: 0, missingImportFlags: 0, missingExportFlags: 0, rejectedImportFlags: 0, rejectedExportFlags: 0,
      invalidImportValues: 0, invalidExportValues: 0, unconfirmedDstBlocks: 0 };
    for (const [key, count] of counts) {
      const r = own(grid, key) ? grid[key] : null;
      if (!r || typeof r !== 'object') { out.missingRows++; continue; }
      out.presentBlocks++;
      if (r.hasImport === undefined) out.missingImportFlags++;
      if (r.hasExport === undefined) out.missingExportFlags++;
      if (r.hasImport !== true) out.rejectedImportFlags++;
      if (r.hasExport !== true) out.rejectedExportFlags++;
      if (!finite(r.poborPoZbil) || r.poborPoZbil < 0) out.invalidImportValues++;
      if (!finite(r.oddaniePoZbil) || r.oddaniePoZbil < 0) out.invalidExportValues++;
      if (count > 1 && !(r.expectedCount === count && r.importCount === count && r.exportCount === count)) out.unconfirmedDstBlocks++;
      if (gridRowComplete(r, count)) out.validBlocks++;
    }
    return out;
  }
  function gridView(shared, settings, imported) {
    const legacy = shared && shared.hourlyElicznik || {}, source = settings.gridSource || 'auto';
    if (!['auto', 'shared', 'csv'].includes(source)) throw new Error('Nieprawidłowe źródło eLicznika PV.');
    if (source === 'csv' && !imported) throw new Error('Wybrano osobny CSV eLicznika, ale nie zapisano go jeszcze w karcie PV.');
    // Nawet przy kompletnym legacy nie ukrywamy uszkodzonego zapisu PV.
    const csv = imported ? Object.fromEntries(validateGridDataset(imported).rows.map(r => [r.key, r])) : {};
    const { counts } = gridCounts(settings.startDate, settings.endDate);
    const grid = source === 'shared' ? legacy : source === 'csv' ? csv : Object.create(null);
    const origins = Object.create(null), conflicts = new Set(), conflictDetails = [];
    const selection = { sharedBlocks: 0, csvBlocks: 0, unresolvedBlocks: 0 };
    for (const [key, count] of counts) {
      const a = own(legacy, key) ? legacy[key] : null, b = own(csv, key) ? csv[key] : null;
      if (source !== 'shared' && a && b) {
        const fields = ['poborPoZbil', 'oddaniePoZbil'].filter(k => finite(a[k]) && finite(b[k]) && Math.abs(a[k] - b[k]) > EPS);
        if (a.strefa && b.strefa && a.strefa !== b.strefa) fields.push('strefa');
        if (fields.length) {
          conflicts.add(key);
          conflictDetails.push({ key, fields, shared: { poborPoZbil: a.poborPoZbil, oddaniePoZbil: a.oddaniePoZbil, strefa: a.strefa },
            csv: { poborPoZbil: b.poborPoZbil, oddaniePoZbil: b.oddaniePoZbil, strefa: b.strefa } });
        }
      }
      let origin = source;
      if (source === 'auto') {
        const aOk = gridRowComplete(a, count), bOk = gridRowComplete(b, count);
        // Znana strefa może wybrać cały CSV, ale nie jest doklejana do legacy.
        if (aOk && (a.strefa || !bOk || !b.strefa)) { grid[key] = a; origin = 'shared'; }
        else if (bOk) { grid[key] = b; origin = 'csv'; }
        else { if (a || b) grid[key] = a || b; origin = 'unresolved'; }
      }
      if (!gridRowComplete(grid[key], count)) origin = 'unresolved';
      origins[key] = origin;
      selection[origin === 'shared' ? 'sharedBlocks' : origin === 'csv' ? 'csvBlocks' : 'unresolvedBlocks']++;
    }
    return { grid, origins, conflicts, diagnostics: { source, selection, conflictDetails,
      shared: inspectGrid(legacy, settings.startDate, settings.endDate),
      csv: imported ? inspectGrid(csv, settings.startDate, settings.endDate) : null,
      selected: inspectGrid(grid, settings.startDate, settings.endDate), conflictingBlocks: conflicts.size } };
  }

  function prepare(seriesInput, settings, shared, importedGrid) {
    const span = range(settings.startDate, settings.endDate);
    entityIds(settings);
    const series = mergeSeries([seriesInput]);
    const entities = settings.entities, maps = Object.create(null);
    for (const id of Object.keys(series)) maps[id] = new Map(series[id].map(r => [r.ts, r]));
    const issues = [], issueIndex = new Map();
    const gridInfo = gridView(shared, settings, importedGrid);
    const grid = gridInfo.grid, rce = shared && shared.rceHourly || {}, rates = shared && shared.zoneRates || {};
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
    let residualSum = 0, pvPowerKnownHours = 0, pvPowerApproxKwh = 0, socRangeFlags = 0, powerUnknownUnitHours = 0;
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
        const meanKw = power.powerUnit === 'kW' ? power.mean : power.powerUnit === 'W' ? power.mean / 1000 : null;
        if (meanKw === null) powerUnknownUnitHours++;
        else {
          pvPowerKnownHours++; pvPowerApproxKwh += meanKw;
          if (h.pv === 0 && meanKw > 0.1) issue('stalled_pv', ts, 'pv', 'warning', 'Zerowy przyrost PV mimo mean mocy >0,1 kW. Bez zastępowania licznika mocą.', meanKw);
          if (finite(h.pv) && Math.abs(h.pv - meanKw) > Math.max(0.2, meanKw * 0.2))
            issue('power_disagrees', ts, 'pv', 'warning', 'PV change różni się od przybliżenia mean mocy × 1 h (próg max 0,2 kWh / 20%, jednostka jawna).', h.pv - meanKw);
        }
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
    if (powerUnknownUnitHours) issue('power_unit_unknown', span.start, 'pvPower', 'warning',
      'Nieznana jednostka mocy w historii/cache. Nie porównano jej z kWh i nie odgadnięto jednostki z wielkości liczby. Po aktualizacji pobierz własne dane HA raz; jeśli ostrzeżenie pozostanie, metadane HA wymagają wyjaśnienia, nie kolejnych powtórzeń. Liczniki energii nie zostały zmienione.', powerUnknownUnitHours);
    const rows = [], negativeHouseDetails = [], historical = Object.create(null);
    let dstBlocks = 0, zeroImportPositiveAcBlocks = 0, negativeHouseBlocks = 0;
    for (const [key, hs] of groups) {
      const ts = hs[0].ts, durationHours = hs.length, g = own(grid, key) ? grid[key] : null;
      const gridOk = gridRowComplete(g, durationHours);
      if (!gridOk) issue('grid_missing', ts, 'elicznik', settings.loadMode === 'conditional' ? 'error' : 'warning',
        'Brak pełnych nieujemnych kierunków eLicznika z flagami hasImport/hasExport (dla kroku 2 h także dwóch rekordów każdego kierunku). Stary/niepełny zapis nie oznacza 0.');
      if (gridInfo.conflicts.has(key)) issue('grid_source_conflict', ts, 'elicznik', 'error',
        'Osobny CSV różni się energią/strefą od odczytanej kopii dotychczasowych danych. Nie nadpisano różnicy; wymaga wyjaśnienia przed symulacją.');
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
        const beforeAcChargeKwh = gridOk && finite(output) ? output + g.poborPoZbil - g.oddaniePoZbil : null;
        negativeHouseDetails.push({ key, ts, endTs: ts + durationHours * HOUR, durationHours,
          acOutputKwh: output, gridImportKwh: gridOk ? g.poborPoZbil : null,
          gridExportKwh: gridOk ? g.oddaniePoZbil : null, acChargeKwh: ac,
          beforeAcChargeKwh, houseKwh: load, gridSource: gridInfo.origins[key],
          reason: settings.loadMode !== 'conditional' ? 'meter_negative'
            : finite(beforeAcChargeKwh) && beforeAcChargeKwh < 0 ? 'export_exceeds_supply' : 'charge_exceeds_remainder' });
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
    return { ok: errors.length === 0, physicalValidation: false, rows, hourly, historical, issues, negativeHouseDetails,
      diagnostics: { expectedHours: span.hours, intervalCount: rows.length, dstBlocks, grid: gridInfo.diagnostics, powerUnknownUnitHours,
        residualKnownHours, residualMissingHours: span.hours - residualKnownHours,
        residualSumKwh: residualKnownHours === span.hours ? residualSum : null, residualKnownSumKwh: residualSum,
        negativeResidualHours, residualBelowMinus02Hours, zeroImportPositiveAcBlocks, negativeHouseBlocks,
        pvPowerKnownHours, pvPowerApproxKwh: pvPowerKnownHours === span.hours ? pvPowerApproxKwh : null,
        socRangeFlags, missingBuyPriceBlocks: rows.filter(r => r.buyPlnKwh === null).length,
        missingRcePriceBlocks: rows.filter(r => r.rcePlnMwh === null).length, errorCount: errors.length } };
  }
  return Object.freeze({ parseStatsCsv, mergeSeries, prepare, entityIds, signature, range, midnight, nextDay, localKey,
    parseGridCsvFiles, validateGridDataset, inspectGrid, gridView, restoreGridSelection });
});
