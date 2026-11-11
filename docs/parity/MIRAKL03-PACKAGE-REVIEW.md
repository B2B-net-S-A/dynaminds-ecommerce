# Niezależny przegląd pakietu Mirakl 03

Odczyt lokalnych plików po zbudowaniu pakietu; bez uruchamiania aplikacji, bazy, workerów lub API dostawcy. Nie zmieniano źródeł ani pakietu.

Pakiet: `local-builds/full-base-development-03`.
Manifest SHA-256: `228a7aa9ac2e0d1c7a8b24fceceadba484cc5e36f4c98830c30687d7fb87fe2c` (328007 B).
Source contract: `7573420249f9122133977da38c357ef88a2db754678afa53ff2106bf53dc1f25`.

## Wynik

- Wszystkie 374 pliki manifestu, łącznie 99029345 B, zgadzają się z rzeczywistymi SHA-256 i rozmiarami. Dokładny zbiór katalogu to te pliki oraz release.json; brak dodatkowych plików, braków i symlinków.
- 701 z 702 przypiętych emitted_sources zgadza się z aktualnym DEV. Jedyny oczekiwany drift to `shared/large-import-dependencies/pim-large-import173-business-traversal-ui/profile-startup.mjs`: pakiet 03 przypina `5cfe1672725a6764fdf8d7135927617c2db026f2ba7facd09b8ccd8acc0fd6e8`, a późniejsza poprawka przygotowywana dla 04 ma `2e82e985a85b20b1367c7ae1180b9f4b3a2b5f811f173f794574a7806bd26191`. Nie modyfikowano 03 w celu ukrycia tej różnicy.
- Źródła Mirakl client/channel/read-postgres/read-routes/session-authority oraz app, db, imports, import-routes, domain, channel-access, ordinary-local-cli i ordinary-local-runtime są obecne w przypiętym grafie i zgodne z DEV.
- Kopia source-release-manifest.json ma oczekiwany hash successor. native_contract i adapter_contract są literalnie zgodne z successor; wcześniejszy niezależny przegląd successor potwierdził 23 niezmienione pliki runtime oraz dokładnie dwa nowe piny app/runtime.
- Source206 nie występuje w files, emitted_sources ani 202 deklaracjach resource_contract. Brak referencji 206_return/return_credit206 w aktualnych db.ts, app.ts i resource-definitions.mjs. Nie zostało dołączone do migracji.
- Wszystkie sześć plików static_contract jest bajt w bajt zgodne z DEV/dist. Główny bundle zawiera interfejs Mirakl, pola instance_url/shop_id i właściwy endpoint orders-stage. Endpointy preview są składane dynamicznie zgodnie ze źródłem.

## Granice i pozostałe odbiory

emitted_sources opisuje graf backendowego bundlera, nie wszystkie źródła Vite. Obejmuje tylko trzy współdzielone pliki web/pim. Tożsamość frontendu potwierdzono przez sześć przypiętych artefaktów dist; odbiór zwykłej obsługi UI wymaga Chrome na uruchomionym wydaniu.

Manifest jawnie zachowuje istniejący brak `output/pdf/odoo-demo.pdf`. Jest to brak demonstracyjnego zasobu Odoo, a nie wykryta regresja Mirakl; nie należy deklarować kompletności wszystkich zasobów runtime na podstawie samego tego przeglądu.

Nie sprawdzano cold startup, działania transakcji, rzeczywistego zapisu OMS, sesji w bazie, transportu ani konta Mirakl. Wynik dotyczy kompletności i tożsamości wyemitowanych artefaktów; nie jest odbiorem całego Goala.

Dowody narzędzi: końcowe wyniki poleceń `f0e37e`, `8e0633`, `196d7d` (EXIT 0). Polecenie sprawdzające brak referencji Source206 zwróciło brak dopasowań rg (EXIT 1, oczekiwany wynik braku referencji).
