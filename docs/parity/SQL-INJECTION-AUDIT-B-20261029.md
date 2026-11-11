# SQL injection — audyt wszystkich ścieżek SQL i lint, który go pilnuje (decyzja B)

Data: 2026-10-29. Zakres: tylko lokalnie, bez push. Gałąź od `goal/full-base-20261017` (HEAD `b92d6b5`).
Decyzja Artura (29.10, wariant B): aplikacja nadal loguje się jako superuser `postgres` i w każdej
transakcji robi `SET LOCAL ROLE dyna_app` (osobny, późniejszy tor W1 to logowanie nie-superuserem; zob.
`docs/parity/DB-LOGIN-ROLE-P279-20261029.md` §2.2 na gałęzi `worktree-agent-a2cb8ca7e8b7d0555` oraz
`docs/parity/W1-A-PROGRESS.md` na gałęzi `worktree-agent-a31573900a457f8af`). Dopóki tak jest, każde SQL
injection daje superusera, więc wstrzyknięcie trzeba wykluczyć na każdej ścieżce i pilnować testem.

## 1. Dlaczego każde wstrzyknięcie to superuser — także jednoinstrukcyjne

Nie trzeba `; RESET ROLE` (drugiej instrukcji, którą protokół rozszerzony z parametrami odrzuca).
Wystarczy wyrażenie w jednym `SELECT`. Klon `dynaminds_sqli29_20261029_01`, wycofana transakcja:

```
SET LOCAL ROLE dyna_app
SELECT current_user, rolsuper                              → dyna_app, false
SELECT count(*) FROM (SELECT set_config('role','none',true)) s   → 1     -- np. wstrzyknięty fragment
SELECT current_user, rolsuper                              → postgres, true
```

`set_config('role', …)` jest dozwolone, bo `session_user` to `postgres`. Wniosek: liczy się każda
możliwość dopisania tekstu SQL, nie tylko wiele instrukcji.

## 2. Metoda

### 2a. Kod TypeScript — każde wywołanie `.query(`

Narzędzie: `tests/sql-text-lint.ts` (bez bazy, bez zależności — lekser TS i mały ewaluator po tokenach).
To **heurystyka konserwatywna, nie dowód formalny** (bez kompilatora typów); luki, które znalazł przegląd,
są zamknięte i pilnowane fiksturami (§5), znane ograniczenia w §6.
Zbiór: wszystkie `server/**/*.{ts,mts,mjs}` i `shared/**/*.{ts,mts,mjs}` (1 105 plików: 940 `.ts` + 165
`.mjs`/`.mts`; 459 z wywołaniem `.query(`), czyli kod tras HTTP, workerów, importów i integracji oraz
`shared/large-import-dependencies`. Dwa pliki `.tsx` w tych katalogach nie mają `.query(`. Miejscem do
sprawdzenia jest każde wywołanie `x.query(…)`, `x.query<T>(…)`, `x.query?.(…)`, `x.query!(…)`, `(x.query)(…)`,
`(x.query as T)(…)` (dowolny odbiorca: `c`, `pool`, `client`, `lock`, `owner`, `reader`, adaptery); sprawdzany jest
pierwszy argument (albo `text` obiektu `{ text, values }`, bo tak czyta go `pg`). Jako (c) bez oceny tekstu liczą
się: `x.query.call/apply/bind`, `x['query'](…)`, wywołanie po nieznanym kluczu na kliencie, metoda `query` użyta
jako wartość (`f = c.query`, `run(c.query)`, `{ q: c.query }`, `Reflect.apply(c.query, …)`) i destrukturyzacja
właściwości `query` — poza obiektami żądania (parametr handlera tras, typ `…Request`, nazwa `req/request/r/
original/raw`, wiązanie używane z `.body/.params/.headers/…` lub `x.query.k`), gdzie `query` to dane.

