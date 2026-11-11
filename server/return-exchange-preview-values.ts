import { ensure } from './errors';

/** Project only public stock facts from the already locked, hash-bound SQL frame.
 * No second stock query: both warehouse epochs belong to the original consent. */
export function completeReturnExchangePreview(frame: any) {
  const preview = frame.public;
  const warehouse = frame.snapshot.return.warehouse_id;
  if (warehouse === preview.warehouse_id)
    return { ...preview, return_warehouse_id: warehouse, return_stock: [] };
  const quantities = new Map<string, number>();
  for (const row of preview.rows)
    for (const component of row.components)
      quantities.set(
        component.product_id,
        (quantities.get(component.product_id) ?? 0) + row.restocked * component.quantity,
      );
  const stock = frame.snapshot.physical.stock;
  const positions = [...quantities]
    .filter(([, quantity]) => quantity > 0)
    .map(([productId, returned]) => {
      const matching = preview.stock.filter((position: any) => position.product_id === productId);
      ensure(
        matching.length === 1,
        409,
        'Brak pełnego podglądu produktu przyjmowanego do magazynu',
      );
      const position = matching[0];
      const original = stock.find(
        (p: any) => p.warehouse_id === warehouse && p.product_id === productId,
      );
      const onHand = original?.on_hand ?? 0;
      const reserved = original?.reserved ?? 0;
      ensure(
        [onHand, reserved, returned].every(Number.isSafeInteger) &&
          onHand >= reserved &&
          reserved >= 0 &&
          returned >= 0,
        409,
        'Nie można potwierdzić stanu magazynu przyjęcia reklamacji',
      );
      ensure(
        onHand + returned <= 2147483647,
        409,
        'Przyjęcie przekroczyłoby limit stanu magazynowego',
      );
      return {
        product_id: position.product_id,
        sku: position.sku,
        on_hand: onHand,
        reserved,
        available: onHand - reserved,
        version: original?.version ?? null,
        return_quantity: returned,
        replacement_quantity: 0,
        after_on_hand: onHand + returned,
        after_reserved: reserved,
        after_available: onHand - reserved + returned,
      };
    });
  return { ...preview, return_warehouse_id: warehouse, return_stock: positions };
}
