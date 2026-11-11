import { ensure } from './errors';

/** SQL148 shares the genuine139 ledger, but its private plan contains costs.
 * Legacy HTTP views must stop before spreading that payload or its snapshot.
 */
export function assertLegacyReturnAssistantPayload(payload: unknown): void {
  const p = payload as { snapshot?: { protocol?: unknown; plan?: { protocol?: unknown } };
    plan?: { protocol?: unknown }; planner_source?: unknown } | null;
  ensure(p?.snapshot?.protocol !== 'destinations_v1' && p?.snapshot?.plan?.protocol !== 'destinations_v1' &&
    p?.plan?.protocol !== 'destinations_v1' && p?.planner_source === undefined,
    409, 'Ten zapis odczytaj i obsłuż przez przyjęcie zwrotu do magazynów');
}