Klasy (z zadania):
- **(a)** stały literał lub sklejone literały;
- **(b)** tekst zbudowany tylko ze stałych (zakres `const`/`let` blokowy, `var` funkcyjny): szablony, `?:`,
  `||`/`??`, liczby (`Number()`, arytmetyka
  inna niż `+`), stałe obiekty/tablice modułu (`${S.x}`, `MAP[k]`, `LIST.join()`), funkcje repozytorium
  śledzone do ich `return` (z parametrami związanymi z argumentami wywołania), parametry śledzone do
  każdego miejsca wywołania (także przez `import`, import domyślny, `export { a as b }`, beczki
  `export { … } from` / `export * from`, `import * as`, `await import()`; metoda przez każde `.name(` w
  dowolnym pliku, także `x.name!(…)`, a odwołanie do metody jako wartość, przez `['name']` lub
  destrukturyzację = (c); wywołanie po kluczu `x[k](…)` / `N[k](…)` / `m[k](…)` z `await import()` liczy się
  jako wywołanie każdej funkcji o nazwie, którą `k` może przyjąć — klucz nieznany = wywołujący nieznani;
  obiekt z metodą, przestrzeń nazw lub wiązanie `await import()` użyte inaczej niż `N.x` (`(svc as any)[k]`,
  `Object.values(svc)`, `const {[k]: f} = svc`, przekazanie dalej) = wywołujący nieznani), callbacki
  `.map/.filter/…` (element bezpiecznej tablicy, indeks to liczba), klucze literałów obiektów
  (`Object.keys`). Wiązania: każda inicjalizacja, przypisanie, `+=`, zapis `push/unshift/set/add/splice/
  fill` i przypisanie pola (także przez `x!`, `(x)`, `(x as T)` i w innym module, który importuje stałą) —
  wartości zapisu muszą być bezpieczne. Dla wartości, która może być tablicą/obiektem (wszystko poza
  literałem tekstu/liczby, także po ponownym przypisaniu), działa **lista dozwolonych odczytów**: każde
  inne użycie jest ucieczką i daje (c). Odczyt to: metoda zwracająca tekst/liczbę/boolean (`.join`,
  `.includes`, `.indexOf`, `.has`, …), `.length`/`.size`, `.map/.filter/.slice/.find/…` (wynik śledzony
  dalej; callback nie może zapisywać elementu, gdy elementy mogą być kolekcjami), odczyt `x[i]`/`x.p` w
  szablonie, arytmetyce, porównaniu lub warunku, spread `[...x]`, argument funkcji repozytorium, która nie
  zmienia i nie wydaje parametru (sprawdzane w jej ciele, także dla metod tej samej nazwy), oraz alias
  `const t = x[k]`, którego wszystkie użycia też są odczytami. Ucieczka: `return x`, `= x`, `?:`/`||`/`??`/
  `&&` z `x` jako wartością, `x` w literale tablicy/obiektu, nieznana metoda (`x.update(…)`, `o.get()`),
  nieznana funkcja, `Object.assign/values/defineProperty`, `Reflect.*`, element pętli `for…of` lub
  callbacku, który ucieka, `await x`, operator przecinka, rzutowanie `<T>x`, spread obiektu lub tablicy o
  elementach-kolekcjach, wywołanie metody obiektu, który ma własne metody (mogą pisać przez `this`), klasa
  (statyczne pola), zapis przez destrukturyzację (`({ x } = …)`, `[x] = …`) lub nagłówek `for (x of …)` do
  istniejącego wiązania, ostatni argument callbacku tablicy (sama tablica). Parametr używany jako kolekcja nie
  może być zmieniany ani wydawany w swojej funkcji (gdy któryś wywołujący podaje kolekcję). Wywołanie
  rozstrzyga wiązanie widoczne w miejscu wywołania (parametr albo lokalna wartość o nazwie funkcji to nie ta
  funkcja); `as`/`satisfies`/`in`/`instanceof` jako nazwy właściwości nie są operatorami, a wyrażenie po
  `x as T` (`x as T + y`) nie jest akceptowane; argumenty typów `f<A, B>(…)` nie dzielą listy argumentów;
