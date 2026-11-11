# CRM Base API — kandydat 218, jeszcze nieodebrany

**Stan: źródła w pracy; działające wydanie N24/schema217.** Nowego API nie
aktywowano w normalnej aplikacji ani w odtworzonym podglądzie.

## Najnowszy wynik: TEMP32 i bramki zwykłego wydania

Rzeczywisty TEMP32 na osobnej bazie02 porównał publiczny
`partial_sale204_predecessor_definition(oid)` z prywatnym wejściem TEMP
przekazującym świeży kontekst przez zamknięte poddrzewo siedmiu funkcji.
Dziesięć przypadków po trzy pary oraz trzy pary rodzica dały33 pary/66 wywołań.
Porównano literalne całe wyniki UTF-8; pierwszy zestaw zachowano również jako
prywatne surowe pliki. NULL zachował P0002, nieistniejący OID55000.
Przypadki obejmowały także wczesny powrót członka starego17 spoza nowego27
oraz własny zakres23 bez ramki. Rodzic `partial_sale204_valid()` zwrócił true
w obu wariantach we wszystkich trzech parach.

Poniżej sumy trzech wywołań każdej strony. Pierwsze trzy wiersze to odczyt
definicji przez partial204 dla podanego OID, nie wykonanie wskazanego guarda.
Czas serwera to `pg_stat_xact_user_functions.total_time` tylko funkcji wejścia
danej strony, z jej wywołaniami potomnymi; nie sumowano zagnieżdżonych czasów.
Czas klienta to osobny `client_ms` zapytania, bez SAVEPOINT, odczytu statystyk,
zapisu plików i porównania wyników.

| Przypadek | Serwer before→after, ms | Klient before→after, ms | Ramka na wywołanie before→after |
| --- | ---: | ---: | ---: |
| OID buyer_address_guards | 318,213→167,686 | 318,981→168,418 | 6→1 |
| OID fa3_draft_fingerprint | 141,583→33,755 | 142,238→34,304 | 5→1 |
| OID b2b_invoice_fingerprint | 143,559→32,245 | 144,124→32,691 | 5→1 |
| Rodzic partial_sale204_valid | 485,058→208,310 | 485,631→208,868 | 11→1 |

W całym dobranym zestawie33 wywołań na stronę:90→21 wywołań ramki.
Publiczne osiem rekordów pg_proc wraz z pełnymi definicjami oraz cała ramka29
pozostały identyczne przed/po próbach TEMP. Po ROLLBACK potwierdzono brak map218,
pełne osiem rekordów poprzednika217 oraz zachowanie18 ról i trzech członkostw;
klient został zamknięty. Wynik nie dowodzi Native9, instalacji, p95, pełnej skali
ani działania Base API w zwykłym wydaniu. Publicznego instalatora nie zmieniono.
Receipt `base-wire-crm218-partial204-temp32-prepared-agent-20261019-01/run01/result.private.json`,
152437 B, SHA256 `861b98966f5bb448678b93b8c803e1bf775654bb57f39c50d99f9f77f6d259c6`.

Najbliższe działania integracyjne, po rzeczywistym odbiorze218:

- Uzyskać pełny niezależny katalog przed/po i ścisły inverse218→217, a potem
  wpiąć go przed projektorem217 w `packing189-cold-inspection.mjs`; marker218
  musi odpowiadać całemu kontraktowi. Bieżący cold łańcuch kończy się na217.
- Uzgodnić finalny fizyczny SQL z obiema kopiami `resource-format209.mjs`,
  builderem i zasobami runtime. Obecny alias218 nadal przypina historyczny
  plik4260205 B/`8d3c7426…`, więc nie potwierdza bieżącego8208759 B/`a4f57b16…`.
- W `server/app.ts` zastąpić samo sprawdzenie tabel/signatury zweryfikowanymi
  możliwościami i `createDefaultBaseWireCrmDispatch`; przekazać te same flagi
  do `available`/`dictionaryAvailable`, zachowując auth i requestLifetime.
  Obecna rejestracja tworzy serwis pięciu metod bez włączenia słowników.
- Sześć metod słownikowych wymaga osobnego odbioru219: typed mapy grup,
  migracji i cold/resource parity. `server/db.ts` rejestruje218, nie219.
  Istniejący rzeczywisty DBsuite instaluje218 i używa serwisu pięciu metod;
  nie zastępuje testu sześciu słowników ani zwykłej rejestracji aplikacji.
  Końcem etapu jest wspólne wydanie i proces UI→klucz API→11 metod→UI.

