# Historia zaproszeń B2B — 18.10.2026

Status: **lokalny proces zaproszenie→akceptacja oraz historia odebrane przez UI/API/PG; pełny Goal otwarty**.

Dostawca może odczytać historię zaproszeń dla własnego konta kontrahenta po
ponownym otwarciu ekranu. Nowy GET
`/api/b2b/accounts/:id/network-invitations` oraz panel w istniejącym ekranie
B2B pokazują zaproszenia oczekujące, przyjęte, cofnięte i wygasłe. Odczyt nie
tworzy ani nie ponawia zaproszeń; dotychczasowe operacje POST pozostają bez zmian.
Nie jest to deklaracja zgodności z metodami API Base Connect.

Odczyt wymaga aktualnych uprawnień administratora, również na końcu transakcji.
Kursor jest podpisany i związany z firmą, aktorem, kluczem API, kontem,
wersją konta i limitem. Strony zachowują pełne mikrosekundy daty oraz UUID
jako rozstrzygnięcie kolejności. Wygaśnięcie jest oceniane według jednego
czasu bazy dla całej serii stron; nie zmienia zapisanego stanu zaproszenia.
Limit wynosi domyślnie25, maksymalnie50. Odpowiedź nie zawiera tokenu,
hasha tokenu, adresu e-mail odbiorcy ani identyfikatora aktora zaproszenia.

UI umożliwia wybór konta, odświeżenie, powrót do najnowszych i przejście do
starszych zaproszeń. Zmiana firmy lub użytkownika usuwa poprzedni kontekst;
spóźniona odpowiedź nie może przywrócić danych innego konta. Błędy, ładowanie
i pusta historia są pokazane osobno. Tryb tylko do odczytu pozwala administratorowi
obejrzeć historię.

## Weryfikacja

- Root:5/5 testów rzeczywistego handlera Fastify i koordynatora uprawnień
  z kontrolowaną granicą SQL.53 wiersze obejmują remisy daty i mikrosekund;
  sprawdzono sfałszowany kursor, obcy zakres, zmianę wersji konta, cofnięcie
  uprawnień, stabilny czas wygaśnięcia i brak biznesowych zapisów.
- Root:6/6 testów rzeczywistego ekranu React z kontrolowanymi GET:
  wybór/odświeżenie/paginacja, spóźnione odpowiedzi, zmiana kontekstu,
  błąd/pusta historia/niepełne DTO i uprawnienia widoku.
- Root:11/11 regresji komponentu powiązania produktów B2B, kontrola typów
  oraz osobny build Vite EXIT0.
- Chrome: **PASS_SYNTHETIC_COMPONENT_UI_ONLY** na rzeczywistym komponencie
  i CSS, z kontrolowanymi GET. Root obejrzał desktop1698px oraz dwa widoki375px.
  Pierwsza kontrola wykryła przycinanie przycisków; lokalne zawijanie i minimalna
  szerokość panelu usunęły problem. Zmierzono granice dzieci karty, nie tylko
  szerokość dokumentu ukrywającego overflow. Sprawdzono cztery stany, wybór
  konta, odświeżanie, starsze/najnowsze i pustą historię konta nieaktywnego.
  Po poprawce Root ponownie wykonał6/6 testów React i kontrolę typów EXIT0.
  Końcowa fikstura ma zgodne daty: utworzenie16.10, wygaśnięcie17.10,
  ocena18.10. Wcześniejsze próby i autoryzowana zmiana źródła są zachowane.
- Końcowy własny serwer wizualny, oryginalny68813, zakończył się EXIT0 ze
  zgodnymi pinami. Wykonał8 GET,0 POST i0 wywołań bazy. Własna karta zamknięta,
  PID52574 nie istnieje; Root potwierdził wolne porty5176/5177/5178.
- Dodatkowy test bazodanowy `b2b-catalog-bind-key-safety` odmówił przed hookiem
  przygotowania z powodu braku `DYNA_TEST`. Nie został ponowiony ani zaliczony
  jako odbiór PostgreSQL. Prywatny zapis tej odmowy i porządkowania artefaktu
  jest zachowany w `integrated209-acceptance-root-20261018-01`.

