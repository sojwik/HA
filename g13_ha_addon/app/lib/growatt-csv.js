'use strict';

// Formatuje datę w strefie Europe/Warsaw jako "YYYY-MM-DD HH:mm:ss".
// Ważne: HA może zwrócić start okresu jako timestamp UTC - konwersja na czas
// lokalny jest potrzebna, żeby przypisanie do dnia/miesiąca (np. wiersz o
// 00:30 czasu polskiego 1 lutego) nie "spadło" błędnie na styczeń przez samo
// obcięcie surowego UTC. Intl.DateTimeFormat sam uwzględnia czas letni/zimowy.
const WARSAW_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Warsaw',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false,
});

function toWarsawString(rawStart) {
  // HA WS API (recorder/statistics_during_period) zwraca start/end jako
  // milisekundy od epoki (ten sam format co JS Date.now()) - NIE sekundy.
  // Potwierdzone na żywych danych: surowa wartość ~1.79e12 odpowiada
  // lipcowi 2026 jako milisekundy; jako sekundy (błędne *1000) wychodził
  // rok ~58000, co tłumaczyło odrzucanie wszystkich wierszy przy parsowaniu
  // dat po stronie frontendu.
  const d = new Date(rawStart);
  const parts = WARSAW_FORMATTER.formatToParts(d).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

/**
 * @param {Object} statisticsResult - wynik z ha-ws.fetchStatistics(): mapa statistic_id -> tablica okresów
 * @returns {string} tekst CSV z kolumnami statistic_id,start,sum,delta (nagłówki jak w eksporcie HA)
 */
function statisticsToCsv(statisticsResult) {
  const lines = ['statistic_id,start,sum,delta'];

  Object.keys(statisticsResult).forEach((statId) => {
    const periods = statisticsResult[statId] || [];
    let prevSum = null;
    periods.forEach((p) => {
      const sum = (p.sum === null || p.sum === undefined) ? '' : p.sum;
      let delta = (p.change === null || p.change === undefined) ? null : p.change;
      if (delta === null && typeof p.sum === 'number' && prevSum !== null) {
        delta = p.sum - prevSum; // zapasowe wyliczenie, gdy "change" niedostępne w tej wersji HA
      }
      if (typeof p.sum === 'number') prevSum = p.sum;
      if (delta === null || delta === undefined || isNaN(delta)) return; // brak danych dla tego okresu - pomijamy wiersz, nie zerujemy
      lines.push(`${statId},${toWarsawString(p.start)},${sum},${delta}`);
    });
  });

  return lines.join('\n') + '\n';
}

module.exports = { statisticsToCsv, toWarsawString };
