'use strict';
// Wszystkie encje i przebiegi są sztuczne. Ten plik wolno publikować.
const D = require('../app/public/pv-data');
const HOUR = 3600000;
function settings(patch) {
  return Object.assign({ startDate: '2026-09-01', endDate: '2026-09-01', loadMode: 'conditional', topology: 'dc_shared',
    existingKwp: 9.54, addedKwp: 9.54, addedYieldFactor: 1, capacityKwh: 10,
    minSocPct: 0, maxSocPct: 100, initialSocPct: 0, chargeDcKw: 20, dischargeDcKw: 20,
    pvToAcEta: 1, pvToBatteryEta: 1, batteryToAcEta: 1, acToBatteryEta: 1, storeChargeEta: 1, storeDischargeEta: 1,
    inverterAcKw: 20, addedInverterAcKw: 20, exportAcKw: 20, unlimitedInverter: false,
    unlimitedAddedInverter: false, unlimitedExport: false, depositUseFraction: 1, loadScale: 1, costPln: null,
    allowDstAggregation: false, acceptScenario: true, autoRefresh: false, gridSource: 'shared', gridPolicyVersion: 1,
    entities: { pv: 'sensor.test_pv', acOutput: 'sensor.test_ac', acCharge: 'sensor.test_ac_charge',
      bmsCharge: 'sensor.test_bms_charge', bmsDischarge: 'sensor.test_bms_discharge',
      soc: 'sensor.test_soc', pvPower: 'sensor.test_power', house: '' } }, patch);
}
function sumSeries(series) {
  for (const rs of Object.values(series)) {
    let sum = 0;
    for (const r of rs) if (r.change !== null) { sum += r.change; r.sum = sum; }
  }
  return series;
}
function data(s = settings()) {
  const span = D.range(s.startDate, s.endDate), series = Object.create(null);
  const shared = { hourlyElicznik: {}, rceHourly: {}, zoneRates: { T2: 1.5 } };
  for (const [channel, id] of Object.entries(s.entities)) if (id) {
    series[id] = [];
    for (let ts = span.start - HOUR; ts < span.end; ts += HOUR) {
      const hour = Number(D.localKey(ts).slice(-2)), pv = hour === 12 ? 4 : 0;
      const stat = channel === 'soc' || channel === 'pvPower';
      const change = stat ? null : channel === 'pv' || channel === 'acOutput' ? pv : channel === 'house' ? (hour === 12 ? 2 : hour === 20 ? 3 : 0) : 0;
      const mean = channel === 'soc' ? 10 : channel === 'pvPower' ? pv : null;
      const r = { ts, change, sum: stat ? null : 0, mean, min: mean, max: mean };
      if (channel === 'pvPower') r.powerUnit = 'kW';
      series[id].push(r);
    }
  }
  for (let ts = span.start; ts < span.end; ts += HOUR) {
    const key = D.localKey(ts), hour = Number(key.slice(-2));
    if (!shared.hourlyElicznik[key]) shared.hourlyElicznik[key] = { date: key.slice(0, 10), hour,
      poborPoZbil: 0, oddaniePoZbil: 0, hasImport: true, hasExport: true, strefa: 'T2', expectedCount: 0, importCount: 0, exportCount: 0 };
    const g = shared.hourlyElicznik[key]; g.expectedCount++; g.importCount++; g.exportCount++; g.poborPoZbil += hour === 20 ? 3 : 0; g.oddaniePoZbil += hour === 12 ? 2 : 0;
    shared.rceHourly[key] = 400;
  }
  return { series: sumSeries(series), shared, settings: s, span };
}
function csv(series, ids = Object.keys(series), start = -Infinity, end = Infinity) {
  const head = ['statistic_id', 'start', 'start_utc', 'mean', 'min', 'max', 'sum', 'change', 'power_unit'];
  const lines = [head.join(',')];
  for (const id of ids) for (const r of series[id] || []) if (r.ts >= start && r.ts < end) {
    lines.push([id, D.localKey(r.ts).replace('_', ' ') + ':00:00', new Date(r.ts).toISOString().replace('.000Z', 'Z'),
      ...['mean', 'min', 'max', 'sum', 'change'].map(k => r[k] === null ? '' : r[k]), r.powerUnit || ''].join(','));
  }
  return lines.join('\n') + '\n';
}
function legacyKv(f) {
  const mk = f.settings.startDate.slice(0, 7);
  return {
    'monthly-ledger': JSON.stringify({ months: { [mk]: { kwh: 2, przypis: .984, kosztEnergii: 10, kosztDystrybucji: 2,
      haProdukcja: 4, haLadowanie: 2, haRozladowanie: 1 } }, kosztInwestycji: 26000, batCostPln: 5000,
      batCapacityKwh: 123, batEfficiency: .9, zoneRates: f.shared.zoneRates, refundRate: .3, refundCapBasis: 'base',
      extraBattery: { capacityKwh: 5, efficiency: 1, chargeKw: null, dischargeKw: null, costPln: 2000, startDate: null, endDate: null } }),
    ['elicznik-hourly-' + mk]: JSON.stringify(f.shared.hourlyElicznik),
    ['ha-hourly-' + mk]: JSON.stringify([{ ts: f.span.start + 12 * HOUR, produkcja: 4, ladowanie: 2, rozladowanie: 1, oddanieHa: 2 }]),
    'rce-cache': JSON.stringify({ v: 2, data: f.shared.rceHourly }),
  };
}
function gridCsv(grid) {
  const lines = ['Data;Strefa;Wartość;Rodzaj;Status;'];
  for (const key of Object.keys(grid).sort()) {
    const r = grid[key], day = key.slice(0, 10), hour = Number(key.slice(-2));
    const span = D.range(day, day); let count = 0;
    for (let t = span.start; t < span.end; t += HOUR) if (D.localKey(t) === key) count++;
    for (const [field, dir] of [['poborPoZbil', 'pobrana'], ['oddaniePoZbil', 'oddana']])
      for (let n = 0; n < count; n++) lines.push(day + ' ' + (hour + 1) + ':00;' + (r.strefa || '') + ';'
        + String(r[field] / count).replace('.', ',') + ';' + dir + ' po zbilansowaniu [kWh];licznik;');
  }
  return lines.join('\n') + '\n';
}
module.exports = { settings, data, csv, gridCsv, sumSeries, legacyKv, HOUR };
