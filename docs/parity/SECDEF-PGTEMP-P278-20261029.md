# SECURITY DEFINER `pg_temp` shadowing — finding, proof, mitigation (placeholder 278)

Placeholder 278 zintegrowany 29.10.2026 jako **migracja 262** (`262_revoke_public_temporary`, sekcja „Integracja jako 262”
na końcu), za zgodą Artura i z kontrolą startu. Opisy do sekcji integracji mówią o 278 jak w czasie przygotowania.

Data: 2026-10-29. Zakres: tylko lokalnie, bez push, bez scalania. Migracja 278 jest **placeholderem**
(plik `server/278_revoke_public_temporary.sql`, **nie** w `migration-manifest.mjs`); wymaga decyzji Artura
przed rejestracją, bo zmienia ustawienie bezpieczeństwa bazy (ACL). Źródło zgłoszenia: przegląd p277
(`docs/parity/STOCKTAKE-USAGE-P277-20261029.md`, gałąź `worktree-agent-a719ac1d0e629b92e`).

Weryfikacja na klonach PG04 `dynaminds_restore_36751abef3079f3f` → `migrate()` → HEAD (ledger 248,
`258_wz_issuer_refresh`): `_02` czysty HEAD (baza odniesienia), `_01` HEAD + 278. Wszystkie ataki jako
`dyna_app` w wycofanej transakcji. Pomocnicy: `local-builds/test-harness/` (`pw.txt` nie kopiowany).

## 1. Finding

Funkcja `SECURITY DEFINER` z `SET search_path = pg_catalog, public` (bez `pg_temp`) rozwiązuje
**niekwalifikowaną** nazwę relacji najpierw w schemacie tymczasowym sesji: PostgreSQL przeszukuje `pg_temp`
przed schematami z listy, gdy `pg_temp` nie jest na niej wymieniony. Sesja, która potrafi utworzyć tabelę
tymczasową o tej nazwie, podstawia (shadow) tabelę, którą funkcja definera czyta lub zapisuje.

Na klonie HEAD: `has_database_privilege('dyna_app', current_database(), 'TEMP')` = `true` (PUBLIC ma
domyślne `TEMPORARY`), a liczba funkcji `SECURITY DEFINER` bez `pg_temp` w `search_path` to **1130**
(schemat `public`) / **1141** łącznie z `ordinary187_private`, z **1327** wszystkich definerów. Rozkład
`search_path` definerów: `pg_catalog, public` 1099; `public, pg_temp` 167; `pg_catalog, public,
ordinary187_private` 31; `pg_catalog, public, pg_temp` 19. Wszystkie definery należą do `postgres`.

Dosięgalne tylko przez kogoś, kto wykonuje SQL jako `dyna_app` (np. przez SQL injection z możliwością
wielu instrukcji — `CREATE TEMP TABLE` jest osobną instrukcją, nie zmieści się w jednej wstrzykniętej
klauzuli), więc to **defense-in-depth**, ale potencjalnie wysokie (obejście limitu, fałszywa odpowiedź
strażnika, zapis omijający ograniczenia).

### Klasyfikacja 1141 definerów bez `pg_temp` (parsowanie `prosrc`, `classify.cjs`)

| ryzyko | liczba |
|---|---:|
| brak niekwalifikowanej relacji (bez dynamicznego SQL) | 644 |
| low — nieosiągalne wprost przez `dyna_app` (owner/migracja/wywołanie zagnieżdżone) | 263 |
| medium — osiągalne przez `dyna_app`, czyta niekwalifikowane relacje | 112 |
| **high — osiągalne przez `dyna_app`, zapisuje niekwalifikowaną relację** | **81** |
| **high — osiągalne przez `dyna_app`, odpowiedź boolowska z niekwalifikowanych odczytów** | **41** |

Osiągalne przez `dyna_app` łącznie: 439 (EXECUTE 307, przez trigger na tabeli zapisywalnej przez
`dyna_app` 133). Dynamiczny SQL (`EXECUTE format`/literal): 52 (parser je zaznacza — ich realne ryzyko
zależy od tego, czy kwalifikują nazwy w stringu; do przeglądu ręcznego, nie objęte zliczeniem relacji).
Z 79 bezargumentowych funkcji boolowskich `*_guards`/`*_valid`/`*guard`: 69 jest `SECURITY DEFINER` bez
`pg_temp`, z czego 32 odwołują się do niekwalifikowanych relacji, a 18 jest wykonywalnych wprost przez
`dyna_app`.

## 2. Proof (klon `_01`, HEAD, jako `dyna_app`, transakcja wycofana)

