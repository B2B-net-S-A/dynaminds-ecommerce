import type { PoolClient } from 'pg';
import { ensure } from './errors';
import { productDeletionsAvailable, productNotDeletedSQL } from './product-deletions';
export const creation = (operation: string) =>
  ['create_draft', 'create_group', 'create_variant'].includes(operation);
const name = (s: unknown) =>
  String(s ?? '')
    .trim()
    .toLocaleLowerCase('pl-PL');
export function attributesMatch(expected: any[], actual: any[], variant = false) {
  return expected.every((a) => {
    const found = actual.filter((v) => name(v.name) === name(a.name));
    if (found.length !== 1) return false;
    const v = found[0];
    if (a.id && v.id !== a.id) return false;
    return variant
      ? v.option === a.option
      : Boolean(v.variation) === Boolean(a.variation) &&
          JSON.stringify([...(v.options ?? [])].sort()) === JSON.stringify([...a.options].sort());
  });
}
export async function groupDefinition(c: PoolClient, p: any, axes: string[]) {
  ensure(
    p.kind === 'group' && axes.length > 0,
    422,
    'Wybierz grupę i co najmniej jeden parametr wariantowy',
  );
  ensure(new Set(axes.map(name)).size === axes.length, 422, 'Powtórzony parametr wariantowy');
  // A deleted variant (225) is not part of the offer group.
  const deletions = await productDeletionsAvailable(c);
  const variants = (
    await c.query(
      `SELECT id,sku,version,attributes,active FROM products WHERE parent_id=$1 AND ${productNotDeletedSQL(deletions, 'products')} ORDER BY id`,
      [p.id],
    )
  ).rows;
  ensure(variants.length > 0, 422, 'Grupa nie ma wariantów');
  const seen = new Set<string>();
  const options = new Map(axes.map((a) => [a, new Set<string>()]));
  for (const v of variants) {
    const tuple = axes.map((a) => v.attributes[a]);
    ensure(
      tuple.every((v) => typeof v === 'string' && v.trim() === v && v.length > 0),
      422,
      `Wariant ${v.sku} wymaga jednoznacznych wartości parametrów grupy`,
    );
    const key = JSON.stringify(tuple);
    ensure(
      !seen.has(key),
      422,
      'Warianty mają tę samą kombinację parametrów; dodaj parametr rozróżniający',
    );
    seen.add(key);
    axes.forEach((a, i) => options.get(a)!.add(tuple[i]));
  }
  const attributes = [
    ...axes.map((a) => ({
      name: a,
      visible: true,
      variation: true,
      options: [...options.get(a)!].sort(),
    })),
    ...Object.entries(p.attributes)
      .filter(([a]) => !axes.some((axis) => name(axis) === name(a)))
      .map(([a, value]) => ({
        name: a,
        visible: true,
        variation: false,
        options: [String(value)],
      })),
  ];
  ensure(
    new Set(attributes.map((a) => name(a.name))).size === attributes.length,
    422,
    'Nazwy parametrów muszą być jednoznaczne',
  );
  return { attributes, variants };
}
export async function variantParent(c: PoolClient, p: any) {
  ensure(
    p.kind === 'variant' && p.parent_id,
    422,
    'Tworzenie wariantu wymaga lokalnego wariantu z grupą',
  );
  const group = (
    await c.query("SELECT id,sku,version,active FROM products WHERE id=$1 AND kind='group'", [
      p.parent_id,
    ])
  ).rows[0];
  ensure(group, 422, 'Nie znaleziono lokalnej grupy');
  return group;
}
export function validateParent(remote: any, local: any, attributes: Record<string, string>) {
  ensure(
    remote?.type === 'variable' && remote.sku === local.sku,
    422,
    'Rodzic WooCommerce musi odpowiadać lokalnej grupie i jej SKU',
  );
  const axes = (remote.attributes ?? []).filter((a: any) => a.variation);
  ensure(axes.length > 0, 422, 'Grupa WooCommerce nie ma parametrów wariantowych');
  ensure(
    new Set(axes.map((a: any) => name(a.name))).size === axes.length,
    422,
    'Grupa WooCommerce ma powtórzone parametry wariantowe',
  );
  const result = axes.map((a: any) => {
    const entries = Object.entries(attributes).filter(([k]) => name(k) === name(a.name));
    ensure(
      entries.length === 1 && a.options?.includes(entries[0][1]),
      422,
      `Wariant wymaga wartości parametru ${String(a.name).slice(0, 80)} dostępnej w grupie WooCommerce`,
    );
    return {
      ...(Number.isSafeInteger(a.id) && a.id > 0 ? { id: a.id } : {}),
      name: a.name,
      option: entries[0][1],
    };
  });
  return result;
}
export const parentSnapshot = (r: any) => ({
  id: String(r.id),
  sku: r.sku,
  type: r.type,
  status: r.status,
  attributes: r.attributes ?? [],
});
