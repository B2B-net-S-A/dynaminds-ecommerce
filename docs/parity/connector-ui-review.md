# Przegląd UI ręcznego zadania konektora

Data: 2026-10-17. Niezależny review Source, callsites i kontrolowanych testów. Bez rzeczywistych kont, HTTP do aplikacji/dostawców, PostgreSQL, Chrome lub zmian runtime. Kod produktu nie był zmieniany w ramach tego przeglądu.

## Wynik i zakres

Brak wykazanego blockera IAM lub ponawiania niepewnego zapisu dla obecnego wpięcia: **Allegro `orders.sync` w SyncPanel**. Wynik nie jest odbiorem dostawcy ani pełnego UI wszystkich rodzajów zadań. Wykryta konkretna luka P2 w funkcji współdzielonej została następnie poprawiona na polecenie koordynatora. Ostatni diff i jego test wykonał autor tego raportu; koordynator powinien przejrzeć tę wąską poprawkę.

- `main.tsx` przekazuje aktualne tenant/user/admin/readOnly oraz blokadę zewnętrznych zapisów; lokalny Woo zachowuje osobny kontroler.
- `sync.tsx` montuje kontrolkę tylko dla niesymulowanego kanału Allegro i `orders.sync`; dla tej ręcznej ścieżki usuwa zwykłe „Ponów”. Pozostałe cztery backendowe rodzaje nie otrzymuje tu nowej kontrolki.
- Domyślny mount nie odczytuje ani nie wykonuje zadania. Jawny GET wymaga dostępności capability, aktualnego zwykłego administratora i ścisłego DTO oryginalnego job ID/kind. Zmiana kontekstu remountuje kontrolkę, a odpowiedź starego komponentu nie odblokowuje zapisu.
- Przed jednym POST następują świeże kontrole capability/aktora/zadania oraz ponowna kontrola aktora. Web Locks i trwały marker localStorage wiążą user/tenant/job. Marker jest zapisywany przed dispatch i nieusuwany po utracie odpowiedzi. Kolejne działania odczytują oryginalne zadanie.
- Właściwą granicę bezpieczeństwa zachowuje backend: świeża zwykła sesja admin, własny actor/job/plan/channel, wyłącznie jawny sandbox, trwała intencja, jedna dzierżawa i ponowna weryfikacja przed wyjściem do dostawcy. Marker przeglądarki jest tylko zabezpieczeniem UX.
- Niepewna odpowiedź, 401 lub błędny ACK nie są traktowane jako brak skutku ani zgoda na drugi zapis. Nowa kontrolka pokazuje ogólny błąd; treść testowego sekretu z odpowiedzi 500 nie trafia do niej.

## P2 — nieobsługiwany świeży zakup InPost — poprawione

Pierwotne `freshOrdinaryConnectorJob` w `web/ordinary-connector-job.tsx` wymagało dla każdego rodzaju poza `orders.sync` stanu planu `queued`. Jednocześnie `server/ordinary-connector-jobs.ts` jawnie dopuszcza dla `shipping` action `buy` parę `buy_queued/buy_ready`. Poprawne DTO tej operacji przechodziło ścisły parser, lecz funkcja świeżości zwracała false, więc przy użyciu tej kontrolki nie pojawiała się akcja wykonania.

Potwierdzenie: `0d7269` / EXIT0, wyekstrahowane rzeczywiste funkcje aktualnego modułu, syntetyczny poprawny DTO, bez React mount i bez API. To rzeczywista rozbieżność stanów, ale **nie blokuje obecnego callsite `orders.sync`**. Poprawka dopuszcza dokładnie trzy pary dla `shipping`: `queued/ready`, `buy_queued/buy_ready`, `queued/refresh_ready`. Dla `offer.write`, `shipping.dpd`, `dpd.collection` wymaga wyłącznie `queued/ready`. Regresja sprawdza wszystkie 36 kombinacji stanu/fazy oraz brak planu i niedozwolony plan dla orders.sync. Żadne nowe callsites nie zostały dodane. Dla aktualnego wydania należy zachować jawny wąski zakres zamiast deklaracji pełnego UI wszystkich 5 kinds.

## Weryfikacja

`node --test web/ordinary-connector-job.test.mjs` w DEV:

- końcowa oryginalna sesja `73170`, start `f67724`, terminal `f0574f` / EXIT0; wcześniejszy punkt review `38157/cb35b6/88dbbf` również EXIT0;
- 13/13 testów PASS (12 podprzypadków oraz grupa nadrzędna), 0 skipped, około 2.956 s;
- rzeczywisty React/JSDOM, rzeczywisty moduł api i SyncPanel; fetch, health, sesja, DTO, storage i Web Locks kontrolowane;
- utrata POST, 401 i błędny ACK; zmiana użytkownika i późna utrata roli; dwie zamontowane kontrolki; świeży GET; tryby wyłączony/readOnly/external block; brak wycieku błędu 500.

Middleware Vite nie uruchamiał serwera dostawcy ani aplikacji. Testy nie sprawdzają faktycznego logowania, MFAs, działania transakcji PG, oficjalnego sandboxa ani zwykłej obsługi w Chrome. Nie przyznają statusu `accepted` żadnemu wierszowi nowej matrycy.

## Referencje Source

- `development/full-base/web/ordinary-connector-job.tsx` — `75e791897c7cc807b593ca07fdca769da728feae7504baf82e649444cd648fc5`, 8579 B.
- `development/full-base/web/ordinary-connector-job.test.mjs` — `5ad47940a84833f6219020b36ae6b2c24004516e3498793ac74bfd2503485b46`, 15006 B.
- `development/full-base/web/sync.tsx` — `96148948b14de90ae17bfefc7c73c1c387f15589b322dda616677c8cf120520b`, 13658 B.
- `development/full-base/web/main.tsx` — `a8e21b23696676679cc39d623713de95d1ad713c57453eafc367c4fcdb752cfd`, 228093 B.
- `development/full-base/server/ordinary-connector-jobs.ts` — `76e5e74df24a68ecdbe9262861a9a79c43011c6a4fd0a865c951ed77da0f26da`, 13182 B.
- `development/full-base/web/api.ts` — `571d979f16ba1c283184887da54908118818737dee57c653081935574d8c4fdc`, 2935 B.
