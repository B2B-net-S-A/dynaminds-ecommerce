# Migracja 237: historia logowań, trwała blokada logowania, rotacja kluczy API (27.10.2026)

Tor S2 z [STAGE4-NONINTEGRATION-GAP-20261025](STAGE4-NONINTEGRATION-GAP-20261025.md), obszar 5: SEC-005, SEC-012, API-001.
SEC-009 (filtry dziennika audytu) nie wchodzi: wymaga kolumny `api_key_id` w rdzeniowej `audit_events`, a ta
migracja celowo nie zmienia żadnej tabeli rdzenia.

## Co powstało (`server/237_auth_security.sql`)

Tylko własne obiekty `auth237_`. Żadna tabela rdzenia nie jest zmieniona, nie ma klucza obcego do `users` ani
`api_keys` (więc żaden wyzwalacz RI nie ląduje na rdzeniu), nic nie jest nadane `dyna_app`. Skompilowana delta
zimnego katalogu: 82 dodania, 0 zmian, 0 usunięć; poprzednik = skompilowane after236 (`dfdb9f18…`); dziesięć
strażników `true` przed i po.

| Obiekt | Po co |
|---|---|
| `auth237_login_events` | zdarzenie logowania: `outcome` (success, password_failed, mfa_failed, password_locked, mfa_locked, refused, password_reset), `status` HTTP, `ip`, `user_agent` (≤300 znaków), czas, `user_id` (NULL dla adresu bez konta), `tenant_id` (tylko udane logowanie), `subject_hash` |
| `auth237_login_throttle` | trwały licznik błędnych haseł na login: `failures`, `locked_until`, `updated_at` |
| `auth237_api_key_state` | stan klucza, którego nie ma w `api_keys`: `rotated_from_id` (UNIQUE: jeden następca), `rotated_by`, `rotated_at`, `last_used_at`, `last_used_ip` |
| `auth237_login_attempt(text)` | rezerwuje próbę przed sprawdzeniem hasła; zablokowany login → `allowed=false` bez liczenia |
| `auth237_record_login(...)` | zapis zdarzenia i retencja (ograniczona na wywołanie) |

## Decyzje i powody

- **Identyfikacja loginu bez enumeracji.** `subject_hash` = HMAC-SHA256 znormalizowanego e-maila (trim, małe
  litery) z kluczem z `encryptionKey` instalacji (`server/login-history.ts`), jak `subject_hash` w RODO 228. Ta
  sama kolumna dla adresu z kontem i bez: te same zapytania, ta sama odpowiedź (401, a po blokadzie 429 z tym
  samym tekstem), ten sam czas (mediana 21,92 vs 21,94 ms na klonie _02 i 23,67 vs 23,28 ms na _11, po 8 prób). Wiersze dla nieznanych adresów są
  nieuniknione, jeśli blokada ma działać tak samo (inaczej 429 zdradzałby konto); są stałej wielkości,
  HMAC nie da się sprawdzić słownikiem bez klucza, ich tworzenie ogranicza limit 10/min na IP, a retencja je usuwa.
  Rozważony agregat per IP nie daje blokady per konto (zgadywanie z wielu adresów).
- **Blokada (SEC-012), wartości odwracalne, do decyzji Artura.** Próba liczy się jako błąd, zanim hasło zostanie
  sprawdzone (blokada wiersza = równoległe próby z wielu instancji liczą się po kolei); dobre hasło usuwa licznik.
  Piąty błąd w ciągu godziny blokuje na 5 min, każdy kolejny po wygaśnięciu podwaja czas do 30 min; godzina bez
  prób zeruje licznik. W czasie blokady nawet dobre hasło dostaje 429 (inaczej blokada byłaby wyrocznią hasła).
  Udany reset hasła zdejmuje blokadę. Limit 10/min na IP w pamięci zostaje bez zmian.
  **Ryzyko:** blokada per konto pozwala atakującemu, który zna e-mail, trzymać konto zablokowane jednym żądaniem na
  okno blokady. Środki zaradcze (blokada per login+IP lub urządzenie, przepuszczanie dobrego hasła z adresu z udanym
  logowaniem) to zmiana polityki — czeka na decyzję. Wskazał to przegląd bezpieczeństwa 27.10 (atak „blokada co
  30 min”); ten sam przegląd znalazł wyścig `INSERT … DO NOTHING` + `SELECT STRICT` (rzadki 500 przy dwóch
  równoczesnych dobrych logowaniach) — poprawione jednym `INSERT … ON CONFLICT DO UPDATE … RETURNING` i testem —
  oraz brak filtra 90 dni przy odczycie (poprawione). Otwarte: zalew listy administratora (100 wierszy) próbami
  na jeden e-mail; filtr po osobie albo zwijanie powtórzeń `password_locked` to osobna praca.
