'use strict';

// Zastępuje window.storage (działa wyłącznie w artefakcie Claude.ai) plikiem
// JSON w /data - katalog persystowany przez Supervisor między restartami
// i aktualizacjami dodatku (patrz "map: - data:rw" w config.yaml).
//
// Traktujemy wartości jako nieprzezroczyste stringi - dokładnie tak samo jak
// oryginalne window.storage: wywołujący sam robi JSON.stringify()/JSON.parse().
// Dzięki temu ten moduł nie musi nic wiedzieć o kształcie danych aplikacji
// (monthly-ledger, rce-cache czy cokolwiek dojdzie w przyszłości).

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || '/data';
const KV_FILE = path.join(DATA_DIR, 'kv-store.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readAll() {
  ensureDataDir();
  if (!fs.existsSync(KV_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(KV_FILE, 'utf8'));
  } catch (err) {
    console.error('[kv] Nie udało się odczytać kv-store.json, zwracam pusty magazyn:', err.message);
    return {};
  }
}

function writeAll(obj) {
  ensureDataDir();
  const tmp = KV_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, KV_FILE); // atomowa podmiana - bez ryzyka połowicznego zapisu przy awarii w trakcie
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

module.exports = { get, set, del, list, KV_FILE };
