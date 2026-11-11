/**
 * Rule barcodes (Uwagi v3 §0): every v2 rule with run.barcode has a printable code 'AR-' + 10 hex characters
 * (server/automation-v2.ts barcodeFor). Scanned in a packing scan field with an order open, it runs that rule
 * for the order instead of counting a product.
 */
export const RULE_BARCODE = /^AR-[0-9A-F]{10}$/i;

export const isRuleBarcode = (value: string): boolean => RULE_BARCODE.test(value.trim());

/** Request body of POST /api/automations/v2/barcode. */
export const ruleBarcodeBody = (value: string, orderId: string) => ({ code: value.trim().toUpperCase(), order: orderId });

/** One-line result for the scan field. */
export function ruleBarcodeText(run: { rule_name?: string; status?: string; reason?: string | null; error?: string | null }): string {
  const name = run.rule_name ? '„' + run.rule_name + '”' : 'akcja';
  if (run.status === 'failed') return `Akcja ${name} nie powiodła się: ${run.error ?? run.reason ?? 'nieznany błąd'}`;
  if (run.status === 'skipped') return `Akcja ${name} pominięta: ${run.reason ?? 'zamówienie nie spełnia warunków'}`;
  if (run.status === 'queued') return `Akcja ${name} czeka na wykonanie.`;
  return `Wykonano akcję ${name}.`;
}
