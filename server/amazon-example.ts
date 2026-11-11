export function demoAmazonOrder() {
  const money = (amount: string) => ({ amount, currencyCode: 'PLN' });
  return {
    id: '123-1234567-1234567',
    orderId: '123-1234567-1234567',
    createdTime: '2026-10-01T10:00:00Z',
    lastUpdatedTime: '2026-10-01T10:00:00Z',
    salesChannel: {
      channelName: 'AMAZON',
      marketplaceId: 'A1C3SOZRARQ6R3',
      marketplaceName: 'Amazon.pl',
    },
    buyer: { buyerName: 'Jan Demo' },
    recipient: {
      deliveryAddress: {
        name: 'Jan Demo',
        addressLine1: 'Testowa 1',
        city: 'Warszawa',
        postalCode: '00-001',
        countryCode: 'PL',
      },
    },
    proceeds: { grandTotal: money('246.90') },
    fulfillment: { fulfilledBy: 'MERCHANT', fulfillmentStatus: 'UNSHIPPED' },
    payment: {
      paymentExecutions: [{ paymentMethod: 'CreditCard', paymentAmount: money('246.90') }],
    },
    orderItems: [
      {
        orderItemId: '12345678901',
        quantityOrdered: 2,
        product: {
          sellerSku: 'AMAZON-DEMO-SKU',
          asin: 'B000DEMO01',
          title: 'Produkt demonstracyjny Amazon',
        },
        fulfillment: { quantityFulfilled: 0, quantityUnfulfilled: 2 },
        proceeds: {
          proceedsTotal: money('246.90'),
          breakdowns: [
            { type: 'ITEM', subtotal: money('200.00') },
            { type: 'SHIPPING', subtotal: money('0.73') },
            {
              type: 'TAX',
              subtotal: money('46.17'),
              detailedBreakdowns: [
                { subtype: 'ITEM', value: money('46.00') },
                { subtype: 'SHIPPING', value: money('0.17') },
              ],
            },
          ],
        },
      },
    ],
  };
}
export function demoAmazonCatalog() {
  const market = 'A1C3SOZRARQ6R3';
  const item = (sku: string, name: string, rel: any[] = [], price = '123.45', quantity = 8) => ({
    sku,
    summaries: [
      {
        marketplaceId: market,
        asin: 'B0DEMO0740',
        productType: 'SHIRT',
        itemName: name,
        status: ['BUYABLE', 'DISCOVERABLE'],
        conditionType: 'new_new',
        createdDate: '2026-01-01T00:00:00Z',
        lastUpdatedDate: '2026-10-04T00:00:00Z',
      },
    ],
    attributes: {
      color: [{ value: sku.endsWith('BLUE') ? 'Niebieski' : 'Czarny', marketplace_id: market }],
    },
    offers: [
      { marketplaceId: market, offerType: 'B2C', price: { currencyCode: 'PLN', amount: price } },
    ],
    fulfillmentAvailability: [{ fulfillmentChannelCode: 'DEFAULT', quantity }],
    relationships: [{ marketplaceId: market, relationships: rel }],
  });
  const parent = 'AMAZON-DEMO-PARENT',
    children = ['AMAZON-DEMO-SKU', 'AMAZON-DEMO-BLUE'];
  return [
    {
      ...item(parent, 'Koszulka Amazon — rodzina wariantów', [
        { type: 'VARIATION', childSkus: children },
      ]),
      offers: [],
      fulfillmentAvailability: [],
    },
    ...children.map((sku) =>
      item(sku, `Koszulka Amazon — ${sku.endsWith('BLUE') ? 'niebieska' : 'czarna'}`, [
        { type: 'VARIATION', parentSkus: [parent] },
      ]),
    ),
    item('AMAZON-DEMO-OTHER', 'Torba Amazon — produkt prosty', [], '49.90', 15),
  ];
}
