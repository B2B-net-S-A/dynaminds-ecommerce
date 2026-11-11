import { tenantTx, tenantReadTx } from './db';
import { createCrmClientWirePort } from './crm';
import { authorizeBaseWireCrmInTx } from './base-wire-crm-authority';
import { createBaseWireCrmService } from './base-wire-crm';
import { createBaseWireCrmDictionaryRuntime } from './base-wire-crm-dictionaries-runtime';
import { createBaseWireCrmDispatch, type BaseWireCrmDispatchCapabilities, type BaseWireCrmDispatchPorts } from './base-wire-crm-dispatch';

export function createDefaultBaseWireCrmService() {
  return createBaseWireCrmService({
    transaction: (actor, writing, work) => (writing ? tenantTx : tenantReadTx)(actor.tenantId, work),
    authorize: authorizeBaseWireCrmInTx,
    domain: createCrmClientWirePort,
  });
}

export type BaseWireCrmDispatchRuntimeFactories = {
  clients(): BaseWireCrmDispatchPorts['clients'];
  dictionaries(capabilities: BaseWireCrmDispatchCapabilities): BaseWireCrmDispatchPorts['dictionaries'];
};
const dispatchFactories: BaseWireCrmDispatchRuntimeFactories = {
  clients: createDefaultBaseWireCrmService,
  dictionaries: createBaseWireCrmDictionaryRuntime,
};

/** Compose existing services without installing219, registering routes or
 * entering a transaction. Only validated startup capabilities select methods.
 * Lazy factories also keep a disabled dictionary lane completely untouched. */
export function createDefaultBaseWireCrmDispatch(
  capabilities: BaseWireCrmDispatchCapabilities,
  factories: BaseWireCrmDispatchRuntimeFactories = dispatchFactories,
) {
  let clients: BaseWireCrmDispatchPorts['clients'] | undefined;
  let dictionaries: BaseWireCrmDispatchPorts['dictionaries'] | undefined;
  const dispatch = createBaseWireCrmDispatch(capabilities, {
    clients: {
      execute: (...args) => (clients ??= factories.clients()).execute(...args),
      file: (...args) => (clients ??= factories.clients()).file(...args),
    },
    dictionaries: {
      execute: (...args) => (dictionaries ??= factories.dictionaries(selected)).execute(...args),
    },
  });
  // Dispatch has rejected accessors, extra fields and non-booleans before this
  // data-only copy. Both layers retain the same immutable startup decision.
  const selected = Object.freeze({ ...capabilities });
  return dispatch;
}
