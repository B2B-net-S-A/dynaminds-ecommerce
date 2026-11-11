# Lokalny odbiór MERGE209 — 18.10.2026

Na wspólnym wydaniu `691a7cb5e943e1474411906e9f5b9e69143761bf6e74676f6415dea4b41b7fac`
potwierdzono APP READY i dwa rzeczywiste procesy MERGE. Aplikacja działa na
`http://127.0.0.1:4103`, na zachowanej i zaktualizowanej kopii danych; oryginalny
Main nie został przełączony. Workery i scoped automation są wyłączone.

## Połączenie do głównego — zwykłe API

Oryginalny driver wykonał podgląd i połączenie, otrzymując oba HTTP201 z
rozliczonymi oryginalnymi kluczami poleceń. Dodatkowy pierwotny wrapper odmówił
odbioru, ponieważ oczekiwał niezmiennego pola `buyer-address-access.reason`.
Source166 jednoznacznie zmienia je na `dependent_plan_locked`, gdy zamówienie
staje się celem claima. To zmiana dostępności edycji, nie utrata adresu lub polityki.

Nowy GET-only weryfikator potwierdził dokładny incoming claim oraz oryginalne
wykonanie. Przed użyciem starego eksportu normalizuje wyłącznie to jedno pole,
po sprawdzeniu literalnego źródła166 i oczekiwanego przejścia null→locked.
Pozostałe porównania zachowują pierwotne wymagania. Wynik: główne zachowane,
drugie zamówienie zamknięte jako źródło z claimem do głównego; operacyjny adres,
historia, token i ogólna polityka portalu zachowane. Pełne rostery źródeł/pozycji
i utrwalonych snapshotów rezerwacji oraz trzy odczyty stanu, lokalizacji i ruchów
magazynowych zgodne. Nie jest to bezpośredni audyt bieżących tabel rezerwacji.
Wykonano34 żądania, w tym tylko dwa
POST uwierzytelniające; **zero biznesowych POST i zero nowych wykonań** w reassessment.

Dowód: `local-builds/full-base-preview-20261017/merge209-into-main16-readback02-prepared-1792301900002/run/result.private.json`,
SHA256 `d7b56d696489970aa4bb400661a915a4efa28ee10dbcd6fd9c7946d26c2764e8`.
Oryginalne artefakty FAILED pozostają zachowane.

## Nowe zamówienie techniczne — Chrome

W osobnej sesji incognito, z izolowanymi cookies, operator wybrał dokładną firmę
i dwa przygotowane zamówienia. Pełny podgląd pokazał dwie pozycje sprzedaży,
dwie rezerwacje, koszt dostawy tylko z głównego oraz zmieniony przez kupującego
adres. Po osobnych potwierdzeniach wykonano jeden klik zatwierdzenia.

Powstało `MERGE-81300BEF07A6`, wykonanie `63d54562-ff02-4910-b3ac-7408ed6ad774`.
W UI potwierdzono operacyjny adres po zmianie, historię „Adres odziedziczony po
połączeniu zamówień”, wyłączoną korektę adresu w portalu oraz dwa źródła.
Sprawdzono odświeżenie, wyjście do źródeł, ich widoki historyczne tylko do odczytu
i ponowne otwarcie wyniku z zachowanym adresem i historią.

Dowód: `local-builds/full-base-preview-20261017/merge209-pairs16-prepared-1792301516001/chrome-technical/root-chrome-proof.private.json`,
SHA256 `aa89ab9b3fe2d2f3a65f8a6ee92a14a52f648ccf3abca8c9be598a2175e7b0e5`.
W tym samym katalogu zapisano redagowane odczyty UI oraz zrzuty
`root-preview.png`, `root-target-summary.png` i `root-inherited-address.png`.
Dodatkowy GET-only odczyt tego samego wykonania również przeszedł. Potwierdził
nowy token wyniku, dokładny adres, jeden własny wpis dziedziczenia i brak kopiowania
zgody na edycję adresu. Oba źródła zachowały sprawdzane nagłówki, pozycje, polityki
i historie; ich claimy wskazują to samo wykonanie i wynik. Stan produktu jest zgodny
z fixture: dwie sztuki i dwie rezerwacje, dostępne zero; jedynym ruchem pozostaje
oryginalne przyjęcie PZ dwóch sztuk. Nie istniał pełny wcześniejszy snapshot bajtowy
lokalizacji/ruchów, więc nie przyznano takiego porównania ani audytu fizycznych tabel.
Weryfikator wykonał27 żądań, w tym dwa POST uwierzytelniające, bez biznesowego POST.

Dowód: `local-builds/full-base-preview-20261017/merge209-chrome16-technical-readback-prepared-1792302100001/run/result.private.json`,
SHA256 `158c6a8695075417e1c13f960affd8d92ab869b5f5a534f0a554873b257193c6`.

## Granice odbioru

Obie pary były ręczne, lokalne, nieopłacone, z WMS OFF. Odbiór nie potwierdza
WMS ON, mieszanej historii finansowej, dostawców zewnętrznych, doręczenia email,
pełnego podziału zamówienia, aktywnych workerów, backup/restore lub godzinnej skali.
To odbiór dwóch konkretnych przepływów na jednym wydaniu. Pełny Goal pozostaje aktywny.
