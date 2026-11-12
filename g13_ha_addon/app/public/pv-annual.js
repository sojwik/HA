/* PV-only, roczny SZACUNEK z jawnych założeń. Brak historii/HA/DOM/KV.
 * Uzysk AC zawiera straty/ograniczenia: bez drugiego eta. Cena jest gotowym
 * przypisem depozytu/kWh: bez ponownego mnożnika RCE 1,23.
 * Nie odtwarzamy brakujących pomiarów ani nie annualizujemy krótkiego okresu. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.G13PvAnnual = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const MODE = 'annual_estimate';
  const DEFAULTS = Object.freeze({ annualYieldAcKwhPerKwp: 1000, annualDepositPlnKwh: .30, annualPriceSpreadFraction: .30 });
  const KEYS = Object.freeze(['addedKwp', 'annualYieldAcKwhPerKwp', 'annualDepositPlnKwh', 'annualPriceSpreadFraction', 'depositUseFraction', 'costPln']);
  const finite = x => typeof x === 'number' && Number.isFinite(x);
  const isAnnual = s => !!s && s.calculationMode === MODE;
  function number(s, key, high) {
    if (!finite(s[key]) || s[key] < 0 || s[key] > high) throw new Error('Parametr ' + key + ': wpisz liczbę od 0 do ' + high + '. Puste pole nie oznacza zera.');
    return s[key];
  }
  function validate(s) {
    if (!isAnnual(s)) throw new Error('Wybierz tryb „Szacunek roczny + ROI”.');
    number(s, 'addedKwp', 100000);
    number(s, 'annualYieldAcKwhPerKwp', 10000);
    number(s, 'annualDepositPlnKwh', 1000);
    number(s, 'annualPriceSpreadFraction', 1);
    number(s, 'depositUseFraction', 1);
    if (s.costPln !== null && s.costPln !== undefined) number(s, 'costPln', 1e12);
    return true;
  }
  function estimate(s) {
    validate(s);
    const annualEnergyAcKwh = s.addedKwp * s.annualYieldAcKwhPerKwp;
    const cost = finite(s.costPln) && s.costPln > 0 ? s.costPln : null;
    const variants = [['cautious', 'Ostrożny', 1 - s.annualPriceSpreadFraction], ['central', 'Środkowy', 1], ['favourable', 'Korzystny', 1 + s.annualPriceSpreadFraction]]
      .map(([id, label, factor]) => {
        const depositPlnKwh = s.annualDepositPlnKwh * factor;
        const annualDepositPln = annualEnergyAcKwh * depositPlnKwh;
        const annualBenefitPln = annualDepositPln * s.depositUseFraction;
        const paybackStatus = cost === null ? 'cost_unknown' : annualBenefitPln === 0 ? 'no_return' : 'finite';
        const paybackYears = paybackStatus === 'finite' ? cost / annualBenefitPln : null;
        const annualSimpleRoiPct = cost === null ? null : annualBenefitPln / cost * 100;
        if (![annualEnergyAcKwh, depositPlnKwh, annualDepositPln, annualBenefitPln].every(finite)
          || (paybackYears !== null && !finite(paybackYears)) || (annualSimpleRoiPct !== null && !finite(annualSimpleRoiPct)))
          throw new Error('Przekroczony zakres obliczenia rocznego. Zmień skrajne założenia.');
        return { id, label, depositPlnKwh, annualEnergyAcKwh, annualDepositPln, annualBenefitPln, paybackYears, paybackStatus, annualSimpleRoiPct };
      });
    return { schema: 1, kind: 'annual_pv_estimate', annual: true, physicalValidation: false,
      historicalHoursRequired: false, historicalAnnualization: false, allAddedAcAssumedExported: true,
      priceSensitivityOnly: true, statisticalConfidenceInterval: false, annualEnergyAcKwh,
      costPln: cost, assumptions: Object.fromEntries(KEYS.map(k => [k, s[k] === undefined ? null : s[k]])), variants };
  }
  // Optional reference from an already validated, complete EXPORT scenario.
  // Never use conditional benefit (utilization is separate), actual total meter
  // export, a known-only price subtotal, or annualize its energy/time window.
  function historicalReference(result, s) {
    if (!result || result.kind !== 'incremental_pv_export_valuation' || !result.total || !s) return null;
    const t = result.total, amount = t.extraDeposit;
    if (!finite(t.extraExportKwh) || t.extraExportKwh <= 0 || !amount || amount.missingIntervals !== 0
      || !finite(amount.totalPln) || amount.totalPln < 0 || !finite(result.hours) || result.hours <= 0) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s.startDate || '') || !/^\d{4}-\d{2}-\d{2}$/.test(s.endDate || '') || s.startDate > s.endDate) return null;
    const valuePlnKwh = amount.totalPln / t.extraExportKwh;
    if (!finite(valuePlnKwh) || valuePlnKwh > 1000) return null;
    return { kind: 'historical_reference', startDate: s.startDate, endDate: s.endDate, hours: result.hours,
      extraExportKwh: t.extraExportKwh, extraDepositPln: amount.totalPln, valuePlnKwh, notAnnual: true };
  }
  function restoreOrigin(origin, value) {
    if (!origin || origin.kind !== 'historical_reference') return null;
    if (origin.notAnnual !== true || !finite(origin.valuePlnKwh) || origin.valuePlnKwh !== value
      || !finite(origin.hours) || origin.hours <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(origin.startDate || '')
      || !/^\d{4}-\d{2}-\d{2}$/.test(origin.endDate || '') || origin.startDate > origin.endDate) return null;
    return { kind: 'historical_reference', startDate: origin.startDate, endDate: origin.endDate,
      hours: origin.hours, valuePlnKwh: origin.valuePlnKwh, notAnnual: true };
  }
  return Object.freeze({ mode: MODE, defaults: DEFAULTS, keys: KEYS, isAnnual, validate, estimate, historicalReference, restoreOrigin });
});
