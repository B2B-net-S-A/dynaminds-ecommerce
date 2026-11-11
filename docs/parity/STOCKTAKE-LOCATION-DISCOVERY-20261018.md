# Inwentaryzacja i blokada lokalizacji — odkrycie zakresu

Status: **SOURCE DISCOVERY; DOM-GAP-003 nadal OPEN**. Dotyczy wymagania
`DOM-WMS-014`. Nie zmieniono zamrożonych scope.v1/v2/v3 ani inputv2.

## Ustalona semantyka publicznego źródła

[Oficjalny artykuł Base o inwentaryzacji](https://base.com/pl-PL/pomoc/wiedza/inwentaryzacje/)
odczytano 18.10.2026 o 19:33 UTC, HTTP 200. Rozróżnia on dwa zachowania:

- Ręczna blokada konkretnej lokalizacji WMS wyłącza ją z przydziału pickera;
  dostępna inna lokalizacja tego samego produktu umożliwia dalszą kompletację.
- Samo liczenie nie ustanawia automatycznego zatrzymania ruchu ani sprzedaży.
  Podczas liczenia w panelu operator powinien kontrolować ruch i odświeżać
  porównanie stanów.

To dwa osobne kontrakty, a nie wzajemnie wykluczające się tryby. Publiczny tekst
nie dowodzi automatycznego zakładania blokady przez samo otwarcie WMS App.
Zachowanie zadania przypisanego przed ręczną blokadą wymaga odrębnego,
jednoznacznego ustalenia.

## Granica dat i zamrożonego zakresu

W [przypiętym wejściu domen z 17.10](scope-inputs/v2/domains.json) istnieje już
`DOM-WMS-014`: ręczna blokada liczonej lokalizacji respektowana w pickingu.
Źródło `BASE-count` zachowuje metadane obserwacji i opis konfliktu, lecz nie
pełne archiwum ówczesnego artykułu.

Nowy pełny HTTP response i fragmenty są dowodem odczytu **18.10**, nie pełnego
stanu strony 17.10. Dopiero review Roota i osobne nowe wejście mogą formalnie
przypisać doprecyzowanie do matrycy. Do tego czasu `DOM-GAP-003` pozostaje
otwarty; stan partial całej matrycy i pozostałe luki nie zmieniają się.

## Rzeczywista luka produktu do wykonania

Przejrzana normalna ścieżka ilościowa ma listę lokalizacji, przesunięcia i
pomiary, ale nie ma komendy trwałej blokady/zwolnienia lokalizacji:
[UI](../../web/stock-locations.tsx), [API](../../server/stock-location-routes.ts).
`binStock()`/`reserveLocations()` wybierają dostępne biny bez predykatu takiej
blokady, a `scanLocation()` sprawdza rezerwację i liczbę skanów:
[serwis](../../server/stock-locations.ts), rzeczywiste wywołania w
[procesie zamówienia](../../server/domain.ts).

To ustalenie dotyczy przejrzanych aktywnych ścieżek, nie dowolnego symbolu lub
hipotetycznej nieobecności kodu w całym repozytorium. Obecny spis już wykrywa
ruch po pomiarze i odmawia rozliczenia starej podstawy
([serwis spisu](../../server/stocktakes.ts));
[UI WMS](../../web/wms-stocktakes.tsx) również uprzedza o możliwym równoległym ruchu.

Kolejny krok produktu: jawna trwała blokada tenant/magazyn/lokalizacja,
widoczna w zwykłym UI/API i respektowana przez rzeczywiste przydziały.
Odbiór powinien wykazać wybór alternatywnego binu, atomową odmowę bez
alternatywy, zwolnienie, zachowanie po restarcie, aktualne uprawnienia i brak
wpływu na cudze firmy. Sposób obsługi wcześniejszych zadań musi być jawny.
Wymaga to zwykłej autoryzowanej ścieżki migracji i kontroli runtime.

[Poprawka pozostałej rezerwacji](STOCK-LOCATION-RESERVATION-LOCAL-20261018.md)
naprawia odrębny błąd ilości po częściowej wysyłce. Nie zamyka funkcji ręcznej
blokady ani nie nadaje odbioru inwentaryzacji lub WMS App.

## Zachowane dowody

Katalog prywatny:
`/Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/dom-gap003-stocktake-discovery-20261018-01`.

- [Pełny publiczny HTML](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/dom-gap003-stocktake-discovery-20261018-01/inwentaryzacje-20261018.html>):
  323661 B, SHA256 `3d00cde4136bbc4192db47db90a9a1a28905017117541287135268da613faaec`.
- [URL, data, status i nagłówki](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/dom-gap003-stocktake-discovery-20261018-01/source-receipt.private.json>):
  925 B, SHA256 `41f03e2505974419d40cce32c5ebe214369f5e05a7a5d739780fd445fba7190d`.
- [Stabilne fragmenty](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/dom-gap003-stocktake-discovery-20261018-01/excerpts.private.json>):
  2617 B, SHA256 `d59d9359402bd6a8ff805d1939a671bb4fdcc3537de4a29ddc273703ddbb30aa`.
- [Przegląd 17 źródeł i propozycja odbioru](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/dom-gap003-stocktake-discovery-20261018-01/source-review.private.json>):
  8694 B, SHA256 `376b2c385fabeea95fe0c98322402e1357b212ae725f0f7f79533213b159632a`.

Przegląd kodu był SOURCE ONLY: bez SQL, konta Base i odbioru jego panelu.
Nie przyznaje implementacji, sandboxa, konta dostawcy ani pełnego Goala.
