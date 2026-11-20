# AMIplus — wspólny przycisk eLicznika i Rozbudowy PV (0.4.4)

## Co robi przycisk

W **Depozyt → 1 · Dane z eLicznika** jest „Pobierz dane z AMIplus”, obok dotychczasowego importu CSV/XLSX. Działa **wyłącznie po kliknięciu**: nie ma harmonogramu, pobierania przy otwarciu strony ani automatycznego logowania do Taurona. Czyta statystyki już zapisane przez istniejącą integrację AMIplus w Home Assistant. Nie wymusza jej odświeżania, nie wywołuje usług zapisu/naprawy recorder i nie steruje urządzeniami.

- Koniec zakresu: **wczoraj (D−1), według Europe/Warsaw**, ustalany ponownie przy każdym pobraniu.
- D−1 jest celem, nie obietnicą. Integracja lub operator mogą mieć większe opóźnienie. UI pokazuje ostatnią dostępną godzinę, ostatnią pełną dobę w odczycie i liczbę braków.
- Domyślny początek: ostatnia zapisana data minus 6 dni, aby porównać 7 dni i uzupełnić kolejne. Przy pustej historii: ostatnie 31 dni. Pole „Od” można zmienić; maksymalnie 366 dni naraz, odczyt w częściach do 31 dni.
- Przycisk nie pobiera cen RCE. Po dodaniu godzin użyj istniejącego „Pobierz brakujące ceny z API PSE”. Brak cen jest nadal jawny, bez stałej ceny zastępczej.

## Pierwsze użycie — zwykły interfejs

1. Kliknij przycisk. Pierwszy odczyt wykrywa liczniki i nie importuje jeszcze energii.
2. Lokalnie wybierz swój licznik, sprawdź datę „Od” i zaznacz, że odpowiada on używanym danym eLicznika. Numer/PPE nie musi być przekazywany w rozmowie ani wpisywany do kodu. Opis licznika jest widoczny tylko w Twoim interfejsie.
3. Kliknij ponownie. Nowe poprawne godziny zostaną zapisane. Kolejne użycia tego samego licznika wymagają jedynie kliknięcia przycisku. Potwierdzenie i wybór utrwalane są przy pierwszym skutecznym zapisie nowych godzin.
4. Sprawdź komunikat: dodane, zgodne, konfliktowe, pominięte godziny. Nie trzeba wklejać logów, otwierać konsoli ani wykonywać testów na PC.

Podczas operacji pozostałe kontrolki są chwilowo zablokowane, aby równoległy import nie nadpisał danych. „Anuluj pobieranie” przywraca je bez zapisu. Podczas krótkiego końcowego zapisu anulowanie jest wyłączone. Przy utracie odpowiedzi po rozpoczęciu zapisu odśwież widok przed następną próbą — zapis mógł już się zakończyć; powtórzenie nie doliczy energii ponownie.

## Źródła i znaczenie danych

Wykrywanie obsługuje źródło `tauron_importer` i nazwy kanałów używane przez integrację PiotrMachowski/Tauron AMIplus. Nie wykorzystuje sumarycznych sensorów Daily/Monthly/Yearly. Nie zakłada, że czas odświeżenia sensora jest godziną zużycia.

- `balanced_consumption` → pobór po bilansowaniu.
- `balanced_generation` → oddanie po bilansowaniu; **tylko ono zasila dotychczasowy wzór przypisu**, z zachowanym sposobem wyceny RCE.
- `consumption` / `generation` i strefowe kanały są odczytywane, jeśli dostępne, jako pomoc przy ustalaniu strefy. Eksport do sieci nie staje się produkcją PV DC.
- W tym importerze `state` to energia godziny, a `sum` to suma narastająca. Wymagane są jawne metadane energii Wh/kWh, `has_sum`, `source`. Żądanie HA normalizuje energię do kWh; nie przelicza się jej drugi raz. `state` jest kontrolowane względem sąsiedniej różnicy `sum`. Brak poprzedniego punktu, ujemna/nieprawidłowa wartość lub niezgodność powoduje pominięcie godziny, nie jej naprawę.
- Strefy T1/T2/T3 rozpoznawane są po opisach „Szczyt przedpołudniowy”, „Szczyt popołudniowy”, „Reszta dnia”, a nie odgadywane z numeru kanału. Sumy stref nie są dodawane do sumy łącznej. Jeśli nie da się ustalić strefy, pozostaje ona nieznana; nie dopisuje się taryfy według domyślnego harmonogramu.
- Przy wykrytej sprzeczności stref godzina jest pomijana. W pełni zerowej godzinie, kiedy wszystkie kanały strefowe są zerowe, nie zawsze da się ustalić strefę — nie wpływa to na energię tej zerowej godziny.

To kontrakt wspieranego importera, nie dowód wersji lub kompletności instalacji użytkownika. Inne wersje/forki z inną strukturą, opisami stref lub semantyką rekordów mogą wymagać osobnego dostosowania. Wtedy pozostaje import CSV/XLSX, bez zgadywania jednostek czy kanałów.

