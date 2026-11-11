# Integracje: inwentaryzacja operacji i dowodów

Stan: 2026-10-17. **15 dostawców, 324 wiersze operacji: 266 deklarowanych jako implemented, 56 planned oraz 2 dodatkowe operacje kodu poza registry. To zakres matrycy z rozszerzeniem DEV Mirakl, nie pełny katalog Base. Historyczna baza P obejmowała 14 dostawców i 313 operacji.**

`integrations.json` jest macierzą operacji; identyfikatory `integration.<provider>.<operation>` są stabilne. Zmiana statusu wymaga dowodu właściwej operacji. Kod, lokalny kontrakt, normalny UI/API, sandbox i konto dostawcy są niezależne. Puste sandbox/account nie oznaczają braku implementacji.

## Granice aktualnego odbioru

Istniejące Root receipts z finalnego Main db1a dowodzą wybranych operacji dwóch oficjalnych **lokalnych** sklepów WooCommerce oraz lokalnego SMTP. Dowód nie przechodzi automatycznie na warianty produktów, webhooki, płatności, harmonogramy ani zewnętrzne konto. SMTP potwierdza przyjęcie do lokalnego szyfrowanego sinka, **nie dostarczenie odbiorcy**. ACK-loss Woo ma osobny odczyt rozstrzygający bez ponownego PUT; niepewny email pozostaje niepewny i bez resend.

W tym przeglądzie odczytano źródła, publiczne strony Base i istniejące receipts. Nie uruchamiano kontraktów ani aplikacji, nie otwierano kont/kluczy i nie wykonywano API dostawców. Znalezione pliki testów są locatorami do późniejszego wykonania, nie wynikiem PASS.

## Obecni dostawcy

| Dostawca | Implemented / planned | Kontrakt źródłowy i granica |
|---|---:|---|
| DeepL | 8 / 4 | DeepL REST; exact upstream version source_missing; Brak globalnego sandboxu; kontrakt lokalny nie potwierdza konta Free/Pro. |
| Email SMTP | 10 / 3 | SMTP / Nodemailer; Lokalny sink bez forward; accepted nie oznacza delivered. |
| Amazon | 21 / 5 | SP-API: Orders / Catalog / Listings / Reports / Fulfillment, endpoint versions per adapter; Sandbox wymaga danych aplikacji; konto sprzedawcy i zakresy niepotwierdzone tym audytem. |
| eBay | 37 / 7 | Sell Fulfillment / Inventory / Account / Taxonomy + Trading identity; Oddzielne sandbox/live; limity lokalne nie dowodzą dostępnej puli konta eBay. |
| Odoo | 17 / 5 | Odoo 19 JSON-2 /json/2/{model}/{method}; Własna instancja testowa; brak automatycznego sandboxu dostawcy. |
| DPD Polska | 16 / 3 | DPDServices REST PL + DPDInfo SOAP; Oficjalne DEMO i rzeczywiste etykiety wymagają osobnego odbioru; lokalne paczki DEMO V2 nie dowodzą API DPD. |
| BigBuy | 8 / 2 | BigBuy REST; Zakup lokalny nie jest zamówieniem dropshipping u BigBuy. |
| Shopify | 36 / 7 | Admin GraphQL 2026-10 (source-pinned); Sklep deweloperski wymaga autoryzowanego konta; callback HTTPS i chronione dane klienta osobno. |
| SMSAPI | 7 / 2 | SMSAPI REST; exact upstream version source_missing; test=1 nie wysyła SMS; kod sms-live istnieje, registry.send nadal planned: wymaga uzgodnienia. |
| PrestaShop | 22 / 2 | PrestaShop Webservice; documentation reference 9; Osobny własny sklep testowy; nie mylić planned webhook module z działającym webhookiem. |
| Allegro | 33 / 2 | Allegro REST, per-resource media versions in adapter; Publiczny sandbox/live rozdzielone; brak aktualnego autoryzowanego konta w dowodach tego audytu. |
| WooCommerce | 31 / 0 | WooCommerce REST wc/v3; own local official WordPress/Woo fixture; V2 dowodzi dwóch oficjalnych lokalnych sklepów; nie dowodzi zewnętrznego sklepu ani wszystkich operacji. |
| InPost ShipX | 9 / 3 | ShipX PL; Punkty publiczne nie dowodzą autoryzowanego nadania, zakupu ani etykiety. |
| Fakturownia | 8 / 5 | Fakturownia REST; exact upstream version source_missing; Flaga sandbox w aplikacji nie tworzy sandboxu dostawcy; lokalny dokument DEMO nie jest fakturą Fakturownia/KSeF. |
| Mirakl Seller (DEV) | 3 / 6, plus 2 code operations outside registry | MMP Seller OpenAPI3; source wired in isolated DEV; no ordinary runtime, official sandbox or account acceptance. |

