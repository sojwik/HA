'use strict';
/* Testy backendu: KV (P0-4), ha-ws (P0-3), walidacja query. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'g13kv-'));
process.env.DATA_DIR = TMP;
const kv = require('../app/lib/kv');

console.log('\n=== KV: P0-4 uszkodzony plik nie kasuje historii ===');

t('K1 świeży magazyn zwraca undefined', () => {
  assert.strictEqual(kv.get('nic'), undefined);
});

t('K2 zapis i odczyt', () => {
  kv.set('ledger', '{"a":1}');
  assert.strictEqual(kv.get('ledger'), '{"a":1}');
});

t('K3 uszkodzony JSON → kopia zapasowa ZACHOWANA', () => {
  kv.set('cenne', 'dane których nie wolno stracić');
  fs.writeFileSync(kv.KV_FILE, '{"cenne": "dane które', 'utf8');   // ucięty JSON
  const v = kv.get('cenne');
  assert.strictEqual(v, undefined, 'po uszkodzeniu magazyn jest pusty');
  const backups = fs.readdirSync(TMP).filter(f => f.includes('.corrupt-'));
  assert.ok(backups.length >= 1, 'musi powstać plik .corrupt-<ts>');
  const saved = fs.readFileSync(path.join(TMP, backups[0]), 'utf8');
  assert.ok(saved.includes('dane które'), 'kopia musi zawierać oryginalną treść');
});

t('K4 health() raportuje degradację', () => {
  const h = kv.health();
  assert.strictEqual(h.ok, false);
  assert.ok(h.degraded.backupPath, 'health musi podać ścieżkę kopii');
});

t('K5 zapis po degradacji nie kasuje kopii', () => {
  const before = fs.readdirSync(TMP).filter(f => f.includes('.corrupt-'));
  kv.set('nowy', 'x');
  const after = fs.readdirSync(TMP).filter(f => f.includes('.corrupt-'));
  assert.deepStrictEqual(before, after, 'kopia musi przetrwać kolejne zapisy');
  assert.strictEqual(kv.get('nowy'), 'x');
});

t('K6 pusty plik to legalny stan, nie uszkodzenie', () => {
  kv.clearDegraded();
  fs.writeFileSync(kv.KV_FILE, '', 'utf8');
  assert.deepStrictEqual(kv.list(), []);
  assert.strictEqual(kv.health().ok, true);
});

t('K7 tablica zamiast obiektu → traktowana jako uszkodzenie', () => {
  fs.writeFileSync(kv.KV_FILE, '[1,2,3]', 'utf8');
  kv.get('x');
  assert.strictEqual(kv.health().ok, false);
});

t('K8 plik .tmp nie zostaje po zapisie', () => {
  kv.clearDegraded();
  fs.writeFileSync(kv.KV_FILE, '{}', 'utf8');
  kv.set('a', 'b');
  assert.ok(!fs.existsSync(kv.KV_FILE + '.tmp'), 'tmp musi być przemianowany');
});

console.log('\n=== ha-ws: P0-3 nieprawidłowe daty nie wywracają procesu ===');
const haWs = require('../app/lib/ha-ws');

t('H1 asValidDate odrzuca śmieci', () => {
  assert.strictEqual(haWs.asValidDate('nie-jest-data'), null);
  assert.strictEqual(haWs.asValidDate(new Date('xyz')), null);
  assert.strictEqual(haWs.asValidDate(NaN), null);
  assert.strictEqual(haWs.asValidDate(''), null);
  assert.strictEqual(haWs.asValidDate(undefined), null);
});

t('H2 asValidDate przyjmuje poprawne', () => {
  assert.ok(haWs.asValidDate('2026-07-01') instanceof Date);
  assert.ok(haWs.asValidDate(new Date()) instanceof Date);
  assert.ok(haWs.asValidDate(Date.now()) instanceof Date);
});

t('H3 fetchStatistics odrzuca Invalid Date przez Promise, nie wyjątek', async () => {
  let threw = false;
  try {
    await haWs.fetchStatistics(['sensor.x'], new Date('śmieć'), new Date());
  } catch (e) {
    threw = true;
    assert.ok(/nieprawidłowa data początkowa/i.test(e.message), 'komunikat musi nazywać problem: ' + e.message);
  }
  assert.ok(threw, 'musi odrzucić Promise');
});

t('H4 pusta lista encji odrzucona', async () => {
  let threw = false;
  try { await haWs.fetchStatistics([], new Date(0), new Date()); }
  catch (e) { threw = true; assert.ok(/pusta/i.test(e.message)); }
  assert.ok(threw);
});

t('H5 start >= end odrzucone', async () => {
  let threw = false;
  const d = new Date('2026-07-01');
  try { await haWs.fetchStatistics(['sensor.x'], d, d); }
  catch (e) { threw = true; assert.ok(/wcześniejsza/i.test(e.message)); }
  assert.ok(threw);
});

t('H6 encja bez kropki odrzucona', async () => {
  let threw = false;
  try { await haWs.fetchStatistics(['bez_kropki'], new Date(0), new Date()); }
  catch (e) { threw = true; assert.ok(/entity_id/i.test(e.message)); }
  assert.ok(threw);
});

console.log('\n=== growatt-csv: DST i kolumny ===');
const { statisticsToCsv, toUtcKey, toWarsawString } = require('../app/lib/growatt-csv');

t('G1 dwie godziny 02:00 przy zmianie czasu mają RÓŻNE klucze UTC', () => {
  const a = Date.parse('2026-10-25T02:00:00+02:00');
  const b = Date.parse('2026-10-25T02:00:00+01:00');
  assert.notStrictEqual(toUtcKey(a), toUtcKey(b));
  assert.strictEqual(toWarsawString(a).slice(11, 16), '02:00');
  assert.strictEqual(toWarsawString(b).slice(11, 16), '02:00');
});

t('G2 CSV ma kolumnę start_utc', () => {
  const csv = statisticsToCsv({
    'sensor.x': [
      { start: Date.parse('2026-10-25T02:00:00+02:00'), sum: 10, change: 1 },
      { start: Date.parse('2026-10-25T02:00:00+01:00'), sum: 11, change: 1 },
    ],
  });
  const lines = csv.trim().split('\n');
  assert.strictEqual(lines[0], 'statistic_id,start,start_utc,sum,delta,delta_sum');
  assert.strictEqual(lines.length, 3, 'oba wiersze muszą przetrwać');
  const keys = lines.slice(1).map(l => l.split(',')[2]);
  assert.notStrictEqual(keys[0], keys[1]);
});

t('G3 północ nie daje „24:00”', () => {
  const s = toWarsawString(Date.parse('2026-01-15T00:00:00+01:00'));
  assert.ok(s.includes('00:00:00'), 'oczekiwano 00:00:00, jest: ' + s);
});

t('G4 delta z change, delta_sum z sum — osobno', () => {
  const csv = statisticsToCsv({
    'sensor.x': [
      { start: Date.parse('2026-07-01T10:00:00+02:00'), sum: 100, change: 5 },
      { start: Date.parse('2026-07-01T11:00:00+02:00'), sum: 103, change: 5 },
    ],
  });
  const row = csv.trim().split('\n')[2].split(',');
  assert.strictEqual(row[4], '5', 'delta = change');
  assert.strictEqual(row[5], '3', 'delta_sum = Δsum (103−100)');
});

t('G5 nieparsowalny timestamp pominięty, nie wyzerowany', () => {
  const csv = statisticsToCsv({ 'sensor.x': [{ start: 'śmieć', sum: 5, change: 5 }] });
  assert.strictEqual(csv.trim().split('\n').length, 1, 'tylko nagłówek');
});

// sprzątanie
fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n${pass} przeszło, ${fail} nie przeszło`);
module.exports = { pass, fail };
if (require.main === module) process.exit(fail ? 1 : 0);
