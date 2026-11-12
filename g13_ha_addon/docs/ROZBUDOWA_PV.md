# Rozbudowa PV — kontrakt modelu scenariuszowego 0.3.6

**Stan: przygotowanie wydania 0.3.6 do kontrolowanego sprawdzenia na PC.** Obejmuje poprawkę jednostek i osobny CSV eLicznika oraz prostszy formularz z prądami baterii w A DC. Bez publikacji i aktualizacji HA. Źródła/paczka 0.3.5 oraz poprzednia kopia robocza pozostają zachowane. Model nadal nie jest kalibracją pomiarów ani doborem urządzeń.

## Co liczy karta

Porównuje dwa przebiegi **tego samego modelu i strategii**:

- A: obecne 9,54 kWp i obecna bateria;
- B: to samo + zadane dodatkowe kWp.

W obu wariantach: PV → dom → bateria → eksport/ograniczenie. Przy deficycie bateria rozładowuje się do modelowej rezerwy, a resztę pobiera dom z sieci. **Brak planowego ładowania z sieci, brak sprzedaży energii z baterii.** Historyczne przepływy BMS nie są dodawane do symulowanych ani odtwarzane jako harmonogram.

Wynik paneli = **B − A**, nie model B minus ręcznie sterowana historia. Uniknięty zakup jest prezentowany z przeciwnym znakiem: zakup A − zakup B.

### Znane ustawienia startowe

- Obecne PV: 18 × 530 W = **9,54 kWp**; niezmieniane przez formularz.
- Bateria nominalna: **14,336 kWh**, liniowy przelicznik SOC → energia (założenie).
- Modelowe SOC: **10–100%**, czyli **12,9024 kWh** okna przed stratami.
- Kandydat startu: **10%**, czyli 1,4336 kWh zapisanej energii i 0 ponad rezerwą. Ten sam w obu modelach. Statystyka godzinowa SOC nie jest dokładnym stanem granicznym.
- Fizyczny próg rozładowania 30% pozostaje nietknięty. Korzyści z jego zmiany nie przypisujemy rozbudowie.

Dodatkowe kWp, prądy baterii, limity oraz podłączenie pozostają do jawnego wyboru. Nie nadano im domyślnych wartości sprzętowych ani ukrytego braku ograniczeń. Nie ma presetów prądu opartych na niezatwierdzonych 2/4/6 kW.

### Prosty formularz: prądy i gotowe założenia strat

- Ładowanie i rozładowanie wpisuje się osobno w **A DC na zaciskach baterii**, nie w A po stronie AC. 0 blokuje kierunek; puste pole pozostaje nieznane.
- Silnik nadal liczy w kW: `P = I × Uodniesienia / 1000`. Domyślne **51,2 V = 16 × 3,2 V** jest jawnym założeniem nominalnym, nie bieżącym/historicznym pomiarem. Przy 100 A daje 5,12 kW. Napięcie można zmienić w „Zaawansowanych”; przy stałych A zmienia to modelową moc.
- To stały limit mocy w kroku godzinowym. Rzeczywiste napięcie zależy m.in. od SOC i obciążenia; model nie gwarantuje utrzymania podanego prądu przez fizyczną baterię. Nie wysyłamy ustawień do urządzeń.
- Domyślny profil `estimate-v1` to **orientacyjne założenia, nie pomiar**: PV DC → AC 95%, PV DC → zaciski baterii 98%, zaciski DC → AC 95%, nadwyżka AC → zaciski DC 95%, zapis i oddanie energii wewnątrz baterii po 98%. Wszystkie wartości są widoczne w rozwijanych ustawieniach oraz w wyniku.
- Iloczyn dla cyklu AC → bateria → AC wynosi około **86,7%**. To informacja wynikająca z czterech współczynników, NIE dodatkowy mnożnik strat. Nie jest skalibrowany z historii użytkownika ani deklarowany jako dolna/górna granica wyniku.
- Zaawansowane sprawności można wprowadzić ręcznie. Wcześniej wpisany pełny lub częściowy zestaw pozostaje własnym zestawem; braków nie uzupełniamy po cichu. Własny zestaw jest zachowany również przy przełączeniu na profil orientacyjny i z powrotem.
- Dawne kW przeliczamy na wyświetlane A przy napięciu odniesienia bez zmiany limitu mocy modelu (z dokładnością arytmetyki zmiennoprzecinkowej). Nie zaokrąglamy A przed obliczeniem. Nowe zapisane A są nadrzędne wobec pochodnych kW.
- Gdy stary zestaw sprawności jest całkowicie pusty, pojawiają się jawne założenia orientacyjne i wymagana jest ponowna akceptacja scenariusza. Samo wczytanie ustawień nie zapisuje migracji; nie dotyka też danych innych kart.
- Limity falownika i eksportu pozostają w **kW AC**; nie są przeliczane z prądów baterii. Nieznany limit wymaga ustalenia albo jawnego wyboru istniejącej opcji idealizacji bez limitu. Nie włączamy jej automatycznie.


