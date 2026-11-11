/** Prepared, UNREGISTERED dictionary runtime. Capabilities must come from the
 * caller's validated startup contracts, never request parameters or table presence.
 */
import type { Actor } from './domain';
import type { BaseWireJson } from './base-wire-codec';
import { tenantTx, tenantReadTx } from './db';
import { createCrmDictionaryWirePort } from './crm';
import { authorizeBaseWireCrmInTx, withBaseWireCrmAuthority } from './base-wire-crm-authority';
import {
  BASE_WIRE_CRM_DICTIONARY_METHODS,
  createBaseWireCrmDictionariesService,
  isBaseWireCrmDictionaryWrite,
} from './base-wire-crm-dictionaries';
import { ensure } from './errors';

export type BaseWireCrmDictionaryCapabilities = Readonly<{
  crm218Verified: boolean;
  dictionary219Verified: boolean;
  readOnly: boolean;
}>;
export type BaseWireCrmDictionaryRuntimePorts = {
  tenantTx: typeof tenantTx;
  tenantReadTx: typeof tenantReadTx;
  authorize: typeof authorizeBaseWireCrmInTx;
  domain: typeof createCrmDictionaryWirePort;
};
const defaults: BaseWireCrmDictionaryRuntimePorts = {
  tenantTx, tenantReadTx, authorize: authorizeBaseWireCrmInTx, domain: createCrmDictionaryWirePort,
};

export function createBaseWireCrmDictionaryRuntime(
  capabilities: BaseWireCrmDictionaryCapabilities,
  ports: BaseWireCrmDictionaryRuntimePorts = defaults,
) {
  ensure(capabilities && ['crm218Verified', 'dictionary219Verified', 'readOnly']
    .every(key => typeof capabilities[key as keyof typeof capabilities] === 'boolean'),
  503, 'Brak zweryfikowanych możliwości słowników Base CRM');
  const selected = Object.freeze({ ...capabilities });
  return {
    async execute(actor: Actor, method: string, parameters: Record<string, BaseWireJson>, options: { clientKey?: string } = {}) {
      ensure(BASE_WIRE_CRM_DICTIONARY_METHODS.includes(method as typeof BASE_WIRE_CRM_DICTIONARY_METHODS[number]),
        400, 'Nieznana metoda słownika CRM');
      ensure(selected.crm218Verified && selected.dictionary219Verified, 503, 'Słowniki Base CRM wymagają modułów218 i219');
      ensure(!isBaseWireCrmDictionaryWrite(method) || !selected.readOnly, 423, 'Podgląd kopii jest tylko do odczytu');
      const principal = Object.freeze({ ...actor });
      const adapter = createBaseWireCrmDictionariesService({
        transaction: (writing, work) => (writing ? ports.tenantTx : ports.tenantReadTx)(principal.tenantId, async c => {
          // Same order as the client wire service: tenant mutex precedes the
          // fresh SQL authority's membership/key locks, including keyed replay.
          if (writing) await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['crm215:' + principal.tenantId]);
          return withBaseWireCrmAuthority(c, principal, writing, async proof =>
            work(ports.domain(c, principal, proof)), ports.authorize);
        }),
      });
      return adapter.execute(method, parameters, options);
    },
  };
}
