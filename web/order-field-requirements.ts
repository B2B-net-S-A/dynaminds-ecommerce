/** UI hints only. Native/current packing validation remains server-owned. */
export type OrderFieldRequirement = 'manual_create' | 'pack_complete';
export function toggleOrderFieldRequirement(
  current: readonly OrderFieldRequirement[],
  stage: OrderFieldRequirement,
  checked: boolean,
): OrderFieldRequirement[] {
  if (checked) return current.includes(stage) ? [...current] : [...current, stage];
  return current.filter((item) => item !== stage);
}
export function packingFieldRequirementHint(
  definition: { enabled: boolean; type: string; required_on: readonly OrderFieldRequirement[] },
  value: { type: string; value: string | string[]; file?: { id: string } | null } | null,
  backendAvailable: boolean,
): string | null {
  if (!definition.enabled || !definition.required_on.includes('pack_complete')) return null;
  if (!backendAvailable)
    return 'Wymagane przy pakowaniu — sprawdzanie wymaga wsparcia tej wersji serwera.';
  const missing = !value || value.type !== definition.type ||
    (definition.type === 'multi_select'
      ? !Array.isArray(value.value) || value.value.length === 0
      : definition.type === 'file'
        ? typeof value.value !== 'string' || !value.file || value.file.id !== value.value
        : typeof value.value !== 'string' || value.value.trim().length === 0);
  return missing
    ? 'Do uzupełnienia przed pakowaniem. Ostatecznie sprawdzi serwer podczas podglądu.'
    : 'Wymagane przy pakowaniu. Ostatecznie sprawdzi serwer podczas podglądu.';
}
