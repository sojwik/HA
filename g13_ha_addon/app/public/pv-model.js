/* Rozbudowa PV — czysty, odizolowany model SCENARIUSZA, nie rekonstrukcja HA.
 * Brak dostępu do DOM, sieci, legacy state i magazynu KV. Jednostki: kWh/kW.
 * Energetyka i ekonomia nie używają historycznych przepływów baterii.
 * Szczegółowe granice torów i ograniczenia: docs/ROZBUDOWA_PV.md. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.G13PvModel = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const EPS = 1e-9;
  const ENERGY_FIELDS = ['pvDcKwh', 'loadAcKwh', 'gridImportKwh', 'gridExportKwh',
    'pvToHouseAcKwh', 'batteryToHouseAcKwh', 'batteryChargeDcKwh', 'batteryDischargeDcKwh',
    'curtailedDcKwh', 'lossKwh'];
  function finite(x) { return typeof x === 'number' && Number.isFinite(x); }
  function fail(text) { throw new Error(text); }
  function requireNumber(obj, key, lo, hi, openLower) {
    const x = obj[key];
    if (!finite(x) || (openLower ? x <= lo : x < lo) || x > hi)
      fail('Parametr ' + key + ': wymagano liczby ' + (openLower ? '>' : '≥') + lo + ' i ≤' + hi + '. Puste pole nie oznacza zera ani braku limitu.');
    return x;
  }
  function validateConfig(c) {
    if (!c || typeof c !== 'object') fail('Brak parametrów scenariusza.');
    if (!['dc_shared', 'ac_added'].includes(c.topology)) fail('Wybierz scenariusz podłączenia (wspólny DC albo dodatkowy AC).');
    requireNumber(c, 'existingKwp', 0, 100000, true);
    requireNumber(c, 'addedKwp', 0, 100000);
    requireNumber(c, 'addedYieldFactor', 0, 10);
    requireNumber(c, 'capacityKwh', 0, 100000, true);
    requireNumber(c, 'minSocPct', 0, 100);
    requireNumber(c, 'maxSocPct', c.minSocPct, 100, true);
    // Nigdy nie podnosimy energii startowej do rezerwy za darmo.
    requireNumber(c, 'initialSocPct', c.minSocPct, c.maxSocPct);
    for (const k of ['chargeDcKw', 'dischargeDcKw']) requireNumber(c, k, 0, 100000);
    for (const k of ['pvToAcEta', 'pvToBatteryEta', 'batteryToAcEta', 'storeChargeEta', 'storeDischargeEta'])
      requireNumber(c, k, 0, 1, true);
    if (c.topology === 'ac_added') requireNumber(c, 'acToBatteryEta', 0, 1, true);
    // Infinity istnieje tylko wewnątrz obliczenia, po JAWNYM wyborze idealizacji.
    if (c.unlimitedInverter !== true) requireNumber(c, 'inverterAcKw', 0, 100000, true);
    if (c.topology === 'ac_added' && c.addedKwp > 0 && c.unlimitedAddedInverter !== true)
      requireNumber(c, 'addedInverterAcKw', 0, 100000, true);
    if (c.unlimitedExport !== true) requireNumber(c, 'exportAcKw', 0, 100000);
    requireNumber(c, 'depositUseFraction', 0, 1);
    requireNumber(c, 'loadScale', 0, 10, true);
    if (c.costPln !== null && c.costPln !== undefined) requireNumber(c, 'costPln', 0, 1e12);
    return true;
  }

  /* Jeden przedział: stałe/średnie moce w kroku; bez odtwarzania kolejności
   * wewnątrz godziny. Limit hybrydy to wspólny budżet AC forward+reverse.
   * Energia E jest energią ZMAGAZYNOWANĄ, moce baterii dotyczą zacisków DC. */
  function step(row, c, before, expanded) {
    const dt = row.durationHours;
    const oldPv = row.pvDcKwh;
    const addedPv = expanded ? oldPv * c.addedKwp / c.existingKwp * c.addedYieldFactor : 0;
    const load = row.loadAcKwh * c.loadScale;
    const floor = c.capacityKwh * c.minSocPct / 100;
    const ceiling = c.capacityKwh * c.maxSocPct / 100;
    const hybridCap = c.unlimitedInverter === true ? Infinity : c.inverterAcKw * dt;
    const exportCap = c.unlimitedExport === true ? Infinity : c.exportAcKw * dt;
    const terminalChargeCap = c.chargeDcKw * dt;
    let e = before;
    let sharedPv = c.topology === 'dc_shared' ? oldPv + addedPv : oldPv;
    const extraAcCap = c.unlimitedAddedInverter === true ? Infinity : (c.addedInverterAcKw || 0) * dt;
    const newAcAvailable = c.topology === 'ac_added' ? Math.min(addedPv * c.pvToAcEta, extraAcCap) : 0;
    // W wariancie AC nowy falownik zasila dom pierwszy: istniejące PV DC
    // może wtedy zasilać baterię bez dodatkowego przejścia AC→DC.
    const newHouse = Math.min(load, newAcAvailable);
    const oldHouse = Math.min(load - newHouse, sharedPv * c.pvToAcEta, hybridCap);
    sharedPv -= oldHouse / c.pvToAcEta;
    let deficit = load - newHouse - oldHouse;
    const dTerminal = Math.min(Math.max(0, e - floor) * c.storeDischargeEta,
      c.dischargeDcKw * dt, deficit / c.batteryToAcEta,
      Math.max(0, hybridCap - oldHouse) / c.batteryToAcEta);
    const dStored = dTerminal / c.storeDischargeEta;
    const dAc = dTerminal * c.batteryToAcEta;
    e -= dStored;
    deficit -= dAc;

    const cFromDc = Math.min(sharedPv * c.pvToBatteryEta, terminalChargeCap,
      Math.max(0, ceiling - e) / c.storeChargeEta);
    const pvForCharge = cFromDc / c.pvToBatteryEta;
    sharedPv -= pvForCharge;
    e += cFromDc * c.storeChargeEta;

    let acForCharge = 0, cFromAc = 0;
    if (c.topology === 'ac_added') {
      acForCharge = Math.min(Math.max(0, newAcAvailable - newHouse),
        Math.max(0, hybridCap - oldHouse - dAc),
        Math.max(0, terminalChargeCap - cFromDc) / c.acToBatteryEta,
        Math.max(0, ceiling - e) / c.storeChargeEta / c.acToBatteryEta);
      cFromAc = acForCharge * c.acToBatteryEta;
      e += cFromAc * c.storeChargeEta;
    }
    const newExport = Math.min(Math.max(0, newAcAvailable - newHouse - acForCharge), exportCap);
    const oldExport = Math.min(Math.max(0, sharedPv) * c.pvToAcEta,
      Math.max(0, hybridCap - oldHouse - dAc - acForCharge), Math.max(0, exportCap - newExport));
    const newUsedDc = c.topology === 'ac_added' ? (newHouse + acForCharge + newExport) / c.pvToAcEta : 0;
    const oldCurtail = Math.max(0, sharedPv - oldExport / c.pvToAcEta);
    const newCurtail = c.topology === 'ac_added' ? Math.max(0, addedPv - newUsedDc) : 0;
    const loss = (oldHouse + oldExport) * (1 / c.pvToAcEta - 1)
      + newUsedDc * (1 - c.pvToAcEta) + pvForCharge - cFromDc + acForCharge - cFromAc
      + (cFromDc + cFromAc) * (1 - c.storeChargeEta) + dStored - dTerminal + dTerminal - dAc;
    const out = {
      ts: row.ts, key: row.key, durationHours: dt,
      pvDcKwh: oldPv + addedPv, addedPvDcKwh: addedPv, loadAcKwh: load,
      gridImportKwh: Math.max(0, deficit), gridExportKwh: newExport + oldExport,
      pvToHouseAcKwh: newHouse + oldHouse, batteryToHouseAcKwh: dAc,
      batteryChargeDcKwh: cFromDc + cFromAc, batteryDischargeDcKwh: dTerminal,
      batteryChargeFromAddedAcKwh: acForCharge, gridToBatteryKwh: 0,
      storedBeforeKwh: before, storedAfterKwh: e, socPct: 100 * e / c.capacityKwh,
      curtailedDcKwh: oldCurtail + newCurtail, lossKwh: loss,
      hybridAcThroughputKwh: oldHouse + oldExport + dAc + acForCharge,
    };
    out.balanceErrorKwh = out.pvDcKwh + out.gridImportKwh + before
      - load - out.gridExportKwh - e - out.curtailedDcKwh - loss;
    if (Math.abs(out.balanceErrorKwh) > 1e-7 || e < floor - EPS || e > ceiling + EPS
      || out.batteryChargeDcKwh > terminalChargeCap + EPS
      || dTerminal > c.dischargeDcKw * dt + EPS || out.hybridAcThroughputKwh > hybridCap + EPS
      || out.gridExportKwh > exportCap + EPS || loss < -EPS
      || (out.batteryChargeDcKwh > EPS && dTerminal > EPS))
      fail('Naruszenie bilansu/ograniczenia modelu przy ' + row.key + '. Wynik został zatrzymany.');
    return out;
  }

  function newValuation() { return { knownPln: 0, missingIntervals: 0, affectedKwh: 0, totalPln: 0 }; }
  function addValuation(v, kwh, price) {
    if (Math.abs(kwh) <= EPS) return; // 0 × nieznana cena nadal daje zerowy przyrost.
    if (!finite(price)) { v.missingIntervals++; v.affectedKwh += Math.abs(kwh); }
    else v.knownPln += kwh * price;
    v.totalPln = v.missingIntervals ? null : v.knownPln;
  }
  function sellPrice(row) {
    if (!finite(row.rcePlnMwh)) return null;
    const factor = row.key.slice(0, 7) >= '2025-02' ? 1.23 : 1;
    return Math.max(0, row.rcePlnMwh) / 1000 * factor;
  }
  function newTotals(initial) {
    const t = { initialStoredKwh: initial, finalStoredKwh: initial,
      purchase: newValuation(), deposit: newValuation(), maxBalanceErrorKwh: 0 };
    for (const f of ENERGY_FIELDS) t[f] = 0;
    return t;
  }
  function addTotals(t, x, r) {
    for (const f of ENERGY_FIELDS) t[f] += x[f];
    t.finalStoredKwh = x.storedAfterKwh;
    t.maxBalanceErrorKwh = Math.max(t.maxBalanceErrorKwh, Math.abs(x.balanceErrorKwh));
    addValuation(t.purchase, x.gridImportKwh, r.buyPlnKwh);
    addValuation(t.deposit, x.gridExportKwh, sellPrice(r));
  }
  function newDelta() {
    return { addedPvDcKwh: 0, avoidedImportKwh: 0, extraExportKwh: 0,
      extraCurtailDcKwh: 0, finalStoredDifferenceKwh: 0,
      avoidedPurchase: newValuation(), extraDeposit: newValuation(), conditionalBenefitPln: null };
  }
  function addDelta(t, a, b, r, c) {
    t.addedPvDcKwh += b.pvDcKwh - a.pvDcKwh;
    t.avoidedImportKwh += a.gridImportKwh - b.gridImportKwh;
    t.extraExportKwh += b.gridExportKwh - a.gridExportKwh;
    t.extraCurtailDcKwh += b.curtailedDcKwh - a.curtailedDcKwh;
    t.finalStoredDifferenceKwh = b.storedAfterKwh - a.storedAfterKwh;
    addValuation(t.avoidedPurchase, a.gridImportKwh - b.gridImportKwh, r.buyPlnKwh);
    addValuation(t.extraDeposit, b.gridExportKwh - a.gridExportKwh, sellPrice(r));
    const buy = t.avoidedPurchase.totalPln, sale = t.extraDeposit.totalPln;
    t.conditionalBenefitPln = buy === null || (c.depositUseFraction !== 0 && sale === null)
      ? null : buy + (c.depositUseFraction === 0 ? 0 : c.depositUseFraction * sale);
  }
  function simulate(rows, config) {
    validateConfig(config);
    if (!Array.isArray(rows) || !rows.length) fail('Brak pełnego ciągłego szeregu wejściowego.');
    const initial = config.capacityKwh * config.initialSocPct / 100;
    let ea = initial, eb = initial, previousEnd = null;
    const a = newTotals(initial), b = newTotals(initial), delta = newDelta();
    const monthly = Object.create(null), intervals = [];
    let hours = 0;
    for (const r of rows) {
      if (!r || !finite(r.ts) || !finite(r.durationHours) || ![1, 2].includes(r.durationHours)
        || !finite(r.pvDcKwh) || r.pvDcKwh < 0 || !finite(r.loadAcKwh) || r.loadAcKwh < 0
        || typeof r.key !== 'string' || !/^\d{4}-\d{2}-\d{2}_\d{2}$/.test(r.key))
        fail('Niepoprawny lub niepełny przedział wejściowy. Braków/ujemnego zapotrzebowania nie zastępujemy zerem.');
      if (r.ts % 3600000 !== 0 || (previousEnd !== null && r.ts !== previousEnd))
        fail('Przerwa, duplikat albo niechronologiczny szereg. Nie przenosimy SOC przez nieznane godziny.');
      previousEnd = r.ts + r.durationHours * 3600000;
      if (r.buyPlnKwh !== null && r.buyPlnKwh !== undefined && (!finite(r.buyPlnKwh) || r.buyPlnKwh < 0)) fail('Nieprawidłowa stawka zakupu.');
      if (r.rcePlnMwh !== null && r.rcePlnMwh !== undefined && !finite(r.rcePlnMwh)) fail('Nieprawidłowa cena RCE.');
      const ra = step(r, config, ea, false), rb = step(r, config, eb, true);
      const mk = r.key.slice(0, 7);
      if (!monthly[mk]) monthly[mk] = { hours: 0, current: newTotals(ea), expanded: newTotals(eb), delta: newDelta() };
      const m = monthly[mk];
      ea = ra.storedAfterKwh; eb = rb.storedAfterKwh;
      addTotals(a, ra, r); addTotals(b, rb, r); addDelta(delta, ra, rb, r, config);
      addTotals(m.current, ra, r); addTotals(m.expanded, rb, r); addDelta(m.delta, ra, rb, r, config);
      m.hours += r.durationHours; hours += r.durationHours;
      intervals.push({ key: r.key, ts: r.ts, durationHours: r.durationHours, current: ra, expanded: rb });
    }
    return { schema: 1, kind: 'scenario_not_validated_reconstruction', physicalValidation: false,
      hours, intervalCount: rows.length, current: a, expanded: b, delta, monthly, intervals,
      assumptions: Object.assign({}, config), annualized: false, terminalEnergyValued: false };
  }
  return Object.freeze({ simulate, validateConfig, sellPrice });
});
