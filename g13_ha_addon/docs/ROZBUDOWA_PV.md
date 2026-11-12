# Rozbudowa PV 0.4.0 — dostępne godziny + roczny ROI: zużycie → eksport

Nowy **czwarty, jawnie wybierany tryb**: „Dostępne godziny + roczny ROI — zużycie → eksport, bez symulacji baterii”. Nie wymaga 100% poprawnych godzin całego okresu. Nie naprawia historii i nie zmienia dotychczasowych trybów, ich wymagań lub salda rzeczywistego.

**Nie wyceniamy całego przyrostu jako eksportu.** Dodatkowe PV najpierw zmniejsza historyczny godzinowy pobór z sieci; dopiero reszta jest nadwyżką do eksportu. Pobór z eLicznika jest przyjętym przybliżeniem niezaspokojonego zużycia: może obejmować ładowanie baterii, nie jest osobnym pomiarem samego domu. Nie rekonstruujemy H, SOC ani zmienionej pracy magazynu. Pominięcie modelowania baterii nie oznacza jej fizycznego odłączenia.

## Przepływy i wycena

Dla użytecznej godziny UTC:

```
nowe_DC = historyczne_PV_DC × dodatkowe_kWp / obecne_kWp × względny_uzysk
```

Konwersja i limit falownika mają ten sam kontrakt co historyczny eksport 0.3.8:

- wspólny DC: `dodatkowe_AC = min((PV + nowe_DC) × η, limit) − min(PV × η, limit)`;
- osobny falownik AC: `dodatkowe_AC = min(nowe_DC × η, limit_nowego_falownika)`.

To krzywe samego PV, nie pomiar wolnego budżetu hybrydy z baterią lub gwarancja limitów chwilowych/MPPT.

Następnie:

```
zmniejszenie_poboru = min(dodatkowe_AC, potwierdzony_pobór_eLicznika)
nadwyżka            = dodatkowe_AC − zmniejszenie_poboru
wolny_limit         = max(0, limit_eksportu − historyczny_eksport)
nowy_eksport        = min(nadwyżka, wolny_limit)
niewykorzystane_AC  = nadwyżka − nowy_eksport

oszczędność_zakupu  = zmniejszenie_poboru × zapisana_stawka_strefy_G13
przypis_depozytu    = nowy_eksport × przeliczenie_RCE_tej_godziny
```

Przykładowo: 3 kWh dodatkowego AC i 1 kWh poboru oznacza 1 kWh mniej zakupu i maksymalnie 2 kWh eksportu, **nie sprzedaż wszystkich 3 kWh**. Danej kWh nie wyceniamy podwójnie.

- **RCE jest historyczne, przypisane do tej samej godziny.** Nie używamy ręcznej ceny 0,30 zł/kWh ani średniej arytmetycznej wszystkich cen, w tym nocy. Niezmienione `pv-model.sellPrice`: ujemna RCE → 0, PLN/MWh → PLN/kWh, współczynnik 1,23 od lutego 2025. To kontynuacja dotychczasowej reguły PV, nie nowa interpretacja przepisów.
- **Zakup G13 korzysta z aktualnie zapisanych stawek strefowych**, nie z datowanego archiwum zmian taryfy. UI mówi o tym wprost; nie obiecujemy odtworzenia każdej dawnej ceny zakupu, której aplikacja nie posiada. Brak strefy/ceny nie jest zastępowany zerem ani stawką domyślną.
- Limit eksportu dotyczy dopiero nadwyżki. **0 kW eksportu nie blokuje zużycia na miejscu.** Historyczny eksport nie jest obcinany. Pusty limit nie oznacza braku limitu; taki wariant wymaga istniejącego jawnego checkboxa.
- Przy nieznanym poborze nie zakładamy, że pobór wynosi 0 i całe PV można sprzedać. Przy znanym poborze i nieznanym eksporcie można nadal wycenić zmniejszenie zakupu; nadwyżka z ograniczeniem eksportowym pozostaje niewyznaczona. Jawny brak limitu usuwa tę zależność, nie tworzy pomiaru eksportu.

## Co oznacza wykorzystanie przez dom — a czego nie oznacza

**Fizyczny udział zużycia obliczamy godzinowo**, nie ustawiamy go na 100% produkcji. Dopiero nadwyżka trafia na eksport.

**Finansowo przyjmujemy pełną wartość dodatkowego przypisu do wykorzystania na późniejsze rozliczenie energii pobranej dla domu.** Nie używamy `refundRate`, mnożnika wypłaty 30%, zakresu ±30% ani procentu wykorzystania z innych trybów. Ich zapisane wartości pozostają zachowane, ale nie sterują nowym trybem. To jawne założenie wykorzystania środków, nie gwarancja wykorzystania i nie wypłata gotówkowa.

Osobnego wariantu zwrotu niewykorzystanego depozytu w gotówce **nie dodano w tym wydaniu**. Nie sumujemy takiego zwrotu z wykorzystaniem tego samego depozytu i nie nazywamy go sprzedażą całego salda.

## Dostępne godziny zamiast blokady całego zakresu

- Wykorzystujemy poprawnie zapisany PV DC, a nie proporcjonalnie powiększony eksport eLicznika. Dla licznika nadal potrzebne są `change`, poprzednia godzina/bufor i brak sprzeczności `change` z Δsum. Nie zastępujemy PV średnią mocą, nie przesuwamy godzin, nie obcinamy ujemnych przyrostów.
- **W nowym trybie nieużyteczna godzina nie blokuje innych.** Pozostaje w źródle; raport zawiera liczbę godzin, powody i listę niepełnych przedziałów. Nie zapisujemy pominięcia jako zmierzonego zera.
- Znane podsumy zakupu i depozytu są osobne. Brak ceny RCE nie kasuje znanej oszczędności zakupu; brak ceny zakupu nie kasuje znanego przypisu. Znane kWh bez ceny pokazujemy oddzielnie. Przy braku PV nie wymyślamy nieznanych kWh.
- Zero dodatkowej energii nie wymaga ceny, ale nie oznacza potwierdzenia zerowych historycznych przepływów. Zero zapisanej ceny jest prawidłową wartością; brak ceny pozostaje brakiem.
- **Powtórzona godzina jesienna** bez jednoznacznego dopasowania przepływów/cen zostaje wyłączona z tego szacunku (2 h UTC), nie blokując reszty. Nie przypisujemy jednej ceny do dwóch foldów. Pozostałe tryby zachowują własny kontrakt DST i zgodę na agregację.
- Konflikt między źródłami wyłącza odpowiednią godzinę, nie jest rozstrzygany wyborem korzystniejszej wartości. Nie sumujemy źródeł ani nie dopisujemy flag.
- Brak całego profilu daje raport bez podstaw do rocznego ROI, nie fikcyjną prognozę z 0,30 zł. Nadal wymagane są sensowne jawne parametry formularza oraz bezpieczny format zapisu; „bez blokad za luki” nie oznacza akceptacji uszkodzonego JSON lub przypadkowych jednostek.

