# Oficjalny lokalny WooCommerce — pięć własnych sklepów

Ten katalog definiuje i uruchamia pięć **własnych** sklepów a–e dla tła profilu
`docs/parity/acceptance-profile.v1.json` (`background.dependencies`:
`official_local_woo_required_for_import_and_sync`, `local_official_woo_instances_min` 2).
Sklepy Playground na 8443/8444 pozostają niezależne. Porty sklepów to wyłącznie
`127.0.0.1:18443–18447`; MariaDB i HTTP WordPressa nie mają opublikowanych portów.

Stan 30.10.2026: obrazy pobrane i przypięte, plugin sprawdzony, **pięć sklepów działa**
(root `local-builds/official-woo-scale-20261030-01`, projekt Compose `dyna-woo-39d98c319221`),
klucze REST utworzone, sterownik obciążenia ich używa (`tools/scale/load/woo.mjs`,
`docs/scale/LOAD-DRIVER-PROFILE-COMPLIANCE-20261029.md` §3).

Źródła sprawdzone 18.10.2026: [oficjalny katalog obrazów WordPress](https://raw.githubusercontent.com/docker-library/official-images/master/library/wordpress),
[MariaDB](https://raw.githubusercontent.com/docker-library/official-images/master/library/mariadb),
[nginx](https://raw.githubusercontent.com/docker-library/official-images/master/library/nginx),
[WooCommerce 11.2.1](https://wordpress.org/plugins/woocommerce/),
[wymagania Woo](https://woocommerce.com/document/server-requirements/)
i [REST wc/v3](https://developer.woocommerce.com/docs/apis/rest-api/).
Wersje: WordPress 7.1.3 / PHP 8.3, WP-CLI 2.12.0, Woo 11.2.1, MariaDB 11.4.13, nginx 1.30.6-alpine.

## Przypięcia

`images.lock.json` ma digesty manifestów `linux/arm64` odczytane 30.10.2026 z oficjalnych
indeksów Docker Hub (`docker buildx imagetools inspect --raw <tag>`). Same indeksy są w
`manifests/`; test odtwarza z nich cały lock. sha256 indeksu = RepoDigest pobranego obrazu.

| obraz | digest arm64 | sha256 indeksu |
|---|---|---|
| `wordpress:7.1.3-php8.3-apache` | `sha256:3ce2f1f06b5bd75e4a324ba34a93cb69fb74aa1561f48b6c5318537feef66890` | `8901759b…2e863` |
| `wordpress:cli-2.12.0-php8.3` | `sha256:b03e58ee3b481c5cbb9a6313e3a9e888b636e940abc86002c85595d197ebe412` | `6bcc7bb9…305cb` |
| `mariadb:11.4.13` | `sha256:9640785a96ddd0aa19b50f89f693eebb065e2c7b494d8ae16e5b776a3680e7fb` | `d1891ede…ba620` |
| `nginx:1.30.6-alpine` | `sha256:4f7cab9e1cd018f80e67f31e02dc0c6d18560b19504461c4f3dd37e5c63a74c5` | `0e52bd05…97949` |

Plugin: `https://downloads.wordpress.org/plugin/woocommerce.11.2.1.zip`, 18 060 641 B,
sha256 `5317434cb381b5fdc7c1dd6ee258324f08c390976aaf8d1199f2a0e9a3ab8586` (zgodny). Plik leży
w osobnym katalogu `local-builds/official-woo-plugin-20261030/`; `prepare` kopiuje go do roota.
Z ZIP-a nic nie jest uruchamiane poza oficjalnym `wp plugin install` w kontenerze CLI.

Inny tag albo inny hash pluginu = stop i pytanie, bez podmiany wersji.

## Zakres i izolacja

- Jeden MariaDB, pięć osobnych baz i użytkowników. Każdy WordPress ma własny katalog,
  hasło administratora i własne klucze REST. Klucz jednego sklepu nie działa w innym (401).
- Wygenerowany SQL tworzy tylko bazy, użytkowników i granty. WordPress i dane Woo powstają
  przez `wp core install`, oficjalny plugin oraz `WC_Product_Simple` / `wc_create_order`.
- Sieci: `owned` jest wewnętrzna (WordPress, MariaDB, CLI, brzeg TLS). Brzeg TLS jest też
  w sieci `edge` (nie wewnętrznej). Bez niej Docker nie publikuje portu kontenera, który jest
  tylko w sieci wewnętrznej (sprawdzone 30.10: brzeg nie miał żadnego wiązania).
- Brzeg TLS: własne CA (`prepare` wystawia 14 dni, `secrets/ca.pem`; odnowienie: `renew-tls` niżej), certyfikat `localhost`/`127.0.0.1`,
  `Host` inny niż `localhost:<port>` dostaje 444. Bez przypiętego CA połączenie odpada.
- Produkt: rejestr dopuszcza do pięciu sklepów i origins 18443–18447 od `9224af7`
  (`shared/local-woo-origins.ts`), z przypięciem CA i kluczy oraz zwykłym IAM. Ten katalog
  niczego w produkcie nie zmienia.

## Uruchomienie od zera (nowy root)

Zmienne dla poleceń poniżej:

```sh
TOOLS='<workspace>/development/full-base/tools/local/official-woo'
TASK_ROOT='<workspace>/local-builds/official-woo-scale-<YYYYMMDD-NN>'
PLUGIN_ZIP='<workspace>/local-builds/official-woo-plugin-20261030/woocommerce.11.2.1.zip'
```

Operator działa też z worktree (`.claude/worktrees/<nazwa>`): root `local-builds` jest ten sam.

1. **Pliki (bez Dockera):** `node "$TOOLS/operator.mjs" prepare "$TASK_ROOT" "$PLUGIN_ZIP"`.
   Świeży katalog 0700, pliki 0600, hasła i CA przez OpenSSL. Nic nie trafia do systemowego
   magazynu zaufania.
2. **Indeksy i lock:** dla każdego obrazu
   `docker buildx imagetools inspect --raw <tag> > "$TASK_ROOT/manifests/<id>.index.json"`
   (id: `wordpress`, `cli`, `database`, `tls`), potem `operator.mjs resolve` i `preflight`.
   `resolve` tworzy `compose.resolved.private.json` i `env.private` z `tag@sha256`.
3. **Obrazy i start:**

   ```sh
   PROJECT=$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).name)' "$TASK_ROOT/compose.resolved.private.json")
   DC="docker compose --project-name $PROJECT -f $TASK_ROOT/compose.resolved.private.json"
   $DC pull
   $DC up -d database wp-a wp-b wp-c wp-d wp-e tls
   ```

4. **Instalacja każdego sklepu** (`SLOT` a–e, `PORT` 18443–18447):

   ```sh
   $DC run --rm -T cli-$SLOT core install --url="https://localhost:$PORT" --title="Owned Woo $SLOT" \
     --admin_user="fixture_$SLOT" --admin_email="fixture-$SLOT@example.invalid" --skip-email \
     --prompt=admin_password < "$TASK_ROOT/secrets/admin_$SLOT" > /dev/null
   $DC run --rm -T cli-$SLOT core is-installed
   $DC run --rm -T cli-$SLOT plugin install /fixture/woocommerce.zip --activate
   $DC run --rm -T cli-$SLOT eval-file /fixture/bootstrap.php
   ```

   `> /dev/null` przy `core install` jest konieczne: WP-CLI wypisuje na stdout całe polecenie
   z hasłem podanym przez `--prompt` (30.10 hasło sklepu a trafiło tak do logu i zostało
   zmienione przez `wp_set_password` z PHP podanym na stdin). Bootstrap odmawia ponownego
   wykonania; przerwaną instalację trzeba obejrzeć, nie powtarzać.
5. **Klucze REST** (dla każdego sklepu dwa: `importer` dla wydania, `producer` dla sterownika):
   `node "$TOOLS/operator.mjs" keys "$TASK_ROOT" <slot> <importer|producer>`.
   Klucz tworzy WooCommerce (`WC_Auth::create_keys`, ta sama ścieżka co ekran „Approve”) przez
   `rest-key.php` podany na stdin oficjalnemu WP-CLI, jako administrator `fixture_<slot>`.
   Wynik trafia wyłącznie do nowego pliku `secrets/rest_<purpose>_<slot>.json` (0600), nic nie
   jest wypisywane. Istniejący plik albo klucz tego przeznaczenia = odmowa (bez powtórki).
6. **Wiązania dla sterownika:** `node "$TOOLS/operator.mjs" bindings "$TASK_ROOT" a,b,c,d,e`
   zapisuje `woo-store-bindings.private.json`: ścieżki i sha256 CA oraz kluczy, bez wartości.
7. **Dostęp z przestrzeni sieciowej wydania:** wydanie działa w przestrzeni sieciowej kontenera
   bazy (`scale-pg.sh netns-node`), gdzie `127.0.0.1` nie jest hostem. Forwarder TCP:
   `node "$TOOLS/operator.mjs" forward "$TASK_ROOT" dyna-scale-full-pg18 a,b,c,d,e`.
   To nginx `stream` z przypiętego obrazu (`--network container:<baza>`, read-only, bez uprawnień
   poza SETUID/SETGID, `no-new-privileges`, 32 MiB), nasłuch tylko `127.0.0.1:1844x` w tej
   przestrzeni, cel `host.docker.internal:1844x`. TLS pozostaje end-to-end; forwarder nie widzi
   kluczy ani treści. Dozwolone są tylko kontenery `dyna-scale-<nazwa>-pg18` (nie `dyna-scale-pg18`).

Kontrola: `curl --cacert "$TASK_ROOT/secrets/ca.pem" https://localhost:18443/wp-json/wc/v3/`
daje 200; bez `--cacert` błąd TLS; `-H 'Host: localhost:9999'` daje 444.

## Zatrzymanie, ponowny start, usunięcie

- Zatrzymanie (dane zostają): `$DC stop` oraz `docker stop dyna-woo-<hash>-fwd-<baza>`.
- Ponowny start: `$DC up -d database wp-a wp-b wp-c wp-d wp-e tls` oraz `docker start dyna-woo-<hash>-fwd-<baza>`.
  Forwarder trzeba utworzyć na nowo (`docker rm` + `forward`), gdy kontener bazy był utworzony
  od nowa (nowa przestrzeń sieciowa).
- Usunięcie (osobna decyzja, po zachowaniu wyników): `docker rm -f dyna-woo-<hash>-fwd-<baza>`,
  `$DC down` (sieci i kontenery tego projektu; dane są w `$TASK_ROOT/data`), potem sam katalog
  `$TASK_ROOT`. Bez globalnego `prune`; obrazy usuwa się po tagu z locka, jeśli w ogóle.

Odczyt zamówień w produkcie bierze wszystkie zamówienia sklepu, najwyżej 1000
(`server/local-woo-orders-read.ts`). Pełny profil dokłada ~561 zamówień na sklep (8/min), więc
po jednym pełnym biegu potrzebny jest nowy root (sterownik odmawia startu, gdy bieg przekroczyłby
1000 − 50; `woo.mjs` `orderCapacity`). Krótkie biegi próbne dokładają po ~60–80.
Produkty sklepu mają SKU produktów DYNAMINDS (synchronizacja stanów porównuje SKU); produkt z tym
SKU z wcześniejszego biegu jest używany ponownie i dostaje stan bieżącego biegu.

## Odnowienie certyfikatu brzegu TLS (`renew-tls`)

`prepare` wystawia CA i certyfikat `localhost` na 14 dni. Root, który żyje dłużej (sklep demo i stagingu na :4300),
odnawia się przed `notAfter`, bez ruszania sklepów, baz, kluczy REST i forwarderów:

```bash
openssl x509 -in "$TASK_ROOT/secrets/ca.pem" -noout -enddate      # kiedy wygasa
node "$TOOLS/operator.mjs" renew-tls "$TASK_ROOT" 825              # liczba dni, najwyżej 825
```

- Nowe CA ma ten sam klucz (`secrets/ca.key`) i ten sam podmiot, nowy certyfikat ten sam klucz `secrets/tls.key`.
  Pliki są sprawdzane (łańcuch, `localhost`/`127.0.0.1`, ważność) przed podmianą. Stare zostają obok jako
  `<plik>.superseded-NN`, razem z poprzednim `woo-store-bindings.private.json`.
- Zmieniają się bajty CA, więc i jego sha256: `woo-store-bindings.private.json` dostaje nowy pin CA (piny kluczy
  bez zmian). Restartuje się tylko kontener `tls`, potem handshake z nowym CA na każdym porcie z bindings.
  Wynik: `TLS_RENEWED`, `ca_sha256`, `not_after`.
- Każda kopia CA idzie za nowym pinem, zanim wydanie wystartuje ponownie. Demo: `tools/demo/demo.sh woo-ca`
  (kopia CA i pin w `$DEMO_ROOT/private/woo/selection.json`, ten sam kanał, fixture i klucz importera, potem
  `stop` + `start`). Kanał w bazie demo nie przechowuje CA, więc migawka `dynaminds_demo_snapshot` zostaje bez zmian.
  Sterownik skali (`tools/scale/load/woo.mjs`) czyta bindings przy każdym biegu.
- Do czasu wygaśnięcia starego CA działa jeszcze stary pin (ten sam klucz i podmiot), więc wydanie uruchomione
  przed odnowieniem nie traci połączenia do restartu.
- Cofnięcie: przywróć pliki `*.superseded-NN` w `secrets/` i bindings, potem restart `tls` i `demo.sh woo-ca`.

## Budżet

Wymagane co najmniej 30 GiB wolnego miejsca; budżet środowiska 12 GiB. `operator.mjs budget
"$TASK_ROOT"` mierzy pliki, dane kontenerów (`du` w kontenerach), obrazy i warstwy zapisywalne.
Limity: 512 MiB/sklep, 768 MiB baza, 64 MiB TLS, 32 MiB forwarder, CLI 512 MiB sekwencyjnie.
To monitor budżetu, nie limit systemu plików.

## Czego to nie potwierdza

Konta ani sandboxu dostawcy, skali ani zakończenia Goala. Sklepy są syntetyczne i własne.

Testy źródłowe: `node --test tests/official-local-woo.test.mjs`.
