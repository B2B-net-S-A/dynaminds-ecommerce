import type { PayuCurrency, PayuOrderStatus } from './payment-payu-values';
// payout.reconcile: match PayU settlement/payment-import rows to local payment sessions. Pure function;
// classifications reuse the payment_import_rows vocabulary (server/077_payment_imports.sql) so wiring can
// feed the existing import preview. A row becomes 'ready' only for exactly one COMPLETED session with
// the same amount and currency; everything else stays out of settlement.
export interface PayuSettlementRow {
  position: number;
  reference: string; // PayU orderId or our extOrderId, as the report carries it (unverified column)
  amount: number; // grosze, gross
  fee: number; // grosze, PayU commission
  currency: PayuCurrency;
}
export interface PayuSettlementSession {
  sessionId: string;
  orderId: string | null;
  extOrderId: string;
  amount: number;
  currency: PayuCurrency;
  status: PayuOrderStatus;
  settled: boolean;
}
export type PayuMatchClass = 'ready' | 'duplicate' | 'invalid' | 'unmatched' | 'ambiguous' | 'conflict';
export interface PayuMatch {
  position: number;
  classification: PayuMatchClass;
  sessionId: string | null;
  net: number | null;
  issue: string | null;
}
export function matchPayuSettlement(rows: readonly PayuSettlementRow[], sessions: readonly PayuSettlementSession[]): PayuMatch[] {
  const claimed = new Set<string>();
  return rows.map((row) => {
    const out = (classification: PayuMatchClass, issue: string | null, s: PayuSettlementSession | null = null): PayuMatch => ({
      position: row.position,
      classification,
      sessionId: s?.sessionId ?? null,
      net: classification === 'ready' ? row.amount - row.fee : null,
      issue,
    });
    if (!Number.isSafeInteger(row.amount) || row.amount <= 0 || !Number.isSafeInteger(row.fee) || row.fee < 0 || row.fee > row.amount)
      return out('invalid', 'Nieprawidłowa kwota lub prowizja');
    const hits = sessions.filter((s) => s.orderId === row.reference || s.extOrderId === row.reference);
    if (hits.length === 0) return out('unmatched', 'Brak płatności PayU o tym identyfikatorze');
    if (hits.length > 1) return out('ambiguous', 'Identyfikator pasuje do kilku płatności');
    const [s] = hits;
    if (s.settled || claimed.has(s.sessionId)) return out('duplicate', 'Płatność jest już rozliczona', s);
    if (s.amount !== row.amount || s.currency !== row.currency) return out('conflict', 'Kwota lub waluta różni się od płatności', s);
    if (s.status !== 'COMPLETED') return out('conflict', 'Płatność nie jest zakończona w PayU', s);
    claimed.add(s.sessionId);
    return out('ready', null, s);
  });
}
