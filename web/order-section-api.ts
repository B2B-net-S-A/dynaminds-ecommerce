/** HTTP for per-section editing of an order (shared/order-sections.ts). The only place the card
 * calls PATCH /api/orders/:id/sections/:section. Until the server lands (no `section_values` in the
 * card payload) the buyer sections fall back to the existing PATCH /api/orders/:id/customer. */
import type { OrderSection, SectionLock } from '../shared/order-sections';
import { api, ApiError } from './api';
import { SECTION_FIELDS, sectionLabel, sectionValuesOf, type EditableSection, type Row } from './order-card-model';

export class SectionSaveError extends Error {
  constructor(
    message: string,
    public status: number,
    public lock?: SectionLock,
  ) {
    super(message);
  }
}

export type SectionRequest = (path: string, method: string, body: unknown, onResponse: (data: unknown, status: number) => void) => Promise<unknown>;
const defaultRequest: SectionRequest = (path, method, body, onResponse) =>
  api(path, method, body, {}, undefined, (data, r) => onResponse(data, r.status));

const LEGACY: Partial<Record<EditableSection, string[]>> = {
  customer: ['name', 'email', 'phone'],
  delivery_address: ['street', 'postal_code', 'city'],
};

/** Saves one section. Throws SectionSaveError: 409 stale version, 423 locked (with `lock`), 422 invalid.
 * A 5xx or a lost response is rethrown as is: its outcome is unknown and the card re-reads the order. */
export async function saveOrderSection(o: Row, section: OrderSection, values: Row, request: SectionRequest = defaultRequest): Promise<void> {
  if (section === 'products') throw new SectionSaveError('Produkty zapisują się pozycja po pozycji.', 400);
  if (!('section_values' in o)) return legacySave(o, section, values, request);
  let lock: SectionLock | undefined;
  try {
    await request(
      `/orders/${encodeURIComponent(o.id)}/sections/${section}`,
      'PATCH',
      { expected_version: Number(o.version), values },
      (data, status) => {
        if (status === 423 && data && typeof data === 'object' && 'lock' in data) lock = (data as { lock: SectionLock }).lock;
      },
    );
  } catch (e) {
    if (e instanceof ApiError && e.status < 500) {
      const message =
        e.status === 409 ? 'Zamówienie zmieniło się w międzyczasie. Odczytaj je ponownie i powtórz zmianę.' : e.status === 423 ? lock?.reason ?? e.message : e.message;
      throw new SectionSaveError(message, e.status, lock);
    }
    throw e;
  }
}

async function legacySave(o: Row, section: EditableSection, values: Row, request: SectionRequest): Promise<void> {
  const supported = LEGACY[section];
  const current = sectionValuesOf(o, section) as Row;
  const unsupported = SECTION_FIELDS[section].filter((f) => !supported?.includes(f.field) && String(values[f.field] ?? '') !== String(current[f.field] ?? ''));
  if (!supported || unsupported.length)
    throw new SectionSaveError(
      `Zapis sekcji „${sectionLabel(section)}”${unsupported.length ? ` (${unsupported.map((f) => f.label).join(', ')})` : ''} będzie dostępny po aktualizacji serwera.`,
      501,
    );
  const customer = section === 'customer' ? values : sectionValuesOf(o, 'customer');
  const address = section === 'delivery_address' ? values : sectionValuesOf(o, 'delivery_address');
  try {
    await request(
      `/orders/${encodeURIComponent(o.id)}/customer`,
      'PATCH',
      {
        expected_version: String(o.version),
        customer_name: customer.name,
        email: customer.email,
        phone: customer.phone,
        street: address.street,
        postal_code: address.postal_code,
        city: address.city,
      },
      () => {},
    );
  } catch (e) {
    if (e instanceof ApiError && e.status < 500) throw new SectionSaveError(e.message, e.status);
    throw e;
  }
}
