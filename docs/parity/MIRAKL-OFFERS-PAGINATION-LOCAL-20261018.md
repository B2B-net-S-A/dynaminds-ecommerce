# Mirakl OF21 — lokalne strony ofert

Status: implementacja oraz kontrolowane testy API, HTTP i React. Bez odbioru
konta dostawcy, oficjalnego sandboxa lub całej uruchomionej aplikacji.
Lokalny commit funkcji: `060153a`.

## Zachowanie

Dotychczas zwykły panel i endpoint podglądu ofert udostępniały tylko offset0.
Panel pozwala teraz jawnie odczytać następną stronę i wrócić do poprzedniej.
Pozycję następnej strony wyznacza liczba rzeczywiście otrzymanych wierszy,
także dla strony krótszej od żądanego limitu. Zmiana SKU, limitu lub użytkownika
usuwa poprzednią obserwację. Nie pobieramy kolejnej strony automatycznie.

`GET /api/integrations/:id/mirakl/offers-preview` przyjmuje opcjonalny `offset`
0..10000; jego brak zachowuje pierwszą stronę. Limit10000 jest lokalną polityką.
Każdy odczyt nadal wymaga aktualnych uprawnień, kontroli sklepu A01 i trwałego
budżetu OF21. Strona kontynuacji wiąże się z odczytanym hashem połączenia;
zmienione połączenie odmawia przed wysłaniem żądania do dostawcy. Błąd lub
utrata odpowiedzi nie uruchamia automatycznej ponownej próby.

Oficjalny [kontrakt OF21](https://developer.mirakl.com/content/product/mmp/rest/seller/openapi3/offers/of21)
opisuje offset pagination. Osobne strony nie tworzą spójnego snapshotu danych
zmieniających się u dostawcy.

## Dowody i granice

Autor i Root niezależnie wykonali:

```sh
node --import tsx --test --test-concurrency=1 tests/mirakl.test.ts tests/mirakl-channel.test.ts tests/mirakl-read-routes.test.ts tests/mirakl-offers-wire.test.ts web/mirakl-reads.test.mjs
```

Root: **81 PASS, 0 FAIL, 0 SKIP**,1904,807708ms; oryginalny proces36602 EXIT0.
Test wire używa rzeczywistego lokalnego HTTP, klienta Mirakl i Fastify,
ze sterowanymi danymi dostawcy. Sprawdza offsety0/100/101, sklep, SKU,
serializację poświadczenia, brak automatycznej kontynuacji i trwały cooldown429.
Testy React obejmują kliknięcia, krótkie strony, zmiany kontekstu i konfiguracji.
Niezależny przegląd nie wskazał konkretnego P1/P2.
Root `npm run typecheck`: oryginalny41012 EXIT0.

Odbiór konta/sandboxa i procesy biznesowe na wspólnym wydaniu pozostają otwarte.
Main4100 oraz APP164103 nie były przełączane ani użyte przez te testy.

Kontrola Chrome **SYNTHETIC_COMPONENT_UI PASS**: rzeczywisty komponent i CSS,
sterowane odpowiedzi GET, strony0→1→2→1, poprawny powrót po krótkiej stronie,
reset po zmianie SKU oraz wyłączone przyciski dla ostatniej strony. Root obejrzał
oba zrzuty. Wynik prywatny: `mirakl-component-visual-qa-1792321474423`,
`result.private.json`1439B SHA
`185cb193f5c4dbfad98798042316a5d300c9f2774c31cdb7db227b0055b48a30`.
Testowa karta została zamknięta, własny serwer zakończył się EXIT0 (oryginalny81670).
Ten dowód dotyczy komponentu na kontrolowanych danych, nie całej aplikacji ani
rzeczywistego konta Mirakl.
