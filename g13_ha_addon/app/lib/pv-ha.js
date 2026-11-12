'use strict';
/* Tylko ścieżka PV. Stare ha-ws / eksporty Growatt pozostają bez zmian.
 * Metadane recorder + jawna normalizacja mocy. Nie rozpoznajemy W/kW
 * po wielkości wartości, nazwie encji ani aktualnym stanie sensora. */
const WebSocket = require('ws');
const { asValidDate } = require('./ha-ws');
const { anyStatsToCsv } = require('./growatt-csv');
const TYPES = ['change', 'sum', 'mean', 'min', 'max'];
function validate(ids, start, end, powerId) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 40 || new Set(ids).size !== ids.length
    || ids.some(id => typeof id !== 'string' || !/^[a-z_]+\.[a-z0-9_]+$/.test(id)))
    throw new Error('PV: wymagane 1–40 różnych, poprawnych encji.');
  const utcHour = value => typeof value === 'string' && /^20\d{2}-\d{2}-\d{2}T\d{2}:00:00(?:\.000)?Z$/.test(value)
    && asValidDate(value) && new Date(value).toISOString().replace('.000Z', 'Z') === value.replace('.000Z', 'Z');
  if (!utcHour(start) || !utcHour(end) || +new Date(end) <= +new Date(start)
    || +new Date(end) - +new Date(start) > 62 * 86400000)
    throw new Error('PV: wymagany poprawny zakres UTC, najwyżej 62 dni na część.');
  if (powerId && !ids.includes(powerId)) throw new Error('PV: encja mocy musi należeć do żądanych encji.');
}
function fetchPvStatistics(ids, start, end, powerId = '') {
  try { validate(ids, start, end, powerId); } catch (e) { return Promise.reject(e); }
  const token = process.env.SUPERVISOR_TOKEN;
  if (!token) return Promise.reject(new Error('Brak SUPERVISOR_TOKEN dla odczytu statystyk PV.'));
  return new Promise((resolve, reject) => {
    let ws, finished = false, powerUnit = null, stage = 'auth';
    const timeout = setTimeout(() => finish(new Error('Przekroczono czas odczytu HA dla PV.')), 45000);
    function finish(error, value) {
      if (finished) return;
      finished = true; clearTimeout(timeout);
      try { if (ws) ws.close(); } catch (_) {}
      if (error) reject(error); else resolve(value);
    }
    function stats() {
      stage = 'stats';
      ws.send(JSON.stringify({ id: 2, type: 'recorder/statistics_during_period',
        statistic_ids: ids, start_time: new Date(start).toISOString(), end_time: new Date(end).toISOString(),
        period: 'hour', types: TYPES, units: { energy: 'kWh', power: 'kW' } }));
    }
    try { ws = new WebSocket(process.env.HA_WS_URL || 'ws://supervisor/core/websocket', { maxPayload: 16 * 1024 * 1024 }); }
    catch (e) { finish(e); return; }
    ws.on('message', raw => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'auth_required' && stage === 'auth') {
          ws.send(JSON.stringify({ type: 'auth', access_token: token })); return;
        }
        if (msg.type === 'auth_invalid') { finish(new Error('Autoryzacja HA dla PV nieudana.')); return; }
        if (msg.type === 'auth_ok' && stage === 'auth') {
          if (!powerId) { stats(); return; }
          stage = 'metadata';
          ws.send(JSON.stringify({ id: 1, type: 'recorder/get_statistics_metadata', statistic_ids: [powerId] })); return;
        }
        if (msg.type !== 'result') return;
        if (msg.id === 1 && stage === 'metadata') {
          // Brak metadanych nie zabiera liczników kWh; moc pozostaje nieznana.
          if (msg.success && Array.isArray(msg.result)) {
            const matches = msg.result.filter(m => m && m.statistic_id === powerId);
            if (matches.length === 1 && ['W', 'kW'].includes(matches[0].unit_of_measurement)
              && (matches[0].unit_class == null || matches[0].unit_class === 'power')) powerUnit = 'kW';
          }
          stats(); return;
        }
        if (msg.id === 2 && stage === 'stats') {
          if (!msg.success) { finish(new Error('HA odrzucił odczyt/normalizację statystyk PV.')); return; }
          if (!msg.result || typeof msg.result !== 'object' || Array.isArray(msg.result)) throw new Error('Nieprawidłowa odpowiedź statystyk PV.');
          const series = Object.create(null);
          for (const id of ids) {
            const rows = msg.result[id] === undefined ? [] : msg.result[id];
            if (!Array.isArray(rows) || rows.some(r => !r || typeof r !== 'object')) throw new Error('Nieprawidłowe wiersze statystyk PV.');
            series[id] = rows;
          }
          finish(null, { series, powerId, powerUnit });
        }
      } catch (e) { finish(new Error('Odczyt statystyk PV: ' + e.message)); }
    });
    ws.on('error', e => finish(new Error('Połączenie HA dla PV: ' + e.message)));
    ws.on('close', () => finish(new Error('HA zamknął odczyt PV przed odpowiedzią.')));
  });
}
function toCsv(result) {
  const lines = anyStatsToCsv(result.series, TYPES).trimEnd().split('\n');
  // Serializer bazowy emituje wyłącznie zwalidowane ID/czas/liczby. Jednostka
  // dotyczy tylko wskazanego kanału diagnostycznego, nie energii ani SOC.
  return lines.map((line, i) => line + ',' + (i === 0 ? 'power_unit'
    : result.powerUnit === 'kW' && line.split(',')[0] === result.powerId ? 'kW' : '')).join('\n') + '\n';
}
async function handler(req, res) {
  const ids = typeof req.query.entities === 'string' ? req.query.entities.split(',').map(s => s.trim()).filter(Boolean) : [];
  const powerId = typeof req.query.power_entity === 'string' ? req.query.power_entity : '';
  const start = req.query.start, end = req.query.end;
  try {
    validate(ids, start, end, powerId);
    if (req.query.power_entity !== undefined && typeof req.query.power_entity !== 'string') throw new Error('PV: power_entity musi być pojedynczym identyfikatorem.');
    if (req.query.types !== undefined && req.query.types !== TYPES.join(',')) throw new Error('PV: wymagane types=change,sum,mean,min,max.');
  } catch (e) { res.status(400).json({ error: e.message }); return; }
  try {
    const result = await fetchPvStatistics(ids, start, end, powerId);
    res.set('Content-Type', 'text/csv; charset=utf-8'); res.set('Cache-Control', 'no-store');
    res.set('Content-Disposition', 'attachment; filename="pv-ha-statistics.csv"');
    res.send(toCsv(result));
  } catch (e) { res.status(502).json({ error: e.message }); }
}
module.exports = { fetchPvStatistics, toCsv, handler };
