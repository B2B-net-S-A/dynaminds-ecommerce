-- Migration 264_order_status_labels (client feedback 05.11.2026, registered after 263_manual_off_verdict;
-- docs/order-status-codes.md). Data only: no table, constraint, index, function, trigger or grant changes.
-- The order status codes stay; their labels change: new is "Nieopłacone" (a prepaid order waiting for payment),
-- paid is "Nowe" (ready to fulfil: paid online, cash on delivery or B2B trade credit released). From 264 a
-- cash-on-delivery order is created in paid and a released trade credit moves its order to paid, and new -> picking
-- is refused, so the existing cash-on-delivery and trade-credit orders still in new move to paid here.
-- orders.status keeps its CHECK: the orders table is fingerprinted by the sealed guards (150, 151, 158-160, 169,
-- 173, 178-185), so a new status code is not possible without a new guard generation.
-- Sources merged into another order stay as they are. The order_revision trigger clears the workflow sub-status
-- (it belonged to the new stage) and bumps the version. No status event is written: this is a reclassification.
UPDATE public.orders o SET status='paid',updated_at=clock_timestamp()
WHERE o.status='new'
 AND(o.payment_mode='cod' OR EXISTS(SELECT FROM public.b2b254_trade_charges t WHERE t.tenant_id=o.tenant_id AND t.order_id=o.id))
 AND NOT EXISTS(SELECT FROM public.order_merge_claims m WHERE m.tenant_id=o.tenant_id AND m.source_order_id=o.id);
