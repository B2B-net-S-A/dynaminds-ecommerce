import React, { useRef, useState } from 'react';
import { Search, Plus, ArrowUpRight } from 'lucide-react';

export const providerSummaries: Record<string, string> = {
  deepl: 'Tłumaczenie nazw i opisów produktów, limity znaków, kolejka i przegląd treści.',
  allegro: 'Zamówienia, szkice i publikacja ofert, ceny, dostępność oraz statusy.',
  amazon: 'Zamówienia, katalog i warianty, ceny, dostępność ofert oraz potwierdzanie wysyłek.',
  ebay: 'Zamówienia, katalog, nowe szkice, publikacja ofert i przekazywanie wysyłek.',
  woocommerce: 'Zamówienia i produkty sklepu, ceny, dostępność oraz statusy.',
  shopify: 'Zamówienia, katalog i warianty, ceny, dostępność oraz publikacja produktów.',
  prestashop: 'Zamówienia, produkty, ceny i dostępność sklepu.',
  inpost: 'Przesyłki i etykiety ShipX, tracking oraz publiczna wyszukiwarka punktów.',
  dpd: 'Przesyłki krajowe, etykiety, odbiory, protokoły i tracking.',
  odoo: 'Katalog ERP, zamówienia, ceny, dostępność, faktury oraz istniejące PDF i zdjęcia.',
  fakturownia: 'Faktury, pełne korekty zwrotów oraz pobieranie dokumentów PDF.',
  bigbuy: 'Katalog hurtowni, warianty, ceny i dostępność zewnętrzna.',
  smtp: 'Własne konta SMTP, szablony HTML, kolejka i lokalny odbiornik wiadomości.',
  smsapi: 'Profil konta i test SMS bez doręczenia. Rzeczywista wysyłka pozostaje wyłączona.',
};

export function IntegrationCatalog({
  registry,
  admin,
  details,
  add,
  readOnly = false,
}: {
  registry: any[];
  admin: boolean;
  readOnly?: boolean;
  details: (provider: any) => void;
  add: (id: string) => void;
}) {
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const [search, setSearch] = useState(''),
    [category, setCategory] = useState('');
  const categories = [...new Set(registry.map((p) => p.category))];
  const term = search.trim().toLocaleLowerCase('pl');
  const matching = registry.filter((p) =>
    [p.name, p.category, providerSummaries[p.id] ?? '']
      .join(' ')
      .toLocaleLowerCase('pl')
      .includes(term),
  );
  const shown = matching.filter((p) => !category || p.category === category);
  return (
    <section className="integration-catalog">
      <div className="panel integration-catalog-heading">
        <div>
          <h2>Katalog integracji</h2>
          <p>Wybierz dostawcę i sprawdź zakres konektora przed konfiguracją.</p>
        </div>
        <label className="integration-search">
          <Search size={18} />
          <input
            aria-label="Szukaj dostawcy w katalogu"
            placeholder="Nazwa lub funkcja, np. faktury"
            value={search}
            maxLength={100}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <div className="integration-category-list" aria-label="Kategorie integracji">
          <button
            className="button small-btn"
            aria-pressed={!category}
            onClick={() => setCategory('')}
          >
            Wszystkie ({matching.length})
          </button>
          {categories.map((c) => (
            <button
              className="button small-btn"
              key={c}
              aria-pressed={category === c}
              onClick={() => setCategory(c)}
            >
              {c} ({matching.filter((p) => p.category === c).length})
            </button>
          ))}
        </div>
        <p className="muted">
          Zakres kodu konektora nie potwierdza dostępu do konta dostawcy. Klucze, wymagane zgody i
          ograniczenia sprawdzisz w szczegółach.
        </p>
      </div>
      <p role="status" className="muted">
        Znaleziono {shown.length} z {registry.length} dostawców.
      </p>
      {!shown.length && (
        <div className="panel empty">
          <p>Brak dostawców dla wybranych filtrów.</p>
          <button
            className="button"
            onClick={() => {
              setSearch('');
              setCategory('');
            }}
          >
            Wyczyść filtry katalogu
          </button>
        </div>
      )}
      <div className="integration-grid">
        {shown.map((p) => (
          <section className="panel integration-card" key={p.id}>
            <div className="integration-card-top">
              <div className="provider-mark" style={{ background: p.color + '17', color: p.color }}>
                {p.name.slice(0, 1)}
              </div>
              <span className="source-label">{p.category}</span>
            </div>
            <h3>{p.name}</h3>
            <p>
              {providerSummaries[p.id] ?? 'Sprawdź zakres i wymagania w szczegółach konektora.'}
            </p>
            <div className="integration-card-actions">
              <button
                className="text-button"
                aria-label={`Zakres i wymagania ${p.name}`}
                onClick={() => details(p)}
              >
                Zakres i wymagania <ArrowUpRight size={15} />
              </button>
              {admin && (
                <button
                  className="button small-btn"
                  aria-label={`Dodaj połączenie ${p.name}`}
                  disabled={readOnly}
                  onClick={() => { if (!readOnlyRef.current) add(p.id); }}
                >
                  <Plus size={14} /> Dodaj
                </button>
              )}
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}
