# Import nowych zamówień Woo216 — źródła i kompilacja

**Kod zintegrowany; rzeczywisty automatyczny proces w aplikacji pozostaje do odbioru.**

Zwykły lokalny czytnik może, po osobnej zgodzie administratora, zaimportować
wyłącznie nowo zaobserwowane zamówienie z kompletnego odczytu rozpoczętego po
zgodzie. Historyczny staging i stare zadania nie są przyjmowane. Wszystkie
pozycje muszą mieć rzeczywiste mapowania ofert; wiersze błędne i niemapowane
pozostają do ręcznej obsługi, bez STARTED i blokady kanału.

Receipt wiąże konkretny kanał, wersję zgody, źródło, magazyn, occurrence,
dispatch, zadanie i inbound. Właściwy import używa istniejącego `importOrder`;
utworzenie zamówienia/rezerwacji/płatności i receipt DONE należą do tej samej
transakcji. Niepewny rozpoczęty import blokuje automatyczne ponowienie. To
ograniczenie nie oznacza ukończonego procesu rozstrzygania wszystkich awarii.

Źródłowe commity D: `ac74d01` + `a14b1f6` + `adfd291`; integracja zasobów i cold
`eb9d5f6`. Odrębny executor stanów: `08a93d1`. Wszystko pozostaje lokalne.

Root wykonał niezależną kompilację pełnego poprzednika i SQL216 na świeżej bazie
PG04: **41332 → 41534 rekordy, 202 dodatki, 0 zmian/usunięć**. Pełny inverse,
siedem guardów przed i siedem po: TRUE przy SQL8s/client9s. ROLLBACK, zamknięcie
klientów, zero połączeń przed DROP, brak scratch po DROP oraz pełne role i
członkostwa potwierdzone. Nie było COMMIT ani zmiany bazy aplikacji.

- SQL216: 6343 B, SHA256 `04878be0b869e319fc86667c9c94f4254bd3b7a3ad7951d374a8c0ac012a5994`.
- [Wynik Source216](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/woo-import216-source-prepared-agent-20261019-01/result.private.json>): 108913 B, SHA256 `735ae326c14438e95129b38a7d65f50eb7809f2683f090ab335fb5268a2af83e`.
- [Pełna delta](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/woo-import216-source-prepared-agent-20261019-01/delta.private.json>): SHA256 `e409cf2e36b4c3dff0b116b7c5bc42d9d71cc5d6c293457544245f77196c0967`.

Root sprawdził zintegrowane kontrolowane porty importu/czytnika, UI poleceń i
typecheck. Test kolejności migracji dostosowano do zachowania215 przed216.
Root wykonał także10 testów pełnej projekcji216 i39 testów zasobów/starszych
bramek; źródłowy etap ma niezależny FILE peer. To nie są testy aktywnego importu.

SQL kompilowano przy historycznym źródle `b5f1d5d`; późniejsza poprawka mapowania
zmieniła kod importu, zachowując SQL byte-exact. Nie przypisujemy starej próbie
wykonania późniejszego kodu. Akceptacja pełnego procesu będzie dotyczyć nowego
wspólnego pakietu, naturalnego odczytu, biznesowego skutku i UI/API.

Aktualnie uruchomione N18 nadal ma schema215 i nie wykonuje importu216 ani
nowego executora stanów. Pełna automatyka, recovery, skala i Goal pozostają otwarte.
