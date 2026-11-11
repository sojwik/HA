/* Własna przestrzeń kluczy PV; żadna metoda nie może zapisać/usunąć ledger,
 * cen ani historii istniejących kart. Commit manifestu dopiero po wszystkich
 * shardach; przerwany download/zapis nie aktywuje częściowej historii. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.G13PvStore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const PREFIX = 'pv-sim-v1-';
  const SETTINGS = PREFIX + 'settings', ACTIVE = PREFIX + 'active';
  const SHARD = /^pv-sim-v1-data-[a-z0-9-]+-\d{4}$/;
  const allowed = key => key === SETTINGS || key === ACTIVE || SHARD.test(key);
  function create(storage) {
    if (!storage || !['get', 'set', 'delete', 'list'].every(k => typeof storage[k] === 'function')) throw new Error('Brak magazynu KV dla karty PV.');
    let tail = Promise.resolve(), seq = 0;
    function serial(fn) { const p = tail.then(fn, fn); tail = p.catch(() => {}); return p; }
    async function read(key) {
      if (!allowed(key)) throw new Error('Próba odczytu spoza przestrzeni PV.');
      const r = await storage.get(key);
      if (!r) return null;
      const obj = JSON.parse(r.value);
      if (!obj || obj.schema !== 1 || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('Nieznany/uszkodzony format zapisu PV: ' + key + '. Bez automatycznego nadpisania.');
      return obj;
    }
    async function write(key, value) {
      if (!allowed(key)) throw new Error('Próba zapisu spoza przestrzeni PV.');
      const s = JSON.stringify(value);
      // Limit backendu 2 MB dotyczy zewnętrznego JSON z escape; zachowujemy zapas.
      if (new TextEncoder().encode(JSON.stringify({ value: s })).byteLength > 1800000)
        throw new Error('Część historii PV przekracza bezpieczny limit zapisu 1,8 MB.');
      await storage.set(key, s);
    }
    async function ownKeys() {
      const result = await storage.list(PREFIX);
      return ((result && result.keys) || []).filter(k => typeof k === 'string' && allowed(k));
    }
    async function loadSettings() {
      const obj = await read(SETTINGS);
      if (!obj) return null;
      if (!obj.settings || typeof obj.settings !== 'object' || Array.isArray(obj.settings)) throw new Error('Uszkodzone ustawienia PV.');
      return obj.settings;
    }
    function saveSettings(settings) { return serial(() => write(SETTINGS, { schema: 1, settings })); }
    async function loadDataset() {
      const m = await read(ACTIVE);
      if (!m) return null;
      if (!Array.isArray(m.keys) || !m.keys.length || m.keys.length > 1000 || new Set(m.keys).size !== m.keys.length
        || typeof m.generation !== 'string' || !/^[a-z0-9-]+$/.test(m.generation) || typeof m.signature !== 'string')
        throw new Error('Uszkodzony manifest danych PV.');
      const parts = [];
      for (const key of m.keys) {
        if (!SHARD.test(key) || !key.startsWith(PREFIX + 'data-' + m.generation + '-')) throw new Error('Nieprawidłowy klucz części danych PV.');
        const obj = await read(key);
        if (!obj || obj.generation !== m.generation || !obj.series) throw new Error('Brak/sporna część historii PV: ' + key);
        parts.push(obj.series);
      }
      return { signature: m.signature, fetchedAt: m.fetchedAt, parts };
    }
    function saveDataset(series, signature) {
      return serial(async () => {
        const previousManifest = await read(ACTIVE);
        const previousKeys = previousManifest && Array.isArray(previousManifest.keys)
          ? previousManifest.keys.filter(k => SHARD.test(k)) : [];
        const generation = Date.now().toString(36) + '-' + (++seq).toString(36) + '-' + Math.random().toString(36).slice(2, 9);
        const keys = []; let chunk = Object.create(null), count = 0;
        async function flush() {
          if (!count) return;
          const key = PREFIX + 'data-' + generation + '-' + String(keys.length).padStart(4, '0');
          // Zachowujemy klucz także przy błędzie po stronie odpowiedzi HTTP:
          // serwer mógł już zapisać część. Czyszczenie dotyczy TYLKO nowej generacji.
          keys.push(key);
          await write(key, { schema: 1, generation, series: chunk });
          chunk = Object.create(null); count = 0;
        }
        let committed = false;
        const fetchedAt = new Date().toISOString();
        try {
          for (const id of Object.keys(series).sort()) for (const row of series[id]) {
            if (!chunk[id]) chunk[id] = [];
            chunk[id].push(row); count++;
            if (count >= 4000) await flush();
          }
          await flush();
          if (!keys.length) throw new Error('Pusta historia PV nie może zastąpić poprzedniej.');
          await write(ACTIVE, { schema: 1, generation, signature, keys, fetchedAt });
          committed = true;
        } catch (e) {
          // Przy niepewnej odpowiedzi PUT manifestu sprawdzamy odczytem, czy
          // commit nastąpił. Nigdy nie kasujemy shardów aktywnego manifestu.
          try { const m = await read(ACTIVE); committed = !!m && m.generation === generation; }
          catch (_) { throw new Error(e.message + ' Niepewny stan zapisu PV; zachowano części, sprawdź ponowne wczytanie.'); }
          if (!committed) {
            for (const key of keys) { try { await storage.delete(key); } catch (_) {} }
            throw e;
          }
        }
        let cleanupWarning = false;
        try {
          const activeNow = await read(ACTIVE);
          if (activeNow && activeNow.generation === generation)
            for (const key of previousKeys) if (!keys.includes(key)) await storage.delete(key);
        } catch (_) { cleanupWarning = true; }
        return { signature, fetchedAt, cleanupWarning };
      });
    }
    function reset() {
      return serial(async () => {
        // Najpierw manifest — przerwane czyszczenie nie pozostawi aktywnej
        // referencji do usuniętych części. Awaria nie rusza cudzych kluczy.
        await storage.delete(ACTIVE);
        for (const key of await ownKeys()) if (key !== ACTIVE) await storage.delete(key);
      });
    }
    return Object.freeze({ loadSettings, saveSettings, loadDataset, saveDataset, reset });
  }
  return Object.freeze({ create, prefix: PREFIX });
});