## Braki, DST, konflikty i bezpieczeństwo zapisu

- Nowe godziny są **dodawane**, nie sumowane z wcześniej zapisanymi. Identyczny powtórny import jest operacją bez zmian.
- Każda istniejąca godzina pozostaje bez zmian, także jeśli jest niepełna. Różnica energii/strefy lub niepotwierdzony kierunek jest zgłaszany jako konflikt/niepełny istniejący wpis. Inne nowe godziny mogą zostać dodane. Nie rozstrzygamy, że AMI jest bardziej wiarygodne od CSV.
- Wybrane źródło licznika jest wiązane z pierwszym skutecznym importem AMI. Nie łączymy automatycznie kolejnych liczników. Brak wcześniejszego licznika w HA nie powoduje wyboru zastępczego. Weryfikacja, że pierwszy wybór odpowiada dotychczasowemu CSV, należy do użytkownika w lokalnym UI.
- Braki są pomijane i raportowane, nigdy uzupełniane zerami. Poprawny pusty odcinek nie blokuje kolejnego z danymi. Błąd HTTP/protokołu/jednostek w dowolnej części zatrzymuje całą operację **przed** zapisem.
- Doba wiosennej zmiany czasu ma 23 godziny. Powtórzona lokalna godzina jesienna jest celowo pomijana (2 godziny UTC) — starszy importer może nie rozróżniać obu foldów. Istniejący poprawny CSV dla tej godziny pozostaje. Nie przypisujemy jednej wartości do dwóch godzin ani nie dzielimy jej arbitralnie.
- Miesięczne pliki godzin, odpowiednie pochodne pola rejestru i wybór licznika zapisywane są atomowo w jednym magazynie. Porównanie rewizji odmawia zapisu, jeśli w czasie odczytu inna karta lub proces zmienił dane. Uszkodzony JSON nie jest resetowany przez ścieżkę AMI (zwraca 503). Zwykłe otwarcie strony przez `loadState()` nadal zachowuje kopię `kv-store.json.corrupt-<ts>` (uprawnienia `0o600`) przed wyzerowaniem żywego pliku i raportuje degradację w `/api/health`.
- Koszty energii/dystrybucji, parametry inwestycji, ceny, pozostałe miesiące i magazyny PV są zachowane. Pochodne pola miesięcy z nowymi godzinami są przeliczane według dotychczasowych wzorów i już zapisanych cen. Jeśli dla takiego miesiąca nie ma ani jednej ceny, wcześniejszy przypis/kWh z rejestru nie są zerowane; raportowane są brakujące ceny.
- Jeśli zapis się nie uda lub nie zostanie potwierdzony, nie kasuj danych. Ręczny importer zostaje w dotychczasowej postaci. Nie jest wymagany reimport poprzednich plików ani reinstalacja AMIplus.

## Granice

Nie zmieniono modeli PV/baterii, ich założeń, ograniczeń ani starych parserów i endpointów HA. Nowe godziny głównego eLicznika stają się dostępne przez istniejące źródło współdzielone PV, ale nie zmieniają jego ustawień czy zapisanych historii. Ostrzeżenia godzinowego profilu Growatt pozostają odłożone zgodnie z decyzją użytkownika.

Sprawdzenie na emulatorze recorder i zachowanych CSV nie jest niezależnym odczytem działającego HA użytkownika ani potwierdzeniem poprawności rozliczeń operatora. Dane licznika i jego identyfikatory pozostają w prywatnym HA/dodatku. Nie dodawać katalogów `uploads/` i prywatnych audytów do repozytorium/paczki publicznej.

## Dostęp także z Rozbudowy PV (0.4.2)

W zakładce **Rozbudowa PV → Pobór i oddanie z AMIplus** znajduje się ten sam formularz co w głównym eLiczniku. Przełączanie zakładek przenosi istniejące kontrolki, nie tworzy kopii historii lub drugiego handlera i nie wywołuje AMI. Wybór licznika, potwierdzenie, data i komunikat pozostają te same. Formularz AMI jest poza formularzem scenariusza; zmiana daty/wyboru AMI nie zapisuje ustawień PV.

Import jest świadomym zapisem do **wspólnego głównego eLicznika**, wraz z jego pochodnymi miesięcznymi, tak samo jak w 0.4.1. Nie jest nowym prywatnym cache PV i nie zmienia wzorów rozliczeń. Sama symulacja nadal pozostaje tylko odczytem tych danych. Ceny RCE są osobno, a produkcja PV DC nadal pochodzi z wcześniejszego źródła HA/Growatt — AMI nie dostarcza całej produkcji instalacji.