Wynik jest **znaną podsumą z dostępnych danych**, a nie pełną kwotą okresu lub gwarantowaną dolną granicą rzeczywistej korzyści. Pokrycie oraz miesięczne części okresu pozostają widoczne.

## Osobny roczny szacunek i ROI

Pole **„Roczny uzysk AC do podziału · kWh/kWp/rok”** jest osobne od założeń manualnego estymatora 0.3.9. Startowe **1000** to edytowalny przykład, nie pomiar, kalibracja lub wynik PVGIS. Oznacza energię po konwersji/limicie falownika, **przed podziałem** na zmniejszenie poboru, eksport i niewykorzystaną nadwyżkę. Brak/nieprawidłowy uzysk nie blokuje historycznych podsum — wyłącza tylko roczny wynik.

Do rocznego odniesienia bierzemy **wyłącznie te godziny, w których cały dodatkowy strumień AC ma znany podział i pełną potrzebną wycenę**. Ich dodatkowe AC jest wspólnym mianownikiem:

```
wartość_zakupu_na_AC = suma_oszczędności_zakupu_w_próbie / suma_dodatkowego_AC_w_próbie
wartość_depozytu_na_AC = suma_przypisu_w_próbie / suma_dodatkowego_AC_w_próbie

roczne_AC = dodatkowe_kWp × założony_roczny_uzysk_AC
roczna_oszczędność = roczne_AC × wartość_zakupu_na_AC
roczny_depozyt     = roczne_AC × wartość_depozytu_na_AC
roczna_korzyść     = roczna_oszczędność + roczny_depozyt
prosty_zwrot_lata  = koszt_samej_rozbudowy / roczna_korzyść
roczna_stopa_%     = roczna_korzyść / koszt_samej_rozbudowy × 100
```

Z tej samej próby pochodzą udziały zmniejszenia poboru, eksportu i ograniczenia eksportu. Nie używamy ceny eksportu dla energii pokrywającej zużycie. Godziny z częściową wyceną nadal wchodzą do znanych podsum okresu, ale nie do pełnej rocznej próby.

- **Nie annualizujemy liczby dni lub sumy energii krótkiego okresu.** Roczna energia jest osobnym założeniem, nie ma drugiego mnożenia przez eta/95%, a przypis RCE nie jest ponownie mnożony przez 1,23.
- Udziały i ceny dostępnej próby mogą **zawyżyć lub zaniżyć** wynik roczny. Sezonowość i brakujące godziny nie gwarantują „ostrożnej” średniej. Pokazujemy dodatnie godziny/AC próby i informację o tej niepewności; to nie przedział ufności.
- Bez dodatniej w pełni wycenionej próby nie ma podstaw do rocznego ROI; nie zastępujemy go zerem lub ceną ręczną. Przy zadanej rocznej energii 0 wynik roczny wynosi 0. Przy zerowej korzyści nie ma skończonego zwrotu, przy pustym/zerowym koszcie okres/stopa zwrotu są nieznane.
- Koszt dotyczy całej samej rozbudowy. Prosty zwrot pomija degradację, serwis, finansowanie, dyskonto i przyszłe zmiany cen/przepisów.

## Dane, pobranie i izolacja

Można użyć **krótszego lub niepełnego istniejącego zapisu**, gdy jego zakres choć częściowo pokrywa wybór oraz zgadza się rola licznika PV. Wybierany jest jeden cały zbiór z największą liczbą użytecznych godzin w wybranym okresie, następnie najnowszy. Nie sklejamy godzin kilku historii i nie rozszerzamy zakresu ponad metadane. UI pokazuje źródło, zakres i pokrycie. CSV zapisany w PV jest używany ponownie.

Przycisk **„Pobierz dostępne dane PV — osobny zapis”** pobiera tylko PV DC i opcjonalną moc, miesięcznymi częściami z buforem. Zbiór z lukami można aktywować, jeżeli ma przynajmniej jedną użyteczną godzinę PV. Prawidłowa odpowiedź CSV z samym nagłówkiem dla całego pustego miesiąca nie blokuje kolejnych dostępnych miesięcy: jest pustą częścią, nie rekordami zerowymi. HTML, błędny format lub błąd HTTP nie są traktowane jako brak miesiąca. Sama moc, cały pusty zakres lub przerwany zapis nie zastępują wcześniejszego zbioru.

Nowe klucze: `pv-sim-v1-available-active` i `pv-sim-v1-available-data-*`. Ten osobny atomowy zapis **nie zastępuje** pełnej historii, cache eksportowego ani CSV. Stare historyczne tryby nie korzystają z niego po cichu i nadal sprawdzają pełny wymagany zakres. Algorytm atomowego zapisu, limity części, odczyt niepewnego commita i izolacja kluczy zachowane. Jawny dwuklik resetu obejmuje także nową kolekcję, nigdy legacy.

Nowy tryb nie uruchamia automatycznego pobierania HA, nawet jeśli wcześniejszy `autoRefresh` pozostał zapisany. Pobranie jest ręczne. Uszkodzony nowy cache nie blokuje starszych trybów ani nie jest automatycznie nadpisywany. Formularz nie zmienia parametrów baterii, starych sprawności, manualnej ceny rocznej lub dawnych zgód poza unieważnieniem zgody po zmianie trybu/założeń. Spóźnione obliczenie nie publikuje wyniku po zmianie formularza.

