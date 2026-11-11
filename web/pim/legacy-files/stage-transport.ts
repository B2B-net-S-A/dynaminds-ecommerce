/** Browser-only authenticated StagePort. Staging reads do not preview or apply PIM values. */
import type {StagePort} from './session';

type JsonTransport = (path: string, method?: string, body?: unknown) => Promise<unknown>;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fields = ['client_key', 'core_request', 'execution_id', 'preview', 'typed_mapping'];
function need(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

/** The current parent gate is read at dispatch time; caller must explicitly opt into rollout. */
export function createAuthenticatedLegacyStagePort(
  transport: JsonTransport,
  catalogId: string,
  allowed: () => boolean,
): StagePort {
  need(uuid.test(catalogId), 'Wybierz rzeczywisty katalog importu.');
  return async input => {
    need(allowed(), 'Drugi etap PIM nie jest dostępny w bieżącym zakresie.');
    need(input && typeof input === 'object' && !Array.isArray(input), 'Niepoprawny zakres drugiego etapu.');
    need(JSON.stringify(Object.keys(input).sort()) === JSON.stringify(fields), 'Niepoprawny zakres drugiego etapu.');
    const body = structuredClone(input);
    need(body.core_request?.catalog_id === catalogId && body.typed_mapping?.catalog_id === catalogId,
      'Drugi etap wskazuje inny katalog niż zapisany import.');
    need(typeof body.client_key === 'string' && uuid.test(body.client_key)
      && typeof body.execution_id === 'string' && uuid.test(body.execution_id), 'Niepoprawny identyfikator drugiego etapu.');
    need(allowed(), 'Zakres lub blokada zapisu uległy zmianie.');
    // api() owns genuine same-origin cookie/workspace headers and HTTP error handling.
    // Both prepared.ready branches return untouched; the shared session validates them.
    return transport(`/product-catalogs/${catalogId}/pim/legacy-file-stage`, 'POST', body);
  };
}