- **(c)** tekst, który zależy od danych z żądania, importu, providera lub bazy — wszystko, czego lint
  nie potrafi udowodnić jako (b). Każde takie miejsce przejrzałem ręcznie.

Lint jest konserwatywny: czego nie umie prześledzić (parametr callbacku przekazanego jako wartość,
funkcja eksportowana bez wywołania w `server/`+`shared/`, metoda bez wywołującego, destrukturyzacja z
domyślnymi wartościami), to jest (c). Inwentarz `docs/parity/w1a-280-evidence/sql-calls.json`
(gałąź `worktree-agent-a31573900a457f8af`) dotyczy wywołań funkcji SQL po nazwie; jego 11 rekordów
„dynamic-sql” (`SELECT public.${fn}(…)` w `catalog-stock-control.ts:144,147`,
`catalog-stock-return-effects.ts:67`, `large-import/quota-lease-renewal.ts:32`) lint niezależnie
klasyfikuje jako (b) — nazwa funkcji to wybór spośród literałów. Zgodne.

### 2b. SQL w bazie — funkcje z dynamicznym `EXECUTE`

Klon PG04 `dynaminds_sqli29_20261029_01` = `TEMPLATE dynaminds_restore_36751abef3079f3f` + prawdziwy
`migrate()` tej gałęzi (ledger 252, ostatnia `262_revoke_public_temporary`). Z `pg_proc` wszystkie funkcje
plpgsql/sql spoza `pg_catalog`/`information_schema`, których źródło zawiera słowo `EXECUTE` (107), z ACL
(`has_function_privilege('dyna_app', …, 'EXECUTE')`) i triggerami. Lekser SQL (literały `'…'`, `E'…'`,
`$tag$…$tag$`, komentarze) zostawia tylko instrukcje `EXECUTE` na poziomie kodu (pomija `GRANT EXECUTE`,
`EXECUTE FUNCTION` i tekst manifestów). Dla każdej: tekst przed `USING`/`INTO` sklasyfikowany jako literał,
`format()` z mapą specyfikatorów na argumenty (`%I`/`%L` cytują; `%s` sprawdzany), konkatenacja `||`
(części w `quote_ident/quote_literal/format_type` albo literały) albo zmienna (śledzona ręcznie do źródła).

## 3. Liczby

### TypeScript (`docs/parity/sqli-b-evidence/ts-sites-summary.json`)

| klasa | miejsca |
|---|---:|
| (a) literał | 7 550 |
| (b) wykazane przez lint jako stałe | 684 |
| na liście przeglądu (`tests/sql-text-allowlist.json`) | 62 |
| **razem `.query(`** | **8 296** |

(`server/`: 7 351 / 609 / 45; `shared/large-import-dependencies`: 199 / 75 / 17.) 62 pozycje listy według
źródła tekstu:

| źródło | liczba | ocena |
|---|---:|---|
| stała, której lint nie domyka (zwrot obiektu z helpera, element pętli kopiowany do wyniku, spread parametrów, alias odpowiedzi, callback przekazany jako wartość) | 23 | (b) |
| zrecenzowany SQL pakietu profilu startowego (`.mjs` w `shared/large-import-dependencies`, inspektory właściciela, sha256 sprawdzany przed użyciem) | 13 | (b) — kod, nie żądanie |
| plik SQL migracji (`readRuntimeResource`) w `migrate()` | 5 | (b) — kod |
| identyfikator z katalogu (`pg_attribute`, `pg_constraint`, `pg_tables`, katalog packing189) cytowany `"…"`/`quoteIdentifier` albo z regexem | 7 | (b) |
| migawka operatora w narzędziu odtwarzania (baza `dynaminds_restore_*`), sprawdzona z katalogiem i cytowana | 3 | (b) |
| nazwa bazy wygenerowana (`randomBytes`) lub z regexem `^dynaminds_restore_[a-f0-9]{16}$` | 3 | (b) |
| liczba sprawdzona `Number.isSafeInteger` i zakresem tuż przed użyciem (`migration-bootstrap.ts` lock/statement timeout) | 2 | (b) |
| `pg.escapeLiteral(id)::uuid` w paczce simple-query (`order-detail-rows.ts`) | 1 | (b) — poprawne cytowanie |
| **liczba z żądania** `LIMIT ${q.limit+1}`, `q.limit` = `z.coerce.number().int().min(1).max(50)` | 3 | (c), nie do wstrzyknięcia |
| **kolumny z żądania** przez `z.enum(CATALOG_EXPORT_COLUMNS)` (`catalog-export.ts` readBatch) | 1 | (c), whitelist |
| **zapisana konfiguracja** `config.identity` (`catalog-file-import.ts` identityMatches) | 1 | (c), whitelist w zapisie |