## Pokrycie operacji

Każda poniższa nazwa ma własny wiersz JSON z wymaganiem, pozytywem, negatywem, utratą odpowiedzi, readback i dowodami. `implemented` to deklaracja registry; per-operation callsite audit pozostaje jawnie niewykonany.

### DeepL

Źródło: [registry](../../server/integrations.ts#L18); [dokumentacja wskazana w kodzie](https://developers.deepl.com/api-reference/translate/request-translation) — tego URL dostawcy nie zweryfikowano zdalnie w tej turze.

Implemented: `connection.read`, `languages.v3`, `usage.read`, `catalog.translation.preview`, `catalog.translation.queue`, `catalog.translation.review`, `catalog.translation.apply`, `catalog.translation.batch`.

Planned: `translation.glossaries`, `translation.documents`, `translation.parameters`, `translation.publish`.

### Email SMTP

Źródło: [registry](../../server/integrations.ts#L44); [dokumentacja wskazana w kodzie](https://nodemailer.com/smtp) — tego URL dostawcy nie zweryfikowano zdalnie w tej turze.

Implemented: `connection.test`, `email.preview`, `email.queue`, `email.smtp`, `email.history`, `email.html`, `email.automation`, `email.schedules`, `email.order_actions`, `email.attachments`.

Planned: `email.inbound`, `gmail.oauth`, `email.label_attachments`.

### Amazon

Źródło: [registry](../../server/integrations.ts#L67); [dokumentacja wskazana w kodzie](https://developer-docs.amazon.com/sp-api/docs/orders-api) — tego URL dostawcy nie zweryfikowano zdalnie w tej turze.

Implemented: `oauth.authorization_code`, `account.bind.oauth_callback`, `oauth.refresh`, `connection.read`, `orders.preview`, `orders.stage`, `orders.import`, `products.link.sku`, `orders.schedule`, `api.rate.shared`, `api.cooldown.shared`, `catalog.read`, `catalog.reports.bulk`, `catalog.variants`, `prices.sync`, `stock.sync`, `offers.schedule`, `offers.reconcile`, `sellers.participations.read`, `fulfillment.write`, `fulfillment.reconcile`.

Planned: `account.identity.read`, `offers.publish`, `payments.reconcile`, `fba.orders`, `webhooks.receive`.

### eBay

Źródło: [registry](../../server/integrations.ts#L116); [dokumentacja wskazana w kodzie](https://developer.ebay.com/api-docs/sell/fulfillment/overview.html) — tego URL dostawcy nie zweryfikowano zdalnie w tej turze.

Implemented: `oauth.refresh`, `oauth.authorization_code`, `account.identity.read`, `account.binding.immutable`, `connection.read`, `orders.preview`, `orders.stage`, `orders.import`, `products.link.sku`, `orders.schedule`, `catalog.read`, `catalog.bulk`, `catalog.variants`, `catalog.mapping`, `prices.read`, `stock.external.read`, `offers.sync.preview`, `prices.sync`, `stock.sync`, `offers.sync.schedule`, `offers.sync.reconcile`, `offers.sync.revision_budget`, `api.concurrency.shared`, `api.cooldown.shared`, `offers.create.inventory_draft`, `seller.policies.read`, `seller.locations.read`, `categories.search`, `categories.aspects.read`, `offers.create.aspects.validate`, `offers.create.reconcile`, `offers.publish.existing`, `offers.publish.reconcile`, `fulfillment.preview`, `fulfillment.write`, `fulfillment.reconcile`, `fulfillment.schedule`.

Planned: `offers.publish.group`, `offers.draft.sync`, `stock.lot_units`, `api.quota.provider.read`, `fulfillment.update`, `webhooks.receive`, `payments.reconcile`.

### Odoo

Źródło: [registry](../../server/integrations.ts#L180); [dokumentacja wskazana w kodzie](https://www.odoo.com/documentation/19.0/developer/reference/external_api.html) — tego URL dostawcy nie zweryfikowano zdalnie w tej turze.

Implemented: `connection.read`, `products.preview`, `catalog.bulk`, `catalog.variants`, `catalog.mapping`, `stock.external.read`, `prices.read`, `invoices.export`, `invoices.pdf.cached`, `catalog.images.primary.import`, `invoices.post`, `invoices.reconcile`, `orders.import`, `orders.sync`, `payments.transactions.read`, `stock.schedule.external`, `prices.schedule.local`.

Planned: `invoices.pdf.generate`, `payments.accounting.read`, `payments.complex.reconcile`, `invoices.corrections`, `catalog.images.gallery`.

### DPD Polska

Źródło: [registry](../../server/integrations.ts#L216); [dokumentacja wskazana w kodzie](https://dpdservices.dpd.com.pl/swagger-ui/index.html) — tego URL dostawcy nie zweryfikowano zdalnie w tej turze.

Implemented: `connection.read`, `shipment.preview`, `shipment.create`, `shipment.reconcile`, `label.pdf.cached`, `shipment.dispatch.local`, `pickup.availability`, `pickup.preview`, `pickup.create`, `pickup.cancel`, `pickup.resolve.manual`, `pickup.schedule`, `protocol.pdf.cached`, `tracking.read`, `tracking.schedule`, `tracking.renumbering`.

Planned: `pickup.update`, `returns.label`, `multiparcel`.

### BigBuy

Źródło: [registry](../../server/integrations.ts#L245); [dokumentacja wskazana w kodzie](https://api.bigbuy.eu/rest/doc) — tego URL dostawcy nie zweryfikowano zdalnie w tej turze.

Implemented: `connection.read`, `supplier.product.read`, `supplier.variant.read`, `supplier.stock.read`, `supplier.prices.read`, `supplier.purchase.local`, `catalog.bulk`, `stock.schedule`.

Planned: `dropshipping.orders.write`, `fulfillment.reconcile`.

### Shopify

Źródło: [registry](../../server/integrations.ts#L266); [dokumentacja wskazana w kodzie](https://shopify.dev/docs/api/admin-graphql/2026-10) — tego URL dostawcy nie zweryfikowano zdalnie w tej turze.

Implemented: `connection`, `oauth.authorization_code`, `oauth.refresh`, `account.identity`, `orders.preview`, `products.preview`, `orders.stage`, `orders.import`, `orders.read.single`, `orders.import.revalidate`, `orders.observations.monotonic`, `webhooks.receive`, `webhooks.orders.revalidate`, `webhooks.retry`, `webhooks.subscriptions.read`, `webhooks.subscriptions.write`, `webhooks.subscriptions.reconcile`, `products.link`, `orders.schedule`, `discounts.allocate`, `presentment.currency`, `offers.preview`, `offers.queue`, `offers.reconcile`, `offers.schedule`, `catalog.fetch`, `catalog.import.local`, `catalog.variants.local`, `inventory.location`, `price.sync`, `stock.sync`, `offers.publish`, `publications.read`, `fulfillment.preview`, `fulfillment.write`, `fulfillment.reconcile`.

Planned: `fulfillment.partial`, `fulfillment.multiple_locations`, `fulfillment.schedule`, `fulfillment.tracking.update`, `webhooks.privacy`, `webhooks.lifecycle`, `payments.reconcile`.

### SMSAPI

Źródło: [registry](../../server/integrations.ts#L323); [dokumentacja wskazana w kodzie](https://www.smsapi.pl/docs/) — tego URL dostawcy nie zweryfikowano zdalnie w tej turze.

Implemented: `connection.test`, `sms.preview`, `sms.test`, `sms.history`, `sms.automation`, `sms.schedule`, `sms.order.batch`.

Planned: `sms.send`, `sms.delivery.callback`.

### PrestaShop

Źródło: [registry](../../server/integrations.ts#L343); [dokumentacja wskazana w kodzie](https://devdocs.prestashop-project.org/9/webservice/) — tego URL dostawcy nie zweryfikowano zdalnie w tej turze.

Implemented: `connection`, `orders.preview`, `products.preview`, `orders.stage`, `orders.import`, `products.link`, `orders.schedule`, `multishop.scope`, `stock.sync`, `price.sync`, `offers.preview`, `offers.queue`, `offers.reconcile`, `offers.schedule`, `discounts.allocate`, `payments.read`, `payments.reconcile`, `payments.schedule`, `status.preview`, `status.queue`, `status.reconcile`, `status.schedule`.

Planned: `offers.create`, `webhooks.module`.

### Allegro

Źródło: [registry](../../server/integrations.ts#L378); [dokumentacja wskazana w kodzie](https://developer.allegro.pl/documentation/) — tego URL dostawcy nie zweryfikowano zdalnie w tej turze.

Implemented: `connection`, `orders.preview`, `offers.preview`, `oauth.refresh`, `oauth.authorization_code`, `oauth.refresh.auto`, `orders.schedule`, `orders.events`, `orders.stage`, `orders.import`, `offers.link`, `offers.plan`, `offers.update`, `stock.sync.manual`, `price.sync.manual`, `stock.sync.auto`, `price.sync.auto`, `orders.status.preview`, `orders.status.write`, `orders.status.auto`, `orders.status.reconcile`, `publish.existing`, `oauth.offers_write`, `offers.create.catalog_draft`, `offers.batch.create`, `offers.batch.publish`, `catalog.search`, `catalog.category.parameters`, `seller.settings.read`, `oauth.orders_write`, `payments.read`, `payments.reconcile`, `payments.schedule`.

Planned: `catalog.product.create`, `gpsr.responsible_person`.

### WooCommerce

Źródło: [registry](../../server/integrations.ts#L424); [dokumentacja wskazana w kodzie](https://woocommerce.github.io/woocommerce-rest-api-docs/) — tego URL dostawcy nie zweryfikowano zdalnie w tej turze.

Implemented: `connection`, `orders.preview`, `products.preview`, `product.update`, `orders.stage`, `orders.import`, `products.link`, `catalog.fetch`, `catalog.import.local`, `catalog.variants.local`, `orders.schedule`, `webhooks.receive`, `offers.plan`, `offers.create.draft`, `variable.create`, `variations.create`, `variations.batch.preview`, `variations.batch.publish`, `offers.update`, `publish.existing`, `stock.sync.manual`, `price.sync.manual`, `stock.sync.auto`, `price.sync.auto`, `orders.status.preview`, `orders.status.write`, `orders.status.auto`, `orders.status.reconcile`, `payments.read`, `payments.reconcile`, `payments.schedule`.

Planned: brak wpisów; nie oznacza pełnej parytety.

### InPost ShipX

Źródło: [registry](../../server/integrations.ts#L468); [dokumentacja wskazana w kodzie](https://dokumentacja-inpost.atlassian.net/wiki/spaces/PL/overview) — tego URL dostawcy nie zweryfikowano zdalnie w tej turze.

Implemented: `connection`, `points.search`, `shipment.get`, `shipment.quote`, `shipment.buy`, `shipment.cancel`, `label.pdf`, `tracking.manual`, `tracking.auto`.

Planned: `dispatch_order`, `multiparcel`, `returns.label`.

### Fakturownia

Źródło: [registry](../../server/integrations.ts#L490); [dokumentacja wskazana w kodzie](https://github.com/fakturownia/API) — tego URL dostawcy nie zweryfikowano zdalnie w tej turze.

Implemented: `connection`, `invoices.preview`, `invoice.plan`, `invoice.create`, `invoice.reconcile`, `correction.full_return`, `invoice.pdf`, `invoice.status.manual`.

Planned: `correction.partial`, `invoice.status.auto`, `ksef.send`, `ksef.upo`, `email`.

## Zakres Base do rozpoznania

[Oficjalny katalog Base](https://base.com/pl-PL/integracje/) i [przegląd pomocy](https://base.com/pl-PL/pomoc/wiedza/integracje/) sprawdzono 2026-10-17. Potwierdzono koszyki: Marketplace, sklepy internetowe, wysyłka, księgowość/ERP, SMS, pozostałe, hurtownie, PIM, WMS, fulfillment oraz „Coming soon”. Ostatni to stan publikacji, nie dowód gotowej integracji. Dynamicznego rosteru nie enumerowano w całości; nie przyjmujemy marketingowej liczby integracji jako mianownika parytety.

Przykłady do dalszego rozpoznania obejmują eMAG, [Empik](https://base.com/pl-PL/integracje-marketplace/), Ceneo, Magento, Shoplo, Przelewy24 i drukarki chmurowe. Obecność w oficjalnym katalogu nie dowodzi dostępnego publicznego API ani jego kodu w projekcie. `coverage_gaps` rozdziela wszystkie koszyki, aktualnych członków registry i discovery pending. Wewnętrzny PIM/WMS aplikacji nie oznacza konektora do każdego zewnętrznego PIM/WMS.

## Kolejność następnej pracy

1. Uzupełnić roster dostawca × operacja × region/wersja z oficjalnych źródeł; oznaczyć API publiczne, partner-only albo source_missing. Zachować obecne moduły.
2. Dla każdej operacji powiązać konkretny callsite i fixture publicznego kontraktu; osobno pozytyw, błędny auth/scope, 429/timeout, ACK-loss oraz odczyt skutku. Nie uruchamiać niepewnej mutacji ponownie.
3. Odebrać normalny UI/API i lifecycle workera: start, harmonogram, kolejka, close/drain, restart, dedup i odzyskiwanie; scoped worker nie zastępuje uniwersalnego globalnego workera.
4. Sandbox i autoryzowane konto dostawcy pozostawić oddzielnymi odbiorami. Lokalny fixture nie nadaje im PASS. Brak konta nie uzasadnia udawania pełnej integracji.

Nie zmieniono aktywnych kryteriów V2, kodu, runtime, danych ani konfiguracji.


## Addytywne rozszerzenie DEV: Mirakl Seller

Źródło pierwotnej implementacji Mirakl: izolowane `development/full-base`, commit `6fd6ebc5e9d5e87d5fe539632bea5081e63aa2d4`. `local-app/server` pozostaje historycznym źródłem poprzednich 14 dostawców. Aktualizacja matrycy nie przenosi kodu DEV na Main i nie zmienia dawnych wymagań, poziomów dowodu ani zamrożonych wejść v1. W chwili pierwotnego rozszerzenia pliki macierzy P i DEV/docs/parity były identyczne; poniższy przegląd pinów dotyczy wyłącznie bieżącej kopii roboczej DEV.

| Operacje | Stan źródłowy | Granica dowodu |
|---|---|---|
| account.read.A01, orders.read.OR11, offers.read.OF21 | Literalnie implemented w DEV registry; klient, trwały cache/budżet i jawne UI/API podpięte | Brak przyznanego normalnego UI/API, sandbox lub account acceptance |
| orders.stage, orders.import | Podpięte trusted OR11 → staging → mapowanie → zwykły OMS writer; registry nadal planned | Rozbieżność jest jawna. Current session/tenant/source/connection i Source106 wymagają rzeczywistego odbioru zapisu |
| products.link.sku, api.rate.shared | Źródłowe callsites poza listą operacji registry | Własne wymagania i dowody; nie podnoszą registry implemented |
| orders.schedule | Istnieje kontrolowany port checkpoint/repository; rzeczywisty worker nieodebrany | Nie uznawać testów portu za instalację workera |
| offers.write, fulfillment.write, webhooks.receive | Planned | Stock/pricing, pełne zastąpienie, status/readback i fulfillment pozostają otwarte. MMP webhooki są Operator-only, oddzielnie od Seller pollingu |

Każdy z 11 nowych wierszy zachowuje wymagany poziom **account**; local/sandbox/account evidence pozostają puste. Nazwy testów i zgłoszone zakończone sesje narzędzi nie mają trwałego przypiętego receipt dla tego wydania: nie przyznano im odbioru ani nie wykorzystano agregowanej liczby testów jako dowodu. W macierzy są przypięte pliki kodu i locatory testów.

Publiczne kontrakty z istniejącego rozpoznania: [A01](https://developer.mirakl.com/content/product/mmp/rest/seller/openapi3/stores), [OR11](https://developer.mirakl.com/content/product/mmp/rest/seller/openapi3/orders/or11), [OF21](https://developer.mirakl.com/content/product/mmp/rest/seller/openapi3/offers/of21), [OpenAPI3](https://developer.mirakl.com/specs/content/product/mmp/rest/seller/openapi3-download.json?download=). Odczytany wcześniej snapshot OpenAPI miał 1194628 B i SHA-256 `7405cdd62c3c824e43ec051d3d84c78864ad4ee083b6e09f7ab3ee5ea3347cc8`; tej aktualizacji nie towarzyszy ponowne pobranie dokumentacji ani wywołanie biznesowego API. Projekt pełnego przekroju i otwarte warianty opisuje [next-connector-contract.md](next-connector-contract.md); jest to historyczny plan, a nie obecny status wdrożenia.

182 etykiety rodziny Mirakl z rosteru pozostają osobnymi wymaganiami bez odbioru konta. Ta aktualizacja nie zmienia rosteru, nie zamyka discovery ani pełnego Goala. Scope.v2 ma zachować pełne scope.v1 i dodać wymagania Mirakl; zamknięcie zakresu nadal nie oznacza odbioru implementacji.

Scope.v2 utworzony istniejącym narzędziem: SHA-256 `49d078d47a53438818bc375ea4489c0334eaafa3b57ba8d0ae7a0015969fecea`, 2585 wymagań, 13 dodatków (11 operacji, dostawca, luka rodziny). Wszystkie 2572 wcześniejsze definicje i poziomy dowodu zachowano. Checker: valid=true, 89 zweryfikowanych plików, completion_review_candidate=false. scope_complete=false i acceptance_granted=false.

### Plikowy przegląd dwóch pinów Mirakl — 2026-10-17

Zaktualizowano wyłącznie dwa odwołania code evidence w bieżącej macierzy DEV. Oba dawne pliki odtworzono z commitu `6fd6ebc5e9d5e87d5fe539632bea5081e63aa2d4` i porównano z aktualnym kodem; to przegląd semantyki różnicy, nie ślepa zmiana hashy.

| Wiersz | Plik i zmiana od pierwotnego pinu | Aktualny pin |
|---|---|---|
| `integration.mirakl.orders.stage` | `server/app.ts`: tylko import i oczekiwana rejestracja tras korekt zwrotów (dwie dodane linie); callsite trusted OR11→stage i jego actor/connection admission bez zmian. |102121 B, SHA `5e8c69022baf302b4a68d28091f9d2729c722425b1828e8babf5d061e44607b7` |
| `integration.mirakl.orders.import` | `server/db.ts`: tylko trzy wpisy migratora206/207/208; istniejące Mirakl tx/session authority hooks bez zmian. |38979 B, SHA `35f7084c683b7f6bde18735d0cfdf18becb95b21a44b667130d1b047bd624543` |

Stare piny: app `e89940375a9942aa2cf9b014c5a941aaa799baa13ad1412024e97c1244925074`/101981 B; db `bca15986835a52fd7a72ddf57ab5fc25dd61bc564318c49bf177fa43cb25611d`/38709 B. Pozostałe evidence entries, wymagania, operations/status, wymagany poziom account oraz pending acceptance zachowano dokładnie. Nowa rejestracja/migracje zmieniają zależności startu/schematu; nie dowodzą dostępności runtime Mirakl. Nie wykonano nowych testów biznesowych ani wywołań konta, a local/sandbox/account pozostają puste. Frozen scope.v2/scope-inputs i roster pozostają literalne.
