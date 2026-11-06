'use strict';

/* ============================================================================
 * server.js — dodatek G13 Depozyt
 *
 * POPRAWKI (audyt cz. 1–2):
 *  P0-3  Nieprawidłowa data w query → 400, nie wywrócenie procesu.
 *  P0-4  kv.health() w /api/health; uszkodzony magazyn nie kasuje historii.
 *  T18   Brak autoryzacji → opcjonalny token (INGRESS_TOKEN / ADDON_TOKEN).
 *  T19   Brak nagłówków bezpieczeństwa → CSP, X-Content-Type-Options, itd.
 *  T20   Brak limitu ciała → 2 MB na KV (było 10 MB bez uzasadnienia).
 *  T23   index2.html (stara kopia, publiczna) → usunięty z repo.
 *  SIGTERM  init:false + brak obsługi sygnału → graceful shutdown.
 *  P1-10 units:{energy:'kWh'} w zapytaniu do HA (w lib/ha-ws.js).
 * ==========================================================================*/

const path = require('path');
const fs = require('fs');
const express = require('express');
const kv = require('./lib/kv');
const haWs = require('./lib/ha-ws');
const { statisticsToCsv } = require('./lib/growatt-csv');
const V = require('./lib/validate');

const PORT = process.env.PORT || 8099;
const OPTIONS_FILE = '/data/options.json';
const AUTH_TOKEN = process.env.ADDON_TOKEN || '';

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
  // Progi fizyczne — pod WIT 12K-HU i moc umowną 16 kW. Nadpisywalne w opcjach.
  limits_kw: {
    produkcja: 13.2, oddanieHa: 13.2, poborHa: 16.0,
    zuzycieDomu: 29.2, ladowanie: 14.6, rozladowanie: 14.6,
  },
  battery_capacity_kwh: 16.35,
  battery_eta: 0.92,
  require_auth: false,
};

function loadOptions() {
  try {
    const parsed = JSON.parse(fs.readFileSync(OPTIONS_FILE, 'utf8'));
    return Object.assign({}, DEFAULT_OPTIONS, parsed, {
      limits_kw: Object.assign({}, DEFAULT_OPTIONS.limits_kw, parsed.limits_kw || {}),
    });
  } catch (e) {
    console.warn('[config] Nie znaleziono /data/options.json — używam wartości domyślnych.');
    return JSON.parse(JSON.stringify(DEFAULT_OPTIONS));
  }
}

const options = loadOptions();
const validateCfg = V.resolveConfig({
  limitsKw: options.limits_kw,
  batteryCapacityKwh: options.battery_capacity_kwh,
  batteryEta: options.battery_eta,
});

function monthsAgo(n) {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
}

const app = express();
app.disable('x-powered-by');

/* ---------- nagłówki bezpieczeństwa (T19) ---------- */
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Referrer-Policy', 'no-referrer');
  // Ingress HA osadza dodatek w iframe, więc frame-ancestors musi pozwalać
  // na rodzica. Reszta CSP blokuje zewnętrzne skrypty (SheetJS jest lokalny).
  res.set('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self' https://api.pse.pl",
    "frame-ancestors 'self' http://homeassistant.local:* https://*.ui.nabu.casa",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '));
  next();
});

/* ---------- limit ciała (T20) ---------- */
app.use(express.json({ limit: '2mb' }));

/* ---------- autoryzacja (T18) ---------- */
app.use((req, res, next) => {
  if (!options.require_auth || !AUTH_TOKEN) return next();
  if (req.path === '/api/health') return next();   // potrzebne do healthcheck
  const got = req.get('X-Addon-Token') || '';
  if (got !== AUTH_TOKEN) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
});

/* ---------- health ---------- */
app.get('/api/health', (req, res) => {
  const h = kv.health();
  res.status(h.ok ? 200 : 503).json({
    ok: h.ok,
    kv: h,
    uptimeSec: Math.round(process.uptime()),
    version: require('./package.json').version || 'dev',
  });
});

/* ---------- KV ---------- */
app.get('/api/kv/:key', (req, res) => {
  try {
    const value = kv.get(req.params.key);
    if (value === undefined) { res.status(404).json({ error: 'not_found' }); return; }
    res.json({ key: req.params.key, value });
  } catch (err) {
    console.error('[kv] GET:', err.message);
    res.status(503).json({ error: err.message });
  }
});

app.put('/api/kv/:key', (req, res) => {
  if (typeof req.body.value !== 'string') {
    res.status(400).json({ error: 'Pole "value" musi być stringiem (frontend sam robi JSON.stringify).' });
    return;
  }
  try {
    kv.set(req.params.key, req.body.value);
    res.json({ key: req.params.key, value: req.body.value });
  } catch (err) {
    console.error('[kv] PUT:', err.message);
    res.status(503).json({ error: err.message });
  }
});