### SQL w bazie (`docs/parity/sqli-b-evidence/secdef-execute.json`)

Na klonie: 1 725 funkcji, 1 333 `SECURITY DEFINER`, 392 definerów wykonywalnych przez `dyna_app`.
Słowo `EXECUTE` w źródle ma 107 funkcji; instrukcję `EXECUTE` na poziomie kodu ma **38** (34 definery,
4 invokery) — **65 instrukcji**. (Dokument SECDEF-PGTEMP-P278 podaje „52” z innego parsera, który liczył też
`EXECUTE` w tekstach; tamte funkcje są podzbiorem 107 i przeszły tę samą klasyfikację.)

| konstrukcja | instrukcje | źródło części niecytowanych |
|---|---:|---|
| `format()` tylko z `%I`/`%L` (lub `%s` z `quote_*`) | 51 | — |
| literał | 2 | — |
| `format('%s')` | 5 | `CASE` z literałów (`return_destination_*`), stała tablica kluczy `k` (`stocktake_adjustment_usage_track*`) |
| zmienna | 6 | `CASE TG_OP`/`TG_TABLE_NAME` z literałów (3 definery-triggery, 3 invokery-triggery) |
| konkatenacja | 1 | `string_agg(format('%I.%I', …))` z `pg_constraint` (`cooperation171_public_drain`) |

Ścieżki osiągalne przez aplikację: 9 instrukcji w definerach wykonywalnych przez `dyna_app`
(`buyer_address_block_reason`, `competitor_observation_guards`, `stock_file_import_snapshot`, …) i
w 11 definerach-triggerach — wszystkie nazwy pochodzą z list literałów w ciele funkcji albo z
`TG_TABLE_NAME`, przez `%I`. **Żaden argument funkcji ani wiersz tabeli zapisywalnej przez `dyna_app` nie
trafia do tekstu `EXECUTE` bez cytowania.** Nie ma `query_to_xml`, `dblink`, `COPY … PROGRAM` ani
`pg_read_file` w funkcjach aplikacji.

## 4. Znaleziska i poprawki

**Nie znalazłem wstrzyknięcia możliwego do wykonania** — ani w TS/MJS (8 296 miejsc: 7 550 literałów,
684 wykazane heurystyką, 62 przejrzane ręcznie), ani w dynamicznym SQL definerów (65 instrukcji). Dlatego nie ma testu „payload zmienia zapytanie” dla realnej podatności; jest
test, że każdy taki payload zostałby złapany (§5).

Klasa (c) — dane z zewnątrz w tekście SQL, ale niewykonalne:

1. `server/ksef243.ts` `listInvoicesInTx`: `LIMIT ${q.limit + 1}` (`q` = `purchaseListQuery.parse`,
   liczba całkowita 1–200). **Poprawione** (`bdc1440`): `LIMIT $n::integer` z wartością w parametrach.
   Czerwony przed poprawką: lint (`sqli-b-evidence/lint-red-ksef243-before-fix.txt`). Dowód na klonie `_01`
   jako `dyna_app` (wycofane): lista bez filtrów, z `limit`, i z `kind+from+to+q` (6 parametrów) działa;
   gdyby do `limit` dostał się tekst, PostgreSQL odrzuca go jako `invalid input syntax for type integer`,
   zamiast wkleić go do zapytania.
