# Końcowy przegląd zamrożenia zakresu

2026-10-17. Początkowo niezależny odczyt aktualnego narzędzia, testów i `scope-freeze-review.md`; po wykryciu nowych przypadków koordynator jawnie przekazał mi własność naprawy `tools/parity/scope-freeze.mjs` i testu. Nie zmieniano macierzy, backendu DEV, Main ani kont dostawców.

## Wynik

**ACK dla dwóch wcześniejszych poprawek; dwie dodatkowe luki znalezione, odtworzone i naprawione.** Finalny diff nowych poprawek wymaga niezależnego sprawdzenia przez koordynatora: autor naprawy nie przedstawia własnego testu jako niezależnego drugiego review.

Na wejściowym źródle `7d5f99467c14e9424f5c38a5a01da0bb700cdf931d474ad7dad4c24766190fab` / 13502 B potwierdzono:

- Operations, region i zagnieżdżony operation_contract są zachowywane normatywnie. Ich osłabienie lub usunięcie pod tym samym ID jest odrzucane.
- Deklaracja rodzica jest ponownie wyprowadzana z jego trzech własnych przypiętych wejść. Fałszywa słabsza definition lub required evidence level w ponownie zahashowanym parent nie wystarcza.
- Poziom dowodu operacji nie może się obniżyć; postęp i dowody mogą się zmieniać.
- `scope_complete` i `snapshot_kind=complete` opisują wyłącznie zamknięcie zadeklarowanego zakresu. `acceptance_granted=false` nie zmienia się także przy kompletnym snapshot z nieodebranymi operacjami.

Własne cztery wybrane regresje tych obszarów: 4/4 PASS, exit 0, 3169.496791 ms; session 82678, output `066ea6`.

## Dodatkowe luki przed naprawą

1. **Usunięcie całego `integrations.cross_cutting_gaps` nie zmieniało requirements i było przyjmowane jako zgodny potomek.** Pomijano trzy zadeklarowane wymagania dotyczące normalnego workera, uzgodnienia registry z kodem i odkrycia kontraktów dostawcy.
2. **Osłabienie `coverage_gaps[].acceptance` i `missing_scope` nie zmieniało requirements.** Gap przechowywał wyłącznie tekst requirement; zachowanie tego jednego zdania pozwalało usunąć szczegółowe warunki zamknięcia luki.

Oba przypadki odtworzono z pełnych aktualnych wejść w prywatnym tymczasowym katalogu, z autentycznym parent wyprowadzonym z jego własnych pinów. Bez zmiany oryginalnych plików macierzy. Wynik obu przypadków: ACCEPTED, requirements_unchanged=true, 2569 wymaganych rekordów, acceptance_granted=false. Output `b52df2`, exit 0. Luki dotyczyły mianownika zakresu, a nie przyznania odbioru produktu.

## Naprawa

- Jedna projekcja `normativeDefinition` zachowuje domyślnie wszystkie pola kontraktu; wyłącza jawne pola postępu. Operacje i luki używają tej samej zasady, bez wybierania tylko pojedynczych znanych pól normatywnych.
- Dla gap pozostają normatywne m.in. acceptance, missing_scope, bound_scope, docs, required_evidence_level oraz przyszłe pola kontraktu. Wyłączenia to ID podniesione do tożsamości rekordu oraz jawne pola postępu, dowodów i rozwiązania.
- Każdy zadeklarowany top-level zbiór `*_gaps` jest wymaganym zbiorem zakresu, także cross_cutting_gaps oraz przyszłe nazwane zbiory. Reguła jest częścią formatu dokumentu; nie deklaruje odkrywania dowolnego zagnieżdżonego języka kontraktowego.
- Rekord gap zachowuje tożsamość oryginalnego zbioru i pełną normatywną treść. `resolved_<nazwa_zbioru>` zachowuje ten sam gap ID i zbiór, wymaga closed=true, niepustego resolution oraz pinów dowodów, które są odczytywane i hashowane.
- Wszystkie te luki uczestniczą w odmowie complete, dopóki pozostają otwarte. Usunięcie zbioru lub przeniesienie treści w celu obejścia kontraktu nie ukrywa wymaganego rekordu.

Regresja obejmuje usunięcie/wyczyszczenie cross-cutting gaps, osłabienie acceptance/missing_scope/przyszłego kontraktu/poziomu dowodu, usunięcie przyszłego zbioru, fałszywy parent gap, dopuszczalną zmianę statusu/dowodów oraz usunięty lub fałszywie przypięty resolved_cross_cutting_gaps.

## Finalna weryfikacja

```sh
node --test tools/parity/scope-freeze.test.mjs tools/parity/check.test.mjs
```

**17/17 PASS** (12 scope-freeze + 5 inventory checker), 0 FAIL/skipped, exit 0, 1700.3835 ms. Końcowy przebieg po ostatniej zmianie: session 95843, output `965f98`.

Ponowne wykonanie dwóch konkretnych reproducerów na aktualnych pełnych wejściach po naprawie:

- drop_cross_cutting_gaps → REFUSED / REQUIRED_REMOVED;
- weaken_gap_acceptance → REFUSED / REQUIRED_REDEFINED.

Session 37701 zakończona exit 0, output `a8455c`. Odczyt rzeczywistego zakresu: **2572 rekordy**, w tym trzy wcześniejsze pominięte cross-cutting gaps; **74 pliki dowodowe** sprawdzone przez checker, `scope_complete=false`, `acceptance_granted=false`. Output początkowy `58b1c8`. Tymczasowe pliki zostały usunięte; nie zapisano snapshotu do użycia operacyjnego.

## Tożsamość finalnej treści

| Plik | Bajty | SHA-256 |
| --- | ---: | --- |
| tools/parity/scope-freeze.mjs | 14543 | b48ef0f3837ddd51e5c40646e2cf451f9966a000d5320bd111e8b7694f665bc7 |
| tools/parity/scope-freeze.test.mjs | 20302 | 305d48fd47562cdbda5f39ac22e9a969b696284bfd0920117a22d23af6b6b651 |
| tools/parity/check.mjs | 7386 | 952973b5e04367ab8a4f1756b02f288fc28e8529a57b307aa69d0293d678bc5d |
| docs/parity/domains.json | 389487 | e586ae249a4ea44d2c3016ba6e122e8b1cbb203c66f994efa4ec32408fa83eea |
| docs/parity/integrations.json | 1191016 | c7eb039c26cd60a495dcd8b8eb624a5c58caed1be1d1f6f9f4656781318229d4 |
| docs/parity/base-provider-roster.json | 3672322 | b4c1ea152a16bdd2186c56d46d706299ad77ac3007798487b66fa16177e3915a |

Granice: weryfikowany jest jeden bezpośredni parent i jego wejścia; ancestry pozostałych wersji nie jest rekursywnie przeliczane. Zmiana projekcji requirements po naprawie oznacza, że snapshot ze starym niepełnym kształtem requirements będzie odrzucony jako parent. Nie wolno go po cichu przepisać; pierwszy przyjmowany snapshot należy utworzyć i przejrzeć po tej poprawce, zachowując historię poprzedniego artefaktu.

To kontrola lokalnych plików, struktury i niezmienności zadeklarowanego zakresu. Nie potwierdza kompletności katalogu Base, adekwatności merytorycznej dowodów, działania API/UI, sandbox/account acceptance ani pełnego Goala.
