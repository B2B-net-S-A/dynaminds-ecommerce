# Pięć sklepów — rzeczywisty import produktu i zamówienia

Status: **pięć procesów API, zachowanie wcześniejszych danych oraz korekta UI → zapis stanu Woo PASS; automatyka i skala otwarte**.

Na tym samym wydaniu N11 `8d8f8bdd…` każda z pięciu firm otrzymała produkt
z identycznym świeżym SKU. Lokalne UUID produktów i zamówień są różne;
natywne numery Woo mogą się powtarzać między odrębnymi sklepami.

## Odebrany proces

1. Własny prosty produkt w Woo:8 sztuk,12,30 PLN, bez podatku.
2. Rzeczywiste pobranie katalogu i zatwierdzenie wyłącznie nowego produktu.
   Przyjęcie do MAIN nastąpiło **przed** utworzeniem zamówienia.
3. Własne zamówienie Woo `on-hold`:1 sztuka,12,30 PLN, bez wpłaty.
   Natywny Woo zmniejszył zapas do7.
4. Pobranie zamówień przez istniejący procesor i osobne zatwierdzenie wyłącznie
   nowego zamówienia, z aktualnym hashem źródła.
5. Odczyt zwykłego zamówienia, rozliczenia i stanów:
   **na stanie8 / zarezerwowane1 / dostępne7**, zgodnie z Woo7.
   Wpłaty0, do zapłaty12,30 PLN, brak refundacji.

| Firma | Nowe produkty lokalne | Nowe zamówienia lokalne | Stan / rezerwacja / dostępne | Woo |
| --- | --- | --- | --- | --- |
| A | 1 | 1 | 8 / 1 / 7 | 7 |
| B | 1 | 1 | 8 / 1 / 7 | 7 |
| C | 1 | 1 | 8 / 1 / 7 | 7 |
| D | 1 | 1 | 8 / 1 / 7 | 7 |
| E | 1 | 1 | 8 / 1 / 7 | 7 |

Pięć cyklicznych prób odczytu zamówienia innej firmy zwróciło404.
Starsze produkty i zamówienia Woo zachowały pełne odpowiedzi API po odjęciu
wyłącznie nowych ID. Jedyny jawny wyjątek porównania produktów to `related_ids`:
oficjalny Woo zwraca tam losową próbkę powiązanych produktów. Zachowano pełne
surowe odpowiedzi, sprawdzono typ, unikalność, zakres i limit tych ID.
Nie jest to twierdzenie o hashach fizycznych wierszy bazy Woo.

## Zachowany błąd i kontrolowane wznowienie

Pierwsza próba zatrzymała się po55 GET i jednym znanym POST201: produkt A29
został utworzony. Helper błędnie odrzucił poprawny `Location` odpowiedzi201.
Nie ponowiono tworzenia produktu ani nie usunięto danych próby.

Po poprawieniu kontroli nagłówka osobne wznowienie odczytało A29 przez GET,
wykorzystało ten sam SKU i klucze importów oraz wykonało pozostałe39 POST.
`Location` dopuszczono wyłącznie dla201 z dokładnym własnym adresem utworzonego
produktu lub zamówienia; przekierowań nie śledzono.

Wznowienie: **39 POST +121 GET =160 pełnych ACK**, EXIT0. Razem z pierwszą
próbą:40 POST, bez powtórnego produktu A. Koordynator i osobny agent uzgodnili
wszystkie intencje, ACK, hashe odpowiedzi i pięć przypadków biznesowych.
16 kontrolowanych testów wznowienia PASS, bez pominięć.

Dowód prywatny:
`local-builds/full-base-preview-20261017/five-native-woo-business-prepared-agent01/run02/result.private.json`,
149506 B/SHA256 `acdfb49f6a74f2271490e52d5f58675bfdbbf29668337c30e6b86ce0c08d9b1b`.

## Dane i UI

