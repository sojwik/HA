/* Wyłącznie prezentacja/założenia formularza PV. Silnik nadal używa kW DC.
 * Nie dotyka KV, starego kalkulatora ani urządzeń. A × przyjęte V / 1000
 * daje STAŁY modelowy limit kW, nie odtworzenie zmiennego prądu baterii. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.G13PvForm = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const VOLTAGE = 51.2;
  const ESTIMATE = Object.freeze({ pvToAcEta: .95, pvToBatteryEta: .98, batteryToAcEta: .95,
    acToBatteryEta: .95, storeChargeEta: .98, storeDischargeEta: .98 });
  const ETA_KEYS = Object.freeze(Object.keys(ESTIMATE));
  const finite = x => typeof x === 'number' && Number.isFinite(x);
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  function currentToKw(amps, volts) {
    if (!finite(amps) || amps < 0 || !finite(volts) || volts <= 0 || volts > 1000) return null;
    const kw = amps * volts / 1000; return finite(kw) ? kw : null;
  }
  function effective(settings) {
    const s = Object.assign({}, settings);
    if (s.customEfficiencies != null) {
      if (typeof s.customEfficiencies !== 'object' || Array.isArray(s.customEfficiencies)) throw new Error('Uszkodzony zapis własnych sprawności PV.');
      s.customEfficiencies = Object.fromEntries(ETA_KEYS.map(k => [k, own(s.customEfficiencies, k) ? s.customEfficiencies[k] : null]));
    }
    if (!['estimate-v1', 'custom'].includes(s.efficiencyMode)) throw new Error('Nieznany wariant sprawności PV. Nie zastąpiono go domyślnym.');
    if (s.efficiencyMode === 'estimate-v1') Object.assign(s, ESTIMATE);
    else s.customEfficiencies = Object.fromEntries(ETA_KEYS.map(k => [k, s[k] === undefined ? null : s[k]]));
    s.chargeDcKw = currentToKw(s.chargeCurrentA, s.batteryVoltageV);
    s.dischargeDcKw = currentToKw(s.dischargeCurrentA, s.batteryVoltageV);
    return s;
  }
  function restore(saved, merged) {
    const s = Object.assign({}, merged);
    s.customEfficiencies = saved.customEfficiencies == null ? null : saved.customEfficiencies;
    s.batteryVoltageV = own(saved, 'batteryVoltageV') ? saved.batteryVoltageV : VOLTAGE;
    for (const [amps, kw] of [['chargeCurrentA', 'chargeDcKw'], ['dischargeCurrentA', 'dischargeDcKw']]) {
      if (own(saved, amps)) s[amps] = saved[amps];
      else s[amps] = finite(saved[kw]) && saved[kw] >= 0 && finite(s.batteryVoltageV) && s.batteryVoltageV > 0
        ? saved[kw] * 1000 / s.batteryVoltageV : null;
    }
    if (own(saved, 'efficiencyMode')) {
      s.efficiencyMode = saved.efficiencyMode;
      if (s.efficiencyMode === 'custom') for (const k of ETA_KEYS) s[k] = own(saved, k) ? saved[k] : null;
    } else {
      // Nawet częściowo wpisane stare wartości są zachowane. Nie dopasowujemy
      // ani nie uzupełniamy ręcznych sprawności pod pozorem uproszczenia UI.
      const custom = ETA_KEYS.some(k => saved[k] !== undefined && saved[k] !== null);
      s.efficiencyMode = custom ? 'custom' : 'estimate-v1';
      for (const k of ETA_KEYS) s[k] = own(saved, k) ? saved[k] : null;
      if (!custom) s.acceptScenario = false; // nowe założenie wymaga akceptacji
    }
    return effective(s);
  }
  function validate(settings) {
    if (!finite(settings.batteryVoltageV) || settings.batteryVoltageV <= 0 || settings.batteryVoltageV > 1000)
      throw new Error('Podaj dodatnie napięcie odniesienia baterii w V (do 1000 V) w ustawieniach zaawansowanych. To założenie modelu, nie pomiar.');
    for (const [key, label] of [['chargeCurrentA', 'ładowania'], ['dischargeCurrentA', 'rozładowania']])
      if (!finite(settings[key]) || settings[key] < 0) throw new Error('Podaj prąd ' + label + ' w A DC. Puste pole nie oznacza zera; 0 blokuje ten kierunek.');
    const expected = effective(settings);
    if (expected.chargeDcKw !== settings.chargeDcKw || expected.dischargeDcKw !== settings.dischargeDcKw)
      throw new Error('Niespójne przeliczenie A/V na kW. Sprawdź parametry PV ponownie.');
    if (settings.efficiencyMode === 'estimate-v1' && ETA_KEYS.some(k => settings[k] !== ESTIMATE[k]))
      throw new Error('Sprawności nie zgadzają się z wybranym wariantem orientacyjnym.');
    return settings;
  }
  function cycleAcEta(s) { const values = [s.acToBatteryEta, s.storeChargeEta, s.storeDischargeEta, s.batteryToAcEta];
    return values.every(x => finite(x) && x > 0 && x <= 1) ? values.reduce((a, b) => a * b, 1) : null; }
  return Object.freeze({ voltage: VOLTAGE, estimate: ESTIMATE, etaKeys: ETA_KEYS, currentToKw, effective, restore, validate, cycleAcEta });
});
