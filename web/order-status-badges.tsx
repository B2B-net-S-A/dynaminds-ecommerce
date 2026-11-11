/** Order fulfilment stage and payment state badges (Uwagi v3 §1, §7): text label always visible, the
 * semantic colour only as a dot and tint, so the badge still reads for colour-blind people. */
import { fulfilmentLabels, isFulfilmentStage, paymentLabels, type PaymentState } from './order-stage';
import './order-status.css';

type Row = Record<string, any>;

const isPaymentState = (value: string): value is PaymentState =>
  Object.prototype.hasOwnProperty.call(paymentLabels, value);

/** Stage from the order payload; older payloads without fulfilment_stage fall back to orders.status. */
export const stageOf = (o: Row): string => o.fulfilment_stage ?? o.status;

/** Payment state from the payload, else derived like server/order-stage.ts paymentState from the ledger summary. */
export function paymentStateOf(o: Row): PaymentState {
  if (o.payment_state && isPaymentState(o.payment_state)) return o.payment_state;
  const p = o.payment ?? {};
  const net = Number(p.net ?? 0);
  const nominal = Number(p.nominal ?? (p.amount_due != null ? net + Number(p.amount_due) - Number(p.overpayment ?? 0) : o.total ?? 0));
  if (net > nominal) return 'overpaid';
  if (net >= nominal) return 'paid';
  if (o.payment_mode === 'cod') return 'cod';
  return net > 0 ? 'partial' : 'unpaid';
}

export function FulfilmentBadge({ stage }: { stage: string }) {
  if (!isFulfilmentStage(stage)) return <span className="order-badge order-unknown">{stage}</span>;
  return <span className={`order-badge order-stage-${stage}`}>{fulfilmentLabels[stage]}</span>;
}

export function PaymentBadge({ state }: { state: string }) {
  if (!isPaymentState(state)) return <span className="order-badge order-unknown">{state}</span>;
  return <span className={`order-badge order-pay-${state}`}>{paymentLabels[state]}</span>;
}
