/* Karta Rozbudowa PV. Celowo NIE wywołuje render/saveState/recomputeMonths,
 * nie zna state.months ani źródeł legacy. Bridge udostępnia wyłącznie kopię. */
(function () {
  'use strict';
  const root = document.getElementById('tab-pv');
  if (!root) return;
  const M = window.G13PvModel, D = window.G13PvData, S = window.G13PvStore, U = window.G13PvForm, X = window.G13PvExport;
  if (!M || !D || !S || !U || !X || !window.G13PvReadOnly) {
    root.textContent = 'Nie załadowano modułów PV. Dotychczasowe karty działają niezależnie; odśwież stronę.';
    return;
  }
  const defaults = () => U.effective({
    startDate: '2026-09-01', endDate: '2026-10-31', calculationMode: 'export_only', exportPvToAcEta: .95, loadMode: 'conditional', gridSource: 'auto', gridPolicyVersion: 1, topology: '',
    existingKwp: 9.54, addedKwp: null, addedYieldFactor: 1,
    capacityKwh: 14.336, minSocPct: 10, maxSocPct: 100, initialSocPct: 10,
    chargeCurrentA: null, dischargeCurrentA: null, batteryVoltageV: U.voltage, efficiencyMode: 'estimate-v1',
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
    ['exportPvToAcEta', 'Sprawność PV DC → AC · %', 'Jedyna sprawność trybu eksportu. Orientacyjne 95% to założenie, nie pomiar. Własna wartość nie zmienia sprawności modelu baterii.'],
    ['capacityKwh', 'Nominalna bateria · kWh', '14,336 kWh w całym zakresie SOC, nie zmierzona pojemność użytkowa.'],
    ['minSocPct', 'Rezerwa modelu · % SOC', '10% tylko w modelu. Rzeczywistego progu 30% nie zmieniamy.'],
    ['maxSocPct', 'Górny SOC modelu · %', 'To samo okno w obu modelach; odejmujemy rezerwę tylko raz.'],
    ['initialSocPct', 'SOC na początku okresu · %', '10% to kandydat z analizy, nie pomiar graniczny. Identyczny start obu modeli.'],
    ['chargeCurrentA', 'Prąd ładowania baterii · A DC', 'Wpisz prąd scenariusza. 0 blokuje ładowanie; puste pole pozostaje nieznane.'],
    ['dischargeCurrentA', 'Prąd rozładowania baterii · A DC', 'Osobny prąd scenariusza. Nie jest to prąd AC ani ustawienie wysyłane do falownika.'],
    ['batteryVoltageV', 'Napięcie odniesienia baterii · V DC', 'Domyślnie modelowe 51,2 V (16 × 3,2 V). Nie jest bieżącym pomiarem ani stałym napięciem rzeczywistej baterii. Zmiana V przy stałych A zmienia limit kW modelu.'],
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
  const percentages = new Set(['exportPvToAcEta', 'pvToAcEta', 'pvToBatteryEta', 'batteryToAcEta', 'acToBatteryEta', 'storeChargeEta', 'storeDischargeEta', 'depositUseFraction']);
  const entities = [
    ['pv', 'PV DC · licznik kWh'], ['acOutput', 'Wyjście falownika AC · licznik kWh'],
    ['acCharge', 'Ładowanie AC · licznik kWh'], ['bmsCharge', 'BMS ładowanie DC · licznik kWh'],
    ['bmsDischarge', 'BMS rozładowanie DC · licznik kWh'], ['soc', 'SOC · statystyki %'],
    ['pvPower', 'Moc PV · jednostka sprawdzana w HA (tylko diagnostyka)'], ['house', 'Niezależny dom AC · licznik kWh (opcjonalny)'],
  ];
  let settings = defaults(), dataset = null, exportDataset = null, result = null, prepared = null, gridDataset = null, pendingGrid = null;
  let store, busy = false, blocked = false, ready = false, resetArmed = false, autoTimer = null, gridMigrationNotice = '', modeMigrationNotice = '';
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
    <header class="pv-heading"><div><span class="eyebrow">Osobny kalkulator · 0.3.8</span><h2>Rozbudowa PV</h2></div><span class="pv-badge">Symulacja scenariusza</span></header>
    <div id="pvModeNotice" class="pv-notice"><strong>Nie jest to zwalidowana rekonstrukcja pomiarów.</strong> Porównujemy dwa modele: obecne PV i PV po rozbudowie — z dynamiczną obecną baterią, bez planowego ładowania z sieci. Dane historyczne i ich rozbieżności pokazujemy osobno. Nic nie trafia do salda depozytu, autokonsumpcji ani kalkulatora drugiego magazynu.</div>
    <form id="pvForm" novalidate>
      <div class="pv-field pv-mode-selector"><label for="pv-calculationMode">Sposób liczenia korzyści z rozbudowy</label><select id="pv-calculationMode"><option value="export_only">Prosty: dodatkowa produkcja PV wyceniona jako eksport</option><option value="dynamic_battery">Zaawansowany: dwa modele z dynamiczną obecną baterią</option></select><p id="pvModeHint" class="pv-muted"></p><p id="pvModeMigration" class="pv-muted"></p></div>
      <section class="panel pv-section"><div class="panel-header-row"><h3>1 · Dane i okres</h3><span class="pv-muted">Daty włącznie · Europe/Warsaw</span></div>
        <div class="pv-grid pv-period"><div class="pv-field"><label for="pv-startDate">Od</label><input id="pv-startDate" type="date"></div><div class="pv-field"><label for="pv-endDate">Do</label><input id="pv-endDate" type="date"></div><div id="pvLoadModeField" class="pv-field pv-wide"><label for="pv-loadMode">Zapotrzebowanie domu</label><select id="pv-loadMode"><option value="conditional">Warunkowe H = wyjście AC + import − eksport − ładowanie AC</option><option value="meter">Osobny, zadeklarowany licznik domu AC (bez ładowania baterii)</option></select></div></div>
        <p id="pvLoadHelp" class="pv-muted">H nie jest niezależnym pomiarem domu. Licznik ładowania AC nie oznacza fakturowanego zakupu baterii. Nie odejmujemy go od BMS DC ani nie obcinamy do importu. Przy drugim wariancie odpowiedzialność za granicę pomiaru pozostaje jawna — nazwa encji jej nie potwierdza.</p>
        <details><summary>Niezależne źródła HA — pokaż / zmień</summary><p id="pvEntityHelp" class="pv-muted">Liczniki: kWh i przyrost change. BMS/SOC/moc są diagnostyką, nie sterują symulacją. Encje BMS można odczytać z opcji dodatku; ich wpisanie tutaj nie zmienia tych opcji ani growatt_entities.</p><div id="pvEntities" class="pv-grid"></div></details>
        <div class="pv-actions"><button id="pvFetch" type="button" class="btn-secondary">Pobierz dane HA dla tej karty</button><button id="pvDiagnose" type="button" class="btn-ghost">Sprawdź dane</button><label class="pv-check"><input id="pv-autoRefresh" type="checkbox"> Odświeżaj dane przy wejściu i co 60 min w otwartej karcie</label></div>
        <div id="pvDataStatus" class="pv-muted" role="status">Brak własnej historii PV.</div>
        <div id="pvGridAutoStatus" class="pv-notice" role="status">eLicznik: sprawdzanie zapisanych źródeł…</div>
        <p id="pvGridMigration" class="pv-muted"></p>
        <details id="pvGridDetails"><summary>eLicznik dla PV — źródła, diagnostyka i archiwalny CSV</summary>
          <p id="pvGridExplanation" class="pv-muted">Automatycznie używamy kompletnych danych zapisanych w dodatku; stare braki potwierdzenia uzupełnia wcześniej sprawdzony CSV PV. Cała godzina pochodzi z jednego źródła. Nie dopisujemy flag, nie sumujemy dwóch źródeł i nie zmieniamy rozliczeń. Nowe kompletne importy w głównej karcie nie wymagają ponownego wgrywania tutaj. To nie jest pobieranie danych z Taurona.</p>
          <div class="pv-field"><label for="pv-gridSource">Źródło eLicznika używane w PV</label><select id="pv-gridSource"><option value="auto">Automatycznie — dane dodatku + zapisany CSV PV</option><option value="shared">Tylko dotychczasowe dane — odczyt, bez CSV PV</option><option value="csv">Tylko osobny, sprawdzony CSV zapisany w PV</option></select></div>
          <div class="pv-actions"><button id="pvGridCheck" type="button" class="btn-ghost">Sprawdź zapis eLicznika — tylko odczyt</button></div><div id="pvGridReport" role="status">Kliknij, aby zobaczyć liczbę rekordów, brakujących znaczników i nieprawidłowych wartości.</div>
          <label for="pvGridFile">Oryginalne CSV Tauron eLicznik (oba kierunki, etykiety końca godziny 1–24)</label><input id="pvGridFile" type="file" accept=".csv,text/csv" multiple>
          <p id="pvGridArchiveHelp" class="pv-muted">CSV jest potrzebny tylko do uzupełnienia starych, niepotwierdzonych zapisów. Już zapisanych plików nie trzeba wgrywać ponownie przy otwarciu karty. Jeśli wymieniasz archiwum CSV PV, wybierz razem wszystkie pliki, które chcesz w nim zachować: nowy zestaw zastępuje poprzedni, nie łączy się z nim i nie zmienia źródłowych CSV. Brak kierunku pozostaje nieznany; powtórzona godzina wymaga obu rekordów każdego kierunku i osobnej zgody na krok 2 h. Inny format/status pomiaru jest odrzucany.</p>
          <p id="pvGridPreview" role="status">Wybór pliku przygotowuje tylko podgląd. Zapis wymaga przycisku poniżej.</p><button id="pvGridImport" type="button" class="btn-secondary">Zapisz CSV i używaj automatycznie tylko w PV</button>
        </details>
        <label class="pv-check"><input id="pv-allowDstAggregation" type="checkbox"> Akceptuję przybliżenie wspólnego kroku 2 h dla powtórzonej godziny zmiany czasu. RCE tej godziny pozostaje nieznane, jeśli cache nie rozróżnia obu godzin.</label>
      </section>
      <section class="panel pv-section"><h3>2 · Prosty formularz scenariusza</h3><p id="pvScenarioIntro" class="pv-muted">Podaj dodatkowe PV, prądy baterii oraz ograniczenia instalacji. Nie musisz samodzielnie wpisywać sześciu sprawności. Ustawienia nie sterują urządzeniami.</p>
        <div class="pv-field"><label for="pv-topology">Scenariusz podłączenia nowych paneli</label><select id="pv-topology"><option value="">Wybierz scenariusz — podłączenie nie jest jeszcze ustalone</option><option value="dc_shared">DC: nowe i obecne panele na wspólnym falowniku hybrydowym</option><option value="ac_added">AC: nowy falownik PV, istniejąca hybryda może przyjąć nadwyżkę AC</option></select><small id="pvTopologyHelp">Wariant AC zakłada dostępność takiego sterowania ładowaniem; nie potwierdza możliwości WIT. Połączenia elektryczne/MPPT wymagają osobnego projektu.</small></div>
        <div id="pvParameters" class="pv-grid"></div>
        <p id="pvCurrentInfo" class="pv-notice"></p>
        <p id="pvExportEtaInfo" class="pv-notice" hidden></p><div id="pvEfficiencyControl" class="pv-field"><label for="pv-efficiencyMode">Sprawności i straty</label><select id="pv-efficiencyMode"><option value="estimate-v1">Orientacyjne straty — gotowe założenia, nie pomiar</option><option value="custom">Własne wartości — ustawienia zaawansowane</option></select></div>
        <p id="pvEfficiencyInfo" class="pv-muted"></p>
        <details id="pvAdvanced"><summary id="pvAdvancedSummary">Zaawansowane: bateria, napięcie, własne sprawności i pozostałe założenia</summary><div id="pvAdvancedParameters" class="pv-grid"></div><h4 id="pvEfficiencyHeading">Sprawności torów — wszystkie użyte wartości są jawne</h4><p id="pvEfficiencyHelp" class="pv-muted">W wariancie orientacyjnym pola są tylko do odczytu. Nie wyznaczamy sprawności z ilorazu historycznych liczników. Aby wpisać własne wartości, wybierz „Własne wartości” powyżej.</p><div id="pvEfficiencyParameters" class="pv-grid"></div></details>
        <div class="pv-checks"><label class="pv-check"><input id="pv-unlimitedInverter" type="checkbox"> Jawnie idealizuję: bez limitu konwersji istniejącej hybrydy</label><label class="pv-check"><input id="pv-unlimitedAddedInverter" type="checkbox"> Jawnie idealizuję: bez limitu dodatkowego falownika AC</label><label class="pv-check"><input id="pv-unlimitedExport" type="checkbox"> Jawnie idealizuję: bez limitu eksportu</label></div>
        <p id="pvWindow" class="pv-notice"></p>
        <details id="pvDynamicAssumptions"><summary>Co model upraszcza?</summary><ul class="pv-muted"><li>Nowe PV = historyczne PV DC × dodatkowe kWp / 9,54 × względny uzysk. To profil po historycznych ograniczeniach — nie odzyskujemy utraconej produkcji ani nie znamy przyszłego zacienienia.</li><li>Stałe/średnie moce w kroku 1 h (wyjątkowo 2 h): brak gwarancji ograniczeń chwilowych, przepięć, limitów prądu/napięcia MPPT lub zgodności instalacyjnej.</li><li>Wariant AC: nowy falownik najpierw zasila dom, istniejące PV DC ma pierwszeństwo ładowania. Konwersje w obu kierunkach dzielą budżet mocy istniejącej hybrydy.</li><li>Liniowe SOC → energia; jawne sprawności torów i baterii. Brak modelu starzenia, temperatury, poboru własnego i podtrzymania SOC. Żadnych dopasowanych „strat”, aby zamknąć historię.</li><li>W obu modelach identyczny start, progi i strategia. Wynik nie zawiera korzyści z obniżenia rzeczywistego progu 30% lub zmiany ręcznego sterowania.</li><li>Zakup: aktualnie zapisane stawki G13 odczytane bez modyfikacji. Depozyt: RCE godzinowe, ujemne ceny → 0, mnożnik 1,23 od lutego 2025. Nieznanych cen nie zastępujemy zerem ani stawką płaską.</li><li>Brak rocznego przeliczenia i okresu zwrotu. Końcowy zapas energii nie jest wyceniany. Zmiana depozytu nie jest wypłatą gotówkową.</li></ul></details>
      </section>
      <details id="pvExportAssumptions" class="panel pv-section" hidden><summary>Założenia prostego trybu eksportu — przeczytaj</summary><ul class="pv-muted"><li>Nowe PV = historyczne PV DC × dodatkowe kWp / obecne kWp × względny uzysk. Nie skalujemy eksportu eLicznika. Profil zawiera już skutki historycznego ograniczania/awarii; nie odzyskujemy brakującej produkcji.</li><li>Cały dostępny przyrost traktujemy jako eksport. Rzeczywista autokonsumpcja i ładowanie baterii mogłyby go zmniejszyć. Nie rekonstruujemy instalacji bez magazynu.</li><li>Wspólny DC: różnica krzywych konwersji samego PV przed/po rozbudowie. Nie znamy zajęcia hybrydy przez baterię, prądów/napięć MPPT ani przyszłych ograniczeń.</li><li>Eksport eLicznika jest punktem odniesienia dla wolnego miejsca w limicie całego układu. Historia ponad zadanym limitem daje ostrzeżenie i brak miejsca na przyrost — bez obcięcia historii. Przy świadomie nieograniczonym eksporcie nie wymagamy tego punktu odniesienia.</li><li>Moce średnie w 1 h lub jawnym kroku 2 h nie gwarantują dotrzymania limitów chwilowych. Nowe panele mogą mieć inny profil, orientację, zacienienie i temperaturę.</li><li>Wyceniamy tylko dodatkowy eksport według zapisanych RCE. Brak ceny przy dodatniej energii oznacza nieznaną pełną kwotę. Depozyt nie jest gotówką; nie wyliczamy rocznego zwrotu ani oszczędności G13.</li><li>H, ładowanie AC, BMS i SOC nie są potrzebne temu trybowi. Błędy tych danych nie zostały naprawione i nadal obowiązują w modelu z baterią. Kompletność/czas PV DC nadal podlegają kontroli.</li></ul></details>
      <section class="panel pv-section"><h3 id="pvCalculationHeading">3 · Oblicz różnicę dwóch modeli</h3>
        <label class="pv-check"><input id="pv-acceptScenario" type="checkbox"><span id="pvAcceptanceText">Rozumiem warunkowy charakter zapotrzebowania/źródeł, strat i ograniczeń. Akceptuję wpisane założenia wyłącznie jako scenariusz, bez uznawania historii za fizycznie zwalidowaną.</span></label>
        <div class="pv-actions"><button id="pvCalculate" type="button" class="btn-primary">Porównaj obecne PV i rozbudowę</button><button id="pvReset" type="button" class="btn-danger-ghost">Wyczyść tylko kartę PV</button></div>
        <p id="pvStatus" role="status" aria-live="polite">Uzupełnij parametry wybranego trybu, podłączenie i limity. W trybie eksportu bateria i dom nie są potrzebne. Założenia wymagają akceptacji; brak limitu musi być jawny.</p><p id="pvSaveStatus" class="pv-muted"></p>
      </section>
    </form>
    <section class="panel pv-section" aria-labelledby="pvDiagnosticsHeading"><h3 id="pvDiagnosticsHeading">Diagnostyka danych historycznych</h3><div id="pvDiagnostics">Po pobraniu sprawdzimy kompletność, granice czasu oraz rozbieżności. Brak danych nie oznacza zerowych przepływów.</div></section>
    <section id="pvResults" class="pv-section" aria-live="polite" hidden></section>`;
  const basicFields = new Set(['addedKwp', 'exportPvToAcEta', 'chargeCurrentA', 'dischargeCurrentA', 'inverterAcKw', 'addedInverterAcKw', 'exportAcKw', 'costPln']);
  for (const f of fields) $(U.etaKeys.includes(f[0]) ? 'pvEfficiencyParameters' : basicFields.has(f[0]) ? 'pvParameters' : 'pvAdvancedParameters').append(field(...f));
  for (const [key, label] of entities) $('pvEntities').append(field(key, label, '', true));
  const bools = ['unlimitedInverter', 'unlimitedAddedInverter', 'unlimitedExport', 'allowDstAggregation', 'acceptScenario', 'autoRefresh'];
  const texts = ['startDate', 'endDate', 'calculationMode', 'loadMode', 'topology', 'gridSource', 'efficiencyMode'];
  function restore(s) {
    const n = defaults();
    for (const [key] of fields) if (Object.prototype.hasOwnProperty.call(s, key)) n[key] = s[key];
    for (const key of texts) if (typeof s[key] === 'string') n[key] = s[key];
    for (const key of bools) n[key] = s[key] === true;
    for (const [key] of entities) if (s.entities && typeof s.entities[key] === 'string') n.entities[key] = s.entities[key];
    // Baza instalacji nie migruje z obcych ustawień.
    n.existingKwp = 9.54;
    const choice = D.restoreGridSelection(s);
    n.gridSource = choice.gridSource; n.gridPolicyVersion = choice.gridPolicyVersion;
    if (choice.migrated) {
      n.acceptScenario = false;
      gridMigrationNotice = '0.3.7: przywrócono wcześniejszą historię i parametry. W formularzu włączono automatyczny wybór zapisanych źródeł (poprzednio: '
        + (choice.previousSource === 'csv' ? 'osobny CSV' : 'dane dodatku') + '). Nie trzeba ponownie importować zapisanych plików. '
        + 'Rozliczeń i rekordów nie zmieniono. Ponownie zaakceptuj scenariusz przed obliczeniem; zmiana pola zapisze nowy wybór tylko w PV.';
    }
    n.calculationMode = X.mode(s);
    if (s.calculationMode === undefined) modeMigrationNotice = '0.3.8: przywrócono dotychczasowy model z baterią, bez cichej zmiany znaczenia. Aby użyć uproszczenia, wybierz „Prosty: dodatkowa produkcja PV wyceniona jako eksport”. Dane i parametry są zachowane; nowy tryb wymaga ponownej akceptacji.';
    const restored = U.restore(s, n);
    if (!Object.prototype.hasOwnProperty.call(s, 'exportPvToAcEta')) restored.exportPvToAcEta = restored.pvToAcEta;
    return restored;
  }
  function inputText(key, value) {
    return value === null || value === undefined ? ''
      : String(percentages.has(key) ? Number((value * 100).toFixed(6)) : value);
  }
  function fill() {
    for (const [key] of fields) $('pv-' + key).value = inputText(key, settings[key]);
    for (const key of texts) $('pv-' + key).value = settings[key];
    for (const key of bools) $('pv-' + key).checked = settings[key] === true;
    for (const [key] of entities) $('pv-entity-' + key).value = settings.entities[key];
    $('pvGridMigration').textContent = gridMigrationNotice;
    updateFields();
  }
  function readForm(changedId) {
    const n = defaults();
    for (const [key] of fields) {
      const raw = $('pv-' + key).value.trim();
      // Zmiana innego pola nie zaokrągla dawnych ręcznych sprawności tylko
      // dlatego, że procenty prezentujemy z ograniczoną liczbą cyfr.
      n[key] = changedId !== 'pv-' + key && raw === inputText(key, settings[key]) ? settings[key]
        : raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) / (percentages.has(key) ? 100 : 1) : null;
    }
    n.existingKwp = 9.54;
    for (const key of texts) n[key] = $('pv-' + key).value;
    for (const key of bools) n[key] = $('pv-' + key).checked;
    for (const [key] of entities) n.entities[key] = $('pv-entity-' + key).value.trim();
    n.customEfficiencies = settings.customEfficiencies || null;
    return n;
  }
  function updateFields() {
    root.querySelectorAll('input,select,button').forEach(n => { n.disabled = busy || !ready || (blocked && n.id !== 'pvReset'); });
    if (!busy && ready && !blocked) {
      const ac = settings.topology === 'ac_added';
      $('pv-addedInverterAcKw').disabled = !ac || settings.unlimitedAddedInverter;
      for (const key of U.etaKeys) $('pv-' + key).disabled = settings.efficiencyMode !== 'custom';
      $('pv-acToBatteryEta').disabled = !ac || settings.efficiencyMode !== 'custom';
      $('pv-unlimitedAddedInverter').disabled = !ac;
      $('pv-inverterAcKw').disabled = settings.unlimitedInverter;
      $('pv-exportAcKw').disabled = settings.unlimitedExport;
      $('pv-entity-house').disabled = settings.loadMode !== 'meter';
      $('pvGridImport').disabled = !pendingGrid;
    }
    $('pvCurrentInfo').textContent = 'Przyjęte napięcie modelu: ' + number(settings.batteryVoltageV, 2) + ' V DC. '
      + 'Ładowanie: ' + number(settings.chargeCurrentA) + ' A → ' + number(settings.chargeDcKw, 3) + ' kW DC; rozładowanie: '
      + number(settings.dischargeCurrentA) + ' A → ' + number(settings.dischargeDcKw, 3) + ' kW DC. P = I × U / 1000. '
      + 'To stałe limity mocy modelu; rzeczywiste napięcie zmienia się. Nie jest to gwarancja utrzymania podanego prądu w całym zakresie SOC.';
    const cycle = U.cycleAcEta(settings);
    $('pvEfficiencyInfo').textContent = settings.efficiencyMode === 'estimate-v1'
      ? 'Założenia orientacyjne, NIE pomiar: konwersja AC/DC 95%, tor PV DC do zacisków baterii 98%, zapis i oddanie energii wewnątrz baterii po 98%. Wynikowy cykl AC → bateria → AC: ' + number(cycle * 100, 1) + '% — to iloczyn tych strat, nie dodatkowy mnożnik. Te same wartości w obu modelach.'
      : 'Zachowano własne sprawności. Rozwiń „Zaawansowane”, aby je sprawdzić lub zmienić. Wynikowy cykl AC → bateria → AC: ' + (cycle === null ? 'nieznany' : number(cycle * 100, 1) + '%') + '. To założenia scenariusza, nie potwierdzona kalibracja.';
    const c = settings.capacityKwh, lo = settings.minSocPct, hi = settings.maxSocPct, initial = settings.initialSocPct;
    const valid = [c, lo, hi, initial].every(x => typeof x === 'number' && Number.isFinite(x));
    $('pvWindow').textContent = valid
      ? 'Okno energii nominalnej: ' + number(c * (hi - lo) / 100, 4) + ' kWh przed stratami. Start obu modeli: '
        + number(c * initial / 100, 4) + ' kWh, ponad rezerwą: ' + number(c * (initial - lo) / 100, 4)
        + ' kWh. Nie podnosimy stanu do rezerwy za darmo. Fizyczny próg falownika pozostaje bez zmian.'
      : 'Brak pełnych parametrów energii/SOC. Nie zastępujemy ich zerem.';
    applyModeView();
  }
  function invalidate() { result = null; $('pvResults').replaceChildren(); $('pvResults').hidden = true; }
  function invalidateDiagnostics(message) { prepared = null; $('pvDiagnostics').textContent = message; }
  function showDataStatus() {
    if (exportMode()) {
      const picked = X.pickDataset(settings, dataset, exportDataset);
      if (!picked) {
        $('pvDataStatus').textContent = 'Brak zgodnego zapisu PV DC obejmującego wybrany zakres. Pobierz dane HA dla tego zakresu; wcześniejsze historie pozostają zachowane. Krótki zapis nie zastępuje pełnego miesiąca.';
      } else {
        $('pvDataStatus').textContent = 'Używany cały zapis: ' + (picked.origin === 'export' ? 'osobna historia prostego trybu' : 'wcześniejsza historia PV — ponowne użycie licznika DC')
          + '. Zapisano: ' + picked.dataset.fetchedAt + '. Zakres zapisu: ' + picked.match.originalStartDate + ' – ' + picked.match.originalEndDate
          + (picked.match.subset ? '; wybrano podzakres.' : '; zakres zgodny.')
          + ' Nie trzeba pobierać ponownie tylko z powodu zmiany trybu. Kompletność godzin i bufor sprawdzamy osobno; nie jest to potwierdzenie jakości pomiarów.';
      }
      return;
    }
    if (!dataset) { $('pvDataStatus').textContent = 'Brak własnej historii PV. Pozostałe karty i ich zapisy pozostają nietknięte.'; return; }
    let matches = false; try { matches = dataset.signature === D.signature(settings); } catch (_) {}
    $('pvDataStatus').textContent = 'Ostatni zapis własnej historii: ' + dataset.fetchedAt + '. '
      + (matches ? 'Zakres i lista encji zgodne z formularzem. Nie jest to potwierdzenie jakości pomiarów.' : 'Zmieniono zakres/kanały — pobierz dane dla aktualnego wyboru. Stare dane zachowano.');
  }
  function gridSummary(label, q) {
    if (q.direction === 'export_only') return label + ': potwierdzony EKSPORT ' + q.validBlocks + '/' + q.expectedBlocks
      + ' przedziałów (' + q.expectedHours + ' h UTC). Brak rekordu: ' + q.missingRows + '; bez flag eksportu: ' + q.missingExportFlags
      + '; niepotwierdzone flagi: ' + q.rejectedExportFlags + '; nieprawidłowe wartości eksportu: ' + q.invalidExportValues
      + '; niepotwierdzony eksport kroku 2 h: ' + q.unconfirmedDstBlocks + '. Import i G13 nie są kontrolą tego trybu.';
    return label + ': ' + q.validBlocks + '/' + q.expectedBlocks + ' kompletnych przedziałów (' + q.expectedHours + ' h UTC). '
      + 'Brak rekordu: ' + q.missingRows + '; bez flag poboru/oddania: ' + q.missingImportFlags + '/' + q.missingExportFlags
      + '; niepotwierdzone flagi poboru/oddania: ' + q.rejectedImportFlags + '/' + q.rejectedExportFlags
      + '; nieprawidłowe wartości poboru/oddania: ' + q.invalidImportValues + '/' + q.invalidExportValues
      + '; niepotwierdzona kompletność kroku 2 h: ' + q.unconfirmedDstBlocks + '. Liczniki mogą się pokrywać.';
  }
  function gridLabel(source) {
    return source === 'auto' ? 'wybór automatyczny' : source === 'csv' ? 'osobny CSV PV' : source === 'shared' ? 'dane dodatku' : 'niepotwierdzone';
  }
  function renderGridReport(g) {
    const box = $('pvGridReport'); box.replaceChildren();
    const c = g.selection;
    const info = 'eLicznik · ' + gridLabel(g.source) + (g.direction === 'export_only' ? ' · tylko eksport: ' : ': ') + g.selected.validBlocks + '/' + g.selected.expectedBlocks
      + ' kompletnych przedziałów. Z danych dodatku: ' + c.sharedBlocks + '; z zapisanego CSV PV: ' + c.csvBlocks
      + '; niepotwierdzone: ' + c.unresolvedBlocks + '; konflikty: ' + g.conflictingBlocks + '.';
    $('pvGridAutoStatus').textContent = info;
    box.append(el('p', gridSummary('Dotychczasowe dane — tylko odczyt', g.shared)));
    if (g.csv) box.append(el('p', gridSummary('Zapisany CSV PV', g.csv)));
    box.append(el('p', 'Źródło używane w PV: ' + gridLabel(g.source) + '. ' + gridSummary('Wybrany zakres', g.selected)));
    if (g.source === 'auto' && c.unresolvedBlocks) box.append(el('p', g.direction === 'export_only'
      ? 'Nie potwierdzono eksportu we wszystkich godzinach. Nie użyto zera ani nie pobrano danych z Taurona. Dla limitowanego eksportu to blokada; jawny wariant bez limitu może wycenić sam przyrost bez historycznego punktu odniesienia.'
      : 'Dla niepotwierdzonych godzin żadne zapisane źródło nie dowodzi obu kierunków. Nie pobrano braków z Taurona ani nie zastąpiono ich zerami. Stare archiwum bez flag wymaga jednorazowego potwierdzenia oryginalnym CSV; powtórzona godzina wymaga dwóch rekordów każdego kierunku.', 'pv-muted'));
    if (g.conflictingBlocks) {
      box.append(el('p', 'CSV różni się wartościami/strefą od dotychczasowych zapisów w ' + g.conflictingBlocks
        + ' przedziałach. Niczego nie nadpisano; przed symulacją trzeba wyjaśnić różnicę.', 'pv-error'));
      const detail = el('details'); detail.append(el('summary', 'Pokaż wszystkie różnice źródeł (' + g.conflictingBlocks + ')'));
      if (g.direction === 'export_only') detail.append(table(['Godzina lokalna', 'Eksport dodatku', 'Eksport CSV'],
        g.conflictDetails.map(r => [r.key, number(r.shared.oddaniePoZbil, 6), number(r.csv.oddaniePoZbil, 6)]), 'Tylko eksport w kWh. Rozbieżności importu/G13 nie należą do tego trybu.'));
      else {
      detail.append(table(['Godzina lokalna', 'Import dodatku', 'Import CSV', 'Eksport dodatku', 'Eksport CSV', 'Strefy: dodatek / CSV'],
        g.conflictDetails.map(r => [r.key, number(r.shared.poborPoZbil, 6), number(r.csv.poborPoZbil, 6),
          number(r.shared.oddaniePoZbil, 6), number(r.csv.oddaniePoZbil, 6), (r.shared.strefa || 'nieznana') + ' / ' + (r.csv.strefa || 'nieznana')]), 'Energia w kWh. Odczyt, bez nadpisania żadnego źródła.'));
      }
      box.append(detail);
    }
    if (gridDataset) box.append(el('p', 'Zapisany osobny zestaw CSV: ' + gridDataset.sources.join(', ') + '. Rekordy: ' + gridDataset.rows.length + '.', 'pv-muted'));
  }
  async function showGridReport() {
    try {
      await window.G13PvReadOnly.whenReady;
      renderGridReport(dataModule().gridView(window.G13PvReadOnly.getSnapshot(), settings, gridDataset).diagnostics);
    } catch (e) {
      $('pvGridReport').replaceChildren(el('p', e.message, 'pv-error'));
      $('pvGridAutoStatus').textContent = 'Nie sprawdzono eLicznika: ' + e.message;
    }
  }
  function readLocalFile(file) {
    if (typeof file.text === 'function') return file.text();
    return new Promise((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Nie udało się odczytać wybranego CSV.'));
      reader.readAsText(file, 'UTF-8');
    });
  }
  async function previewGridFiles(e) {
    e.stopPropagation(); // wybór pliku NIE zapisuje ustawień formularza
    if (busy || !ready || blocked) return;
    const files = Array.from(e.target.files || []); pendingGrid = null; invalidate();
    resetArmed = false; $('pvReset').textContent = 'Wyczyść tylko kartę PV';
    if (!files.length) { $('pvGridPreview').textContent = 'Nie wybrano CSV.'; updateFields(); return; }
    busy = true; updateFields();
    try {
      if (files.length > 48 || files.reduce((n, f) => n + f.size, 0) > 16 * 1024 * 1024) throw new Error('Maksymalnie 48 plików / 16 MB łącznie.');
      const texts = [];
      for (const f of files) texts.push({ name: f.name, text: await readLocalFile(f) });
      pendingGrid = D.parseGridCsvFiles(texts);
      const map = Object.fromEntries(pendingGrid.rows.map(r => [r.key, r]));
      $('pvGridPreview').textContent = 'Podgląd — jeszcze NIC nie zapisano. ' + gridSummary('Wybrane CSV', D.inspectGrid(map, settings.startDate, settings.endDate))
        + ' Zapis zastąpi tylko poprzedni osobny zestaw CSV karty PV, nie doda jego energii ponownie.';
    } catch (err) { pendingGrid = null; $('pvGridPreview').textContent = 'CSV odrzucony: ' + err.message + ' Poprzedni zapis pozostał bez zmian.'; }
    finally { busy = false; updateFields(); }
  }
  async function importGrid() {
    if (busy || !ready || blocked || !pendingGrid) return;
    busy = true; invalidate(); invalidateDiagnostics('Zapis osobnego eLicznika PV…'); updateFields();
    try {
      const next = D.validateGridDataset(pendingGrid);
      const saved = await store.saveGridDataset(next);
      gridDataset = next; pendingGrid = null; settings.gridSource = 'auto'; settings.gridPolicyVersion = 1; fill();
      let selectionWarning = '';
      try { await store.saveSettings(settings); }
      catch (_) { selectionWarning = ' CSV zapisano, ale nie udało się zapisać wyboru źródła. Po ponownym otwarciu sprawdź wybór „Źródło eLicznika”.'; }
      $('pvGridFile').value = '';
      $('pvGridPreview').textContent = 'Zapisano CSV wyłącznie w pv-sim-v1-. Włączono automatyczny wybór źródeł. Nie zaimportowano go do Depozytu ani Magazynu.' + selectionWarning
        + (saved.cleanupWarning ? ' Nowy zestaw aktywny; usuwanie starych części PV nie powiodło się.' : '');
      say('Osobny CSV eLicznika zapisany dla PV. Automatyczny wybór użyje go tylko tam, gdzie potrzeba potwierdzenia. Samego modelu nie uruchomiono.' + selectionWarning, !!selectionWarning);
      await showGridReport();
    } catch (e) { say('Zapis CSV dla PV nie powiódł się: ' + e.message + '. Nie zmieniono dotychczasowych rozliczeń.', true); }
    finally { busy = false; updateFields(); }
  }

  function table(heads, rows, caption) {
    const scroll = el('div', undefined, 'table-scroll'); const t = el('table');
    if (caption) t.append(el('caption', caption));
    const th = el('thead'), tr = el('tr'); for (const h of heads) tr.append(el('th', h)); th.append(tr); t.append(th);
    const b = el('tbody'); for (const values of rows) { const r = el('tr'); values.forEach((v, i) => r.append(el('td', v, i ? 'num' : 'col-month'))); b.append(r); }
    t.append(b); scroll.append(t); return scroll;
  }
  function diagnostics(p) {
    if (p.kind === 'export_only_inputs') { renderExportDiagnostics(p); return; }
    const box = $('pvDiagnostics'); box.replaceChildren();
    const q = p.diagnostics;
    renderGridReport(q.grid);
    box.append(el('p', gridSummary('eLicznik · ' + gridLabel(q.grid.source), q.grid.selected)));
    box.append(el('p', 'Moc PV ze znaną jednostką: ' + q.pvPowerKnownHours + '/' + q.expectedHours + ' h; bez potwierdzonej jednostki: ' + q.powerUnknownUnitHours + ' h. Brak jednostki wyłącza tylko porównanie z mocą, nie skaluje liczników kWh.', 'pv-muted'));
    box.append(el('p', 'Oczekiwane godziny UTC: ' + q.expectedHours + ' · kroki modelu: ' + q.intervalCount + ' · kroki 2 h: ' + q.dstBlocks + '. Błędów blokujących: ' + q.errorCount + '.', q.errorCount ? 'pv-error' : 'pv-muted'));
    if (p.negativeHouseDetails.length) {
      const detail = el('div', undefined, 'pv-notice'); detail.id = 'pvHouseBreakdown';
      detail.append(el('h4', 'Dlaczego model jest zablokowany — składniki ujemnego H (' + p.negativeHouseDetails.length + ')'));
      detail.append(el('p', 'H = wyjście AC + import − eksport − ładowanie AC. Wszystkie składniki poniżej to kWh w podanym przedziale. '
        + 'Nie zerujemy ujemnego H, nie przesuwamy liczników między godzinami i nie wycinamy tych przedziałów. '
        + 'Prądy, limity 12 kW ani sprawności scenariusza nie zmieniają tego historycznego równania.'));
      const reason = r => r.reason === 'export_exceeds_supply' ? 'Eksport > wyjście AC + import'
        : r.reason === 'charge_exceeds_remainder' ? 'Ładowanie AC > wyjście AC + import − eksport' : 'Ujemny licznik domu';
      detail.append(table(['Początek lokalny · Europe/Warsaw', 'Przedział UTC', '+ Wyjście AC', '+ Import', '− Eksport', '− Ładowanie AC', '= H', 'Źródło eLicznika', 'Niespójność arytmetyczna'],
        p.negativeHouseDetails.map(r => [r.key.replace('_', ' ') + ':00 · ' + r.durationHours + ' h',
          new Date(r.ts).toISOString() + ' → ' + new Date(r.endTs).toISOString(), number(r.acOutputKwh, 6),
          number(r.gridImportKwh, 6), number(r.gridExportKwh, 6), number(r.acChargeKwh, 6), number(r.houseKwh, 6), gridLabel(r.gridSource), reason(r)]),
        'Wszystkie ujemne godziny — bez zaokrąglania danych przed obliczeniem. To nie jest diagnoza uszkodzenia konkretnego sensora.'));
      detail.append(el('p', 'Suma ujemnych H: ' + number(p.negativeHouseDetails.reduce((n, r) => n + r.houseKwh, 0), 6)
        + ' kWh. To opis niespójności, nie energia do dopisania do bilansu. Granice pomiarów i czasu wymagają wyjaśnienia; osobny licznik domu można wybrać tylko, gdy rzeczywiście mierzy właściwy obwód.', 'pv-muted'));
      detail.append(el('p', 'Użyte encje HA: wyjście AC — ' + settings.entities.acOutput + '; ładowanie AC — ' + settings.entities.acCharge
        + '. Godziny eLicznika 1–24 są etykietami końca przedziału; tabela pokazuje początek po przeliczeniu, bez dodatkowego przesunięcia.', 'pv-muted'));
      box.append(detail);
    }
    box.append(el('p', 'Reszta R = PV DC + rozładowanie BMS DC + ładowanie AC − ładowanie BMS DC − wyjście AC. Znane godziny: '
      + q.residualKnownHours + '/' + q.expectedHours + '; reszta < −0,2 kWh: ' + q.residualBelowMinus02Hours
      + '; ujemne reszty ogółem: ' + q.negativeResidualHours + '; suma (tylko pełny okres): ' + kwh(q.residualSumKwh) + '. Nie dopasowujemy strat, by zamknąć ten bilans.'));
    box.append(el('p', 'Dodatnie ładowanie AC bez importu netto: ' + q.zeroImportPositiveAcBlocks + ' przedziałów; kontrola sieci możliwa tylko dla ' + q.grid.selected.validBlocks + '/' + q.intervalCount + ' przedziałów. Nietypowe zakresy SOC: ' + q.socRangeFlags
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
    if (exportMode()) {
      const picked = X.pickDataset(settings, dataset, exportDataset);
      if (!picked) throw new Error('Najpierw pobierz profil PV DC obejmujący wybrany zakres i encję. Krótka historia nie zastępuje pełnego okresu; wcześniejszy zapis zachowano.');
      await window.G13PvReadOnly.whenReady;
      prepared = X.prepare(picked.dataset.series, settings, window.G13PvReadOnly.getSnapshot(), gridDataset);
      diagnostics(prepared); return prepared;
    }
    if (!dataset) throw new Error('Najpierw pobierz osobną historię PV z HA. Nie używamy uproszczonego cache starej karty.');
    if (dataset.signature !== D.signature(settings)) throw new Error('Zakres lub encje różnią się od zapisanych danych PV. Pobierz aktualny zestaw.');
    await window.G13PvReadOnly.whenReady;
    prepared = D.prepare(dataset.series, settings, window.G13PvReadOnly.getSnapshot(), gridDataset);
    diagnostics(prepared);
    return prepared;
  }
  function renderResult(r) {
    if (r.kind === 'incremental_pv_export_valuation') { renderExportResult(r); return; }
    const box = $('pvResults'); box.replaceChildren(); box.hidden = false;
    box.append(el('h3', 'Wynik scenariusza · ' + settings.startDate + ' – ' + settings.endDate));
    box.append(el('p', $('pvCurrentInfo').textContent, 'pv-muted'));
    box.append(el('p', $('pvEfficiencyInfo').textContent + ' Użyte sprawności: ' + U.etaKeys.map(k => k + ' ' + (typeof settings[k] === 'number' && Number.isFinite(settings[k]) ? number(settings[k] * 100, 2) + '%' : 'nieustalone')).join('; ') + '.', 'pv-notice'));
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
  function exportMode() { return X.mode(settings) === 'export_only'; }
  function dataModule() { return exportMode() ? X : D; }
  function applyModeView() {
    const only = exportMode();
    root.dataset.calculationMode = only ? 'export_only' : 'dynamic_battery';
    const oldFields = new Set(['capacityKwh', 'minSocPct', 'maxSocPct', 'initialSocPct', 'chargeCurrentA',
      'dischargeCurrentA', 'batteryVoltageV', 'loadScale', ...U.etaKeys]);
    for (const [key] of fields) {
      const hide = only ? oldFields.has(key) : key === 'exportPvToAcEta';
      const input = $('pv-' + key); input.parentElement.hidden = hide;
      if (hide) input.disabled = true;
    }
    for (const [key] of entities) {
      const hide = only && !['pv', 'pvPower'].includes(key);
      const input = $('pv-entity-' + key); input.parentElement.hidden = hide;
      if (hide) input.disabled = true;
    }
    for (const id of ['pvLoadModeField', 'pvLoadHelp', 'pvCurrentInfo', 'pvWindow', 'pvEfficiencyControl',
      'pvEfficiencyHeading', 'pvEfficiencyHelp', 'pvEfficiencyParameters', 'pvDynamicAssumptions']) $(id).hidden = only;
    $('pv-loadMode').disabled = only || busy || !ready || blocked;
    $('pv-efficiencyMode').disabled = only || busy || !ready || blocked;
    $('pvExportAssumptions').hidden = !only;
    $('pvExportEtaInfo').hidden = !only;
    $('pvEfficiencyInfo').hidden = only;
    if (only) {
      $('pv-acceptScenario').disabled = busy || !ready || blocked;
      $('pv-unlimitedInverter').disabled = busy || !ready || blocked || settings.topology !== 'dc_shared';
      $('pv-unlimitedInverter').parentElement.hidden = settings.topology !== 'dc_shared';
      $('pv-inverterAcKw').parentElement.hidden = settings.topology !== 'dc_shared';
      $('pv-inverterAcKw').disabled = busy || !ready || blocked || settings.topology !== 'dc_shared' || settings.unlimitedInverter;
      $('pv-addedInverterAcKw').parentElement.hidden = settings.topology !== 'ac_added';
      $('pv-unlimitedAddedInverter').parentElement.hidden = settings.topology !== 'ac_added';
    } else {
      $('pv-unlimitedInverter').parentElement.hidden = false;
      $('pv-addedInverterAcKw').parentElement.hidden = false;
      $('pv-unlimitedAddedInverter').parentElement.hidden = false;
    }
    $('pvModeNotice').textContent = only
      ? 'Nie jest to zwalidowana rekonstrukcja pomiarów. Dodatkową produkcję z profilu PV DC wyceniamy TAK, JAKBY dostępny przyrost trafił do sieci. Bez modelowania domu, baterii i oszczędności G13. Istniejącej baterii nie odłączamy ani nie odtwarzamy jej historii. Saldo depozytu i pozostałe kalkulatory pozostają nietknięte.'
      : 'Nie jest to zwalidowana rekonstrukcja pomiarów. Porównujemy dwa modele: obecne PV i PV po rozbudowie — z dynamiczną obecną baterią, bez planowego ładowania z sieci. Dane historyczne i ich rozbieżności pokazujemy osobno. Nic nie trafia do salda depozytu, autokonsumpcji ani kalkulatora drugiego magazynu.';
    $('pvModeHint').textContent = only
      ? 'Prosty tryb: PV DC → dodatkowa produkcja → przyrost eksportu → RCE. Ujemne H/BMS/SOC nie są wejściem. Eksport eLicznika służy tylko jako punkt odniesienia i do kontroli wolnego miejsca w limicie; nie mnożymy go przez przyrost kWp.'
      : 'Zachowany dotychczasowy model. Wymaga zapotrzebowania domu i parametrów baterii; dawne blokady H nadal obowiązują. Przełączenie trybu nie naprawia ani nie zmienia historii.';
    $('pvModeMigration').textContent = modeMigrationNotice;
    $('pvEntityHelp').textContent = only
      ? 'Wymagany licznik PV DC w kWh z przyrostem change. Moc PV jest opcjonalną diagnostyką z jednostką HA. Nie pobieramy H, wyjścia AC, ładowania AC, BMS ani SOC. Już zapisany zgodny profil PV może zostać użyty bez ponownego pobrania; krótki zapis nie pokrywa dłuższego okresu.'
      : 'Liczniki: kWh i przyrost change. BMS/SOC/moc są diagnostyką, nie sterują symulacją. Encje BMS można odczytać z opcji dodatku; ich wpisanie tutaj nie zmienia tych opcji ani growatt_entities.';
    $('pvScenarioIntro').textContent = only
      ? 'Podaj dołożone kWp, wariant podłączenia, limity i jedną sprawność PV → AC. Parametry baterii są zachowane, ale nie są używane w tym trybie. Ustawienia nie sterują urządzeniami.'
      : 'Podaj dodatkowe PV, prądy baterii oraz ograniczenia instalacji. Nie musisz samodzielnie wpisywać sześciu sprawności. Ustawienia nie sterują urządzeniami.';
    $('pvAdvancedSummary').textContent = only ? 'Zaawansowane: profil, względny uzysk i wykorzystanie depozytu' : 'Zaawansowane: bateria, napięcie, własne sprawności i pozostałe założenia';
    $('pv-topology').querySelector('option[value="ac_added"]').textContent = only
      ? 'AC: osobny dodatkowy falownik PV, bez symulacji ładowania baterii'
      : 'AC: nowy falownik PV, istniejąca hybryda może przyjąć nadwyżkę AC';
    $('pvTopologyHelp').textContent = only
      ? 'DC: porównujemy konwersję samego PV przed/po rozbudowie przy wspólnym limicie. Nie znamy konkurencji z baterią. AC: limit nowego falownika. Żaden wariant nie potwierdza projektu MPPT, instalacji ani zgody na eksport.'
      : 'Wariant AC zakłada dostępność takiego sterowania ładowaniem; nie potwierdza możliwości WIT. Połączenia elektryczne/MPPT wymagają osobnego projektu.';
    $('pv-inverterAcKw').parentElement.querySelector('small').textContent = only
      ? 'Limit krzywej konwersji samego PV. Przyrost = min(PV po rozbudowie × η, limit) − min(obecne PV × η, limit). Nie jest pomiarem wolnego budżetu hybrydy z baterią.'
      : 'Wspólny budżet konwersji AC PV + bateria + ładowanie zwrotne w kroku.';
    $('pv-exportAcKw').parentElement.querySelector('small').textContent = only
      ? 'Wolne miejsce = max(0, limit × długość kroku − historyczny eksport). 0 blokuje przyrost, nie zeruje historii. To założenie, nie potwierdzenie limitu OSD.'
      : '0 oznacza blokadę eksportu. Nie jest to moc umowna importu.';
    $('pvGridExplanation').textContent = only
      ? 'Automatycznie używamy potwierdzonego EKSPORTU z danych dodatku albo zapisanego CSV PV. Cały rekord pochodzi z jednego źródła, bez sumowania źródeł i dopisywania flag. Import i taryfa G13 nie są potrzebne w tym trybie. CSV już zapisany w PV nie wymaga ponownego importu. To nie jest pobieranie danych z Taurona.'
      : 'Automatycznie używamy kompletnych danych zapisanych w dodatku; stare braki potwierdzenia uzupełnia wcześniej sprawdzony CSV PV. Cała godzina pochodzi z jednego źródła. Nie dopisujemy flag, nie sumujemy dwóch źródeł i nie zmieniamy rozliczeń. Nowe kompletne importy w głównej karcie nie wymagają ponownego wgrywania tutaj. To nie jest pobieranie danych z Taurona.';
    $('pvGridArchiveHelp').textContent = only
      ? 'Już zapisanych plików nie trzeba wgrywać ponownie. Jeśli wymieniasz archiwum CSV PV, wybierz razem wszystkie pliki, które chcesz zachować: nowy zestaw zastępuje poprzedni, nie łączy się z nim. W tym trybie wymagany jest potwierdzony eksport, a dla powtórzonej godziny oba rekordy eksportu i zgoda na krok 2 h. Import jest zachowany, ale nie służy tej wycenie. Inny format/status pomiaru jest odrzucany.'
      : 'CSV jest potrzebny tylko do uzupełnienia starych, niepotwierdzonych zapisów. Już zapisanych plików nie trzeba wgrywać ponownie przy otwarciu karty. Jeśli wymieniasz archiwum CSV PV, wybierz razem wszystkie pliki, które chcesz w nim zachować: nowy zestaw zastępuje poprzedni, nie łączy się z nim i nie zmienia źródłowych CSV. Brak kierunku pozostaje nieznany; powtórzona godzina wymaga obu rekordów każdego kierunku i osobnej zgody na krok 2 h. Inny format/status pomiaru jest odrzucany.';
    $('pvCalculationHeading').textContent = only ? '3 · Wyceń przyrost eksportu' : '3 · Oblicz różnicę dwóch modeli';
    $('pvCalculate').textContent = only ? 'Oblicz dodatkowe PV jako eksport' : 'Porównaj obecne PV i rozbudowę';
    $('pvAcceptanceText').textContent = only
      ? 'Akceptuję scenariusz: cały dostępny przyrost PV jest wyceniany jako eksport, bez domu/baterii. Rozumiem ograniczenia profilu, konwersji, eksportu i cen. Nie uznaję wyniku za gwarancję fizycznego eksportu ani wypłaty gotówki.'
      : 'Rozumiem warunkowy charakter zapotrzebowania/źródeł, strat i ograniczeń. Akceptuję wpisane założenia wyłącznie jako scenariusz, bez uznawania historii za fizycznie zwalidowaną.';
    $('pvExportEtaInfo').textContent = 'Jedyna użyta sprawność: PV DC → AC ' + number(typeof settings.exportPvToAcEta === 'number' && Number.isFinite(settings.exportPvToAcEta) ? settings.exportPvToAcEta * 100 : null, 6)
      + '%. To edytowalne założenie, NIE pomiar. Nie stosujemy strat baterii, A/V, SOC ani mnożnika zapotrzebowania domu. Ich dotychczasowe wartości są zachowane.';
  }
  function renderIssueList(box, issues) {
    const detail = el('details'); detail.append(el('summary', 'Pełna lista problemów i ostrzeżeń (' + issues.length + ')'));
    if (issues.length) {
      const list = el('ul', undefined, 'pv-issues');
      for (const i of issues) list.append(el('li', i.key + ' / ' + new Date(i.ts).toISOString() + ' · ' + i.channel + ' · ' + i.message
        + (i.value === null ? '' : ' Wartość: ' + (typeof i.value === 'number' ? number(i.value, 6) : JSON.stringify(i.value))), i.severity === 'error' ? 'pv-error' : ''));
      detail.append(list);
    } else detail.append(el('p', 'Brak flag nie oznacza fizycznej walidacji profilu ani przyszłego eksportu.'));
    box.append(detail);
  }
  function renderExportDiagnostics(p) {
    const box = $('pvDiagnostics'); box.replaceChildren(); const q = p.diagnostics;
    renderGridReport(q.grid);
    box.append(el('p', 'Tryb: dodatkowe PV wycenione jako eksport. Nie obliczamy H ani R i nie używamy AC charge, BMS, SOC, zużycia domu czy stawek G13. Ich pominięcie nie naprawia historycznych rozbieżności.', 'pv-notice'));
    box.append(el('p', 'PV DC: znane przyrosty ' + q.pvKnownHours + '/' + q.expectedHours + ' h. Oczekiwane godziny UTC: ' + q.expectedHours
      + ' · kroki modelu: ' + q.intervalCount + ' · kroki 2 h: ' + q.dstBlocks + '. Błędów blokujących: ' + q.errorCount + '.', q.errorCount ? 'pv-error' : 'pv-muted'));
    box.append(el('p', gridSummary('eLicznik · ' + gridLabel(q.grid.source), q.grid.selected)));
    box.append(el('p', 'Moc PV ze znaną jednostką: ' + q.pvPowerKnownHours + '/' + q.expectedHours + ' h; bez potwierdzonej jednostki: '
      + q.powerUnknownUnitHours + ' h; bez użytecznego odczytu: ' + q.powerMissingHours + ' h. To tylko diagnostyka: nigdy nie zastępujemy licznika kWh średnią mocą.', 'pv-muted'));
    box.append(el('p', 'Brak jednoznacznego RCE: ' + q.missingRcePriceBlocks + ' przedziałów. Dodatni przyrost bez ceny daje nieznaną pełną kwotę; zerowy przyrost nie wymaga ceny. Dane i ceny nie są uzupełniane w ciemno.', 'pv-muted'));
    box.append(table(['Historia / okres', 'PV DC — profil', 'Eksport eLicznika — punkt odniesienia'], Object.keys(p.historical).sort().map(mk => {
      const m = p.historical[mk]; return [mk + ' · ' + m.hours + ' h', kwh(m.values.pvDcKwh.totalKwh), kwh(m.values.gridExportKwh.totalKwh)];
    }), 'Eksport nie jest produkcją PV. Sumy niepełne pozostają nieznane; historia baterii/domu nie jest tu rekonstruowana.'));
    renderIssueList(box, p.issues);
  }
  function renderExportResult(r) {
    const box = $('pvResults'); box.replaceChildren(); box.hidden = false; const t = r.total;
    box.append(el('h3', 'Dodatkowe PV wycenione jako eksport · ' + settings.startDate + ' – ' + settings.endDate));
    box.append(el('p', 'Wyłącznie wybrany okres: ' + r.hours + ' h. Nowy profil = PV DC × ' + number(settings.addedKwp, 3) + ' / '
      + number(settings.existingKwp, 3) + ' kWp × ' + number(settings.addedYieldFactor, 3) + '. Sprawność PV → AC: '
      + number(settings.exportPvToAcEta * 100, 6) + '%. To założenia, nie kalibracja.', 'pv-muted'));
    box.append(el('p', 'CAŁY dostępny przyrost jest z założenia wyceniany jako eksport. Nie odejmujemy zużycia domu ani ładowania baterii i nie obiecujemy, że tyle rzeczywiście trafi do sieci. Nie liczymy oszczędności G13. Nie jest to wynik instalacji fizycznie pozbawionej baterii.', 'pv-notice'));
    const cards = el('div', undefined, 'pv-metrics');
    for (const [label, value, id] of [
      ['Warunkowa wartość wykorzystanego przyrostu', money(t.conditionalBenefitPln), 'pvBenefit'],
      ['Dodatkowy przypis depozytu', money(t.extraDeposit.totalPln), 'pvDepositDelta'],
      ['Scenariuszowy przyrost eksportu AC', kwh(t.extraExportKwh), 'pvExtraExport'],
      ['Dodatkowy profil PV DC', kwh(t.addedPvDcKwh), 'pvExtraEnergy'],
    ]) {
      const card = el('div', undefined, 'panel pv-metric'); card.append(el('span', label, 'pv-muted'));
      const n = el('strong', value, 'mono'); n.id = id; card.append(n); cards.append(card);
    }
    box.append(cards);
    box.append(el('p', 'Wartość warunkowa = ' + number(settings.depositUseFraction * 100, 0) + '% × dodatkowy przypis depozytu. Depozyt ≠ gotówka. Koszt rozbudowy: '
      + money(settings.costPln) + '. Bez rocznego przeliczenia i okresu zwrotu. Saldo depozytu nie zostało powiększone.', 'pv-notice'));
    const limit = (unlimited, value) => unlimited === true ? 'jawnie bez limitu' : number(value, 3) + ' kW AC';
    box.append(el('p', settings.topology === 'dc_shared'
      ? 'Wspólny DC: przyrost konwersji = min(PV po rozbudowie × η, limit) − min(obecne PV × η, limit). Limit: ' + limit(settings.unlimitedInverter, settings.inverterAcKw)
        + '. To krzywe samego PV; nie znamy konkurencji z baterią ani rzeczywistego wolnego budżetu hybrydy.'
      : 'Dodatkowy falownik AC: przyrost konwersji = min(nowy profil PV × η, limit dodatkowego falownika). Limit: ' + limit(settings.unlimitedAddedInverter, settings.addedInverterAcKw)
        + '. Bez modelowania ładowania baterii z AC.', 'pv-muted'));
    box.append(el('p', 'Limit eksportu: ' + limit(settings.unlimitedExport, settings.exportAcKw) + '. '
      + (settings.unlimitedExport ? 'Nie używamy historycznego eksportu jako ograniczenia. Brak jego pomiaru pozostaje nieznany.'
        : 'Wolne miejsce w kroku = max(0, limit × czas − potwierdzony eksport historyczny). Nie obcinamy historii ani nie przesuwamy energii między godzinami.'), 'pv-muted'));
    box.append(table(['Wielkość', 'Cały wybrany okres'], [
      ['Historyczny profil PV DC', kwh(t.referencePvDcKwh)],
      ['Dodatkowy profil PV DC', kwh(t.addedPvDcKwh)],
      ['Dodatkowe AC po ograniczeniu falownika, przed limitem eksportu', kwh(t.additionalAcAfterInverterKwh)],
      ['Scenariuszowy przyrost eksportu AC', kwh(t.extraExportKwh)],
      ['Niewykorzystany profil wskutek limitu falownika — ekwiwalent DC', kwh(t.inverterLimitedDcKwh)],
      ['Niewykorzystany profil wskutek limitu eksportu — ekwiwalent DC', kwh(t.exportLimitedDcKwh)],
      ['Modelowa strata konwersji wyeksportowanej energii', kwh(t.conversionLossKwh)],
      ['Historyczny eksport eLicznika — bez zmiany', kwh(t.historicalExport.totalKwh)],
      ['Historyczny eksport + scenariuszowy przyrost — NIE prognoza pomiaru', kwh(t.historicalPlusScenarioExportKwh)],
    ], 'Tylko nowy profil i jego wycena. Niewykorzystana energia/straty są wielkościami modelu, nie zmierzonym ograniczeniem instalacji.'));
    box.append(table(['Okres', 'Nowy profil DC', 'Przyrost eksportu AC', 'Dodatkowy przypis depozytu', 'Wartość warunkowa'], Object.keys(r.monthly).sort().map(mk => {
      const m = r.monthly[mk]; return [mk + ' · ' + m.hours + ' h', kwh(m.addedPvDcKwh), kwh(m.extraExportKwh), money(m.extraDeposit.totalPln), money(m.conditionalBenefitPln)];
    })));
    box.append(el('p', 'RCE to migawka przy obliczeniu. Zasady wyceny dotychczasowej karty PV: ujemne RCE → 0; mnożnik 1,23 od lutego 2025. Po zmianie cen przelicz ponownie. Maksymalna reszta rachunku energii: '
      + t.maxBalanceErrorKwh.toExponential(2) + ' kWh — kontrola arytmetyki, nie walidacja pomiarów ani ograniczeń chwilowych.', 'pv-muted'));
    if (t.extraDeposit.missingIntervals) box.append(el('p', 'Brak ceny przy dodatnim przyroście w ' + t.extraDeposit.missingIntervals + ' przedziałach, dla '
      + kwh(t.extraDeposit.affectedKwh) + '. Znana podsuma depozytu: ' + money(t.extraDeposit.knownPln) + ' — NIE pełny wynik.', 'pv-notice'));
    if (r.issues.length) {
      const detail = el('details'); detail.append(el('summary', 'Historyczny eksport ponad przyjętym limitem: ' + r.issues.length + ' przedziałów'));
      detail.append(table(['Godzina lokalna', 'Eksport historyczny', 'Przyjęty limit × czas'], r.issues.map(i => [i.key, kwh(i.historicalKwh), kwh(i.assumedLimitKwh)]),
        'W tych godzinach przyrost wynosi 0. Nie obcinano historii. Sprawdź znaczenie wpisanego limitu; nie jest potwierdzonym parametrem sprzętu.'));
      box.append(el('p', 'Uwaga: historyczny eksport przekracza wpisany limit w ' + r.issues.length + ' przedziałach. Założenie nie jest zgodne z całą historią.', 'pv-notice')); box.append(detail);
    }
    if (settings.unlimitedExport || (settings.topology === 'dc_shared' && settings.unlimitedInverter) || (settings.topology === 'ac_added' && settings.unlimitedAddedInverter))
      box.append(el('p', 'UWAGA: jawny wariant idealizowany bez co najmniej jednego limitu. Nie jest potwierdzonym wariantem sprzętowym.', 'pv-notice'));
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
      if (exportMode()) { X.validateConfig(settings); result = X.simulate(p.rows, settings); }
      else { U.validate(settings); M.validateConfig(settings); result = M.simulate(p.rows, settings); }
      renderResult(result);
      say(exportMode() ? 'Wyceniono dodatkową produkcję jako eksport. To scenariusz bez domu i baterii, nie gwarancja rzeczywistego oddania. Dotychczasowych rozliczeń ani ustawień HA nie zmieniono.'
        : 'Obliczono różnicę dwóch modeli. To wynik warunkowy; dotychczasowe rozliczenia i ustawienia HA nie zostały zmienione.');
    } catch (e) { say(e.message, true); }
  }
  async function fetchData() {
    if (busy || !ready || blocked) return;
    let sig, span, ids; const onlyExport = exportMode(), module = dataModule();
    try { sig = module.signature(settings); span = D.range(settings.startDate, settings.endDate); ids = module.entityIds(settings); }
    catch (e) { say(e.message, true); return; }
    busy = true; invalidate(); invalidateDiagnostics('Pobieranie nowego zestawu. Poprzednie dane pozostają zapisane do chwili poprawnego zakończenia.'); updateFields();
    try {
      const parts = [];
      for (let cursor = span.start; cursor < span.end;) {
        const mk = D.localKey(cursor).slice(0, 7), [y, m] = mk.split('-').map(Number);
        const nextMonth = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
        const end = Math.min(span.end, D.midnight(nextMonth));
        const qs = new URLSearchParams({ entities: ids.join(','), start: new Date(cursor - 3600000).toISOString(),
          end: new Date(end).toISOString(), types: 'change,sum,mean,min,max', power_entity: settings.entities.pvPower || '' });
        say('Pobieranie osobnej historii PV: ' + mk + ' (z 1 h bufora). Bez zapisu do dotychczasowych kart…');
        const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 65000);
        let text;
        try {
          const response = await fetch('api/pv/stats.csv?' + qs.toString(), { signal: controller.signal });
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
      if (onlyExport) {
        // Sprawdzamy wyłącznie wymagany profil PV PRZED commitem. Pusta
        // odpowiedź dla PV (np. HTTP 200 z samą mocą) nie może ukryć się
        // za fallbackiem do starego cache. To nie jest symulacja bez limitu:
        // chwilowy obiekt wyłącza tylko zależność od eLicznika przy walidacji
        // licznika. Nie zapisujemy ani nie zmieniamy założeń użytkownika.
        const profileCheck = X.prepare(series, Object.assign({}, settings,
          { gridSource: 'auto', unlimitedExport: true, allowDstAggregation: true }), {});
        if (profileCheck.diagnostics.pvKnownHours !== span.hours) throw new Error(
          'Nie aktywowano nowego profilu PV DC: poprawne przyrosty i bufor dla ' + profileCheck.diagnostics.pvKnownHours
          + '/' + span.hours + ' godzin. Poprzednie historie zachowano; braków/ujemnych przyrostów nie zastępujemy zerem.');
      }
      if (dataModule().signature(settings) !== sig || exportMode() !== onlyExport) throw new Error('Formularz zmienił się podczas pobierania; nie aktywowano innych danych.');
      const saved = onlyExport ? await store.saveExportDataset(series, sig) : await store.saveDataset(series, sig);
      const next = { series, signature: sig, fetchedAt: saved.fetchedAt };
      if (onlyExport) exportDataset = next; else dataset = next;
      showDataStatus();
      const p = await prepareData();
      say('Zapisano wyłącznie własną historię PV. ' + (p.ok ? onlyExport ? 'Możesz wycenić dodatkowe PV jako eksport po akceptacji. Stara pełna historia PV pozostała zachowana.' : 'Możesz porównać modele po uzupełnieniu założeń.' : 'Diagnostyka wskazuje problemy blokujące — patrz poniżej.')
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
      await store.reset(); dataset = null; exportDataset = null; prepared = null; gridDataset = null; pendingGrid = null; settings = defaults(); blocked = false; gridMigrationNotice = ''; modeMigrationNotice = '';
      $('pvGridFile').value = ''; $('pvGridPreview').textContent = 'Brak osobnego CSV PV.'; $('pvGridReport').textContent = 'Sprawdź zapis eLicznika przyciskiem tylko do odczytu.';
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
  $('pvForm').addEventListener('change', async e => {
    if (!ready || busy || blocked) return;
    const next = readForm(e.target.id);
    if (e.target.id === 'pv-calculationMode' || (X.mode(next) === 'export_only' && e.target.id !== 'pv-acceptScenario')) next.acceptScenario = false;
    if (U.etaKeys.some(k => e.target.id === 'pv-' + k)) next.efficiencyMode = 'custom';
    if (e.target.id === 'pv-efficiencyMode') {
      next.acceptScenario = false;
      if (next.efficiencyMode === 'custom' && settings.customEfficiencies) Object.assign(next, settings.customEfficiencies);
    }
    settings = U.effective(next);
    if (e.target.id === 'pv-calculationMode') modeMigrationNotice = '';
    if (e.target.id === 'pv-efficiencyMode' && settings.efficiencyMode === 'custom') $('pvAdvanced').open = true;
    invalidate(); invalidateDiagnostics('Zmieniły się ustawienia. Sprawdź dane ponownie dla aktualnego wyboru.'); fill(); showDataStatus(); setupAuto();
    resetArmed = false; $('pvReset').textContent = 'Wyczyść tylko kartę PV';
    showGridReport(); // świeża kopia źródeł, bez pobierania HA i bez zapisu legacy
    if (pendingGrid) $('pvGridPreview').textContent = 'CSV przygotowany, ale zakres formularza mógł się zmienić. Zapis dotyczy całego wybranego zestawu plików; kompletność zakresu sprawdzisz po zapisie.';
    try { await store.saveSettings(settings); $('pvSaveStatus').textContent = 'Ustawienia zapisane osobno (pv-sim-v1-settings).'; }
    catch (e) { $('pvSaveStatus').textContent = 'Błąd zapisu ustawień PV: ' + e.message + '. Bieżące pola są tylko w pamięci; nie pokazujemy ich jako zapisane.'; }
  });
  $('pvGridFile').addEventListener('change', previewGridFiles);
  $('pvGridImport').addEventListener('click', importGrid);
  $('pvGridCheck').addEventListener('click', showGridReport);
  $('pvFetch').addEventListener('click', fetchData);
  $('pvDiagnose').addEventListener('click', diagnose);
  $('pvCalculate').addEventListener('click', calculate);
  $('pvReset').addEventListener('click', reset);
  document.querySelector('[data-tab="pv"]').addEventListener('click', () => {
    if (result) { invalidate(); say('Ponownie otwarto kartę — przelicz na bieżącej migawce eLicznika i cen.'); }
    if (ready && !blocked) showGridReport();
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
      const cachedGrid = await store.loadGridDataset();
      if (cachedGrid) gridDataset = D.validateGridDataset(cachedGrid);
      const cached = await store.loadDataset();
      if (cached) dataset = { signature: cached.signature, fetchedAt: cached.fetchedAt, series: D.mergeSeries(cached.parts) };
      const cachedExport = await store.loadExportDataset();
      if (cachedExport) exportDataset = { signature: cachedExport.signature, fetchedAt: cachedExport.fetchedAt, series: D.mergeSeries(cachedExport.parts) };
    } catch (e) { blocked = true; say('Nie udało się odczytać własnego zapisu PV: ' + e.message + '. Nie nadpisano historii. Możesz jawnie wyczyścić wyłącznie kartę PV.', true); }
    finally {
      ready = true; fill(); showDataStatus(); setupAuto(); root.dataset.ready = 'true';
      if (!blocked) showGridReport();
      if (!root.hidden && settings.autoRefresh && !blocked) fetchData();
    }
  })();
})();