Bajtowo niezmienione względem 0.3.9: silniki `pv-model.js`, `pv-export.js`, `pv-annual.js`, przygotowanie `pv-data.js`, formularz `pv-form.js`, backend recorder/HA/KV, walidatory, XLSX i zależności. W `pv-store.js` dodano tylko osobną kolekcję i objęcie jej jawnym resetem. Wspólny HTML/serwer zmieniają wyłącznie lokalny asset `pv-available.js` i jego tag cache.

## Obsługa i dostawa

W **Rozbudowa PV**, u góry w **„Sposób liczenia korzyści z rozbudowy”**, wybierz nowy wariant. Wybór wcześniejszego trybu nie jest sam zmieniany. Sprawdź zakres, kWp, podłączenie, limity, sprawność, koszt i roczny uzysk AC. Zaakceptuj scenariusz i oblicz. Jeśli zachowana historia już daje potrzebną próbę, nie pobieraj/nie importuj jej ponownie. Jeśli potrzebujesz szerszego dostępnego profilu, użyj nowego osobnego przycisku pobrania, nie czyść starych danych.

Dostawa: Git + PowerShell, **bez Node/npm, testów PC, konsoli przeglądarki i obowiązku wklejania logów**. Paczka na dokładnej bazie 0.3.9; DryRun → zastosowanie, pytania w bieżącym PowerShellu, instalator nieinteraktywny. Bez resetu/force/kasowania starszych klonów. Opcjonalny push wymaga osobnego dokładnego `TAK`; PR/scalenie/HA osobno. Asystent nie publikuje i nie wdraża.

Testy przygotowania obejmują poprzednie regresje, podział energii, oddzielne ceny/podsumy, braki/konflikty/DST, brak podwójnej wyceny, roczną próbę i brak skończonego zwrotu przy zerowej korzyści, wybór cache i atomiczny zapis, prawdziwy DOM/ingress/HTTP oraz przypadki mutacyjne. Dane testowe nowych modułów są sztuczne; prywatne historie i raporty pozostają poza publicznym ZIP. To nie wykonanie na PC/HA użytkownika ani walidacja fizyczna.

---

# Zachowany opis 0.3.9 — osobny manualny estymator roczny

Poniżej wcześniejszy kontrakt. Jego założenie wyceny całego przyrostu jako eksportu, ręczna cena i trzy warianty cen **nie dotyczą nowego trybu zużycie → eksport**. Historyczne instrukcje instalacji nie zastępują procedury 0.4.0.

# Rozbudowa PV 0.3.9 — osobny „Szacunek roczny + ROI”

**Nowy tryb jest estymatorem z jawnych założeń, nie rekonstrukcją pomiarów.** Odpowiada na pytanie o orientacyjną roczną wartość dołożonych paneli i prosty zwrot samej rozbudowy, bez wymagania kompletnych godzin HA/eLicznika/RCE. Nie uzupełnia luk, nie zeruje nieznanych pomiarów i nie annualizuje krótkiego okresu.

Pozostają trzy wybierane jawnie tryby:

1. **Szacunek roczny + ROI** — niezależny rachunek z poniższych założeń.
2. **Dodatkowa produkcja PV wyceniona jako eksport** — zachowany model godzinowy 0.3.8 i jego walidacja.
3. **Dynamiczna praca istniejącej baterii** — zachowany wcześniejszy model wraz z kontrolami H, SOC, A/V i sprawności.

Wcześniej zapisany tryb nie zmienia się sam. Dawne ustawienia bez pola trybu nadal oznaczają model baterii. Nowy niezapisany formularz zachowuje dotychczasowy domyślny wybór eksportu godzinowego; estymator wybiera się z listy raz. Zmiana trybu lub rocznych założeń unieważnia zgodę i wynik, ale nie usuwa parametrów, historii ani CSV.

## Założenia i wzory

Podstawowy formularz roczny pokazuje tylko cztery pola: dołożone kWp, koszt samej rozbudowy, roczny uzysk AC i środkową wartość przypisu depozytu za kWh. W zaawansowanych pozostają wykorzystanie depozytu i rozpiętość cen; bieżąca rozpiętość jest opisana także w widocznym komunikacie. Wszystkie założenia pokazuje wynik.

```
E_AC_rocznie = dołożone_kWp × uzysk_AC_kWh_na_kWp_rocznie
P_wariantu  = środkowa_wartość_depozytu × (1 − rozpiętość, 1, 1 + rozpiętość)
przypis     = E_AC_rocznie × P_wariantu
korzyść     = przypis × wykorzystanie_depozytu
prosty_zwrot_lata = koszt_samej_rozbudowy / korzyść
prosta_roczna_stopa_zwrotu_% = korzyść / koszt_samej_rozbudowy × 100
```

- Początkowe **1000 kWh AC/kWp/rok**, **0,30 zł/kWh** i **±30% ceny** to **edytowalne przykłady**, nie pomiary, kalibracja, wynik PVGIS lub prognoza cen. Nie są dobierane z kilku tygodni historii. Wartości wymagają własnej oceny dla położenia, orientacji, zacienienia i sposobu rozliczenia.
- Uzysk **AC** jest już po założonych stratach i ograniczeniach. Nie mnożymy go drugi raz przez 95%, sprawności baterii, historyczny współczynnik DC ani limity falownika/eksportu z innego trybu. Nie potwierdzamy w ten sposób żadnego sprzętu lub projektu podłączenia.
- Cena oznacza **gotową kwotę przypisu depozytu za kWh**, już po zasadach rozliczenia. To nie surowa RCE w zł/MWh; nie doliczamy ponownie mnożnika 1,23. Wartość ujemna jest odrzucana, a jawne 0 jest dopuszczalne.
- Całą przyjętą dodatkową energię AC wyceniamy z założenia jako eksport. Rzeczywista autokonsumpcja, bateria lub ograniczenia mogą dać inny efekt. Nie naliczamy jednocześnie dodatkowych oszczędności zakupu G13 lub korzyści magazynu.
- **Depozyt nie jest gotówką.** Liczy się marginalne wykorzystanie dodatkowego przypisu, nie samo saldo ani historyczne zużycie całego depozytu. 100% jest scenariuszem, nie gwarancją wykorzystania.
- Koszt dotyczy **całej samej rozbudowy**, np. paneli, montażu i dodatkowego osprzętu; nie dodajemy automatycznie kosztu istniejącej instalacji lub baterii.
- Warianty **ostrożny / środkowy / korzystny** zmieniają **tylko cenę**, przy tej samej energii i wykorzystaniu. To umowna analiza wrażliwości, **nie statystyczny przedział ufności ani gwarancja, że wynik rzeczywisty się w nim znajdzie**. ±0% daje trzy identyczne scenariusze; przy ±100% ostrożny ma cenę 0.
- Przy zerowej energii/cenie/wykorzystaniu korzyść wynosi 0 i nie ma skończonego zwrotu. Przy pustym lub zerowym koszcie energia/korzyść nadal są obliczane, ale ROI i okres zwrotu pozostają nieznane; nie prezentujemy natychmiastowego zwrotu. Pusty uzysk lub cena nie są zamieniane na zero.
- Prosty zwrot zakłada powtarzalną roczną korzyść. Pomija degradację, serwis, finansowanie, dyskontowanie i przyszłe zmiany cen/przepisów. To nie NPV, IRR ani rekomendacja inwestycyjna.