2. `server/b2b-credits.ts`, `server/b2b-invoices.ts`, `server/fa3-drafts.ts` `listInTx`: ten sam wzorzec
   `LIMIT ${q.limit+1}` z `z.coerce.number().int().min(1).max(50)`. **Nie zmienione**: pliki są przypięte
   hashem (`server/catalog-stock-writer-coverage.ts`) i należą do obszaru faktur; nie da się wstrzyknąć,
   więc koszt re-pinu nie ma pokrycia. Na liście przeglądu.
3. `server/catalog-export.ts` `readBatch`: `AS ${k}` z `q.columns` — `z.array(z.enum(...))` stałych kluczy.
   Whitelist; na liście.
4. `server/catalog-file-import.ts` `identityMatches`: `${kind}` z `config.identity` — przy podglądzie
   z `z.enum(['id','sku','ean','name'])`, przy wykonaniu z wiersza podglądu zapisanego przez aplikację i
   porównanego hashem z ponownie sparsowanym żądaniem (`catalog-file-import-eligibility.ts:23`). Second-order
   tylko wtedy, gdy ktoś zapisze wiersz SQL-em — co ten audyt wyklucza. Plik przypięty; na liście.

Zapieczętowany SQL i pliki `local-invoice*` — bez zmian; żadne z nich nie ma miejsca (c)
(`local-invoices.ts`, `local-invoice-*.ts`, `tax226-local-invoices.ts`: wszystkie wywołania to (a)/(b)).

## 5. Lint i test

- `tests/sql-text-lint.ts` — analizator (opis metody w nagłówku pliku).
- `tests/sql-text-allowlist.json` — 62 przejrzane wyjątki: `file`, `fn`, `key` (sha256, 16 hex,
  znormalizowanego wyrażenia tekstu SQL), `class`, `why`. Każda zmiana wyrażenia unieważnia wpis.
- `tests/sql-text-lint.test.ts` (`node --test` przez tsx, bez bazy, ~5 s, 221 testów):
  1. każde `.query(` jest (a), (b) albo na liście — inaczej lista miejsc z łańcuchem powodu;
  2. lista jest aktualna: wpis bez pasującego miejsca albo bez powodu = błąd;
  3. korpus: > 900 plików, > 8 000 miejsc (regresja leksera nie przejdzie po cichu);
  4. 76 wstrzyknięć, które muszą zostać złapane (szablon, `+`, WHERE przez `push`, pole obiektu `+=`,
     helper z parametrem, `.map`, import, alias tablicy, `.length` JSON-a `{"length":"1;…"}`,
     destrukturyzacja, nadpisany parametr domyślny, gałąź `?:`, `String()`/`toString()`, `Object.keys(body)`,
     `for…of`, `let` + przypisanie, `{ text }`, funkcja przekazana jako wartość, eksport bez wywołania,
     spread `req.body`, `new Array(...)`, wywołanie generyczne `f<T>()`; oraz 19 przypadków z przeglądu
     bezpieczeństwa: import domyślny, beczki `export {…} from` i `export *`, metoda jako wartość /
     destrukturyzowana / po kluczu `['run']` / jako callback, tablica z `?:` lub `split()` wypełniana przez
     helper, helper o nazwie jak wbudowana (`add`), tablica w innej tablicy, akumulator `reduce`, parametr
     zmieniany w funkcji wywoływanej, eksportowany obiekt/tablica zmieniane przez importującego, `valueOf()`,
     `.length` pola nadpisywanego spreadem, `c.query.call(…)`, `c['query'](…)`; oraz 35 przypadków z
     drugiej rundy przeglądu: alias przez `return`, funkcję tożsamości, `?:`/`||` (także w funkcji
     wywoływanej), odbiorcy `where!.`, `(where).`, `(where as T).`, metody `h.update(where, x)`/`h.get(…)`,
     zagnieżdżone aliasy obiektu (`o.a` zaliasowane, `Object.assign(o.a, …)`, `Object.values(o)` w pętli,
     getter `this.a`, destrukturyzacja), `defineProperty`/`Reflect.set`, `splice`/`push.apply`, tablica
     w obiekcie, wywołanie po kluczu (`svc[k](…)`, `B[k]`/`B['run']` na przestrzeni nazw, `m['run']`/`m[k]`
     z `await import()`), `svc.run!(…)`, ponowne przypisanie tekstu na tablicę, eksportowana tablica
     zwracana/zapisywana przez importującego); oraz z `tests/sql-text-lint-review3.ts` 131 przypadków trzeciej
     rundy (zasięg blokowy, `f<A, B>()`, `.query?.(`/`!(`/`(c.query)(`/jako wartość/destrukturyzacja/
     `Reflect.apply`/klucz liczony, zapis przez destrukturyzację i nagłówek `for`, `as`/`in` jako nazwy
     właściwości i ogon po `as T`, `<T>x`, wywołanie parametru o nazwie funkcji, dyspozycja przez zmienną/
     `Object.values`/przestrzeń nazw/`await import()`, metody budujące przez `this`, klasy, gettery, klucze `Map`,
     `await`/przecinek/spready/trzeci argument callbacku, cykl `paramMutated`, `await import()` u
     importującego, `for (v of …)` z wcześniejszym `v`, prototyp, domyślne w parametrze, metoda z kluczem
     liczonym, lekser po `.of`) z 4 kontrolami, i 6 stałych wzorców, które muszą
     zostać zielone (parametry, WHERE z `$n`, mapa stałych, liczby, stała lista tabel, `?:` literałów).
     Powody werdyktów: `sqli-b-evidence/fixture-reasons.txt`;
  5. mutacja prawdziwego pliku: w `crm.ts` `listCrmClients` zamiana `ILIKE $${params.length}` na
     `ILIKE '${q[k]}'` musi dać dokładnie jedno nowe miejsce (c).
