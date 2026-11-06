'use strict';
/* Uruchamia wszystkie zestawy testów po kolei. */
const { spawnSync } = require('child_process');
const path = require('path');

const SUITES = [
  ['Walidator na realnych danych', 'test_validate_real.js'],
  ['Backend (KV, ha-ws, CSV)', 'test_backend.js'],
  ['Frontend (jednostkowe + realne dane)', 'test_frontend.js'],
  ['Serwer (integracyjny HTTP)', 'test_server.js'],
  ['DOM (dymny, jsdom)', 'test_dom_smoke.js'],
];

let totalFail = 0;
const results = [];
const skipped = [];

for (const [label, file] of SUITES) {
  console.log('\n' + '='.repeat(70));
  console.log('  ' + label);
  console.log('='.repeat(70));
  const r = spawnSync(process.execPath, [path.join(__dirname, file)], {
    encoding: 'utf8',
    cwd: path.join(__dirname, '..'),
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  const ok = r.status === 0;
  // Pominięte testy NIE są sukcesem — wykrywamy je po markerze z fixture.js,
  // żeby podsumowanie nie mówiło „wszystko przeszło", gdy część nie wykonała się.
  const skips = (r.stdout || '').split('\n')
    .filter((l) => l.startsWith('##G13-SKIP##'))
    .map((l) => l.replace('##G13-SKIP## ', ''));
  for (const sk of skips) skipped.push(sk);
  results.push([label, ok, skips.length > 0]);
  if (!ok) totalFail++;
}

console.log('\n' + '='.repeat(70));
console.log('  PODSUMOWANIE');
console.log('='.repeat(70));
for (const [label, ok, hadSkip] of results) {
  const mark = !ok ? '✗' : (hadSkip ? '⚠' : '✓');
  console.log(`  ${mark} ${label}${hadSkip ? '  (część POMINIĘTA)' : ''}`);
}
if (skipped.length) {
  console.log('\n  POMINIĘTE zestawy — brak pliku z realnym eksportem HA:');
  for (const sk of skipped) console.log('    · ' + sk);
  console.log('  Uruchom z G13_TEST_CSV=/sciezka/bilans_growatt.csv, żeby je wykonać.');
}
if (totalFail !== 0) {
  console.log('\n' + totalFail + ' zestaw(y) NIE PRZESZŁY');
} else if (skipped.length) {
  console.log('\nZESTAWY WYKONANE BEZ BŁĘDÓW, ale ' + skipped.length + ' pominięto —');
  console.log('poprawki na realnych danych NIE zostały w tym uruchomieniu zweryfikowane.');
} else {
  console.log('\nWSZYSTKIE ZESTAWY PRZESZŁY (łącznie z testami na realnych danych)');
}
process.exit(totalFail ? 1 : 0);
