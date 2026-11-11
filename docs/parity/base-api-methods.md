# Publiczny indeks API Base — wersja1

17.10.2026. Z pierwotnego [indeksu API Base](https://api.baselinker.com/)
wyodrębniono204 jednoznaczne nazwy metod w41 grupach i7 rodzinach.
To domknięta enumeracja **tej konkretnej strony**, nadal bez pełnego
rozpisania argumentów, wyników, błędów i semantyki każdej metody.
Nie jest odbiorem implementacji ani całego API Base.

| Rodzina | Metody |
|---|---:|
| Orders | 51 |
| Order returns | 21 |
| Courier shipments | 16 |
| Clients (CRM) | 11 |
| Product catalog | 93 |
| Base Connect | 5 |
| External storages | 7 |

Wynik: [base-api-methods.v1.json](base-api-methods.v1.json).
Każda metoda ma stabilne ID `BASE-API-<method>`, rodzinę, grupę i pierwotny
URL dokumentacji. Wszystkie mają `index_only_contract_unreviewed` oraz
`acceptance_granted:false`. Kod REST, podobna nazwa albo istniejący ekran
nie potwierdzają zgodności kontraktu metody.

Źródło to109757B UTF-8, SHA256
`142d98570834624cf3889b1d7623410dd6f1470441481a55470f6945386cbe58`.
Dokładne bajty zachowano bez zmian w `base-api-index-20261017.html.gz`.
Skrypt parsuje wyłącznie lokalny dokument: nie łączy się z API, nie używa
tokenu, nie wykonuje skryptów strony ani nie pobiera zasobów.

```sh
node --test tools/parity/base-api-index.test.mjs
node tools/parity/base-api-index.mjs /absolute/decompressed-index.html /absolute/fresh-inventory.json
```

Wyjście jest nowe i wyłączne; istniejącego pliku nie nadpisuje. Parser
odmawia przy duplikacie, nieprzypisanej metodzie, obcym URL, innej ścieżce,
dodatkowych parametrach albo niezgodnej etykiecie linku.

## Aktualny rejestr dokumentacji

Rejestr z18.10 wiąże już **204/204 metod** z zachowanym indywidualnym HTML
i kontraktem: [źródła i odnośniki](base-api-contract-traceability-20261018.json).
Szczegóły i granice odbioru opisuje [aktualny stan kontraktów](base-api-remaining-contracts-next.md).
Historyczny spis145/59 pozostaje zapisem wcześniejszego etapu. Indeks v1
i jego statusy nie zostały zmienione. Komplet odnośników nie potwierdza
implementacji ani zgodności wire. Źródłowe kontrakty JSON obejmują134 metody,
w tym [Purchase orders9](base-api-purchase-order-contracts.v1.json),
[Transfers6](base-api-transfer-contracts.v1.json) i [PickPack8](base-api-pickpack-contracts.v1.json);
70 metod pozostaje wyłącznie w Markdown. Nadal brak wspólnego AST wszystkich grup,
a612 pozycji planu odbioru pozostaje NOT_RUN.

## Następny wymagany krok

Uzupełnić normalizację kontraktów i otwartą semantykę metod oraz wspólny
kontrakt uwierzytelniania, kodowania i limitów. Wykorzystać istniejące204
źródła zamiast ponownie traktować historyczne59 nazw jako brakujące strony.
Rozpisać konkretne scenariusze happy/negative,
paginację, uprawnienia i skutki biznesowe, powiązać z rzeczywistym kodem,
a następnie addytywnie włączyć wymagania do kolejnego snapshotu zakresu.
Nie nadpisano `scope.v1/v2`, nie usunięto żadnego wcześniejszego wymagania
i nie zamknięto `DOM-GAP-006`. Pełna zgodność wire pozostaje otwarta,
odrębnie od podobieństwa funkcjonalnego.