- **Mutacja ręczna w drzewie** (wymóg zadania): `server/portal-routes.ts:328` dopisane
  `AND kind<>'${(req.body as any).x}'` → test czerwony (`lint-red-mutation-portal-routes.txt`, powód:
  `.x` of `.body` of parameter `req`); po cofnięciu zielony 221/221 (`lint-green.txt`).
- **Przegląd bezpieczeństwa** (subagent security-reviewer na diff + dokument): pierwsza wersja miała
  fałszywe negatywy (wywołujący niewidoczni przez import domyślny/beczki/metodę jako wartość; mutacja
  śledzona po kształcie inicjalizatora i nazwie funkcji; `valueOf`; spread przy `.length`; `.query.call`,
  `['query']`; brak `.mjs`). Wszystkie zamknięte w lincie i dodane jako fikstury (wyżej); po zmianach lint
  znalazł 19 nowych miejsc w `.mjs` — przejrzane i na liście, żadne nie pochodzi z żądania. Druga runda
  znalazła kolejne fałszywe negatywy (klasy wyżej); zamiast łatać przypadki lint ma teraz listę dozwolonych
  odczytów dla kolekcji i obsługę wywołań po kluczu. Po zmianie 16 nowych miejsc w `server/` (helpery
  zwracające obiekt, elementy pętli kopiowane do wyników, liczby walidowane w miejscu) — przejrzane, na
  liście, żadne nie pochodzi z żądania. Trzecia runda (świeży recenzent) znalazła 17 klas fałszywych negatywów;
  wszystkie zamknięte i pilnowane fiksturami (131 przypadków w `tests/sql-text-lint-review3.ts`). Po zmianie
  3 wpisy listy przestały być potrzebne (zasięg blokowy), doszedł 1 (`ksef243` — spread parametrów).

## 6. Ryzyko rezydualne

