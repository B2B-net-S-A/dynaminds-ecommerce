# Wydanie05 — aktualny przekrój lokalnego odbioru

17.10.2026. Manifest wydania ma SHA256
`f73f57c3655bf9aeecba2de6a406ba328f3a9ef3d4140d6f93088dcf95c750dc`:
374 pliki, 99 030 617 B, 702 emitowane źródła. Podgląd działa na4103,
na istniejącej kopii danych; oryginalny Main4100 zachowuje `db1a33d2…`/schema205.
Koordynator ponownie odczytał oba health podczas tego etapu. To dowód
dostępności i rewizji, bez pełnego ponownego odbioru wszystkich funkcji.

## Potwierdzone działania

- Rzeczywiste logowanie/API: sesja administratora, rejestr15 connectorów,
  deklaracja pól Mirakl oraz izolacja cudzych sklepów Woo.
- Rzeczywisty właściciel obu istniejących lokalnych sklepów ma przez API
  dostęp do obu; sesja innej firmy ich nie widzi. Nie wysyłano do tych sklepów
  nowych zadań ani zapisów.
- Chrome: dashboard Main, formularz konfiguracji Mirakl w podglądzie oraz
  panel obu lokalnych Woo po zalogowaniu właściciela. Nie zapisano połączenia
  Mirakl i nie wykonano wywołania jego zewnętrznego API.
- Dwa rzeczywiste syntetyczne scenariusze zwrotu w podglądzie05: WMS OFF/ON,
  sale/custody/reject i dwa magazyny. Późniejszy reader206 sprawdzono na
  osobnej przywróconej scratch DB: 3/3 PASS, 0 SKIP; scratch usunięto po
  zamknięciu własnych klientów. [Dokładny zakres i ograniczenia](RETURN-CREDIT206-INTEGRATION.md).

Dowody prywatne są w `local-builds/full-base-preview-20261017/`:

- `preview05-api-acceptance.private.json` — odczyty sesji Demo i izolacja;
- `preview05-owner-api-acceptance.private.json` — rzeczywisty właściciel obu Woo;
- `preview05-mirakl-form.png` i `preview05-two-local-woo.png` — obejrzany UI;
- `return-credit206-cases05/result.private.json` — dwa scenariusze API;
- `return-credit206-native05-1792257398767/Root-review.private.json` — kontrola15 artefaktów PG.

## Otwarte warunki

Podgląd ma wyłączone globalne workery, automatykę scoped i importer.
`mirakl_reads_available=false` odzwierciedla brak wybranej rzeczywistej
instancji/sklepu oraz poświadczeń. Sama obecność formularza i kodu adaptera
nie potwierdza konta dostawcy ani pełnego importu przez UI.

Source206 nie znajduje się w migracjach podglądu ani Main. Writer207 i
scenariusz faktura przed RMA pozostają osobnym WIP. Pakiet05 nie jest nowym
odbiorem Main50, wspólnego recovery ani całego zakresu Base.

Gotowość05 zaobserwowano po około65 s od urodzenia procesu; to pojedynczy
start na małej istniejącej kopii z rozgrzanym PostgreSQL, bez aktywnych
workerów. Nie jest wynikiem zamrożonego profilu100k/100k.

Wcześniejsze04 i diagnostyczne04 zakończyły się błędem exact source pin
stock writera. Commit `f3931ed` aktualizuje wyłącznie dwa przejrzane piny
DB/domain Mirakl; nie wyłącza kontroli. Wydanie05 zawiera tę poprawkę i
normalizację immutable catalogue z `0ce83cd`. Historyczne niepowodzenia
pozostają zachowane.

[Pełny Goal](../FULL-BASE-GOAL.md) pozostaje aktywny. Zakresv2 nadal jest
częściowy; zamrożony [profil skali](acceptance-profile.README.md) nie został
jeszcze wykonany. Lokalne testy mechanizmu usług nie zastępują odbioru
restartu i odtworzenia całego rzeczywistego stacka.