## Izolacja

| Plik | Odpowiedzialność |
|---|---|
| `app/public/pv-form.js` | Czyste przeliczenie A/V na kW, jawny profil strat i zachowanie wcześniejszych ustawień. Bez sieci i KV. |
| `app/public/pv-model.js` | Czysta funkcja symulacji; bez DOM, KV, sieci i legacy state. UMD: przeglądarka/Node używają tego samego pliku. |
| `app/public/pv-data.js` | Parser własnych statystyk, UTC/Warsaw, kompletność, warunkowe H i diagnostyka. Nie używa starego parsera HA ani jego progów. |
| `app/public/pv-store.js` | Własna przestrzeń `pv-sim-v1-`; zapis części + aktywnego manifestu. |
| `app/public/pv-tab.js` / `.css` | Formularz, pobieranie, dwa modele, wyniki/ostrzeżenia i reset tylko PV. |
| `app/public/index.html` | Dodany przycisk, pusty panel, skrypty/arkusz i bridge tylko do odczytu. Istniejące wzory pozostają niezmienione. |
| `app/lib/pv-ha.js` | Osobny odczyt metadanych/statystyk recorder z jawną normalizacją mocy; bez zapisów do HA. |
| `app/server.js` | Dodatkowy endpoint `api/pv/stats.csv`; istniejące endpointy i ich jednostki pozostają bez zmian. |

`window.G13PvReadOnly.getSnapshot()` zwraca **kopię JSON, rekurencyjnie zamrożoną**, zawierającą tylko eLicznik, RCE i stawki G13. Nie ujawnia `state.months`, wyników baterii, kosztów ani setterów. `whenReady` czeka na zakończenie istniejącego wczytywania stanu.

Karta nie wywołuje `saveState`, `renderMagazyn`, `recomputeMonths` ani funkcji rozliczeń. Nie zapisuje kluczy `monthly-ledger`, `rce-cache`, `elicznik-hourly-*` lub `ha-hourly-*`. BMS odczytuje osobno do diagnostyki, na podstawie encji z formularza; opcje dodatku może jedynie odczytać przez `api/config`.

### Zapisy własne

- `pv-sim-v1-settings` — ustawienia;
- `pv-sim-v1-data-<generacja>-<część>` — części historii, maksymalnie 4000 wierszy w części, dodatkowa kontrola rozmiaru opakowanego JSON;
- `pv-sim-v1-active` — manifest aktywnej, ukończonej generacji HA;
- `pv-sim-v1-grid-<generacja>-<część>` oraz `pv-sim-v1-grid-active` — osobny, sprawdzony zestaw CSV eLicznika, z własnym manifestem i nazwami plików źródłowych. Nie trafia do `elicznik-hourly-*`.

Manifest aktywuje się dopiero po zapisaniu wszystkich części. Utrata odpowiedzi po zapisie manifestu jest sprawdzana odczytem; nie kasujemy shardów, które mogły stać się aktywne. Uszkodzone/nieznane formaty nie są automatycznie zerowane. Zapisy z jednej karty są kolejkowane. Reset wymaga dwóch kliknięć i filtruje klucze własnej przestrzeni, również gdy `list()` zwróci obce wpisy. Zalecane jedno okno edycji karty: nie ma serwerowego CAS/wieloużytkownikowego scalania ustawień.

Nie zapisujemy wyników symulacji do księgi. Po zmianie pól wynik jest unieważniany. Ponowne otwarcie karty wymaga przeliczenia na aktualnych wspólnych danych. Przywrócone własne dane można przeliczyć bez ponownego pobierania.

## Wejścia i błędy

Pobieranie odbywa się przez **względny** `api/pv/stats.csv`, oddzielnie dla kolejnych miesięcy i własnej listy encji, z `change,sum,mean,min,max`. Zapytanie ma jawny godzinowy UTC i godzinę bufora przed początkiem. Nowy endpoint dopuszcza 1–40 różnych encji i najwyżej 62 dni na część. Nie zmienia `growatt_entities`, starego `api/ha/stats.csv`, `api/growatt/ha-stats.csv` ani automatyzacji urządzenia.

