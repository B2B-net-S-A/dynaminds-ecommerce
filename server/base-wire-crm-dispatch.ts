/** Prepared, UNREGISTERED composition. Only validated server startup supplies
 * capabilities; request parameters never select capabilities or authority.
 * Neither this module nor its constructor imports a database/runtime factory.
 */
import type { Actor } from './domain';
import type { BaseWireJson } from './base-wire-codec';
import { BASE_WIRE_CRM_METHODS, isBaseWireCrmWrite, type BaseWireCrmService } from './base-wire-crm';
import { BASE_WIRE_CRM_DICTIONARY_METHODS, isBaseWireCrmDictionaryWrite } from './base-wire-crm-dictionaries';
import type { createBaseWireCrmDictionaryRuntime } from './base-wire-crm-dictionaries-runtime';
import { ensure } from './errors';

export const BASE_WIRE_CRM_DISPATCH_METHODS = Object.freeze([
  ...BASE_WIRE_CRM_METHODS, ...BASE_WIRE_CRM_DICTIONARY_METHODS,
]);
export type BaseWireCrmDispatchMethod = typeof BASE_WIRE_CRM_DISPATCH_METHODS[number];
export type BaseWireCrmDispatchCapabilities = Readonly<{
  crm218Verified: boolean;
  dictionary219Verified: boolean;
  readOnly: boolean;
}>;
export type BaseWireCrmDispatchPorts = {
  clients: Pick<BaseWireCrmService, 'execute' | 'file'>;
  dictionaries: Pick<ReturnType<typeof createBaseWireCrmDictionaryRuntime>, 'execute'>;
};

function method(value: string): asserts value is BaseWireCrmDispatchMethod {
  ensure(BASE_WIRE_CRM_DISPATCH_METHODS.includes(value as BaseWireCrmDispatchMethod), 400, 'Nieznana metoda Base CRM');
}
export function isBaseWireCrmDispatchWrite(value: string) {
  method(value);
  return isBaseWireCrmWrite(value) || isBaseWireCrmDictionaryWrite(value);
}
export function baseWireCrmDispatchScope(value: string) {
  return isBaseWireCrmDispatchWrite(value) ? 'crm:write' as const : 'crm:read' as const;
}
function capabilities(value: BaseWireCrmDispatchCapabilities) {
  // Refuse accessor/coercion/extra fields before taking an immutable snapshot.
  // This is an internal construction boundary, not a request-body parser.
  ensure(value && typeof value === 'object' && !Array.isArray(value), 503, 'Brak zweryfikowanych możliwości Base CRM');
  const fields = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(fields);
  const expected = ['crm218Verified', 'dictionary219Verified', 'readOnly'] as const;
  ensure(keys.length === expected.length && expected.every(key => Object.hasOwn(fields, key)
    && Object.hasOwn(fields[key], 'value') && typeof fields[key].value === 'boolean'),
  503, 'Brak zweryfikowanych możliwości Base CRM');
  return Object.freeze(Object.fromEntries(expected.map(key => [key, fields[key].value])) as BaseWireCrmDispatchCapabilities);
}

export function createBaseWireCrmDispatch(input: BaseWireCrmDispatchCapabilities, ports: BaseWireCrmDispatchPorts) {
  const selected = capabilities(input);
  return {
    async execute(actor: Actor, selectedMethod: string, parameters: Record<string, BaseWireJson>, options: { clientKey?: string } = {}): Promise<Record<string, BaseWireJson>> {
      method(selectedMethod);
      ensure(selected.crm218Verified, 503, 'Moduł Base CRM wymaga zweryfikowanego218');
      ensure(!isBaseWireCrmDispatchWrite(selectedMethod) || !selected.readOnly, 423, 'Podgląd kopii jest tylko do odczytu');
      if (BASE_WIRE_CRM_DICTIONARY_METHODS.includes(selectedMethod as typeof BASE_WIRE_CRM_DICTIONARY_METHODS[number])) {
        ensure(selected.dictionary219Verified, 503, 'Słowniki Base CRM wymagają zweryfikowanego219');
        return ports.dictionaries.execute(actor, selectedMethod, parameters, options);
      }
      return ports.clients.execute(actor, selectedMethod, parameters, options);
    },
    async file(actor: Actor, clientId: number, fieldId: number) {
      ensure(selected.crm218Verified, 503, 'Moduł Base CRM wymaga zweryfikowanego218');
      return ports.clients.file(actor, clientId, fieldId);
    },
  };
}