### Compile19, profile38 i rzeczywiste porównanie ctx39

Pełny prywatny kandydat MOVE `a6b8bc78…` zainstalowano w transakcji na
izolowanej kopii217. Run03 potwierdził dokładnie31 zmienionych rekordów oraz
21 pełnych rekordów pomocniczych. Dziewięć kontroli przed migracją zwróciło
TRUE; po niej sześć TRUE, a187/173/PIM przekroczyły8s. Nie aktywowano kandydata.
ROLLBACK odtworzył pełny rzeczywisty katalog41545 rekordów,18 ról i trzy
członkostwa; klient zamknięty. Początkowa odmowa połączenia po restarcie hosta
oraz run02 zakończony timeoutem bazowego PIM przed DDL są zachowane oddzielnie.

Profile38 mierzył osobno dwie kontrole po tej samej instalacji. Ordinary187
wywołał ramkę137 razy (1936,213ms SELF), PIM164 razy (2269,264ms SELF).
Deskryptor wywołano odpowiednio2417/2181 razy; jego SELF wynosił1591,399/
1303,276ms. Oba zapytania przerwano przy8s. Różnice statystyk wyliczono osobno
przed/po każdym zapytaniu; zagnieżdżonych czasów total nie sumowano. To profil
przyczyny, bez odbioru Native. Pełne31/21, ROLLBACK całego katalogu, role i end PASS.

Następna poprawka przekazuje świeżą ramkę przez zamknięty graf, zamiast
ponownie ją pozyskiwać. Pięć prywatnych getterów ctx39 zachowuje owner gate,
pełne mapy31, cztery SHA wybranego pakietu i dokładny bieżący AFTER. Usunięto
jedynie powtarzany odczyt kotwicy samej ramki; wejście zewnętrzne musi przed
ich użyciem zweryfikować wszystkie nowe funkcje i uzyskać świeżą ramkę.
Sam argument JSON nie jest dowodem autoryzacji.

Rzeczywista osobna transakcja ctx39 potwierdziła wszystkie pięć pełnych
24-polowych definicji względem oczekiwań źródłowych. Pełne wyniki29 funkcji
porównano dla descriptor/source/definition (87 par), dwóch definicji CHECK oraz trzech
metadata. Wszystkie równe; brak OID, NULL i zmiana wybranego AFTER dały55000
w obu wersjach. Rola dyna_app nie może wykonać prywatnego gettera (42501).
Cały katalog217 i role odtworzono po ROLLBACK; klient zamknięty. Kontrola ta
nie uruchamiała nowego pełnego grafu15 ani nowych publicznych wejść, nie jest
wynikiem wydajności9 kontroli ani odbiorem CRM w zwykłej aplikacji.

Dowody w prywatnym katalogu `local-builds/full-base-preview-20261017/`:

- `base-wire-crm218-move-compile19-prepared-root-20261019-01/run03/result.private.json`: `faf36bf76442bf323259983f14283cb851066bcf71383337c865543397b7a4df`.
- `base-wire-crm218-move-profile38-prepared-agent-20261019-01/run01/result.private.json`: `67fadf20578c6d9fbdad010f1f217200217ec5c0eade7f8ebc5a79e550dea326`.
- `base-wire-crm218-context39-root-prepared-20261019-01/run01/result.private.json`: `92ba641e5e50c566047b737d408fe3a88833fd92b531d9ddafa78536a4953a96`.

Źródłowa poprawka lifetime w `222e349` wygasza proof przed powrotem callbacku
do runnera transakcji.83 focused testy PASS i pełny typecheck0 obejmują ten kod;
nie potwierdzają aktywacji218/219. Siedem nowych scenariuszy DB słowników
w `a8b19e0` jest przygotowanych, ale niewykonanych. Rzeczywisty odbiór11 metod
na wspólnym wydaniu pozostaje OPEN.

### TEMP33: odmowy po zmianach i poprawka wskazania rekordu

Rzeczywisty run02 przeszedł13 przypadków:11 wymaganych odmów i dwa dodatnie
kontrole ignorowanych pól. Zmiany treści/nagłówka wybranego i niewybranego
członka29, starego członka17 spoza29 oraz usunięcie wiersza basis odrzuciły
zarówno oryginalne wejście/rodzic, jak i wariant TEMP. Odrzucono też niepełną
ramkę17 i zmieniony `after_check` wybranego rekordu. NULL zachował P0002,
brak OID55000; timeoutów nie zaliczano jako poprawnej odmowy.

