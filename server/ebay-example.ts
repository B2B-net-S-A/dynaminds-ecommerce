export function demoEbayOrder() {
  const amount = (value: string) => ({ value, currency: 'PLN' });
  return {
    id: 'DEMO-EBAY-6001',
    orderId: 'DEMO-EBAY-6001',
    creationDate: '2026-10-04T10:00:00.000Z',
    lastModifiedDate: '2026-10-04T10:00:00.000Z',
    _dyna: { field_groups: 'TAX_BREAKDOWN' },
    buyer: { username: 'DEMO-buyer' },
    buyerCheckoutNotes: 'Lokalny przykład eBay — dane syntetyczne, bez żądań do dostawcy.',
    cancelStatus: { cancelState: 'NONE_REQUESTED', cancelRequests: [] },
    orderFulfillmentStatus: 'NOT_STARTED',
    orderPaymentStatus: 'PAID',
    fulfillmentHrefs: [],
    fulfillmentStartInstructions: [
      {
        fulfillmentInstructionsType: 'SHIP_TO',
        shippingStep: {
          shipTo: {
            fullName: 'Jan Demo eBay',
            email: 'ebay@example.test',
            primaryPhone: { phoneNumber: '' },
            contactAddress: {
              addressLine1: 'Testowa 60',
              city: 'Warszawa',
              postalCode: '00-001',
              countryCode: 'PL',
            },
          },
        },
      },
    ],
    lineItems: [
      {
        lineItemId: '6001001',
        legacyItemId: '6001',
        sku: 'EBAY-DEMO-SKU',
        title: 'Produkt eBay DEMO',
        quantity: 2,
        lineItemFulfillmentStatus: 'NOT_STARTED',
        lineItemCost: amount('100.00'),
        discountedLineItemCost: amount('90.01'),
        deliveryCost: { shippingCost: amount('15.00'), discountAmount: amount('5.00') },
        taxes: [],
        refunds: [],
        total: amount('100.01'),
      },
    ],
    pricingSummary: {
      priceSubtotal: amount('100.00'),
      priceDiscount: amount('-9.99'),
      deliveryCost: amount('15.00'),
      deliveryDiscount: amount('-5.00'),
      total: amount('100.01'),
    },
    paymentSummary: {
      payments: [{ paymentMethod: 'EBAY', paymentStatus: 'PAID', amount: amount('100.01') }],
      refunds: [],
      totalDueSeller: amount('100.01'),
    },
  };
}

export function demoEbayCatalog() {
  const group = {
    inventoryItemGroupKey: 'DEMO-EBAY-AURA',
    title: 'Lampa Aura eBay',
    description: 'Lokalny przykład wariantów eBay',
    variantSKUs: ['EBAY-DEMO-BLACK', 'EBAY-DEMO-WHITE'],
    aspects: { Marka: ['DYNAMINDS'] },
    variesBy: { specifications: [{ name: 'Kolor', values: ['Czarny', 'Biały'] }] },
    imageUrls: [],
  };
  return ['EBAY-DEMO-SKU', 'EBAY-DEMO-BLACK', 'EBAY-DEMO-WHITE'].map((sku, n) => ({
    item: {
      sku,
      locale: 'pl_PL',
      condition: 'NEW',
      ...(n ? { inventoryItemGroupKeys: [group.inventoryItemGroupKey] } : {}),
      availability: { shipToLocationAvailability: { quantity: 12 + n } },
      product: {
        title: n ? `Lampa Aura ${n === 1 ? 'czarna' : 'biała'}` : 'Produkt eBay DEMO',
        description: 'Dane syntetyczne; bez połączenia z eBay.',
        ean: [],
        aspects: n ? { Kolor: [n === 1 ? 'Czarny' : 'Biały'] } : { Marka: ['DYNAMINDS'] },
        imageUrls: [],
      },
    },
    group: n ? group : null,
    offers: [
      {
        offerId: 'DEMO-OFFER-' + n,
        sku,
        marketplaceId: 'EBAY_DE',
        format: 'FIXED_PRICE',
        status: 'PUBLISHED',
        pricingSummary: { price: { value: n ? '120.00' : '100.00', currency: 'PLN' } },
        availableQuantity: 12 + n,
        listing: { listingId: 'DEMO-LISTING-' + n, listingStatus: 'ACTIVE' },
      },
    ],
    offers_unavailable: false,
  }));
}
