/* Karta Rozbudowa PV. Celowo NIE wywołuje render/saveState/recomputeMonths,
 * nie zna state.months ani źródeł legacy. Bridge udostępnia wyłącznie kopię. */
(function () {
  'use strict';
  const root = document.getElementById('tab-pv');
  if (!root) return;
  const M = window.G13PvModel, D = window.G13PvData, S = window.G13PvStore;
  if (!M || !D || !S || !window.G13PvReadOnly) {
    root.textContent = 'Nie załadowano modułów PV. Dotychczasowe karty działają niezależnie; odśwież stronę.';
    return;
  }
  const defaults = () => ({
    startDate: '2026-09-01', endDate: '2026-10-31', loadMode: 'conditional', topology: '',
    existingKwp: 9.54, addedKwp: null, addedYieldFactor: 1,
    capacityKwh: 14.336, minSocPct: 10, maxSocPct: 100, initialSocPct: 10,
    chargeDcKw: null, dischargeDcKw: null, pvToAcEta: null, pvToBatteryEta: null,
    batteryToAcEta: null, acToBatteryEta: null, storeChargeEta: null, storeDischargeEta: null,
    inverterAcKw: null, addedInverterAcKw: null, exportAcKw: null,
    unlimitedInverter: false, unlimitedAddedInverter: false, unlimitedExport: false,
    depositUseFraction: 1, loadScale: 1, costPln: null,
    allowDstAggregation: false, acceptScenario: false, autoRefresh: false,
    entities: {
      pv: 'sensor.growatt_solar_pv_energy_total', acOutput: 'sensor.growatt_solar_energy_total',
      acCharge: 'sensor.growatt_battery_ac_charge_energy_total', bmsCharge: '', bmsDischarge: '',
      soc: 'sensor.growatt_battery_battery_soc', pvPower: 'sensor.growatt_solar_solar_total_power', house: '',
    },
  });
  const fields = [
    ['existingKwp', 'Obecne PV · kWp', '9,54 kWp = 18 × 530 W; wartość bazowa uzgodniona z użytkownikiem.'],
    ['addedKwp', 'Dodatkowe PV · kWp', 'Tylko dołożona moc. 0 służy kontroli zerowego przyrostu.'],
    ['addedYieldFactor', 'Względny uzysk nowych paneli', '1 = ten sam profil i uzysk na kWp; jawne założenie, nie projekt geometrii/MPPT.'],
    ['capacityKwh', 'Nominalna bateria · kWh', '14,336 kWh w całym zakresie SOC, nie zmierzona pojemność użytkowa.'],
    ['minSocPct', 'Rezerwa modelu · % SOC', '10% tylko w modelu. Rzeczywistego progu 30% nie zmieniamy.'],
    ['maxSocPct', 'Górny SOC modelu · %', 'To samo okno w obu modelach; odejmujemy rezerwę tylko raz.'],
    ['initialSocPct', 'SOC na początku okresu · %', '10% to kandydat z analizy, nie pomiar graniczny. Identyczny start obu modeli.'],
    ['chargeDcKw', 'Moc ładowania · kW DC', 'Na zaciskach baterii. Wpisz scenariusz; 2/4/6 kW nie zostały zatwierdzone.'],
    ['dischargeDcKw', 'Moc rozładowania · kW DC', 'Osobny parametr. 0 blokuje dany kierunek; puste pole jest nieznane.'],
    ['inverterAcKw', 'Limit istniejącej hybrydy · kW AC', 'Wspólny budżet konwersji AC PV + bateria + ładowanie zwrotne w kroku.'],
    ['addedInverterAcKw', 'Limit dodatkowego falownika · kW AC', 'Dotyczy wyłącznie wariantu dodatkowego falownika AC.'],
    ['exportAcKw', 'Limit eksportu całego układu · kW AC', '0 oznacza blokadę eksportu. Nie jest to moc umowna importu.'],
    ['pvToAcEta', 'PV DC → AC · sprawność %', 'Jedna jawna sprawność konwersji PV dla obu falowników w tej wersji.'],
    ['pvToBatteryEta', 'PV DC → zaciski baterii · %', 'Tor DC/DC; bez strat przechowywania opisanych niżej.'],
    ['batteryToAcEta', 'Zaciski baterii DC → AC · %', 'Sprawność wyjścia falownika, nie całego cyklu baterii.'],
    ['acToBatteryEta', 'Nadwyżka AC → zaciski baterii · %', 'Tylko dodatkowe PV AC; NIE planowe ładowanie z sieci.'],
    ['storeChargeEta', 'Zaciski DC → energia zapisana · %', 'Strata wewnętrzna ładowania. Brak automatycznej kalibracji z BMS.'],
    ['storeDischargeEta', 'Energia zapisana → zaciski DC · %', 'Strata wewnętrzna rozładowania. Nie mnożymy pojemności oknem ponownie.'],
    ['loadScale', 'Mnożnik zapotrzebowania domu', '1 = wejściowe H. Zmień do analizy wrażliwości; to nie statystyczny przedział ufności.'],
    ['depositUseFraction', 'Wykorzystanie zmiany depozytu · %', '100% to założenie pełnego wykorzystania, nie gotówka ani prognoza zwrotu.'],
    ['costPln', 'Koszt SAMYCH nowych paneli/rozbudowy · zł', 'Opcjonalna informacja. Nie kopiujemy 21 000 ani 5000 zł i nie wyliczamy rocznego zwrotu.'],
  ];
  const percentages = new Set(['pvToAcEta', 'pvToBatteryEta', 'batteryToAcEta', 'acToBatteryEta', 'storeChargeEta', 'storeDischargeEta', 'depositUseFraction']);
  const entities = [
    ['pv', 'PV DC · licznik kWh'], ['acOutput', 'Wyjście falownika AC · licznik kWh'],
    ['acCharge', 'Ładowanie AC · licznik kWh'], ['bmsCharge', 'BMS ładowanie DC · licznik kWh'],
    ['bmsDischarge', 'BMS rozładowanie DC · licznik kWh'], ['soc', 'SOC · statystyki %'],
    ['pvPower', 'Moc PV · statystyki kW (tylko diagnostyka)'], ['house', 'Niezależny dom AC · licznik kWh (opcjonalny)'],
  ];
  let settings = defaults(), dataset = null, result = null, prepared = null;
  let store, busy = false, blocked = false, ready = false, resetArmed = false, autoTimer = null;
  const $ = id => document.getElementById(id);
  const number = (x, digits = 2) => typeof x === 'number' && Number.isFinite(x)
    ? x.toLocaleString('pl-PL', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : 'nieznane';
  const money = x => x === null || x === undefined ? 'nieznane' : number(x) + ' zł';
  const kwh = x => x === null || x === undefined ? 'nieznane' : number(x) + ' kWh';
  function el(tag, text, cls) { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; }
  function say(message, error) { $('pvStatus').textContent = message; $('pvStatus').classList.toggle('pv-error', !!error); }
  function field(key, label, help, entity) {
    const wrap = el('div', undefined, 'pv-field');
    const lab = el('label', label); lab.htmlFor = 'pv-' + (entity ? 'entity-' : '') + key;
    const input = el('input'); input.id = lab.htmlFor; input.type = entity ? 'text' : 'number';
    input.autocomplete = 'off';
    if (entity) { input.placeholder = 'sensor.…'; input.spellcheck = false; }
    else { input.step = 'any'; input.min = '0'; input.placeholder = 'nieustalone'; }
    if (key === 'existingKwp') input.readOnly = true;
    wrap.append(lab, input); if (help) wrap.append(el('small', help)); return wrap;
  }
  root.innerHTML = `
    <header class="pv-heading"><div><span class="eyebrow">Osobny kalkulator · 0.3.5</span><h2>Rozbudowa PV</h2></div><span class="pv-badge">Symulacja scenariusza</span></header>
    <div class="pv-notice"><strong>Nie jest to zwalidowana rekonstrukcja pomiarów.</strong> Porównujemy dwa modele: obecne PV i PV po rozbudowie — z dynamiczną obecną baterią, bez planowego ładowania z sieci. Dane historyczne i ich rozbieżności pokazujemy osobno. Nic nie trafia do salda depozytu, autokonsumpcji ani kalkulatora drugiego magazynu.</div>
    <form id="pvForm" novalidate>
      <section class="panel pv-section"><div class="panel-header-row"><h3>1 · Dane i okres</h3><span class="pv-muted">Daty włącznie · Europe/Warsaw</span></div>
        <div class="pv-grid pv-period"><div class="pv-field"><label for="pv-startDate">Od</label><input id="pv-startDate" type="date"></div><div class="pv-field"><label for="pv-endDate">Do</label><input id="pv-endDate" type="date"></div><div class="pv-field pv-wide"><label for="pv-loadMode">Zapotrzebowanie domu</label><select id="pv-loadMode"><option value="conditional">Warunkowe H = wyjście AC + import − eksport − ładowanie AC</option><option value="meter">Osobny, zadeklarowany licznik domu AC (bez ładowania baterii)</option></select></div></div>
        <p class="pv-muted">H nie jest niezależnym pomiarem domu. Licznik ładowania AC nie oznacza fakturowanego zakupu baterii. Nie odejmujemy go od BMS DC ani nie obcinamy do importu. Przy drugim wariancie odpowiedzialność za granicę pomiaru pozostaje jawna — nazwa encji jej nie potwierdza.</p>
        <details><summary>Niezależne źródła HA — pokaż / zmień</summary><p class="pv-muted">Liczniki: kWh i przyrost change. BMS/SOC/moc są diagnostyką, nie sterują symulacją. Encje BMS można odczytać z opcji dodatku; ich wpisanie tutaj nie zmienia tych opcji ani growatt_entities.</p><div id="pvEntities" class="pv-grid"></div></details>
        <div class="pv-actions"><button id="pvFetch" type="button" class="btn-secondary">Pobierz dane HA dla tej karty</button><button id="pvDiagnose" type="button" class="btn-ghost">Sprawdź dane</button><label class="pv-check"><input id="pv-autoRefresh" type="checkbox"> Odświeżaj dane przy wejściu i co 60 min w otwartej karcie</label></div>
        <div id="pvDataStatus" class="pv-muted" role="status">Brak własnej historii PV.</div>
        <label class="pv-check"><input id="pv-allowDstAggregation" type="checkbox"> Akceptuję przybliżenie wspólnego kroku 2 h dla powtórzonej godziny zmiany czasu. RCE tej godziny pozostaje nieznane, jeśli cache nie rozróżnia obu godzin.</label>
      </section>
      <section class="panel pv-section"><h3>2 · Jawne założenia, nie ustawienia urządzenia</h3>
        <div class="pv-field"><label for="pv-topology">Scenariusz podłączenia nowych paneli</label><select id="pv-topology"><option value="">Wybierz scenariusz — podłączenie nie jest jeszcze ustalone</option><option value="dc_shared">DC: nowe i obecne panele na wspólnym falowniku hybrydowym</option><option value="ac_added">AC: nowy falownik PV, istniejąca hybryda może przyjąć nadwyżkę AC</option></select><small>Wariant AC zakłada dostępność takiego sterowania ładowaniem; nie potwierdza możliwości WIT. Połączenia elektryczne/MPPT wymagają osobnego projektu.</small></div>
        <div id="pvParameters" class="pv-grid"></div>
        <div class="pv-checks"><label class="pv-check"><input id="pv-unlimitedInverter" type="checkbox"> Jawnie idealizuję: bez limitu konwersji istniejącej hybrydy</label><label class="pv-check"><input id="pv-unlimitedAddedInverter" type="checkbox"> Jawnie idealizuję: bez limitu dodatkowego falownika AC</label><label class="pv-check"><input id="pv-unlimitedExport" type="checkbox"> Jawnie idealizuję: bez limitu eksportu</label></div>
        <p id="pvWindow" class="pv-notice"></p>
        <details><summary>Co model upraszcza?</summary><ul class="pv-muted"><li>Nowe PV = historyczne PV DC × dodatkowe kWp / 9,54 × względny uzysk. To profil po historycznych ograniczeniach — nie odzyskujemy utraconej produkcji ani nie znamy przyszłego zacienienia.</li><li>Stałe/średnie moce w kroku 1 h (wyjątkowo 2 h): brak gwarancji ograniczeń chwilowych, przepięć, limitów prądu/napięcia MPPT lub zgodności instalacyjnej.</li><li>Wariant AC: nowy falownik najpierw zasila dom, istniejące PV DC ma pierwszeństwo ładowania. Konwersje w obu kierunkach dzielą budżet mocy istniejącej hybrydy.</li><li>Liniowe SOC → energia; jawne sprawności torów i baterii. Brak modelu starzenia, temperatury, poboru własnego i podtrzymania SOC. Żadnych dopasowanych „strat”, aby zamknąć historię.</li><li>W obu modelach identyczny start, progi i strategia. Wynik nie zawiera korzyści z obniżenia rzeczywistego progu 30% lub zmiany ręcznego sterowania.</li><li>Zakup: aktualnie zapisane stawki G13 odczytane bez modyfikacji. Depozyt: RCE godzinowe, ujemne ceny → 0, mnożnik 1,23 od lutego 2025. Nieznanych cen nie zastępujemy zerem ani stawką płaską.</li><li>Brak rocznego przeliczenia i okresu zwrotu. Końcowy zapas energii nie jest wyceniany. Zmiana depozytu nie jest wypłatą gotówkową.</li></ul></details>
      </section>
      <section class="panel pv-section"><h3>3 · Oblicz różnicę dwóch modeli</h3>
        <label class="pv-check"><input id="pv-acceptScenario" type="checkbox"> Rozumiem warunkowy charakter zapotrzebowania/źródeł, strat i ograniczeń. Akceptuję wpisane założenia wyłącznie jako scenariusz, bez uznawania historii za fizycznie zwalidowaną.</label>
        <div class="pv-actions"><button id="pvCalculate" type="button" class="btn-primary">Porównaj obecne PV i rozbudowę</button><button id="pvReset" type="button" class="btn-danger-ghost">Wyczyść tylko kartę PV</button></div>
        <p id="pvStatus" role="status" aria-live="polite">Uzupełnij moc rozbudowy, scenariusz podłączenia, moce i sprawności. Puste pola nie są wartościami domyślnymi.</p><p id="pvSaveStatus" class="pv-muted"></p>
      </section>
    </form>
    <section class="panel pv-section" aria-labelledby="pvDiagnosticsHeading"><h3 id="pvDiagnosticsHeading">Diagnostyka danych historycznych</h3><div id="pvDiagnostics">Po pobraniu sprawdzimy kompletność, granice czasu oraz rozbieżności. Brak danych nie oznacza zerowych przepływów.</div></section>
    <section id="pvResults" class="pv-section" aria-live="polite" hidden></section>`;
  for (const f of fields) $('pvParameters').append(field(...f));
  for (const [key, label] of entities) $('pvEntities').append(field(key, label, '', true));
  const bools = ['unlimitedInverter', 'unlimitedAddedInverter', 'unlimitedExport', 'allowDstAggregation', 'acceptScenario', 'autoRefresh'];
  const texts = ['startDate', 'endDate', 'loadMode', 'topology'];
  function restore(s) {
    const n = defaults();
    for (const [key] of fields) if (Object.prototype.hasOwnProperty.call(s, key)) n[key] = s[key];
    for (const key of texts) if (typeof s[key] === 'string') n[key] = s[key];
    for (const key of bools) n[key] = s[key] === true;
    for (const [key] of entities) if (s.entities && typeof s.entities[key] === 'string') n.entities[key] = s.entities[key];
    // Baza instalacji nie migruje z obcych ustawień.
    n.existingKwp = 9.54;
    return n;
  }
  function fill() {
    for (const [key] of fields) $('pv-' + key).value = settings[key] === null || settings[key] === undefined ? ''
      : percentages.has(key) ? Number((settings[key] * 100).toFixed(6)) : settings[key];
    for (const key of texts) $('pv-' + key).value = settings[key];
    for (const key of bools) $('pv-' + key).checked = settings[key] === true;
    for (const [key] of entities) $('pv-entity-' + key).value = settings.entities[key];
    updateFields();
  }
  function readForm() {
    const n = defaults();
    for (const [key] of fields) {
      const raw = $('pv-' + key).value.trim();
      n[key] = raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) / (percentages.has(key) ? 100 : 1) : null;
    }
    n.existingKwp = 9.54;
    for (const key of texts) n[key] = $('pv-' + key).value;
    for (const key of bools) n[key] = $('pv-' + key).checked;
    for (const [key] of entities) n.entities[key] = $('pv-entity-' + key).value.trim();
    return n;
  }
  function updateFields() {
    root.querySelectorAll('input,select,button').forEach(n => { n.disabled = busy || !ready || (blocked && n.id !== 'pvReset'); });
    if (!busy && ready && !blocked) {
      const ac = settings.topology === 'ac_added';
      $('pv-addedInverterAcKw').disabled = !ac || settings.unlimitedAddedInverter;
      $('pv-acToBatteryEta').disabled = !ac;
      $('pv-unlimitedAddedInverter').disabled = !ac;
      $('pv-inverterAcKw').disabled = settings.unlimitedInverter;
      $('pv-exportAcKw').disabled = settings.unlimitedExport;
      $('pv-entity-house').disabled = settings.loadMode !== 'meter';
    }
    const c = settings.capacityKwh, lo = settings.minSocPct, hi = settings.maxSocPct, initial = settings.initialSocPct;
    const valid = [c, lo, hi, initial].every(x => typeof x === 'number' && Number.isFinite(x));
    $('pvWindow').textContent = valid
      ? 'Okno energii nominalnej: ' + number(c * (hi - lo) / 100, 4) + ' kWh przed stratami. Start obu modeli: '
        + number(c * initial / 100, 4) + ' kWh, ponad rezerwą: ' + number(c * (initial - lo) / 100, 4)
        + ' kWh. Nie podnosimy stanu do rezerwy za darmo. Fizyczny próg falownika pozostaje bez zmian.'
      : 'Brak pełnych parametrów energii/SOC. Nie zastępujemy ich zerem.';
  }
  function invalidate() { result = null; $('pvResults').replaceChildren(); $('pvResults').hidden = true; }
  function invalidateDiagnostics(message) { prepared = null; $('pvDiagnostics').textContent = message; }
  function showDataStatus() {
    if (!dataset) { $('pvDataStatus').textContent = 'Brak własnej historii PV. Pozostałe karty i ich zapisy pozostają nietknięte.'; return; }
    let matches = false; try { matches = dataset.signature === D.signature(settings); } catch (_) {}
    $('pvDataStatus').textContent = 'Ostatni zapis własnej historii: ' + dataset.fetchedAt + '. '
      + (matches ? 'Zakres i lista encji zgodne z formularzem. Nie jest to potwierdzenie jakości pomiarów.' : 'Zmieniono zakres/kanały — pobierz dane dla aktualnego wyboru. Stare dane zachowano.');
  }
  function table(heads, rows, caption) {
    const scroll = el('div', undefined, 'table-scroll'); const t = el('table');
    if (caption) t.append(el('caption', caption));
    const th = el('thead'), tr = el('tr'); for (const h of heads) tr.append(el('th', h)); th.append(tr); t.append(th);
    const b = el('tbody'); for (const values of rows) { const r = el('tr'); values.forEach((v, i) => r.append(el('td', v, i ? 'num' : 'col-month'))); b.append(r); }
    t.append(b); scroll.append(t); return scroll;
  }
  function diagnostics(p) {
    const box = $('pvDiagnostics'); box.replaceChildren();
    const q = p.diagnostics;
    box.append(el('p', 'Oczekiwane godziny UTC: ' + q.expectedHours + ' · kroki modelu: ' + q.intervalCount + ' · kroki 2 h: ' + q.dstBlocks + '. Błędów blokujących: ' + q.errorCount + '.', q.errorCount ? 'pv-error' : 'pv-muted'));
    box.append(el('p', 'Reszta R = PV DC + rozładowanie BMS DC + ładowanie AC − ładowanie BMS DC − wyjście AC. Znane godziny: '
      + q.residualKnownHours + '/' + q.expectedHours + '; reszta < −0,2 kWh: ' + q.residualBelowMinus02Hours
      + '; ujemne reszty ogółem: ' + q.negativeResidualHours + '; suma (tylko pełny okres): ' + kwh(q.residualSumKwh) + '. Nie dopasowujemy strat, by zamknąć ten bilans.'));
    box.append(el('p', 'Dodatnie ładowanie AC bez importu netto: ' + q.zeroImportPositiveAcBlocks + ' przedziałów. Nietypowe zakresy SOC: ' + q.socRangeFlags
      + '. Brak stawek G13: ' + q.missingBuyPriceBlocks + '; brak jednoznacznego RCE: ' + q.missingRcePriceBlocks + ' przedziałów. Wpływ na kwotę zależy od modelowanych przepływów/przyrostu.', 'pv-muted'));
    const rows = Object.keys(p.historical).sort().map(mk => {
      const m = p.historical[mk], v = f => kwh(m.values[f].totalKwh);
      return [mk + ' · ' + m.hours + ' h', v('pvDcKwh'), v('houseKwh'), v('gridImportKwh'), v('gridExportKwh'), v('acChargeKwh')];
    });
    box.append(table(['Historia', 'PV DC', settings.loadMode === 'conditional' ? 'H warunkowe' : 'Licznik domu (deklaracja)', 'Import eLicznik', 'Eksport eLicznik', 'Ładowanie AC ≠ zakup'], rows, 'Pomiar/wnioskowanie historyczne — NIE wynik strategii scenariusza. Sumy z brakami: nieznane.'));
    const detail = el('details'); detail.append(el('summary', 'Pełna lista problemów i ostrzeżeń (' + p.issues.length + ')'));
    if (p.issues.length) {
      const list = el('ul', undefined, 'pv-issues');
      // Wszystkie wpisy są dostępne, nie obcinamy listy do kilku „ładnych” godzin.
      for (const i of p.issues) list.append(el('li', i.key + ' / ' + new Date(i.ts).toISOString() + ' · ' + i.channel + ' · ' + i.message
        + (i.value === null ? '' : ' Wartość: ' + (typeof i.value === 'number' ? number(i.value, 6) : JSON.stringify(i.value))), i.severity === 'error' ? 'pv-error' : ''));
      detail.append(list);
    } else detail.append(el('p', 'Brak flag nie oznacza fizycznej walidacji pomiarów.'));
    box.append(detail);
  }
  async function prepareData() {
    if (blocked) throw new Error('Zapis PV jest uszkodzony/niedostępny. Nie nadpisujemy go automatycznie — użyj jawnego czyszczenia tylko karty PV.');
    if (!dataset) throw new Error('Najpierw pobierz osobną historię PV z HA. Nie używamy uproszczonego cache starej karty.');
    if (dataset.signature !== D.signature(settings)) throw new Error('Zakres lub encje różnią się od zapisanych danych PV. Pobierz aktualny zestaw.');
    await window.G13PvReadOnly.whenReady;
    prepared = D.prepare(dataset.series, settings, window.G13PvReadOnly.getSnapshot());
    diagnostics(prepared);
    return prepared;
  }
  function renderResult(r) {
    const box = $('pvResults'); box.replaceChildren(); box.hidden = false;
    box.append(el('h3', 'Wynik scenariusza · ' + settings.startDate + ' – ' + settings.endDate));
    box.append(el('p', 'Różnica: rozbudowa − obecny układ, przy tej samej strategii i starcie. Wyceniono tylko ten okres (' + r.hours + ' h). Źródła G13/RCE to migawka przy obliczeniu; po zmianie danych przelicz ponownie. Wyniku nie zapisano do rozliczeń.', 'pv-muted'));
    const cards = el('div', undefined, 'pv-metrics');
    const metrics = [
      ['Korzyść warunkowa za okres', money(r.delta.conditionalBenefitPln), 'pvBenefit'],
      ['Uniknięty zakup G13', money(r.delta.avoidedPurchase.totalPln), 'pvAvoidedPurchase'],
      ['Zmiana przypisu depozytu', money(r.delta.extraDeposit.totalPln), 'pvDepositDelta'],
      ['Dodatkowy profil PV DC', kwh(r.delta.addedPvDcKwh), 'pvExtraEnergy'],
    ];
    for (const [label, value, id] of metrics) { const card = el('div', undefined, 'panel pv-metric'); card.append(el('span', label, 'pv-muted')); const v = el('strong', value, 'mono'); v.id = id; card.append(v); cards.append(card); }
    box.append(cards);
    box.append(el('p', 'Korzyść = uniknięty zakup + ' + number(settings.depositUseFraction * 100, 0) + '% × zmiana depozytu. Depozyt ≠ gotówka. Kwoty „nieznane” nie są zastępowane zerem. Koszt rozbudowy: '
      + money(settings.costPln) + '. Bez rocznego zwrotu i bez wyceny końcowego zapasu.', 'pv-notice'));
    const a = r.current, b = r.expanded;
    const flow = [
      ['PV DC (profil)', kwh(a.pvDcKwh), kwh(b.pvDcKwh), kwh(b.pvDcKwh - a.pvDcKwh)],
      ['Dom AC (ten sam)', kwh(a.loadAcKwh), kwh(b.loadAcKwh), kwh(b.loadAcKwh - a.loadAcKwh)],
      ['Zakup z sieci', kwh(a.gridImportKwh), kwh(b.gridImportKwh), kwh(b.gridImportKwh - a.gridImportKwh)],
      ['Eksport do sieci', kwh(a.gridExportKwh), kwh(b.gridExportKwh), kwh(b.gridExportKwh - a.gridExportKwh)],
      ['Ładowanie baterii (zaciski DC)', kwh(a.batteryChargeDcKwh), kwh(b.batteryChargeDcKwh), kwh(b.batteryChargeDcKwh - a.batteryChargeDcKwh)],
      ['Rozładowanie baterii (zaciski DC)', kwh(a.batteryDischargeDcKwh), kwh(b.batteryDischargeDcKwh), kwh(b.batteryDischargeDcKwh - a.batteryDischargeDcKwh)],
      ['Ograniczona produkcja (ekwiwalent DC)', kwh(a.curtailedDcKwh), kwh(b.curtailedDcKwh), kwh(b.curtailedDcKwh - a.curtailedDcKwh)],
      ['Straty torów/baterii w modelu', kwh(a.lossKwh), kwh(b.lossKwh), kwh(b.lossKwh - a.lossKwh)],
      ['Energia zapisana na końcu', kwh(a.finalStoredKwh), kwh(b.finalStoredKwh), kwh(r.delta.finalStoredDifferenceKwh)],
    ];
    box.append(table(['Wielkość modelowa', 'Obecne PV', 'PV po rozbudowie', 'Rozbudowa − obecne'], flow, 'Dwa przebiegi modelu — nie różnica względem ręcznie sterowanej historii.'));
    box.append(el('p', 'Końcowy SOC: ' + number(a.finalStoredKwh / settings.capacityKwh * 100) + '% → '
      + number(b.finalStoredKwh / settings.capacityKwh * 100) + '%. Nierówny zapas końcowy pokazujemy osobno, bez dopisywania do korzyści. Maksymalna reszta numeryczna bilansu: '
      + Math.max(a.maxBalanceErrorKwh, b.maxBalanceErrorKwh).toExponential(2) + ' kWh — to kontrola arytmetyki, nie kalibracja pomiarów.', 'pv-muted'));
    const months = Object.keys(r.monthly).sort().map(mk => {
      const m = r.monthly[mk], h = prepared.historical[mk];
      return [mk + ' · ' + m.hours + ' h', kwh(h.values.gridImportKwh.totalKwh),
        number(m.current.gridImportKwh) + ' → ' + number(m.expanded.gridImportKwh),
        number(m.current.gridExportKwh) + ' → ' + number(m.expanded.gridExportKwh),
        money(m.delta.avoidedPurchase.totalPln), money(m.delta.extraDeposit.totalPln), money(m.delta.conditionalBenefitPln)];
    });
    box.append(table(['Okres', 'Import historyczny', 'Import modeli · kWh', 'Eksport modeli · kWh', 'Uniknięty zakup', 'Zmiana depozytu', 'Korzyść warunkowa'], months));
    const missing = r.delta.avoidedPurchase.missingIntervals + r.delta.extraDeposit.missingIntervals;
    if (missing) box.append(el('p', 'Brakujące wyceny przy niezerowej różnicy: G13 ' + r.delta.avoidedPurchase.missingIntervals + ', RCE '
      + r.delta.extraDeposit.missingIntervals + '. Znane podsumy (NIE pełny wynik): zakup ' + money(r.delta.avoidedPurchase.knownPln)
      + ', depozyt ' + money(r.delta.extraDeposit.knownPln) + '.', 'pv-notice'));
    if (settings.unlimitedInverter || settings.unlimitedExport || (settings.topology === 'ac_added' && settings.unlimitedAddedInverter))
      box.append(el('p', 'UWAGA: jawny wariant idealizowany bez co najmniej jednego limitu mocy. Nie jest potwierdzonym wariantem sprzętowym.', 'pv-notice'));
  }
  async function diagnose() {
    if (busy || !ready) return;
    try { const p = await prepareData(); say(p.ok ? 'Dane złożono bez luk blokujących. Ostrzeżenia i brak fizycznej walidacji pozostają widoczne.' : 'Model zablokowany: niepełne/niepoprawne wejścia lub niezaakceptowany krok DST. Sprawdź diagnostykę.', !p.ok); }
    catch (e) { say(e.message, true); }
  }
  async function calculate() {
    if (busy || !ready) return;
    invalidate();
    try {
      const p = await prepareData();
      if (!p.ok) throw new Error('Nie uruchomiono modelu: ' + p.diagnostics.errorCount + ' problemów blokujących. Nie wycinamy godzin ani nie zamykamy bilansu na siłę.');
      if (!settings.acceptScenario) throw new Error('Zaznacz akceptację założeń scenariusza (punkt 3); to nie akceptacja jakości pomiarów.');
      M.validateConfig(settings);
      result = M.simulate(p.rows, settings);
      renderResult(result);
      say('Obliczono różnicę dwóch modeli. To wynik warunkowy; dotychczasowe rozliczenia i ustawienia HA nie zostały zmienione.');
    } catch (e) { say(e.message, true); }
  }
  async function fetchData() {
    if (busy || !ready || blocked) return;
    let sig, span, ids;
    try { sig = D.signature(settings); span = D.range(settings.startDate, settings.endDate); ids = D.entityIds(settings); }
    catch (e) { say(e.message, true); return; }
    busy = true; invalidate(); invalidateDiagnostics('Pobieranie nowego zestawu. Poprzednie dane pozostają zapisane do chwili poprawnego zakończenia.'); updateFields();
    try {
      const parts = [];
      for (let cursor = span.start; cursor < span.end;) {
        const mk = D.localKey(cursor).slice(0, 7), [y, m] = mk.split('-').map(Number);
        const nextMonth = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
        const end = Math.min(span.end, D.midnight(nextMonth));
        const qs = new URLSearchParams({ entities: ids.join(','), start: new Date(cursor - 3600000).toISOString(),
          end: new Date(end).toISOString(), types: 'change,sum,mean,min,max' });
        say('Pobieranie osobnej historii PV: ' + mk + ' (z 1 h bufora). Bez zapisu do dotychczasowych kart…');
        const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 65000);
        let text;
        try {
          const response = await fetch('api/ha/stats.csv?' + qs.toString(), { signal: controller.signal });
          if (!response.ok) {
            let detail = 'HTTP ' + response.status;
            try { const j = await response.json(); if (j.error) detail += ': ' + j.error; } catch (_) {}
            throw new Error(detail);
          }
          text = await response.text();
        } finally { clearTimeout(timeout); }
        parts.push(D.parseStatsCsv(text)); cursor = end;
      }
      const series = D.mergeSeries(parts);
      if (D.signature(settings) !== sig) throw new Error('Formularz zmienił się podczas pobierania; nie aktywowano innych danych.');
      const saved = await store.saveDataset(series, sig);
      dataset = { series, signature: sig, fetchedAt: saved.fetchedAt };
      showDataStatus();
      const p = await prepareData();
      say('Zapisano wyłącznie własną historię PV. ' + (p.ok ? 'Możesz porównać modele po uzupełnieniu założeń.' : 'Diagnostyka wskazuje problemy blokujące — patrz poniżej.')
        + (saved.cleanupWarning ? ' Nie udało się usunąć starych części PV; nowy zapis jest aktywny.' : ''), !p.ok);
    } catch (e) { say('Pobieranie/zapis PV nie powiodły się: ' + e.message + '. Nie podmieniono dotychczasowych danych innych kart.', true); }
    finally { busy = false; updateFields(); }
  }
  async function reset() {
    if (busy || !ready) return;
    if (!resetArmed) {
      resetArmed = true; $('pvReset').textContent = 'Potwierdź: usuń tylko dane i ustawienia PV';
      say('Drugie kliknięcie wyczyści tylko przestrzeń pv-sim-v1-. eLicznik, RCE, depozyt i oba magazyny pozostaną nietknięte.');
      return;
    }
    busy = true; invalidate(); invalidateDiagnostics('Czyszczenie własnej przestrzeni PV…'); updateFields();
    try {
      await store.reset(); dataset = null; prepared = null; settings = defaults(); blocked = false;
      invalidate(); fill(); showDataStatus(); $('pvDiagnostics').textContent = 'Wyczyszczono wyłącznie kartę PV.';
      $('pvSaveStatus').textContent = ''; say('Usunięto wyłącznie własne dane i ustawienia karty PV.');
    } catch (e) { blocked = true; say('Nie udało się dokończyć czyszczenia PV: ' + e.message + '. Pozostałe karty nie zostały zmienione.', true); }
    finally { resetArmed = false; $('pvReset').textContent = 'Wyczyść tylko kartę PV'; busy = false; updateFields(); setupAuto(); }
  }
  function setupAuto() {
    if (autoTimer) clearInterval(autoTimer);
    autoTimer = settings.autoRefresh ? setInterval(() => { if (!root.hidden) fetchData(); }, 3600000) : null;
  }
  $('pvForm').addEventListener('submit', e => e.preventDefault());
  $('pvForm').addEventListener('change', async () => {
    if (!ready || busy || blocked) return;
    settings = readForm(); invalidate(); invalidateDiagnostics('Zmieniły się ustawienia. Sprawdź dane ponownie dla aktualnego wyboru.'); updateFields(); showDataStatus(); setupAuto();
    resetArmed = false; $('pvReset').textContent = 'Wyczyść tylko kartę PV';
    try { await store.saveSettings(settings); $('pvSaveStatus').textContent = 'Ustawienia zapisane osobno (pv-sim-v1-settings).'; }
    catch (e) { $('pvSaveStatus').textContent = 'Błąd zapisu ustawień PV: ' + e.message + '. Bieżące pola są tylko w pamięci; nie pokazujemy ich jako zapisane.'; }
  });
  $('pvFetch').addEventListener('click', fetchData);
  $('pvDiagnose').addEventListener('click', diagnose);
  $('pvCalculate').addEventListener('click', calculate);
  $('pvReset').addEventListener('click', reset);
  document.querySelector('[data-tab="pv"]').addEventListener('click', () => {
    if (result) { invalidate(); say('Ponownie otwarto kartę — przelicz na bieżącej migawce eLicznika i cen.'); }
    if (ready && settings.autoRefresh) fetchData();
  });
  fill();
  (async () => {
    try {
      store = S.create(window.storage);
      const saved = await store.loadSettings();
      if (saved) settings = restore(saved);
      else {
        // Odczyt, nigdy zmiana opcji dodatku. Brak BMS oznacza brak diagnozy,
        // nie zastępowanie jego przepływów Growattem ani zerami.
        try {
          const r = await fetch('api/config');
          if (r.ok) { const c = await r.json(); settings.entities.bmsCharge = typeof c.bmsChargeEntity === 'string' ? c.bmsChargeEntity : '';
            settings.entities.bmsDischarge = typeof c.bmsDischargeEntity === 'string' ? c.bmsDischargeEntity : ''; }
        } catch (_) {}
      }
      const cached = await store.loadDataset();
      if (cached) dataset = { signature: cached.signature, fetchedAt: cached.fetchedAt, series: D.mergeSeries(cached.parts) };
    } catch (e) { blocked = true; say('Nie udało się odczytać własnego zapisu PV: ' + e.message + '. Nie nadpisano historii. Możesz jawnie wyczyścić wyłącznie kartę PV.', true); }
    finally {
      ready = true; fill(); showDataStatus(); setupAuto(); root.dataset.ready = 'true';
      if (!root.hidden && settings.autoRefresh && !blocked) fetchData();
    }
  })();
})();