Zakres AMI nie zmienia dat obliczeń PV. Po nowym imporcie aktualizowany jest podgląd pokrycia eLicznika; wynik godzinowy jest unieważniany, aby nie pokazywać starego wyniku jako aktualnego. Dotyczy to także wyboru samego CSV, bo nowe wspólne godziny mogą ujawnić istniejący w modelach konflikt źródeł. Kliknij ponownie obliczenie. Nie ma automatycznej zmiany parametrów lub zgody scenariusza, przeliczenia modeli ani pobierania produkcji PV.

Wybór **„Tylko osobny CSV”** pozostaje świadomie zachowany: zapis AMI nie zastępuje tego CSV ani nie przełącza źródła. Aby używać wspólnych godzin, wybierz „Automatycznie” lub „Tylko dotychczasowe dane”. Ręczny estymator roczny zachowuje swój wynik i założenia; czyści się tylko opcjonalne odniesienie do zmienionej historii.

Operacje PV i AMI mają wspólną blokadę w czasie importu. Rozpoczęty odczyt/zapis/reset PV lub oczekujący zapis jego ustawień wstrzymuje uruchomienie AMI; w czasie AMI nie startuje timer pobierania PV. Po anulowaniu/błędzie kontrolki wracają do stanu właściwego dla wybranego trybu. Nie dodano harmonogramu AMI ani nie zmieniono istniejącego wyboru automatycznego odświeżania PV.

## Poprawki bezpieczeństwa i spójności (0.4.3)

- **Autoryzacja fail-closed:** ustawienie `require_auth: true` bez zmiennej środowiskowej `ADDON_TOKEN` blokuje żądania kodem `503` (poza `/api/health`) zamiast po cichu wyłączać ochronę. Porównanie `X-Addon-Token` używa stałoczasowego `crypto.timingSafeEqual`.
- **CSP bez `'unsafe-inline'` w `script-src` i bez Google Fonts:** serwer generuje losowy `nonce` dla każdego żądania `index.html`, a zablokowane zewnętrzne arkusze Google Fonts zostały usunięte.
- **Ochrona przed Stored XSS:** wszystkie interpolacje kluczy miesięcy i etykiet w `innerHTML` przechodzą przez `V.escapeHtml()`, a ręczne dodawanie miesiąca waliduje format `RRRR-MM`.
- **Magazyn KV i współbieżność:** walidacja nazw kluczy (blokada `__proto__`, `..`, znaków specjalnych), mapa o prototypie `null`, limity rozmiaru zapisu (32 MB / 500 kluczy), losowe pliki tymczasowe `wx` z prawami `0o600`, limit `maxPayload` (16 MB) w `ha-ws.js` oraz optymistyczna kontrola `ETag` / `If-Match` (`409 Conflict`) dla `monthly-ledger` z synchronizacją po imporcie AMIplus.
- **Pełne czyszczenie w `btnReset`:** przycisk czyszczenia głównej karty usuwa teraz także `ha-hourly-*` oraz powiązanie `ami-v1-meter` (z zachowaniem danych karty Rozbudowa PV) i jest chroniony przed równoległym importem AMI.
- **Zachowanie danych przy aktualizacji:** format `/data/kv-store.json` oraz wszystkie klucze historii, cen RCE, AMIplus i PV są w 100% zachowane bez migracji niszczących.

## Poprawki kalkulacji i zakładki Wygasanie (0.4.4)

- **Zakładka Depozyt (spójność z TAURON i Wygasaniem):** `computeLedgerFromState()` stosuje ustawowy model **M+1 FIFO** z wygasaniem po 12 miesiącach (M+13) — przypis za miesiąc M zasila konto dopiero od M+1, więc nie pokrywa kosztu energii tego samego miesiąca M. Saldo w Depozycie jest w pełni spójne z sumą aktywnych transz w Wygasaniu.
- **Zakładka Wygasanie — status „Wykorzystana” i „Potencjalny zwrot”:** transza zużyta w całości (`remaining <= 0,005 zł`) zmienia status na **„Wykorzystana”** (zamiast mylącego „Aktywna, wygasa…”) i nie pojawia się jako najbliższe wygaśnięcie z `0,00 zł`. Dla aktywnych transz z pozostałym saldem kolumna **„Potencjalny zwrot”** wylicza na żywo prognozę `do X,XX zł` (według bieżącej stawki `[%]` i podstawy limitu `przed ×1,23` / `po ×1,23`), a stopka tabeli podsumowuje wszystkie kolumny.
- **Zakładka Analiza (ROI) — kontrola pokrycia PV:** `selfConsumptionFor()` sprawdza pokrycie godzin pomiaru produkcji PV (`haPvHours / haHours >= 90%`, tak samo jak F48 w Magazynie), zapobiegając fałszywej ujemnej autokonsumpcji w miesiącach z niepełnym pomiarem Growatt (np. przy działającym BMS). Usunięto również zdublowany fragment opisu w panelu kosztu inwestycji.
- **Ręczny import CSV RCE:** `parseRceRows()` rozpoznaje kolumny `period` i `dtime` (koniec kwadransa z PSE) i używa `V.rceHourFromRecord()`, zachowując zgodność ze starszymi plikami godzinowymi.
