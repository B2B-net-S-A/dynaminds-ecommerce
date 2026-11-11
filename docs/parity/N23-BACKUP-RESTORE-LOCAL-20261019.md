# N23 — świeży backup, odtworzenie i podgląd lokalny

**Backup/restore i zachowanie danych: PASS. Odbiór wskazanych widoków: PASS; pełny UI podglądu: PARTIAL.**

Root wykonał jeden zaszyfrowany backup i jedno odtworzenie wydania
`c148c9c99f55e4be460daa738caacdcbb8d1cee19978bdd8954475f9f8cb94b7`.
Źródło PG03:57083 pozostało działającą aplikacją N23; nowa baza PG04:57084
to `dynaminds_restore_36751abef3079f3f`. Stara kopia N21 została zachowana,
a jej podgląd normalnie zatrzymany z potwierdzeniem terminal0.

## Rzeczywiste wykonanie

- Przed operacją: brak klientów podglądu PG04, bezpieczna istniejąca rola
  `dyna_app`, pełne 18 ról i 3 członkostwa każdego klastra zachowane,
  ponad 56 GiB wolnego miejsca. Zwykłe odczyty SQL8s/klient9s, ROLLBACK/end.
- Publiczny `backup-operator.mjs create`: EXIT0, zaszyfrowany plik 14 131 236 B,
  SHA256 `512ea451c0d1b32281abf45cb89cc2389c318e6ff77245bb014feca5fe40483f`.
- Publiczny `restore-one`: pojedyncze wykonanie EXIT0. Operator potwierdził
  schemat, pełne fingerprinty 644 tabel, konfigurację, pliki obrazu oraz własne
  kontrole odtwarzania. Kopia ma wyłączone workery; nie wykonano jej kolejki.
- Niezależny od operatora odczyt źródła i kopii potwierdził wszystkie 644
  pary count/SHA identyczne do bieżącego baseline N23. Kolejka: 731 zadań
  (131 done, 3 failed, 597 pending), 144 sesje. Role i członkostwa bez zmian.
- Nowy podgląd wystartował przez publiczny supervisor na porcie 4106,
  READY dla wydania c148; readOnly=true, workery i transport dostawców wyłączone.

## Chrome i kontrola po odczytach

Jedno zwykłe logowanie lokalnego administratora A utworzyło jedną sesję w kopii.
Chrome pokazał dashboard, odebrane zamówienie `DE-20261019-D92EB662`, płatność
12,30 PLN i 0 PLN do zapłaty, z jawną deklaracją płatności kanału sprzedaży.
Dodawanie połączenia oraz test/podgląd/import w modalu integracji były wyłączone.
Ustawienia organizacji, role, zaproszenia, tworzenie/dołączanie organizacji
i podgląd abonamentu miały wyłączone kontrolki zapisu. Odczyty pozostały dostępne.

Po Chrome źródło zachowało wszystkie 644 hashe. Kopia zachowała 643 całe tabele
oraz pełny hash wszystkich dawnych sesji po odjęciu dokładnie jednej nowej
sesji własnego administratora A (144→145). Wszystkie zadania, role i członkostwa
pozostały identyczne. Weryfikator użył RRRO SQL8s/klient9s, ROLLBACK/end; 0 zapisów.

**Otwarte obserwacje UI:** panel bezpieczeństwa konta nadal pokazywał aktywne
przyciski MFA, zmiany hasła i kończenia sesji. Nie wykonano tych operacji.
Na liście zamówień niektóre dodatkowe panele zbiorcze pokazały komunikat
„Nieoczekiwany błąd serwera”; przyczyna nie została jeszcze ustalona.
Dlatego ten odbiór nie potwierdza całego UI podglądu ani wszystkich jego odczytów.

## Dowody

Prywatne artefakty w `local-builds/full-base-preview-20261017/n23-backup-restore-prepared-agent-20261019-01/`:

| Artefakt | SHA256 |
|---|---|
| root-live-preflight.private.json | 28743c862961567b96505421d1c8c9cad4bd90235fde2b29422acc7c3a75c067 |
| root-create-ACK.private.json | 1fe29f504eb2dec048c4dd707d79a3d402ed7f0cc3c9d37dca70922c82bf24b1 |
| root-restore-ACK.private.json | 5ba8509efcd0bb37fe41236dfdfab0793ae92b9c5c1a9d603bd958e6a7709731 |
| verify-pre01/result.private.json | b94a4f1945700e121d6e337d68b6fb1c40aae9dde7e0221ca5df82a2ea87c9c0 |
| verify-post01/result.private.json | 017ff579d1915bf6ab2efa31d6fc7cf3abb62258392d8ef7709d98a8195216df |

Zrzuty: `ui-integrations-readonly.root.png`, `ui-settings-top-readonly.root.png`,
`ui-settings-readonly.root.png` (otwarte kontrolki bezpieczeństwa),
`ui-restored-A-order.root.png`. Weryfikator: `verify-restore.source.private.mjs`,
SHA256 `c20f75da8842eeaebe719d7dafae8df696c4bb19ed4dc37a766573d33a1d3650`.

Osobna, jawnie jednorazowa baza `dynaminds_wire218_disposable_20261019_01`
została utworzona z kopii 217 do testów następnej migracji CRM; nie jest źródłem
ani odebraną kopią N23. Zmiana katalogu baz nie zmieniła ról lub danych tych baz.

Pełny prywatny filesystem, wznowienie niepustej kolejki po awarii, pełna skala,
API Base, dostawcy zewnętrzni i nadrzędny Goal pozostają OPEN.
