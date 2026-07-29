# G13 Depozyt — dodatek Home Assistant

## Co się zmieniło 

1. **Trwałość danych.** `window.storage` (działał tylko w artefakcie Claude.ai)
   zastąpiony plikiem `/data/kv-store.json`, persystowanym przez Supervisor
   między restartami i aktualizacjami dodatku. `saveState()`/`loadState()` w
   aplikacji są **niezmienione** — działają przez podmieniony `window.storage`
   (ten sam kontrakt `get/set/delete/list`), więc reszta logiku ich w ogóle
   nie widzi różnicy.

2. **Growatt — automatycznie.** Te same 6 encji `growatt_*`, które wcześniej
   eksportowałeś ręcznie przez `import_statistics.export_statistics` i wgrywałeś
   jako plik CSV, backend dodatku pobiera teraz bezpośrednio z długoterminowych
   statystyk Home Assistant (WebSocket API), formatuje jako CSV w dokładnie tym
   samym kształcie kolumn i przepuszcza przez **niezmienioną** funkcję
   `handleHaStatsFiles()`. Synchronizacja odpala się przy każdym otwarciu
   panelu i cyklicznie w tle (domyślnie co 60 min). Ręczny import CSV zostaje
   jako przycisk rezerwowy w tej samej sekcji.

3. **eLicznik i RCE — bez żadnych zmian.** eLicznik nadal wymaga ręcznego pliku
   (granulacja/strefy z Twojej integracji `polish_energy_meter` nie zostały
   jeszcze zweryfikowane, więc nie zgadywałem). RCE nadal pobiera się
   automatycznie z API PSE bezpośrednio z przeglądarki, dokładnie jak wcześniej
   — to już działało, nie było powodu tego ruszać.

4. **Silnik liczący (FIFO depozytu, ROI, strefy, magazyn) — bez żadnych zmian,**
   łącznie z Twoimi 123 testami, które go pokrywają. Celowo nie było
   odtwarzane z samej dokumentacji.

## Instalacja

1. Skopiuj cały ten folder na hosta HA jako `/addons/local/g13_depozyt_calc`
   (Samba `\\homeassistant\addons\`, SSH, albo wtyczka File editor/Studio Code Server).
2. Ustawienia → Dodatki → Sklep z dodatkami → odśwież stronę (albo ⋮ → Sprawdź
   aktualizacje) — pojawi się sekcja „Lokalne dodatki” z „G13 Depozyt Prosumencki”.
3. Zainstaluj, w razie potrzeby dostosuj opcje (niżej), uruchom.
4. Dodatek pojawia się w bocznym pasku HA (Ingress) — ikona panelu słonecznego.

## Opcje konfiguracyjne (zakładka „Konfiguracja” dodatku)

| Opcja | Domyślnie | Znaczenie |
|---|---|---|
| `growatt_entities` | 6 encji z Twojej dokumentacji | Lista `entity_id` do synchronizacji. Zmień, jeśli realne nazwy w Twoim `growatt_modbus` (0xAHA) się różnią. |
| `history_months_back` | 24 | Ile miesięcy wstecz synchronizować przy każdym odświeżeniu. |
| `refresh_interval_minutes` | 60 | Jak często odświeżać automatycznie w tle, gdy panel jest otwarty. |

## Ważne ograniczenie architektoniczne

Silnik liczący działa **w przeglądarce**, tak jak wcześniej — to świadomy
wybór (patrz punkt 4 wyżej). Konsekwencja: automatyczna synchronizacja Growatt
faktycznie przelicza dane, gdy panel jest otwarty (przy wejściu + w tle co
`refresh_interval_minutes`), a nie 24/7 niezależnie od przeglądarki. Pełne
działanie serwerowe wymagałoby przeniesienia też silnika liczącego na
backend — osobny, większy krok, gdyby kiedyś był potrzebny.

## Na pierwsze uruchomienie — na co zwrócić uwagę w logu dodatku

(Ustawienia → Dodatki → G13 Depozyt Prosumencki → Log)

- **Nazwy encji.** Jeśli log/panel pokazuje 0 zsynchronizowanych godzin mimo
  że dane w HA istnieją, porównaj `growatt_entities` z realnymi `entity_id`
  w Developer Tools → States.
- **Typ statystyki `change`.** Backend prosi HA o gotowy przyrost godzinowy
  (`change`); jeśli Twoja wersja HA go nie zwraca, kod liczy deltę sam z
  różnicy kolejnych `sum` — powinno zadziałać automatycznie, ale warto to
  potwierdzić przy pierwszym uruchomieniu.
- **Błąd autoryzacji WS / brak dostępu do API.** Sprawdź, czy
  `homeassistant_api: true` zostało zaakceptowane — czasem wymaga restartu
  dodatku po pierwszej instalacji.

## Struktura

```
config.yaml           - manifest dodatku (Ingress, opcje, dostęp do API)
Dockerfile             - obraz Node.js, budowany lokalnie przez Supervisor
app/server.js          - serwer Express: KV, konfiguracja, endpoint Growatt
app/lib/kv.js           - magazyn klucz-wartość w /data (zamiennik window.storage)
app/lib/ha-ws.js         - klient WebSocket do Core API (statystyki długoterminowe)
app/lib/growatt-csv.js    - konwersja statystyk HA -> CSV (strefa Europe/Warsaw)
app/public/index.html      - Twoja aplikacja + shim window.storage + auto-sync Growatt
```