- **Zdarzenia MFA.** `secureLogin` dostaje hak wywoływany w tej samej transakcji co licznik MFA (zwrot Problem
  zatwierdza liczniki), więc `mfa_failed`/`mfa_locked` zapisują się atomowo z blokadą MFA z migracji 051.
- **Kto widzi historię.** Właściciel: swoje zdarzenia (50 najnowszych, w tym nieudane i inne organizacje).
  Administrator: zdarzenia obecnych członków organizacji, ale z udanych logowań tylko te do własnej organizacji
  (100 najnowszych). Viewer/operator: 403. Klucz API: 403 (trasy spoza `/api/v1`).
- **Retencja (RODO).** IP i User-Agent to dane osobowe; cel: bezpieczeństwo konta (art. 6 ust. 1 lit. f). Zdarzenia
  90 dni, nieaktywne i niezablokowane liczniki 1 dzień. Usuwa je `auth237_record_login` przy każdym zapisie
  (po 200 wierszy każdego rodzaju), bez nowego workera; listy pokazują tylko okno 90 dni także przed usunięciem.
- **Rotacja klucza (API-001).** `POST /api/developer/keys/:id/rotate {overlap_seconds 0…3600}`: nowy sekret z tą
  samą nazwą, zakresami (także CRM z 218) i długością życia (≤90 dni); właścicielem jest administrator, który
  otrzymał sekret (nikt nie dostaje poświadczenia działającego w cudzym imieniu). Domyślnie stary klucz jest
  unieważniany od razu (jak „wygeneruj nowy token” w Base i bezpieczniej); okres przejściowy tylko na wyraźne
  żądanie i najwyżej godzinę: skraca `expires_at`, więc każde z ok. 20 miejsc sprawdzających `revoked_at`/`expires_at`
  odrzuci stary klucz po czasie. Jeden następca na klucz, audyt `api_key.rotated` (bez sekretów).
- **`last_used_at` bez zapisu na żądanie.** `touchApiKey` (po uwierzytelnieniu `/api/v1` i Base API) aktualizuje
  stan tylko, gdy znacznik ma ponad 60 s; świeży znacznik nie tworzy wersji wiersza ani blokady. Pomiar na klonie:
  20 żądań → 1 wersja wiersza; instrukcja 0,069 ms (mediana z 500) vs `SELECT 1` 0,033 ms; mediana żądania
  `/api/v1/orders` 1,93 ms.

## Sprawdzenia

- `tests/auth-security237.test.ts` (baza): przed zmianą 0/11 na `dynaminds_m237_20261027_01` (brak tabeli, 200
  zamiast 429, 404 tras); po zmianie 12/12 na świeżym `dynaminds_m237_20261027_11`.
- `tests/auth-security237.test.mjs`, `tests/auth-security237-source-compatibility.test.mjs` (z opcjonalnym
  odwróceniem prawdziwych katalogów), `tests/auth-security237.component.test.mjs`.
- `migrate()` 218→237 na świeżym `dynaminds_m237_20261027_10` (zostaje): 227 wierszy ledgera, 10 strażników `true` (sesja z `jit=off`,
  `timezone=UTC`), zimna inspekcja `COLD_INSPECTION_PASSED`, `auth_security237_active: true`.
- Regresja na klonach z 237: `tests/developer.test.ts` 22/22 (37 min, `_07`); `account-security`, `password-recovery`,
  `workspace-mfa`, `workspaces` 81/86 pod obciążeniem, z czego 3 to 57014 w `buildApp` (po ponowieniu zielone);
  2 pozostałe (`workspace-mfa.test.ts:450` „Niekompletny moduł PIM”, `workspaces.test.ts:588` „Niezmienna
  przynależność produktu do katalogu”) padają identycznie na wersji sprzed 237 (`d6c5283`, klon `_12`), więc nie
  są skutkiem tej zmiany.
- UI przeklikane (API 4237, Vite 5237, klon `_08`): komunikat blokady na ekranie logowania, historia własna
  i członków, rotacja z okresem 5 min (nowy sekret, „następca klucza …”, stary ważny do +5 min, wpis audytu).