- Lint jest heurystyczny (bez kompilatora typów); 684 „wykazane” miejsca opierają się na tej heurystyce;
  trzy rundy przeglądu za każdym razem znajdowały nowe klasy obejść, więc należy zakładać, że istnieją
  kolejne. Zakres `const`/`let` jest blokowy (blok, nagłówek `for`), `var` funkcyjny. Metody są dopasowane po
  nazwie: `x.name.y`, `x.name[i]`, `x.name = …` i porównania `x.name` nie są uznawane za wyjęcie metody
  (to zwykle właściwość innego obiektu, np. `req.query`). Parametr 0 adaptera `query` jest uznany za
  bezpieczny, bo każde jego wywołanie to też `.query(` sprawdzane przez lint. Kształt elementów (czy element
  tablicy może być kolekcją) jest znany tylko dla literałów i ich `push`; elementy z wyników zapytań lub
  parametrów są traktowane jak kolekcje (ostrożnie). Funkcja wywoływana przez `Reflect.apply`,
  `Function.prototype` lub `eval`, i `query` destrukturyzowane z klienta pg (`const {query} = c`) nie są
  wykrywane (w repo nie występują). Wywołań po kluczu `x[k](` jest w repo 7: 6 × `app[method]` w trasach (klucz
  z literałów `'post'|'patch'`) i `[...x][0]!(…)` w `scoped-automation-worker.ts:15` z kluczem nieznanym — przez
  nie wszystkie metody repozytorium mają „wywołujących nieznanych” (ostrożnie). Obiekty żądania rozpoznawane są
  po konwencji (parametr handlera, typ `…Request`, nazwy `req/request/r/original/raw`, użycie `.body`/
  `.params`/…): klient pg nazwany `req` i przekazany jako wartość `req.query` nie zostałby zgłoszony.
  Parametr 0 metody `query` adaptera jest ufany; wyjęcie takiej metody jako wartość zgłasza osobna reguła.
- Poza zbiorem: `scripts/`, `tools/`, `web/` (CLI i front, nie ścieżki żądania), pliki `*.sql` migracji
  (kod), biblioteki z `node_modules`. Inspektory startowe `.mjs` wykonują SQL z pakietów profilu — tam
  kontrolą jest integralność pakietu (sha256), nie cytowanie. Wykrywanie funkcji: 3 z 21 126 nagłówków nierozpoznane
  (generatory, nie SQL).
- Wiersz zapisany w bazie i użyty jako identyfikator (second-order) jest bezpieczny tylko tak długo, jak
  nikt nie zapisuje go SQL-em — to samo założenie, które ten lint chroni.
- `LIKE`/`ILIKE` ze wzorcem z żądania to semantyka filtra (`%` jako dane), nie wstrzyknięcie SQL.
- Dynamiczny SQL definerów sprawdzony jednorazowo na klonie; nowa migracja z `EXECUTE format('%s', arg)`
  nie jest pilnowana testem bez bazy (zob. §7).

## 7. Związek z W1

W1 (logowanie jako nie-superuser) usuwa przyczynę, dla której każde wstrzyknięcie = superuser
(§1: `set_config('role','none')`/`RESET ROLE` wracają do `session_user`). Do tego czasu ten lint jest
jedyną automatyczną zaporą; po W1 nadal chroni dane między firmami (RLS omijane przez wstrzyknięty SQL
jako `dyna_app` → nadal `dyna_app`, ale z dowolnym `app.tenant_id` przez `set_config`). Allow-lista nie
zawiera nic, co po W1 zmieniłoby ocenę. Sprawdzenie `EXECUTE` w definerach (2b) warto powtórzyć jako test
bazowy przy kolejnych migracjach z dynamicznym SQL.

## 8. Weryfikacja

- `node node_modules/tsx/dist/cli.mjs --test tests/sql-text-lint.test.ts` — 221/221.
- Testy pinów: `tests/catalog-stock-writer-coverage.test.ts`, `tests/full-base-scale-http-ports.test.mjs`
  — 68/68 (żaden przypięty plik nie zmieniony; `ksef243.ts` nie jest przypięty).
- `npx tsc --noEmit -p .` — czysto.
- `run-bw.sh` (główny checkout) 458/458; ta sama lista plików w tym worktree 458/458.
- Klon `dynaminds_sqli29_20261029_01` zostawiony na PG04 (tylko odczyt i wycofane transakcje).