Pierwszy run01 zatrzymał się na błędnej asercji testu: dla buyer deskryptor
wybiera rekord2, a test zmieniał `after_check` rekordu0. Oryginał i TEMP zgodnie
zwróciły niezmieniony wynik. Run02 zachowuje ten przypadek jako dodatnią
kontrolę niewybranego rekordu, dodaje odmowę zmienionego rekordu2 i sprawdza
ignorowane `before`/`after` także na rekordzie2. Kodu produktu nie zmieniano;
oba operatory i nieudany wynik zachowano.

Po każdym przypadku pełna ramka29, osiem funkcji publicznych, trzy cele zmian,
basis, sześć literalnych odpowiedzi i role wróciły do bazowego stanu. Końcowy
ROLLBACK odtworzył217 i pełne osiem rekordów, zachował18 ról/trzy członkostwa;
klient zamknięty. To nie jest odbiór instalatora ani Native9. Prywatny kontekst
JSON jest wewnętrznym przepływem danych, nie niezależnym dowodem autoryzacji.

Receipts w `base-wire-crm218-partial204-tamper33-prepared-agent-20261019-01`:

- `run01/result.private.json`: SHA256 `fa51c0cbea417cdb4f2bddfd6389037ed694b1116fe509c467d829b4d0431710` — zachowana błędna asercja testu, rollback PASS.
- `run02/result.private.json`: SHA256 `9fd509c8c38715198db1744e53ca5ad205609116641d17c24c03dfb9545adcbc` —13 przypadków PASS, rollback PASS.

## Historyczny zakres pięciu adapterów i wcześniejszy wynik

Poniższy wcześniejszy etap obejmował5 z11 metod CRM: `addCrmClient`, `getCrmClientData`,
`getCrmClients`, `deleteCrmClient`, `getCrmClientExtraFields`.
Usuwanie deleguje do tej samej domeny,
journala i audytu co zwykły CRM; nie omija bramki sesyjnej istniejącego REST.
Testy kontrolowane obejmują zachowanie historii zamówień, map i plików,
odmowy obcych i odwołanych kluczy oraz uzgodnienie utraconego ACK.
Odczyt definicji używa tego samego CRM, siedmiu edytorów i istniejących
liczbowych ID, bez alokacji. Tablica wynikowa zgodna z tabelą/przykładem
retained dokumentacji oraz filtr aktywnych definicji są jawną lokalną
polityką. Niejednoznaczność opisu dostawcy pozostaje otwarta.
Root uruchomił34 testy wire/rate/lifecycle:34PASS/0FAIL/0SKIP.
To testy z kontrolowanym portem danych, bez odbioru rzeczywistego SQL/API.
[Matryca11 metod i granic dowodów](base-api-crm-coverage-20261019.json).

## Aktualny wynik: compile17 i ograniczenie kosztu metadanych

Pełny SQL wariantu15 ma8208759 B, SHA256
`a4f57b16e45f7f98730a42ee54de897d75bc8d8542ff2f0abcaf15f83e351391`.
Rzeczywisty compile17 na osobnej bazie02 potwierdził dziewięć kontroli przed
migracją i sześć po niej. Ordinary187, large_import173 i PIM przekroczyły8s
(57014); DDL118ms. ROLLBACK do217, brak map218 i zamknięcie klienta potwierdzone.
Nie aktywowano migracji ani nie uruchomiono biznesowego testu PostgreSQL.

Oba warianty predecessor_metadata209 czytają elementy tablicy po indeksie,
zamiast materializować pełną dużą tablicę przez jsonb_array_elements. Przy
deterministycznej kolacji pomijają zamianę tekstu, jeżeli szukany tekst jest
dłuższy od bieżącego wyniku. Dla nieznanej lub niedeterministycznej kolacji
oraz NULL pozostaje pierwotna operacja. Zachowano wcześniejsze kontrole,
kolejność zamian i pełne wyniki.

RootTEMP25 potwierdził64 równe pełne wyniki w czterech wariantach dla czterech
przypadków. Własny czas16 wywołań spadł730,307→423,307ms. Oddzielne TEMP26
potwierdziło30 równoważności zamian (m.in. NULL, Unicode i rosnący wynik)
oraz siedem przypadków odczytu tablic. To dowody optymalizacji helpera,
bez potwierdzenia wydajności całej migracji.

