import { SmtpClient } from './smtp';
import { DeepL } from './deepl';
import { Amazon, amazonSettings } from './amazon';
import { amazonApiTransport } from './amazon-api-limits';
import { Ebay } from './ebay';
import { OdooSales } from './odoo-orders';
import { Shopify } from './shopify';
import { BigBuy } from './bigbuy';
export { Shopify } from './shopify';
import { z } from 'zod';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { setTimeout } from 'node:timers/promises';
import { ensure, Problem } from './errors';
import { psId, psStateIds } from './prestashop-orders';
import { Dhl } from './carrier-dhl';
import { PocztaPolska } from './carrier-pocztapolska';
export const registry = [
  {
    id: 'mirakl', name: 'Mirakl Seller', category: 'Marketplace', color: '#206be8',
    docs: 'https://developer.mirakl.com/content/product/mmp/rest/seller',
    fields: ['api_key'], settings: ['instance_url', 'shop_id', 'currency'],
    implemented: ['account.read.A01', 'orders.read.OR11', 'offers.read.OF21', 'orders.stage', 'orders.import', 'products.link.sku', 'api.rate.shared', 'orders.schedule', 'offers.write', 'fulfillment.write', 'webhooks.receive'],
    planned: [],
    note: 'Odczyt konta, zamówień i ofert własnego sklepu Mirakl MARKETPLACE, w walucie PLN/EUR/USD/GBP/CZK. Wymaga danych od operatora oraz włączenia konkretnej instancji i trwałych limitów API w środowisku lokalnym. Ręczny import: odczyt OR11 do przeglądu z kontrolą połączenia, powiązanie offer_id z lokalnym SKU i zatwierdzenie aktualnego podglądu; wspólny trwały limit odczytów na instancję. Harmonogram odczytu OR11 do kolejki importu pod tym samym limitem; zapis cen i stanów ofert (OF24 z raportem OF02/OF03), akceptacja, numer przesyłki i wysyłka zamówień (OR21/OR23/OR24) z uzgodnieniem odczytem po utraconej odpowiedzi; powiadomienia operatora z tajnym tokenem w ścieżce tylko przyspieszają odczyt. Zapisy działają wyłącznie w symulacji lokalnej; zapis na koncie operatora czeka na dostawcę (umowa i zgoda operatora). Dostępność należy potwierdzić osobno dla swojego operatora i konta.',
  },
  {
    id: 'deepl',
    name: 'DeepL',
    category: 'Tłumaczenia',
    color: '#0f2b46',
    docs: 'https://developers.deepl.com/api-reference/translate/request-translation',
    fields: ['api_key'],
    settings: ['api_plan'],
    implemented: [
      'connection.read',
      'languages.v3',
      'usage.read',
      'catalog.translation.preview',
      'catalog.translation.queue',
      'catalog.translation.review',
      'catalog.translation.apply',
      'catalog.translation.batch',
    ],
    planned: [
      'translation.glossaries',
      'translation.documents',
      'translation.parameters',
      'translation.publish',
    ],
    note: 'Rzeczywiste API Free lub Pro, bez sandboxu dostawcy. Klucz API szyfrowany na serwerze, języki i limity z API. Tłumaczenie nazwy/opisu po zgodzie na użycie znaków; osobny przegląd i zapis wersji językowej. Lokalny przykład oznaczony jako symulacja. Konto DeepL wymaga osobnej weryfikacji; po niepewnej odpowiedzi brak automatycznego replay.',
  },
  {
    id: 'smtp',
    name: 'Email SMTP',
    category: 'Komunikacja',
    color: '#5357cf',
    docs: 'https://nodemailer.com/smtp',
    fields: ['username', 'password'],
    settings: ['host', 'port', 'from_email', 'from_name'],
    implemented: [
      'connection.test',
      'email.preview',
      'email.queue',
      'email.smtp',
      'email.history',
      'email.html',
      'email.automation',
      'email.schedules',
      'email.order_actions',
      'email.attachments',
      'email.inbound',
    ],
    planned: ['gmail.oauth', 'email.label_attachments'],
    note: 'Własna skrzynka SMTP: TLS465 lub wymagany STARTTLS587. Osobny lokalny odbiornik1025 bez przekazywania na zewnątrz. Akceptacja serwera nie potwierdza doręczenia. Poczta przychodząca IMAP TLS993: podgląd, import do zamówienia i odpowiedź SMTP; skrzynka dostawcy niepotwierdzona. Niepewna próba nie jest automatycznie ponawiana. Wysyłka zewnętrzna wymaga autoryzacji operatora.',
  },
  {
    id: 'amazon',
    name: 'Amazon',
    category: 'Marketplace',
    color: '#ff9900',
    docs: 'https://developer-docs.amazon.com/sp-api/docs/orders-api',
    fields: ['client_id', 'client_secret', 'refresh_token'],
    settings: [
      'region',
      'marketplace_id',
      'selling_partner_id',
      'listing_write',
      'shipment_write',
      'application_id',
      'oauth_redirect_uri',
      'oauth_beta',
    ],
    implemented: [
      'oauth.authorization_code',
      'account.bind.oauth_callback',
      'oauth.refresh',
      'connection.read',
      'orders.preview',
      'orders.stage',
      'orders.import',
      'products.link.sku',
      'orders.schedule',
      'api.rate.shared',
      'api.cooldown.shared',
      'catalog.read',
      'catalog.reports.bulk',
      'catalog.variants',
      'prices.sync',
      'stock.sync',
      'offers.schedule',
      'offers.reconcile',
      'sellers.participations.read',
      'fulfillment.write',
      'fulfillment.reconcile',
    ],
    planned: [
      'account.identity.read',
      'offers.publish',
      'payments.reconcile',
      'fba.orders',
      'webhooks.receive',
    ],
    note: 'Import zamówień Amazon do lokalnego magazynu: podgląd, powiązanie SKU i kontrola przed rezerwacją. Obsługuje niewysłane zamówienia realizowane przez sprzedawcę. Wymaga danych aplikacji, tokena zgody sprzedawcy oraz dostępu do adresu odbiorcy. Płatności uzgadniasz osobno. FBA, anulowania i złożone rozliczenia wymagają dalszej obsługi. Sandbox Amazon wymaga danych aplikacji; przykład lokalny działa bez kluczy. Połączenie z kontem dostawcy pozostaje do potwierdzenia',
  },
  {
    id: 'ebay',
    name: 'eBay',
    category: 'Marketplace',
    color: '#3665f3',
    docs: 'https://developer.ebay.com/api-docs/sell/fulfillment/overview.html',
    fields: ['client_id', 'client_secret', 'ru_name', 'refresh_token'],
    settings: [
      'inventory_access',
      'marketplace_id',
      'price_mode',
      'fulfillment_write',
      'seller_settings_read',
    ],
    implemented: [
      'oauth.refresh',
      'oauth.authorization_code',
      'account.identity.read',
      'account.binding.immutable',
      'connection.read',
      'orders.preview',
      'orders.stage',
      'orders.import',
      'products.link.sku',
      'orders.schedule',
      'catalog.read',
      'catalog.bulk',
      'catalog.variants',
      'catalog.mapping',
      'prices.read',
      'stock.external.read',
      'offers.sync.preview',
      'prices.sync',
      'stock.sync',
      'offers.sync.schedule',
      'offers.sync.reconcile',
      'offers.sync.revision_budget',
      'api.concurrency.shared',
      'api.cooldown.shared',
      'offers.create.inventory_draft',
      'seller.policies.read',
      'seller.locations.read',
      'categories.search',
      'categories.aspects.read',
      'offers.create.aspects.validate',
      'offers.create.reconcile',
      'offers.publish.existing',
      'offers.publish.reconcile',
      'fulfillment.preview',
      'fulfillment.write',
      'fulfillment.reconcile',
      'fulfillment.schedule',
      'api.quota.provider.read',
    ],
    planned: [
      'offers.publish.group',
      'offers.draft.sync',
      'stock.lot_units',
      'fulfillment.update',
      'webhooks.receive',
      'payments.reconcile',
    ],
    note: 'Sell Fulfillment: import zamówień z TAX_BREAKDOWN, SKU sprzedawcy, ponowny odczyt przed zatwierdzeniem i lokalna rezerwacja. Klucze aplikacji oraz RuName albo wcześniej uzyskany refresh token; osobne dane sandbox/live. Panel zgody OAuth: odczyt zamówień, odczyt katalogu albo zapis cen/stanów; powrót automatyczny i ręczny. Jednorazowy kod wymieniany po stronie serwera, tokeny szyfrowane i odświeżane. Zgoda przypisana do firmy/użytkownika/sesji i wersji połączenia. Rozpoczęcie próby wyłącza harmonogramy. Trading GetUser i podstawowy api_scope: porównanie stałego EIAS przed zapisem nowych tokenów, także po zmianie nazwy. Kanał trwale przypisany do skrótu identyfikatora; inne konto wymaga nowego kanału. Starszy refresh wymaga najpierw odczytu starego konta. Pełny profil ani EIAS nie są zapisywane. Rejestracja lokalnego callbacku i uwierzytelniony dostawca niepotwierdzone. Pierwszy odczyt 90 dni, następne zmiany z nakładką 10 minut; trwały postęp stron. Bez automatycznego zatwierdzania, FX ani nadpisywania importów. Starsze zamówienia bez email nie mogą przejść importu. Anulowania, częściowe realizacje/płatności, zwroty, opłaty i programy wysyłkowe wymagają uzgodnienia. VAT lokalnego katalogu, kwoty brutto źródła. Inventory: opcjonalny zakres sell.inventory.readonly, katalog SKU, grupy wariantów i oferty wybranego marketplace. Jawny tryb cen netto/brutto, lokalny VAT. Dostępność eBay osobno od fizycznego magazynu, nowe SKU ze stanem zero. Powiązanie po SKU; ceny i dane istniejących SKU zachowane. Obejmuje zasoby Inventory API; starsze oferty Trading nie są automatycznie migrowane. Zapis cen i dostępności istniejących aktywnych ofert FIXED_PRICE po osobnej zgodzie sell.inventory; podgląd wszystkich rynków wspólnego SKU, minimalny POST, harmonogram i uzgadnianie odczytem po awarii bez ponawiania mutacji. Stan 0 zależy od ustawienia Out-of-Stock Control; zakończenie oferty wymaga uzgodnienia. Partie lotSize wymagają przelicznika, aktywne aukcje ograniczają zmniejszenie puli. Limit dostawcy 250 rewizji listingu dziennie; trwały budżet 250 prób w kroczącym oknie 24 godzin, wspólny dla zweryfikowanego konta, środowiska i aukcji we wszystkich firmach/kanałach. Zmiana puli obejmuje aukcje innych rynków; rezerwacja atomowa przed zapisem. Wyczerpanie odkłada zadanie bez zużywania prób ponawiania; można anulować oczekiwanie i przygotować nowy plan. Niejednoznaczna odpowiedź zachowuje zużyty budżet; GET i zgodny stan go nie zużywają. Wspólna kontrola aplikacji i środowiska: 4 jednoczesne żądania na rodzinę Inventory/Fulfillment/Account/Taxonomy/OAuth/Trading, trwała przerwa po 429 według Retry-After i odłożenie bez zużycia prób. Zapisy rezerwują miejsce przed fazą rozpoczęcia; odczyty wznawiają trwały etap, bez ponownego POST. Panel pokazuje miejscowe obserwacje; dzienna pula eBay i użycie innych narzędzi wymagają osobnej weryfikacji. Publikacja istniejącego szkicu FIXED_PRICE: jawne ID, sprawdzona tożsamość konta i zakres sell.inventory; podgląd ceny, ilości, treści, lokalizacji oraz trzech warunków. Cena i stan zachowane, pojedynczy POST bez body, uzgodnienie GET po niepewnej odpowiedzi. Tworzenie nowego szkicu pojedynczego SKU lub zestawu: lokalny opis, publiczne zdjęcia HTTPS, parametry, kategoria, lokalizacja i trzy warunki; cena z cennika i dostępność po rezerwacjach. Inventory PUT i offer POST z trwałym postępem, znacznikiem planu oraz uzgodnieniem odczytem bez ponawiania niepewnego żądania. Obcy rekord nie jest nadpisywany; zachowany własny Inventory można ponownie przygotować po zamknięciu wyniku odczytem. Publikacja osobno. Zachowanie znacznika przez uwierzytelnionego dostawcę niepotwierdzone. Grupy wymagają osobnego procesu. Account: opcjonalna zgoda sell.account.readonly, wybór istniejących warunków płatności/zwrotu/dostawy i lokalizacji Inventory. Taxonomy: osobny token aplikacji client_credentials, sugestie i kategorie końcowe, wymagane parametry oraz słowniki/zależności. Nadpisania parametrów tylko dla oferty. Ponowny odczyt przed PUT i POST, zatrzymanie przy zmianie; GET po niepewnym zapisie nie wymaga ponownego odczytu Account. Ręczne ID jawnie bez weryfikacji Account/Taxonomy. Warunki pojazdów i zaawansowane reguły kategorii nieobsługiwane lokalnie; dostawca sprawdza publikację ostatecznie. Uwierzytelniony Account/Taxonomy niepotwierdzony; publikacja może rozpocząć sprzedaż i naliczyć opłaty. Przekazanie wysyłki: osobny sell.fulfillment, cała przekazana przesyłka, jawny kod przewoźnika, ID pozycji z importu i minimalny POST; trwała faza przed zapisem oraz uzgodnienie GET bez ponawiania po awarii. Automatyzacja co minutę: sprawdzona tożsamość konta, jawna zgoda i dokładne mapowania lokalnych przewoźników. Partie25, trwałe pokwitowania, próg100 oczekujących; wyłączenie zatrzymuje niewysłane plany, niepewny zapis zachowuje odczyt. Przesyłki DEMO nie trafiają na konto dostawcy. Konto dostawcy niepotwierdzone.',
  },
  {
    id: 'odoo',
    name: 'Odoo',
    category: 'ERP',
    color: '#714b67',
    docs: 'https://www.odoo.com/documentation/19.0/developer/reference/external_api.html',
    fields: ['api_key'],
    settings: ['server_url', 'database', 'company_id', 'warehouse_id', 'unit_id', 'price_mode'],
    implemented: [
      'connection.read',
      'products.preview',
      'catalog.bulk',
      'catalog.variants',
      'catalog.mapping',
      'stock.external.read',
      'prices.read',
      'invoices.export',
      'invoices.pdf.cached',
      'catalog.images.primary.import',
      'invoices.post',
      'invoices.reconcile',
      'orders.import',
      'orders.sync',
      'payments.transactions.read',
      'stock.schedule.external',
      'prices.schedule.local',
    ],
    planned: [
      'invoices.pdf.generate',
      'payments.accounting.read',
      'payments.complex.reconcile',
      'invoices.corrections',
      'catalog.images.gallery',
    ],
    note: 'Odoo 19 JSON-2: odczyt katalogu, wariantów, cen i dostępności jednego magazynu wybranej firmy. Klucz API użytkownika, nazwa bazy, ID firmy/magazynu/jednostki sztukowej i jawny wybór cen netto/brutto. Lokalny VAT wybierany przy imporcie; podatki ERP nie są kopiowane. Katalog do przeglądu i zatwierdzenia, dostępność ERP osobno od magazynu fizycznego. Sandbox oznacza osobną instancję testową, nie automatyczny sandbox Odoo. Eksport istniejącej faktury: jawny kontrahent/dziennik/konto/podatki, szkic i kontrola kwot, osobne księgowanie i uzgodnienie bez ponownego create/action_post po niepewnej odpowiedzi. Bez rejestrowania płatności i wysyłki w ERP. Import potwierdzonych zamówień: kwoty ERP, ID wariantów, ponowny odczyt przed zatwierdzeniem i atomowa rezerwacja lokalna. Wpłaty tylko z zakończonych transakcji jednego zamówienia; autoryzacja nie jest wpłatą. Harmonogram śledzi write_date zamówienia z checkpointem; zmiany niezależnych płatności mogą wymagać pełnego odczytu, zmiany po imporcie ręcznego uzgodnienia. Harmonogram katalogu odczytuje powiązane warianty: dostępność ERP osobno, lokalne ceny po jawnym włączeniu, bez FX i nadpisywania zmienionych produktów. PDF istniejącej zaksięgowanej faktury: kontrola powiązania załącznika, szyfrowana kopia lokalna i pobranie offline. Brak PDF wymaga wygenerowania w ERP; konektor nie generuje ani nie wysyła dokumentu. Główne zdjęcie wariantu: lokalny podgląd, jawne dodanie do galerii, zachowanie pozostałych danych. Galeria ERP i automatyczne zdjęcia do wykonania. Uwierzytelniona instancja niepotwierdzona.',
  },
  {
    id: 'dpd',
    name: 'DPD Polska',
    category: 'Kurier',
    color: '#dc0032',
    docs: 'https://dpdservices.dpd.com.pl/swagger-ui/index.html',
    fields: ['username', 'password'],
    settings: ['master_fid'],
    implemented: [
      'connection.read',
      'shipment.preview',
      'shipment.create',
      'shipment.reconcile',
      'label.pdf.cached',
      'shipment.dispatch.local',
      'pickup.availability',
      'pickup.preview',
      'pickup.create',
      'pickup.cancel',
      'pickup.resolve.manual',
      'pickup.schedule',
      'protocol.pdf.cached',
      'tracking.read',
      'tracking.schedule',
      'tracking.renumbering',
    ],
    planned: ['pickup.update', 'returns.label', 'multiparcel'],
    note: 'DPDServices REST PL: paczka krajowa, COD i deklarowana wartość, numery i PDF A4. Odbiór do 200 gotowych paczek, dostępność godzin, anulowanie i zapisany protokół PDF. Wszystkie zapisy po zatwierdzeniu; cena według umowy. Niepewny odbiór potwierdza administrator u DPD bez powtarzania zamówienia. Sandbox to oficjalne DEMO DPD; przykład lokalny bez HTTP. Automatyczne podjazdy według dni i godzin w czasie polskim, do 2000 paczek i 20 partii na termin. Tracking SOAP DPD InfoServices: osobny login/hasło, historia, zmiany numeru i zwrot do nadawcy. Automatyczny odczyt tylko po zatwierdzeniu; bez rozliczenia COD i zmian magazynu.',
  },
  {
    id: 'bigbuy',
    name: 'BigBuy',
    category: 'Hurtownia',
    color: '#fa9826',
    docs: 'https://api.bigbuy.eu/rest/doc',
    fields: ['api_key'],
    settings: [],
    implemented: [
      'connection.read',
      'supplier.product.read',
      'supplier.variant.read',
      'supplier.stock.read',
      'supplier.prices.read',
      'supplier.purchase.local',
      'catalog.bulk',
      'stock.schedule',
    ],
    planned: ['dropshipping.orders.write', 'fulfillment.reconcile'],
    note: 'Punktowy i masowy odczyt produktów/wariantów, opisów, zdjęć, cen i dostępności według czasu przygotowania. Masowy katalog ma niezależną paginację sześciu zbiorów, wznawianie, wspólne limity tokena i harmonogram cen/dostępności hurtowni. Katalog dostawcy w Zakupach; dostępność zewnętrzna nie zwiększa fizycznego magazynu. Zakup lokalny z progami ceny, bez wysłania do BigBuy. Wymagany klucz API i potwierdzenie waluty konta; uwierzytelniony odczyt dostawcy niepotwierdzony.',
  },
  {
    id: 'shopify',
    name: 'Shopify',
    category: 'Sklep internetowy',
    color: '#95bf47',
    docs: 'https://shopify.dev/docs/api/admin-graphql/2026-10',
    fields: ['access_token', 'client_id', 'client_secret'],
    settings: ['store_url', 'oauth_redirect_uri'],
    implemented: [
      'connection',
      'oauth.authorization_code',
      'oauth.refresh',
      'account.identity',
      'orders.preview',
      'products.preview',
      'orders.stage',
      'orders.import',
      'orders.read.single',
      'orders.import.revalidate',
      'orders.observations.monotonic',
      'webhooks.receive',
      'webhooks.orders.revalidate',
      'webhooks.retry',
      'webhooks.subscriptions.read',
      'webhooks.subscriptions.write',
      'webhooks.subscriptions.reconcile',
      'products.link',
      'orders.schedule',
      'discounts.allocate',
      'presentment.currency',
      'offers.preview',
      'offers.queue',
      'offers.reconcile',
      'offers.schedule',
      'catalog.fetch',
      'catalog.import.local',
      'catalog.variants.local',
      'inventory.location',
      'price.sync',
      'stock.sync',
      'offers.publish',
      'publications.read',
      'fulfillment.preview',
      'fulfillment.write',
      'fulfillment.reconcile',
      'fulfillment.partial.merged_source',
    ],
    planned: [
      'fulfillment.partial',
      'fulfillment.multiple_locations',
      'fulfillment.schedule',
      'fulfillment.tracking.update',
      'webhooks.privacy',
      'webhooks.lifecycle',
      'payments.reconcile',
    ],
    note: 'Subskrypcje GraphQL: pełna lista aplikacji/sklepu, podgląd i zatwierdzany create/delete, minimalne pola ID, pojedyncza mutacja i odczyt po niepewnej odpowiedzi. Usunięcie wyłącznie własnej niezmienionej rejestracji; TOML aplikacji poza listą. Docelowy HTTPS musi być publicznie dostępny, aplikacja pozostaje lokalna; konto niepotwierdzone. Webhooki sześciu tematów zamówień i zwrotów: HMAC surowej treści, trwała deduplikacja dostaw, kolejka i odczyt GraphQL do bufora. Zmiany zaimportowanych zamówień wymagają uzgodnienia. Konfiguracja, pauza i ponowienie w panelu; lokalny przykład bez HTTP Shopify. Dostawy rzeczywiste wymagają dostępnego HTTPS i subskrypcji aplikacji; niepotwierdzone z kontem dostawcy. OAuth standalone: Client ID i sekret albo ręczny token istniejącej aplikacji. Podpisany powrót i jednorazowy kod, wygasający token offline i odświeżanie obu tokenów. Sklep identyfikowany przez GraphQL; nowe połączenie zatrzymuje harmonogramy. Dodatkowe prawa zapisu wybierane osobno. Przyjęcie lokalnego callbacku przez rejestrację Shopify niepotwierdzone. Realizacja wysłanej pełnej paczki: oficjalny fulfillmentCreate, jawne pozycje FulfillmentOrderLineItem z ilościami, wiele zleceń w jednej lokalizacji, tracking i opcjonalne powiadomienie. Wymagane read_orders/read_merchant_managed_fulfillment_orders, zapis write_merchant_managed_fulfillment_orders i fulfill_and_ship_orders użytkownika sklepu. Podgląd/zgoda, niezmienny plan, wspólna blokada sklepu/zamówienia i GET po niepewnym zapisie bez ponowienia. Wstrzymane, częściowe, wielolokalizacyjne lub niepełne przydziały odrzucane; bez automatycznego przenoszenia zleceń. Częściowa realizacja tylko dla zamówienia źródłowego scalonego lokalnie (podzbiór jego pozycji); ogólna częściowa wysyłka jednego zamówienia jest odrzucana. Konto dostawcy niepotwierdzone, DEMO pozostaje lokalne. GraphQL 2026-10: import zamówień, katalogu i wariantów oraz synchronizacja cen i stanów i publikacja istniejących produktów w wybranym kanale. Publikacja wymaga read_publications/write_publications; aktywacja szkicu write_products. Publikacja dotyczy całego produktu ze wszystkimi wariantami. Katalog wymaga read_products, a import stanów read_inventory i jednej wybranej lokalizacji. Cena wymaga write_products, stan write_inventory i wskazania lokalizacji. Mutacje wymagają zgody; wynik jest sprawdzany odczytem. Token zainstalowanej aplikacji, domena myshopify.com, read_orders/read_products i dostęp do danych kupującego. Domyślnie 60 dni historii; read_all_orders wymaga zgody Shopify. Sandbox oznacza osobny sklep deweloperski.',
  },
  {
    id: 'smsapi',
    name: 'SMSAPI',
    category: 'Komunikacja',
    auth: 'OAuth Bearer token',
    docs: 'https://www.smsapi.pl/docs/',
    fields: ['access_token'],
    settings: ['sender'],
    implemented: [
      'connection.test',
      'sms.preview',
      'sms.test',
      'sms.history',
      'sms.automation',
      'sms.schedule',
      'sms.order.batch',
      'sms.send',
      'sms.delivery.callback',
    ],
    planned: [],
    note: 'Profil konta oraz test=1 bez doręczenia. Symulacja lokalna dostępna w Komunikacja SMS bez tokenu. Wysyłka rzeczywista: połączenie live zakłada administrator z MFA, każda partia wymaga osobnej zgody, jeden POST bez ponowień; niepewny wynik nie jest wysyłany drugi raz. Raport doręczenia przez callback tylko z adresów IP SMSAPI i z tajnym tokenem w ścieżce (zaszyfrowany w połączeniu). Konto SMSAPI i publiczny adres HTTPS callbacku niepotwierdzone.',
  },
  {
    id: 'prestashop',
    name: 'PrestaShop',
    category: 'Sklep internetowy',
    color: '#df0067',
    docs: 'https://devdocs.prestashop-project.org/9/webservice/',
    implemented: [
      'connection',
      'orders.preview',
      'products.preview',
      'orders.stage',
      'orders.import',
      'products.link',
      'orders.schedule',
      'multishop.scope',
      'stock.sync',
      'price.sync',
      'offers.preview',
      'offers.queue',
      'offers.reconcile',
      'offers.schedule',
      'discounts.allocate',
      'payments.read',
      'payments.reconcile',
      'payments.schedule',
      'status.preview',
      'status.queue',
      'status.reconcile',
      'status.schedule',
    ],
    planned: ['offers.create', 'webhooks.module'],
    fields: ['api_key'],
    settings: ['store_url', 'shop_id', 'order_state_ids'],
    note: 'Import używa GET. Synchronizacja istniejących ofert wymaga GET/PATCH produktów, kombinacji i stock_availables oraz GET konfiguracji, walut, specific_prices (shops/shop_groups dla współdzielenia stanów). Statusy mają własne mapowanie ID w panelu synchronizacji, wymagają GET zamówienia/powiązań i order_states oraz POST order_histories; email historii wyłączony. Zapis jest potwierdzany; sandbox musi wskazywać osobny sklep testowy.',
  },
  {
    id: 'allegro',
    name: 'Allegro',
    category: 'Marketplace',
    color: '#ff6500',
    docs: 'https://developer.allegro.pl/documentation/',
    implemented: [
      'connection',
      'orders.preview',
      'offers.preview',
      'oauth.refresh',
      'oauth.authorization_code',
      'oauth.refresh.auto',
      'orders.schedule',
      'orders.events',
      'orders.stage',
      'orders.import',
      'offers.link',
      'offers.plan',
      'offers.update',
      'stock.sync.manual',
      'price.sync.manual',
      'stock.sync.auto',
      'price.sync.auto',
      'orders.status.preview',
      'orders.status.write',
      'orders.status.auto',
      'orders.status.reconcile',
      'publish.existing',
      'oauth.offers_write',
      'offers.create.catalog_draft',
      'offers.batch.create',
      'offers.batch.publish',
      'catalog.search',
      'catalog.category.parameters',
      'seller.settings.read',
      'oauth.orders_write',
      'payments.read',
      'payments.reconcile',
      'payments.schedule',
    ],
    planned: ['catalog.product.create', 'gpsr.responsible_person'],
    fields: [],
    settings: [],
    note: 'OAuth aplikacji DYNAMINDS; sandbox i produkcja. Nowe szkice Allegro PL pojedynczo lub w partiach do 200 SKU: istniejący produkt katalogu, parametry kategorii, dostawa/warunki konta oraz jawny producent i informacje bezpieczeństwa. Podgląd, zatwierdzenie, częściowe wyniki, przerwanie i wznowienie partii; także publikacja istniejących ofert z zachowaniem ceny i stanu. Wymaga offers:write i settings:read; publikacja osobno. Wynik 201/202 i niepewny POST uzgadniany po znaczniku bez ponownego tworzenia. Konto dostawcy niepotwierdzone.',
  },
  {
    id: 'woocommerce',
    name: 'WooCommerce',
    category: 'Sklep internetowy',
    color: '#8052b5',
    docs: 'https://woocommerce.github.io/woocommerce-rest-api-docs/',
    implemented: [
      'connection',
      'orders.preview',
      'products.preview',
      'product.update',
      'orders.stage',
      'orders.import',
      'products.link',
      'catalog.fetch',
      'catalog.import.local',
      'catalog.variants.local',
      'orders.schedule',
      'webhooks.receive',
      'offers.plan',
      'offers.create.draft',
      'variable.create',
      'variations.create',
      'variations.batch.preview',
      'variations.batch.publish',
      'offers.update',
      'publish.existing',
      'stock.sync.manual',
      'price.sync.manual',
      'stock.sync.auto',
      'price.sync.auto',
      'orders.status.preview',
      'orders.status.write',
      'orders.status.auto',
      'orders.status.reconcile',
      'payments.read',
      'payments.reconcile',
      'payments.schedule',
    ],
    planned: [],
    fields: ['consumer_key', 'consumer_secret'],
    settings: ['store_url'],
    note: 'Klucze REST API sklepu. Podgląd zmian, kolejka zapisu i weryfikacja wyniku; do zapisu wymagane klucze read/write.',
  },
  {
    id: 'inpost',
    name: 'InPost ShipX',
    category: 'Kurier',
    color: '#d2a900',
    docs: 'https://dokumentacja-inpost.atlassian.net/wiki/spaces/PL/overview',
    implemented: [
      'connection',
      'points.search',
      'shipment.get',
      'shipment.quote',
      'shipment.buy',
      'shipment.cancel',
      'label.pdf',
      'tracking.manual',
      'tracking.auto',
    ],
    planned: ['dispatch_order', 'multiparcel', 'returns.label'],
    fields: ['access_token'],
    settings: ['organization_id'],
    note: 'ShipX PL. Publiczna wyszukiwarka punktów działa bez tokena.',
  },
  {
    id: 'fakturownia',
    name: 'Fakturownia',
    category: 'Księgowość',
    color: '#0c9276',
    docs: 'https://github.com/fakturownia/API',
    implemented: [
      'connection',
      'invoices.preview',
      'invoice.plan',
      'invoice.create',
      'invoice.reconcile',
      'correction.full_return',
      'correction.partial',
      'invoice.pdf',
      'invoice.status.manual',
    ],
    planned: ['invoice.status.auto', 'ksef.send', 'ksef.upo', 'email'],
    fields: ['api_token'],
    settings: ['account_url'],
    note: 'Podgląd, kolejka faktur oraz pełnych i częściowych korekt zwrotu (kolejne korekty po przyjętym zwrocie, uzgodnienie bez drugiego POST), PDF. Zapis po zatwierdzeniu. Tryb sandbox w aplikacji nie tworzy osobnego środowiska u dostawcy.',
  },
  // L3 (migration 234): carriers wired on the DPD pattern; verified only against local fakes.
  {
    id: 'dhl',
    name: 'DHL Parcel Polska',
    category: 'Kurier',
    color: '#d40511',
    docs: 'https://dhl24.com.pl/webapi2',
    fields: ['username', 'password'],
    settings: ['sap_account'],
    implemented: ['connection', 'shipment.create', 'cod', 'label.pdf', 'tracking.read', 'pickup.book'],
    planned: ['points.search'],
    note: 'DHL24 WebAPI2 (SOAP): przesyłka krajowa z COD i ubezpieczeniem, etykieta PDF zapisana przy utworzeniu, tracking i zamówienie kuriera. Zapisy po zatwierdzeniu; utracona odpowiedź uzgadniana po referencji bez ponownego utworzenia. Sprawdzone tylko na lokalnym fake; kontrakt wymaga konta sandbox DHL24. Przykład lokalny bez HTTP.',
  },
  {
    id: 'pocztapolska',
    name: 'Poczta Polska',
    category: 'Kurier',
    color: '#e3001b',
    docs: 'https://e-nadawca.poczta-polska.pl/',
    fields: ['username', 'password', 'tracking_login', 'tracking_password'],
    settings: ['urzad_nadania'],
    implemented: ['connection', 'shipment.create', 'cod', 'label.pdf', 'tracking.read'],
    planned: ['pickup_point'],
    note: 'eNadawca (SOAP): Pocztex Kurier, Paczka pocztowa i doręczenie do punktu, COD na rachunek NRB, etykieta PDF zapisana przy utworzeniu; tracking usługą Śledzenie z osobnym loginem (tracking_login, tracking_password). Zapisy po zatwierdzeniu; utracona odpowiedź uzgadniana odczytem bufora po guid. Sprawdzone tylko na lokalnym fake; kontrakt wymaga konta testowego eNadawcy. Przykład lokalny bez HTTP.',
  },
];
export type Transport = (url: string, init: RequestInit) => Promise<Response>;
function privateAddress(ip: string) {
  if (
    ip === '::1' ||
    ip === '::' ||
    ip.startsWith('fc') ||
    ip.startsWith('fd') ||
    ip.startsWith('fe80') ||
    ip.startsWith('::ffff:')
  )
    return true;
  const parts = ip.split('.').map(Number);
  return (
    parts.length === 4 &&
    (parts[0] === 0 ||
      parts[0] === 10 ||
      parts[0] === 127 ||
      parts[0] >= 224 ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127))
  );
}
export async function validateRemoteUrl(url: string) {
  const u = new URL(url);
  ensure(
    u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      !u.hash &&
      !u.search &&
      (!u.port || u.port === '443'),
    422,
    'Adres integracji musi być publicznym adresem HTTPS bez danych logowania i parametrów',
  );
  ensure(
    !isIP(u.hostname) && u.hostname.includes('.') && !u.hostname.endsWith('.local'),
    422,
    'Nieprawidłowa domena integracji',
  );
  await publicAddresses(u.hostname);
  return u.origin + u.pathname.replace(/\/$/, '');
}
export async function publicAddresses(hostname: string) {
  const ips = await lookup(hostname, { all: true });
  ensure(
    ips.length > 0 && ips.every((i) => !privateAddress(i.address)),
    422,
    'Integracje nie mogą łączyć się z prywatnymi adresami',
  );
  return ips;
}
export const safeFetch: Transport = async (url, init) => {
  const u = new URL(url);
  await validateRemoteUrl(u.origin);
  try {
    return await fetch(url, {
      ...init,
      redirect: init.redirect === 'manual' ? 'manual' : 'error',
      signal: AbortSignal.timeout(12000),
    });
  } catch {
    throw new Problem(502, 'Brak odpowiedzi API dostawcy');
  }
};
export class ApiClient {
  constructor(
    public base: string,
    public credentials: Record<string, string>,
    public transport: Transport = safeFetch,
  ) {}
  async request(
    path: string,
    {
      method = 'GET',
      body,
      headers = {},
      query = {},
    }: {
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
      query?: Record<string, string | number>;
    } = {},
  ) {
    const u = new URL(this.base + path);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, String(v));
    for (let n = 0; n < 3; n++) {
      const res = await this.transport(u.toString(), {
        method,
        headers: {
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (method === 'GET' && (res.status === 429 || res.status >= 500) && n < 2) {
        const retry = Number(res.headers.get('retry-after'));
        await setTimeout(
          Math.min(5000, Number.isFinite(retry) && retry > 0 ? retry * 1000 : 300 * 2 ** n),
        );
        continue;
      }
      if (!res.ok) throw new Problem(res.status === 401 ? 401 : 502,
        `API dostawcy: HTTP ${res.status}`,
        res.status === 401 ? 'PROVIDER_HTTP_UNAUTHORIZED' : undefined);
      if (res.status === 204) return null;
      const reader = res.body?.getReader();
      ensure(reader, 502, 'Brak odpowiedzi JSON dostawcy');
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          ensure(size <= 5 * 1024 * 1024, 502, 'Odpowiedź JSON dostawcy przekracza 5 MB');
          chunks.push(part.value);
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw new Problem(502, 'Nieprawidłowa odpowiedź JSON dostawcy');
      } finally {
        await reader.cancel();
      }
    }
    throw new Problem(502, 'API dostawcy niedostępne po ponowieniach');
  }
}
export class Dpd extends ApiClient {
  private headers: Record<string, string>;
  constructor(
    mode: string,
    settings: Record<string, string>,
    credentials: Record<string, string>,
    transport?: Transport,
  ) {
    ensure(['sandbox', 'live'].includes(mode), 422, 'Nieprawidłowe środowisko DPD');
    super(
      mode === 'sandbox' ? 'https://dpdservicesdemo.dpd.com.pl' : 'https://dpdservices.dpd.com.pl',
      credentials,
      transport,
    );
    ensure(
      /^[1-9]\d{0,9}$/.test(settings.master_fid) && Number(settings.master_fid) <= 2147483647,
      422,
      'Nieprawidłowy Master FID DPD',
    );
    ensure(
      credentials.username &&
        !/[:\r\n]/.test(credentials.username) &&
        credentials.password &&
        !/[\r\n]/.test(credentials.password),
      422,
      'Wymagany login i hasło DPD',
    );
    this.headers = {
      Authorization:
        'Basic ' +
        Buffer.from(credentials.username + ':' + credentials.password).toString('base64'),
      'x-dpd-fid': settings.master_fid,
    };
  }
  postalCode(zipCode: string) {
    ensure(/^\d{5}$/.test(zipCode), 422, 'Wymagany polski kod pocztowy');
    return this.request('/public/routing/v1/postalCode', {
      headers: this.headers,
      query: { countryCode: 'PL', zipCode },
    });
  }
  async test() {
    const r = await this.postalCode('01354');
    ensure(r?.status === 'OK', 502, 'DPD nie potwierdziło odczytu kodu pocztowego');
    return r;
  }
  create(payload: unknown) {
    return this.request('/public/shipment/v1/generatePackagesNumbers', {
      method: 'POST',
      headers: this.headers,
      body: payload,
    });
  }
  labels(reference: string) {
    ensure(/^DYNA-[0-9a-f-]{36}$/.test(reference), 422, 'Nieprawidłowa referencja DPD');
    return this.request('/public/shipment/v1/generateSpedLabels', {
      method: 'POST',
      headers: this.headers,
      body: {
        labelSearchParams: {
          policy: 'STOP_ON_FIRST_ERROR',
          session: { type: 'DOMESTIC', packages: [{ parcels: [{ reference }] }] },
        },
        outputDocFormat: 'PDF',
        format: 'A4',
        outputType: 'BIC3',
        variant: 'STANDARD',
      },
    });
  }
  availability(zipCode: string) {
    ensure(/^\d{5}$/.test(zipCode), 422, 'Wymagany polski kod pocztowy');
    return this.request('/public/courierorder/v1/courierOrderAvailability', {
      headers: this.headers,
      query: { countryCode: 'PL', zipCode },
    });
  }
  protocol(payload: unknown) {
    return this.request('/public/shipment/v1/generateProtocol', {
      method: 'POST',
      headers: this.headers,
      body: payload,
    });
  }
  pickup(payload: unknown) {
    return this.request('/public/courierorder/v1/packagesPickupCall', {
      method: 'POST',
      headers: this.headers,
      body: payload,
    });
  }
  cancelPickup(orderNumber: string, checkSum: string) {
    ensure(
      /^[A-Za-z0-9]{1,40}$/.test(orderNumber) && /^[A-Za-z0-9-]{8,36}$/.test(checkSum),
      422,
      'Nieprawidłowe dane zlecenia DPD',
    );
    return this.request('/public/courierorder/v1/packagesPickupCall', {
      method: 'DELETE',
      headers: this.headers,
      query: { orderNumber, checkSum },
    });
  }
}
export class PrestaShop extends ApiClient {
  private shopId: string;
  get offerShopId() {
    return this.shopId;
  }
  offerRows(resource: string, query: Record<string, string | number>, max: number) {
    return this.read(resource, query, max);
  }
  async patchOffer(
    resource: 'products' | 'combinations' | 'stock_availables',
    id: string,
    values: Record<string, string | number>,
  ) {
    psId(id);
    const singular =
      resource === 'products'
        ? 'product'
        : resource === 'combinations'
          ? 'combination'
          : 'stock_available';
    const escape = (v: string) =>
      v.replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!,
      );
    const body =
      '<?xml version="1.0" encoding="UTF-8"?><prestashop><' +
      singular +
      '><id>' +
      id +
      '</id>' +
      Object.entries(values)
        .map(([k, v]) => '<' + k + '>' + escape(String(v)) + '</' + k + '>')
        .join('') +
      '</' +
      singular +
      '></prestashop>';
    const u = new URL(this.base + '/' + resource + '/' + id);
    u.searchParams.set('id_shop', this.shopId);
    const response = await this.transport(u.toString(), {
      method: 'PATCH',
      headers: {
        Authorization: 'Basic ' + Buffer.from(this.credentials.api_key + ':').toString('base64'),
        'Content-Type': 'application/xml',
        Accept: 'application/xml',
      },
      body,
    });
    ensure(
      response.ok,
      response.status === 401 ? 401 : 502,
      'API PrestaShop: HTTP ' + response.status,
    );
    // XML is never parsed or evaluated; a subsequent JSON GET proves the result.
    const reader = response.body?.getReader();
    let bytes = 0;
    if (reader)
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          ensure(bytes <= 5 * 1024 * 1024, 502, 'Odpowiedź PrestaShop przekracza limit');
        }
      } finally {
        await reader.cancel();
      }
  }
  async statusState(id: string) {
    const rows = await this.read(
      'order_states',
      {
        'filter[id]': '[' + psId(id) + ']',
        display: '[id,paid,shipped,delivery,deleted]',
        limit: 1,
      },
      1,
    );
    ensure(rows.length === 1 && psId(rows[0].id) === id, 502, 'Brak docelowego statusu PrestaShop');
    return rows[0];
  }
  async updateOrderStatus(id: string, state: string) {
    psId(id);
    psId(state);
    const u = new URL(this.base + '/order_histories');
    u.searchParams.set('id_shop', this.shopId);
    u.searchParams.set('sendemail', '0');
    const response = await this.transport(u.toString(), {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(this.credentials.api_key + ':').toString('base64'),
        'Content-Type': 'application/xml',
        Accept: 'application/xml',
      },
      body:
        '<?xml version="1.0" encoding="UTF-8"?><prestashop><order_history><id_order>' +
        id +
        '</id_order><id_order_state>' +
        state +
        '</id_order_state></order_history></prestashop>',
    });
    ensure(
      response.ok,
      response.status === 401 ? 401 : 502,
      'API PrestaShop: HTTP ' + response.status,
    );
    const reader = response.body?.getReader();
    let bytes = 0;
    if (reader)
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          ensure(bytes <= 5 * 1024 * 1024, 502, 'Odpowiedź PrestaShop przekracza limit');
        }
      } finally {
        await reader.cancel();
      }
  }
  constructor(
    settings: Record<string, string>,
    creds: Record<string, string>,
    transport?: Transport,
  ) {
    super(settings.store_url.replace(/\/$/, '') + '/api', creds, transport);
    this.shopId = psId(settings.shop_id);
    psStateIds(settings.order_state_ids);
    ensure(
      /^[A-Za-z0-9]{32}$/.test(creds.api_key ?? ''),
      422,
      'Klucz Webservice PrestaShop musi mieć 32 znaki',
    );
  }
  private async read(resource: string, query: Record<string, string | number>, max: number) {
    const response = await this.request('/' + resource, {
      headers: {
        Authorization: `Basic ${Buffer.from(this.credentials.api_key + ':').toString('base64')}`,
      },
      query: { output_format: 'JSON', id_shop: this.shopId, ...query },
    });
    // Core Webservice emits [] for an empty list, and {resource:[...]} otherwise.
    const rows = Array.isArray(response) && response.length === 0 ? [] : response?.[resource];
    ensure(
      Array.isArray(rows) &&
        rows.length <= max &&
        rows.every((v) => v && typeof v === 'object' && !Array.isArray(v)),
      502,
      'Nieprawidłowa lub zbyt duża odpowiedź PrestaShop',
    );
    const ids = rows.map((v) => psId(v.id));
    ensure(new Set(ids).size === ids.length, 502, 'Powtórzone identyfikatory PrestaShop');
    const display = String(query.display ?? 'full');
    return display === 'full'
      ? (rows as any[])
      : rows.map((v) =>
          Object.fromEntries(
            display
              .slice(1, -1)
              .split(',')
              .map((key) => [key, v[key]]),
          ),
        );
  }
  private async related(resource: string, ids: string[], fields: string) {
    const unique = [...new Set(ids)];
    if (!unique.length) return [];
    const rows = await this.read(
      resource,
      { display: `[${fields}]`, 'filter[id]': `[${unique.join('|')}]`, limit: unique.length },
      unique.length,
    );
    ensure(
      rows.every((v) => unique.includes(psId(v.id))),
      502,
      'Brak powiązanych zasobów PrestaShop',
    );
    return rows;
  }
  async test() {
    await this.read(
      'orders',
      { display: '[id,id_shop]', 'filter[id_shop]': `[${this.shopId}]`, limit: 1 },
      1,
    );
    return { ok: true, scope: 'orders_read' };
  }
  async products(page = 1) {
    ensure(Number.isSafeInteger(page) && page >= 1 && page <= 1000, 422, 'Nieprawidłowa strona');
    const data = await this.read(
      'products',
      {
        display: '[id,reference,name,price,active,id_default_combination]',
        sort: '[id_ASC]',
        limit: `${(page - 1) * 50},50`,
      },
      50,
    );
    return { data, page, has_more: data.length === 50, prices: 'tax_exclusive' };
  }
  async order(id: string) {
    const result = await this.orders(1, undefined, psId(id));
    ensure(
      result.data.length === 1 && psId(result.data[0].id) === id,
      502,
      'Brak zamówienia PrestaShop',
    );
    return result.data[0];
  }
  async orders(page = 1, afterId?: string, exactId?: string) {
    ensure(Number.isSafeInteger(page) && page >= 1 && page <= 200, 422, 'Nieprawidłowa strona');
    if (afterId !== undefined) psId(afterId, true);
    if (afterId === '9999999999') return { data: [], page, has_more: false };
    const orders = await this.read(
      'orders',
      {
        display: 'full',
        'filter[id_shop]': `[${this.shopId}]`,
        ...(afterId === undefined ? {} : { 'filter[id]': `[${BigInt(afterId) + 1n},9999999999]` }),
        ...(exactId === undefined ? {} : { 'filter[id]': `[${psId(exactId)}]` }),
        sort: '[id_ASC]',
        limit: `${afterId === undefined ? (page - 1) * 5 : 0},5`,
      },
      5,
    );
    ensure(
      orders.every((v) => psId(v.id_shop) === this.shopId),
      502,
      'API zwróciło zamówienie innego sklepu',
    );
    ensure(
      orders.every(
        (v, index) =>
          BigInt(psId(v.id)) > BigInt(index ? psId(orders[index - 1].id) : (afterId ?? '0')),
      ),
      502,
      'Nieprawidłowa kolejność zamówień PrestaShop',
    );
    if (!orders.length) return { data: [], page, has_more: false };
    const orderIds = orders.map((v) => psId(v.id));
    const [customers, addresses, currencies, states, details, cartRules] = await Promise.all([
      this.related(
        'customers',
        orders.map((v) => psId(v.id_customer)),
        'id,email',
      ),
      this.related(
        'addresses',
        orders.map((v) => psId(v.id_address_delivery)),
        'id,id_customer,id_country,firstname,lastname,address1,address2,city,postcode,phone,phone_mobile',
      ),
      this.related(
        'currencies',
        orders.map((v) => psId(v.id_currency)),
        'id,iso_code',
      ),
      this.related(
        'order_states',
        orders.map((v) => psId(v.current_state)),
        'id,paid,shipped,delivery,deleted',
      ),
      this.read(
        'order_details',
        {
          display:
            '[id,id_order,id_shop,product_id,product_attribute_id,product_name,product_reference,product_quantity,product_quantity_return,product_quantity_refunded,total_price_tax_incl,total_refunded_tax_incl,id_customization]',
          'filter[id_order]': `[${orderIds.join('|')}]`,
          limit: 501,
        },
        500,
      ),
      this.read(
        'order_cart_rules',
        {
          display: '[id,id_order,value,free_shipping,deleted]',
          'filter[id_order]': `[${orderIds.join('|')}]`,
          limit: 251,
        },
        250,
      ),
    ]);
    ensure(
      [...details, ...cartRules].every((v) => orderIds.includes(psId(v.id_order))),
      502,
      'API zwróciło pozycje innego zamówienia',
    );
    const countries = await this.related(
      'countries',
      addresses.map((v) => psId(v.id_country)),
      'id,iso_code',
    );
    const find = (rows: any[], id: unknown) =>
      id === undefined ? undefined : rows.find((v) => psId(v.id) === psId(id));
    const fields = [
      'id',
      'id_shop',
      'id_customer',
      'id_address_delivery',
      'id_currency',
      'current_state',
      'module',
      'shipping_number',
      'total_paid_tax_incl',
      'total_paid_real',
      'total_products_wt',
      'total_shipping_tax_incl',
      'total_discounts_tax_incl',
      'total_wrapping_tax_incl',
      'note',
      'reference',
      'date_upd',
      'round_mode',
      'round_type',
      'associations',
    ];
    const data = orders.map((order) => {
      const address = find(addresses, order.id_address_delivery);
      return {
        ...Object.fromEntries(fields.map((key) => [key, order[key]])),
        id: psId(order.id),
        associations: {
          order_rows: (Array.isArray(order.associations?.order_rows)
            ? order.associations.order_rows
            : []
          ).map((v: any) =>
            Object.fromEntries(
              ['id', 'product_id', 'product_attribute_id', 'product_quantity'].map((key) => [
                key,
                v[key],
              ]),
            ),
          ),
        },
        _dyna: {
          customer: find(customers, order.id_customer),
          address,
          currency: find(currencies, order.id_currency),
          country: find(countries, address?.id_country),
          state: find(states, order.current_state),
          details: details.filter((v) => psId(v.id_order) === psId(order.id)),
          cart_rules: cartRules.filter((v) => psId(v.id_order) === psId(order.id)),
        },
      };
    });
    return { data, page, has_more: orders.length === 5, next_id: psId(orders.at(-1).id) };
  }
}
export class WooCommerce extends ApiClient {
  constructor(
    settings: Record<string, string>,
    creds: Record<string, string>,
    transport?: Transport,
  ) {
    super(settings.store_url.replace(/\/$/, '') + '/wp-json/wc/v3', creds, transport);
  }
  private headers() {
    return {
      Authorization: `Basic ${Buffer.from(`${this.credentials.consumer_key}:${this.credentials.consumer_secret}`).toString('base64')}`,
    };
  }
  async test() {
    await this.request('/products', { headers: this.headers(), query: { per_page: 1 } });
    return { ok: true };
  }
  async orders(page = 1) {
    const data = await this.request('/orders', {
      headers: this.headers(),
      query: { per_page: 50, page, orderby: 'date', order: 'desc' },
    });
    ensure(Array.isArray(data), 502, 'Nieprawidłowa odpowiedź WooCommerce');
    return { data, page, has_more: data.length === 50 };
  }
  updateOrderStatus(id: number, status: string) {
    return this.request(`/orders/${id}`, {
      method: 'PUT',
      body: { status },
      headers: this.headers(),
    });
  }
  order(id: number) {
    return this.request(`/orders/${id}`, { headers: this.headers() });
  }
  async products(page = 1) {
    const data = await this.request('/products', {
      headers: this.headers(),
      query: { per_page: 50, page },
    });
    ensure(Array.isArray(data), 502, 'Nieprawidłowa odpowiedź WooCommerce');
    return { data, page, has_more: data.length === 50 };
  }
  async catalogPage(page = 1, parent?: string) {
    const data = await this.request(parent ? `/products/${parent}/variations` : '/products', {
      headers: this.headers(),
      query: { per_page: 50, page, orderby: 'id', order: 'asc' },
    });
    ensure(
      Array.isArray(data) && data.length <= 50,
      502,
      'Nieprawidłowa strona katalogu WooCommerce',
    );
    return { data, has_more: data.length === 50 };
  }
  async updateProduct(id: number, patch: { stock_quantity?: number; regular_price?: string }) {
    return this.request(`/products/${id}`, { method: 'PUT', headers: this.headers(), body: patch });
  }
  async product(id: string, parent?: string) {
    const resource = await this.request(
      parent ? `/products/${parent}/variations/${id}` : `/products/${id}`,
      {
        headers: this.headers(),
      },
    );
    if (!parent) return resource;
    // v3 variation responses omit parent_id. Validate membership using the parent product.
    const group = await this.request(`/products/${parent}`, { headers: this.headers() });
    ensure(
      String(group?.id) === parent &&
        group.type === 'variable' &&
        Array.isArray(group.variations) &&
        group.variations.some((v: unknown) => String(v) === id),
      422,
      'Wariant nie należy do wskazanego produktu WooCommerce',
    );
    ensure(String(resource?.id) === id, 502, 'Dostawca zwrócił inny wariant');
    return { ...resource, parent_id: parent, type: 'variation', _parent: group };
  }
  bySku(sku: string) {
    return this.request('/products', { headers: this.headers(), query: { sku, per_page: 10 } });
  }
  variationBySku(parent: string, sku: string) {
    return this.request(`/products/${parent}/variations`, {
      headers: this.headers(),
      query: { sku, per_page: 10 },
    });
  }
  createVariation(parent: string, body: Record<string, unknown>) {
    return this.request(`/products/${parent}/variations`, {
      method: 'POST',
      headers: this.headers(),
      body,
    });
  }
  setting(group: string, id: string) {
    return this.request(`/settings/${group}/${id}`, { headers: this.headers() });
  }
  createProduct(body: Record<string, unknown>) {
    return this.request('/products', { method: 'POST', headers: this.headers(), body });
  }
  writeProduct(id: string, body: Record<string, unknown>, parent?: string) {
    return this.request(parent ? `/products/${parent}/variations/${id}` : `/products/${id}`, {
      method: 'PUT',
      headers: this.headers(),
      body,
    });
  }
}
export class Allegro extends ApiClient {
  constructor(mode: string, creds: Record<string, string>, transport?: Transport) {
    super(
      mode === 'sandbox' ? 'https://api.allegro.pl.allegrosandbox.pl' : 'https://api.allegro.pl',
      creds,
      transport,
    );
  }
  private headers() {
    return {
      Authorization: `Bearer ${this.credentials.access_token}`,
      Accept: 'application/vnd.allegro.public.v1+json',
    };
  }
  test() {
    return this.request('/me', { headers: this.headers() });
  }
  async orders(offset = 0) {
    const result = await this.request('/order/checkout-forms', {
      headers: this.headers(),
      query: { limit: 50, offset },
    });
    ensure(Array.isArray(result.checkoutForms), 502, 'Nieprawidłowa odpowiedź Allegro');
    return {
      data: result.checkoutForms,
      offset,
      has_more: offset + result.checkoutForms.length < result.totalCount,
    };
  }
  events(from?: string) {
    return this.request('/order/events', {
      headers: this.headers(),
      query: { limit: 5, ...(from ? { from } : {}) },
    });
  }
  eventStats() {
    return this.request('/order/event-stats', { headers: this.headers() });
  }
  async updateOrderStatus(id: string, status: string, revision: string) {
    const u = new URL(this.base + `/order/checkout-forms/${encodeURIComponent(id)}/fulfillment`);
    u.searchParams.set('checkoutForm.revision', revision);
    const res = await this.transport(u.toString(), {
      method: 'PUT',
      headers: { ...this.headers(), 'Content-Type': 'application/vnd.allegro.public.v1+json' },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) throw new Problem(
      [401, 403, 404, 409, 422].includes(res.status) ? res.status : 502,
      `API Allegro: HTTP ${res.status}`,
      res.status === 401 ? 'PROVIDER_HTTP_UNAUTHORIZED' : undefined,
    );
    ensure(
      res.status === 204,
      502,
      'Nieoczekiwana odpowiedź zapisu statusu Allegro; sprawdź wynik odczytem',
    );
  }
  order(id: string) {
    return this.request(`/order/checkout-forms/${encodeURIComponent(id)}`, {
      headers: this.headers(),
    });
  }
  async offers(offset = 0) {
    const result = await this.request('/sale/offers', {
      headers: this.headers(),
      query: { limit: 50, offset },
    });
    ensure(Array.isArray(result.offers), 502, 'Nieprawidłowa odpowiedź Allegro');
    return {
      data: result.offers,
      offset,
      has_more: offset + result.offers.length < result.totalCount,
    };
  }
  offer(id: string) {
    return this.request(`/sale/product-offers/${encodeURIComponent(id)}`, {
      headers: this.headers(),
    });
  }
  catalogProduct(id: string) {
    z.uuid().parse(id);
    return this.request('/sale/products/' + id, {
      headers: this.headers(),
      query: { language: 'pl-PL' },
    });
  }
  async catalogSearch(phrase: string, after?: string) {
    const result = await this.request('/sale/products', {
      headers: this.headers(),
      query: { phrase, language: 'pl-PL', ...(after ? { 'page.id': after } : {}) },
    });
    ensure(
      Array.isArray(result.products) && result.products.length <= 1000,
      502,
      'Nieprawidłowa lista produktów Allegro',
    );
    return {
      data: result.products.map((p: any) => ({
        id: z.uuid().parse(p.id),
        name: String(p.name ?? ''),
        category: p.category,
      })),
      meta: { cursor: result.nextPage?.id ?? null },
    };
  }
  async categoryOfferParameters(id: string) {
    ensure(/^[1-9]\d{0,14}$/.test(id), 422, 'Nieprawidłowa kategoria Allegro');
    const result = await this.request('/sale/categories/' + id + '/parameters', {
      headers: this.headers(),
    });
    ensure(
      Array.isArray(result.parameters) && result.parameters.length <= 1000,
      502,
      'Nieprawidłowe parametry kategorii Allegro',
    );
    return result.parameters.filter((p: any) => !p.options?.describesProduct);
  }
  creationResource(path: string, id: string) {
    ensure(
      [
        '/sale/shipping-rates/',
        '/after-sales-service-conditions/return-policies/',
        '/after-sales-service-conditions/implied-warranties/',
        '/sale/responsible-producers/',
      ].includes(path),
      422,
      'Nieprawidłowy zasób Allegro',
    );
    z.uuid().parse(id);
    return this.request(path + id, { headers: this.headers() });
  }
  async creationOptions(resource: string, offset = 0) {
    const definitions: Record<string, [string, string, number]> = {
      shipping: ['/sale/shipping-rates', 'shippingRates', 1000],
      returns: ['/after-sales-service-conditions/return-policies', 'returnPolicies', 60],
      warranties: ['/after-sales-service-conditions/implied-warranties', 'impliedWarranties', 60],
      producers: ['/sale/responsible-producers', 'responsibleProducers', 100],
    };
    const d = definitions[resource];
    ensure(d, 422, 'Nieznany rodzaj ustawień Allegro');
    const [path, key, max] = d;
    ensure(
      Number.isSafeInteger(offset) &&
        offset >= 0 &&
        (resource === 'producers' ? offset <= 50000 : offset === 0),
      422,
      'Nieprawidłowa strona ustawień Allegro',
    );
    const result = await this.request(path, {
      headers: this.headers(),
      query: resource === 'shipping' ? { marketplace: 'allegro-pl' } : { limit: max, offset },
    });
    const rows = result[key];
    ensure(
      Array.isArray(rows) && rows.length <= max,
      502,
      'Nieprawidłowe ustawienia sprzedawcy Allegro',
    );
    const data = rows.map((r: any) => ({ id: z.uuid().parse(r.id), name: String(r.name ?? r.id) }));
    ensure(
      new Set(data.map((r: any) => r.id)).size === data.length,
      502,
      'Powtórzone ustawienia sprzedawcy Allegro',
    );
    return {
      data,
      meta: {
        cursor:
          resource === 'producers' && rows.length === max && offset + max <= 50000
            ? offset + max
            : null,
      },
    };
  }
  async offersByExternalId(marker: string) {
    ensure(/^dyna-[a-f0-9-]{36}$/.test(marker), 422, 'Nieprawidłowy znacznik oferty');
    const result = await this.request('/sale/offers', {
      headers: this.headers(),
      query: { 'external.id': marker, limit: 2, offset: 0 },
    });
    ensure(
      Array.isArray(result.offers) &&
        result.offers.length <= 2 &&
        Number.isSafeInteger(result.totalCount) &&
        result.totalCount === result.offers.length &&
        result.totalCount <= 1,
      409,
      'Niejednoznaczny wynik tworzenia Allegro',
    );
    ensure(
      result.offers.every((r: any) => /^[1-9]\d{0,18}$/.test(String(r.id))),
      502,
      'Nieprawidłowy identyfikator oferty Allegro',
    );
    return result.offers;
  }
  async createDraft(body: Record<string, any>) {
    const res = await this.transport(this.base + '/sale/product-offers', {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/vnd.allegro.public.v1+json' },
      body: JSON.stringify(body),
    });
    if (![201, 202].includes(res.status)) throw new Problem(
      res.status === 401 ? 401 : 502,
      'Tworzenie oferty Allegro: HTTP ' + res.status,
      res.status === 401 ? 'PROVIDER_HTTP_UNAUTHORIZED' : undefined,
    );
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader)
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          ensure(
            size <= 5 * 1024 * 1024,
            502,
            'Odpowiedź tworzenia Allegro przekracza 5 MB; uzgodnij wynik',
          );
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel();
      }
    let data: any = null;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      /* 202 can identify the operation solely through Location. */
    }
    let id = String(data?.id ?? ''),
      operationId: string | undefined;
    if (res.status === 202) {
      let target: URL;
      try {
        target = new URL(res.headers.get('location') ?? '', this.base);
      } catch {
        throw new Problem(422, 'Brak adresu operacji tworzenia Allegro; uzgodnij wynik');
      }
      const match =
        /^\/sale\/product-offers\/([1-9]\d{0,18})\/(?:sale\/)?operations\/([0-9a-f-]{36})$/i.exec(
          target.pathname,
        );
      ensure(
        target.origin === new URL(this.base).origin &&
          !target.username &&
          !target.password &&
          !target.search &&
          !target.hash &&
          match,
        422,
        'Nieprawidłowy adres operacji tworzenia Allegro; uzgodnij wynik',
      );
      ensure(!id || id === match[1], 502, 'Niezgodny identyfikator tworzenia Allegro');
      id = match[1];
      operationId = z.uuid().parse(match[2]);
    }
    ensure(
      /^[1-9]\d{0,18}$/.test(id),
      502,
      'Brak identyfikatora utworzonej oferty Allegro; uzgodnij wynik',
    );
    return { id, operationId };
  }
  async patchOffer(id: string, body: Record<string, unknown>) {
    const res = await this.transport(this.base + `/sale/product-offers/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { ...this.headers(), 'Content-Type': 'application/vnd.allegro.public.v1+json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Problem(res.status === 401 ? 401 : 502,
      `API dostawcy: HTTP ${res.status}`,
      res.status === 401 ? 'PROVIDER_HTTP_UNAUTHORIZED' : undefined);
    const data = await res.json().catch(() => {
      throw new Problem(502, 'Nieprawidłowa odpowiedź Allegro');
    });
    let operationId: string | undefined;
    if (res.status === 202) {
      const location = res.headers.get('location');
      ensure(location, 422, 'Allegro przyjęło zmianę bez identyfikatora operacji; uzgodnij wynik');
      let target: URL;
      try {
        target = new URL(location, this.base);
      } catch {
        throw new Problem(422, 'Nieprawidłowy adres operacji Allegro; uzgodnij wynik');
      }
      const prefix = `/sale/product-offers/${encodeURIComponent(id)}/`;
      ensure(
        target.origin === new URL(this.base).origin &&
          !target.username &&
          !target.password &&
          !target.search &&
          !target.hash &&
          target.pathname.startsWith(prefix),
        422,
        'Nieprawidłowy adres operacji Allegro; uzgodnij wynik',
      );
      const match =
        /^(?:sale\/)?operations\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(
          target.pathname.slice(prefix.length),
        );
      ensure(match, 422, 'Nieprawidłowy identyfikator operacji Allegro; uzgodnij wynik');
      operationId = match[1];
    }
    return { accepted: res.status === 202, data, operationId };
  }
  async offerOperation(id: string, operation: string) {
    const res = await this.transport(
      this.base +
        `/sale/product-offers/${encodeURIComponent(id)}/operations/${encodeURIComponent(operation)}`,
      { method: 'GET', headers: this.headers(), redirect: 'manual' },
    );
    if (res.status === 303) return { done: true };
    if (!res.ok) throw new Problem(res.status === 401 ? 401 : 502,
      `API dostawcy: HTTP ${res.status}`,
      res.status === 401 ? 'PROVIDER_HTTP_UNAUTHORIZED' : undefined);
    const data = await res.json().catch(() => null);
    return {
      done: res.status === 200 && data?.operation?.status === 'SUCCESS',
      pending: res.status === 202,
      data,
    };
  }
  async refresh(mode: string) {
    const base = mode === 'sandbox' ? 'https://allegro.pl.allegrosandbox.pl' : 'https://allegro.pl';
    const res = await this.transport(base + '/auth/oauth/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.credentials.client_id}:${this.credentials.client_secret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.credentials.refresh_token,
      }).toString(),
    });
    ensure(res.ok, 502, `Odświeżenie OAuth: HTTP ${res.status}`);
    const data = await res.json();
    ensure(
      typeof data.access_token === 'string' && typeof data.refresh_token === 'string',
      502,
      'Nieprawidłowa odpowiedź OAuth',
    );
    return data;
  }
}
export class InPost extends ApiClient {
  constructor(mode: string, creds: Record<string, string>, transport?: Transport) {
    super(
      mode === 'sandbox'
        ? 'https://sandbox-api-shipx-pl.easypack24.net/v1'
        : 'https://api-shipx-pl.easypack24.net/v1',
      creds,
      transport,
    );
  }
  private headers() {
    return { Authorization: `Bearer ${this.credentials.access_token}` };
  }
  test() {
    return this.request('/organizations', { headers: this.headers(), query: { per_page: 1 } });
  }
  points(city: string, page = 1) {
    return this.request('/points', { query: { city, per_page: 20, page } });
  }
  shipments(org: string, query: Record<string, string | number>) {
    return this.request(`/organizations/${encodeURIComponent(org)}/shipments`, {
      headers: this.headers(),
      query,
    });
  }
  createShipment(org: string, body: unknown) {
    return this.request(`/organizations/${encodeURIComponent(org)}/shipments`, {
      method: 'POST',
      headers: this.headers(),
      body,
    });
  }
  buyShipment(id: string, offer: number) {
    return this.request(`/shipments/${encodeURIComponent(id)}/buy`, {
      method: 'POST',
      headers: this.headers(),
      body: { offer_id: offer },
    });
  }
  refreshShipment(id: string, body: unknown) {
    return this.request(`/shipments/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: this.headers(),
      body,
    });
  }
  cancelShipment(id: string) {
    return this.request(`/shipments/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: this.headers(),
    });
  }
  tracking(number: string) {
    return this.request(`/tracking/${encodeURIComponent(number)}`);
  }
  async label(id: string, maxBytes = 10 * 1024 * 1024) {
    ensure(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 10 * 1024 * 1024,
      422, 'Nieprawidłowy limit etykiety InPost');
    const res = await this.transport(
      this.base + `/shipments/${encodeURIComponent(id)}/label?format=pdf&type=A6`,
      { method: 'GET', headers: { ...this.headers(), Accept: 'application/pdf' } },
    );
    ensure(
      res.ok && res.headers.get('content-type')?.split(';')[0] === 'application/pdf',
      502,
      'Nieprawidłowa etykieta PDF InPost',
    );
    const reader = res.body?.getReader();
    ensure(reader, 502, 'Brak etykiety');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        ensure(size <= maxBytes, 502, 'Etykieta jest zbyt duża');
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel();
    }
    const pdf = Buffer.concat(chunks);
    ensure(pdf.subarray(0, 5).toString() === '%PDF-', 502, 'Nieprawidłowy format etykiety');
    return pdf;
  }
  shipment(id: string) {
    return this.request(`/shipments/${encodeURIComponent(id)}`, { headers: this.headers() });
  }
}
export class Fakturownia extends ApiClient {
  constructor(
    settings: Record<string, string>,
    creds: Record<string, string>,
    transport?: Transport,
  ) {
    super(settings.account_url.replace(/\/$/, ''), creds, transport);
  }
  test() {
    return this.request('/invoices.json', {
      query: { api_token: this.credentials.api_token, per_page: 1, page: 1, period: 'this_month' },
    });
  }
  invoices(page = 1) {
    return this.request('/invoices.json', {
      query: { api_token: this.credentials.api_token, page, per_page: 50, period: 'all' },
    });
  }
  createInvoice(invoice: Record<string, unknown>) {
    return this.request('/invoices.json', {
      method: 'POST',
      body: { api_token: this.credentials.api_token, invoice },
    });
  }
  invoice(id: string) {
    return this.request(`/invoices/${encodeURIComponent(id)}.json`, {
      query: { api_token: this.credentials.api_token, correction_positions: 'full' },
    });
  }
  invoiceByOrder(oid: string, page = 1) {
    return this.request('/invoices.json', {
      query: {
        api_token: this.credentials.api_token,
        oid,
        page,
        per_page: 100,
        period: 'all',
        include_positions: 'true',
      },
    });
  }
  async invoicePdf(id: string) {
    const u = new URL(this.base + `/invoices/${encodeURIComponent(id)}.pdf`);
    u.searchParams.set('api_token', this.credentials.api_token);
    const res = await this.transport(u.toString(), {
      method: 'GET',
      headers: { Accept: 'application/pdf' },
    });
    ensure(
      res.ok && res.headers.get('content-type')?.split(';')[0] === 'application/pdf',
      502,
      'Nieprawidłowy PDF Fakturowni',
    );
    const reader = res.body?.getReader();
    ensure(reader, 502, 'Brak PDF');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        ensure(size <= 10 * 1024 * 1024, 502, 'PDF jest zbyt duży');
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel();
    }
    const pdf = Buffer.concat(chunks);
    ensure(pdf.subarray(0, 5).toString() === '%PDF-', 502, 'Nieprawidłowy format PDF');
    return pdf;
  }
}
export class SmsRejected extends Problem {}
export class SmsApi extends ApiClient {
  constructor(credentials: Record<string, string>, transport: Transport = safeFetch) {
    super('https://api.smsapi.pl', credentials, transport);
  }
  async test() {
    const r = await this.request('/profile', {
      headers: { Authorization: 'Bearer ' + this.credentials.access_token },
    });
    ensure(
      typeof r.points === 'number' && Number.isFinite(r.points),
      502,
      'Nieprawidłowy profil SMSAPI',
    );
    return { points: r.points, payment_type: r.payment_type };
  }
  // This connector deliberately exposes only the provider's non-delivering test operation.
  // POST has no retries: neither HTTP 5xx nor duplicate idx is proof of non-acceptance.
  async testMessage(p: {
    recipient: string;
    payload: string;
    sender: string;
    id: string;
    max_parts: number;
  }) {
    const body = new URLSearchParams({
      to: p.recipient,
      message: p.payload,
      from: p.sender,
      idx: p.id.replaceAll('-', ''),
      check_idx: '1',
      format: 'json',
      encoding: 'utf-8',
      test: '1',
      max_parts: String(p.max_parts),
    });
    const res = await this.transport(this.base + '/sms.do', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Bearer ' + this.credentials.access_token,
      },
      body: body.toString(),
    });
    ensure(res.ok, 502, 'Niepewny wynik testu SMSAPI: HTTP ' + res.status);
    const reader = res.body?.getReader();
    ensure(reader, 502, 'Brak odpowiedzi SMSAPI');
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        ensure(size <= 65536, 502, 'Odpowiedź SMSAPI przekracza limit');
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel();
    }
    let r: any;
    try {
      r = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new Problem(502, 'Nieprawidłowa odpowiedź SMSAPI');
    }
    if (Number.isInteger(r.error)) {
      if (r.error === 53)
        throw new Problem(502, 'SMSAPI zgłasza istniejący idx; wynik wymaga sprawdzenia');
      throw new SmsRejected(422, 'SMSAPI odrzuciło test: kod ' + r.error);
    }
    const parsed = z
      .object({
        count: z.literal(1),
        list: z
          .array(
            z.object({
              id: z.string().min(1).max(64),
              number: z.string(),
              status: z.string().max(40),
              points: z.number().finite().nonnegative(),
            }),
          )
          .length(1),
      })
      .safeParse(r);
    ensure(
      parsed.success && parsed.data.list[0].number === p.recipient,
      502,
      'Nieprawidłowe potwierdzenie SMSAPI',
    );
    return { ...parsed.data!.list[0], provider_test: true, delivered: false };
  }
}

export function connector(
  provider: string,
  mode: string,
  settings: Record<string, string>,
  credentials: Record<string, string>,
  transport?: Transport,
) {
  switch (provider) {
    case 'mirakl':
      throw new Problem(422, 'Mirakl: wymagany channelReader z trwałym repozytorium i autoryzacją', 'MIRAKL_CHANNEL_READER_REQUIRED');
    case 'deepl':
      return new DeepL({ api_plan: settings.api_plan }, credentials, transport);
    case 'smtp':
      return new SmtpClient(settings, credentials);
    case 'amazon': {
      const config = amazonSettings.parse(settings);
      return new Amazon(
        mode,
        config,
        credentials,
        amazonApiTransport(mode, config.region, credentials.client_id, transport ?? safeFetch),
        transport ?? safeFetch,
      );
    }
    case 'ebay':
      return new Ebay(mode, credentials, transport ?? safeFetch);
    case 'dpd':
      return new Dpd(mode, settings, credentials, transport);
    case 'dhl':
      return new Dhl(mode, settings, credentials, transport ?? safeFetch);
    case 'pocztapolska':
      return new PocztaPolska(mode, settings, credentials, transport ?? safeFetch);
    case 'bigbuy':
      return new BigBuy(mode, credentials, transport ?? safeFetch);
    case 'odoo':
      return new OdooSales(settings, credentials, transport ?? safeFetch);
    case 'shopify':
      return new Shopify(settings, credentials, transport ?? safeFetch);
    case 'prestashop':
      return new PrestaShop(settings, credentials, transport);
    case 'allegro':
      return new Allegro(mode, credentials, transport);
    case 'woocommerce':
      return new WooCommerce(settings, credentials, transport);
    case 'inpost':
      return new InPost(mode, credentials, transport);
    case 'smsapi':
      return new SmsApi(credentials, transport);
    case 'fakturownia':
      return new Fakturownia(settings, credentials, transport);
    default:
      throw new Problem(422, 'Nieobsługiwana integracja');
  }
}
