# Scenariusz pokazu DYNAMINDS Ecommerce dla klienta (demo lokalne)

Instancja na Renderze ma kilka różnic (brak sklepu Woo, daty raportów, działająca walidacja XSD).

Czas: 25–30 minut, cztery obszary. Firma demo: **Pracownia Smaków Sp. z o.o.** (delikatesy i akcesoria, Łódź), historia
od 28.09 do 29.10.2026, 152 zamówienia i 2 zamówienia z WooCommerce. Dane są fikcyjne.

Instancja jest osobna: `http://127.0.0.1:4300`, własny kontener PostgreSQL `dyna-scale-demo-pg18`. Main (4100) nie bierze udziału.

Polecenia uruchamiaj w katalogu repozytorium, w którym jest `tools/demo/demo.sh`.

## Przed pokazem

| Krok | Polecenie / czynność | Ile trwa | Wynik |
|---|---|---|---|
| 1 | Podłącz ładowarkę, nie zamykaj pokrywy, uruchom Docker Desktop | | |
| 2 | `docker ps \| grep dyna-woo` | sekundy | działają sklepy Woo i `tls` (certyfikat sklepów ważny do ok. 13.11.2026) |
| 3 | `tools/demo/demo.sh reset` | ok. 2 min | na końcu `DYNAMINDS demo: http://127.0.0.1:4300`; dane w stanie początkowym |
| 4 | `tools/demo/demo.sh status` | sekundy | kontenery `running`, `fakes running`, `status: ok` |
| 5 | Otwórz `http://127.0.0.1:4300`, zaloguj się jako Marta Zielińska | sekundy | hasła są w `tools/demo/CREDENTIALS.local.md`; nie pokazuj tego pliku na ekranie |

Sam `tools/demo/demo.sh start` po wyłączeniu instancji: ok. 2 min. Po pokazie: `tools/demo/demo.sh stop`.
Wyłącz powiadomienia systemowe. Zapasowy plan to zrzuty w `docs/demo/screens/`.

### Gdy coś pójdzie nie tak

| Objaw | Co zrobić |
|---|---|
| Strona się nie ładuje | `tools/demo/demo.sh status`, potem `tools/demo/demo.sh start` (2 min); w tym czasie pokaż zrzuty |
| Dane zmienione przez wcześniejszą próbę | `tools/demo/demo.sh reset` (2 min) |
| Wylogowało | zaloguj się ponownie (sesja trwa 8 h) |
| Zamówienie Woo nie przychodzi po 3 min | pokaż zamówienia ze źródłem WooCommerce już na liście. Błąd odczytu zatrzymuje kanał do restartu aplikacji, więc nie naprawiaj tego przy kliencie |
| KSeF lub paragon zgłasza brak połączenia | `tools/demo/demo.sh status`; gdy `fakes stopped`, `tools/demo/demo.sh start` |

## Co jest prawdziwe, a co symulowane

Powiedz to na początku, bez czekania na pytanie.

| Element | Stan w demo |
|---|---|
| Aplikacja, baza, reguły, historia operacji | prawdziwe: spakowane wydanie i PostgreSQL 18 |
| WooCommerce | **prawdziwy WooCommerce 11.2.1, ale lokalny, nasz własny sklep testowy** (`https://localhost:18447`), nie sklep klienta |
| Kurierzy | **symulacja**. InPost: lokalny symulator. Pozostałe przesyłki: „Nadaj przesyłkę DEMO”, przewoźnik „Symulator lokalny”. Żadnej etykiety u prawdziwego przewoźnika. DPD, DHL i Poczta Polska są tylko widoczne jako połączenia „przykład lokalny” |
| KSeF | **lokalna atrapa**; numery i UPO nie mają mocy prawnej. Połączenie z MF jest wyłączone w kodzie |
| Drukarka fiskalna | **lokalna atrapa**; paragony nie są fiskalne |
| Walidacja XSD | **ta instancja jej nie wykonuje** (`X-Walidacja-XSD: pominieta` przy FA(3) i JPK). Nie mów, że pliki przeszły walidację schematem. Walidacja jest w bieżącym kodzie, a ta instancja powstała wcześniej |
| Allegro, Amazon, Shopify, eBay, PrestaShop | tylko „przykład lokalny” z danymi syntetycznymi, bez kont dostawców |
| AI katalogu | **nie działa w tym demo**: brak lokalnego silnika Ollama. Pokazujemy ekran i komunikat |
| Zdjęcia produktów | rysunki poglądowe |
| Skala | liczby z osobnego testu, nie z tej instancji |