Cichy rzeczywisty profil27 bieżącego wariantu potwierdził, że w8s próby187
pełna ramka wykonała się339 razy (3225,696ms własnego czasu), snapshot64 razy
(1695,285ms), a metadata20929 razy (709,679ms). Liczby opisują pracę do timeoutu,
nie pełne zakończone wywołanie. Statystyki drugiej próby PIM są kumulacyjne.
Profil wycofano w całości do217; klient został zamknięty. Wynik kieruje dalszą
pracę na jawne współdzielenie ramki w jednym wywołaniu, bez uznawania testu za
odbiór wydajności.

RootTEMP28 sprawdził prywatny prototyp współdzielenia ramki w obu wariantach
metadata209 i jednoargumentowym deskryptorze.66 pomiarów (33 pary before/after)
potwierdziło równość pełnych wyników, w tym SQL NULL, tekst funkcji, legacy
oraz rekordy objęte i nieobjęte209/218. Publiczne ciała nie zmieniły się;
ROLLBACK do217 i zamknięcie klienta potwierdzone. Łączny czas funkcji według
pg_stat_xact_user_functions (total_time, bez narzutu klienta) dla12 wywołań
metadata1:993,339→952,683ms; metadata2:929,683→894,904ms; dziewięciu wywołań
deskryptora:294,639→278,235ms. To niewielka poprawa w tym profilu,
bez pomiaru p95 i bez potwierdzenia pełnych dziewięciu kontroli migracji.
Prototyp nie został przeniesiony do D SQL lub generatorów. Późniejsze próby
podmiany opisano poniżej; ocena kosztu całego łańcucha pozostaje otwarta.

PróbaTEMP29 domknęła17 przypadków odmów i zachowania wyników tego prototypu:
ciała/nagłówki valid i fingerprint, wybranego oraz niewybranego członka29,
uszkodzone tablice17, członka17 spoza29, brak wiersza basis oraz NULL/brak OID.
Dodatkowe before/after w caller17 są ignorowane zgodnie z pierwotnym kodem;
w tym przypadku wynik pozostał identyczny zamiast odmawiać. Po każdej próbie
odtworzono pełną ramkę, dwa rekordy funkcji wsparcia, trzy publiczne ciała,
cały wiersz basis i sześć wyników bazowych. Role, ROLLBACK do217 i end PASS.
To odbiór tych prób negatywnych, bez aktywacji CRM lub Native.

TEMP30 porównał bezpośrednie TEXT COLLATE "C" z dotychczasową materializacją
source/definition w JSONB.24 pomiary (12 par) zachowały całą zwracaną mapę;
siedem podmian odrzucono w obu wariantach i odtworzono stan po każdej z nich.
Nie uzyskano istotnej poprawy: total_time12 wywołań116,809→116,142ms.
Tego wariantu nie promowano do źródeł instalatora.

TEMP31 porównał wariant pierwotny, dynamiczny i statyczny współdzielenia ramki:
99 pomiarów w33 trójkach dało identyczne pełne wyniki. Statyczne wywołanie
nie poprawiło konsekwentnie czasu wariantu dynamicznego; nie jest rozwiązaniem
pełnego limitu8s. Wszystkie próby29–31 zakończyły się ROLLBACK do217 i end.
Kolejny eksperyment obejmuje jawny kontekst w zamkniętym poddrzewie
partial204/gettery209/snapshot, zamiast dalszej zmiany pojedynczego porównania.
Kontekst prywatnej implementacji jest wyłącznie danymi przepływu wewnętrznego;
nie stanowi samodzielnego dowodu uprawnienia dla argumentu przekazanego przez
właściciela bazy. Publiczne wejścia nadal wymagają świeżej kontroli i kotwic.

Prywatny compile18 sprawdził całe złożenie trzech dynamicznych podmian
(wariant16,8520213 B, SHA256 `06db77eb166378bdd3647e9bee856f108542f8d5a1bb961fbe8ac31d14264723`).
Dziewięć kontroli przed migracją zwróciło true; po niej sześć true, a187/173/PIM
ponownie57014 przy8s. DDL126ms, ROLLBACK do217 i end potwierdzone. To rozstrzyga,
że zysk pojedynczych helperów nie wystarczył całemu łańcuchowi. Wariant16
z89 blokami zmian pozostaje wyłącznie prywatnym, nieodebranym eksperymentem;
bieżące D SQL ma nadal83 bloki i SHA256 `a4f57b16…`. Nie powstał compact09,
nie zmieniono Native35, instalatora ani działającego wydania.

