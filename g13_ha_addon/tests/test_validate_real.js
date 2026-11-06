'use strict';
/* Test walidatora na REALNYM eksporcie HA — musi odtworzyć wyniki z analizy. */
const fs = require('fs');
const V = require('../app/lib/validate');

const ROLE = {
  'sensor.growatt_solar_energy_total': 'produkcja',
  'sensor.growatt_grid_energy_to_grid_total': 'oddanieHa',
  'sensor.growatt_grid_grid_import_energy_total': 'poborHa',
  'sensor.growatt_load_load_energy_total': 'zuzycieDomu',
  'sensor.growatt_battery_battery_charge_total': 'ladowanie',
  'sensor.growatt_battery_battery_discharge_total': 'rozladowanie',
};

// data DD.MM.YYYY HH:MM w czasie lokalnym → ms UTC
function parseLocal(s) {
  const m = s.match(/^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})$/);
  if (!m) return null;
  // składamy jako czas lokalny Warszawy: próbujemy +02:00 i +01:00, wybieramy
  // ten, którego etykieta lokalna zgadza się z wejściem (rozstrzyga DST)
  const iso = `${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:00`;
  for (const off of ['+02:00', '+01:00']) {
    const t = Date.parse(iso + off);
    const lab = V.localHourLabel(t);
    if (lab.date === `${m[3]}-${m[2]}-${m[1]}` && lab.hour === parseInt(m[4], 10)) return t;
  }
  return Date.parse(iso + '+02:00');
}

const { CSV, skipBanner } = require('./fixture');
if (!CSV) { skipBanner('Walidator na realnych danych (192 odrzucone godziny)'); process.exit(0); }
console.log('  plik testowy: ' + CSV);

const raw = fs.readFileSync(CSV, 'utf8')
  .replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
const header = raw[0].split(',');
const idx = {};
header.forEach((h, i) => { idx[h.trim()] = i; });

const perRole = {};
for (let i = 1; i < raw.length; i++) {
  const c = raw[i].split(',');
  const role = ROLE[c[idx.statistic_id]];
  if (!role) continue;
  const ms = parseLocal(c[idx.start]);
  const delta = parseFloat(c[idx.delta]);
  if (ms === null || !isFinite(delta)) continue;
  (perRole[role] = perRole[role] || []).push({ ms, delta });
}
for (const r in perRole) perRole[r].sort((a, b) => a.ms - b.ms);

const cfg = V.resolveConfig();
const rej = V.createRejectionLog();
const accepted = {};

for (const role in perRole) {
  accepted[role] = [];
  const rows = perRole[role];
  for (let i = 0; i < rows.length; i++) {
    const prev = i > 0 ? rows[i - 1].ms : null;
    const v = V.acceptDelta(role, rows[i].delta, prev, rows[i].ms, cfg);
    if (v.ok) accepted[role].push(rows[i]);
    else rej.add(role, rows[i].ms, rows[i].delta, v);
  }
}

const s = rej.summary();
console.log('=== Filtr na realnych danych (oczekiwane: 192 odrzucone) ===');
console.log('  odrzucone razem:', s.total, s.total === 192 ? '✓ ZGADZA SIĘ' : '✗ ROZBIEŻNE');
console.log('  per rola:');
for (const r in s.byRole) {
  const b = s.byRole[r];
  console.log(`    ${r.padEnd(14)} ${String(b.count).padStart(4)} h  (ujemne ${b.negative}, >próg ${b.overLimit})`);
}
console.log('  przekroczenia progu (oczekiwane 4):');
s.overLimitSamples.forEach(x => {
  console.log(`    ${new Date(x.ts).toISOString()}  ${x.role}  ${x.delta} kWh  ${x.reason}`);
});

// Miesięczny test baterii
const byMonth = {};
const ch = perRole.ladowanie, dis = perRole.rozladowanie;
const disMap = new Map(dis.map(r => [r.ms, r.delta]));
for (const r of ch) {
  const mk = V.monthKeyFromUtc(r.ms);
  (byMonth[mk] = byMonth[mk] || []).push({
    ladowanie: r.delta,
    rozladowanie: disMap.has(r.ms) ? disMap.get(r.ms) : 0,
  });
}

console.log('\n=== Miesięczny test rozstępu SOC (pojemność 16,35 kWh, η=0,92) ===');
console.log('  miesiąc    rozstęp   ×poj.   wyrok');
const EXPECT = { '2026-08': 1.00, '2026-09': 5.62, '2026-10': 9.75 };
for (const mk of Object.keys(byMonth).sort()) {
  const r = V.validateBatteryMonth(byMonth[mk], cfg);
  const flag = r.plausible ? '✓' : '✗';
  let check = '';
  if (EXPECT[mk] !== undefined) {
    check = Math.abs(r.ratio - EXPECT[mk]) < 0.35 ? '  ← zgodne z analizą' : '  ← ROZBIEŻNE';
  }
  console.log(`  ${mk}  ${String(r.socRange).padStart(8)}  ${String(r.ratio).padStart(6)}   ${flag}${check}`);
}

console.log('\n=== Twardy limit (η=1,00, pełna→pusta) ===');
for (const mk of ['2026-09', '2026-10']) {
  const r = V.validateBatteryMonth(byMonth[mk], cfg);
  console.log(`  ${mk}: nadmiar ${r.hardExcess} kWh → ${r.hardImpossible ? '✗ NIEMOŻLIWE' : '✓ możliwe'}`);
}

const ok = s.total === 192;
console.log('\n' + (ok ? 'PASS' : 'FAIL'));
process.exit(ok ? 0 : 1);
