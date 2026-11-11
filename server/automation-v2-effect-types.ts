/**
 * Automation rules v2: the contract of one effect handler. Effect modules (server/automation-v2-effects-*.ts)
 * export handlers; server/automation-v2-effects-registry.ts collects them and server/automation-v2-effects.ts
 * dispatches to them before its built-in effects.
 */
import type { PoolClient } from 'pg';
import type { z } from 'zod';
import type { CatalogEffect } from '../shared/automation-v2';
import type { Actor } from './domain';
import type { EventContext } from './events';

export interface EffectEnv {
  c: PoolClient;
  actor: Actor;
  orderId: string;
  runId: string;
  rule: { id: string; name: string };
  context: EventContext;
  /** Runs another v2 rule for the same order inside this chain. */
  runRule: (ruleId: string) => Promise<string>;
}

export interface EffectResult {
  type: string;
  changed: boolean;
  message: string;
}

export interface EffectHandler<P = any> {
  /** Strict zod schema of the effect's params (stored in the rule). */
  schema: z.ZodType<P>;
  /** Checks against the tenant's data when the rule is saved; throws Problem(422) with a Polish message. */
  validate?: (c: PoolClient, p: P, ctx: { selfId?: string }) => Promise<void>;
  /** Polish sentence for the test view ("co by się stało"). `names` maps uuids to names when known. */
  describe: (p: P, names: Record<string, string>) => string;
  /** Applies the effect inside the run's savepoint. Throws Problem on refusal (rolls back the rule's effects). */
  apply: (env: EffectEnv, p: P, index: number) => Promise<EffectResult>;
}

export type EffectCatalogParams = Record<string, CatalogEffect['params']>;

export interface EffectModule {
  handlers: Record<string, EffectHandler>;
  /** Editor form descriptors with the tenant's option lists (printers, warehouses, people, …). */
  catalogParams: (c: PoolClient) => Promise<EffectCatalogParams>;
}

export const result = (type: string, changed: boolean, message: string): EffectResult => ({ type, changed, message });