## Historia jako opcjonalny punkt odniesienia

Roczny przycisk obliczeń nie uruchamia przygotowania godzin, pobierania HA ani odczytu cen/eLicznika; nie czeka na gotowość danych legacy. W tym trybie wyłączone są również planowanie i wykonanie zachowanego automatycznego odświeżania HA. Parametr autoRefresh nie jest tracony — działa ponownie dopiero w trybie historycznym.

W osobnym rozwijanym panelu można nacisnąć **„Porównaj z zapisanym okresem — tylko odczyt”**:

- Używa wyłącznie już zapisanej, zgodnej całej historii oraz zachowanych dat/założeń modelu eksportowego. Nie pobiera HA, nie importuje ponownie CSV i nie skleja godzin kilku zbiorów.
- Odniesienie to **przypis dodatkowego depozytu / modelowy przyrost eksportu**, ważone produkcją tego okresu, nie średnia taryfa lub przypis całej istniejącej instalacji. Do tego odrębnego historycznego wyniku nadal potrzebne są poprawne wejścia; dodatni eksport z niepełną ceną nie udaje kompletnej średniej.
- Brak historii, luki, brak zgody DST lub brak pełnej wyceny uniemożliwiają tylko to opcjonalne odniesienie, **nie roczne obliczenie**. Nie ma automatycznej naprawy lub domyślnego zera.
- Wynik odniesienia pokazuje daty, godziny, energię, przypis i cenę okresu. **Nic nie jest automatycznie przepisywane.** Osobny przycisk świadomego użycia ceny przenosi ją jako własne założenie roczne, zapisuje pochodzenie i wymaga nowej zgody.
- Nawet po świadomym przyjęciu ceny okresu roczna energia pochodzi z osobno wpisanego uzysku AC. Nie przeliczamy kilku tygodni na rok. Opis dat pozostaje widoczny po ponownym otwarciu; ręczna zmiana ceny usuwa ten opis pochodzenia.
- Spóźniony wynik odniesienia jest unieważniany po zmianie ustawień/trybu. Wynik roczny nie jest zapisywany do salda rzeczywistego.

## Izolacja i zachowanie zapisów

`pv-annual.js` jest czystym modułem obliczeniowym bez DOM, sieci, HA i KV. `pv-tab.js` wybiera ścieżkę roczną **przed** kontrolami godzinowymi. Ustawienia i opis świadomie wybranej ceny są zapisane tylko w dotychczasowej przestrzeni `pv-sim-v1-`; wynik nie zmienia rozliczeń ani kalkulatora dodatkowej baterii.

Uszkodzona opcjonalna historia nie jest nadpisywana/czyszczona i nie blokuje rocznego wyniku, jeśli same ustawienia zostały poprawnie odczytane. Przy uszkodzonym zapisie ustawień nadal odmawiamy jego cichego nadpisania. Błąd zapisu ma jawny komunikat „tylko w pamięci”.

**Bez zmian bajtowych względem 0.3.8:** `pv-model.js`, `pv-data.js`, `pv-form.js`, `pv-export.js`, `pv-store.js`, backend recorder/HA/KV, walidatory i biblioteka XLSX. `index.html` otrzymuje tylko względny lokalny skrypt `pv-annual.js`, serwer tylko jego tag treści/cache. Zależności npm nie zmieniają się. Dokumentacja wcześniejszych trybów poniżej ma charakter zachowanego kontraktu, a nie bieżącej instrukcji instalacji.

## Obsługa i dostawa 0.3.9

W zwykłym UI wybierz **„Szacunek roczny + ROI — bez kompletnej historii HA”**, sprawdź cztery podstawowe pola oraz wykorzystanie/rozpiętość, zaakceptuj założenia i oblicz. Nie wybieraj dat, nie pobieraj HA ani nie importuj ponownie CSV tylko po to, by uruchomić roczny szacunek. Opcjonalne odniesienie nie jest etapem obowiązkowym.

Procedura aktualizacji: **Git + PowerShell, bez Node/npm, testów PC, konsoli przeglądarki i wymogu wklejania logów**. Paczka sprawdza dokładną bazę 0.3.8, czystość klona, pełne hashe i zakres zmian. Pytania są w bieżącym PowerShellu; bezinteraktywny instalator robi DryRun, potem zastosowanie po sukcesie. Istniejący klon używany jest tylko po jawnym wskazaniu; nie jest resetowany, kasowany ani zastępowany po błędzie. Standardowo powstaje nowy unikalny klon. Opcjonalna publikacja wymaga osobnego dokładnego `TAK`; PR/scalenie i aktualizacja HA są osobnymi czynnościami użytkownika. Asystent nie wykonuje tych działań.

Testy przygotowania obejmują stare regresje, arytmetykę roczną, 1200 deterministycznych zestawów założeń, błędne/puste/zerowe parametry, DOM, zapis i ponowne otwarcie, przełączanie trybów, opóźnione odniesienie, błędy historii/zapisu, zakaz pobrań HA w trybie rocznym oraz rzeczywisty HTTP/KV/cache zasobów. Testy mutacyjne sprawdzają wykrywanie celowo wprowadzonych błędów. Są to testy w środowisku przygotowania, **nie na komputerze/HA użytkownika i nie walidacja fizyczna**. Prywatne eksporty oraz szczegółowe wyniki użytkownika pozostają poza publicznym payloadem.

