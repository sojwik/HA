'use strict';

// Dostęp do Core API przez Supervisora - działa automatycznie w dodatku HA
// dzięki "homeassistant_api: true" w config.yaml (token wstrzykiwany jako
// SUPERVISOR_TOKEN, bez ręcznego tworzenia long-lived access token).
const WebSocket = require('ws');

const SUPERVISOR_TOKEN = process.env.SUPERVISOR_TOKEN;
const WS_URL = process.env.HA_WS_URL || 'ws://supervisor/core/websocket';
const REQUEST_TIMEOUT_MS = 30000;

/**
 * Pobiera długoterminowe statystyki (recorder) dla podanych encji w zadanym
 * przedziale czasu, z granulacją godzinową. To ten sam mechanizm co
 * "import_statistics.export_statistics" (bezterminowe statystyki), NIE
 * surowy stan encji (/api/history/period), który w Home Assistant domyślnie
 * sięga tylko ok. 10 dni wstecz.
 *
 * @param {string[]} statisticIds
 * @param {Date} startDate
 * @param {Date} endDate
 * @returns {Promise<Object>} mapa statistic_id -> tablica {start, sum, change}
 */
function fetchStatistics(statisticIds, startDate, endDate) {
  return new Promise((resolve, reject) => {
    if (!SUPERVISOR_TOKEN) {
      reject(new Error('Brak SUPERVISOR_TOKEN w środowisku — sprawdź, czy config.yaml ma "homeassistant_api: true".'));
      return;
    }

    const ws = new WebSocket(WS_URL);
    const requestId = 1;
    let settled = false;

    const timeout = setTimeout(() => {
      finish(new Error('Przekroczono czas oczekiwania na odpowiedź Home Assistant (WS API).'));
    }, REQUEST_TIMEOUT_MS);

    function finish(err, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { ws.close(); } catch (e) { /* noop */ }
      if (err) reject(err); else resolve(result);
    }

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (e) { return; }

      if (msg.type === 'auth_required') {
        ws.send(JSON.stringify({ type: 'auth', access_token: SUPERVISOR_TOKEN }));
        return;
      }
      if (msg.type === 'auth_invalid') {
        finish(new Error('Autoryzacja WS API nieudana: ' + msg.message));
        return;
      }
      if (msg.type === 'auth_ok') {
        ws.send(JSON.stringify({
          id: requestId,
          type: 'recorder/statistics_during_period',
          start_time: startDate.toISOString(),
          end_time: endDate.toISOString(),
          statistic_ids: statisticIds,
          period: 'hour',
          // Prosimy zarówno o "change" (gotowy przyrost okresu) jak i "sum"
          // (narastający licznik) - w server.js liczymy deltę z "sum" jako
          // zapasowe rozwiązanie, gdyby "change" nie było wspierane przez
          // wersję HA.
          types: ['change', 'sum'],
        }));
        return;
      }
      if (msg.id === requestId && msg.type === 'result') {
        if (!msg.success) {
          finish(new Error('Home Assistant zwrócił błąd: ' + JSON.stringify(msg.error)));
          return;
        }
        finish(null, msg.result || {});
      }
    });

    ws.on('error', (err) => finish(new Error('Błąd połączenia WS z Home Assistant: ' + err.message)));
    ws.on('close', () => finish(new Error('Połączenie WS zamknięte zanim nadeszła odpowiedź.')));
  });
}

module.exports = { fetchStatistics };
