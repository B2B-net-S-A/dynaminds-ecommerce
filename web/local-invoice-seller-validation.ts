/** Input validation mirrors the server; it does not verify VAT registration. */
export function validLocalInvoiceSellerNip(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9]{10}$/.test(value) && value !== '0000000000' &&
    [6, 5, 7, 2, 3, 4, 5, 6, 7].reduce((sum, weight, index) => sum + weight * Number(value[index]), 0) % 11 === Number(value[9]);
}
