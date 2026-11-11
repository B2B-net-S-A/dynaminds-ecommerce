# Split210 — odrzucony financial composite (18.10.2026)

Status: **KNOWN_MVCC_RISK_DO_NOT_PROMOTE**. Kandydat pozostaje nieprzyjętym badaniem źródeł. Nie podłączono go do generatora, pakietu, aplikacji ani publicznych funkcji PostgreSQL. Dwa nowe, wcześniej nieśledzone pliki usunięto z drzewa produktu dopiero po prywatnej archiwizacji i potwierdzeniu pełnej zgodności bajtów. Brak importów lub innych odwołań do kandydata w pozostałym kodzie potwierdzono przed dodaniem tego dokumentu.

## Przyczyna odrzucenia

Pomysł zastępował dwa wywołania `partial_sale204_predecessor_definition` odczytem rodzin definicji w `ordinary181_financial_valid`. Zachowywał źródłowe guardy, pełne 24 pola deskryptora rodzica, listy zależności i oryginalną gałąź odmowy. To nie zapewnia jednak tej samej widoczności zmian: zewnętrzna funkcja jest `STABLE`, a oryginalny rodzic `VOLATILE`.

Dokumentacja PostgreSQL18 wskazuje, że `STABLE` korzysta ze snapshotu zapytania wywołującego, natomiast `VOLATILE` pobiera świeży snapshot dla kolejnych wykonywanych zapytań. Standardowe języki proceduralne również ustawiają tryb SPI zależnie od tej klasyfikacji. Zobacz [Function Volatility Categories](https://www.postgresql.org/docs/18/xfunc-volatility.html) oraz [Visibility of Data Changes](https://www.postgresql.org/docs/18/spi-visibility.html).

Źródłowy scenariusz ryzyka: po utworzeniu snapshotu zewnętrznego zapytania i przejściu istniejącego guarda druga sesja zatwierdza `ALTER FUNCTION ... COST` dla fingerprintu. Oryginalny rodzic może zobaczyć zmianę w późniejszym SPI i odmówić, podczas gdy proponowany `CASE` nadal odczytuje stary deskryptor i rodzinę. Jest to analiza osiągalnego okna różnicy, **nie wykonany dwusesyjny kontrprzykład całej funkcji**. Nie zmieniano atrybutów volatility, aby ominąć problem. Promocja wymagałaby zamknięcia tej granicy architektonicznej i osobnego dowodu równoważności.

## Granice dowodów

Osiem wcześniejszych testów czystych źródeł przeszło bez pominięć: sprawdzały skończoną transformację, zachowanie oryginalnych gałęzi i pełny inverse ciała/definicji. Końcowa zmiana dodała wyłącznie ostrzeżenia w komentarzach; przywrócenie poprzednich komentarzy odtwarza całe wcześniejsze pliki bajtowo. Nie powtarzano testów po tej zmianie. Te wyniki nie dowodzą równoważności runtime/MVCC, poprawy wydajności, odbioru Native ani procesu biznesowego.

Nie powstał caller, spec ani preview D35. Nie wykonano SQL D35, testów dwóch sesji ani pomiarów tego kandydata. Nie nadaje on Source32, nie naprawia nieudanego odbioru C33 i nie zamyka biznesowego splitu. [Wynik C33](SPLIT210-C33-LOCAL-20261018.md) zachowuje własne granice.

## Archiwum lokalne

Katalog prywatny `local-builds/full-base-preview-20261017/order-split210-financial-composite-rejected-research-20261018-01` ma uprawnienia `0700`; oba pliki i manifest mają `0600`. Ścieżki liczone od katalogu głównego DYNAMINDS Ecommerce, poza repozytorium `development/full-base`.

| Plik archiwum | Bajty | SHA-256 |
| --- | ---: | --- |
| `order-split210-financial-composite.mjs` | 13346 | `3f7f1661ad62169feced2ad5657f89551fdc4399dd9b6bbb12b25bca72a1227b` |
| `order-split210-financial-composite.test.mjs` | 791271 | `633b021352c8b524f05158d73a6a5d55cd990fef07c0c258ab2eacb78841f855` |
| `archive-manifest.private.json` | 1590 | `6fd982f347ee509ab14b0d673754c9244a07af78a85f90f109c09bd7773f102f` |

Archiwum utworzono z wyłącznym tworzeniem nowych plików (`EXCL`) i zweryfikowano całe bajty przed usunięciem dokładnie dwóch własnych plików. Istniejące źródła produktu, dane i wcześniejsze WIP pozostają poza zakresem tej operacji.
