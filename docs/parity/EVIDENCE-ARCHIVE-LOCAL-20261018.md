# Matryca zgodności — trwałe dowody źródłowe, 18.10.2026

Status: **LOCAL_FILE_EVIDENCE_REPLAY_PASS; SCOPE_PARTIAL**.
Odtwarzanie matrycy nie jest już zależne od bieżącej wersji ośmiu plików kodu
Mirakl. Root zachował ich dokładne historyczne bajty z Git w osobnym,
[przypiętym archiwum](evidence-archives/mirakl-v2-20261018/archive.json).
Nowe [scope.v3](scope.v3.json) ma dokładnie te same 2585 wymagań i `required_ids`
co [scope.v2](scope.v2.json), oraz osobny spis 2052 kodów katalogu.
Nie dodano dostawców, operacji ani odbiorów. `scope_complete=false`,
`acceptance_granted=false`; zamrożona data odniesienia pozostaje 17.10.2026.

## Przyczyna i naprawa

17 historycznych odwołań wskazywało na osiem zmienianych plików w checkoutcie.
Ścisła kontrola SHA/rozmiaru słusznie odmawiała ich późniejszego replay.
Wszystkie osiem wymaganych wersji nadal istniało jako konkretne obiekty Git;
odzyskano 248263 B, bez pobierania sieciowego lub zastępowania starych pinów.

Nowy [producer archiwum](../../tools/parity/evidence-archive.mjs) przyjmuje
jawne źródło plikowe lub dokładny Git blob. Mapa łączy oryginalny
`path/bytes/SHA` wyłącznie z zachowaną kopią o identycznych bajtach/SHA.
Następca wskazuje archiwum przez przypięte `evidence_archive`; kontrola rodzica
korzysta z jego własnego przypięcia albo jawnego przypięcia żądania.
Brak wpisu lub zmiana archiwum nadal powodują odmowę. Nie wyszukuje się
zamiennika w bieżącym kodzie i nie uruchamia plików dowodowych.

Root wykonał producer i nowy freeze jednokrotnie, EXIT0. Niezależny odczyt
porównał wszystkie osiem pełnych plików z oryginalnymi pinami i obiektami Git,
a następnie odtworzył całe v3 z jego przypiętych wejść i rodzica.
Pełne bajty v2 pozostały identyczne z Git HEAD. Domyślny stary check nadal
odmawia przez 17 odwołań; check z jawnym archiwum jest poprawny, przy
`coverage_closed=false` dla obu inwentarzy. To zamknięcie problemu trwałości
dowodów kodu, bez zmiany normatywnego zakresu lub poziomu odbioru.

Root: 29/29 testów PASS, 0 SKIP, 610,797ms; niezależny bieg: 29/29 PASS, 0 SKIP.
[Testy archiwum](../../tools/parity/evidence-archive.test.mjs) obejmują drift
lub brak oryginału, dokładny historyczny Git blob, niewłaściwy/brakujący blob,
podmianę i brak zachowanych bajtów, alias pliku, obcy pin, ponowne użycie
katalogu wyjściowego oraz ponowną walidację rodzica. Zachowano testy starszego
formatu, domyślnego CLI i odmowy utraty wymagań/kodów.

## Przypięcia i granice

| Artefakt | Bajty | SHA256 |
| --- | ---: | --- |
| `evidence-archives/mirakl-v2-20261018/archive.json` |6434|`e18d458d93e8af650d418bfbcf62ca14ec1c69cbda50bc22dc3a05cf6627848d`|
| `scope.v3.json` |2283319|`72c8fd34337d13f1cc397ace3761ebf8013f91680c9ff41a9b4da4a43f11ccb9`|
| Niezmienione `scope.v2.json` |1925550|`49d078d47a53438818bc375ea4489c0334eaafa3b57ba8d0ae7a0015969fecea`|
| `root-actual-result.private.json` |2238|`4844eefe00328a0845dfde0ed06cf5f52e7178bf301bff48624691fce424b460`|

Ostatni receipt jest pod
`local-builds/full-base-preview-20261017/mirakl-scope-evidence-archive-prepared-agent-20261018-01/`.

Nie wykonywano SQL, HTTP, operacji adaptera ani konta dostawcy. Archiwum
potwierdza historyczny kod, nie działanie obecnego wydania. Surowej odpowiedzi
katalogu Base nie odzyskano ani ponownie nie zweryfikowano; 2052 kody pozostają
metadanymi rozpoznania, bez wnioskowania tożsamości dostawców i operacji.
Pełna matryca funkcji i odbiór integracji Base nadal pozostają otwarte.