## Otwarcie (2 min)

1. Zaloguj się. **Klient widzi** „Przegląd”: wartość sprzedaży, zamówienia do realizacji, ostatnie zamówienia (`01-przeglad`).

## Obszar 1. Zamówienia i magazyn (8 min)

1. Menu **Zamówienia**: lista ze statusami i źródłami (`02-zamowienia`).
2. Kliknij zamówienie **Zofia Wieczorek**, status **W kompletacji** (`DE-20261029-B710108C`). Klient widzi pasek etapów, płatność, pozycje, lokalizację.
3. Rozwiń **Partie i alokacje magazynowe**. Wybierz partię `P2609-POR`, w polu **Odczytany kod SKU lub EAN** wpisz `PS-PRZ-001`, kliknij **Skanuj jedną sztukę wybranej partii** (`03-skan-partii`).
   Górne pole „Zeskanuj lub wpisz SKU / EAN” też działa (od poprawki z 2.11.2026). Gdy w lokalizacji jest kilka partii produktu, kieruje do tej sekcji.
4. Kliknij **Potwierdź spakowanie**, potem **Nadaj przesyłkę DEMO**. Klient widzi status **Nadane**, numer `DEMO-…`, przewoźnika „Symulator lokalny” (`04-nadane-demo`). Powiedz, że to symulacja.
5. Na liście wpisz `DE-20261027-9BCDF4F6`, otwórz. W **Przesyłki**: przewoźnik `InPost ShipX`, numer `DEMO-…`, oraz pełna historia z każdym skanem (`05-inpost-historia`).
6. Menu **Partie i FIFO**, **Odczytaj zapas i wartość**: wartość zapasu ok. 47 tys. zł (`06-partie-zapas`). Zakładka **Historia operacji**: niezmienna historia skanów, rezerwacji i wydań (`07-partie-historia`).
7. Menu **Zwroty i reklamacje**: sprawy zwrotowe; filtr statusu „Wszystkie” pokazuje też rozliczone (`08-zwroty`).

## Obszar 2. Faktury, KSeF, JPK (8 min)

1. Wróć do zamówienia Zofii Wieczorek (nadanego przed chwilą). Rozwiń **Faktura VAT: B2B, EUR, ZW/NP/OO/OSS**. Seria **Faktury sprzedaży (FV-S/PS)**; dane są już wypełnione. **Przelicz**: klient widzi VAT 5% i 23% osobno (`10-faktura-przeliczenie`).
2. **Przygotuj podgląd**, zaznacz „Sprawdziłem dane…”, **Wystaw fakturę**. Numer `FV-S/PS/2026/…`.
3. W sekcji KSeF kliknij **Wyślij do KSeF**. Klient widzi **Przyjęta w KSeF**, numer oraz „Lokalny serwer testowy — numer KSeF i UPO nie mają mocy prawnej” (`11-faktura-ksef-przyjeta`). Przeczytaj to na głos.
4. Menu **Dokumenty**, **Rozliczenie płatności, faktur i korekt**: domyślny okres październik, **Przelicz**. Klient widzi 130+ zgodnych i oznaczone wyjątki, co do grosza (`12-rozliczenie`).
5. Niżej: **Korekty faktur FV-S (KOR-S)** — trzy korekty do zwrotów (`13-korekty-kor-s`).
6. Niżej: **Pliki JPK** (`14-pliki-jpk`). Miesiąc **wrzesień 2026**, kod urzędu `1009`, dowolny e-mail, **Pobierz JPK_V7M**.
   Używaj września. Październik jest odrzucany, bo brakuje raportu dobowego kasy za 29.10 (paragon jest, raportu nie ma). To poprawna kontrola, ale nie da się jej usunąć w tym zestawie danych.