Źródłowo30 testów kompatybilności i siedem compact PASS;27 funkcji, dwa CHECK,
13 helperów i83 bloki zmian. Nowego fizycznego compact dla wariantu15 jeszcze
nie przygotowano; compact08 dotyczy historycznego wariantu14. Kolejny kierunek
to ograniczenie powtórnych pełnych kontroli ramki w jednym wywołaniu przez
jawne przekazywanie zweryfikowanego kontekstu, bez trwałego cache i bez
pomijania kontroli integralności. A/B, capture, cold kontrakt oraz wspólny
odbiór UI/API pozostają otwarte.

Prywatne receipt:

- `root-wire218-compile17.private.json`, SHA256
  `f56f30220e2b1a66654d75e7b96418ef929f012ecb2a0c6200664c2a04061e78`.
- `root-wire218-metadata25.private.json`, SHA256
  `ef80fef6f66a44801dc948c59236fad0bca68182fc0d7da0146eb67c841168b4`.
- `root-wire218-metadata-edges26.private.json`, SHA256
  `8b56419ab906da569f6810318022739a5309fbebfcd187e39e988df56cbc927e`.
- `root-wire218-call-profile27.private.json`, SHA256
  `24eafc3807ab72c36e4a5a7dc0403c9fc0c55017770dc0e94374e1186a01e7fd`.
- `root-wire218-reuse28.private.json`, SHA256
  `3cc5a26468e62cfa6d261358ba44d95a5235e57ee375a0d687e2844cb36d97a1`.
- `base-wire-crm218-tamper29-prepared-agent-20261019-01/run01/result.private.json`, SHA256
  `5a879c0ba9da2e3feb2c8b6f3fa4e69a87144398f440022aaf78fffad48b6a19`.
- `root-wire218-frame30.private.json`, SHA256
  `fd7f38390ffcdcd6fdcf3a6a30da61f20ecd15b6732bfc7d7c1d9ab7471d150a`.
- `root-wire218-static31.private.json`, SHA256
  `bfe426613b235b205af947f09a9957e43431311d2d1bc656b5262e08a949b938`.
- `root-wire218-compile18.private.json`, SHA256
  `d413304f5dcc12e483e53af6aea88eb7a2d57b21588ff9bf790b221e45fd513e`.

## Historyczny wynik: compile16 i wspólny odczyt deskryptora

Pełny SQL wariantu14 ma8205511 B, SHA256
`c2ff3cd051bdddf583cbc45687a6908768da9d32912d96b51182ba81964954c5`.
Rzeczywisty compile16 na osobnej bazie02 potwierdził dziewięć kontroli przed
migracją i sześć po niej. Ordinary187, large_import173 i PIM nadal przekraczają
niezmienione8s; DDL107ms. ROLLBACK do217 i zamknięcie klienta potwierdzone.
CRM218 pozostaje nieaktywowany; test biznesowy pięciu metod nadal NOT_RUN.

Snapshot współdzieli jeden uwierzytelniony deskryptor dla source/definition
w każdym wybranym rekordzie. RootTEMP21: sześć par pełnych równych wyników,
30→15 wywołań deskryptora, ciepłe próbki około50–55→41–44ms.
TEMP22 odrzucił cztery podmiany tekstów pakietu, nagłówek i dwie zmiany
wybranego rekordu. TEMP23 odrzucił też zmianę kodu i nagłówka funkcji
ordinary180 spoza rekordów wybieranych przez snapshot. Każda próba zachowała
cały wynik po cofnięciu SAVEPOINT i zakończyła się ROLLBACK do217/end.
To wyniki prototypu i odmów, bez odbioru wydajności całej migracji.

Źródłowo29 testów kompatybilności i siedem compact PASS;27 funkcji, dwa CHECK,
13 helperów i77 bloków zmian. Przygotowany compact08 ma747038 B, SHA256
`891e2d5b3606feb2eda4b53bb65e19956d9c7e4bfec5b6170001ac0859cd56d2`.
Bieżący wariant nie ma rzeczywistego A/B instalatorów ani pełnego capture,
cold kontraktu, aktualizacji aplikacji i odbioru API/Chrome. Źródłowy adapter
sześciu metod słowników ma nowy, niezarejestrowany wrapper i6 kontrolowanych
testów PASS; nie rozszerza działającego N24 ani odbioru5/11.

Prywatne receipt:

- `root-wire218-compile16.private.json`, SHA256
  `b7ff4ed7ce3a256a36ccca7bce94322f75f0ab1a838f8a1e999035ec33b3d2f4`.