[Końcowy receipt wizualny](../../../../local-builds/full-base-preview-20261017/b2b-invitation-history-visual03-1792327712630/result.private.json)
ma4080B SHA `4d0479f2304114558c56788847ff5057c2cd64c765a38b1450b4c08772d6172e`.
[Widok375px](../../../../local-builds/full-base-preview-20261017/b2b-invitation-history-visual03-1792327712630/narrow375-controls.private.jpg)
ma55669B SHA `23a6e69120413bea28b4f09b1f2fb700058720345fab8f7ad51325f6d9122e9a`.
Piny końcowego źródła: server46875B/`aaa4d590ea5f571c1f7480314b7d0ae28efdd8af0362467a9b4a059df11e5b64`,
web39556B/`e7afdc62114d36169ea45b02658bc964c0c6932bb60c0725b94d65a3a842b87f`.

## Rzeczywiste wydanie lokalne — odbiór Root

Root zbudował wydanie `34631b2e86fc47948b9614205e0de47b756b535da738ba4152ca1f4f9a0ead10`
z dokładnie dwiema podmianami B2B względem `bd46ebfa…`. Pozostałe1273 pliki
stagingu i59 elementów kontraktu209 zachowano. Vite, kontrola wejść, emisja
oraz niezależny od preparera odczyt pełnego pakietu zakończyły się EXIT0.
Pakiet ma379 elementów/99419434B, największy15949569B; limity16/96MiB
pozostały niezmienione. Rzeczywisty graf budowania obejmuje740 źródeł.

Na świeżej, własnej kopii Root odebrał zwykły start bez ręcznych GRANT lub
bezpośredniego normalizatora:232 różnice ACL naprawił start aplikacji,
generacja1469→1702,40503 rekordy metadanych zgodne ze źródłem. Kontrole209
i187 zwróciły TRUE odpowiednio w25,553ms i4771,754ms przy limicie8s.
Transakcja kontrolna wycofana, klient zamknięty. Profil nie ma dodatkowych
flag writerów, automatyki lub workerów; split210 pozostaje niedostępny.

Osobny setup zwykłym API wykonał6 POST: dwie nowe firmy administratorów,
cennik, nieaktywne konto kontrahenta oraz zaproszenie i rejestrację obserwatora
w firmie dostawcy. Rzeczywista historia konta jest początkowo pusta;
administrator kupującego otrzymał404 dla obcego konta, obserwator403.
To osobny odbiór przygotowania i tych początkowych odczytów API.

Następnie zwykły Chrome wykonał29 zapisów biznesowych: zatwierdzenie konta
v1→aktywne v2,27 odrębnych zaproszeń i jedną akceptację kupującego.
Root sprawdził58 oryginalnych referencji intent/ACK oraz obejrzał pięć
rzeczywistych zrzutów: dostawcę desktop, dwa widoki375px, kupującego po
akceptacji i obserwatora. Historia zachowuje stan po odświeżeniu, ponownym
otwarciu i logowaniu. Na375px przyciski zawijają się, UUID mieszczą się,
a szerokość dokumentu i viewportu wynosi375px. Obserwator nie widzi panelu
historii ani formularzy zaproszeń. Cztery logowania i cztery wylogowania
zakończono; zamknięto wyłącznie własną kartę.

Pierwsze26 zaproszeń rzeczywiście przeszło paginację25→1→25. Pomocnik testu
zgubił jednak tymczasową zmienną jednorazowego kodu26 po opuszczeniu formularza.
Nie wykonano akceptacji ani ponowienia tego zapisu. Zachowano oryginalny
checkpoint; Root przed dalszym zapisem autoryzował osobne zaproszenie27,
które cofnęło26. Nowy kod zapisano prywatnie i trwale przed nawigacją,
a kupujący zaakceptował27 raz. Końcowy stan to26 cofniętych i jedno przyjęte
zaproszenie oraz paginacja25→2→25. Dziennik zatwierdzenia konta opisuje
polecenie semantyczne; serializer dodaje domyślny pusty telefon, potwierdzony
w źródle, początkowym API i późniejszym odczycie formularza. Nie jest to
deklaracja zgodności bajtów surowego żądania HTTP.

Root wykonał21 rzeczywistych GET,0 POST: obie strony i limit50 zgadzają się
z27 ID widocznymi w UI, czas oceny wygaśnięcia jest identyczny dla stron kursora,
wszystkie daty zachowują mikrosekundy. Sfałszowany kursor, zmiana limitu
i obcy kontekst zwracają422; brak sesji401, obserwator403, obce konto404.
Odpowiedzi uwierzytelnione historii mają `no-store` i dokładny DTO bez
sekretów zaproszeń. Historia, konto i link pozostają logicznie zgodne przed
i po odczytach.

