# N24 — lokalny backup, odtworzenie i bezpieczeństwo podglądu

Status: **odbiór lokalny opisanego zakresu PASS; pełny Goal OPEN**.

Normalna aplikacja działa pod `http://127.0.0.1:4105`, a osobna odtworzona
kopia pod `http://127.0.0.1:4106`. Obie używają wydania
`2e05da9f4d87f9941f39111714c21af17d661ce199e60d607caacfab6397790b`,
źródeł `bd18f343d46861ea25d7ba2a3d574d09280a8a6a` i schematu217.
N24 nie aktywuje kandydata CRM218.

## Rzeczywisty odbiór

- Utworzono zaszyfrowany backup bazy, konfiguracji i obrazów: **14 131 236 B**.
- Wykonano jedno odtworzenie do nowej bazy PG04
  `dynaminds_restore_4ef96eefa8122203`. Zachowano wcześniejszą kopię N23
  oraz jej pliki; zatrzymano wyłącznie jej podgląd, aby zwolnić port4106.
- Przed uruchomieniem nowego podglądu porównano wszystkie **644 tabele**:
  pełne liczby i hashe wierszy odpowiadają bazie źródłowej N24.
- Po starcie i pojedynczym logowaniu Chrome źródło nadal ma wszystkie644
  tabele bez zmian. Kopia ma643 bez zmian, a sesje mają dokładny inverse:
  wszystkie144 wcześniejsze wiersze i jedną nową sesję lokalnego konta A.
- Zachowano pełne731 wierszy kolejki,18 ról i3 członkostwa na każdym
  klastrze. Wszystkie dziewięć kontroli integralności na obu bazach
  zwróciło true w niezmienionych limitach8/9s. Transakcje kontrolne
  zakończyły się ROLLBACK i zamknięciem klientów.
- Osobno porównano pełne bajty i ścieżkę jedynego istniejącego obrazu.
- Health obu działających aplikacji potwierdził tę samą rewizję.
  Podgląd ma `restore_preview=true`, wyłączone workery, procesory Woo
  i importy; jego transport do dostawców jawnie odmawia wywołań.
- Chrome na zwykłym koncie D otwiera ustawienia z aktywnymi kontrolkami
  bezpieczeństwa. Chrome na odtworzonym koncie A pokazuje istniejące
  zamówienia i ustawienia; **MFA, zmiana hasła i zakończenie sesji są
  wyłączone**. Nie wykonywano zmian poświadczeń, MFA ani sesji.

## Dowody

Wszystkie poniższe ścieżki są względne do
`local-builds/full-base-preview-20261017/n24-backup-restore-prepared-agent-20261019-01`
w katalogu projektu. Prywatnych konfiguracji i sekretów nie dołączono do Git.

| Dowód | SHA256 |
| --- | --- |
| `root-live-preflight01.private.json` | `abd842a04d2ed590876d81c77d0ca9ab07ab2504342efcbf1e73cb08655d3de0` |
| `root-create-ACK.private.json` | `d05e39e1a1950316031ca99977951a5ca1387ab2dbd4aaff16e2e06202fbbb4d` |
| `root-restore-ACK.private.json` | `84a87866642cb51142732499b6e4355c3479e3187efb8163e545b62b9601c20e` |
| `verify-pre01/result.private.json` | `89d8fbf61738200d4ae18ad78d1968adcf72aad9cf58f06ec67b868eaa489e16` |
| `verify-post-login01/result.private.json` | `165fcd4b60ffef791545b9f331d40e4b5973636cf2d0ca2e12bf50f880df5427` |
| `root-live-post-login01.private.json` | `5de427f5b7d48a730a5e6f8419e9284716f4a3e6a57e8174b36f9457903cce6c` |
| `preview-stack-profile.private.json` | `16b25f6fbf0d99665d2d5ff9e695bff8d2607021262153e53ead18e591da64d4` |

W tym samym katalogu zapisano `root-preview-settings-ax.private.txt`
oraz zrzut `root-preview-security.png`.

## Granice odbioru

To odbiór odtworzenia danych, konfiguracji, istniejącego obrazu i określonych
kontrolek podglądu. Nie potwierdza odtworzenia całego prywatnego systemu
plików, wznowienia wykonywania niepustej kolejki, wszystkich paneli readonly,
ciągłej automatyki pięciu firm ani docelowej skali.

Panel API/webhooków ma dodatkową poprawkę readonly w źródłach i11 testów
kontrolowanych PASS; **nie zawiera jej to wydanie N24**. Rzeczywisty odbiór
tej poprawki pozostaje otwarty. Nie nadano odbioru pełnej zgodności z Base,
integracji dostawców ani całego Goala.
