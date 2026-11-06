'use strict';

/* ============================================================================
 * kv.js — magazyn klucz/wartość w /data/kv-store.json
 *
 * POPRAWKA P0-4 (audyt cz. 2):
 *   Było: readAll() łapał błąd JSON.parse i zwracał {}. Najbliższy set()
 *   zapisywał ten pusty obiekt z powrotem → CAŁA historia (ledger, cache RCE,
 *   eLicznik) kasowała się bez śladu, jednym uszkodzonym bajtem.
 *
 *   Jest: uszkodzony plik jest ZACHOWYWANY jako kv-store.json.corrupt-<ts>
 *   przed jakimkolwiek zapisem, stan degradacji jest widoczny w /api/health,
 *   a zapis przechodzi przez fsync pliku i katalogu (rename bez fsync nie
 *   gwarantuje trwałości przy utracie zasilania).
 * ==========================================================================*/

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || '/data';
const KV_FILE = path.join(DATA_DIR, 'kv-store.json');

let degraded = null;   // { reason, backupPath, at } — null gdy wszystko OK

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readAll() {
  ensureDataDir();
  if (!fs.existsSync(KV_FILE)) return {};

  let text;
  try {
    text = fs.readFileSync(KV_FILE, 'utf8');
  } catch (err) {
    // Błąd odczytu (uprawnienia, I/O) — NIE kasujemy, NIE zwracamy pustego
    // magazynu po cichu. Rzucamy, żeby serwer zwrócił 503 zamiast udawać,
    // że historii nie ma.
    throw new Error('kv: nie mogę odczytać ' + KV_FILE + ': ' + err.message);
  }

  // Pusty plik (0 bajtów) to legalny stan świeżej instalacji
  if (!text.trim()) return {};

  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('oczekiwano obiektu JSON, otrzymano ' + (Array.isArray(parsed) ? 'tablicę' : typeof parsed));
    }
    return parsed;
  } catch (err) {
    // KLUCZOWE: zachowaj uszkodzony plik, zanim cokolwiek zapiszesz.
    const backupPath = KV_FILE + '.corrupt-' + Date.now();
    try {
      fs.copyFileSync(KV_FILE, backupPath);
    } catch (e) {
      // Jeśli nie da się zrobić kopii, odmawiamy dalszej pracy — lepiej
      // zwrócić błąd niż stracić dane.
      throw new Error('kv: uszkodzony magazyn i nie mogę zrobić kopii zapasowej ('
        + e.message + '). Odmawiam zapisu, żeby nie skasować historii.');
    }
    degraded = { reason: err.message, backupPath, at: new Date().toISOString() };
    console.error('[kv] USZKODZONY kv-store.json — kopia zachowana jako ' + backupPath);
    console.error('[kv] Powód: ' + err.message);
    console.error('[kv] Aplikacja startuje z pustym magazynem. Przywróć dane z kopii ręcznie.');

    // Podmieniamy żywy plik na pusty obiekt DOPIERO po zrobieniu kopii.
    // Bez tego każdy kolejny odczyt znów wykrywał uszkodzenie i tworzył
    // następną kopię — przy odświeżaniu co minutę zaśmieciłoby to /data
    // tysiącami plików w ciągu dnia.
    try {
      writeAll({});
    } catch (e) {
      console.error('[kv] Nie mogę zresetować żywego pliku: ' + e.message);
    }
    return {};
  }
}

function writeAll(obj) {
  ensureDataDir();
  const tmp = KV_FILE + '.tmp';
  const data = JSON.stringify(obj, null, 2);

  // fsync pliku PRZED rename — inaczej po awarii zasilania rename może
  // przetrwać, a zawartość nie.
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, data, null, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, KV_FILE);

  // fsync katalogu — utrwala sam wpis katalogowy po rename
  try {
    const dfd = fs.openSync(DATA_DIR, 'r');
    try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
  } catch (e) {
    // Niektóre systemy plików nie pozwalają fsync katalogu — nie jest to błąd
    // krytyczny, plik już jest zrzucony na dysk.
  }
}

function get(key) {
  const all = readAll();
  return Object.prototype.hasOwnProperty.call(all, key) ? all[key] : undefined;
}

function set(key, value) {
  const all = readAll();
  all[key] = value;
  writeAll(all);
  return value;
}

function del(key) {
  const all = readAll();
  const existed = Object.prototype.hasOwnProperty.call(all, key);
  delete all[key];
  writeAll(all);
  return existed;
}

function list(prefix) {
  const all = readAll();
  return Object.keys(all).filter((k) => !prefix || k.indexOf(prefix) === 0);
}

function health() {
  return { ok: degraded === null, degraded, file: KV_FILE };
}

/** Pozwala wyczyścić flagę po ręcznym przywróceniu danych z kopii. */
function clearDegraded() { degraded = null; }

module.exports = { get, set, del, list, health, clearDegraded, KV_FILE };
