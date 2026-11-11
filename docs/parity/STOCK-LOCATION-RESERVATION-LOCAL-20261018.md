# Lokalizacje — rezerwacja pozostała po częściowej wysyłce

Status: **rzeczywisty SQL, reprodukcja N07 oraz zwykły start, API i Chrome N08 PASS — dla pozostałej rezerwacji w lokalizacjach**.
Data: 18.10.2026. Lokalny commit: `77be45ee1c6a11824bd68bc584d6e6850e5454a0`.

## Problem i poprawka

Po częściowej wysyłce paczki rezerwacja pozostaje `active`, a jej historyczna
`quantity` nie maleje. Zużycie zapisuje osobna `consumed_quantity`.
[Rzeczywisty writer](../../server/order-parcel-stock.ts) i jego
[kontrakt SQL134](../../server/134_order_parcels.sql) dopuszczają właśnie taki stan.

GET `/api/stock-locations` sumował pełną pierwotną ilość aktywnych rezerwacji,
przez co zawyżał zajęty i zaniżał dostępny zapas. Poprawka w
[kontrolerze](../../server/stock-location-routes.ts) odejmuje już zużyte sztuki,
tak jak istniejący `binStock()` w [serwisie lokalizacji](../../server/stock-locations.ts).
Brak starszej kolumny jest obsługiwany przez `to_jsonb` i `COALESCE(...,0)`.
Nie zmieniono zapasu, przydziału, filtrów, kursora ani zasad dostępu.

## Rzeczywisty przykład z zachowanych danych

Root wykonał obie pełne wersje zapytania przechwyconego z rzeczywistego
handlera na oznaczonej odtworzonej kopii. Dane istniały wcześniej; nie tworzono
nowej rezerwacji ani sztucznego scenariusza w bazie. Odczyt odbył się jako
`dyna_app` z prawdziwym kontekstem firmy i RLS.

| Wartość | Stare zapytanie | Poprawione zapytanie |
|---|---:|---:|
| Fizyczny stan lokalizacji | 8 | 8 |
| Zajęte sztuki | 3 | 1 |
| Dostępne sztuki | 5 | 7 |

Aktywna rezerwacja ma historyczną ilość 3 i zużycie 2; pozostaje 1. Nowy wynik
zgadza się również z `stock.reserved=1`. Pozostałe pola odpowiedzi są
identyczne. Obca firma otrzymała 0 wierszy. Stan zapasu i generacja 1744 nie
zmieniły się; READ ONLY, ROLLBACK i zamknięcie klienta potwierdzone.

## Reprodukcja przez zwykłe API na N07

Root utworzył w istniejącej własnej firmie jeden nowy produkt i zamówienie,
używając autentycznej zachowanej sesji. Produkt miał 10 sztuk w A-01;
zamówienie obejmowało 3 sztuki. Zwykła kompletacja i plan paczek DEMO 2+1
wydały tylko pierwszą paczkę. Druga pozostaje niewysłana, z rezerwacją 1 sztuki.

Przebieg objął 37 żądań i 11 potwierdzonych mutacji. Odczyt zapasu zwrócił
`on_hand=8`, `reserved=1`, `available=7`, a źródło paczki potwierdziło pierwotne
3, zużyte 2 i pozostałą 1 sztukę. Starszy endpoint N07 nadal pokazał
`quantity=8`, `reserved=3`, `available=5`: błąd został więc odtworzony przez
zwykły, uwierzytelniony proces produktu, niezależnie od odczytu SQL na kopii.

Płatność była wyłącznie lokalną deklaracją receipt 3000 groszy, bez transferu.
Nie wykonano loginu, SQL, połączenia z kurierem lub dostawcą ani startu workera.
Nie wydano drugiej paczki i nie zwolniono pozostałej rezerwacji. Pełne DTO
starego zamówienia i RMA pozostały identyczne. Ten przebieg nie jest odbiorem
wystawiania dokumentu WZ.

## Zwykłe wydanie N08 — API i Chrome

Root zbudował i sprawdził wszystkie 383 pliki N08, łącznie 100273964 B,
z 11 entrypointami. Manifest:
`3711169835e68fb7a04f4356c1e01af08b6e77146bafbf8c392c3ea368e7bfbe`.
Frontend zachowano po sprawdzeniu równości wejść; zmiana jest w kodzie serwera.

Root uruchomił N08 zwykłą ścieżką na tej samej oryginalnej bazie i sesji.
Health zwrócił 200 oraz oczekiwaną rewizję. Porównanie wszystkich 627 tabel
potwierdziło 626 niezmienionych tabel biznesowych; w
`ordinary182_runtime_generation` zmieniło się wyłącznie przypięcie wydania.
Generacja pozostała 1744, bez nowej migracji. Odczyty kontrolne były READ ONLY,
z potwierdzonym ROLLBACK i zamknięciem klienta.

