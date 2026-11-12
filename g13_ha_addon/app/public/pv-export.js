/* PV-only: produkcja dodatkowych paneli WYCENIONA JAKO EKSPORT.
 * Nie rekonstruuje domu/baterii ani nie usuwa ich z rzeczywistej instalacji.
 * Bez DOM, KV, sieci, sterowania urządzeniami i modyfikacji wejść.
 * Stary silnik / H pozostaje oddzielny. RCE: niezmieniona funkcja starej karty PV. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./pv-data'), require('./pv-model'));
  else root.G13PvExport = factory(root.G13PvData, root.G13PvModel);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (D, M) {
  'use strict';
  const HOUR = 3600000, EPS = 1e-7;
  const finite = x => typeof x === 'number' && Number.isFinite(x);
  const own = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
  const entityPattern = /^[a-z_]+\.[a-z0-9_]+$/;
  function fail(text) { throw new Error(text); }
  function mode(s) {
    const v = s && s.calculationMode;
    if (v === undefined) return 'dynamic_battery'; // zapis <=0.3.7 zachowuje znaczenie
    if (!['dynamic_battery', 'export_only'].includes(v)) fail('Nieznany tryb obliczeń PV. Nie zastąpiono go domyślnym.');
    return v;
  }
  function entityIds(s) {
    const e = s && s.entities || {};
    if (!e.pv) fail('Brak encji dla kanału: pv (licznik PV DC).');
    const ids = [e.pv, e.pvPower].filter(Boolean);
    if (ids.some(id => typeof id !== 'string' || !entityPattern.test(id))) fail('Nieprawidłowy identyfikator encji PV DC / mocy.');
    if (ids.length !== new Set(ids).size) fail('PV DC i diagnostyczna moc nie mogą wskazywać tej samej encji.');
    return ids.sort();
  }
  function signature(s) {
    D.range(s.startDate, s.endDate);
    return JSON.stringify({ startDate: s.startDate, endDate: s.endDate, entities: entityIds(s),
      calculationMode: 'export_only', pvEntity: s.entities.pv, powerEntity: s.entities.pvPower || '' });
  }
  function cacheMatch(dataset, s) {
    try {
      entityIds(s);
      if (!dataset || typeof dataset.signature !== 'string' || !dataset.series) return null;
      const sig = JSON.parse(dataset.signature);
      if (!sig || !Array.isArray(sig.entities) || sig.entities.some(id => typeof id !== 'string' || !entityPattern.test(id))
        || new Set(sig.entities).size !== sig.entities.length) return null;
      if (sig.calculationMode === 'export_only') {
        if (sig.pvEntity !== s.entities.pv || !sig.entities.includes(sig.pvEntity)) return null;
      } else if (sig.calculationMode !== undefined || !['conditional', 'meter'].includes(sig.loadMode)) return null;
      const saved = D.range(sig.startDate, sig.endDate), wanted = D.range(s.startDate, s.endDate);
      if (saved.start > wanted.start || saved.end < wanted.end || !sig.entities.includes(s.entities.pv)
        || !Array.isArray(dataset.series[s.entities.pv]) || !dataset.series[s.entities.pv].length) return null;
      // Zgodność zakresu/encjj to jedynie możliwość użycia. prepare nadal
      // sprawdzi KAŻDĄ godzinę i bufor; metadane nie tworzą kompletności.
      return { subset: saved.start !== wanted.start || saved.end !== wanted.end,
        originalStartDate: sig.startDate, originalEndDate: sig.endDate,
        includesPower: !!s.entities.pvPower && sig.entities.includes(s.entities.pvPower)
          && Array.isArray(dataset.series[s.entities.pvPower]) };
    } catch (_) { return null; }
  }
  function pickDataset(s, fullDataset, exportDataset) {
    const candidates = [];
    for (const [origin, dataset] of [['full', fullDataset], ['export', exportDataset]]) {
      const match = cacheMatch(dataset, s);
      if (match) candidates.push({ dataset, match, origin, fetched: Date.parse(dataset.fetchedAt) || 0 });
    }
    // Cały najnowszy pasujący zapis, bez sklejania godzin/ukrytego nadpisania.
    candidates.sort((a, b) => b.fetched - a.fetched || (a.origin === 'export' ? -1 : 1));
    return candidates[0] || null;
  }
  function calendar(startDate, endDate) {
    const span = D.range(startDate, endDate), counts = new Map();
    for (let ts = span.start; ts < span.end; ts += HOUR) {
      const key = D.localKey(ts); counts.set(key, (counts.get(key) || 0) + 1);
    }
    return { span, counts };
  }
  function completeExport(r, count) {
    return !!r && r.hasExport === true && finite(r.oddaniePoZbil) && r.oddaniePoZbil >= 0
      && (count === 1 || (r.expectedCount === count && r.exportCount === count));
  }
  function inspectGrid(grid, startDate, endDate) {
    const { span, counts } = calendar(startDate, endDate);
    const q = { direction: 'export_only', expectedHours: span.hours, expectedBlocks: counts.size, presentBlocks: 0,
      validBlocks: 0, missingRows: 0, missingExportFlags: 0, rejectedExportFlags: 0, invalidExportValues: 0, unconfirmedDstBlocks: 0 };
    for (const [key, count] of counts) {
      const r = own(grid, key) ? grid[key] : null;
      if (!r || typeof r !== 'object') { q.missingRows++; continue; }
      q.presentBlocks++;
      if (r.hasExport === undefined) q.missingExportFlags++;
      if (r.hasExport !== true) q.rejectedExportFlags++;
      if (!finite(r.oddaniePoZbil) || r.oddaniePoZbil < 0) q.invalidExportValues++;
      if (count > 1 && !(r.expectedCount === count && r.exportCount === count)) q.unconfirmedDstBlocks++;
      if (completeExport(r, count)) q.validBlocks++;
    }
    return q;
  }
  function gridView(shared, s, imported) {
    const legacy = shared && shared.hourlyElicznik || {}, source = s.gridSource || 'auto';
    if (!['auto', 'shared', 'csv'].includes(source)) fail('Nieprawidłowe źródło eLicznika PV.');
    if (source === 'csv' && !imported) fail('Wybrano osobny CSV eLicznika, ale nie zapisano go jeszcze w karcie PV.');
    const csv = imported ? Object.fromEntries(D.validateGridDataset(imported).rows.map(r => [r.key, r])) : {};
    const { counts } = calendar(s.startDate, s.endDate), grid = source === 'shared' ? legacy : source === 'csv' ? csv : Object.create(null);
    const origins = Object.create(null), conflicts = new Set(), conflictDetails = [];
    const selection = { sharedBlocks: 0, csvBlocks: 0, unresolvedBlocks: 0 };
    for (const [key, count] of counts) {
      const a = own(legacy, key) ? legacy[key] : null, b = own(csv, key) ? csv[key] : null;
      // Taryfa/import nie należą do wyceny przyrostu eksportu. Różnicy
      // eksportu nie ukrywamy nawet wtedy, gdy starszy rekord nie ma flag.
      if (source !== 'shared' && a && b && finite(a.oddaniePoZbil) && finite(b.oddaniePoZbil)
        && Math.abs(a.oddaniePoZbil - b.oddaniePoZbil) > EPS) {
        conflicts.add(key); conflictDetails.push({ key, shared: { oddaniePoZbil: a.oddaniePoZbil }, csv: { oddaniePoZbil: b.oddaniePoZbil } });
      }
      let origin = source;
      if (source === 'auto') {
        if (completeExport(a, count)) { grid[key] = a; origin = 'shared'; }
        else if (completeExport(b, count)) { grid[key] = b; origin = 'csv'; }
        else { if (a || b) grid[key] = a || b; origin = 'unresolved'; }
      }
      if (!completeExport(grid[key], count)) origin = 'unresolved';
      origins[key] = origin;
      selection[origin === 'shared' ? 'sharedBlocks' : origin === 'csv' ? 'csvBlocks' : 'unresolvedBlocks']++;
    }
    return { grid, origins, conflicts, diagnostics: { direction: 'export_only', source, selection, conflictDetails,
      shared: inspectGrid(legacy, s.startDate, s.endDate), csv: imported ? inspectGrid(csv, s.startDate, s.endDate) : null,
      selected: inspectGrid(grid, s.startDate, s.endDate), conflictingBlocks: conflicts.size } };
  }
  function sum(values) { return values.every(finite) ? values.reduce((a, b) => a + b, 0) : null; }
  function newAmount() { return { knownKwh: 0, missingBlocks: 0, totalKwh: 0 }; }
  function addAmount(cell, value) {
    if (finite(value)) cell.knownKwh += value; else cell.missingBlocks++;
    cell.totalKwh = cell.missingBlocks ? null : cell.knownKwh;
  }
  function prepare(seriesInput, s, shared, importedGrid) {
    const span = D.range(s.startDate, s.endDate), ids = entityIds(s), selected = Object.create(null);
    for (const id of ids) if (own(seriesInput, id)) selected[id] = seriesInput[id];
    const series = D.mergeSeries([selected]), maps = Object.create(null);
    for (const id of ids) maps[id] = new Map((series[id] || []).map(r => [r.ts, r]));
    const pvMap = maps[s.entities.pv], powerMap = s.entities.pvPower && maps[s.entities.pvPower];
    const gridInfo = gridView(shared, s, importedGrid), rce = shared && shared.rceHourly || {};
    const issues = [], hourly = [], groups = new Map();
    let pvKnownHours = 0, pvKnownSumKwh = 0, powerKnownHours = 0, powerUnknownUnitHours = 0, powerMissingHours = 0, powerApproxKwh = 0;
    const issue = (code, ts, channel, severity, message, value = null) => issues.push({ code, ts, key: D.localKey(ts), channel, severity, message, value });
    for (let ts = span.start; ts < span.end; ts += HOUR) {
      const key = D.localKey(ts), row = pvMap.get(ts), prev = pvMap.get(ts - HOUR);
      let pv = null;
      if (!row || !finite(row.change)) issue('missing_energy', ts, 'pv', 'error', 'Brak przyrostu PV DC change; bez zastępowania zerem lub mocą.');
      else if (row.change < 0) issue('negative_energy', ts, 'pv', 'error', 'Ujemny przyrost PV DC; bez obcinania ani wykluczania godziny.', row.change);
      else if (!prev) issue('after_gap', ts, 'pv', 'error', 'Brak poprzedniej godziny/bufora PV; nie przypisujemy energii po luce ostatniej godzinie.');
      else if (finite(row.sum) && finite(prev.sum) && Math.abs(row.change - (row.sum - prev.sum)) > EPS)
        issue('sum_disagrees', ts, 'pv', 'error', 'PV change różni się od Δsum; możliwy reset lub rozbieżność granic.', row.change);
      else { pv = row.change; pvKnownHours++; pvKnownSumKwh += pv; }
      const power = powerMap && powerMap.get(ts);
      if (!power || !finite(power.mean) || power.mean < 0) powerMissingHours++;
      else {
        const kw = power.powerUnit === 'kW' ? power.mean : power.powerUnit === 'W' ? power.mean / 1000 : null;
        if (kw === null) powerUnknownUnitHours++;
        else {
          powerKnownHours++; powerApproxKwh += kw;
          if (pv === 0 && kw > 0.1) issue('stalled_pv', ts, 'pv', 'warning', 'PV DC: zerowy przyrost mimo mean mocy >0,1 kW. Możliwe opóźnienie licznika; bez zastępowania danych.', kw);
          if (finite(pv) && Math.abs(pv - kw) > Math.max(0.2, kw * 0.2)) issue('power_disagrees', ts, 'pv', 'warning',
            'PV change różni się od przybliżenia mean mocy × 1 h. Może to wpływać na godzinową wycenę RCE; nie przesunięto energii.', pv - kw);
        }
      }
      const h = { ts, key, pv }; hourly.push(h);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(h);
    }
    if (powerUnknownUnitHours) issue('power_unit_unknown', span.start, 'pvPower', 'warning',
      'Nieznana jednostka mocy: brak porównania z kWh. Nie odgadujemy W/kW i nie zmieniamy licznika PV DC.', powerUnknownUnitHours);
    if (powerMissingHours) issue('power_history_missing', span.start, 'pvPower', 'warning',
      'Brak opcjonalnej diagnostyki mocy dla części godzin. Liczymy z PV DC change, nie z mocy; brak kontroli nie potwierdza jakości profilu.', powerMissingHours);
    const rows = [], historical = Object.create(null);
    let dstBlocks = 0;
    for (const [key, hs] of groups) {
      const ts = hs[0].ts, durationHours = hs.length, g = own(gridInfo.grid, key) ? gridInfo.grid[key] : null;
      const gridOk = completeExport(g, durationHours);
      if (!gridOk) issue('grid_export_missing', ts, 'elicznik', s.unlimitedExport === true ? 'warning' : 'error',
        s.unlimitedExport === true ? 'Brak potwierdzonego eksportu historycznego. Tylko jawny wariant bez limitu pozwala wycenić przyrost bez tego punktu odniesienia; nie użyto zera.'
          : 'Brak potwierdzonego eksportu eLicznika do ustalenia wolnego miejsca w limicie. Dla kroku 2 h potrzebne oba rekordy eksportu. Import nie jest wymagany.');
      if (gridInfo.conflicts.has(key)) issue('grid_source_conflict', ts, 'elicznik', 'error', 'Sprzeczny eksport w danych dodatku i CSV PV; nie wybrano wygodniejszej wartości.');
      if (durationHours !== 1) {
        dstBlocks++;
        issue('dst_aggregate', ts, 'time', s.allowDstAggregation === true ? 'warning' : 'error',
          'Obie godziny UTC powtórzonej godziny zachowano jako krok 2 h o średnich mocach. Wymaga zgody; nie znamy rozdziału eLicznika/RCE na foldy.');
      }
      const pv = sum(hs.map(h => h.pv));
      const row = { ts, key, durationHours, pvDcKwh: pv, gridMeasuredExportKwh: gridOk ? g.oddaniePoZbil : null,
        gridSource: gridInfo.origins[key], rcePlnMwh: durationHours === 1 && own(rce, key) && finite(rce[key]) ? rce[key] : null };
      rows.push(row);
      const mk = key.slice(0, 7);
      if (!historical[mk]) historical[mk] = { hours: 0, values: { pvDcKwh: newAmount(), gridExportKwh: newAmount() } };
      const m = historical[mk]; m.hours += durationHours;
      addAmount(m.values.pvDcKwh, pv); addAmount(m.values.gridExportKwh, row.gridMeasuredExportKwh);
    }
    const errorCount = issues.filter(i => i.severity === 'error').length;
    return { kind: 'export_only_inputs', ok: errorCount === 0, physicalValidation: false, rows, hourly, historical, issues,
      diagnostics: { expectedHours: span.hours, intervalCount: rows.length, dstBlocks, errorCount,
        grid: gridInfo.diagnostics, pvKnownHours, pvKnownSumKwh, pvDcKwh: pvKnownHours === span.hours ? pvKnownSumKwh : null,
        pvPowerKnownHours: powerKnownHours, powerUnknownUnitHours, powerMissingHours,
        pvPowerApproxKwh: powerKnownHours === span.hours ? powerApproxKwh : null,
        missingRcePriceBlocks: rows.filter(r => r.rcePlnMwh === null).length,
        unusedChannels: ['house', 'acOutput', 'acCharge', 'bmsCharge', 'bmsDischarge', 'soc', 'gridImport', 'G13'] } };
  }
  function requireNumber(c, key, low, high, openLower = false) {
    const v = c[key];
    if (!finite(v) || (openLower ? v <= low : v < low) || v > high)
      fail('Parametr ' + key + ': wymagano liczby ' + (openLower ? '>' : '≥') + low + ' i ≤' + high + '. Puste pole nie oznacza zera ani braku limitu.');
    return v;
  }
  function validateConfig(c) {
    if (!c || mode(c) !== 'export_only') fail('Wybierz tryb „Dodatkowe PV → eksport”.');
    if (!['dc_shared', 'ac_added'].includes(c.topology)) fail('Wybierz scenariusz podłączenia: wspólny DC albo dodatkowy falownik AC.');
    requireNumber(c, 'existingKwp', 0, 100000, true);
    requireNumber(c, 'addedKwp', 0, 100000);
    requireNumber(c, 'addedYieldFactor', 0, 10);
    requireNumber(c, 'exportPvToAcEta', 0, 1, true);
    if (c.topology === 'dc_shared' && c.unlimitedInverter !== true) requireNumber(c, 'inverterAcKw', 0, 100000, true);
    if (c.topology === 'ac_added' && c.addedKwp > 0 && c.unlimitedAddedInverter !== true) requireNumber(c, 'addedInverterAcKw', 0, 100000, true);
    if (c.unlimitedExport !== true) requireNumber(c, 'exportAcKw', 0, 100000);
    requireNumber(c, 'depositUseFraction', 0, 1);
    if (c.costPln !== null && c.costPln !== undefined) requireNumber(c, 'costPln', 0, 1e12);
    return true;
  }
  const ENERGY = ['referencePvDcKwh', 'addedPvDcKwh', 'additionalAcAfterInverterKwh', 'extraExportKwh',
    'inverterLimitedDcKwh', 'exportLimitedDcKwh', 'conversionLossKwh'];
  function newValuation() { return { knownPln: 0, missingIntervals: 0, affectedKwh: 0, totalPln: 0 }; }
  function addValuation(v, energy, price) {
    if (energy === 0) return;
    if (!finite(price)) { v.missingIntervals++; v.affectedKwh += energy; }
    else v.knownPln += energy * price;
    v.totalPln = v.missingIntervals ? null : v.knownPln;
  }
  function totals() {
    return Object.assign(Object.fromEntries(ENERGY.map(k => [k, 0])), { hours: 0, intervalCount: 0, historicalExport: newAmount(),
      historicalPlusScenarioExportKwh: null, extraDeposit: newValuation(), conditionalBenefitPln: null,
      maxBalanceErrorKwh: 0, historicalExportAboveLimitIntervals: 0 });
  }
  function add(t, x, row, c) {
    for (const k of ENERGY) t[k] += x[k];
    t.hours += row.durationHours; t.intervalCount++;
    addAmount(t.historicalExport, row.gridMeasuredExportKwh);
    t.historicalPlusScenarioExportKwh = t.historicalExport.totalKwh === null ? null : t.historicalExport.totalKwh + t.extraExportKwh;
    addValuation(t.extraDeposit, x.extraExportKwh, M.sellPrice(row));
    t.conditionalBenefitPln = c.depositUseFraction === 0 ? 0
      : t.extraDeposit.totalPln === null ? null : t.extraDeposit.totalPln * c.depositUseFraction;
    t.maxBalanceErrorKwh = Math.max(t.maxBalanceErrorKwh, Math.abs(x.balanceErrorKwh));
    if (x.historicalExportAboveLimit) t.historicalExportAboveLimitIntervals++;
    if (ENERGY.some(k => !finite(t[k])) || !finite(t.extraDeposit.knownPln)) fail('Przekroczony zakres liczbowy obliczenia eksportu.');
  }
  function simulate(rows, c) {
    validateConfig(c);
    if (!Array.isArray(rows) || !rows.length) fail('Brak pełnego ciągłego szeregu PV DC.');
    let previousEnd = null;
    const total = totals(), monthly = Object.create(null), intervals = [], issues = [];
    const eta = c.exportPvToAcEta;
    for (const row of rows) {
      if (!row || !finite(row.ts) || row.ts % HOUR !== 0 || ![1, 2].includes(row.durationHours)
        || !finite(row.pvDcKwh) || row.pvDcKwh < 0 || typeof row.key !== 'string' || row.key !== D.localKey(row.ts))
        fail('Niepoprawny przedział PV DC: bez pomijania godzin, zerowania braków lub ujemnej energii.');
      if (previousEnd !== null && row.ts !== previousEnd) fail('Przerwa, duplikat albo niechronologiczny szereg PV DC.');
      if (row.durationHours === 2 && (c.allowDstAggregation !== true || D.localKey(row.ts + HOUR) !== row.key))
        fail('Krok 2 h tylko dla powtórzonej godziny Europe/Warsaw po jawnej zgodzie.');
      if (row.durationHours === 2 && row.rcePlnMwh != null) fail('Nie przypisujemy jednej ceny RCE do nierozróżnialnych dwóch godzin.');
      previousEnd = row.ts + row.durationHours * HOUR;
      if (row.rcePlnMwh != null && !finite(row.rcePlnMwh)) fail('Nieprawidłowa cena RCE.');
      const measured = row.gridMeasuredExportKwh;
      if (measured != null && (!finite(measured) || measured < 0)) fail('Nieprawidłowy historyczny eksport; nie obcinamy go do zera.');
      if (c.unlimitedExport !== true && !finite(measured)) fail('Brak potwierdzonego eksportu do kontroli wspólnego limitu.');
      const added = row.pvDcKwh * c.addedKwp / c.existingKwp * c.addedYieldFactor;
      let available;
      if (c.topology === 'dc_shared') {
        const cap = c.unlimitedInverter === true ? Infinity : c.inverterAcKw * row.durationHours;
        const before = Math.min(row.pvDcKwh * eta, cap);
        const after = Math.min((row.pvDcKwh + added) * eta, cap);
        available = Math.max(0, after - before);
      } else {
        const cap = c.addedKwp === 0 ? 0 : c.unlimitedAddedInverter === true ? Infinity : c.addedInverterAcKw * row.durationHours;
        available = Math.min(added * eta, cap);
      }
      const exportCap = c.unlimitedExport === true ? Infinity : c.exportAcKw * row.durationHours;
      const headroom = c.unlimitedExport === true ? Infinity : Math.max(0, exportCap - measured);
      const extraExport = Math.min(available, headroom);
      const x = { ts: row.ts, key: row.key, durationHours: row.durationHours, referencePvDcKwh: row.pvDcKwh,
        addedPvDcKwh: added, additionalAcAfterInverterKwh: available, extraExportKwh: extraExport,
        inverterLimitedDcKwh: Math.max(0, added - available / eta),
        exportLimitedDcKwh: Math.max(0, (available - extraExport) / eta),
        conversionLossKwh: extraExport * (1 / eta - 1),
        historicalExportKwh: finite(measured) ? measured : null,
        exportHeadroomKwh: finite(headroom) ? headroom : null, exportHeadroomUnlimited: c.unlimitedExport === true,
        historicalExportAboveLimit: finite(measured) && measured > exportCap + EPS };
      x.balanceErrorKwh = added - extraExport - x.conversionLossKwh - x.inverterLimitedDcKwh - x.exportLimitedDcKwh;
      if (ENERGY.some(k => !finite(x[k]) || x[k] < -EPS) || !finite(x.balanceErrorKwh) || Math.abs(x.balanceErrorKwh) > EPS
        || extraExport > available + EPS || (finite(headroom) && extraExport > headroom + EPS))
        fail('Naruszenie rachunku energii/ograniczeń scenariusza eksportu przy ' + row.key + '.');
      if (x.historicalExportAboveLimit) issues.push({ code: 'historical_export_above_limit', key: row.key, ts: row.ts,
        message: 'Historyczny eksport przekracza przyjęty limit. Brak miejsca na przyrost; nie obcięto historii. To niespójność założenia, nie potwierdzenie limitu sprzętu.',
        historicalKwh: measured, assumedLimitKwh: exportCap });
      add(total, x, row, c);
      const mk = row.key.slice(0, 7); if (!monthly[mk]) monthly[mk] = totals();
      add(monthly[mk], x, row, c); intervals.push(x);
    }
    const keys = ['calculationMode', 'topology', 'existingKwp', 'addedKwp', 'addedYieldFactor', 'exportPvToAcEta',
      'inverterAcKw', 'addedInverterAcKw', 'exportAcKw', 'unlimitedInverter', 'unlimitedAddedInverter', 'unlimitedExport',
      'allowDstAggregation', 'depositUseFraction', 'costPln'];
    return { schema: 1, kind: 'incremental_pv_export_valuation', physicalValidation: false,
      batteryModeled: false, houseModeled: false, avoidedPurchaseModeled: false, annualized: false,
      hours: total.hours, intervalCount: rows.length, total, monthly, intervals, issues,
      assumptions: Object.fromEntries(keys.map(k => [k, c[k]])), entireAvailableIncrementAssumedExported: true };
  }
  return Object.freeze({ mode, entityIds, signature, cacheMatch, pickDataset, gridView, inspectGrid, prepare, validateConfig, simulate });
});
