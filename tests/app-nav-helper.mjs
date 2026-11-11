/**
 * Navigates the actual App like a person since Uwagi v3 §2: a module in the main menu, or an option in the
 * options panel of its module (opened by clicking the module first). web/module-nav.test.mjs checks that
 * `optionModules` matches web/module-nav-config.ts.
 */
export const optionModules = {
  'Do skompletowania': 'Kompletacja',
  'Zgłoszenia i rozliczenia': 'Zwroty i reklamacje',
  'Import wpłat': 'Przelewy i pobrania',
  'Klienci CRM': 'Klienci',
  'Sieć B2B': 'Klienci',
  'Kontrahenci B2B': 'Klienci',
  Produkty: 'Asortyment',
  Cenniki: 'Asortyment',
  Magazyny: 'Asortyment',
  'Partie i FIFO': 'Asortyment',
  'Inwentaryzacje partii': 'Asortyment',
  'Zakupy i dostawy': 'Asortyment',
  'Reguły produktów': 'Asortyment',
  'Wiadomości klientów': 'Komunikacja',
  'Komunikacja email': 'Komunikacja',
  'Komunikacja SMS': 'Komunikacja',
  'Reguły i statusy własne': 'Automatyzacje',
  'Pola zamówień': 'Automatyzacje',
  'Pola — import i operacje': 'Automatyzacje',
  'Pola — mapowania kanałów': 'Automatyzacje',
  'Kanały i usługi': 'Integracje',
  'API i webhooki': 'Integracje',
  Raporty: 'Raporty i dokumenty',
  Dokumenty: 'Raporty i dokumenty',
  'Historia operacji': 'Raporty i dokumenty',
  'Organizacja i konto': 'Ustawienia',
  RODO: 'Ustawienia',
};

const byText = (els, text) => els.find((e) => e.textContent.trim() === text);

/**
 * `click(element)` is the test's own click (most assert the element is enabled first). `moduleLabel` names the
 * module of an option missing from `optionModules` (status options such as 'Spakowane').
 */
export async function navigateApp(container, label, click, moduleLabel = optionModules[label]) {
  const menu = () => [...container.querySelectorAll('.sidebar nav button')];
  const options = () => [...container.querySelectorAll('.module-panel .module-option')];
  const direct = byText(menu(), label);
  if (direct && !direct.hasAttribute('aria-expanded')) return click(direct);
  if (direct) {
    // A module with options opens its panel; its first option is the module's main view.
    await click(direct);
    const first = container.querySelector('.module-panel .module-option, .module-panel .status-panel-all button');
    if (!first) throw new Error('Pusty panel modułu: ' + label);
    return click(first);
  }
  if (!byText(options(), label)) {
    const module = byText(menu(), moduleLabel);
    if (!module) throw new Error('Brak w menu: ' + label);
    await click(module);
  }
  const option = byText(options(), label);
  if (!option) throw new Error('Brak opcji w panelu: ' + label);
  return click(option);
}

/**
 * Every entry of the menu as `{ label, module }`: plain modules and the Zamówienia module (`module` null), and each
 * option of the other modules. Opens the option panels to read them, without leaving the current view.
 */
export async function menuScreens(container, click) {
  const menu = () => [...container.querySelectorAll('.sidebar nav button')];
  const screens = [];
  for (const label of menu().map((e) => e.textContent.trim())) {
    const button = byText(menu(), label);
    if (!button.hasAttribute('aria-expanded')) { screens.push({ label, module: null }); continue; }
    await click(button);
    const options = [...container.querySelectorAll('.module-panel .module-option')].map((e) => e.textContent.trim());
    if (!options.length) screens.push({ label, module: null });
    for (const option of options) screens.push({ label: option, module: label });
  }
  return screens;
}

/** 'Moduł magazyniera' and 'Ekran pakowania' replace the shell with the packer app; 'Panel biura' brings it back. */
export async function returnToOffice(container, click) {
  if (container.querySelector('.sidebar nav')) return false;
  const office = byText([...container.querySelectorAll('.wms-header button')], 'Panel biura');
  if (!office) throw new Error('Brak menu i przycisku Panel biura');
  await click(office);
  if (!container.querySelector('.sidebar nav')) throw new Error('Panel biura nie przywrócił menu');
  return true;
}