app.delete('/api/kv/:key', (req, res) => {
  try {
    kv.del(req.params.key);
    res.json({ key: req.params.key, deleted: true });
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

app.get('/api/kv', (req, res) => {
  try {
    res.json({ keys: kv.list(req.query.prefix || '') });
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

/* ---------- konfiguracja dla frontendu ---------- */
app.get('/api/config', (req, res) => {
  res.json({
    historyMonthsBack: options.history_months_back,
    refreshIntervalMinutes: options.refresh_interval_minutes,
    growattEntities: options.growatt_entities,
    limitsKw: options.limits_kw,
    batteryCapacityKwh: options.battery_capacity_kwh,
    batteryEta: options.battery_eta,
  });
});

/* ---------- statystyki Growatt z HA ---------- */
app.get('/api/growatt/ha-stats.csv', async (req, res) => {
  // P0-3: walidacja ZANIM dotkniemy HA. Było: new Date('śmieć') → Invalid Date
  // → RangeError w .toISOString() wewnątrz handlera WS → proces padał.
  const start = req.query.start ? haWs.asValidDate(req.query.start) : monthsAgo(options.history_months_back);
  const end = req.query.end ? haWs.asValidDate(req.query.end) : new Date();

  if (!start) { res.status(400).json({ error: 'Nieprawidłowy parametr "start": ' + req.query.start }); return; }
  if (!end) { res.status(400).json({ error: 'Nieprawidłowy parametr "end": ' + req.query.end }); return; }
  if (start >= end) { res.status(400).json({ error: '"start" musi być wcześniejsze niż "end".' }); return; }
  // Zakres 1900–2200 bez ograniczenia pozwalał żądać 300 lat statystyk
  const spanDays = (end - start) / 86400000;
  if (spanDays > 366 * 5) {
    res.status(400).json({ error: 'Zakres nie może przekraczać 5 lat (żądano ' + Math.round(spanDays) + ' dni).' });
    return;
  }

  try {
    const result = await haWs.fetchStatistics(options.growatt_entities, start, end);

    const counts = options.growatt_entities.map((id) => [id, (result[id] || []).length]);
    const empty = counts.filter(([, n]) => n === 0).map(([id]) => id);
    console.log(`[growatt] okresów na encję: ${counts.map(([id, n]) => id.replace('sensor.growatt_', '') + '=' + n).join(', ')}`);
    if (empty.length) {
      console.warn(`[growatt] UWAGA: brak danych dla: ${empty.join(', ')} — sprawdź entity_id w opcjach dodatku vs. Developer Tools → States.`);
    }

    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Cache-Control', 'no-store');
    res.send(statisticsToCsv(result));
  } catch (err) {
    console.error('[growatt] Błąd pobierania statystyk z HA:', err.message);
    res.status(502).json({ error: err.message });
  }
});

/* ---------- statyczny frontend ---------- */
app.use(express.static(path.join(__dirname, 'public'), {
  index: 'index.html',
  dotfiles: 'deny',
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.set('Cache-Control', 'no-cache');
  },
}));

// Wszystko inne → 404 JSON, nie domyślny HTML Expressa
app.use((req, res) => { res.status(404).json({ error: 'not_found' }); });

// Handler błędów — łapie m.in. przekroczenie limitu ciała
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    res.status(413).json({ error: 'Ciało żądania przekracza 2 MB.' });
    return;
  }
  console.error('[server] Nieobsłużony błąd żądania:', err && err.message);
  if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] G13 Depozyt nasłuchuje na porcie ${PORT}`);
  console.log(`[server] Encje Growatt (${options.growatt_entities.length}): ${options.growatt_entities.join(', ')}`);
  console.log(`[server] Progi kW: ${JSON.stringify(options.limits_kw)}`);
  console.log(`[server] Bateria: ${options.battery_capacity_kwh} kWh, η=${options.battery_eta}`);
  if (options.require_auth && AUTH_TOKEN) console.log('[server] Autoryzacja: WŁĄCZONA (X-Addon-Token)');
  else console.warn('[server] Autoryzacja: wyłączona — dodatek dostępny dla każdego w sieci. Ustaw require_auth + ADDON_TOKEN jeśli port jest wystawiony.');
  const h = kv.health();
  if (!h.ok) console.error('[server] MAGAZYN KV USZKODZONY — kopia: ' + h.degraded.backupPath);
});

/* ---------- graceful shutdown (SIGTERM) ----------
 * config.yaml ma init:false, więc Node jest PID 1 i dostaje SIGTERM
 * bezpośrednio od Supervisora. Bez tego handlera HA ubijał proces po 10 s
 * w trakcie zapisu KV. */
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} — zamykam w ciągu 8 s.`);
  const force = setTimeout(() => { console.error('[server] Wymuszone zamknięcie.'); process.exit(1); }, 8000);
  force.unref();
  server.close(() => { clearTimeout(force); console.log('[server] Zamknięto czysto.'); process.exit(0); });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Ostatnia siatka bezpieczeństwa — logujemy, ale nie udajemy, że wszystko OK.
process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandledRejection:', reason && reason.message ? reason.message : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[server] uncaughtException:', err && err.stack ? err.stack : err);
  shutdown('uncaughtException');
});
