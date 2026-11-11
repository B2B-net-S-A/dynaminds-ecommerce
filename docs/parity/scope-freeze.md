# Wersjonowanie zakresu parytety — plan włączenia rosteru

Stan: 2026-10-17. Plan plikowej walidacji, bez zmiany Goal ani obecnego checkera. Roster65 wpisów jest częściowym odkryciem; nie zamyka zakresu Base. Nie utworzono nowego manifestu autoryzującego kompletność.

## Minimalne powiązanie

1. Root utrwala mały wersjonowany manifest zakresu, np. `scope.v1.json`: identyfikator Goal/etapu, datę, parent SHA (null wyłącznie pierwsza wersja), SHA/bajty rosteru oraz domains/integrations, posortowane wymagane ID i jawną politykę poziomów dowodu. Osobno lista65 ID rosteru,313 ID operacji obecnych14 dostawców i ID otwartych luk odkrywania. To punkt wejścia kontrolowanego zakresu, nie dowód pełności katalogu.
2. Istniejący `tools/parity/check.mjs` otrzymuje jedynie odczyt rosteru/manifestu i kontrolę powiązań. Nie wykonuje adapterów, HTTP, kont ani testów biznesowych. Sprawdza unikalne stabilne ID, poprawny pierwotny URL Base i datę, kategorie, relacje do14 registry oraz zgodność z przypiętymi wersjami plików.
3. Wymagany zbiór ID pochodzi z przypiętego manifestu, nie z bieżącej długości macierzy. Brak choćby jednego required ID oznacza odmowę. Nieznane nowe ID wymagają addytywnego successor manifestu i przeglądu zakresu. Nie wolno podnosić gotowości przez skasowanie wiersza, kategorii, pustego dowodu lub coverage_gap.
4. Nowe znalezione nazwy, regiony i warianty powiększają zakres w kolejnej wersji z zachowaniem rodzica. Zmiana nazwy zachowuje ID i alias. Duplikat otrzymuje jawne `superseded_by` z uzasadnieniem, lecz stary wymagany ID pozostaje rozliczony w historii; jego usunięcie z wymagań wymaga jawnej decyzji Root/użytkownika, a nie automatycznej deduplikacji. Zmiana API/regionu nie dziedziczy dowodu niezgodnej operacji.

## Trzy niezależne wyniki

- **Discovery:** roster i wszystkie kategorie/filtry/paginacje rozpoznane. Obecnie false: główny katalog jest dynamiczny,7 stron kategorii podaje popularne przykłady, a DeepL/SMTP nie uzyskały odpowiednika w ograniczonym przeglądzie. Niezerowe otwarte gaps blokują deklarację pełnego rosteru.
- **Kod i odbiór lokalny:** konkretne operacje mają publiczny kontrakt, callsite, pozytywy/negatywy, ACK-loss/readback oraz normalny UI/worker. Sam wpis w katalogu, kod źródłowy albo nazwa pliku testowego nie zamyka tego poziomu.
- **Sandbox i konto:** rzeczywiste autoryzowane wykonania są odrębnymi dowodami. Poziom wymagany do danego etapu wynika z jawnej polityki przyjętego Goal, nie z dowolnego `required_evidence_level` obniżonego w pojedynczym wierszu. Lokalny model nie dostaje statusu konta dostawcy.

Checker może wystawić wyłącznie `completion_review_candidate`, z `acceptance_granted_by_checker:false`. Nawet prawidłowe SHA dowodzi tożsamości artefaktu, nie poprawności jego biznesowego wniosku. Root nadal odbiera kompletny proces i zgodność z kryteriami użytkownika. Nie wolno nazwać pełnym klonem etapu zamykającego tylko lokalne kontrakty lub65 obecnie odkrytych wpisów.

## Najmniejsze kontrole przyszłej zmiany walidatora

Pozytyw: wszystkie wymagane ID i piny zgodne, wynik nadal częściowy przy otwartych gaps. Negatywy: usunięta jedna operacja; znikający dostawca/kategoria/luka; duplikat lub zmienione ID; drift SHA rosteru/manifestu; nieuzasadnione zastąpienie wymagania aliasem; obniżony poziom dowodu; inherited local dowód użyty jako account; sprzeczne inventory_complete/coverage_complete; nowy provider bez addytywnej wersji zakresu. Każdy przypadek ma odmówić kandydatury do zakończenia, a nie usuwać wymaganie z mianownika.

Nie zmieniono istniejących integrations.json, domains.json ani check.mjs. Ten dokument jest planem następnej małej zmiany Root, nie nową autoryzacją lub ukończeniem Goal.