- `root-wire218-snapshot-pair21.private.json`, SHA256
  `4d02461461b4abd496dd822af4d48503b808e3ddba77b6a8e3ee60f9131a11c6`.
- `root-wire218-snapshot-pair22.private.json`, SHA256
  `bae9cb5e746a16bed714c40b9d697ac67899cbccf8ba259473fef3f1beaa0f26`.
- `root-wire218-snapshot-pair23.private.json`, SHA256
  `38fe88376c6d549f3a92195863662c374578f68977532d554307f71b4ee1a9ef`.

## Historyczny wynik: compile15 i próby schematu18

Rzeczywisty compile15 na oddzielnej bazie02 wykonał pełny SQL8203419 B
o SHA256 `a0d2c30d4fea3b31b10c676c288f779520065710f15b71f0a2eaa6bdbe084e70`.
Wszystkie dziewięć kontroli przed migracją zwróciło true. DDL trwał121ms.
Po migracji buyer/206/FA3/209/188/211 zwróciły true, ale ordinary187,
large_import173 i PIM przekroczyły8s (57014). Stosy wskazują dalsze wywołania
historii209 i odcisków177 przez partial_sale204 oraz walidację snapshot209.
Nie podwyższono limitów8s/9s;120s/121s pozostaje wyłącznie budżetem DDL.
Potwierdzono ROLLBACK, odtworzenie poprzednika217 i zamknięcie klienta.

Oddzielna rzeczywista próba18 odrzuciła siedem zmian wygenerowanego
`payload_document`: bezpośredni INSERT/UPDATE, zmianę NOT NULL kolumny
wynikowej lub źródłowej, podmianę wyrażenia na stałą, usunięcie wyrażenia
i zmianę nazwy kolumny. Końcowy odcisk ramki równy początkowemu;
ROLLBACK do217 i end potwierdzone. To odbiór tych odmów, bez zamknięcia
wydajności całego następcy lub działania metod CRM w aplikacji.

Root potwierdził28 testów kompatybilności i siedem compact PASS w źródłach.
Obecny zakres kontroli obejmuje27 zmienionych funkcji, dwa CHECK i13 kotwic
pomocników (40 pełnych rekordów funkcji). Przygotowany compact07 ma745855 B,
SHA256 `400c5a1bd7393b2378c6e1ef5734674aa4c7c256850a3fc923fc9dfc211a8d5e`.
Jego binding07 ma status `PREPARED_NOT_EXECUTED`; bieżące pełny/compact
nie mają jeszcze rzeczywistego porównania A/B. Wcześniejsza równoważność
instalatora nie jest automatycznie dowodem nowej wersji z wygenerowaną kolumną.

Pozostałe sześć metod statusów/grup, port tej samej domeny i typed mapa219 są
przygotowane wyłącznie źródłowo, bez rejestracji tras i rzeczywistego odbioru.
Podłączony źródłowo kandydat nadal obejmuje5/11; działające N24 pozostaje na217 bez wire.
Kolejne bramki: dziewięć pełnych kontroli po migracji w niezmienionym limicie,
aktualne A/B, niezależny pełny katalog i dokładny inverse218→217, rzeczywisty
test biznesowy PostgreSQL oraz wspólne wydanie z odbiorem UI/API. Prepared
test pięciu metod na bazie02 nadal NOT_RUN; brak odbioru konta Base.

Aktualne receipt w prywatnym katalogu N23:

- `root-wire218-compile15.private.json`,5392 B, SHA256
  `d837ffa010da24b95cf74894ce67c22cf86d807dec768ea80c6314c89940d717`.
- `root-wire218-schema-negatives18.private.json`,1625 B, SHA256
  `fb8486a9714671e691d5ecbb340a5f9dd940a56279ce5e2910f71c950201fd81`.

## Historyczny wynik compile08 i wcześniejsza diagnostyka

Rzeczywisty compile08 (`f81a3f7f…`, pełny SQL7826095B) na oddzielnej bazie02
potwierdził dziewięć kontroli przed218. Po218 buyer/206/FA3/209/188/211
zwróciły true;187/173 zwróciły false w7789/7642ms, a PIM przekroczył8s.
Całość wycofano do217,
potwierdzając brak map218 i zamknięcie klienta.
Receipt `root-wire218-compile08.private.json` w katalogu prywatnym N23
ma SHA256 `b371bc576c33afd7ef46dac68ae8b6d5d7d66e0fa5b43ebd5c71b9bf4b21d9b2`.