### 2a. Licznik limitu (235) — obejście + zapis do cienia

```
baseline previews (public.wms_evidence_usage, tenant a854…)         : 6
po zwykłym INSERT do wms_previews (kontrola, bez cienia)            : 7   -- licznik rośnie poprawnie
CREATE TEMP TABLE wms_evidence_usage(... slot, previews, bytes ...) : CREATE
po INSERT do wms_previews z aktywnym cieniem                        : 7   -- public NIE rośnie
pg_temp.wms_evidence_usage: shadow_rows=32 shadow_previews=1        -- cały zapis (INSERT 32 slotów + UPDATE) poszedł do cienia
public.wms_previews: real_preview_rows=8                            -- wiersz dowodu realnie powstał
```

Trigger `wms_evidence_usage_insert` → `wms_evidence_usage_track()` (`SECURITY DEFINER
search_path=pg_catalog,public`) → `wms_evidence_usage_add()` z niekwalifikowanym `wms_evidence_usage`.
Licznik firmy zostaje 0/stały → obejście limitu `wms_evidence` (potwierdza przewidywanie p277). Ten sam
przebieg pokazuje **zapis do cienia**: `INSERT ... SELECT generate_series(0,31)` i `UPDATE` wylądowały w
`pg_temp.wms_evidence_usage` (bez `CHECK`, `FK`, `RLS`), a nie w realnej tabeli.

### 2b. Zapieczętowany strażnik zwraca złą odpowiedź

`b2b_dropship_wms_change_allowed(old,new,op)` (`SECURITY DEFINER search_path=pg_catalog,public`) decyduje,
czy wolno zmienić niezmienną historię WMS (`wms_row_guard` na `wms_reservation_layers` przepuszcza zmianę,
gdy ta funkcja da `true`). Czyta niekwalifikowane `b2b_dropship_custody_transfers` i `b2b_dropship_orders`.

```
baseline_allowed (bez cienia, DELETE warstwy)                          : false
CREATE TEMP TABLE b2b_dropship_orders(...) + b2b_dropship_custody_transfers(...)  -- ukształtowane pod gałąź DELETE
shadowed_allowed (ten sam wywołanie)                                   : true
```

Strażnik przełączony `false → true`: sesja mogłaby obejść strażnika niezmiennej historii WMS.

### 2c. Zapis do cienia omijający ograniczenia

Pokazane w 2a (INSERT 32 slotów + UPDATE licznika do `pg_temp`). Dodatkowo `wms_evidence_usage_settle()`
(zapis do niekwalifikowanego `wms_evidence_settled`) jest również podatny; bezpośredniej demonstracji
nie dało pojedyncze wywołanie, bo `settle()` iteruje tylko operacje `created_at>=transaction_timestamp()`
(w wycofanej transakcji bez nowej operacji pętla pusta — 0 zapisów). Mechanizm jest identyczny jak w 2a.

### 2d. Szerszy fakt o modelu połączeń (poza zakresem 278)

Model to sesja `postgres` (superuser) + `SET LOCAL ROLE dyna_app`. Potwierdzone na klonie: `dyna_app` może
wyjść z roli jedną instrukcją i wrócić do superusera:

```
SET LOCAL ROLE dyna_app;  current_user=dyna_app  session_user=postgres
SELECT set_config('role','none',true);  -> current_user=postgres
RESET ROLE;                              -> current_user=postgres (usesuper=true)
```

Atakujący z możliwością wielu instrukcji jako `dyna_app` i tak odzyskuje superusera (`RESET ROLE`), więc
cień `pg_temp` jest słabszy niż to, co taki atakujący już ma. 278 zamyka cień dla atakującego **zamkniętego
w roli** `dyna_app`; ucieczka z roli to osobne, większe znalezisko (patrz §5).

## 3. Mitigation — placeholder 278

`server/278_revoke_public_temporary.sql`:

```sql
REVOKE TEMPORARY ON DATABASE <current_database> FROM PUBLIC;
GRANT  TEMPORARY ON DATABASE <current_database> TO   <owner=datdba>;
```

Wykonane w bloku `DO` z `current_database()` i `quote_ident` (poprawne na każdym klonie), z wczesnym
`RAISE`, gdy wykonujący nie jest właścicielem/superuserem. Dlaczego najtańsze i poprawne:

- Zdejmuje `TEMPORARY` z PUBLIC → sesja zamknięta w roli `dyna_app` nie utworzy już żadnej tabeli
  tymczasowej, więc cień znika dla **wszystkich** 1141 funkcji naraz, bez dotykania zapieczętowanego obiektu
  i bez zmiany jakiejkolwiek odpowiedzi strażnika.
