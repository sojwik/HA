'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const kv = require('./lib/kv');
const haWs = require('./lib/ha-ws');
const { statisticsToCsv } = require('./lib/growatt-csv');

const PORT = process.env.PORT || 8099;
const OPTIONS_FILE = '/data/options.json'; // wstrzykiwane przez Supervisora na podstawie config.yaml "options"

const DEFAULT_OPTIONS = {
  growatt_entities: [
    'sensor.growatt_solar_energy_total',
    'sensor.growatt_grid_energy_to_grid_total',
    'sensor.growatt_grid_grid_import_energy_total',
    'sensor.growatt_load_load_energy_total',
    'sensor.growatt_battery_battery_charge_total',
    'sensor.growatt_battery_battery_discharge_total',
  ],
  history_months_back: 24,
  refresh_interval_minutes: 60,
};

function loadOptions() {
  try {
    const raw = fs.readFileSync(OPTIONS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Object.assign({}, DEFAULT_OPTIONS, parsed);
  } catch (e) {
    console.warn('[config] Nie znaleziono /data/options.json - używam wartości domyślnych.');
    return { ...DEFAULT_OPTIONS };
  }
}

const options = loadOptions();

function monthsAgo(n) {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
}

const app = express();
app.use(express.json({ limit: '2mb' }));

// ---------- KV: zamiennik window.storage (get/set/delete/list) ----------
app.get('/api/kv/:key', (req, res) => {
  const value = kv.get(req.params.key);
  if (value === undefined) { res.status(404).json({ error: 'not_found' }); return; }
  res.json({ key: req.params.key, value });
});

app.put('/api/kv/:key', (req, res) => {
  if (typeof req.body.value !== 'string') {
    res.status(400).json({ error: 'Pole "value" musi być stringiem (frontend sam robi JSON.stringify).' });
    return;
  }
  kv.set(req.params.key, req.body.value);
  res.json({ key: req.params.key, value: req.body.value });
});

app.delete('/api/kv/:key', (req, res) => {
  kv.del(req.params.key);
  res.json({ key: req.params.key, deleted: true });
});

app.get('/api/kv', (req, res) => {
  res.json({ keys: kv.list(req.query.prefix || '') });
});

// ---------- Konfiguracja widoczna dla frontendu ----------
app.get('/api/config', (req, res) => {
  res.json({
    historyMonthsBack: options.history_months_back,
    refreshIntervalMinutes: options.refresh_interval_minutes,
    growattEntities: options.growatt_entities,
  });
});

// ---------- Growatt: długoterminowe statystyki HA jako CSV ----------
// Ten sam kształt kolumn (statistic_id, start, delta) co ręczny eksport
// przez import_statistics.export_statistics - dzięki temu frontend parsuje
// to dokładnie tą samą, niezmienioną funkcją co plik wgrywany ręcznie.
app.get('/api/growatt/ha-stats.csv', async (req, res) => {
  try {
    const start = req.query.start ? new Date(req.query.start) : monthsAgo(options.history_months_back);
    const end = req.query.end ? new Date(req.query.end) : new Date();
    const result = await haWs.fetchStatistics(options.growatt_entities, start, end);

    // Diagnostyka: dla każdej skonfigurowanej encji pokazujemy ile okresów
    // faktycznie wróciło z HA. Przy złym entity_id (literówka, inna nazwa
    // niż w rzeczywistej instalacji growatt_modbus) będzie tu 0 - widoczne
    // od razu w logu dodatku, bez zgadywania.
    options.growatt_entities.forEach((id) => {
      const count = (result[id] || []).length;
      console.log(`[growatt] ${id}: ${count} okresów`);
    });
    if (Object.keys(result).length === 0) {
      console.warn('[growatt] HA nie zwrócił ŻADNEJ ze skonfigurowanych encji - sprawdź growatt_entities w opcjach dodatku vs. Developer Tools → States.');
    }

    const csv = statisticsToCsv(result);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.send(csv);
  } catch (err) {
    console.error('[growatt] Błąd pobierania statystyk z HA:', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ---------- Statyczny frontend ----------
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`[server] G13 Depozyt nasłuchuje na porcie ${PORT}`);
  console.log(`[server] Encje Growatt (${options.growatt_entities.length}): ${options.growatt_entities.join(', ')}`);
  console.log(`[server] Historia wsteczna: ${options.history_months_back} mies., odświeżanie co ${options.refresh_interval_minutes} min.`);
});
