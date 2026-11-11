export const demoAllegroOrder = {
  id: 'dynaminds-local-allegro-order',
  revision: 'local-1',
  status: 'READY_FOR_PROCESSING',
  fulfillment: { status: 'NEW' },
  buyer: { email: 'allegro-demo@example.test' },
  payment: { type: 'ONLINE', paidAmount: { amount: '35.00', currency: 'PLN' } },
  delivery: {
    address: {
      firstName: 'Jan',
      lastName: 'Demo',
      street: 'Testowa 1',
      city: 'Warszawa',
      zipCode: '00-001',
      countryCode: 'PL',
    },
    cost: { amount: '5.00', currency: 'PLN' },
  },
  summary: { totalToPay: { amount: '35.00', currency: 'PLN' } },
  lineItems: [
    {
      offer: { id: 'demo-offer-1', name: 'Produkt Allegro DEMO', external: { id: 'DEMO-ALLEGRO' } },
      quantity: 3,
      price: { amount: '10.00', currency: 'PLN' },
    },
  ],
};