- `GRANT` dla właściciela (`datdba`) zachowuje jedyne legalne użycie TEMP: funkcje `SECURITY DEFINER`
  właściciela, które tworzą `ON COMMIT DROP` tabele tymczasowe (167 `operative_delivery_*`, 168
  `parcel_physical_wz_*`). Tworzą je jako `current_user = owner`, nie `dyna_app` (§4).
- Runner migracji łączy się jako właściciel bazy (`server/db.ts`: `postgres` = `datdba`), więc ma prawo
  `REVOKE`/`GRANT ON DATABASE`. DB podstawiane dynamicznie przez `current_database()`.
- Transakcyjne (DDL ACL bazy działa w transakcji `migrate()`), idempotentne (ponowny `REVOKE`/`GRANT` jest
  bez-op).

## 4. Verification (klony PG04)

| sprawdzenie | wynik |
|---|---|
| `dyna_app` TEMP po 278 | `has_database_privilege('dyna_app',…,'TEMP')` = **false**; `datacl` = `{=c/postgres,postgres=CTc/postgres}` (PUBLIC traci `T`, owner ma `CTc`) |
| `dyna_app` `CREATE TEMP TABLE` po 278 | **ERROR 42501** „permission denied to create temporary tables” |
| atak 2a (cień licznika) po 278 | niemożliwy — `CREATE TEMP` odrzucone; zwykły INSERT: licznik `6 → 7` poprawnie |
| atak 2b (cień strażnika) po 278 | niemożliwy — `CREATE TEMP` odrzucone; `b2b_dropship_wms_change_allowed(...)` = **false** |
| funkcja definera właściciela tworząca TEMP po 278 (wołana jako `dyna_app`) | **działa** (probe zwraca 42; `current_user`=owner w ciele definera) |
| strażnicy 18 nazwanych | 18/18 `true`, bez zmian HEAD vs 278 |
| strażnicy 79 boolowskich | **wszystkie 79 wartości identyczne** HEAD (`_02`) vs 278 (`_01`); 64/79 `true` (15 `false` to strażnicy historycznych generacji `ordinary177…186_valid`, `large_import173_parents/pim`, `wave_print177…` — jak na HEAD w p277) |
| aplikacja — `tests/mirakl252.database.test.ts` (pełny `migrate()`, prawdziwa aplikacja, 60 s) na klonie `dynaminds_m252_20261029_01` z 278 | **8/8 pass** |
| aplikacja — `tests/base-wire-wms.database.test.ts` na klonie z 278 (`_91`, `_93`) | 0/2: `Query read timeout` (twardy 9 s w teście); **ten sam wynik na klonie bez 278** (`_92`), więc przyczyną jest obciążenie PG04, nie 278 |
| `run-bw.sh` (testy nie-DB + resource packaging) | **443/443 pass**; placeholder nie jest w manifeście, więc nie dotyka pakowania wydania |

Pliki dowodowe (sesja, scratchpad): `classify-01.json` (klasyfikacja), `guards-head.json` / `guards-278.json`
(strażnicy przed/po), logi `wirewms*.log`.

Nota o PG04: instancja jest współdzielona; w trakcie biegu aktywna była baza innej sesji
(`dynaminds_m259_20261029_02`). Twardy `pool.options.query_timeout = 9000` w teście bywa przekraczany pod
obciążeniem — to spowolnienie PG04, nie regresja 278 (ten sam test na klonie **bez** 278 zachowuje się tak
samo; 278 zmienia wyłącznie `datacl`, nie ścieżki zapytań).

## 5. Residual risk

- **Ucieczka z roli (`RESET ROLE`)** — model „superuser + `SET LOCAL ROLE dyna_app`” pozwala atakującemu z
  wieloma instrukcjami wrócić do superusera. To osłabia wartość 278 (i większości zabezpieczeń) wobec takiego
  atakującego i jest osobnym, poważniejszym znaleziskiem (handoff notuje je jako przyjęte nieblokujące).
  Realny fix: łączyć aplikację jako nie-superuser, albo `dyna_app` jako rola, do której nie da się wrócić
  superuserem. → karta osobnej sesji.
- **Długoterminowo**: każda nowa funkcja `SECURITY DEFINER` powinna mieć `pg_temp` **na końcu** `search_path`
  (migracja 258/273 już to robi: `search_path=pg_catalog,public,pg_temp`). To defensywa niezależna od ACL.
- **Zapieczętowane funkcje** (manifest 149 stocktake, 235 WMS evidence i inne definery zapięte odciskiem)
  nie mogą dostać `pg_temp` bez nowej generacji — 278 jest dla nich jedyną tanią osłoną.