Rzeczywisty odbiór API objął 11 GET, bez POST i SQL w callerze. Ten sam nowy
przypadek z N07 zwrócił teraz **stan 8, rezerwację 1, dostępne 7**. W całym DTO
lokalizacji zmieniły się wyłącznie `reserved` i `available`. Pozostałe biznesowe
DTO, stare zamówienie i RMA były w całości identyczne; jar pozostał niezmieniony.
Nie wysyłano kolejnej paczki i nie poprawiano danych, aby uzyskać wynik.

W zwykłym Chrome Root przeszedł **Magazyny → filtr SKU → Szczegóły**.
Tabela i rozwinięty panel pokazały ten sam stan 8/1/7. Zachowany zrzut
potwierdza odczyt tego rzeczywistego produktu w aplikacji N08.

### Granice

Odbiór dotyczy bieżącej rezerwacji w widoku lokalizacji i jego API.
W sekcji kompletacji zamówienia istnieje nadal odrębna etykieta
`A-01 · 3/3 szt. zarezerwowane`. [Renderer OMS](../../web/main.tsx) używa tam
historycznych `scanned/quantity` oraz stanu rezerwacji; nie odejmuje zużytych
sztuk. Ten tekst wymaga osobnej poprawy prezentacji. Nie deklarujemy naprawy
wszystkich liczników OMS, wydań WZ, integracji dostawców ani pełnej skali.

[Testy kontrolowanego transportu](../../tests/stock-location-reservation-read.test.ts):
7/7 PASS, 0 SKIP; typecheck EXIT 0. Testy wykonują rzeczywisty zarejestrowany
handler oraz sprawdzają parametry, stronę 25+1, DTO, port firmy i obsługę błędów.
Nie interpretują SQL i nie wyliczają fikcyjnego wyniku na podstawie jego tekstu.

Nie przyznano odbioru pełnej skali ani całego Goala. Ta poprawka nie dostarcza
ręcznej blokady lokalizacji opisanej w
[odkryciu stocktake](STOCKTAKE-LOCATION-DISCOVERY-20261018.md).

## Dowody

- [Rzeczywisty wynik SQL](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/stock-location-partial-reservation-root-20261018-01/result.private.json>):
  2955 B, SHA256 `9264281f7c772f1d993402c1e0e3beba9a310024860fb310f5d126ddc9625c14`.
- [Przechwycone zapytania i parametry](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/stock-location-partial-reservation-probe-prepared-agent01/captured-route-query.private.json>):
  5373 B, SHA256 `0c3460fd1f1e990698f968e490a30b1087b73feb969ad60f181e91ae288055da`.
- [Własny rzeczywisty proces API N07](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/stock-location-own-partial-ui-prepared-agent01/run01/result.private.json>):
  45477 B, SHA256 `07274928f0dc65d878327c8bb79ab8fa87082f2575cefeb599178c1758b90fb2`.
- [Odbiór zbudowanego pakietu N08](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/stock-location-app-release-prepared-agent-20261018-08/root-release-review.private.json>):
  2519 B, SHA256 `5c8b5b02c66d7b90caffea4581b5851c4d50e159754bffade141f6bc71ae2ac8`.
- [Zwykły start N08](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/stock-location-original-app-n08-prepared-agent01/ready-root.private.json>):
  5781 B, SHA256 `4d8d6f2cc97b36e48f25d0f944b312623f6f654d1185e759231c02dc1c6284ba`.
- [Dane przed startem](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/stock-location-original-app-n08-prepared-agent01/data-before-root.private.json>):
  88997 B, SHA256 `85ef10cebc654f58d9365adc0ba6584805ba72fb5e98f2c875d250f71546aaee`.
- [Dane po starcie](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/stock-location-original-app-n08-prepared-agent01/data-after-root.private.json>):
  89229 B, SHA256 `86facbde4dc99996eb7f2ab314c69b5e4fd9fc33cf697711e6c56e98b1d45b39`.
- [Rzeczywisty odbiór API N08](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/stock-location-original-app-n08-prepared-agent01/read-api01/result.private.json>):
  8826 B, SHA256 `341924476169eec432fa3bccb8fafe307f99f0655f616053b2410838522eefe8`.
- [Chrome — widok i szczegóły lokalizacji](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/stock-location-original-app-n08-prepared-agent01/ui-stock-location-root.png>):
  136989 B, SHA256 `99fbc70328e70380565984f0a052534ecc6bcdb0e31923c578b2f1e6556b668c`.
- Kontroler: 3708 B, SHA256 `01331fe8010f9645849e7011248285f68d5d0995d04b119d6b86b5ac2b683507`.
  Test: 8714 B, SHA256 `f0da528a32d84d84a6ebb62a6fad2764dc3c0255e8bee21da017a6f7e68958f2`.

Artefakty prywatne zachowują pełne dane i tożsamość kopii. Raport nie publikuje
DSN ani sesji; rozdziela reprodukcję na N07, poprawkę odebraną w N08 i nadal otwarte wymagania produktu.
