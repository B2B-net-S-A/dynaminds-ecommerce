# N09 — skany historyczne i bieżąca rezerwacja w kompletacji

Status: **lokalny zwykły start, API i Chrome PASS dla tego podpisu**.
Data: 18.10.2026. Commit źródeł: `4cd49c0a2e26434a94b24bff50f9e56a35589925`.
Wydanie: `75f239605b96846e1346f3d8c2fcba68c29b1c9e7b1a78871ff5df2b1655aa2f`.

## Poprawka i rzeczywisty wynik

Po częściowym wydaniu paczki [widok zamówienia](../../web/main.tsx) podpisywał
historyczne `scanned/quantity` jako sztuki zarezerwowane. W istniejącym przypadku
3 sztuki zeskanowano, 2 wydano i pozostała 1. Podpis zmieniono na:
**„A-01 · skany 3/3 · zarezerwowane 1 szt.”**

Dla aktywnej rezerwacji bieżąca liczba to `quantity − consumed_quantity −
released_quantity`; brak starszych liczników oznacza 0. Nie ma obcinania wyniku.
Pozostałe stany wydania, zwolnienia i przeniesienia zachowują swoje podpisy.
Nie zmieniono ilości zamówienia, kontroli skanowania, rezerwacji ani API.

Root odświeżył zwykły Chrome, otworzył ten sam istniejący przypadek częściowej
wysyłki i potwierdził nowy podpis. W Magazyny → filtr SKU → Szczegóły nadal
widoczne są **stan 8 / rezerwacja 1 / dostępne 7**. Nie wysłano kolejnej paczki,
nie potwierdzano nowej płatności i nie wykonano biznesowych zapisów z UI.
Przypadek oraz wcześniejszy odbiór lokalizacji opisuje
[raport N08](STOCK-LOCATION-RESERVATION-LOCAL-20261018.md).

## Wydanie, dane i granice

Typecheck EXIT 0. Świeży Vite z izolowanego projektu oraz kontrola i emisja
pakietu zakończyły się PASS. Sprawdzono wszystkie 383 pliki i 11 entrypointów,
łącznie 100274037 B. Wszystkie pliki poza frontendem są identyczne z N08;
runtime serwera i zasoby Native nie zmieniły się. Nie dodano migracji SQL.

Normalny start na oryginalnej bazie potwierdził health 200 i oczekiwane wydanie.
Pełne porównanie 627 tabel zachowało 626 tabel biznesowych; w
`ordinary182_runtime_generation` zmieniło się wyłącznie przypięcie wydania,
przy tej samej generacji 1744. Kontrole Roota: READ ONLY, ROLLBACK i zamknięcie
klienta potwierdzone.

Odrębny caller wykonał 11 GET, bez POST, SQL, nowego logowania lub dostawcy.
Pełne biznesowe DTO pozostały zgodne z odebranym przypadkiem, w tym stary RMA,
źródło paczki, plan i płatności. Sesja nie została zmieniona. Dowód API jest
osobny od rzeczywistego odbioru wizualnego w Chrome.

To jeden lokalny przypadek WMS OFF i dwie linie prezentacji. Nie przyznajemy
odbioru WMS ON, dokumentów fizycznego WZ, ręcznej blokady lokalizacji,
integracji dostawców, skali ani pełnego Goala. Wszystkie pozostałe wymagania
zachowują własne statusy; historyczny raport N08 pozostaje niezmieniony.

## Dowody

- [Pełny odbiór pakietu](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/picking-caption-app-release-prepared-agent-20261018-09/root-release-review.private.json>):
  2664 B, SHA256 `5dd5e7fce0b7bb4c95d91673a19604edcb7cfc32be5c12f27a73fa2979fe2f1c`.
- [Zwykły start](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/picking-caption-original-app-n09-prepared-agent01/ready-root.private.json>):
  5781 B, SHA256 `2f89348edd4aa169a69192385183807b5833bb706ff6370f5c58d7cc338b5452`.
- [Dane przed startem](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/picking-caption-original-app-n09-prepared-agent01/data-before-root.private.json>):
  88997 B, SHA256 `7d70653aef324d93ab574eaa7b9fee72be6d885fb9639497668d20451b2a765d`.
- [Dane po starcie](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/picking-caption-original-app-n09-prepared-agent01/data-after-root.private.json>):
  89229 B, SHA256 `6dae3d8a4938a62ce15c01ba2ef017c60d6a199f58001dfed79b217cd163c3ed`.
- [Rzeczywisty odbiór API](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/picking-caption-original-app-n09-prepared-agent01/read-api01/result.private.json>):
  9274 B, SHA256 `f4baecd3caf0891c6ffa7373d8b15d3b3af7f5ba0ffa16e16924a79a0c7666dc`.
- [Rzeczywisty odbiór Chrome](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/picking-caption-original-app-n09-prepared-agent01/ui-root.private.json>):
  2937 B, SHA256 `98d1746b64f97519a6963ae924a085e92247ff47e89e118c0267b5dee5552c8f`.
- [Chrome — podpis kompletacji](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/picking-caption-original-app-n09-prepared-agent01/ui-picking-caption-root.png>):
  142421 B, SHA256 `054bc139982df0977c3414a67fca9f841a8f9b31bd3b77bdfe6842fcdc4a119c`.
- [Chrome — lokalizacja 8/1/7](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/picking-caption-original-app-n09-prepared-agent01/ui-stock-location-root.png>):
  137347 B, SHA256 `bcbd8cda4f3b659507d574f5260bd0958162fde95002a070ea7ec6f3e3e1a7c2`.

Prywatne artefakty zawierają pełne tożsamości i odpowiedzi. Raport nie publikuje
DSN, tokenu sesji ani danych logowania.
