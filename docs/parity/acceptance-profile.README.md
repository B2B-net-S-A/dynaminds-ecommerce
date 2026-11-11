# Wymagany lokalny profil skali v1

`acceptance-profile.v1.json` jest zamrożoną **specyfikacją do wykonania**, bez pomiaru i bez akceptacji. `acceptance-profile.json` wskazuje dokładne bajty tej wersji i ten sam `config_sha256`. Digest konfiguracji obejmuje wyłącznie `config`, z rekurencyjnie posortowanymi kluczami obiektów, zachowaną kolejnością tablic i UTF-8 JSON bez białych znaków. Przyszła zmiana wymaga nowej wersji z przypiętym rodzicem; nie nadpisujemy v1 po rozpoczęciu pomiarów. Dokumenty nie zmieniają wymaganych ID zakresu domen ani integracji.

Wymagamy łącznie 100 tys. SKU i 100 tys. historycznych zamówień w pięciu aktywnych firmach: po 20 tys. każdego rodzaju na firmę. Równy rozkład jest przyjętą rekomendacją lokalnego odbioru, aby jeden duży tenant nie maskował czterech małych. Dane obejmują 180 dni historii, stany magazynowe, rezerwacje i skutki zwykłych procesów biznesowych, z WMS OFF/ON. Samo wstawienie 100 tys. pustych rekordów nie spełnia profilu.

Po trzech osobnych startach zimnego procesu i stałej 10-minutowej rozgrzewce następuje godzina bez przerw: 30 minut przy 12 oraz 30 minut przy 24 klientach HTTP. Trzeba niezależnie wykazać rzeczywiste nakładanie żądań w kliencie i aplikacji. Miks ma 60% odczytów oraz 40% zapisów, minimum 100 próbek każdego rodzaju na tenant/fazę i przepustowość co najmniej 10/20 udanych żądań na sekundę. Każdy tenant i rodzaj operacji musi spełnić p95 ≤500 ms dla odczytów oraz ≤4 s dla zapisów; p99 wynosi odpowiednio ≤1/8 s. Nieoczekiwane błędy i timeouty mają budżet zero. Pacing, odmowy konfliktu i czas rozgrzewki nie mogą sztucznie poprawiać wyniku.

Przez obie fazy działają rzeczywiste, trwale autoryzowane workery/importer/synchronizacja dla wszystkich pięciu tenantów: na tenant/minutę 5 zdarzeń automatyzacji, 6 nowych importowanych zamówień i 12 aktualizacji stock sync. Profil wymaga faktycznych claimów i zakończonych skutków, a nie flag `enabled`. Import i stock sync używają własnych lokalnych instalacji oficjalnego WooCommerce. Przypięte modele protokołów służą osobnym kontrolowanym awariom. Te poziomy dowodu nie potwierdzają kont ani zewnętrznych sandboxów dostawców. Brak obecnego product path lub zgody dla któregoś tenanta blokuje uruchomienie; wymagania pozostają włączone.

Osobny odbiór recovery obejmuje duplikaty, utracony ACK COMMIT/provider, 429/503 przed przyjęciem skutku, restart/drain, nagłe wyjście własnej aplikacji oraz backup/restore do nowej własnej bazy. Wszystkie zapisy mają pełny rejestr intencji/wyników i końcowe uzgodnienie. Dopuszczamy zero nadmiernej sprzedaży, podwójnych skutków, utraconych potwierdzonych zapisów, obcych danych oraz nierozliczonych `unknown`. Nie wolno automatycznie powtarzać niepotwierdzonych mutacji.

Przed startem powstaje manifest konkretnego przebiegu: jeden dokładny finalny release, runtime/native profile, konfiguracja, źródła generatora, sprzęt/limity, dane, faktyczne ścieżki API, worker opt-ins oraz lokalne zależności i harmonogram awarii. Wszystkie fazy oraz restore muszą użyć tego samego wydania i konfiguracji. Wersje 04/05 ani workers-off nie tworzą wspólnego wyniku. Osobno raportujemy zasoby, cold/warm, kolejki, przepustowość, p95/p99, błędy i pełne uzgodnienie efektów. Limity dysku/retencji w JSON chronią przed kolejnymi kopiami pakietów i nieograniczonymi logami.

Kontrola wyłącznie plikowa, bez DB/HTTP/load:

```sh
node tools/parity/acceptance-profile.mjs
node --test tools/parity/acceptance-profile.test.mjs
```

`valid:true` potwierdza spójność wymagań. Brak rzeczywistego pomiaru oznacza nadal `measurement_performed:false` i `acceptance_granted:false`. Są to przyjęte lokalne cele DYNAMINDS, nie deklaracja parametrów ani SLA Base.
