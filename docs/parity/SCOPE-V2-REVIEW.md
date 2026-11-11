# Niezależny przegląd scope.v2 — 17.10.2026

Wynik: **addytywne rozszerzenie zakresu jest zgodne; odbiór produktu pozostaje otwarty**.
Przegląd był plikowy. Nie uruchamiano aplikacji ani PostgreSQL, nie wywoływano API
dostawców i nie zapisywano nowych manifestów. Źródłem matrycy jest `local-app/docs/parity`, nie kopia DEV.

## Zachowanie zakresu

- Scope.v1: 2572 wymagania, SHA-256
  `2170c4c7793714ec4f6a37fda61db40308e821cbaedf83177aee5ea7feda6f6d`.
- Scope.v2: 2585 wymagań, SHA-256
  `49d078d47a53438818bc375ea4489c0334eaafa3b57ba8d0ae7a0015969fecea`.
- Dokładnie 13 dodatków: 11 operacji Mirakl, jeden dostawca registry i jedna luka
  `mirakl-family-remaining-capabilities`. Nie usunięto żadnego wcześniejszego ID,
  definicji, poziomu wymaganego dowodu ani stanu luki. Wszystkie 313 dawnych wierszy
  integracji i 14 dawnych obiektów dostawców zachowano logicznie identycznie.
- Przypięte wejścia v1 i v2 zostały odczytane przez istniejące narzędzie P.
  Ponowne obliczenie `createScopeSnapshot` w pamięci, z własnych wejść v2 i rodzica v1,
  dało identyczny obiekt i identyczne bajty istniejącego scope.v2. Nie zapisano kopii.

## Liczniki i granice odbioru

Bieżący literalny registry DEV zawiera 15 dostawców i **322 deklarowane operacje**:
266 implemented oraz 56 planned. Matryca ma **324 wiersze**, ponieważ jawnie dodaje
`products.link.sku` i `api.rate.shared` Mirakl spoza registry. To wyjaśnia różnicę;
nie należy nazywać wszystkich 324 operacji deklaracjami registry.

Wszystkie 11 nowych wierszy Mirakl wymaga dowodu account. Ich tablice local, sandbox
oraz account są puste, a normalny UI/API pozostaje unverified. Kod stagingu/importu
jest opisany oddzielnie od nadal planned w registry. Nie przypisano odbioru konta
182 etykietom rodziny Mirakl z rosteru.

Istniejący `local-app/tools/parity/check.mjs` potwierdził valid=true i 89 plików
z poprawnymi przypięciami. `--require-complete` zgodnie odmówił: wszystkie 324 operacje
integracji pozostają otwarte na wymaganym poziomie, a pokrycie katalogu jest niepełne.
`scope_complete=false`, `acceptance_granted=false`, `inventory_mutated=false`.

## Nowszy dowód testowy112

Odczytano istniejące publiczne podsumowanie
`local-app/docs/parity/mirakl-112-2026-10-17T17-02-53-048Z-3af70c0d.summary.json`,
SHA-256 `ae27fe002eeb149d7cb06f079338654c3ac6124bac56b2ffdd3af48288858b55`.
Dziesięć powiązanych plików receipts/logów/manifestów źródeł/runnera ma zgodne rozmiary
i SHA-256. Surowe końcówki stdout potwierdzają grupy 36 oraz 76 testów, wszystkie PASS,
bez pominięć; receipts zapisują EXIT0 i signal=null. Manifesty przed i po uruchomieniu
zawierają 1064 identyczne przypięcia źródeł; nie oznacza to wykonania każdego pliku.

Dowód dotyczy opisanych testów izolowanego stanu PostgreSQL i kontrolowanych portów,
Fastify oraz React/JSDOM. Nie jest odbiorem zwykłego UI/Chrome, zapisu OMS/Native,
całego pakietu04, cache05, sandboxa, konta dostawcy ani pełnego Goala. Przypisanie
tego dowodu konkretnym operacjom wymaga osobnej aktualizacji dowodów w matrycy;
nie wymaga zmiany zamrożonych wymagań scope.v2.
