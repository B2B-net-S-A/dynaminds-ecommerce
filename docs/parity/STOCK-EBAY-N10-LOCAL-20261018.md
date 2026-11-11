# N10 — izolacja lokalizacji i odczyt limitów aplikacji eBay

Status: **N10 działa lokalnie; zachowanie danych i zwykły UI lokalizacji PASS**.
Odczyt limitów eBay ma odbiór kodu i kontrolowane testy, bez wywołania dostawcy
lub odbioru jego konta. Pełny Goal pozostaje aktywny.

## Zmiana produktu

`StockLocations` wiąże strony, historię, wybór i zapis z konkretnym magazynem
i filtrem. Spóźniona strona poprzedniego filtra nie dopisuje obcych wierszy.
Historia poprzedniej lokalizacji nie zastępuje obecnej; zapis używa magazynu,
wersji i client_key pierwotnego wyboru. ACK starego zapisu nie zamyka nowego
wyboru. Dochodzą retry odczytów i blokada podwójnej paginacji, także po A→B→A.
Komponent nie rozpoczyna pracy po unmount i respektuje bieżące uprawnienia.

Nowy jawny endpoint `POST /api/integrations/:id/ebay/provider-quota/read`
pobiera limity aplikacji przez Developer Analytics, osobno od lokalnych
lease/cooldown. Używa tokenu aplikacji client_credentials i podstawowego scope;
nie zastępuje tokenu sprzedawcy. Przed żądaniami i wydaniem wyniku sprawdza
sesję przeglądarkową, aktualną rolę, tenant i niezmienione połączenie.
Brak autopollingu i retry; odpowiedź jest ograniczona do1MiB/2000 wierszy.
204 lub pusty wynik oznacza brak danych. Lokalny przykład nie może potwierdzić
limitów dostawcy. POST podlega istniejącej blokadzie restore-preview.
Kontrakt: [oficjalny OpenAPI eBay v1_beta.0.1](https://developer.ebay.com/api-docs/master/developer/analytics/openapi/3/developer_analytics_v1_beta_oas3.json).

## Testy i wydanie

Commity lokalne: `094f20b` lokalizacje, `3b30a5a9dfce9230fac588798b1c5d7983f3aa54`
eBay. Root:21/21 testów PASS,0 SKIP,2104,07625ms; typecheck EXIT0. Testy obejmują
rzeczywiste komponenty React z opóźnionymi odpowiedziami oraz adapter, serwis
i zarejestrowany handler pod kontrolowanymi portami. Nie zastępują PostgreSQL,
rzeczywistego grantu eBay ani zwykłego panelu połączonego z kontem.
Pierwszy typecheck wykrył dwa problemy typów; jawny null guard i istniejący
createRequire dla testowego JSDOM usunęły je bez instalowania zależności.

Normalny build z izolowanego commita przeszedł stage/Vite/check/emit, każdy EXIT0.
1283 pliki źródeł,745 backendowych,339 frontendowych; pięć zmienionych istniejących
źródeł i jeden nowy moduł. Pakiet383 pliki/100283900B zachowuje limit16MiB/member
i96MiB całości. Wszystkie240 pozycji poza frontendem i emitted-runtime są w całości
identyczne z N09. Kontrakty native/adapter/resource/migration są w całości zgodne;
brak nowych migracji lub aktywacji210. Emisję sprawdzono właściwym walidatorem
emitted package i pełnymi hashami/rosterem, bez instalacji lub kopii node_modules.

Manifest i działająca rewizja:
`07c760b0ce354c23cbdc4be28cb294e93f105b8a3bece42f92f33da6d2bfe4c9`.
Root20882: build EXIT0. Root98130: poprzednie N09 łagodnie zamknięte EXIT0.
Root51527: nowy zwykły stack READY, app PID93010, health200, schema211.
Workery i scoped automation pozostają wyłączone; ich odbiór nie został rozszerzony.

## Dane, API i Chrome

Świeży odczyt627 tabel przed normalną aktualizacją i po niej potwierdził zgodność
626 tabel biznesowych. Zmienił się tylko release_sha256 w ordinary182, generacja
i validated_generation1744 bez zmiany, dirty=false. Oba odczyty były READ ONLY
z8s/9s, ROLLBACK/end potwierdzone. Nie kopiowano klucza konfiguracji lub bazy.

Root61502:11 GET,0 POST/SQL/dostawcy, EXIT0. Pełne DTO biznesowe oraz stare RMA
zgodne z przypiętym wcześniejszym punktem. Nie tworzono nowych danych lub sesji.

Chrome4 na istniejącej sesji własnej firmy potwierdził:

- Magazyny: ten sam PARTIAL SKU, stan8/rezerwacja1/dostępne7; szczegóły i historia.
- Filtr bez wyników zamyka wybór; powrót pokazuje prawidłowy wiersz.
- Zmiana magazynu i powrót zachowują właściwy zakres.
- Zamówienie DE-20261018-9D8B40A1 nadal pokazuje skany3/3 i zarezerwowane1szt.

Sztuczne opóźnienia i podwójne kliknięcia sprawdzono w kontrolowanych testach,
nie w zwykłym Chrome. Firma ma zero połączeń: nie utworzono demonstracyjnego
kanału lub poświadczeń, więc zwykły panel quota nie został tu odebrany.
Nie wykonano zewnętrznego OAuth, odczytu limitów konta ani płatności.
Końcowy świeży odczyt po UI potwierdził **wszystkie627 tabel bez zmian** względem
stanu po aktualizacji, z ROLLBACK/end. Brak nowych zapisów biznesowych.

## Dowody

Katalog wydania:
`local-builds/full-base-preview-20261017/stock-ebay-app-release-prepared-agent-20261018-10`.
Root package review3219B/SHA256
`2915096c4118d6cff863ea42816a0bc8aa60038524d290fabf4aa3ed3c1e1656`.

Katalog startu i odbioru:
`local-builds/full-base-preview-20261017/stock-ebay-original-app-n10-prepared-agent01`.

| Artefakt | SHA256 |
|---|---|
| data-before-root.private.json |649aca79b5f6c8cbbee884030d555e8513e539bfe16a972afc2403b4f81e60e0|
| data-after-root.private.json |e17ddc03c50d5fe24ed7d2e753131c62bd17365abdd958ccdf5f6e06b74bb73a|
| ready-root.private.json |6ff52d31bacdb8d7d6fa7d6a2ddc5f06579a427d8bb0a4a31524e2f67ce8e25f|
| read-api01/result.private.json |dd83dff228febd10f5080e557957bfe3d2ff7852563d8b4b873232d9c85cac0c|
| data-after-ui-root.private.json |422b544209855470bba6d2806bbd497830b3953b5a7d7df1d5dc11388e60223d|
| final-runtime-summary.private.json |a24b3e0b277dad89d9ad42095410ac9b997c7257ab580743bf35960b196e861d|

Screenshoty ui-stock-root.png i ui-order-root.png oraz teksty AX są przypięte
w końcowym summary. Ten odbiór nie zamyka split210, WMS ON, pełnych integracji,
crash recovery, godzinnego profilu skali ani żadnego pełnego kryterium Goala.