7. Paragon: w zamówieniu `DE-20261027-9BCDF4F6` rozwiń **Paragon fiskalny**: numer, PTU, kasa. Powiedz: atrapa drukarki.

## Obszar 3. Sklepy (5 min)

1. Menu **Integracje** → **Lokalne sklepy Woo**: „Automatyczne tworzenie zamówień: Włączone”, ostatnie importy (`20-woo-import`).
2. W terminalu: `tools/demo/demo.sh woo-order`. To zamówienie złożone w prawdziwym WooCommerce przez jego API.
3. Po ok. minucie w **Zamówienia** pojawia się nowe zamówienie, źródło **WooCommerce**, opłacone (zmierzone: 1 min).
4. **Twoje połączenia** → rozwiń „Dane demonstracyjne…” → **Przykład Allegro**. Okno mówi „Lokalny przykład Allegro — dane syntetyczne. Nie korzysta z API dostawcy.” (`21-allegro-przyklad`). Zamknij okno bez importu.

Po `reset` zamówienia złożone wcześniej przez `woo-order` wracają do listy po ok. minucie, bo sklep Woo nie jest cofany. Nie przeszkadza to w pokazie: nowe zamówienie to to z najnowszą godziną.

Stany do sklepu: synchronizacja jest włączona (cykl 30 s). Nie sprawdzaliśmy jej wyniku na ekranie, więc mów tylko, że jest włączona.

## Obszar 4. Raporty i skala (5 min)

1. Menu **Raporty**, **Oblicz raport**: 134 zamówienia z października, zwroty, koszt towaru (`30-raport-sprzedaz`).
2. **Pokaż analizę**: wykres sprzedaży dziennej, zakładki Produkty, Klienci, Pracownicy (`31-analiza-wykres`).
3. Menu **Produkty**: katalog ze zdjęciami (`32-produkty-zdjecia`). Kliknij **Miód lipowy z Podlasia 400 g** (`33-karta-produktu`). W karcie, sekcja **Treści produktu z AI**: komunikat „Uruchom lokalny silnik Ollama…” (`34-ai-silnik`). Powiedz wprost: bez silnika generowanie nie działa, a model ma działać lokalnie.
4. Skala, z testu `docs/scale/LOAD-TEST-FULL-20261029-C.md` (5 firm, 100 000 zamówień, 100 000 SKU, 180 dni):

| | 12 klientów, 30 min | 24 klientów, 30 min |
|---|---|---|
| Żądania na sekundę | 63,6 | 78,2 |
| Błędy | 0 | 0 |
| Odczyty p95 / p99 | 46 / 52 ms | 112 / 138 ms |
| Zapisy p95 / p99 | 353 / 538 ms | 462 / 692 ms |

Odtwarzanie po utracie dysku (`docs/scale/RECOVERY-DRILL-FULL-20261029.md`): utrata danych 57,6 s, powrót 2,5 min.
Ten test nie obejmował importu Woo ani synchronizacji stanów w tle. Nie mów, że to pełny odbiór.

## Pytania, które mogą paść

- **Prawdziwy KSeF?** Nie w tym demo. Przebieg FA(3) jest zbudowany i sprawdzony na atrapie; połączenie z MF jest wyłączone.
- **Prawdziwi kurierzy?** Nie w tym demo; prawdziwe przesyłki wymagają kont dostawców.
- **Role?** **Ustawienia → Zespół**: Administrator, Magazynier, Tylko odczyt. W demo: Marta, Tomasz, Ewa.
- **2FA?** **Ustawienia → Bezpieczeństwo konta**: przycisk **Włącz MFA**, aktywne sesje, historia logowań (`41-bezpieczenstwo-mfa`). W demo jest wyłączone. Włączania nie klikaliśmy w tej próbie.
- **Kto co zrobił?** Menu **Historia operacji**. Wpisz `order` w pole **Operacja** i kliknij **Filtruj**: bez filtra listę zasłaniają wpisy synchronizacji Woo (`40-historia-operacji`).
- **Dane osobowe?** Moduł **RODO** jest w menu. Nie klikaliśmy go w tej próbie.

## Zrzuty

`docs/demo/screens/`: nazwy jak w krokach powyżej.