Dla wybranej encji mocy odczytuje `recorder/get_statistics_metadata`, a następnie `recorder/statistics_during_period` z `units: {energy: "kWh", power: "kW"}`. Tylko znane W/kW o niesprzecznej klasie jednostki pozwala opisać moc jako kW w dodatkowej kolumnie `power_unit`. Brak/nieobsługiwane metadane pozostawiają jednostkę nieznaną; błąd zapytania o statystyki daje błąd pobrania, nie fallback do danych o zgadywanej jednostce.

Starszy cache/CSV bez `powerUnit` zachowuje energię i resztę R, ale nie służy porównaniu licznika z mocą. Widać ostrzeżenie i liczbę godzin bez jednostki; ponowne pobranie własnej historii PV może uzupełnić jawny kontrakt. Nie skalujemy liczników kWh ani nie rozpoznajemy W/kW po wielkości liczby. Zapisana jawna jednostka W jest przeliczana na kW tylko na potrzeby kontroli mocy; kW nie dzielimy drugi raz. Jednostka fizyczna/miejsce pomiaru nadal nie jest kalibracją sprzętu.

Przycisk pobiera dane bez eksportowania/wgrywania plików. Opcjonalne automatyczne odświeżanie wymaga włączenia; działa przy wejściu i co 60 minut w otwartej karcie. Dotychczasowa synchronizacja Growatt/BMS działa jak wcześniej.

Domyślne kanały:

- PV DC: `sensor.growatt_solar_pv_energy_total`;
- wyjście AC: `sensor.growatt_solar_energy_total` (nie nazywamy go samymi panelami);
- ładowanie AC: `sensor.growatt_battery_ac_charge_energy_total`;
- SOC: `sensor.growatt_battery_battery_soc`;
- moc PV (tylko kontrola, jednostka potwierdzana metadanymi recorder): `sensor.growatt_solar_solar_total_power`;
- BMS: własne liczniki kWh wybrane w formularzu; przy pierwszym wejściu, jeśli dostępne, podpowiedź z opcji dodatku;
- opcjonalny dom: oddzielny zadeklarowany licznik AC **bez** ładowania baterii. Sama nazwa encji nie potwierdza niezależności/granicy pomiaru.

Wymagane godzinowe energie pochodzą z `change`, nie z mean licznika ani zastępczej całki z mocy. Kontrolujemy zgodność `change` z Δ`sum`, jeśli obie sumy są dostępne. Duplikat UTC, konflikt między częściami, brak przyrostu, ujemny przyrost, luka lub pierwszy punkt bez bufora nie są naprawiane. Brak wejść blokuje **cały wybrany przebieg** — bez wycinania godzin i resetowania/przenoszenia SOC przez lukę. Można jawnie wybrać krótszy spójny okres, z własnym stanem początkowym.

Dwa tryby zapotrzebowania:

1. **Warunkowe** `H = wyjście AC + import eLicznik − eksport eLicznik − ładowanie AC`.
2. **Zadeklarowany licznik domu AC** — bez dodatkowego odejmowania baterii.

Obie metody mają jawne ograniczenia źródła/granic. W szczególności 1 nie jest niezależnym pomiarem. Ładowanie AC nie jest automatycznie fakturowanym zakupem baterii. Nie używamy `min(AC, import)`, nie odejmujemy AC od BMS DC. Ujemne H pozostaje w diagnozie, blokuje model i nie jest obcinane do zera.

`R = PV DC + BMS rozładowanie DC + ładowanie AC − BMS ładowanie DC − wyjście AC` jest **warunkową resztą historyczną**, a nie obliczoną sprawnością. Pokazujemy wszystkie rozbieżności, liczbę ujemnych godzin, liczbę poniżej −0,2 kWh (tolerancja 1e−7) i pokrycie. Ujemne R nie są dopasowywane, zerowane, przenoszone do sąsiednich godzin lub pomijane. Przy brakującym BMS reszta pełnego okresu jest nieznana.

SOC mean/min/max służą wyłącznie ostrzeżeniom. Nie nadpisują energii modelu. Moc PV służy kontroli rozbieżności/zastojów, nie podmienia licznika.

### Czas, DST, eLicznik

