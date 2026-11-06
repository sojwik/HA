'use strict';

/* ============================================================================
 * validate.js — walidacja pomiarów Growatt / HA
 *
 * Ten plik działa w dwóch środowiskach:
 *   - Node:      const V = require('./lib/validate');
 *   - przeglądarka: <script src="validate.js"></script>  →  window.G13Validate
 *
 * Źródła progów: WIT 12K-HU (13,2 kW max moc pozorna, bateria 250 A @ 40–60 V)
 * oraz moc umowna 16 kW. Wartości są KONFIGUROWALNE per instalacja — nie zaszyte.
 *
 * Wykryte na realnych danych (bilans_growatt.csv, 5222 h × 6 sensorów):
 *   - 188 ujemnych delt poboru (kwiecień: 86 h, −153,6 kWh)
 *   - 4 przekroczenia fizyczne (3 skoki lipca + 42,2 kWh produkcji 15.04)
 *   - wrzesień/październik: rozstęp implied SOC 5,6× i 9,8× pojemności baterii
 * ==========================================================================*/

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.G13Validate = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  /* --------------------------------------------------------------------------
   * Konfiguracja domyślna — pod WIT 12K-HU + przyłącze 16 kW + 16S 280 Ah.
   * Użytkownik może nadpisać każdą wartość przez opcje dodatku.
   * ------------------------------------------------------------------------*/
  const DEFAULT_LIMITS = {
    limitsKw: {
      produkcja:    13.2,  // AC max moc pozorna falownika
      oddanieHa:    13.2,
      poborHa:      16.0,  // moc umowna przyłącza
      zuzycieDomu:  29.2,  // moc umowna + AC falownika
      ladowanie:    14.6,  // 250 A × 58,4 V (16S @ 3,65 V szczyt) — moc, nie energia
      rozladowanie: 14.6,
    },
    margin: 1.10,          // 10% na zaokrąglenia i przesunięcie próbkowania
    // 16S LiFePO4 280 Ah przy napięciu NOMINALNYM 3,2 V/ogniwo = 14,34 kWh.
    // Wcześniej 16,35 kWh, czyli 3,65 V — to napięcie SZCZYTOWE ładowania,
    // nie nominalne, i zawyżało pojemność o 14%.
    batteryCapacityKwh: 14.34,
    batteryEta: 0.92,
    // Sprawność po stronie DC, czyli tam, gdzie mierzy BMS. Wyznaczona z TYCH
    // SAMYCH 46 zdrowych dób, na których wyznaczono 0.92 dla AC:
    //   BMS (DC):      524,9 / 562,2 = 0,9335
    //   Growatt (AC):  514,9 / 562,7 = 0,9151
    // Różnica 2% to strata falownika. Zaokrąglone w górę tak samo jak 0.92
    // względem zmierzonego 0.9171 — żeby nie robić fałszywych alarmów.
    // Bez tego październik liczony z BMS (338,3 / 347,8 = 0,973) nadal byłby
    // oznaczony jako niemożliwy, mimo że jest w pełni poprawny.
    batteryEtaDc: 0.94,
    maxGapHours: 24,       // dłuższa luka → nie ufamy delcie jako jednemu oknu
    // BMS vs Growatt (audyt cz. 12). Poza oknem usterki źródła różniły się
    // o 0,1% (ładowanie) i 1,9% (rozładowanie) — to strata falownika DC→AC.
    // 10% jest więc safely powyżej szumu, a 115% z okna 24.09–11.10 łapie się
    // z ogromnym zapasem.
    bmsTolerancePct: 10,
    // Gdy BMS pokrywa mniej niż 90% godzin Growatt, podmiana zaniżyłaby
    // miesiąc. Wtedy zostajemy przy Growatt i tylko ostrzegamy.
    bmsMinCoverage: 0.90,
  };

  function resolveConfig(overrides) {
    const o = overrides || {};
    return {
      limitsKw: Object.assign({}, DEFAULT_LIMITS.limitsKw, o.limitsKw || {}),
      margin: typeof o.margin === 'number' ? o.margin : DEFAULT_LIMITS.margin,
      batteryCapacityKwh: typeof o.batteryCapacityKwh === 'number'
        ? o.batteryCapacityKwh : DEFAULT_LIMITS.batteryCapacityKwh,
      batteryEta: typeof o.batteryEta === 'number' ? o.batteryEta : DEFAULT_LIMITS.batteryEta,
      batteryEtaDc: typeof o.batteryEtaDc === 'number' ? o.batteryEtaDc : DEFAULT_LIMITS.batteryEtaDc,
      maxGapHours: typeof o.maxGapHours === 'number' ? o.maxGapHours : DEFAULT_LIMITS.maxGapHours,
      bmsTolerancePct: typeof o.bmsTolerancePct === 'number'
        ? o.bmsTolerancePct : DEFAULT_LIMITS.bmsTolerancePct,
      bmsMinCoverage: typeof o.bmsMinCoverage === 'number'
        ? o.bmsMinCoverage : DEFAULT_LIMITS.bmsMinCoverage,
    };
  }

  /* --------------------------------------------------------------------------
   * acceptDelta — czy pojedynczy przyrost licznika jest fizycznie możliwy.
   *
   * KLUCZOWE: próg skaluje się długością okna. Po luce w komunikacji delta
   * obejmuje wiele godzin, więc sztywny próg godzinowy odrzucałby poprawne
   * pomiary (11.04 zużycie 30,2 kWh w oknie 20 h = 1,51 kW średnio).
   *
   * @param {string} role        klucz z limitsKw
   * @param {number} delta       przyrost w kWh
   * @param {number|null} prevMs timestamp poprzedniego okresu (ms) lub null
   * @param {number|null} curMs  timestamp bieżącego okresu (ms) lub null
   * @param {object} cfg         wynik resolveConfig()
   * @returns {{ok:boolean, reason?:string, limit:number, hours:number}}
   * ------------------------------------------------------------------------*/
  function acceptDelta(role, delta, prevMs, curMs, cfg) {
    const c = cfg || resolveConfig();
    const kw = c.limitsKw[role];

    let hours = 1;
    if (typeof prevMs === 'number' && typeof curMs === 'number'
        && isFinite(prevMs) && isFinite(curMs)) {
      const span = (curMs - prevMs) / 3600000;
      // span <= 0 zdarza się przy zmianie czasu (25.10.2026 02:00 występuje 2×)
      hours = span > 0 ? Math.min(span, c.maxGapHours) : 1;
    }

    // Nieznana rola → nie blokujemy, ale sygnalizujemy (lepsze niż ciche zero)
    if (typeof kw !== 'number') {
      if (!isFinite(delta)) return { ok: false, reason: 'nie-liczba', limit: Infinity, hours };
      if (delta < 0) return { ok: false, reason: 'ujemna delta', limit: Infinity, hours };
      return { ok: true, limit: Infinity, hours, unknownRole: true };
    }

    const limit = kw * hours * c.margin;
    if (!isFinite(delta)) return { ok: false, reason: 'nie-liczba', limit, hours };
    if (delta < 0) return { ok: false, reason: 'ujemna delta', limit, hours };
    if (delta > limit) {
      return {
        ok: false,
        reason: 'przekroczenie ' + limit.toFixed(1) + ' kWh / ' + hours.toFixed(0) + ' h',
        limit, hours,
      };
    }
    return { ok: true, limit, hours };
  }

  /* --------------------------------------------------------------------------
   * RejectionLog — odrzucenia muszą być WIDOCZNE, nie ciche.
   * ------------------------------------------------------------------------*/
  function createRejectionLog() {
    const byRole = {};
    // Podział na miesiące MUSI być liczony tutaj, a nie sklejany później.
    // Wcześniej frontend przypisywał całemu miesiącowi jeden globalny summary,
    // więc 192 odrzucone godziny pokazywały się w każdym z 9 miesięcy,
    // a nagłówek sumował je do 1728 (9×).
    const byMonth = {};
    // Dwa osobne koszyki: przekroczenia są rzadsze i ważniejsze diagnostycznie,
    // więc nie mogą zostać wyparte przez masę ujemnych delt (kwiecień: 86 h).
    const overLimitSamples = [];
    const negativeSamples = [];
    let total = 0;
    let rejectedKwh = 0;

    return {
      add(role, ts, delta, verdict) {
        total++;
        if (!byRole[role]) byRole[role] = { count: 0, kwh: 0, negative: 0, overLimit: 0 };
        byRole[role].count++;
        byRole[role].kwh += delta;
        rejectedKwh += delta;
        const mk = monthKeyFromUtc(ts);
        if (!byMonth[mk]) byMonth[mk] = { total: 0, rejectedKwh: 0, byRole: {} };
        const bm = byMonth[mk];
        bm.total++;
        bm.rejectedKwh += delta;
        if (!bm.byRole[role]) bm.byRole[role] = { count: 0, kwh: 0, negative: 0, overLimit: 0 };
        bm.byRole[role].count++;
        bm.byRole[role].kwh += delta;
        const rec = { role, ts, delta, reason: verdict.reason };
        if (verdict.reason === 'ujemna delta') {
          byRole[role].negative++;
          bm.byRole[role].negative++;
          if (negativeSamples.length < 30) negativeSamples.push(rec);
        } else {
          byRole[role].overLimit++;
          bm.byRole[role].overLimit++;
          if (overLimitSamples.length < 60) overLimitSamples.push(rec);
        }
      },
      summary() {
        return {
          total,
          rejectedKwh: Math.round(rejectedKwh * 100) / 100,
          byRole,
          // Zaokrąglamy per miesiąc tak samo jak sumę globalną.
          byMonth: Object.keys(byMonth).reduce(function(acc, k){
            acc[k] = { total: byMonth[k].total,
                       rejectedKwh: Math.round(byMonth[k].rejectedKwh * 100) / 100,
                       byRole: byMonth[k].byRole };
            return acc;
          }, {}),
          overLimitSamples,
          negativeSamples,
          samples: overLimitSamples.concat(negativeSamples),
        };
      },
      get total() { return total; },
    };
  }

  /* --------------------------------------------------------------------------
   * validateBatteryMonth — test rozstępu implied SOC.
   *
   * B(t) = Σ(ładowanie × η − rozładowanie). Skoro 0 ≤ SOC ≤ pojemność,
   * rozstęp max(B) − min(B) nie może przekroczyć pojemności. Test NIE wymaga
   * znajomości SOC początkowego.
   *
   * Walidacja na realnych danych (pojemność 14,34 kWh, η = 0,92, próg 1,20×):
   *   sierpień    16,4 kWh → 1,14×  ✓ (miesiąc referencyjny)
   *   kwiecień    27,1 kWh → 1,89×  ✗
   *   wrzesień    91,9 kWh → 6,41×  ✗
   *   październik 159,4 kWh → 11,12× ✗
   *
   * UWAGA: ten test wykrywa błąd, którego filtr godzinowy NIE widzi — wszystkie
   * godziny września i października mieszczą się w progach mocy.
   * ------------------------------------------------------------------------*/
  function validateBatteryMonth(hours, cfg) {
    const c = cfg || resolveConfig();
    let B = 0, lo = 0, hi = 0;
    let charge = 0, discharge = 0, n = 0;

    for (const h of hours) {
      const ch = Number(h.ladowanie);
      const dis = Number(h.rozladowanie);
      if (!isFinite(ch) || !isFinite(dis)) continue;
      charge += ch; discharge += dis; n++;
      B += ch * c.batteryEta - dis;
      if (B < lo) lo = B;
      if (B > hi) hi = B;
    }

    const range = hi - lo;
    const cap = c.batteryCapacityKwh;
    // Tolerancja 20%, nie 2%. Liczniki mierzą energię na ZACISKACH baterii,
    // a nie przy napięciu nominalnym:
    //   - ładowanie idzie przy ~3,35 V/ogniwo (+5% wobec 3,2 V),
    //   - ogniwa 280 Ah nowe często mają realnie 290-300 Ah (+3-7%),
    //   - dryf próbkowania liczników narasta przez ~730 h miesiąca.
    // Przy 2% zdrowe miesiące (lipiec 15,9 kWh, sierpień 16,4 kWh) były
    // oznaczane jako uszkodzone. Przy 20% przechodzą, a realne usterki
    // nadal odpadają z ogromnym zapasem: wrzesień 6,4x, październik 11,1x.
    const plausible = range <= cap * 1.20;

    // Twardy limit: nawet pełna bateria na start i pusta na koniec, η = 1,00
    const hardMax = charge + cap;
    const hardExcess = discharge - hardMax;

    return {
      hours: n,
      charge: round2(charge),
      discharge: round2(discharge),
      socRange: round2(range),
      capacity: cap,
      ratio: cap > 0 ? round2(range / cap) : null,
      plausible,
      apparentEfficiency: charge > 0 ? round2(discharge / charge * 100) : null,
      hardExcess: round2(hardExcess),
      hardImpossible: hardExcess > 0.5,
      reason: !plausible
        ? ('rozstęp SOC ' + range.toFixed(1) + ' kWh = ' + (range / cap).toFixed(1)
           + '× pojemność ' + cap.toFixed(2) + ' kWh')
        : null,
    };
  }

  /*--------------------------------------------------------------------------
   * validateBatteryTotal — D6: bilans ZBIORCZY całego okresu.
   *
   * Test miesięczny łapie pojedyncze miesiące, ale wiersz SUMA mógł pokazywać
   * więcej rozładowania niż ładowania bez żadnego komentarza. Na realnych
   * danych: 2442,1 kWh oddane z 2398,9 kWh przyjętych.
   *
   * Maksimum fizyczne: cała energia weszła przy sprawności η, a bateria
   * wystartowała PEŁNA i skończyła PUSTA:
   *     maxDischarge = η × (charge + capacity)
   * To zawyżenie na korzyść danych — realnie bateria nie zaczyna okresu
   * pełna ani nie kończy pusta. Jeśli mimo tego rozładowanie jest większe,
   * liczniki są niespójne.
   *
   * Uwaga: sama sprawność pozorna (discharge/charge) nie wystarcza jako test,
   * bo dla krótkiego okresu start z pełnej paczki może ją legalnie podnieść.
   * ------------------------------------------------------------------------*/
  function validateBatteryTotal(months, cfg) {
    const c = cfg || resolveConfig();
    const cap = c.batteryCapacityKwh;
    const eta = c.batteryEta;
    let charge = 0, discharge = 0, n = 0;
    // Każdy miesiąc może mieć WŁASNĄ sprawność, bo może pochodzić z innego
    // źródła: BMS mierzy DC (η 0,94), Growatt AC (η 0,92). Liczenie całości
    // jedną sprawnością AC zawyżałoby nadmiar dla miesięcy z BMS.
    //   maxDischarge = Σ ηᵢ × chargeᵢ + max(ηᵢ) × capacity
    // Pojemność startowa należy do najbardziej korzystnej sprawności — to
    // zawyżenie na korzyść danych, tak jak w pierwotnym wzorze.
    let maxFromCharge = 0, etaMax = 0, etaWeighted = 0;
    (months || []).forEach(function (m) {
      if (!m) return;
      const ch = Number(m.ladowanie), dis = Number(m.rozladowanie);
      const e = (typeof m.eta === 'number' && isFinite(m.eta) && m.eta > 0 && m.eta <= 1)
        ? m.eta : eta;
      if (isFinite(ch)) {
        charge += ch;
        const pos = Math.max(0, ch);
        maxFromCharge += e * pos;
        etaWeighted += e * pos;
      }
      if (isFinite(dis)) discharge += dis;
      if (e > etaMax) etaMax = e;
      n++;
    });
    if (!n) etaMax = eta;
    const maxDischarge = maxFromCharge + etaMax * cap;
    const etaEffective = charge > 0 ? etaWeighted / charge : eta;
    const excess = discharge - maxDischarge;
    // Próg 0,5 kWh jak w twardym limicie miesięcznym — poniżej tego to szum
    // zaokrągleń liczników (0,1 kWh na godzinę).
    const impossible = excess > 0.5;
    return {
      months: n,
      charge: round2(charge),
      discharge: round2(discharge),
      capacity: cap,
      eta: round2(etaEffective),
      apparentEfficiency: charge > 0 ? round2(discharge / charge * 100) : null,
      maxDischarge: round2(maxDischarge),
      excess: round2(excess),
      impossible: impossible,
      reason: impossible
        ? ('rozładowano ' + discharge.toFixed(1) + ' kWh z ' + charge.toFixed(1)
           + ' kWh naładowanych; maksimum przy sprawności ' + eta.toFixed(2)
           + ' i starcie z pełnej paczki to ' + maxDischarge.toFixed(1)
           + ' kWh — nadmiar ' + excess.toFixed(1) + ' kWh')
        : null,
    };
  }

  /* --------------------------------------------------------------------------
   * reconcileBatteryMonth — które źródło liczy baterię: BMS czy Growatt.
   *
   * POWÓD (audyt cz. 12, pomiar rozstrzygający). W oknie 24.09–11.10.2026
   * liczniki Growatt pokazały 342,0 kWh rozładowania, a BMS po stronie DC
   * 158,7 kWh (+115%). Ładowanie odwrotnie: 124,6 kWh z Growatt przy 158,0 kWh
   * z BMS (−21%). Poza tym oknem, na 46 dobach, źródła zgadzały się na 0,1%
   * (ładowanie) i 1,9% (rozładowanie) — ta druga różnica to strata falownika.
   *
   * BMS mierzy prąd i napięcie na ZACISKACH paczki, więc nie zależy od mapy
   * rejestrów falownika ani od wersji integracji Growatt. Dlatego gdy jest
   * dostępny i pokrywa miesiąc, jest źródłem nadrzędnym.
   *
   * Rozbieżność jest ZWRACANA, nie ukryta — to jedyny sposób, żeby kolejna
   * taka usterka została zauważona automatycznie, a nie po miesiącu.
   *
   * @param {{charge:number,discharge:number,hours:number}} growatt
   * @param {{charge:number,discharge:number,hours:number}} bms
   * @param {object} cfg wynik resolveConfig()
   * ------------------------------------------------------------------------*/
  function reconcileBatteryMonth(growatt, bms, cfg) {
    const c = cfg || resolveConfig();
    const g = growatt || {}, b = bms || {};
    const f = function (v) { const n = Number(v); return isFinite(n) ? n : 0; };
    const gCh = f(g.charge), gDis = f(g.discharge), gH = f(g.hours);
    const bCh = f(b.charge), bDis = f(b.discharge), bH = f(b.hours);

    // Zero to POMIAR, nie brak danych. Bateria może stać cały miesiąc
    // (pełna paczka, brak nadwyżek) — wtedy BMS poprawnie pokazuje 0/0,
    // a Growatt potrafi w tym samym czasie wymyślić energię. Warunek
    // oparty na godzinach, nie na sumie energii.
    const hasBms = bH > 0;
    // Pokrycie względem Growatt. Gdy Growatt nie ma godzin, a BMS ma —
    // BMS jest jedynym źródłem i pokrycie traktujemy jako pełne.
    const coverage = gH > 0 ? bH / gH : (bH > 0 ? 1 : null);
    const dCh = (hasBms && bCh > 0) ? (gCh - bCh) / bCh * 100 : null;
    const dDis = (hasBms && bDis > 0) ? (gDis - bDis) / bDis * 100 : null;
    const worst = Math.max(dCh === null ? 0 : Math.abs(dCh),
                           dDis === null ? 0 : Math.abs(dDis));
    // Procent wobec zera jest nieokreślony, więc różnicę 0 vs coś łapiemy
    // bezwzględnie. Próg 0,5 kWh jak w twardym limicie bilansu.
    const zeroMismatch = hasBms && ((bCh === 0 && gCh > 0.5) || (bDis === 0 && gDis > 0.5));
    const suspect = hasBms && (worst > c.bmsTolerancePct || zeroMismatch);

    const out = {
      source: 'growatt',
      bmsAvailable: hasBms,
      charge: round2(gCh),
      discharge: round2(gDis),
      growattCharge: round2(gCh),
      growattDischarge: round2(gDis),
      bmsCharge: round2(bCh),
      bmsDischarge: round2(bDis),
      growattHours: gH,
      bmsHours: bH,
      coverage: coverage === null ? null : round2(coverage * 100) / 100,
      chargeDeltaPct: dCh === null ? null : round2(dCh),
      dischargeDeltaPct: dDis === null ? null : round2(dDis),
      suspect: suspect,
      partial: false,
      reason: null,
    };
    if (!hasBms) return out;

    if (gH > 0 && coverage < c.bmsMinCoverage) {
      out.partial = true;
      out.reason = 'BMS pokrywa tylko ' + Math.round(coverage * 100) + '% godzin Growatt ('
        + bH + ' z ' + gH + ') — zostaję przy Growatt, żeby nie zaniżyć miesiąca.';
      return out;
    }

    out.source = 'bms';
    out.charge = round2(bCh);
    out.discharge = round2(bDis);
    if (suspect) {
      const parts = [];
      if (dCh !== null && Math.abs(dCh) > c.bmsTolerancePct) {
        parts.push('ładowanie ' + (dCh > 0 ? '+' : '') + dCh.toFixed(1) + '%');
      } else if (bCh === 0 && gCh > 0.5) {
        parts.push('ładowanie ' + gCh.toFixed(1) + ' kWh wg Growatt przy 0 kWh z BMS');
      }
      if (dDis !== null && Math.abs(dDis) > c.bmsTolerancePct) {
        parts.push('rozładowanie ' + (dDis > 0 ? '+' : '') + dDis.toFixed(1) + '%');
      } else if (bDis === 0 && gDis > 0.5) {
        parts.push('rozładowanie ' + gDis.toFixed(1) + ' kWh wg Growatt przy 0 kWh z BMS');
      }
      out.reason = 'Growatt różni się od BMS: ' + parts.join(', ')
        + '. Użyłem BMS — to pomiar DC na zaciskach paczki, niezależny od falownika.';
    }
    return out;
  }

  /* --------------------------------------------------------------------------
   * monthKeyFromUtc — klucz miesiąca w czasie LOKALNYM (Europe/Warsaw).
   *
   * Błąd T24: new Date('2026-08-01T00:30:00+02:00').toISOString().slice(0,7)
   * daje '2026-07', bo UTC cofa się na lipiec. Godzina 00:30 czasu polskiego
   * 1 sierpnia należy do SIERPNIA.
   * ------------------------------------------------------------------------*/
  const WARSAW_PARTS = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Warsaw',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23',   // nie h24 — '24:00' łamało parsowanie
  });

  function warsawParts(ms) {
    const out = {};
    for (const p of WARSAW_PARTS.formatToParts(new Date(ms))) out[p.type] = p.value;
    return out;
  }

  function monthKeyFromUtc(ms) {
    const p = warsawParts(ms);
    return p.year + '-' + p.month;
  }

  /* --------------------------------------------------------------------------
   * hourKeyFromUtc — klucz godzinowy ODPORNY na zmianę czasu.
   *
   * Błąd potwierdzony na danych: 25.10.2026 ma 25 godzin, ale klucz
   * 'YYYY-MM-DD_HH' daje tylko 24 unikalne — 02:00 występuje dwa razy
   * i druga godzina nadpisuje pierwszą (utrata 1,9 kWh).
   *
   * Rozwiązanie: klucz z UTC (zawsze unikalny), a osobno etykieta lokalna
   * do wyświetlania. Zachowujemy kompatybilność: date/hour lokalne zostają
   * w rekordzie, ale `key` jest z UTC.
   * ------------------------------------------------------------------------*/
  function hourKeyFromUtc(ms) {
    return new Date(ms).toISOString().slice(0, 13).replace('T', '_');
  }

  function localHourLabel(ms) {
    const p = warsawParts(ms);
    return { date: p.year + '-' + p.month + '-' + p.day, hour: parseInt(p.hour, 10) };
  }

  /* --------------------------------------------------------------------------
   * expectedHoursInDay — 23 / 24 / 25 w zależności od zmiany czasu.
   * Błąd: allHoursCoveredForDate() wymagało zawsze 24 → w dniu 23-godzinnym
   * pętla pobierania RCE nigdy się nie kończyła.
   * ------------------------------------------------------------------------*/
  function expectedHoursInDay(dateStr) {
    // Idziemy po godzinach UTC i liczymy te, których etykieta LOKALNA wypada
    // w zadanym dniu. Zakres ±1 dzień z zapasem pokrywa każdą zmianę strefy.
    // 29.03.2026 (wiosna) → 23 h; 25.10.2026 (jesień) → 25 h; zwykły dzień → 24 h.
    const noonUtc = Date.parse(dateStr + 'T12:00:00Z');
    if (!isFinite(noonUtc)) return 24;
    let count = 0;
    for (let t = noonUtc - 36 * 3600000; t <= noonUtc + 36 * 3600000; t += 3600000) {
      if (localHourLabel(t).date === dateStr) count++;
    }
    return count || 24;
  }

  /* --------------------------------------------------------------------------
   * parsePlNumber — poprawna obsługa separatorów.
   *
   * Błąd T3: '1.234,56' → parseFloat('1.234.56') → 1.234 (cicho, 1000× za mało).
   * Rozróżniamy: ostatni separator jest dziesiętny, pozostałe to tysiące.
   * ------------------------------------------------------------------------*/
  function parsePlNumber(str) {
    if (typeof str === 'number') return str;
    if (str === null || str === undefined) return NaN;
    let s = String(str).trim()
      .replace(/\u00a0/g, '')   // NBSP
      .replace(/\s/g, '')
      .replace(/zł|pln|kwh|mwh/gi, '');
    if (!s) return NaN;

    const lastComma = s.lastIndexOf(',');
    const lastDot = s.lastIndexOf('.');

    if (lastComma !== -1 && lastDot !== -1) {
      // oba obecne → ostatni jest dziesiętny
      if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
      else s = s.replace(/,/g, '');
    } else if (lastComma !== -1) {
      // tylko przecinki: jeden → dziesiętny; wiele → tysiące
      const parts = s.split(',');
      if (parts.length === 2) s = parts[0] + '.' + parts[1];
      else s = parts.join('');
    } else if (lastDot !== -1) {
      const parts = s.split('.');
      // wiele kropek → na pewno tysiące
      if (parts.length > 2) s = parts.join('');
      // jedna kropka z 3 cyframi po niej i ≥1 przed → prawdopodobnie tysiące,
      // ALE '1.5' to legalne 1,5. Rozstrzygamy: 3 cyfry po kropce = tysiące
      // tylko gdy część przed ma ≤3 cyfry i nie ma innych separatorów.
      // Bezpieczniej: zostawiamy jako dziesiętną (HA/CSV używają kropki).
    }
    const n = parseFloat(s);
    return isFinite(n) ? n : NaN;
  }

  /* --------------------------------------------------------------------------
   * rceHourFromRecord — godzina STARTU okresu, nie końca.
   *
   * Błąd P0-2: PSE zwraca `dtime` jako KONIEC interwału. Branie godziny
   * z dtime przesuwa wszystkie ceny o 1 h. Na lipcu 2026: 254,09 zł zamiast
   * 258,62 zł (−1,75%). Priorytet: `period` (jawnie „00:00 - 00:15").
   * ------------------------------------------------------------------------*/
  function rceHourFromRecord(rec) {
    // 1) period — jawny zakres, najbardziej wiarygodny
    if (rec.period !== undefined && rec.period !== null) {
      const s = String(rec.period);
      const range = s.match(/^(\d{1,2}):(\d{2})/);
      if (range) {
        const h = parseInt(range[1], 10);
        if (h >= 0 && h <= 23) return h;
        if (h === 24) return 23; // „24:00" jako koniec ostatniego kwadransa
      }
      const p = parseInt(s, 10);
      if (!isNaN(p) && p >= 1 && p <= 100) return Math.floor((p - 1) / 4);
    }
    // 2) dtime — KONIEC interwału, trzeba cofnąć o jedną godzinę
    const tf = rec.dtime || rec.udtczas_oreb || rec.udtczas || null;
    if (tf) {
      const m = String(tf).match(/(\d{1,2}):(\d{2})/);
      if (m) {
        const h = parseInt(m[1], 10);
        const min = parseInt(m[2], 10);
        // 15:00 koniec → okres 14:00; 14:15 koniec → nadal okres 14:00
        return min === 0 ? (h + 23) % 24 : h;
      }
    }
    return null;
  }

  /* --------------------------------------------------------------------------
   * depositMultiplier — ×1,23 obowiązuje od 1.02.2025 (art. 4c ust. 4).
   * Wcześniej mnożnik 1,0. Bez tej bramki miesiące 2024 zawyżają o 23%.
   * ------------------------------------------------------------------------*/
  function depositMultiplier(monthKey) {
    return monthKey >= '2025-02' ? 1.23 : 1.0;
  }

  function hourlyDepositValue(kwh, rcePlnMwh, monthKey) {
    const priceKwh = Math.max(0, rcePlnMwh) / 1000;  // ujemne RCE → depozyt bez zmian
    const mult = monthKey ? depositMultiplier(monthKey) : 1.23;
    return kwh * priceKwh * mult;
  }

  /* --------------------------------------------------------------------------
   * refundCap — limit zwrotu niewykorzystanej nadpłaty.
   *
   * art. 4 ust. 11a pkt 2 (Dz.U. 2024 poz. 1847):
   *   „30% wartości energii elektrycznej wprowadzonej do sieci w miesiącu
   *    kalendarzowym, którego dotyczy zwrot nadpłaty"
   *
   * Dwie rzeczy są tu istotne:
   *
   * 1) Podstawa to miesiąc, KTÓREGO DOTYCZY ZWROT (czyli miesiąc pochodzenia
   *    transzy), NIE całe aktualne saldo konta i NIE miesiąc wypłaty.
   *
   * 2) „wartość energii wprowadzonej" to wartość PRZED przemnożeniem przez 1,23.
   *    Depozyt jest tą wartością powiększoną o 23% (art. 4c ust. 4), więc
   *    literalne czytanie daje limit 30% × (depozyt / 1,23) = 24,39% depozytu.
   *    Część sprzedawców i opracowań liczy 30% wprost od depozytu.
   *
   * Nie rozstrzygam tego autorytatywnie — tryb jest konfigurowalny:
   *   'base'    → 30% od wartości energii wprowadzonej (literalny przepis)
   *   'deposit' → 30% od depozytu po ×1,23 (interpretacja spotykana w praktyce)
   *
   * Dla lipca 2026 (depozyt 258,62 zł): 'base' → 63,08 zł, 'deposit' → 77,59 zł.
   * Różnica 14,51 zł (23%). Rozstrzyga pierwsza faktyczna faktura zwrotu.
   *
   * @param {number} remaining     niewykorzystana część transzy
   * @param {number} monthDeposit  depozyt miesiąca pochodzenia (po ×1,23)
   * @param {number} rate          0.30 dla RCE godzinowego, 0.20 dla RCEm
   * @param {string} basis         'base' | 'deposit'
   * @param {string} monthKey      miesiąc pochodzenia, do ustalenia mnożnika
   * ------------------------------------------------------------------------*/
  function refundCap(remaining, monthDeposit, rate, basis, monthKey) {
    const mult = monthKey ? depositMultiplier(monthKey) : 1.23;
    const capBase = basis === 'deposit' ? monthDeposit : monthDeposit / mult;
    const cap = rate * capBase;
    // Wszystkie kwoty zaokrąglamy do groszy PRZED zwróceniem — inaczej do
    // księgi trafiałaby wartość z ogonem dziesiętnym (63.078048780487805),
    // a sumy po kilku transzach rozjeżdżałyby się z fakturą o ułamki groszy.
    const refund = round2(Math.min(remaining, cap));
    return {
      refund,
      cap: round2(cap),
      capBase: round2(capBase),
      basis: basis === 'deposit' ? 'deposit' : 'base',
      writtenOff: round2(Math.max(0, remaining - refund)),
    };
  }

  /* --------------------------------------------------------------------------
   * escapeHtml — wszystkie interpolacje do innerHTML muszą przez to przejść.
   * Błąd T2/T26: nazwa miesiąca / etykieta strefy z pliku CSV trafiała
   * surowa do innerHTML → przechowywany XSS → kradzież hassTokens.
   * ------------------------------------------------------------------------*/
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

  return {
    DEFAULT_LIMITS,
    resolveConfig,
    acceptDelta,
    createRejectionLog,
    validateBatteryMonth,
    validateBatteryTotal,
    reconcileBatteryMonth,
    monthKeyFromUtc,
    hourKeyFromUtc,
    localHourLabel,
    expectedHoursInDay,
    parsePlNumber,
    rceHourFromRecord,
    depositMultiplier,
    hourlyDepositValue,
    refundCap,
    escapeHtml,
    round2,
  };
}));
