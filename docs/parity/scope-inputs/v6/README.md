# Zakres v6: trzech dostawców fali 1, nadal częściowy

[scope.v6.json](../../scope.v6.json) ma **2612 wymagań**: wszystkie 2589 rekordów v5 bez zmian plus 23 nowe klucze. Rodzicem jest przypięty `scope.v5.json` (2 305 202 B, SHA256 `be41647b…`). Plik wygenerował istniejący `createScopeSnapshot` z [requestu](../../scope.v6.request.json), z jawnym `--root=/Users/arturtwardowski/DYNA Ecomerce`. Domyślny root CLI to `development/` i nie obejmuje wejść w `local-app`.

Wejścia `domains`, `providerRoster` i archiwum dowodów (`mirakl-v5-20261019`) są identyczne jak w v5. Zmienia się tylko [integrations.json](integrations.json). Jego pierwsze 324 wiersze, 15 dostawców, `coverage_gaps` i `cross_cutting_gaps` są wartościowo identyczne z zamrożonym wejściem v2. Na końcu doszli trzej dostawcy z decyzji Artura z 22.10.2026 ([Goal](../../../FULL-BASE-GOAL.md), fala 1):

- **KSeF** (`ksef`, bezpośrednio API MF, niezależnie od Fakturowni) ma 7 operacji: `connection`, `invoice.send.fa3`, `invoice.status`, `invoice.upo`, `invoice.number`, `offline.mode`, `invoices.received.download`.
- **Poczta Polska** (`pocztapolska`, Envelo/eNadawca) ma 6 operacji: `connection`, `shipment.create`, `label.pdf`, `tracking.read`, `pickup_point` (doręczenie do punktu/placówki), `cod`.
- **DHL Parcel Polska** (`dhl`, WebAPI2) ma 7 operacji: `connection`, `shipment.create`, `label.pdf`, `tracking.read`, `pickup.book`, `cod`, `points.search`.

Wiersze mają tę samą strukturę co wiersze v5 z tej samej rodziny operacji (`operation_contract.family`): cztery scenariusze odbioru (pozytywny, negatywny, utrata ACK/odpowiedzi, readback) z niezmiennikami rodziny i opisem specyficznym dla operacji. Każdy wiersz ma status `planned_acceptance_unverified`, puste dowody na wszystkich poziomach i `required_evidence_level:account`. Dostawcy mają `registry_line:null`, bo `server/integrations.ts` ich nie deklaruje. Adresy dokumentacji podano bez pobierania w tym audycie.

Zakres nadal jest częściowy: `scope_complete:false`, `acceptance_granted:false` i 33 otwarte luki. Stan kodu każdej operacji opisuje [audyt luk fali 1](../../INTEGRATIONS-WAVE1-GAP-20261025.md).

Weryfikacja plikowa: `node --test tools/parity/scope-v6-wave1.test.mjs`. Test sprawdza pin rodzica, zachowanie wszystkich rekordów v5 i dokładną listę 23 dodanych kluczy. Sprawdza też, że generator odtwarza v6, że checker przyjmuje inwentarze (89 plików dowodów) oraz że odmawia `complete`, zmiany definicji, usunięcia wiersza i obniżenia poziomu dowodu.

## Gdy przypięty plik dowodu się zmieni

`scope.v6.json`, `scope.v7.json` i ich requesty są zamrożone i nie zmienia się ich. Dowody w `integrations.json` przypinają pliki kodu (`path`, `bytes`, `sha256`), więc późniejsza zmiana takiego pliku daje w teście odtworzenia `INVENTORY_INVALID` („Evidence must be a bounded regular file with the declared size”). Wtedy dokłada się archiwum, a nie zmienia zakresu:

1. Znajdź pin, który już nie pasuje, i obiekt Git z dokładnie tymi bajtami: `git log --format=%h -- <plik>`, potem dla commitu sprzed zmiany `git rev-parse "<commit>:<plik>"` oraz `git show "<commit>:<plik>" | wc -c` i `| shasum -a 256`. Rozmiar i SHA256 muszą być równe pinowi.
2. Utwórz nowy katalog archiwum, który rozszerza archiwum wskazane w [`evidence-archives/revalidation.json`](../../evidence-archives/revalidation.json). Robi to `extendEvidenceArchive` z [`tools/parity/evidence-archive.mjs`](../../../../tools/parity/evidence-archive.mjs): kopiuje wszystkie dotychczasowe wpisy bez zmian (z miejscem przechowania i pochodzeniem), zapisuje tylko nowe bloby w `<katalog>/new-retained/` i odmawia, gdy blob nie ma dokładnie przypiętych bajtów albo pin jest już w archiwum. Istniejących katalogów archiwów nie edytuje się.
   ```sh
   cd "/Users/arturtwardowski/DYNA Ecomerce/development/full-base"
   node --input-type=module -e '
   import {extendEvidenceArchive} from "./tools/parity/evidence-archive.mjs";
   import fs from "node:fs";
   const D = process.cwd(), root = "/Users/arturtwardowski/DYNA Ecomerce";
   const parent = JSON.parse(fs.readFileSync("docs/parity/evidence-archives/revalidation.json")).archive;
   console.log(JSON.stringify(await extendEvidenceArchive({root, parent,
     outputDirectory: D + "/docs/parity/evidence-archives/<nazwa>-<RRRRMMDD>",
     entries: [{original_ref: {path: D + "/server/<plik>", sha256: "<pin sha256>", bytes: <pin bytes>},
       source: {kind: "git_blob", repository: D, object: "<git blob>"}}]})));'
   ```
3. Wpisz wynik (`path`, `bytes`, `sha256` nowego `archive.json`) w `archive` pliku `evidence-archives/revalidation.json` i zaktualizuj `extends` i `reason`.
4. `node --test tools/parity/scope-v6-wave1.test.mjs tools/parity/scope-v7-payu.test.mjs`. Testy odtwarzają v6 i v7 z nowym archiwum jako magazynem plików, sprawdzają, że każdy wpis zamrożonego archiwum przetrwał dosłownie, i porównują wynik z zamrożonym plikiem (różni się tylko `evidence_archive`).

Archiwum mapuje pin wyłącznie na kopię o identycznych bajtach. Nie przyjmuje bieżącego kodu jako dowodu i nie zmienia wymagań, statusów, poziomów ani odbioru. Dotyczy to też następnego zakresu: nowy `scope.vN` może wskazać to archiwum w `evidence_archive`, a `createScopeSnapshot` wymaga, żeby zawierało wszystkie wpisy archiwum rodzica.

Obecny stan (26.10.2026): [`integrations-v7-20261026`](../../evidence-archives/integrations-v7-20261026/archive.json) (8850 B, SHA256 `47d9c703…`) to 10 wpisów `mirakl-v5-20261019` bez zmian plus `server/integrations.ts` z pinu v6/v7 (72 496 B, SHA256 `7cd0b22…`, blob `fb494304`). Plik zmienił się w `b82c2d0` (carriers234), `3b3abab` (L2) i w kroku rejestru v8 (Mirakl L4, 28.10.2026); pin jest ten sam, więc v8 nie dodaje archiwum.