Profilowanie07 wykazało147 wywołań pełnej ramki kontroli podczas próby187,
łącznie około4,5s jej własnego czasu przed timeoutem. Oddzielna diagnostyka
lokalizuje duży koszt w wyprowadzaniu kontrolnych rekordów i budowaniu
pełnej mapy JSONB. Nowy format wewnętrzny OBJECT v2 usunął powtórne
budowanie mapy; pełne28 kontroli i13 kotwic zachowano. Wynik compile08
nie stanowi odbioru. Trwa diagnostyka rzeczywistej ścieżki wave209;
osobne publiczne pomocniki nie są automatycznie równoważne jej wrapperom.
Nie zwiększono limitu8s i nie wyłączano kontroli.

## Wcześniejszy etap trzech metod

Kod kandydata obejmuje `addCrmClient`, `getCrmClientData`, `getCrmClients`,
formularz `connector.php`, wspólne dane istniejącego CRM, trwałe liczbowe ID,
tenant-aware mapy i tombstones. Aktualizacja zachowuje pominięte pola, lista ma
strony po100, a dodatkowe pola szczegółów są jawnie opcjonalne. Uwierzytelnienie
ponownie sprawdza bieżący klucz, członkostwo i MFA wewnątrz transakcji.
Opcjonalny lokalny klucz idempotencji nie jest deklarowaną gwarancją Base.

Przegląd poprawił replay zredagowanych uploadów i powiązanie z kluczem API,
wyścig brakującej polityki MFA, mapowanie bezpiecznych błędów parsera oraz
wyciek aktywnego żądania po błędzie. GET/PUT konektora mają jawne405 zamiast SPA.
Testy kontrolowane autora i niezależnego testera:79PASS (w tym51regresji CRM).
To nie dowód działania nowego wydania lub współpracy z kontem Base.

## Historyczny rzeczywisty test PostgreSQL trzech metod

Root utworzył osobną bazę `dynaminds_wire218_disposable_20261019_01` z odtworzonej
kopii217. Test uruchomiono raz: **3PASS/7FAIL**. Sama migracja218, backfill,
RLS, tenantFK i odmowa zapisu do map przez dyna_app przeszły. Zapis przez
istniejący CRM i przez wire odmawiał503 z powodu kontroli integralności PIM.
Pełny odbiór trzech metod, plików i paginacji na PostgreSQL pozostaje OPEN.

Próba A/B Roota w tej jednorazowej bazie wykazała: bieżący kandydat218 daje
`fa3_draft_guards()=false` i `pim_dictionary_valid()=false`. Tymczasowe przywrócenie
wyłącznie dwóch dawnych CHECK tabeli api_keys przywraca obydwa wyniki do true.
Testowe klucze CRM usunięto tylko wewnątrz tej samej transakcji diagnostycznej,
aby dawne CHECK mogły się zwalidować; całą próbę wycofano przez ROLLBACK.
Źródło i właściwa odtworzona kopia N23 nie zostały zmienione.

## Historyczna kompilacja następcy i przyczyna odmowy

Root przygotował osobną bazę `dynaminds_wire218_disposable_20261019_02`.
W pierwszej próbie wszystkie dziewięć kontroli poprzednika zwróciło true.
SQL218 o SHA256 `78a837d72afa8f2d79f211742a78902e5af4420e7e1312914724227df1469701`
skompilował się w38ms, ale `ordinary187_valid()` zwrócił false po4777ms.
Całą próbę wycofano, potwierdzając brak nowych map218. Pełnego testu biznesowego
na02 jeszcze nie uruchomiono.

Osobna wycofana transakcja potwierdziła, że nowy manifest następcy i kontrola209
przechodzą: frame5ms, snapshot89ms, `order_merge_delivery209_valid()` true87ms.
Nie przeszły FA3, PIM, ordinary187, buyer_address, return_credit206 i large_import173;
ordinary188 oraz return_credit211 pozostały true. Wszystkie te zapytania miały
niezmienione limity8s serwera/9s klienta; tylko DDL otrzymał120s/121s.

Próba przyczynowa odtworzyła dokładny wykonywany fragment `credit_meta267`
z `manual_inventory_off_valid()`. Przed migracją oba odciski były równe
`b8a3da1927ac4807db9fbd4be5e5814a` (212ms). Po migracji odcisk tego fragmentu
wynosił `7ab9224dad6fdeae17e3d499891e8eaf`, a publiczny odcisk nadal
`b8a3da1927ac4807db9fbd4be5e5814a` (495ms). Wynik nie był NULL: stary fragment
czytał rozszerzone CHECK bez projekcji poprzednika. ROLLBACK i powrót schematu217
potwierdzono. To podstawa poprawki jednego wykonywanego fragmentu oraz kompozycji
projekcji218→209, z zachowaniem dawnych certyfikatów.

