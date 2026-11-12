/* PV-only estimate from available hours. Not a repaired measured history.
 * Additional AC first reduces measured grid purchase (explicit load proxy),
 * only the surplus is exported. No simulated battery/H, cash-refund or writes.
 * Known component sums and a fully-priced annual reference are kept separate. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./pv-data'), require('./pv-export'), require('./pv-model'));
  else root.G13PvAvailable = factory(root.G13PvData, root.G13PvExport, root.G13PvModel);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (D, X, M) {
  'use strict';
  const MODE = 'available_home_export', HOUR = 3600000, EPS = 1e-7;
  const finite = x => typeof x === 'number' && Number.isFinite(x);
  const own = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
  const isAvailable = s => !!s && s.calculationMode === MODE;
  const defaults = Object.freeze({ availableAnnualAcKwhPerKwp: 1000 });
  function exportConfig(s) { return { ...s, calculationMode: 'export_only', depositUseFraction: 1 }; }
  function validate(s) {
    if (!isAvailable(s)) throw new Error('Wybierz tryb „Dostępne godziny + roczny ROI”.');
    D.range(s.startDate, s.endDate); X.entityIds(s); X.validateConfig(exportConfig(s));
    return true;
  }
  function signature(s) {
    D.range(s.startDate, s.endDate);
    return JSON.stringify({ startDate: s.startDate, endDate: s.endDate, calculationMode: MODE,
      entities: X.entityIds(s), pvEntity: s.entities.pv, powerEntity: s.entities.pvPower || '' });
  }
  function profile(series, s) {
    return X.prepare(series, { ...s, calculationMode: 'export_only', gridSource: 'auto', unlimitedExport: true, allowDstAggregation: true }, {});
  }
  function cacheMatch(dataset, s) {
    try {
      X.entityIds(s);
      if (!dataset || typeof dataset.signature !== 'string' || !dataset.series) return null;
      const sig = JSON.parse(dataset.signature);
      if (!sig || !Array.isArray(sig.entities) || sig.entities.some(id => typeof id !== 'string' || !/^[a-z_]+\.[a-z0-9_]+$/.test(id))
        || new Set(sig.entities).size !== sig.entities.length || !sig.entities.includes(s.entities.pv)) return null;
      if ([MODE, 'export_only'].includes(sig.calculationMode)) {
        if (sig.pvEntity !== s.entities.pv) return null;
      } else if (sig.calculationMode !== undefined || !['conditional', 'meter'].includes(sig.loadMode)) return null;
      const saved = D.range(sig.startDate, sig.endDate), wanted = D.range(s.startDate, s.endDate);
      const start = Math.max(saved.start, wanted.start), end = Math.min(saved.end, wanted.end);
      if (end <= start || !Array.isArray(dataset.series[s.entities.pv])) return null;
      const series = Object.create(null);
      for (const id of X.entityIds(s)) if (sig.entities.includes(id) && Array.isArray(dataset.series[id]))
        series[id] = dataset.series[id].filter(r => r.ts >= saved.start - HOUR && r.ts < saved.end);
      const selected = profile(series, s), knownHours = selected.diagnostics.pvKnownHours;
      if (!knownHours) return null;
      return { startDate: sig.startDate, endDate: sig.endDate, overlapHours: (end - start) / HOUR,
        expectedHours: wanted.hours, knownHours, coversWholeRange: saved.start <= wanted.start && saved.end >= wanted.end, series };
    } catch (_) { return null; }
  }
  function pickDataset(s, full, exported, available) {
    const candidates = [];
    for (const [origin, dataset] of [['full', full], ['export', exported], ['available', available]]) {
      const match = cacheMatch(dataset, s);
      if (match) candidates.push({ origin, dataset, match, fetched: Date.parse(dataset.fetchedAt) || 0 });
    }
    // Whole dataset with most usable PV hours, then most recent. Never stitch
    // matching-looking hours from separate histories; short coverage is explicit.
    candidates.sort((a, b) => b.match.knownHours - a.match.knownHours || b.fetched - a.fetched || a.origin.localeCompare(b.origin));
    return candidates[0] || null;
  }
  function parseFetchedCsv(text) {
    // A whole month can be absent before the recorder began. Only a canonical
    // successful header-only CSV is an empty PART, not an invented zero hour.
    // Malformed/HTML responses still fail; validateFetched rejects an empty
    // whole range before the isolated collection can be committed.
    const header = 'statistic_id,start,start_utc,mean,min,max,sum,change';
    const compact = typeof text === 'string' ? text.replace(/^\uFEFF/, '').trim() : '';
    if (compact === header || compact === header + ',power_unit') return Object.create(null);
    return D.parseStatsCsv(text);
  }
  function validateFetched(series, s) {
    const p = profile(series, s);
    if (!p.diagnostics.pvKnownHours) throw new Error('Brak choćby jednej użytecznej godziny PV DC z buforem. Nie aktywowano pustego/spornego zbioru; wcześniejsze zapisy zachowane.');
    return { knownHours: p.diagnostics.pvKnownHours, expectedHours: p.diagnostics.expectedHours };
  }
  function gridView(shared, s, imported) {
    if (s.gridSource === 'csv' && !imported) {
      const g = D.gridView({ hourlyElicznik: {} }, { ...s, gridSource: 'shared' }, null);
      g.warning = 'Wybrany CSV nie jest zapisany. Nie zastąpiono go innym źródłem; brakujące przepływy pomijamy w szacunku.';
      return g;
    }
    return D.gridView(shared, s, imported);
  }
  function convert(pv, s) {
    const addedDc = pv * s.addedKwp / s.existingKwp * s.addedYieldFactor, eta = s.exportPvToAcEta;
    const cap = s.topology === 'dc_shared' ? (s.unlimitedInverter === true ? Infinity : s.inverterAcKw)
      : s.addedKwp === 0 ? 0 : s.unlimitedAddedInverter === true ? Infinity : s.addedInverterAcKw;
    const ac = s.topology === 'dc_shared' ? Math.max(0, Math.min((pv + addedDc) * eta, cap) - Math.min(pv * eta, cap)) : Math.min(addedDc * eta, cap);
    if (!finite(ac) || !finite(addedDc)) throw new Error('Przekroczony zakres produkcji dodatkowego PV.');
    return { addedDcKwh: addedDc, availableAcKwh: ac, inverterLimitedDcKwh: Math.max(0, addedDc - ac / eta) };
  }
  function totals() {
    return { expectedHours: 0, pvKnownHours: 0, flowKnownHours: 0, fullyValuedHours: 0, pricedPositiveHours: 0,
      addedDcKwh: 0, availableAcKwh: 0, inverterLimitedDcKwh: 0,
      avoidedImportKwh: 0, extraExportKwh: 0, curtailedAcKwh: 0, unknownFlowAcKwh: 0,
      knownPurchasePln: 0, knownDepositPln: 0, purchaseUnpricedKwh: 0, exportUnpricedKwh: 0,
      knownBenefitPln: 0, completeBenefitPln: null,
      sampleAcKwh: 0, sampleAvoidedKwh: 0, sampleExportKwh: 0, sampleCurtailedKwh: 0,
      samplePurchasePln: 0, sampleDepositPln: 0, maxFlowBalanceErrorKwh: 0 };
  }
  function accumulate(t, x) {
    t.expectedHours += x.durationHours;
    if (x.pvKnown) t.pvKnownHours += x.durationHours;
    if (x.flowKnown) t.flowKnownHours += x.durationHours;
    if (x.fullyValued) t.fullyValuedHours += x.durationHours;
    if (x.fullyValued && x.availableAcKwh > 0) t.pricedPositiveHours += x.durationHours;
    for (const k of ['addedDcKwh','availableAcKwh','inverterLimitedDcKwh','avoidedImportKwh','extraExportKwh','curtailedAcKwh','unknownFlowAcKwh','purchaseUnpricedKwh','exportUnpricedKwh'])
      if (finite(x[k])) t[k] += x[k];
    if (finite(x.purchasePln)) t.knownPurchasePln += x.purchasePln;
    if (finite(x.depositPln)) t.knownDepositPln += x.depositPln;
    t.knownBenefitPln = t.knownPurchasePln + t.knownDepositPln;
    t.completeBenefitPln = t.fullyValuedHours === t.expectedHours ? t.knownBenefitPln : null;
    if (x.fullyValued) {
      t.sampleAcKwh += x.availableAcKwh; t.sampleAvoidedKwh += x.avoidedImportKwh;
      t.sampleExportKwh += x.extraExportKwh; t.sampleCurtailedKwh += x.curtailedAcKwh;
      t.samplePurchasePln += x.purchasePln; t.sampleDepositPln += x.depositPln;
    }
    if (finite(x.flowBalanceErrorKwh)) t.maxFlowBalanceErrorKwh = Math.max(t.maxFlowBalanceErrorKwh, Math.abs(x.flowBalanceErrorKwh));
    for (const v of Object.values(t)) if (v !== null && !finite(v)) throw new Error('Przekroczony zakres sumowania szacunku.');
  }
  function annualEstimate(t, s) {
    const yieldAc = s.availableAnnualAcKwhPerKwp;
    const yieldKnown = finite(yieldAc) && yieldAc >= 0 && yieldAc <= 10000;
    const energy = yieldKnown ? s.addedKwp * yieldAc : null;
    const cost = finite(s.costPln) && s.costPln > 0 ? s.costPln : null;
    const r = { status: !yieldKnown ? 'yield_missing' : energy === 0 ? 'zero_energy' : t.sampleAcKwh > 0 ? 'estimated' : 'no_priced_sample',
      energyAcKwh: energy, costPln: cost, sampleAcKwh: t.sampleAcKwh, samplePositiveHours: t.pricedPositiveHours,
      avoidedImportKwh: null, exportKwh: null, curtailedAcKwh: null, purchasePln: null, depositPln: null, benefitPln: null,
      purchasePerAcKwh: null, depositPerAcKwh: null, benefitPerAcKwh: null, exportWeightedDepositPlnKwh: null,
      paybackStatus: 'reference_unknown', paybackYears: null, annualSimpleRoiPct: null };
    if (t.sampleAcKwh > 0) {
      r.purchasePerAcKwh = t.samplePurchasePln / t.sampleAcKwh;
      r.depositPerAcKwh = t.sampleDepositPln / t.sampleAcKwh;
      r.benefitPerAcKwh = r.purchasePerAcKwh + r.depositPerAcKwh;
      r.exportWeightedDepositPlnKwh = t.sampleExportKwh > 0 ? t.sampleDepositPln / t.sampleExportKwh : null;
    }
    if (r.status === 'zero_energy') {
      r.avoidedImportKwh = r.exportKwh = r.curtailedAcKwh = r.purchasePln = r.depositPln = r.benefitPln = 0;
    } else if (r.status === 'estimated') {
      r.avoidedImportKwh = energy * t.sampleAvoidedKwh / t.sampleAcKwh;
      r.exportKwh = energy * t.sampleExportKwh / t.sampleAcKwh;
      r.curtailedAcKwh = energy * t.sampleCurtailedKwh / t.sampleAcKwh;
      r.purchasePln = energy * r.purchasePerAcKwh; r.depositPln = energy * r.depositPerAcKwh;
      r.benefitPln = r.purchasePln + r.depositPln;
    }
    if (finite(r.benefitPln)) {
      r.paybackStatus = cost === null ? 'cost_unknown' : r.benefitPln === 0 ? 'no_return' : 'finite';
      r.paybackYears = r.paybackStatus === 'finite' ? cost / r.benefitPln : null;
      r.annualSimpleRoiPct = cost === null ? null : r.benefitPln / cost * 100;
    }
    for (const v of Object.values(r)) if (typeof v === 'number' && !finite(v)) throw new Error('Przekroczony zakres rocznego ROI.');
    return r;
  }
  function estimate(series, s, shared = {}, imported = null) {
    validate(s);
    const p = profile(series || {}, s), gridInfo = gridView(shared, s, imported), rates = shared.zoneRates || {}, rce = shared.rceHourly || {};
    const total = totals(), monthly = Object.create(null), rows = [], reasons = Object.create(null);
    const pvErrors = new Map();
    for (const i of p.issues) if (i.channel === 'pv' && i.severity === 'error') pvErrors.set(i.ts, i.code);
    for (const row of p.rows) {
      const x = { ts: row.ts, key: row.key, durationHours: row.durationHours, pvKnown: finite(row.pvDcKwh),
        flowKnown: false, fullyValued: false, addedDcKwh: null, availableAcKwh: null, inverterLimitedDcKwh: null,
        avoidedImportKwh: null, extraExportKwh: null, curtailedAcKwh: null, unknownFlowAcKwh: 0,
        purchasePln: null, depositPln: null, purchaseUnpricedKwh: 0, exportUnpricedKwh: 0,
        importReferenceKwh: null, exportReferenceKwh: null, buyPlnKwh: null, depositPlnKwh: null, flowBalanceErrorKwh: null, reasons: [] };
      const reason = code => { if (!x.reasons.includes(code)) { x.reasons.push(code); reasons[code] = (reasons[code] || 0) + row.durationHours; } };
      if (!x.pvKnown) reason(pvErrors.get(row.ts) || 'pv_unusable');
      else if (row.durationHours !== 1) reason('dst_ambiguous'); // never assign a single price/flow to both folds
      else {
        Object.assign(x, convert(row.pvDcKwh, s));
        const ac = x.availableAcKwh, g = own(gridInfo.grid, row.key) ? gridInfo.grid[row.key] : null;
        if (ac === 0) {
          x.avoidedImportKwh = x.extraExportKwh = x.curtailedAcKwh = x.purchasePln = x.depositPln = x.flowBalanceErrorKwh = 0;
          x.flowKnown = x.fullyValued = true; // no additional energy needs a price, without inventing measured grid values
        } else if (gridInfo.conflicts.has(row.key)) { reason('grid_conflict'); x.unknownFlowAcKwh = ac; }
        else if (!g || g.hasImport !== true || !finite(g.poborPoZbil) || g.poborPoZbil < 0) { reason('grid_import_missing'); x.unknownFlowAcKwh = ac; }
        else {
          x.importReferenceKwh = g.poborPoZbil;
          x.avoidedImportKwh = Math.min(ac, g.poborPoZbil);
          const surplus = ac - x.avoidedImportKwh;
          x.buyPlnKwh = own(rates, g.strefa) && finite(rates[g.strefa]) && rates[g.strefa] >= 0 ? rates[g.strefa] : null;
          if (x.avoidedImportKwh === 0) x.purchasePln = 0;
          else if (x.buyPlnKwh !== null) x.purchasePln = x.avoidedImportKwh * x.buyPlnKwh;
          else { x.purchaseUnpricedKwh = x.avoidedImportKwh; reason('buy_price_missing'); }
          const exportKnown = g.hasExport === true && finite(g.oddaniePoZbil) && g.oddaniePoZbil >= 0;
          x.exportReferenceKwh = exportKnown ? g.oddaniePoZbil : null;
          if (surplus === 0 || s.unlimitedExport === true || exportKnown) {
            const headroom = s.unlimitedExport === true ? Infinity : exportKnown ? Math.max(0, s.exportAcKw - g.oddaniePoZbil) : 0;
            x.extraExportKwh = Math.min(surplus, headroom);
            x.curtailedAcKwh = surplus - x.extraExportKwh; x.flowKnown = true;
            x.flowBalanceErrorKwh = ac - x.avoidedImportKwh - x.extraExportKwh - x.curtailedAcKwh;
            if (Math.abs(x.flowBalanceErrorKwh) > EPS) throw new Error('Naruszenie rozdziału dodatkowej energii przy ' + row.key);
            x.depositPlnKwh = M.sellPrice({ key: row.key, rcePlnMwh: own(rce, row.key) && finite(rce[row.key]) ? rce[row.key] : null });
            if (x.extraExportKwh === 0) x.depositPln = 0;
            else if (x.depositPlnKwh !== null) x.depositPln = x.extraExportKwh * x.depositPlnKwh;
            else { x.exportUnpricedKwh = x.extraExportKwh; reason('rce_missing'); }
          } else { reason('grid_export_missing'); x.unknownFlowAcKwh = surplus; }
          x.fullyValued = x.flowKnown && finite(x.purchasePln) && finite(x.depositPln);
        }
      }
      accumulate(total, x); const mk = row.key.slice(0, 7);
      if (!monthly[mk]) monthly[mk] = totals(); accumulate(monthly[mk], x); rows.push(x);
    }
    const assumptions = { calculationMode: MODE, startDate: s.startDate, endDate: s.endDate, existingKwp: s.existingKwp, addedKwp: s.addedKwp,
      addedYieldFactor: s.addedYieldFactor, exportPvToAcEta: s.exportPvToAcEta, topology: s.topology,
      inverterAcKw: s.inverterAcKw, addedInverterAcKw: s.addedInverterAcKw, exportAcKw: s.exportAcKw,
      unlimitedInverter: s.unlimitedInverter === true, unlimitedAddedInverter: s.unlimitedAddedInverter === true, unlimitedExport: s.unlimitedExport === true,
      availableAnnualAcKwhPerKwp: finite(s.availableAnnualAcKwhPerKwp) ? s.availableAnnualAcKwhPerKwp : null,
      costPln: finite(s.costPln) ? s.costPln : null, financialDepositUseFraction: 1, cashRefundModeled: false };
    return { kind: 'available_pv_home_export', schema: 1, physicalValidation: false, batteryModeled: false, houseIndependentlyMeasured: false,
      annualizationOfPeriodEnergy: false, noMissingHoursFabricated: true, annualPricesAndSharesMayBeBiased: true,
      purchaseRateSource: 'current_saved_zone_rates_not_dated_history', depositRuleSource: 'unchanged_pv_sellPrice',
      total, monthly, rows, reasons, annual: annualEstimate(total, s), assumptions,
      profileDiagnostics: p.diagnostics, profileWarnings: p.issues.filter(i => i.severity === 'warning' && ['pv','pvPower'].includes(i.channel)),
      gridDiagnostics: gridInfo.diagnostics, gridWarning: gridInfo.warning || '' };
  }
  return Object.freeze({ mode: MODE, defaults, isAvailable, validate, signature, entityIds: X.entityIds, cacheMatch, pickDataset, parseFetchedCsv, validateFetched, gridView, estimate });
});