- Wewnątrz używamy chronologicznych godzin UTC. Daty formularza obejmują całe lokalne dni, oba włącznie.
- Dzień wiosenny ma 23 godziny, jesienny 25; nie wstawiamy sztucznej godziny wiosną.
- Legacy cache eLicznika i RCE ma lokalne klucze bez rozróżnienia dwóch jesiennych 02:00. Nie wymyślamy przypisania jego wierszy do foldów.
- Wyjątkowo używamy **jednego kroku 2 h** z sumą obu godzin HA i zapisanym lokalnym agregatem eLicznika, wyłącznie po zaznaczeniu akceptacji przybliżenia. Moce i przepływy wewnątrz kroku są uśrednione. Cache nie zachowuje liczby źródłowych wierszy eLicznika, więc nie dowodzi kompletności obu foldów.
- RCE wspólnego kroku jest **nieznane**, nawet jeśli w starym cache istnieje jedna cena. Nie stosujemy jej do dwóch nierozróżnionych przepływów. G13 korzysta z zapisanej strefy.
- Wymagamy nieujemnych obu kierunków eLicznika z jawnymi `hasImport/hasExport`. Starszy cache bez flag nie daje dowodu kompletności. Oryginalne pliki można potwierdzić w NOWYM, osobnym importerze wewnątrz PV. Nie używamy do tej naprawy importera Depozytu/Magazynu; nie dopisujemy flag do starych rekordów.

### Obsługa bez konsoli — osobny eLicznik

1. Rozwiń „eLicznik dla PV — diagnostyka i osobny CSV”. „Sprawdź zapis eLicznika — tylko odczyt” pokazuje liczbę rekordów, braków flag i nieprawidłowych liczb dla dat formularza. Nie potrzebuje pobranej historii HA, nie zapisuje niczego i nie uruchamia modelu. Liczniki powodów mogą się pokrywać. Liczbę wyjątków AC/zerowy import odnosimy wyłącznie do kompletnych przedziałów sieciowych.
2. Wybierz razem oryginalne CSV nowego zestawu (maks. 48 plików / 16 MB). Wspierany format jest jawny: średnik, `Data;Strefa;Wartość;Rodzaj;Status`, data ISO i etykieta KOŃCA godziny 1–24, pobrana/oddana **po zbilansowaniu [kWh]**, status `licznik`. Puste, ujemne i nieprawidłowe liczby, duplikaty, sprzeczne strefy, inne jednostki/formaty/statusy są odrzucane. Nie ignorujemy podejrzanych wierszy.
3. Sam wybór plików to podgląd, bez zapisu. Nieistniejąca godzina wiosenna jest błędem pliku; brakującej godziny nie tworzymy. Dwa jesienne rekordy każdego kierunku są sumowane do jawnego przedziału 2 h, bez przypisania do foldów. Pojedynczy rekord nie potwierdza pełnych 2 h. Zgoda DST pozostaje wymagana w modelu; RCE wspólnego przedziału nieznane.
4. „Zapisz i użyj CSV tylko w PV” zapisuje własny zestaw części + manifest i wybiera go jako źródło PV. **Zastępuje cały poprzedni osobny zestaw**, nie sumuje go i nie scala braków ze starą kartą. Ponowny import tych samych plików nie dubluje energii. Niepełny zestaw można zachować z jawnymi brakami, ale braków nie uznajemy za zera i nie uruchamiamy na nich warunkowego H.
5. G13/RCE nadal pochodzą z zamrożonej kopii wspólnych cen. Brak strefy lub ceny daje nieznaną wycenę. Różnice skończonych liczb energii lub niepustych stref pomiędzy CSV i dotychczasowym zapisem są ujawniane oraz blokują model do wyjaśnienia. Nie uzgadniamy ich przez nadpisanie żadnej historii.
6. Można jawnie przełączyć źródło z powrotem na dotychczasowe dane (tylko odczyt). Osobny CSV zostaje zachowany, ale nie jest wtedy używany. Wybrany zakres może pozostać zablokowany przez brak starych flag.
7. Nowe części zapisują się przed manifestem; awaria nie aktywuje połowy zestawu. Zapis CSV i wybór źródła są dwoma operacjami KV: gdy zapis wyboru nie powiedzie się po commicie CSV, interfejs ostrzega, aby po ponownym otwarciu sprawdzić źródło. Nie udaje atomowości dwóch kluczy. Dwuklik resetu usuwa tylko obie historie i ustawienia PV, nie wspólne dane.

## Model energii i granice sprawności

Niech `E` oznacza zapisaną energię baterii, a `C` nominalną pojemność:

