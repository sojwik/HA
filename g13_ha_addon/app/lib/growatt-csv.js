'use strict';

/* ============================================================================
 * growatt-csv.js — statystyki HA → CSV dla frontendu
 *
 * POPRAWKI:
 *  DST (audyt cz. 1 T5/T12, potwierdzone na danych 25.10.2026):
 *    Eksport miał tylko kolumnę `start` z czasem LOKALNYM. W dniu zmiany czasu
 *    02:00 występuje dwa razy → klucz 'data_godzina' kolidował i druga godzina
 *    nadpisywała pierwszą (utrata 1,9 kWh na sześciu sensorach).
 *    Teraz dochodzi kolumna `start_utc` — zawsze unikalna, kluczowana po UTC.
 *    `start` zostaje jako etykieta lokalna do wyświetlania i wstecznej zgodności.
 *
 *  hourCycle: 'h23' zamiast hour12:false — to drugie w niektórych wersjach ICU
 *    daje „24:00" dla północy, co łamało parsowanie godziny.
 *
 *  `delta`: HA zwraca `change` (reset-aware) oraz `sum`. Eksport użytkownika
 *    miał delta == Δsum dokładnie, czyli był to zwykły przyrost sumy, NIE
 *    reset-aware `change`. Dlatego wyprowadzamy OBIE kolumny: `delta` (change
 *    gdy dostępny) i `delta_sum` (Δsum), żeby frontend mógł je porównać.
 * ==========================================================================*/

const WARSAW_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Warsaw',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23',
});

function toWarsawString(rawStart) {
  // HA WS API zwraca start jako milisekundy od epoki (nie sekundy).
  const d = new Date(rawStart);
  if (!isFinite(d.getTime())) return '';
  const parts = WARSAW_FORMATTER.formatToParts(d)
    .reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

/** Klucz godzinowy odporny na zmianę czasu — zawsze unikalny. */
function toUtcKey(rawStart) {
  const d = new Date(rawStart);
  if (!isFinite(d.getTime())) return '';
  return d.toISOString().slice(0, 19) + 'Z';
}

/**
 * @param {Object} statisticsResult mapa statistic_id -> tablica okresów
 * @returns {string} CSV: statistic_id,start,start_utc,sum,delta,delta_sum
 */
function statisticsToCsv(statisticsResult) {
  const lines = ['statistic_id,start,start_utc,sum,delta,delta_sum'];

  Object.keys(statisticsResult).forEach((statId) => {
    const periods = statisticsResult[statId] || [];
    let prevSum = null;

    periods.forEach((p) => {
      const localStr = toWarsawString(p.start);
      const utcKey = toUtcKey(p.start);
      if (!utcKey) return; // nieparsowalny timestamp — pomijamy, nie zerujemy

      const hasSum = typeof p.sum === 'number' && isFinite(p.sum);
      const sum = hasSum ? p.sum : '';

      // delta_sum: zwykły przyrost sumy (to widział eksport użytkownika)
      let deltaSum = null;
      if (hasSum && prevSum !== null) deltaSum = p.sum - prevSum;
      if (hasSum) prevSum = p.sum;

      // delta: preferujemy reset-aware `change` z HA
      let delta = (typeof p.change === 'number' && isFinite(p.change)) ? p.change : null;
      if (delta === null) delta = deltaSum;

      if (delta === null || !isFinite(delta)) return; // brak danych — pomijamy wiersz

      lines.push([
        statId,
        localStr,
        utcKey,
        sum,
        delta,
        deltaSum === null ? '' : deltaSum,
      ].join(','));
    });
  });

  return lines.join('\n') + '\n';
}

module.exports = { statisticsToCsv, toWarsawString, toUtcKey };