- **Dynamiczny SQL (52 funkcje)**: zbudowane `EXECUTE` mogą kwalifikować nazwy; nie zliczono ich odwołań do
  relacji — do przeglądu ręcznego, poza zakresem 278 (278 i tak je osłania, bo zdejmuje TEMP).
- **`datacl` ginie przy klonie/odtworzeniu** (ustalenie z przeglądu bezpieczeństwa): `CREATE DATABASE …
  TEMPLATE` oraz zwykłe odtworzenie z dumpa do świeżej bazy **nie** przenoszą `datacl`, więc PUBLIC znów
  dostaje `TEMPORARY`, a 278 (jeśli jest już w ledgerze) się nie powtórzy. Nasz przepływ klonów uruchamia
  `migrate()` od nowa, więc dziś jest w porządku, ale produkcyjne odtworzenie kopii wymaga ponownego
  wymuszenia. Rekomendacja: asercja startowa `has_database_privilege('dyna_app', current_database(),
  'TEMP') = false` (łapie też cichy `GRANT TEMPORARY … TO dyna_app`, który cofnąłby poprawkę). Cold/startup
  inspection dziś **nie** sprawdza `datacl`, więc nic tego nie zgłosi.
- **Brak obejścia przez zainicjowany `pg_temp`** (zweryfikowane przez przegląd bezpieczeństwa): nawet gdy
  pooled-połączenie ma już zainicjowany schemat tymczasowy (po funkcji 167/168 właściciela), `dyna_app`
  `CREATE TEMP TABLE` dalej pada `permission denied for schema pg_temp_N` — PostgreSQL przy każdym tworzeniu
  sprawdza przywilej `TEMP` bazy na schemacie tymczasowym.

## Integracja jako 262 (29.10.2026, decyzja Artura)

Artur zatwierdził migrację 278 jako **262**, z warunkiem: start aplikacji odmawia, gdy po wpisie 262 w ledgerze
`dyna_app` ma `TEMPORARY` na bazie. Trzy commity przygotowania (6a8df90, 0a45966, e4db06f z
`worktree-agent-ac34a78614ccbf1de`) przeniesione cherry-pickiem bez konfliktu, potem trzy commity integracji (test
czerwony d104c20, migracja 69bb5bd, kontrola startu 3bd9c69) i ten dokument.

- SQL: `server/278_revoke_public_temporary.sql` → `server/262_revoke_public_temporary.sql`; zmienia się tylko pierwsza linia
  komentarza („Migration 262_revoke_public_temporary (prepared as 278, registered after 261_stocktake_evidence_usage; …)”);
  blok `DO` jak przygotowany (także jego komunikat „Migration 278 must run as the owner…”); 3 091 B, sha256
  `f5887c27b423b27aa1df7ce5fa37cbfe03af65c9b2f8d6108dfeda372a43f85a`. Wiersz manifestu `262_revoke_public_temporary`
  (`native_id` `revoke_public_temporary262`, kontrakt `revoke-public-temporary262`) po 261; `server/db.ts` bez zmian.
- **Zimny katalog nie widzi `datacl` — dowód.** Kompilacja na `dynaminds_m262_20261029_01` (szablon + 218…261 + ledger):
  0 dodań, 0 zmian, 0 usunięć; after262 = after261 `34f306f3…569e30d8` (47 070 rekordów), choć `datacl` zmienił się z
  `NULL` (domyślny: PUBLIC ma `TEMPORARY`, `dyna_app` TEMP = true, klon `dynaminds_m261_20261029_02`) na
  `{=c/postgres,postgres=CTc/postgres}` (`dyna_app` TEMP = false) (`m262-source-20261029-01/datacl-probe.json`). Czytnik
  katalogu obejmuje ACL relacji, funkcji i domyślne, nie ACL bazy. `revoke-public-temporary262-source-contract.mjs` (pusta
  delta), `-source-compatibility.mjs`: odwrotność to tożsamość; ponieważ katalog nie pokazuje 262, jej aktywność jest
  aktywnością kompletnego katalogu 261. Na każdej bazie zmigrowanej tym wydaniem (261 i 262 w jednej serii `migrate()`)
  parzystość markerów inspekcji zimnej się zgadza; baza na 261 bez wiersza 262 zostaje przez nią odrzucona. Samo ACL bazy
  sprawdza start (niżej). Jedna linia w `release-cold-projectors.mjs`.