- `Emin = C × SOCmin / 100`, `Emax = C × SOCmax / 100`;
- `E0 = C × SOCinitial / 100`, ten sam dla A/B;
- `Enew = Eold + charge_terminal_DC × ηstore_charge − discharge_terminal_DC / ηstore_discharge`.

Moce `chargeDcKw`/`dischargeDcKw` ograniczają energię **na zaciskach DC** przez `P × długość_kroku`. Nie ograniczają bezpośrednio AC lub zmiany E. Start poza wybranym oknem jest w tej wersji **odrzucany**, nie podnoszony do rezerwy za darmo. Nie ma modelu samorozładowania, starzenia, temperatury, poboru własnego ani gwarancji technicznej pojemności.

Osobno zadawane sprawności (0–100%, zero niedopuszczalne):

1. PV DC → AC;
2. PV DC → zaciski baterii;
3. zaciski baterii DC → AC;
4. nadwyżka AC → zaciski baterii (tylko wariant AC);
5. zaciski DC → zapis energii;
6. zapis energii → zaciski DC.

### DC — wspólna hybryda

Sumujemy profil obecnych i dodanych paneli DC. Najpierw dom przez limit falownika, potem ładowanie nadwyżką DC, potem eksport przez pozostałą moc falownika i limit eksportu. Rozładowanie baterii do domu dzieli limit falownika z PV. Nadwyżka DC może ładować przy imporcie zasilającym deficyt domu spowodowany ograniczeniem mocy AC; nie oznacza to ładowania z sieci.

### AC — dodatkowy falownik PV

Nowy falownik ma własną konwersję i limit. Najpierw zasila dom nową energią AC, potem dom zasila obecne PV. Nadwyżka obecnego PV DC ma pierwszeństwo ładowania, następnie nadwyżka nowego AC może ładować przez istniejącą hybrydę. Suma energii konwertowanej w przód/zwrotnie dzieli jej budżet `kW × czas`. Eksport całego układu ma jeden wspólny limit.

To jawny model możliwego układu, **nie potwierdzenie, że konkretna konfiguracja WIT pozwala realizować takie sterowanie**. Nie modelujemy tras prądowych, MPPT, napięć, asymetrii faz, ramp, mocy biernej lub ograniczeń importu. Deficyt domu może być pokryty siecią. Potrzebny oddzielny projekt elektryczny.

W każdym kroku i całym okresie sprawdzamy:

`PV_DC + import_AC + Eprzed = dom_AC + eksport_AC + Epo + ograniczenie_DC + straty`.

To kontrola arytmetyki przyjętego modelu, **nie fizyczna walidacja liczników**. Nie dodajemy jednocześnie zmierzonego i modelowanego rozładowania.

### Profil nowych paneli / ograniczenia

`PVnowe_DC = PVobecne_DC × dodatkowe_kWp / 9,54 × względny_uzysk`.

Względny uzysk 1 jest jawną hipotezą tego samego profilu na kWp, nie potwierdzeniem nowej geometrii/cienia. Profil historyczny już może zawierać ograniczenia produkcji. Nie odzyskujemy niewidocznego potencjału PV ani nie twierdzimy, że wynik jest gwarantowaną dolną/górną granicą. Krok godzinowy nie rozstrzyga chwilowego clippingu.

Puste limity są nieznane i blokują obliczenie; wpisane 0 A baterii / 0 kW eksportu oznacza zakaz. Tylko osobny checkbox pozwala jawnie wybrać idealizowany brak limitu falownika/eksportu. Taki wynik ma dodatkowe ostrzeżenie.

## Ekonomia

- **Uniknięty zakup**: suma `(import_A − import_B) × stawka_G13_danej_godziny`. Bez fallbacku do ceny ręcznej, faktury lub 0,63.
- **Zmiana depozytu**: suma `(eksport_B − eksport_A) × max(0,RCE)/1000 × mnożnik`. Mnożnik 1,23 od lutego 2025; wcześniej 1.
- **Korzyść warunkowa**: uniknięty zakup + zadany ułamek wykorzystania × zmiana depozytu.
- Założenie wykorzystania dotyczy wartości przyrostu; nie stanowi prognozy rozliczenia dwóch kompletnych ksiąg z wygasaniem istniejących transz.
- Koszt rozbudowy to osobne opcjonalne pole. Brak sezonowej annualizacji, zwrotu w latach i kredytu za końcowy SOC. Końcowa różnica energii pokazana oddzielnie.
- Brak ceny przy niezerowej różnicy daje **nieznane**, ze znaną podsumą i pokryciem osobno. Gdy różnica energii wynosi 0, jej wartość wynosi 0 niezależnie od nieznanej ceny; absolutne przepływy mogą jednocześnie mieć nieznaną wycenę.

