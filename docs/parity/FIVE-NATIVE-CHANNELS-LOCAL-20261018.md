# Pięć firm i lokalnych sklepów — uruchomienie i podłączenie

Status: **rzeczywisty lokalny start i pięć podłączonych kanałów; procesy sprzedaży nadal otwarte**.

Na wydaniu N11 `8d8f8bdd86246c93366249aafa3c2dac131cef154f39a661a864311ba3d9c749`
utworzono przez zwykłe API pięć własnych firm, administratorów i magazynów MAIN.
Każdej przypisano odrębny oficjalny lokalny sklep WooCommerce: dwa zachowane
sklepy A/B i trzy świeże C/D/E. Nie są to zewnętrzne konta dostawców.

## Co rzeczywiście wykonano

- Pięć rejestracji: 5 POST 201 i 12 GET, bez bezpośredniego zapisu SQL.
- Porównanie danych po rejestracji: 617 tabel całkowicie niezmienionych.
  Pozostałe 10 zawiera dokładnie 85 nowych rekordów onboardingu. Po wyłączeniu
  tych pełnych, sprawdzonych rekordów odtworzono wszystkie wcześniejsze hashe.
  Była to rekonstrukcja porównania, bez usuwania rekordów lub przywracania bazy.
- Normalne zatrzymanie poprzedniej aplikacji i uruchomienie tego samego wydania
  z rejestrem pięciu sklepów. Oryginalny supervisor zgłosił `LOCAL_STACK_READY`;
  proces aplikacji i nasłuch wyłącznie `127.0.0.1:4105` potwierdzono osobno.
- Po restarcie wszystkie **627 tabel mają identyczne pełne hashe** jak bezpośrednio
  przed nim. Pełny stempel generacji 1744, zatwierdzenie i rewizja bez zmian.
  Oba porównania używały READ ONLY, z potwierdzonym ROLLBACK i zamknięciem klienta.
- Pięć podłączeń przez zwykłe sesje właścicieli: **5 POST 201 + 24 GET**.
  Każda firma widzi dokładnie swój kanał; pięć cyklicznych prób odczytu kanału
  innej firmy zwróciło 404. Starsza firma spoza rejestru nadal widzi pustą listę.
  Odczyty health przed i po mają identyczną pełną odpowiedź.
- Koordynator i osobny agent uzgodnili wszystkie 29 intencji, pełnych ACK
  oraz hashy odpowiedzi. 11 testów kontrolowanych helpera PASS, bez pominięć.
- Chrome: pięć normalnych logowań istniejącymi danymi testowymi i widoki
  Integracje → Lokalne sklepy Woo. Każda firma pokazuje wyłącznie swój
  podłączony sklep i właściwy adres. Pięć zrzutów sprawdzono wizualnie.
  Zmiana konta użyła zwykłego UI; bez wstrzykiwania cookies lub wylogowania
  starszej sesji. Logowania utworzyły pięć nowych sesji po opisanym wyżej
  porównaniu danych; nie są częścią twierdzenia o niezmienności 627 tabel.

## Dowody lokalne

Ścieżki względem katalogu projektu. Wszystkie poniższe pliki są prywatne;
nie publikować ich zawartości ani poświadczeń.

| Dowód | Plik | SHA256 |
| --- | --- | --- |
| Pięć rejestracji | `local-builds/full-base-preview-20261017/five-native-woo-tenants-prepared-20261018-01/run01/result.private.json` | `f5a40267c108322ec80dd1e739fc86ac003973845b92528ebe7d8c77acf9f02b` |
| Dane przed restartem | `local-builds/full-base-preview-20261017/five-native-woo-runtime-prepared-20261018-01/tenant-preservation-before.root.private.json` | `209415b863666948f628adbd6399947bbad3384852aa76a912e062e24b16a717` |
| Dane po restarcie | `local-builds/full-base-preview-20261017/five-native-woo-runtime-prepared-20261018-01/tenant-preservation-after.root.private.json` | `2d95988cc5981b6f3c61411d2e7f7798cb50480c79a830d2647431b631435e63` |
| Zwykły start i odczyt gotowości | `local-builds/full-base-preview-20261017/five-native-woo-runtime-prepared-20261018-01/five-store-ready.root.private.json` | `e2a3111bbb0dd21e27358753d9b75f6546b98dd5cd3274be5259ba756ac8c508` |
| Pięć podłączonych kanałów i izolacja | `local-builds/full-base-preview-20261017/five-native-woo-runtime-prepared-20261018-01/enroll-five01/result.private.json` | `1f1cc76e5c0c3449de96336b4ecc490ef1e6c510765e111a226412a395029aff` |

## Granice odbioru i następny proces

Podłączenie nie pobrało jeszcze produktów ani zamówień, nie uruchomiło zadania
i nie wykonało żądania do Woo. Status kanałów pozostaje `not_verified`,
`provider_verified=false`. Workery, globalne zadania dostawców oraz split210
pozostają wyłączone. Odbiór Chrome obejmuje logowanie i własny podłączony kanał;
nie obejmuje jeszcze importu, zamówień ani synchronizacji.

Następny proces dla każdej firmy: nowy własny produkt w Woo ze stanem 8 →
import katalogu i przyjęcie 8 do MAIN → nowe zamówienie 1 sztuki → import
zamówienia i rezerwacja → lokalnie 8/1/7 → korekta +1 → synchronizacja
dostępności Woo do 8. Import stanu musi poprzedzać zamówienie, aby nie
pomniejszyć dostępności dwukrotnie. Zachować starsze produkty i zamówienia A/B;
zatwierdzać wyłącznie nowe pozycje tego procesu. Potem odebrać automatyczne
workery, restart, skalę i recovery. Cały nadrzędny Goal pozostaje otwarty.
