# CRM217 — lokalny edytor definicji pól (źródła)

Stan: zaimplementowane UI/API i testy kontrolowane; Root potwierdził niezależną kompilację SQL217. Migracja nie została uruchomiona w bazie aplikacji. Integracja zasobów, Native biznesowy, pakiet i zwykły odbiór UI/API pozostają otwarte. Pełny CRM/Goal pozostaje otwarty.

Root Source217-02: **41534 → 41544 rekordy metadanych, 10 dodatków, cztery dokładne zmiany ACL, 0 usunięć**. Wszystkie pozostałe pola poprzednika i pełny inverse zachowano. Siedem guardów przed i siedem po zwróciło TRUE przy SQL8s/client9s (maksimum5240ms). ROLLBACK, zamknięcie klientów, DROP własnego scratch, pełne role/członkostwa i końcowe piny potwierdzone; bez COMMIT i bez zmiany bazy aplikacji. [Wynik Source217-02](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/crm-fields217-source02-prepared-agent-20261019-01/result.private.json>):110434 B, SHA256 `52714db7d57cc07fdd8f5959d795f284a72573f732f107c45561f69e0a289260`.

Pierwsza próba zatrzymała się przed guardami końcowymi: pomocnicze porównanie ACL tworzyło zwykły obiekt zamiast zachować prototyp deskryptora czytnika. Artefakty FAIL zachowano. Wersja02 zmieniła wyłącznie konstrukcję porównywanego obiektu; nie zmieniała SQL ani akceptowanych pól. Root sprawdził pięć kontroli tej poprawki przed ponowną, osobną kompilacją.

Zachowany dokument Base `getCrmClientExtraFields` ma 50193 bajty i SHA256 `05738237a944676666eadd158573ac663651c81d599b5a226ed281ea66894528` (bundle `base-api-client-sources-20261017.json.gz`). Dokumentuje odczyt definicji oraz typy text, number, select, checkbox, radio, date, file. Poniższe mutacje są jawnym **lokalnym API produktu**, bez przypisywania Base nowych metod wire.

## Porty i zachowanie

- `GET /api/crm/extra-fields` zachowuje `extra_field_id/name/editor_type/options`. Po zainstalowaniu 217 dodaje version, position, archived i `policy.definition_editor_available=true`. Bez 217 nadal działa odczyt CRM215, a nowy edytor odmawia zapisów.
- `POST /api/crm/field-definitions`: `{client_key,name,editor_type,options?,position?}`. Typ jest stały. Opcje są wymagane tylko dla select/checkbox/radio, są przycinane, unikalne i niepuste.
- `PATCH /api/crm/field-definitions/:id`: `{client_key,version,name?,options?,position?,archived?}`. Pozycja jest indeksem od zera w całej liście definicji, również archiwalnych. Przesunięcie atomowo zmienia pozycje i wersje przesuniętych definicji. Brak pola w PATCH zachowuje jego dotychczasową wartość.
- ACK ma postać `{data:{id,name,editor_type,options,position,version,archived}}`. To samo oryginalne polecenie, klucz i actor otrzymują historyczny ACK bez porównywania z bieżącą mutowalną definicją.
- Istniejące `POST /api/crm/commands/observe` i `/cancel` przyjmują dokładne oryginalne `{method,path,body}` także dla definicji. UNKNOWN pozostaje zachowany po remount; obserwacja nie ponawia zapisu, a anulowanie zapisuje niezmienny tombstone bez cofania wcześniejszego ACK.
- Archiwizacja i przywrócenie nie wykonują DML na wartościach klientów, plikach, profilach ani zamówieniach. Zapisane wartości archiwalnego pola pozostają widoczne; prywatny download zachowuje dotychczasową autoryzację. Nowy zapis wartości wymaga wcześniejszego przywrócenia definicji.
- Opcji użytej przez dowolnego własnego klienta, także historycznie, nie można usunąć. Jedno indeksowane zapytanie EXISTS sprawdza zgodność, bez pobierania kompletu wartości do procesu aplikacji.

Lokalne limity: 1000 definicji na firmę, nazwa 120 znaków, 100 opcji po 200 znaków. Nie są deklaracją limitów Base. Nazwa/opcje/kolejność/archiwizacja korzystają z aktualnego IAM administratora, wspólnego tenant mutex CRM, CAS i transakcyjnego journalu/audytu. UI używa dotychczasowego WebLock i trwałego zachowania niepewnego polecenia. Typu/tenant/id nie da się podmienić przez PATCH.

## Schemat i weryfikacja

`server/217_crm_field_definitions.sql` dodaje do istniejącej `crm_extra_fields` kolumny version (domyślnie 1) i archived_at, kontrolę nieujemnej pozycji, wąskie uprawnienia INSERT/UPDATE oraz indeks odczytu wartości po definicji. Nie dodaje DELETE ani UPDATE typu/tożsamości i nie zmienia istniejącego FORCE RLS. SQL215 i jego bootstrap pozostają bez zmian; seed nowych firm automatycznie otrzyma domyślne wartości nowych kolumn.

Kontrolowane źródłowe porty usług/routes/bootstrap/parserów: **49 PASS, 0 SKIP**. Rzeczywisty React z zamkniętym mockowanym fetch i transformacją middleware bez listenera: **27 PASS, 0 SKIP**. Pełny `tsc --noEmit`: EXIT0. Testy obejmują rollback po odmowie journalu także po przesunięciu sąsiadów, CAS/race, aktualne IAM i obcą firmę, utratę ACK/observe/cancel, opcje używane u klientów, zachowanie całych zaszyfrowanych plików i download oraz działanie bez 217. To nie jest wykonanie SQL ani dowód konkurencji PostgreSQL. Root powinien odebrać rzeczywiste uprawnienia/RLS, parser zapytań, migrację istniejących danych oraz normalny pakiet/UI.

Dodatkowo CSS w obrębie CRM ustala szerokość checkbox/radio i zagęszcza formularze definicji. Nie zmienia istniejącego wydania D/N18; wizualny odbiór pozostaje do normalnego startu po integracji.
