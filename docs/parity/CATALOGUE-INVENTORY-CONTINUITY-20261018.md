# Ciągłość odkrytych kodów integracji, 18.10.2026

Status: **SOURCE_HELPER_AND_CONTROLLED_TESTS_PASS**. Rozszerzono narzędzie zamrażania
zakresu; nie utworzono scope.v3 i nie zamknięto pełnego katalogu funkcji Base.

[scope-freeze](../../tools/parity/scope-freeze.mjs) może zapisać osobne
`catalogue_inventory` po jawnym `catalogue_inventory_version:1` w żądaniu.
Przechowuje dokładne code/name/logo z przypiętego rosteru, z zachowaniem wielkości
liter i odrębności wariantów. Są to metadane rozpoznania, bez dopisywania dostawców,
operacji, nowych wymaganych ID lub potwierdzeń integracji.

Następca ponownie odtwarza metadane rodzica z jego przypiętych wejść. Znany kod
nie może zniknąć, także podczas przejścia ze starszego formatu lub po usunięciu
opcjonalnego pola z ponownie zahashowanego rodzica. Obecne metadane rodzica muszą
być zgodne z jego źródłami; ich jawne wyłączenie jest odrzucane.
Granica: usunięcie samego opcjonalnego pola i podmiana referencji rodzica przy
zachowaniu wszystkich kodów jest nierozróżnialna od legacy. Nie jest to gwarancja
obowiązkowej obecności metadanych przy dowolnie zastąpionej referencji rodzica.

Root:19/19 testów PASS,0 FAIL/0 SKIP, stderr pusty; niezależny przegląd bez P1/P2.
Testy obejmują dokładny starszy format, dodanie kodów, utratę kodu, warianty,
duplikaty, nieprawidłowe metadane/provenance, sfałszowany katalog rodzica i
`null`/`undefined` odrzucane jako REQUEST_SCHEMA.
Lokalny dowód: `local-builds/full-base-preview-20261017/root-catalogue-inventory-scope-check-20261018-01/root-terminal-review.private.json`.

Niezależny odczyt całego przypiętego rosteru v2 potwierdził zgodność2052 zapisanych
wpisów/2052 różnych kodów z nowym walidatorem. Surowa odpowiedź HTTP nie została
zachowana; narzędzie jawnie zapisuje `raw_response_revalidated:false` i nie traktuje
zapisanego hasha odpowiedzi jako nowej weryfikacji HTTP lub dostępności dostawcy.

Nie odświeżono przypięć wcześniejszych dowodów Mirakl. Bieżące odtworzenie scope.v2
odmawia przez ich wcześniejszy drift; niezmieniony helper HEAD odmawia tak samo.
Nie osłabiono tej kontroli ani nie podmieniono istniejącego audytu. Pełna matryca,
rzeczywiste operacje adapterów i odbiór dostawców pozostają otwarte.