---

# Zachowany opis wydania 0.3.8 — poniższe wymagania godzinowe dotyczą tylko trybów historycznych

Opis „bez rocznego zwrotu” poniżej nadal obowiązuje w godzinowym modelu eksportu. Nie jest ograniczeniem nowego, jawnie założeniowego estymatora rocznego opisanego powyżej. Historyczna procedura instalacji 0.3.8 nie zastępuje procedury aktualizacji 0.3.9.

# Rozbudowa PV 0.3.8 — dwa jawnie oddzielone sposoby liczenia

## Nowy prosty tryb: dodatkowa produkcja PV wyceniona jako eksport

Ten tryb NIE rekonstruuje domu, baterii ani instalacji fizycznie pozbawionej magazynu. Odpowiada na pytanie: **ile wynosi wartość przyrostu produkcji nowych paneli, jeśli cały dostępny przyrost po przyjętych stratach/ograniczeniach potraktujemy jako eksport?** Rzeczywista autokonsumpcja, bateria, sterowanie i ograniczenia chwilowe mogą dać inne przepływy. Wynik jest scenariuszem, nie pomiarem, gwarancją oddania ani wypłatą gotówki.

Dotychczasowe rozliczenia i zaawansowany model z dynamiczną baterią pozostają niezależne. Nie zmieniono `pv-model.js`, `pv-data.js`, `pv-form.js`, funkcji RCE, logiki depozytu/magazynów ani backendu recorder. W `index.html` doszedł wyłącznie lokalny moduł; w serwerze jego tag treści/cache. Nowe testy i UI nie zapisują legacy KV.

### Wymagane dane i ponowne użycie historii

- PV DC: przyrost `change` w kWh oraz bufor poprzedniej godziny. Wymagany pełny ciągły zakres UTC; luki, ujemne przyrosty i niezgodność z Δsum są błędami, nie zerami. Nie używamy wyjścia AC zawierającego rozładowanie baterii zamiast PV DC.
- Moc PV jest opcjonalną diagnostyką. Jednostka W/kW musi być jawna, zgodnie z istniejącym kontraktem HA; brak jednostki wyłącza porównanie, nie zmienia kWh. Nie zastępujemy licznika średnią mocą i nie przesuwamy energii między godzinami. Niespójności profilu mogą wpływać na godzinowe RCE także po rezygnacji z H.
- Potwierdzony historyczny **eksport** eLicznika jest potrzebny do kontroli wolnego miejsca w zadanym limicie całego układu. Import i taryfa G13 nie są wejściami tego trybu. Gdy użytkownik jawnie przyjmie brak limitu eksportu, można wycenić sam przyrost bez eLicznika, ale punkt odniesienia pozostaje **nieznany**, nie 0.
- Auto wybiera cały rekord z potwierdzonym eksportem: dane dodatku, a następnie sprawdzony zapis CSV PV. Nie sumuje źródeł, nie dopisuje flag i nie łączy fragmentów pomiaru. Sprzeczny eksport w dwóch źródłach blokuje. Etykiety licznika 1–24 są nadal końcami przedziałów; parser bez zmian.
- W tym trybie diagnostyka źródeł wyraźnie potwierdza tylko eksport. W starym modelu warunkowego H nadal wymagane są oba kierunki i obowiązują wszystkie stare konflikty/kontrole.
- Powtórzona godzina jesienna pozostaje dwoma UTC, wspólny krok 2 h wymaga zgody. Potwierdzenie eksportu wymaga obu rekordów eksportu; nie zgadujemy podziału ceny/energii na foldy. Dodatnia energia bez jednoznacznego RCE daje nieznaną pełną kwotę.
- Nowy tryb może użyć podzakresu istniejącej własnej historii, jeżeli sygnatura obejmuje daty i wskazany licznik PV. Kompletność i bufor sprawdzane są mimo zgodności metadanych. Tydzień nie zastępuje miesiąca. Wybieramy cały najnowszy pasujący zapis, nie składamy godzin z kilku historii.
- Minimalne pobranie żąda wyłącznie PV DC i opcjonalnej mocy. Zapis `pv-sim-v1-export-active` i `pv-sim-v1-export-data-*` jest oddzielony od starego pełnego `pv-sim-v1-active`/`data-*`. Atomowy commit manifestu, zakres kluczy i limit części 1,8 MB pozostają kontrolowane. Nowy fetch bez kompletnego wymaganego profilu/bufora nie zastępuje poprzedniego zapisu; HTTP 200 z samą mocą nie oznacza sukcesu PV.
- Zapisany CSV eLicznika jest używany ponownie. Nowy tryb nie wymaga ponownego importu tego samego pliku. Nie jest automatycznym pobieraniem danych z Taurona.

### Rachunek energii i ograniczeń

Dla kroku o długości `dt` godzin:

```
P = historyczny przyrost PV DC
N = P × dodatkowe_kWp / obecne_kWp × względny_uzysk
η = osobna sprawność PV DC → AC tego trybu
```

**Wspólny falownik DC:**

```
A = min((P + N) × η, limit_hybrydy × dt)
  − min(P × η, limit_hybrydy × dt)
```

To różnica dwóch krzywych konwersji **samego PV**, nie pomiar wolnego budżetu hybrydy. Nie znamy zajęcia falownika przez istniejącą baterię, ograniczeń MPPT i skutków zmiany sterowania. Profil jest już po historycznych ograniczeniach; nie odzyskujemy produkcji, której licznik nie zarejestrował.

**Dodatkowy falownik AC:**

```
A = min(N × η, limit_nowego_falownika × dt)
```

Istniejąca hybryda i jej prądy baterii nie są tu wymaganymi parametrami. Nie zakładamy sterowania ładowaniem z dodatkowego AC.

**Przyrost eksportu:**

```
W = max(0, limit_eksportu × dt − historyczny_eksport_eLicznika)
X = min(A, W)
```

Brak limitu wymaga osobnego jawnego wyboru — puste pole nie jest Infinity. Eksport historyczny większy od założonego limitu daje ostrzeżenie i 0 miejsca na przyrost. Nie obcinamy historii; ustawienie 0 blokuje X, a nie zamienia wcześniejszy eksport na zero. Czasowe średnie nie gwarantują limitów chwilowych.

