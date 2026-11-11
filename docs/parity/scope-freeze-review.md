# Przegląd zamrożenia zakresu

2026-10-17 — aktualnie obie poniższe usterki naprawione i potwierdzone regresjami. Zakres: źródła, syntetyczne pliki tymczasowe oraz odczyt bieżącego inwentarza; bez runtime, kont lub API. Nie jest to odbiór produktu ani pełnego zakresu Base. Ostatni diff pozostaje do niezależnego przeglądu koordynatora.

## Początkowy wynik HOLD

1. **P1: niezachowany normatywny zakres operations.** Aktualne domains.json zawiera tablicę operacji, lecz zamrożona definition przechowuje tylko requirement/acceptance/provider/operation. Potomek może zastąpić create+cancel przez read bez odmowy i bez zmian required IDs.
2. **P1: wewnętrznie niespójny parent jest akceptowany.** validateParent sprawdza strukturę i required_ids, lecz nie wyprowadza requirements z własnych przypiętych inputs. Nowy plik rodzica może deklarować słabszą definition niż jego niezmienione przypięte wejścia i dopuścić takiego potomka. Poprawny hash niespójnego pliku nie dowodzi zgodności jego treści.

Oba przypadki odtworzone w kontrolowanym tempFS: `87468c` / EXIT0. W obu acceptance_granted=false; obejście dotyczy zamrożenia mianownika, nie nadania odbioru produktu. Oryginalne pliki wejściowe projektu nie były zmieniane.

Dziedziczone dziewięć kontroli przechodziło; nie obejmowały dwóch powyższych przypadków.

## Stan po wznowieniu i poprawkach

Autorytatywny odczyt plików po wznowieniu potwierdził, że wcześniejsza przerwana praca zapisała obie poprawki źródła. Zostały zweryfikowane, a regresje dodatkowo rozszerzone:

- `operationDefinition` zachowuje normatywne pola wiersza, w tym `operations`, `operation`, `provider`, `region`, kryteria odbioru i zagnieżdżony `operation_contract`. Domyślnie zachowuje także przyszłe pola kontraktu. Odrębnie usuwa wyliczone pola postępu/dowodów oraz kontraktowe `discovery_status`; ich zmiana nie zmienia mianownika.
- Rodzic jest odczytywany przez przypiętą ścieżkę/hash/rozmiar, walidowany strukturalnie, a następnie przeliczany z własnych trzech przypiętych wejść. `requirements`, data odniesienia i deklaracja kompletności muszą zgadzać się z tym przeliczeniem. Ponowne zahashowanie wewnętrznie niespójnego rodzica nie wystarcza.
- Weryfikacja obejmuje jeden bezpośredni rodzic i jego wejścia; nie wykonuje rekursji po całej historii. Plik wersji późniejszej niż 1 musi mieć poprawnie ukształtowany odnośnik do poprzednika. To nie jest deklaracja ponownej weryfikacji wszystkich dalszych przodków.
- Regresje odrzucają `create + cancel → read`, usunięcie `operations`, zmianę regionu, kontraktu i przyszłego normatywnego pola pod tym samym ID. Oddzielnie odrzucają sfałszowaną słabszą definicję, operacje, region, kontrakt oraz poziom dowodu w samym rodzicu, nawet gdy dziecko powtarza fałszywą treść.
- Statusy i dowody mogą się zmieniać, nowe wymagania mogą być dodawane, a wymagany poziom dowodu może wzrosnąć. Usunięcie wymagania albo obniżenie poziomu dowodu jest odrzucane. Zamknięcie luki zachowuje jej ID i wymaga przypiętego pliku dowodu rozwiązania.
- `scope_complete=true` oznacza zamknięty zadeklarowany mianownik, nie działanie operacji. `acceptance_granted=false` pozostaje zawsze wymuszone, także dla kompletnego snapshotu z nieodebranymi operacjami.

## Rzeczywiste sprawdzenia

1. `node --test tools/parity/scope-freeze.test.mjs` — **11/11 PASS**, EXIT0, 2,85 s; chunk końcowy `481a48`, handle `71438` zakończony.
2. Po rozszerzeniu regresji: `node --test tools/parity/scope-freeze.test.mjs tools/parity/check.test.mjs` — **16/16 PASS** (11 scope-freeze + 5 check), EXIT0, 3,93 s; chunk końcowy `36fdbd`, handle `64085` zakończony. Testy plikowe, bez API/PG.
3. Odczyt aktualnych trzech inwentarzy i `createScopeSnapshot` w pamięci — EXIT0, chunk `69deef`. Wynik: **573 wpisy** (domains 146, integrations 338, providerRoster 89), **74 zweryfikowane pliki dowodowe**, `scope_complete=false`, `acceptance_granted=false`. Nie zapisano snapshotu ani nie zmieniono inwentarzy. To kontrola strukturalna i zgodności pinów; nie dowód pełnego katalogu Base.

Piny kodu po końcowym teście:

| Plik | Bajty | SHA256 |
|---|---:|---|
| `tools/parity/scope-freeze.mjs` | 13502 | `7d5f99467c14e9424f5c38a5a01da0bb700cdf931d474ad7dad4c24766190fab` |
| `tools/parity/scope-freeze.test.mjs` | 17158 | `d134fbe90ad51f77794413dc439e60673a9975c835b3da0c72c1ef771460451a` |

Piny wejść dla kontroli rzeczywistego inwentarza:

| Plik | Bajty | SHA256 |
|---|---:|---|
| `docs/parity/domains.json` | 389487 | `e586ae249a4ea44d2c3016ba6e122e8b1cbb203c66f994efa4ec32408fa83eea` |
| `docs/parity/integrations.json` | 1191016 | `c7eb039c26cd60a495dcd8b8eb624a5c58caed1be1d1f6f9f4656781318229d4` |
| `docs/parity/base-provider-roster.json` | 93912 | `ed232f03c48b9767422cdb2f112e07c56594a93ac52efe366974c60b7f4ac995` |

Nie zmieniano checkerów, rosterów, DEV backendu ani działającego Main. Nie uruchamiano API, PG, kont dostawców ani nowych usług.
