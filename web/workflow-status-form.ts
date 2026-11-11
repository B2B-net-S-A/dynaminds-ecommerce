/**
 * Form rules of the custom status manager (operations.tsx StatusManager): a status may sit under a parent,
 * saved as one name "Pakowanie / Do zebrania DPD" (shared/order-categories.ts workflowNameParts reads it back).
 */
import { WORKFLOW_LEVEL_SEPARATOR, workflowCategory, workflowNameParts, type OrderCategory } from '../shared/order-categories';

/** Same limit as the server (workflowInput.name). */
export const WORKFLOW_NAME_MAX = 80;

export const composeWorkflowName = (parent: string, leaf: string): string =>
  parent.trim() ? parent.trim() + WORKFLOW_LEVEL_SEPARATOR + leaf.trim() : leaf.trim();

/** Polish message for a name the server would refuse or read back differently; '' when the name is fine. */
export function workflowNameError(parent: string, leaf: string): string {
  if (parent.trim() && leaf.includes('/')) return 'Nazwa statusu podrzędnego nie może zawierać znaku „/”.';
  const length = composeWorkflowName(parent, leaf).length;
  return length > WORKFLOW_NAME_MAX
    ? `Nazwa razem ze statusem nadrzędnym ma ${length} znaków; dopuszczalne jest ${WORKFLOW_NAME_MAX}.`
    : '';
}

/**
 * Parents offered for a status in `category`: existing parent names and top-level custom statuses of that
 * category, without the status being edited; sorted by name.
 */
export function workflowParentOptions(
  rows: Array<{ id: string; name: string; stage: string; category?: string | null }>,
  category: OrderCategory,
  exceptId?: string,
): string[] {
  const names = new Set<string>();
  for (const r of rows) {
    if (r.id === exceptId || workflowCategory(r) !== category) continue;
    const { parent, leaf } = workflowNameParts(r.name);
    names.add(parent ?? leaf);
  }
  return [...names].sort((a, b) => a.localeCompare(b, 'pl'));
}