Rozdzielamy nowy profil DC, dodatkowe AC po ograniczeniu falownika, przyrost eksportu, modelową stratę konwersji wyeksportowanej energii i ekwiwalenty DC niewykorzystane wskutek limitu falownika/eksportu. Rachunek kontrolny:

```
N = X + strata_konwersji + niewykorzystane_DC_falownika + niewykorzystane_DC_eksportu
```

Są to wielkości scenariusza, nie zmierzone straty/curtailment. Dom i bateria nie są ukrytymi zerowymi przepływami — **nie są modelowane**. Cały dostępny przyrost jest z założenia wyceniany jako eksport, także jeśli rzeczywista instalacja zużyłaby część inaczej.

### Wycena, formularz i zachowanie wcześniejszych ustawień

- Jedna osobna sprawność `exportPvToAcEta`. Przy pierwszym przejściu przenoszona jest wartość PV → AC starego zestawu, również jej precyzja lub jawny brak. Nowy niezapisany formularz proponuje orientacyjne 95%, nie pomiar. Zmiana tej sprawności nie zmienia sześciu sprawności starego modelu.
- Nie potrzeba A/V, pojemności, SOC, H, ładowania AC, BMS ani stawek G13. Pola te są ukryte i nieaktywne, ale ich wartości zostają zachowane dla starego trybu.
- Nowy, niezapisany formularz proponuje tryb `export_only`. Istniejący zapis bez pola `calculationMode` wraca do `dynamic_battery` — bez cichej zmiany znaczenia i zapisu przy starcie. Użytkownik wybiera prosty tryb raz; zmiana trybu oraz założeń eksportu unieważnia wynik i zgodę scenariusza.
- Wyceniany jest tylko X, przez niezmienioną funkcję `pv-model.sellPrice`: godzinowe `max(0,RCE)/1000`, współczynnik 1,23 od lutego 2025. Nowy moduł nie interpretuje na nowo zasad istniejących rozliczeń.
- Wartość warunkowa = wybrany stopień wykorzystania × przyrost przypisu depozytu. Nie wyliczamy oszczędności zakupu G13, wartości starej instalacji, zwrotu rocznego, gotówki ani końcowej energii baterii. Brak ceny przy dodatnim X nie jest zerem; znane podsumy i zakres braków są osobne.
- Koszt rozbudowy to informacja scenariusza, nie wyliczona rekomendacja zakupu. Limity nie są odczytem sprzętu/OSD; wybór podłączenia nie jest projektem elektrycznym.

### Pliki i weryfikacja 0.3.8

`app/public/pv-export.js` to czysty moduł nowego przygotowania danych, źródeł eksportu, zgodności cache i wyceny; bez DOM/KV/sieci. `pv-tab.js` przełącza interfejs, a `pv-store.js` dodaje wyłącznie osobną kolekcję historii. Dotychczasowy silnik, przygotowanie H i przeliczenia A/V zachowano bajtowo. Zależności nie zmieniły się.

Weryfikacja w środowisku przygotowania obejmuje wszystkie wcześniejsze testy, nowe testy silnika/danych/cache, zapis, DOM i prawdziwy HTTP/KV. Są też warianty losowe bilansu/ograniczeń, testy mutacyjne oraz prywatna kontrola na zachowanych danych — prywatne dane i wyniki nie są częścią repozytorium. Żaden z tych testów nie oznacza wykonania na komputerze/HA użytkownika ani fizycznej walidacji.

### Instalacja/obsługa

Procedura użytkownika: **Git + PowerShell, bez Node/npm i testów PC, bez wklejania logów i konsoli przeglądarki**. Paczka sprawdza dokładną bazę 0.3.7, pełny payload, czystość repo i zakres commita. Pytania uruchamiane są w bieżącym procesie PowerShell, a bezinteraktywny instalator wykonuje DryRun, potem zastosowanie tylko po sukcesie. Nie usuwa starszych klonów ani nie cofa zmian. Opcjonalne wysłanie gałęzi wymaga osobnego dokładnego `TAK`; PR/scalenie i aktualizacja HA są osobnymi decyzjami.

Po aktualizacji: wybierz prosty tryb, właściwe daty i jawne założenia, zaakceptuj scenariusz i oblicz. Jeśli zgodna historia już obejmuje okres, nie pobieraj jej ponownie tylko z powodu zmiany trybu. Gdy zapis obejmuje wyłącznie tydzień, a wybierasz miesiąc, pobierz jeden nowy minimalny zakres HA. CSV już zapisany w PV nie wymaga ponownego importu. Nie czyść karty ani nie odinstalowuj dodatku.

---

# Zachowany kontrakt wcześniejszego modelu z dynamiczną baterią (0.3.7)

Poniższa dokumentacja opisuje odrębny zaawansowany tryb i historię poprzednich wydań. Jego H, diagnostyka, A/V i pełna symulacja nie zostały uproszczone ani uznane za naprawione przez nowy tryb eksportu. Historyczne instrukcje/testy poniżej nie zastępują procedury 0.3.8 powyżej.

# Rozbudowa PV — kontrakt modelu scenariuszowego 0.3.7

**Stan: poprawka 0.3.7 tylko dla PV.** Automatyczny wybór istniejących źródeł eLicznika, zgodność ze współczesnym polem jednostki recorder HA i tabela składników ujemnego H. Stare rozliczenia, silnik energii, formularz A/sprawności, przestrzeń zapisu i oryginalne źródła 0.3.6 pozostają bez zmian. Testy wykonuje środowisko przygotowania paczki — procedura użytkownika na PC nie wymaga Node/npm ani lokalnych testów. Publikacja i aktualizacja HA są osobnymi, jawnymi czynnościami użytkownika; paczka nie steruje urządzeniami.

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

