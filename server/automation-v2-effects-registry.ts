/** Automation rules v2: effect handlers that live in their own modules (server/automation-v2-effect-types.ts). */
import type { PoolClient } from 'pg';
import type { EffectCatalogParams, EffectHandler, EffectModule } from './automation-v2-effect-types';
import { effects as org } from './automation-v2-effects-org';
import { effects as orders } from './automation-v2-effects-orders';
import { effects as shipping } from './automation-v2-effects-shipping';
import { effects as comm } from './automation-v2-effects-comm';
import { effects as supply } from './automation-v2-effects-supply';
import { effects as merge } from './automation-v2-effects-merge';

const MODULES: EffectModule[] = [org, orders, shipping, comm, supply, merge];

export const EFFECT_HANDLERS: Readonly<Record<string, EffectHandler>> = Object.freeze(
  Object.assign({}, ...MODULES.map((m) => m.handlers)),
);

export async function moduleCatalogParams(c: PoolClient): Promise<EffectCatalogParams> {
  const out: EffectCatalogParams = {};
  for (const m of MODULES) Object.assign(out, await m.catalogParams(c));
  return out;
}