Osobny rzeczywisty READ ONLY potwierdził39 firm/globalnie0 opt-in, trzy
własne członkostwa (dwóch administratorów i obserwator), konto v2,27 zaproszeń
i dokładnie jeden link kupującego do przyjętego zaproszenia27. Szesnaście
badanych kategorii danych własnych firm, m.in. zamówienia, produkty, płatności,
dokumenty i stock, pozostało pustych. Pełne40503 metadane oraz czysta kontrola
1702/34631 są zgodne;209 TRUE, ROLLBACK i zamknięcie klienta potwierdzone.
187 nie powtarzano — ma osobny rzeczywisty dowód startu opisany powyżej.

Zwykły stop oraz oryginalny proces stacka17714 zakończyły się EXIT0.
Supervisor57142 i aplikacja57146 nie istnieją,4104 jest wolny. Main4100,
APP16 na4103 i SMTP1025/PID96215 zachowały swoje rewizje i tryby. Własną bazę
i artefakty zachowano; nie usuwano danych źródłowych ani pozostałych usług.

Dowody Root:

- [Integralność pakietu](../../../../local-builds/full-base-preview-20261017/b2b-invitation209-release-prepared-20261018-01/canonical-emission-review.private.json),
  2880B SHA `71bb50ffc2c2ff65cc6a085dde1c0d8892c32124d138738f6fcee49dd5c72ebf`.
- [Zwykły start po restore](../../../../local-builds/full-base-preview-20261017/b2b-invitation209-acceptance-root-20261018-01/root-normal-startup-review.private.json),
  5967B SHA `5b32744f20b562795fc46ed708897225bf683e29ac94a481424138ff815cba47`.
- [Setup i początkowe odmowy API](../../../../local-builds/full-base-preview-20261017/b2b-invitation209-acceptance-root-20261018-01/fixture-api-run01/result.private.json),
  3129B SHA `b7c57b1d5f5608aa18a87699f7692b728eb3e69e8f89c43cc47dd0315f6e3dd4`.
- [Rzeczywisty UI](../../../../local-builds/full-base-preview-20261017/b2b-invitation209-acceptance-root-20261018-01/ui-business-run01/result.private.json),
  40150B SHA `cc4f8c0409a13d28fac4f3192a67e524d099d6d35643cc1e0cb3ffe7e147bdca`.
- [Końcowy odczyt API](../../../../local-builds/full-base-preview-20261017/b2b-invitation209-acceptance-root-20261018-01/final-reader-run01/result.private.json),
  7968B SHA `fe2a3c1a475851a608f250c94f399141053f8809f72f111ac1314bbe4c53ee88`.
- [Końcowy odczyt PG](../../../../local-builds/full-base-preview-20261017/b2b-invitation209-acceptance-root-20261018-01/root-b2b-final-db-review.private.json),
  20879B SHA `e8ce2028c2dbe6b337a2ac607f64c3498063576407f3efd6eb1affac9d0cbaef`.
- [Odbiór Root i komplet referencji](../../../../local-builds/full-base-preview-20261017/b2b-invitation209-acceptance-root-20261018-01/root-final-local-acceptance.private.json),
  6212B SHA `8ac68f2b50e0b062e10011be7dc61847ac21046bb22ed67e09377267f48ae314`.

## Granice

Nie odebrano zewnętrznego dostawcy, pełnego B2B order/dropshipping, workerów,
recovery ani skali. Świeże zaproszenia nie potwierdzają naturalnego wygaśnięcia
po24h. Rzeczywista próba nie obejmuje konfliktu wersji konta lub osobnego
administratora/klucza API w tej samej firmie; te przypadki mają wcześniejsze
testy kontrolowane. Dla obserwatora potwierdzono ukryty panel i odmowę API403,
ale narzędzie Chrome nie umożliwiło empirycznego dowodu braku wysłania GET.
Nie zmierzono pełnej równości historycznych danych biznesowych wszystkich
starszych firm; kontrola40503 dotyczy metadanych, a16 pustych kategorii —
dwóch nowych firm. Kursor jest podpisany, ale niezaszyfrowany; zawiera zakres
bieżącej sesji i należy traktować go jako nieprzezroczysty. Brak identyfikatora
aktora zaproszenia dotyczy wierszy historii, nie dowodzi anonimowości kursora.
Pełny Goal pozostaje aktywny.
