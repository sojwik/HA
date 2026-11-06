'use strict';
/* ---------------------------------------------------------------------------
 * Lokalizator pliku testowego z realnym eksportem HA.
 *
 * Eksport NIE jest częścią repozytorium — zawiera prywatny profil zużycia
 * energii i godzinowe sumy liczników właściciela instalacji. Trzymanie go
 * w publicznym repo byłoby wyciekiem danych, więc testy na realnych danych
 * są OPCJONALNE i uruchamiają się tylko, gdy plik jest dostępny lokalnie.
 *
 * Kolejność szukania:
 *   1. zmienna środowiskowa G13_TEST_CSV
 *   2. tests/fixtures/bilans_growatt.csv   (w .gitignore)
 *   3. /home/user/uploads/bilans_growatt.csv  (środowisko audytu)
 *
 * Gdy pliku nie ma, testy NIE udają, że przeszły — wypisują wyraźny komunikat
 * o pominięciu i zwracają kod 0 dla części jednostkowych.
 * -------------------------------------------------------------------------*/
const fs = require('fs');
const path = require('path');

function findCsv() {
  // Jawna wskazówka użytkownika jest wiążąca: jeśli podał ścieżkę, a pliku nie
  // ma, to błąd konfiguracji, nie powód do cichego powrotu do innego pliku.
  if (process.env.G13_TEST_CSV) {
    const p = process.env.G13_TEST_CSV;
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch (e) { /* poniżej rzucamy czytelny błąd */ }
    console.error('\n[BŁĄD] G13_TEST_CSV wskazuje na nieistniejący plik:\n  ' + p);
    console.error('Popraw ścieżkę albo usuń zmienną, żeby pominąć testy na realnych danych.\n');
    process.exit(2);
  }
  const candidates = [
    path.join(__dirname, 'fixtures', 'bilans_growatt.csv'),
    '/home/user/uploads/bilans_growatt.csv',
  ];
  for (const p of candidates) {
    try { if (fs.statSync(p).isFile()) return p; } catch (e) { /* brak — próbuj dalej */ }
  }
  return null;
}

const CSV = findCsv();

function skipBanner(suite) {
  console.log('##G13-SKIP## ' + suite);
  console.log('\n' + '!'.repeat(70));
  console.log('  POMINIĘTO: ' + suite);
  console.log('  Brak pliku z realnym eksportem HA — te testy NIE zostały wykonane.');
  console.log('  To NIE jest wynik pozytywny. Poprawki na realnych danych pozostają');
  console.log('  niezweryfikowane w tym uruchomieniu.');
  console.log('');
  console.log('  Żeby je uruchomić, wskaż plik:');
  console.log('    G13_TEST_CSV=/sciezka/bilans_growatt.csv npm test');
  console.log('  albo umieść go w tests/fixtures/bilans_growatt.csv');
  console.log('!'.repeat(70));
}

module.exports = { CSV, skipBanner };