Kolejny kandydat SQL `8d3c742631d0976ec1c88272ab61fff2ebb2718f715b17f6cdebaca3261880c4`
obejmuje16 funkcji i kompiluje się w53ms. Rzeczywiste próby potwierdziły już
`manual_inventory_off_valid()` true1157ms, jego projection true239ms,
partial_sale204 true220ms i catalog_header205 true224ms. Nadal odmawiają
b2b_invoice_upgrade, b2b_credit, credit_source i financial_return_upgrade.
Pełne ordinary187 i large_import173 przekroczyły8s w wielokrotnie wywoływanej
kontroli frame218 wewnątrz snapshot209. Pozostałe wyniki: buyer_address false,
return_credit206 false, FA3 false, PIM false,209/188/211 true.
Obie transakcje diagnostyczne wycofano i potwierdzono powrót217.

Ówczesny przegląd wykonywalnych fragmentów wykazał kolejnych10 konsumentów definicji
api_keys. Trwały prace nad pełnym zakresem26 funkcji i jedną świeżą walidacją
na wywołanie funkcji zamiast powtarzania jej dla każdego pola. Nie zwiększono
limitów zapytań. SQL8d3 ma4260205B i przekracza zapas obecnego pakietu; prototyp
zmniejszenia wyłącznie nowego instalatora ma4/4 testów kontrolowanych PASS,
ale nie został złożony ani wykonany w PostgreSQL. Pełne pakowanie nadal OPEN.

Rejestr/czytnik i testy pakowania218 mają kontrolowane40/40PASS. Nie jest to
odbiór rzeczywistego pakietu Native ani startu aplikacji. Nadal potrzebne są
poprawne dziewięć kontroli po migracji, pełny test biznesowy, rzeczywisty kontrakt
katalogu218→217 oraz odbiór wspólnego lokalnego wydania. Limity pakietu16/96MiB
pozostają bez zmian. Nie wolno wyłączać kontroli PIM ani kończyć na testach źródeł.

Panel kluczy API w źródłach umożliwia teraz wybór CRM odczyt/zapis. Zapis dodaje
wymagany odczyt; odebranie odczytu usuwa również zapis. Root potwierdził5/5 testów
rzeczywistego komponentu React z zamkniętym fetch. To jeszcze nie odbiór Chrome
lub tworzenia klucza w uruchomionym wydaniu.

Dowody prywatne w `local-builds/full-base-preview-20261017/n23-backup-restore-prepared-agent-20261019-01/`:

- `wire218-database-test01.private.log`, SHA256
  `2de61d49f086ad7bb91a5f47ac05707e8bdc2936074c00eac9478812e85642f1`.
- `wire218-checks-ab01.private.json`, SHA256
  `b7d60f4ac852c2c7cc132f8005575a33d84c77a443e9b1463f3859d73d8304fb`.
- `root-wire218-compile02.private.json`, SHA256
  `82d4dd851bab3cf9ba2ed5bd1936b1d7b638593fd721af4473a71ed0c84abac7`.
- `root-wire218-guards02.private.json`, SHA256
  `d0d87d37c987f1dae5b1ad81a7e53eca56ee26eefae9c62be14263f4fafe3a60`.
- `root-wire218-manual-credit-ab02.private.json`, SHA256
  `ed7c7286065be0710cfd0f36fb73d96189b1ed87b71b3a958d0fb5a2a3a5bf63`.
- `root-wire218-compile03.private.json`, SHA256
  `a255f79ee9f56d767d7bcc4e8950cfa52f1c09a0e09b8ed88a034f6d6e8d4a3c`.
- `root-wire218-inner-guards03.private.json`, SHA256
  `cb87dde66fd1decb5dc8c42515fd33b64e55215c5a34ed5fbdba0bcf2f887e3c`.

Historycznie osobną poprawkę UI bezpieczeństwa zapisano jako `bd18f34`:
Root potwierdził10testów React PASS i typecheck0. W chwili tego zapisu nie była
częścią uruchomionego N23. Późniejszy odbiór N24, obejmujący tę poprawkę,
opisuje [raport N24](N24-RECOVERY-READONLY-LOCAL-20261019.md); nie obejmuje CRM218.
Pozostałe metody CRM, całe Base API, skala i pełny Goal pozostają OPEN.
