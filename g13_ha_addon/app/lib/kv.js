'use strict';

/* ============================================================================
 * kv.js — magazyn klucz/wartość w /data/kv-store.json
 *
 * POPRAWKI:
 *  P0-4 (audyt cz. 2):
 *    Uszkodzony plik jest ZACHOWYWANY jako kv-store.json.corrupt-<ts>
 *    przed jakimkolwiek zapisem, stan degradacji jest widoczny w /api/health,
 *    a zapis przechodzi przez fsync pliku i katalogu.
 *
 *  0.4.3 (audyt bezpieczeństwa i spójności):
 *    - Walidacja nazw kluczy (ochrona przed prototype pollution i znakami ster.).
 *    - Mapa o prototypie null dla kluczy w pamięci.
 *    - Limity rozmiaru magazynu (32 MB) i liczby kluczy (500) przy zapisie
 *      (odczyt i usuwanie istniejących danych nigdy nie są blokowane).
 *    - Losowa nazwa pliku tymczasowego z flagą wx i uprawnieniami 0o600.
 *    - ETag / optymistyczna kontrola współbieżności (If-Match -> 409).
 * ==========================================================================*/

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || '/data';
const KV_FILE = path.join(DATA_DIR, 'kv-store.json');
const MAX_STORE_BYTES = 32 * 1024 * 1024;
const MAX_KEYS = 500;
const FORBIDDEN_KEYS = new Set([
  '__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty',
]);

let degraded = null;   // { reason, backupPath, at } — null gdy wszystko OK

function isValidKey(key) {
  if (typeof key !== 'string' || key.length === 0 || key.length > 160) return false;
  if (FORBIDDEN_KEYS.has(key) || key.includes('..')) return false;
  return /^[a-zA-Z0-9._:-]+$/.test(key);
}

function assertValidKey(key) {
  if (!isValidKey(key)) {
    const err = new Error('Nieprawidłowa nazwa klucza KV.');
    err.status = 400;
    throw err;
  }
}

function etagOf(value) {
  if (value === undefined) return '"ABSENT"';
  return '"' + crypto.createHash('sha256').update(String(value)).digest('hex') + '"';
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function toSafeMap(obj) {
  const map = Object.create(null);
  for (const k of Object.keys(obj)) {
    if (FORBIDDEN_KEYS.has(k)) continue;
    map[k] = obj[k];
  }
  return map;
}

function readAll() {
  ensureDataDir();
  if (!fs.existsSync(KV_FILE)) return Object.create(null);

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
  if (!text.trim()) return Object.create(null);

  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('oczekiwano obiektu JSON, otrzymano ' + (Array.isArray(parsed) ? 'tablicę' : typeof parsed));
    }
    return toSafeMap(parsed);
  } catch (err) {
    // KLUCZOWE: zachowaj uszkodzony plik, zanim cokolwiek zapiszesz.
    const backupPath = KV_FILE + '.corrupt-' + Date.now();
    try {
      fs.copyFileSync(KV_FILE, backupPath);
      try { fs.chmodSync(backupPath, 0o600); } catch (e) { /* best-effort */ }
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
      writeAll(Object.create(null));
    } catch (e) {
      console.error('[kv] Nie mogę zresetować żywego pliku: ' + e.message);
    }
    return Object.create(null);
  }
}

function writeAll(obj) {
  ensureDataDir();
  const tmp = KV_FILE + '.tmp-' + process.pid + '-' + crypto.randomBytes(8).toString('hex');
  const data = JSON.stringify(obj, null, 2);

  // fsync pliku PRZED rename — inaczej po awarii zasilania rename może
  // przetrwać, a zawartość nie. Flaga wx + 0o600 chroni przed kolizją i
  // nieuprawnionym odczytem.
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
      fs.writeSync(fd, data, null, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, KV_FILE);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_) { /* noop */ }
    throw err;
  }

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
  assertValidKey(key);
  const all = readAll();
  return Object.prototype.hasOwnProperty.call(all, key) ? all[key] : undefined;
}

function getWithEtag(key) {
  const value = get(key);
  return { value, etag: etagOf(value) };
}

function set(key, value, opts) {
  assertValidKey(key);
  const all = readAll();
  const existed = Object.prototype.hasOwnProperty.call(all, key);
  const currentEtag = etagOf(existed ? all[key] : undefined);

  if (opts && typeof opts.expectedEtag === 'string' && opts.expectedEtag.trim()) {
    if (opts.expectedEtag.trim() !== currentEtag) {
      const err = new Error('Dane zmieniły się w innej karcie lub przez import AMIplus. Odśwież widok przed zapisem.');
      err.status = 409;
      err.currentEtag = currentEtag;
      throw err;
    }
  }

  if (!existed && Object.keys(all).length >= MAX_KEYS) {
    const err = new Error('Przekroczono limit liczby kluczy w magazynie KV (' + MAX_KEYS + ').');
    err.status = 413;
    throw err;
  }

  all[key] = value;
  const bytes = Buffer.byteLength(JSON.stringify(all, null, 2), 'utf8');
  if (bytes > MAX_STORE_BYTES) {
    const err = new Error('Magazyn KV przekroczył dopuszczalny rozmiar (' + Math.round(MAX_STORE_BYTES / 1048576) + ' MB).');
    err.status = 413;
    throw err;
  }

  writeAll(all);
  return value;
}

function del(key) {
  assertValidKey(key);
  const all = readAll();
  const existed = Object.prototype.hasOwnProperty.call(all, key);
  delete all[key];
  writeAll(all);
  return existed;
}

function list(prefix) {
  const all = readAll();
  const p = typeof prefix === 'string' ? prefix : '';
  return Object.keys(all).filter((k) => !p || k.indexOf(p) === 0);
}

function health() {
  return { ok: degraded === null, degraded, file: KV_FILE };
}

/** Pozwala wyczyścić flagę po ręcznym przywróceniu danych z kopii. */
function clearDegraded() { degraded = null; }

module.exports = {
  get,
  getWithEtag,
  set,
  del,
  list,
  health,
  clearDegraded,
  isValidKey,
  etagOf,
  KV_FILE,
  MAX_STORE_BYTES,
  MAX_KEYS,
};