Dla wybranej encji mocy odczytuje `recorder/get_statistics_metadata`, a następnie `recorder/statistics_during_period` z `units: {energy: "kWh", power: "kW"}`. Odczytuje `statistics_unit_of_measurement` (HA 2026.10 i nowszy kontrakt) oraz starsze `unit_of_measurement`. `display_unit_of_measurement` nie jest dowodem jednostki statystyki. Gdy oba pola są obecne, muszą być obsługiwane i identyczne; null, sprzeczność, obca klasa, duplikat lub inny identyfikator nie są ignorowane. Tylko jawne W/kW o niesprzecznej klasie pozwalają opisać odpowiedź jako kW w kolumnie `power_unit`. Żądanie normalizacji wykonuje HA — odpowiedzi kW nie dzielimy drugi raz. Kontrakt sprawdzono w funkcji `_flatten_list_statistic_ids_metadata_result` pliku `homeassistant/components/recorder/statistics.py` tagu Core 2026.10.0; test emulatora uwzględnia rzeczywistą nazwę pola, a nie tylko historyczny wariant. Brak/nieobsługiwane metadane pozostawiają jednostkę nieznaną; błąd zapytania o statystyki daje błąd pobrania, nie fallback do danych o zgadywanej jednostce.

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

W 0.3.7 wszystkie ujemne przedziały mają od razu widoczną tabelę: początek lokalny, początek/koniec UTC, długość kroku, wyjście AC, import, eksport, ładowanie AC, wynik H i wybrane źródło eLicznika. Pokazujemy również identyfikatory encji i sumę samych ujemnych H, która NIE jest korektą bilansu. Rozróżnienie „eksport > wyjście + import” / „ładowanie AC > pozostała energia” to opis arytmetyczny, nie diagnoza uszkodzenia sensora. Zmiana limitów sprzętu, prądów lub sprawności scenariusza nie zmienia historii. Brak składnika pozostaje nieznany — nie tworzy pozornie kompletnego wiersza ujemnego H.

`R = PV DC + BMS rozładowanie DC + ładowanie AC − BMS ładowanie DC − wyjście AC` jest **warunkową resztą historyczną**, a nie obliczoną sprawnością. Pokazujemy wszystkie rozbieżności, liczbę ujemnych godzin, liczbę poniżej −0,2 kWh (tolerancja 1e−7) i pokrycie. Ujemne R nie są dopasowywane, zerowane, przenoszone do sąsiednich godzin lub pomijane. Przy brakującym BMS reszta pełnego okresu jest nieznana.

SOC mean/min/max służą wyłącznie ostrzeżeniom. Nie nadpisują energii modelu. Moc PV służy kontroli rozbieżności/zastojów, nie podmienia licznika.

### Czas, DST, eLicznik

- Wewnątrz używamy chronologicznych godzin UTC. Daty formularza obejmują całe lokalne dni, oba włącznie.
- Dzień wiosenny ma 23 godziny, jesienny 25; nie wstawiamy sztucznej godziny wiosną.
- Legacy cache eLicznika i RCE ma lokalne klucze bez rozróżnienia dwóch jesiennych 02:00. Nie wymyślamy przypisania jego wierszy do foldów.
- Wyjątkowo używamy **jednego kroku 2 h** z sumą obu godzin HA i potwierdzonym agregatem eLicznika, wyłącznie po osobnym zaznaczeniu akceptacji przybliżenia. W 0.3.7 same flagi cache nie wystarczają dla jesiennej powtórzonej godziny: potrzebne są dwa rekordy każdego kierunku (`expectedCount/importCount/exportCount = 2`), np. z już zapisanego sprawdzonego CSV PV. Tryb auto wybiera ten CSV dla wspólnego kroku. Główny importer nie został zmieniony i nie zapisuje liczności foldów. Bez dowodu pozostaje luka, nie „potwierdzony krok 2 h”. Moce wewnątrz kroku są nadal uśrednione.
- RCE wspólnego kroku jest **nieznane**, nawet jeśli w starym cache istnieje jedna cena. Nie stosujemy jej do dwóch nierozróżnionych przepływów. G13 korzysta z zapisanej strefy.
- Wymagamy nieujemnych obu kierunków eLicznika z jawnymi `hasImport/hasExport`. Starszy cache bez flag nie daje dowodu kompletności. Oryginalne pliki można potwierdzić w NOWYM, osobnym importerze wewnątrz PV. Nie używamy do tej naprawy importera Depozytu/Magazynu; nie dopisujemy flag do starych rekordów.

### Automatyczny wybór zapisanych źródeł — bez podwójnego importu

Domyślny tryb **„Automatycznie — dane dodatku + zapisany CSV PV”** używa świeżej kopii wspólnych danych przy sprawdzeniu i obliczeniu. Przy wejściu do karty oraz zmianie formularza automatycznie pokazuje pokrycie; to odczyt pamięci, nie żądanie do Taurona, zapis do legacy lub nowe pobranie HA.

1. Dla każdego przedziału wybiera **cały rekord** o pełnych obu kierunkach, poprawnych nieujemnych liczbach i potwierdzonych wymaganiach DST. Nigdy nie miesza poboru z jednego źródła z eksportem drugiego i nie sumuje dwóch kopii tej samej godziny.
2. Pierwszeństwo ma kompletny rekord z głównej karty. Jeśli w nim brakuje strefy, a kompletny CSV zawiera strefę, wybierany jest cały rekord CSV. Następnie CSV uzupełnia godziny bez dowodu kompletności w starym cache. Oba źródła pozostają nietknięte.
3. Jeżeli żadne źródło nie potwierdza godziny, pozostaje brak. Nie dopisujemy starych flag ani zer. Liczby miesięczne nie zastępują godzin. Dla starego okresu bez zachowanego dowodu nadal może być potrzebny **jednorazowy** oryginalny CSV; automatyka nie odzyskuje informacji, której nie zapisano.
4. Skończone różniące się energie lub różne niepuste strefy w dwóch źródłach blokują tryb auto, również gdy jeden zapis jest stary/bez flag. Pokrycie i wszystkie różnice są dostępne w zwykłym UI. Nie wybieramy „wygodniejszej” wartości, nie korygujemy historii. Różnice poza wybranym zakresem nie blokują tego zakresu.
5. Wcześniej zapisane CSV PV i historia HA są odczytywane z tego samego `pv-sim-v1-`; nie wymagają ponownego importu. Stare ustawienia 0.3.6 bez `gridPolicyVersion` przechodzą w formularzu na auto z widocznym komunikatem i wyłączoną starą akceptacją scenariusza. Sam start nie zapisuje migracji: najbliższa zmiana pola (np. ponowna akceptacja) zapisuje nowy wybór tylko w PV. A/V, sprawności, limity, daty i encje pozostają zachowane. Nowy, jawnie zapisany tryb ręczny z `gridPolicyVersion: 1` nie jest ponownie zmieniany na auto.
6. Kompletne nowe importy w głównej karcie są dostępne w PV przy następnym odczycie — nie wgrywamy tego samego pliku drugi raz do PV. Istniejący główny importer nie został zmieniony. Jest to **wybór już zapisanych źródeł, nie integracja ani automatyczny download z Taurona**.
7. Tryby zaawansowane „Tylko dotychczasowe dane” i „Tylko osobny CSV” nadal pozwalają jawnie przypiąć źródło. Tryb CSV nie uzupełnia luk z głównej karty, a tryb shared świadomie nie korzysta ani nie porównuje z archiwum CSV. Tryb auto porównuje oba. Uszkodzony zapis CSV nie jest ukrywany przejściem na drugie źródło.