## Testy i uruchomienie

W `app/`: najpierw `npm ci`, a następnie `npm test`. Nowe testy dołączone są do istniejącego runnera. Nie wymagają dodatkowych zależności. Testy syntetyczne nie wymagają CSV użytkownika. Historyczne zestawy używają istniejącego mechanizmu `G13_TEST_CSV`; brak pliku jest jawnie oznaczany jako pominięcie, nie sukces.

- 303 dotychczasowe testy + istniejący przebieg walidatora na realnym eksporcie;
- 41 nowych testów modelu (w tym 400 losowych par 48-godzinnych przebiegów i kontrole zera);
- 39 danych/czasu/zapisu;
- 31 nowych testów CSV, flag, jednostek i osobnych zapisów;
- 13 nowych testów prawdziwej ścieżki Express → klient WebSocket → lokalny emulator protokołu recorder (bez podmiany funkcji pobierającej);
- 45 DOM, obejmujących bajtową zgodność starych kluczy i treści tabel po podglądzie, imporcie, przełączeniu źródła, restartach, błędach i resecie PV;
- 13 HTTP/zasobów/KV;
- 20 testów przeliczenia A/V, wariantu strat, zachowania własnych ustawień i bilansu;
- łącznie 505 nazwanych testów plus istniejący przebieg walidatora na realnym eksporcie. Osobny audyt 0.3.6 wykrył 22/22 celowo wprowadzonych błędów w kopiach tymczasowych: 10 dotyczących jednostek/CSV/zapisów oraz 12 dotyczących A/V, przywracania parametrów i sprawności. Historyczne 16/16 mutacji dotyczyło akceptacji 0.3.5, nie pokrycia tych zmian.

Wektorów mocy/sprawności i encji `sensor.test_*` z testów **nie wolno uznać za ustawienia urządzenia**. Testy potwierdzają działanie kodu, nie kalibrację hardware'u.

## Historia wydania 0.3.5 — nie instrukcja wdrażania tej kopii roboczej

Poniższe kroki opisują poprzednie wydanie. Zostało już zastosowane na PC, opublikowane i scalone przez PR #15. Nie należy go ponownie instalować ani używać jego buildera do tej zmienionej kopii. 0.3.6 ma osobny builder/manifest/instalator. Wykonanie na PC, publikacja i wdrożenie pozostają oddzielnymi etapami.


Potwierdzono bazę na komputerze: czysta `fix/g13-034`, oba numery 0.3.4,
commit `e5eeb9dacd38402eaaf338b0982dc3e4f19979dc`. Pobrane z tego commita
20 plików dodatku zgadza się bajtowo z bazą używaną w audycie. To NIE potwierdza
wersji aktualnie uruchomionej w HA.

0.3.5 ma osobny builder i manifest całego payloadu (31 plików). Nowe numery
w `config.yaml`, `package.json` oraz obu metadanych `package-lock.json` są spójne:
0.3.5. Poprawiono tylko metadane wersji locka; graf zależności nie zmienił się.
Starego `build_034.py` nie używamy do tej funkcji.

Instalator sprawdza bazę, payload, brak lokalnych zmian/kolizji nowych plików,
tożsamość Git i brak zajętej gałęzi docelowej. `-DryRun` niczego nie kopiuje ani
nie tworzy. Pełny tryb tworzy wyłącznie lokalną `fix/g13-035`, kopiuje jawne
pliki i tworzy lokalny commit; nie wykonuje fetch/push, PR, scalania ani zmian HA.
Po błędzie nie wykonujemy reset/force ani automatycznego ponawiania.

Na komputerze: jeden krok/komenda naraz. Najpierw DryRun, potem lokalne
zastosowanie, testy i dopiero osobno uzgodnione wysłanie/scalenie/przebudowa HA.
Nie uruchamiamy skryptów wydania w terminalu dodatku HA.

Prywatne eksporty oraz szczegółowe wyniki audytu nie należą do repozytorium
ani payloadu. Istniejące obliczenia pozostają niezależne. Parametry sprzętowe
PV, moce i sprawności nadal wymagają wyboru jako założenia; numer 0.3.5 nie
zamienia modelu scenariuszowego w fizycznie zwalidowaną prognozę.