- **Kontrola startu i odtworzenie.** `datacl` nie przechodzi przez `CREATE DATABASE … TEMPLATE` ani przez
  `pg_dump`/`pg_restore`: kopia znów daje PUBLIC `TEMPORARY`, a ledger mówi, że 262 była. `server/database-temp-privilege.ts`:
  `assertDatabaseTempPrivilege()` rzuca `DatabaseTempPrivilegeError` (kod `DATABASE_TEMP_PRIVILEGE`, polski komunikat z nazwą
  bazy, przyczyną i sposobem naprawy), gdy ledger ma 262 i `has_database_privilege('dyna_app', current_database(),
  'TEMPORARY')` jest true; `server/index.ts` woła ją zaraz po `migrate()`, przed `seed()` i `buildApp()`.
  `reapplyRevokePublicTemporary()` wykonuje ponownie dokładny blok `DO` 262 (wklejony bajt w bajt, test przypina go do
  pliku; czytnik zasobów wiąże plik z `server/db.ts`), gdy odtworzony ledger ma 262, i wymaga warunku startu;
  `restoreBackup()` (`server/recovery.ts`) robi to po ostatnim kroku `pg_restore`, przed weryfikacją kopii. Kopia MIG-4
  (bez 262) zostaje bez zmian. Jawne `GRANT TEMPORARY … TO dyna_app` przeżywa `REVOKE … FROM PUBLIC`, więc start dalej
  odmawia (nic tego nie ukrywa). `server/db.ts` nietknięty (bez re-pinu rosteru), `recovery.ts` i `index.ts` nie są
  przypięte w repo. Profil operatora kopii (`tools/local/backup-operator.mjs`, `sourcePins` poza repo) trzeba przypiąć
  ponownie przy następnym użyciu, bo zmienił się `server/recovery.ts`.
- Skutek dla klonów PG04 i kopii skali: klon z szablonu ma `TEMPORARY` dla PUBLIC do czasu, aż `migrate()` zastosuje na
  nim 262 (oczekiwane). Kopia bazy już zmigrowanej do 262 przez `CREATE DATABASE … TEMPLATE` (np. kopia `_71` przed testem
  obciążenia) nie uruchomi wydania, dopóki właściciel nie wykona bloku `DO` z `server/262_revoke_public_temporary.sql`.
- Ledger 252 (guard: przyszłe `263_…`, `264_…`); MIG-2 stosuje 244…262; MIG-1 i MIG-4 oczekują serii 244…262; 261 nie
  jest już ostatnia; rodzina `m262` w testach DB 236…261 i testach torów 259–261.
- `docs/parity/INTEGRATION-p278.md` usunięty (treść tutaj).

| Sprawdzenie (PG04, klony `dynaminds_m262_20261029_NN`; wyniki w `m262-source-20261029-01/`) | Wynik |
|---|---|
| bez bazy: `tests/revoke-public-temporary262.test.ts` + zgodność 262 na commicie testu (84159e4) / po integracji | czerwony (brak modułów `database-temp-privilege` i kontraktu 262) / 8/8 |
| `tests/revoke-public-temporary262.database.test.ts` na nowym, niezmigrowanym `_02` | 3/3: przed 262 `datacl` NULL, `dyna_app` tworzy tabelę tymczasową, kontrola milczy; po `migrate()` `{=c/postgres,postgres=CTc/postgres}`, `dyna_app` `CREATE TEMP TABLE` → 42501, właściciel może; `GRANT TEMPORARY … TO PUBLIC` → kontrola i prawdziwy `server/index.ts` odmawiają (czerwony), ponowne 262 z ścieżki odtworzenia → zielony; jawny grant dla `dyna_app` dalej odmawia |
| strażnicy na `_02` (jit=off, UTC; `guards-A-02.json`) | ledger 252, ostatnia `262_revoke_public_temporary`; 18 nazwanych true |
| wszystkie 79 boolowskich strażników (`allguards-262-02.json`) | 64/79 true, wszystkie 79 wartości identyczne z klonem 260 (`m261-source-20261029-01/allguards-260-02.json`) |
| inspekcja zimna na `_02` (`cold-A-02.json`) | COLD_INSPECTION_PASSED, sha = after261/after262 `34f306f3…`, flagi 216…262 true |
| MIG-2 (`_06`, 218…243 ręcznie, potem `migrate()` 244…262) / MIG-1 (`_07`) / MIG-4 (`_08`, zdjęcie szablonu w `DYNA_IMAGE_DIR`) | 1/1 / 3/3 / 1/1 |
| `run-bw.sh` (drzewo z 262) | 458/458 |
| `tests/revoke-public-temporary262-source-compatibility.test.mjs` z opt-in na prawdziwych katalogach | 4/4 |