### Jednorazowe potwierdzanie starego archiwum CSV — tylko w PV

- „Sprawdź zapis eLicznika — tylko odczyt” nie wymaga historii HA ani konsoli. Podaje pokrycie i osobno liczniki flag, liczb i brakującego dowodu obu jesiennych rekordów. Liczniki przyczyn mogą się nakładać.
- Zapisany wcześniej zestaw **zostaje**. Import jest potrzebny wyłącznie wtedy, gdy brakuje potwierdzenia starego okresu. Jeżeli wymieniasz własne archiwum, wybierz razem wszystkie CSV, które mają zostać zachowane: maks. 48 plików / 16 MB. Nowy zestaw zastępuje poprzedni CSV PV; nie scala jego energii ani nie zmienia oryginalnych plików. Nowe kompletne okresy z głównej karty nie muszą być w tym archiwum.
- Oryginalny format: średnik, `Data;Strefa;Wartość;Rodzaj;Status`, data ISO, etykieta końca godziny 1–24, oba kierunki **po zbilansowaniu [kWh]**, status `licznik`. Niedozwolone liczby, statusy, jednostki, duplikaty, nieistniejące godziny i sprzeczne strefy są odrzucane. Pojedynczy rekord powtórzonej godziny nie dowodzi pełnych 2 h; obu foldów i ich RCE nie odgadujemy.
- Wybór plików daje tylko podgląd. **„Zapisz CSV i używaj automatycznie tylko w PV”** zapisuje osobne części + manifest i włącza auto. Nie importuje do Depozytu/Magazynu ani nie zmienia salda. Ponowny zapis tego samego zestawu nie dubluje energii.
- Manifest CSV i wybór źródła są dwoma zapisami. Błąd drugiego zapisu jest widoczny; nie udajemy atomowości dwóch kluczy. Części zapisują się przed manifestem; awaria nie aktywuje połowy zestawu. G13 i RCE nadal pochodzą z kopii wspólnych cen. Brak strefy/ceny nie staje się 0 zł.
- Reset nadal wymaga dwóch kliknięć i usuwa tylko obie historie i ustawienia PV. **Aktualizacja 0.3.7 nie wymaga resetu.**

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

**Procedura użytkownika na PC: Git + PowerShell, bez Node/npm i lokalnych testów.** Instalator sprawdza hashe paczki, dokładny commit bazy 0.3.6 i czystość repo. DryRun poprzedza zastosowanie. Wysłanie gałęzi wymaga osobnego wpisania `TAK`; PR/scalenie i HA są osobnymi czynnościami użytkownika. Nie trzeba wklejać wyników do rozmowy. Nie uruchamiać instalatora w terminalu dodatku HA.

Dla utrzymujących kod, w osobnym środowisku deweloperskim: w `app/` `npm ci`, potem `npm test`; `G13_TEST_CSV` wskazuje prywatny eksport tylko na czas testu. Brak realnego pliku jest jawnie oznaczany jako pominięcie, nie zaliczony test. Zależności pozostają bez zmiany.

- 303 dotychczasowe testy + istniejący przebieg walidatora na realnym eksporcie;
- 41 testów modelu, w tym losowe bilanse i zerowy przyrost;
- 39 danych/czasu/zapisu oraz 31 parsera CSV/jednostek/izolacji;
- 31 automatycznego wyboru źródeł, migracji, DST, konfliktów i składników ujemnego H;
- 27 prawdziwej ścieżki Express → WebSocket → emulator recorder, obejmujących współczesne `statistics_unit_of_measurement`, stare pole, różne jednostki wyświetlania, sprzeczności/null/obcą klasę i błędy. Bez podmiany funkcji pobierającej;
- 55 testów DOM, w tym migracja 0.3.6 bez ponownego importu, odczyt nowego importu z głównej karty, pełna tabela ujemnych godzin, restart, błędy i brak zapisów do cudzych kluczy;
- 20 A/V i własnych sprawności oraz 13 HTTP/zasobów/KV;
- **łącznie 560 nazwanych testów**, w akceptacji środowiska przygotowania 0 błędów / 0 pominięć. Testy nie oznaczają odczytu rzeczywistego HA lub walidacji elektrycznej;
- audyt mutacji 0.3.7 wykrył **36/36** celowo wprowadzonych błędów wyłącznie w kopiach tymczasowych: 22 dotychczasowe reguły (dostosowane do nowego kodu) i 14 nowych kontraktów metadanych, wyboru źródeł, migracji i tabeli H.

Wektory testowe `sensor.test_*` są sztuczne, a prywatnych eksportów nie ma w payloadzie. Pomyślny test joinu czy bilansu arytmetycznego nie usuwa niespójnych pomiarów, nie dobiera sprzętu i nie daje prognozy oszczędności.

## Historia wydania 0.3.5 — nie instrukcja wdrażania tej kopii roboczej

Poniższe kroki opisują poprzednie wydanie. Zostało już zastosowane na PC, opublikowane i scalone przez PR #15. Nie należy go ponownie instalować ani używać jego buildera do tej zmienionej kopii. Nowsze wydania mają osobne buildery/manifesty/instalatory; bieżąca procedura 0.3.7 jest opisana wyżej. Wykonanie na PC, publikacja i wdrożenie pozostają oddzielnymi etapami.


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
