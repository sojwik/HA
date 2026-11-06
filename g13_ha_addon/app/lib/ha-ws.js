'use strict';

/* ============================================================================
 * ha-ws.js — długoterminowe statystyki z HA przez WebSocket Core API
 *
 * POPRAWKI:
 *  P0-3 (audyt cz. 2): startDate/endDate bez walidacji → new Date('śmieć')
 *    dawało Invalid Date, .toISOString() rzucało RangeError wewnątrz handlera
 *    WebSocket → nieobsłużony wyjątek → proces padał z kodem 1 (brak watchdog).
 *    Teraz walidacja PRZED otwarciem gniazda + zwracany jest odrzucony Promise.
 *
 *  P1-10 (audyt cz. 2): brak `units` w zapytaniu → HA mogło zwrócić Wh zamiast
 *    kWh (1000×). Na tych 6 encjach wszystkie są w kWh, więc błąd był utajony,
 *    ale jawna prośba o kWh usuwa ryzyko przy zmianie integracji.
 * ==========================================================================*/

const WebSocket = require('ws');

const SUPERVISOR_TOKEN = process.env.SUPERVISOR_TOKEN;
const WS_URL = process.env.HA_WS_URL || 'ws://supervisor/core/websocket';
const REQUEST_TIMEOUT_MS = 30000;

/** Rzeczywista data albo null. Odrzuca Invalid Date, stringi-śmieci, NaN. */
function asValidDate(v) {
  if (v instanceof Date) return isFinite(v.getTime()) ? v : null;
  if (typeof v === 'number' && isFinite(v)) {
    const d = new Date(v);
    return isFinite(d.getTime()) ? d : null;
  }
  if (typeof v === 'string' && v.trim()) {
    const d = new Date(v);
    return isFinite(d.getTime()) ? d : null;
  }
  return null;
}

/**
 * @param {string[]} statisticIds
 * @param {Date|string|number} startDate
 * @param {Date|string|number} endDate
 * @returns {Promise<Object>} mapa statistic_id -> [{start, sum, change}]
 */
function fetchStatistics(statisticIds, startDate, endDate) {
  return new Promise((resolve, reject) => {
    // --- walidacja PRZED side-effectami (P0-3) ---
    if (!Array.isArray(statisticIds) || statisticIds.length === 0) {
      reject(new Error('fetchStatistics: lista statistic_ids jest pusta lub nie jest tablicą.'));
      return;
    }
    const bad = statisticIds.filter((id) => typeof id !== 'string' || !id.includes('.'));
    if (bad.length) {
      reject(new Error('fetchStatistics: nieprawidłowe entity_id: ' + bad.join(', ')));
      return;
    }
    const start = asValidDate(startDate);
    const end = asValidDate(endDate);
    if (!start) {
      reject(new Error('fetchStatistics: nieprawidłowa data początkowa: ' + JSON.stringify(startDate)));
      return;
    }
    if (!end) {
      reject(new Error('fetchStatistics: nieprawidłowa data końcowa: ' + JSON.stringify(endDate)));
      return;
    }
    if (start >= end) {
      reject(new Error('fetchStatistics: data początkowa musi być wcześniejsza niż końcowa.'));
      return;
    }
    if (!SUPERVISOR_TOKEN) {
      reject(new Error('Brak SUPERVISOR_TOKEN w środowisku — sprawdź, czy config.yaml ma "homeassistant_api: true".'));
      return;
    }

    let ws;
    try {
      ws = new WebSocket(WS_URL);
    } catch (err) {
      reject(new Error('Nie mogę otworzyć gniazda WS (' + WS_URL + '): ' + err.message));
      return;
    }

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
      // Cały handler w try/catch — żaden wyjątek stąd nie może wydostać się
      // do pętli zdarzeń jako uncaughtException.
      try {
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
            start_time: start.toISOString(),
            end_time: end.toISOString(),
            statistic_ids: statisticIds,
            period: 'hour',
            types: ['change', 'sum'],
            // P1-10: jawnie prosimy o kWh. Bez tego HA zwraca jednostkę
            // statystyki, która po zmianie integracji może być Wh.
            units: { energy: 'kWh' },
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
      } catch (err) {
        finish(new Error('Błąd obsługi odpowiedzi WS: ' + err.message));
      }
    });

    ws.on('error', (err) => finish(new Error('Błąd połączenia WS z Home Assistant: ' + err.message)));
    ws.on('close', () => finish(new Error('Połączenie WS zamknięte zanim nadeszła odpowiedź.')));
  });
}

module.exports = { fetchStatistics, asValidDate };
