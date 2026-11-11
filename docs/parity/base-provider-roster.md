# Base — katalog dostawców i usług

Stan źródeł katalogu: **2026-10-17**; uzupełnienie mapowania registry: **2026-10-18**. Rozszerzenie addytywne zachowuje wszystkie **65 wcześniejszych wpisów i identyfikatorów**. Pełne wydobycie uchwyconego HTML daje **2056 wystąpień kart, 2053 różne ID i 2013 URL-i** w 11 kategoriach. Osobny publiczny autocomplete zwraca 2052 rekordy. Nie oznacza to odbioru integracji ani zamknięcia pełnej matrycy Base.

Źródła: [katalog pl-PL](https://base.com/pl-PL/integracje/), [publiczny skrypt katalogu](https://base.com/assets/dist/scripts-integrations-list-sp000470.js), [publiczna lista par](https://base.com/ajax/getFullList.php), [ranking według locale](https://base.com/data/top10_integrations.json). Odczyty wyłącznie GET, bez logowania i operacji biznesowych. Archiwum HTML i skryptu jest lokalnie, skompresowane; JSON zawiera SHA256, rozmiary, ścieżki i oryginalne metadane wcześniejszego przeglądu.

## Wynik wydobycia

| Kategoria HTML | Wystąpienia kart |
|---|---:|
| marketplace | 427 |
| shop | 91 |
| courier | 386 |
| erp_accounting | 154 |
| sms | 16 |
| other | 51 |
| warehouse | 836 |
| pim | 5 |
| wms | 18 |
| fulfillment | 69 |
| comingsoon | 3 |

Roster ma **2060 wpisów**: 65 wcześniejszych plus 1995 nowych. 61 kart powiązano z wcześniejszym wpisem jedynie przy jednoznacznym URL; wszystkie 2056 wystąpień zachowano w `catalog_cards`. Pole `entries` zachowuje wcześniejsze aliasy i znaczenie ID. Pozostałych kart nie scalano według wspólnego URL. Powtarzające się ID: `centauro2, meta, tallysolutions` — zachowano ich osobne wystąpienia i kategorie.

JS pokazuje lokalne odkrywanie ukrytych kart przez usunięcie `d-none` i filtrowanie istniejącego DOM według `data-countries`/`data-categories`. Publiczny `getFullList.php` służy osobnemu autocomplete par integracji. To źródło marketingowej nawigacji, nie endpoint integracji biznesowej.

## Różnice źródeł

- ID HTML nieobecne w autocomplete: `base-bridge, centauro2, meta, tallysolutions`.
- Kody autocomplete nieobecne w HTML: `aliexpress, aliexpress_shipping, aliexpressshippingbr`.
- Te różnice pozostają otwarte do wyjaśnienia. Nie dowodzą braku dostawcy ani pełnego pokrycia jego wariantów.
- Liczby marketingowe z 7 wcześniejszych stron kategorii pozostają historycznymi obserwacjami w `pages`; nie są mianownikiem parytetu.

## Granice odbioru

`inventory_complete`, `coverage_complete` i `summary.full_base_roster_complete` pozostają **false**. Wyczerpano wystąpienia w jednym uchwyconym pl-PL HTML; nie potwierdzono wszystkich wariantów regionalnych, kont, planów i partnerów ani obsługiwanych operacji API. Puste kraje i `all` to surowe atrybuty źródła, bez deklaracji globalnej dostępności. Kategorie comingsoon i usługi Base wymagają osobnej klasyfikacji.

Nie przyznano PASS implementacji, kontraktu lokalnego, UI, sandboxu ani konta dostawcy. Zachowano 14 wcześniejszych rekordów mapowania registry; dodano jeden opisany poniżej link rodzinny Mirakl, więc tabela obejmuje 15 providerów. Nadal tylko 12 mapowań ma historyczny status odwiedzonej strony szczegółowej Base. DeepL i ogólne SMTP pozostają jawnie niepotwierdzone jako osobne pozycje Base. FBA/InPost Fulfillment nie przejmują odbioru adapterów rodzinnych. Uzupełnienie nie zmienia żadnego wiersza ani poziomu dowodu bieżącego inwentarza 324 operacji.

## Uzupełnienie Mirakl — 18.10.2026

Istniejąca karta nr 241, `base.catalog.marketplace.mirakl`, ma dokładne ID `mirakl`, nazwę Mirakl, tag `Mirakl` i URL `https://base.com/pl-PL/integracje/mirakl/` w uchwyconym katalogu. Powiązano ją z istniejącym `registry.id=mirakl` (Mirakl Seller) oraz jego 11 już istniejącymi wierszami w `integrations.json`. To link rodziny technologicznej, a nie twierdzenie o pełnej równoważności funkcji Base i adaptera Seller API.

`registry_mapping_supplements` zawiera datowanie, SHA256 i rozmiary zachowanego wejścia ScopeV2, bieżącego registry, modułów `mirakl`/`mirakl-channel`/`mirakl-read-routes`, rejestracji w `app.ts` oraz inwentarza operacji. Zwykły `connector()` celowo odmawia Mirakl bez autoryzowanego channel readera i trwałego repozytorium limitów; link nie obchodzi tej granicy. Użyto zapisanych źródeł bez nowych żądań sieciowych.

Nie zmieniono żadnej z pozostałych 2059 pozycji ani 2056 kart, wcześniejszych 14 rekordów mapowania, zamrożonego `scope.v2.json` i jego wejść. Nie dodano providerów ani operacji. Nie zmieniono statusów `operations_discovery`, dostępności regionów ani odbioru kont. Pozostałe 1994 nowe pozycje nadal nie mają linku do registry; osobno nadal otwarte jest rozpisanie operacji wszystkich 2060 pozycji. 182 karty z tagiem `mirakl` zachowują osobne ID i dotychczasowe statusy — nie dziedziczą tego linku ani odbioru adaptera.

## Następne kroki

1. Wyjaśnić różnice HTML/autocomplete i klasyfikację regionów, wariantów oraz partnerów.
2. Odkryć oficjalne publiczne API, wersje, auth/scopes, limity i webhooki albo jawnie oznaczyć source_missing/partner_only.
3. Rozpisać operacje, istniejące callsites i testy UI/API; odrębnie dowieść kontraktu lokalnego, sandboxu i konta.
4. Przy mutacjach potwierdzić odczyt skutku po timeout/ACK-loss bez automatycznego replay niepewnego żądania.

Maszynowy katalog nazw, wszystkich kart, surowych atrybutów, URL-i i źródeł: [base-provider-roster.json](base-provider-roster.json).