Przed wznowieniem wszystkie627 tabel aplikacji miały pełne hashe identyczne
z bazą sprzed testu. Po pięciu procesach604 tabele zachowały całe hashe,
23 zawierają skutki operacji. Rzeczywiste uzgodnienie READ ONLY potwierdziło
pełne wcześniejsze hashe i liczby wierszy także tych23 tabel po wyłączeniu
dokładnie217 nowych wierszy i projekcji czterech pól pięciu własnych kanałów.
Wszystkie627 tabel mają więc potwierdzone zachowanie wcześniejszych danych.
Piętnaście markerów zmian stocku powiązano z konkretnymi transakcjami utworzenia
produktów i rezerwacji, po2+1 dla każdej firmy. Pełny stempel1744 bez zmian;
ROLLBACK i zamknięcie klienta potwierdzone. Osobny agent sprawdził wynik.

Prywatny wynik: `reconciliation04/result.private.json`,12273 B/SHA256
`4e33d5e570b721dbb344769493cd05978e35e24758bedcdb9c39eaefa9d81489`.
Poprzednie odmowy helpera zachowano: błędny typ pola listy zmian, oczekiwanie
nieistniejącego surowego pola lokalizacji oraz błędne oczekiwanie flagi bootstrap
dla Woo. Nie wykonano zapisów SQL; poprawki sprawdzono także na wszystkich
rzeczywistych wybranych wierszach przed końcowym uzgodnieniem.

Chrome: na istniejącej sesji firmy E potwierdzono nowy produkt,8/1/7,
zamówienie Woo12,30 PLN, wpłaty0 i rezerwację1 w A-01. To odbiór odczytu E;
wcześniejszy odbiór pięciu firm obejmował logowanie i własny podłączony kanał.

## Korekta w UI i wysłanie stanu do Woo

Po uzgodnieniu importu zwykła sesja Chrome firmy A wykonała dokładnie jedną
korektę +1 wskazanego produktu w MAIN, z jawnym powodem. UI potwierdził zapis,
historię ruchu i **9 na stanie /1 zarezerwowane /8 dostępnych**.

Następnie zwykłe API przygotowało podgląd wyłącznie stanu dla istniejącego
powiązania A: `manage_stock:true, stock_quantity:8, backorders:no`, bez ceny.
Osobne zatwierdzenie kolejki i jednokrotne wykonanie tego konkretnego zadania
przez istniejący procesor zakończyły plan i zadanie stanem `done`.
Końcowy odczyt oficjalnego lokalnego Woo potwierdził zmianę7→8.

W pozostałych czterech firmach nadal8/1/7 i Woo7. Pełne odpowiedzi ich produktów
(z wcześniej opisanym wyjątkiem losowego `related_ids`) i wszystkich zamówień
Woo pozostały zgodne. Pięć lokalnych zamówień i rozliczeń bez zmian.
W A zachowano cenę12,30 PLN, SKU, nazwę i sprzedaż; starsze produkty Woo bez zmian.

Wykonano35 GET przed UI oraz3 POST i60 GET dla podglądu, kolejki, wykonania
i odczytów. Helper nie wykonywał bezpośredniego PUT do Woo; zapis należał
do aplikacji. Prywatny wynik: `stock-A01/sync-once/result.private.json`,248338 B/
SHA256 `2750ca306f4101822e3f476a1e969c24f087ef3fa082790780b8f82178d98b20`.
Zrzut: `stock-A01/ui-A-correction.root.png` w katalogu dowodów tego procesu.
Nie jest to pełne uzgodnienie bazy po późniejszej korekcie i zapisie oferty;
wcześniejsze627-table proof dotyczy dokładnie zakończonego importu pięciu sklepów.

## Otwarte

Procesory wywołano ręcznie jednokrotnie dla konkretnych zadań. Ten wynik
**nie zalicza automatycznych workerów**, cyklicznego pobierania, realizacji
wysyłki, płatności u operatora, skali ani pełnego klona. Zapis stanu do Woo
odebrano oddzielnie powyżej, wyłącznie w jednej firmie i dla jednego produktu.
Z katalogów przygotowano13 pozycji, zatwierdzono tylko5 nowych produktów;
przygotowano29 zamówień źródłowych, zatwierdzono tylko5 nowych. Starszych
pozycji nie importowano do produktów ani zamówień lokalnych.
