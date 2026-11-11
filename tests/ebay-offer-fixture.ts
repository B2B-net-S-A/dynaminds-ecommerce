import assert from 'node:assert/strict';
import { demoEbayCatalog } from '../server/ebay-example';
import {
  ebayBase,
  EBAY_READ_SCOPE,
  EBAY_INVENTORY_WRITE_SCOPE,
  EBAY_TRADING_SCOPE,
} from '../server/ebay';
import type { Transport } from '../server/integrations';
export function ebayOfferFixture() {
  const d = structuredClone(demoEbayCatalog()[0]);
  const { sku, locale, inventoryItemGroupKeys, ...inventory } = d.item as any;
  const offers: any[] = [
    ...d.offers,
    {
      ...structuredClone(d.offers[0]),
      offerId: 'OFFER-UK',
      marketplaceId: 'EBAY_GB',
      availableQuantity: 5,
      pricingSummary: { price: { value: '25.00', currency: 'GBP' } },
    },
  ];
  const state = {
    token: 0,
    applicationToken: 0,
    scope: EBAY_READ_SCOPE + ' ' + EBAY_INVENTORY_WRITE_SCOPE,
    result: 'normal',
    retryAfter: '0',
    inventoryExists: true,
    inventoryResult: 'normal',
    offerResult: 'normal',
    afterInventoryWrite: undefined as (() => Promise<void>) | undefined,
    unauthorizedOnce: false,
    hook: undefined as ((url: URL, method: string) => Promise<void>) | undefined,
    afterWrite: undefined as (() => Promise<void>) | undefined,
    edit: undefined as ((url: URL, value: any) => void) | undefined,
  };
  const calls: { url: string; method: string; payload?: any }[] = [];
  const transport: Transport = async (url, init) => {
    const u = new URL(url),
      method = String(init.method),
      payload = init.body
        ? JSON.parse(
            method === 'POST' && (u.pathname.includes('oauth') || u.pathname === '/ws/api.dll')
              ? '{}'
              : String(init.body),
          )
        : undefined;
    calls.push({ url, method, payload });
    assert.equal(u.origin, ebayBase('sandbox'));
    assert.equal(init.redirect, 'error');
    assert(init.signal);
    if (u.pathname === '/identity/v1/oauth2/token') {
      assert.equal(method, 'POST');
      if (new URLSearchParams(init.body as string).get('grant_type') === 'client_credentials') {
        assert.equal(new URLSearchParams(init.body as string).get('scope'), EBAY_TRADING_SCOPE);
        return Response.json({
          access_token: 'APP-TOKEN-' + ++state.applicationToken,
          expires_in: 7200,
          token_type: 'Application Access Token',
        });
      }
      if (new URLSearchParams(init.body as string).get('scope') === EBAY_TRADING_SCOPE)
        return Response.json({
          access_token: 'EBAY-IDENTITY',
          expires_in: 7200,
          token_type: 'User Access Token',
        });
      assert.equal(new URLSearchParams(init.body as string).get('scope'), state.scope);
      return Response.json({
        access_token: 'EBAY-OFFERS-' + ++state.token,
        expires_in: 7200,
        token_type: 'User Access Token',
      });
    }
    if (u.pathname === '/ws/api.dll') {
      assert.equal(new Headers(init.headers).get('X-EBAY-API-IAF-TOKEN'), 'EBAY-IDENTITY');
      return new Response(
        '<GetUserResponse xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>Success</Ack><User><EIASToken>QA-PUBLICATION-STABLE</EIASToken><UserID>QA-Seller</UserID></User></GetUserResponse>',
      );
    }
    assert.equal(
      new Headers(init.headers).get('authorization'),
      u.pathname.startsWith('/commerce/taxonomy/')
        ? 'Bearer APP-TOKEN-' + state.applicationToken
        : 'Bearer EBAY-OFFERS-' + state.token,
    );
    await state.hook?.(u, method);
    let metadata: any;
    if (u.pathname === '/sell/inventory/v1/location') {
      metadata = {
        locations: [
          {
            merchantLocationKey: 'QA-LOCATION',
            name: 'Warehouse QA',
            merchantLocationStatus: 'ENABLED',
            location: { address: { country: 'DE', postalCode: '10115' } },
          },
        ],
        total: 1,
        limit: 25,
        offset: 0,
      };
    } else if (u.pathname.startsWith('/sell/account/v1/')) {
      assert.equal(new Headers(init.headers).get('content-language'), 'de-DE');
      const kind = u.pathname.split('/')[4].replace('_policy', ''),
        ids: any = { payment: '1', return: '2', fulfillment: '3' };
      const row = {
        [kind + 'PolicyId']: ids[kind],
        marketplaceId: 'EBAY_DE',
        name: 'QA ' + kind,
        categoryTypes: [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES' }],
      };
      metadata =
        u.pathname.split('/').length === 5 ? { [kind + 'Policies']: [row], total: 1 } : row;
    } else if (u.pathname.startsWith('/commerce/taxonomy/v1/')) {
      const tree = { categoryTreeId: '77', categoryTreeVersion: 'QA-V1' },
        category = { categoryId: '123', categoryName: 'QA accessories' };
      if (u.pathname.endsWith('get_default_category_tree_id')) {
        assert.equal(u.searchParams.get('marketplace_id'), 'EBAY_DE');
        metadata = tree;
      } else if (u.pathname.endsWith('get_category_suggestions'))
        metadata = {
          ...tree,
          categorySuggestions: [
            {
              category,
              categoryTreeNodeAncestors: [
                { categoryId: '10', categoryName: 'QA root', categoryTreeNodeLevel: 1 },
              ],
            },
          ],
        };
      else if (u.pathname.endsWith('get_category_subtree'))
        metadata = { ...tree, categorySubtreeNode: { category, leafCategoryTreeNode: true } };
      else if (u.pathname.endsWith('get_item_aspects_for_category'))
        metadata = {
          aspects: [
            {
              localizedAspectName: 'Brand',
              aspectConstraint: {
                aspectRequired: true,
                aspectMode: 'FREE_TEXT',
                itemToAspectCardinality: 'SINGLE',
                aspectMaxLength: 20,
              },
            },
            {
              localizedAspectName: 'Color',
              aspectConstraint: {
                aspectRequired: true,
                aspectMode: 'SELECTION_ONLY',
                itemToAspectCardinality: 'SINGLE',
              },
              aspectValues: [
                { localizedValue: 'Black' },
                {
                  localizedValue: 'White',
                  valueConstraints: [
                    {
                      applicableForLocalizedAspectName: 'Brand',
                      applicableForLocalizedAspectValues: ['White brand'],
                    },
                  ],
                },
              ],
            },
          ],
        };
      else assert.fail('Unknown Taxonomy request');
    }
    if (metadata) {
      assert.equal(method, 'GET');
      state.edit?.(u, metadata);
      return Response.json(metadata);
    }

    if (/^\/sell\/inventory\/v1\/offer\/[^/]+\/publish$/.test(u.pathname)) {
      assert.equal(method, 'POST');
      assert.equal(init.body, undefined);
      const o = offers.find((x) => x.offerId === decodeURIComponent(u.pathname.split('/').at(-2)!));
      assert(o);
      if (['reject', '401', '429', '503'].includes(state.result))
        return Response.json(
          { errors: [{ errorId: 25759 }] },
          {
            status: state.result === 'reject' ? 400 : Number(state.result),
            headers: { 'retry-after': state.retryAfter },
          },
        );
      o.status = 'PUBLISHED';
      o.listing = { listingId: 'QA-LISTING-067', listingStatus: 'ACTIVE' };
      await state.afterWrite?.();
      if (state.result === 'lost') throw new Error('FIXTURE_LOST_RESPONSE');
      return Response.json({ listingId: o.listing.listingId });
    }
    if (u.pathname === '/sell/inventory/v1/bulk_update_price_quantity') {
      assert.equal(method, 'POST');
      assert.equal(new Headers(init.headers).get('content-type'), 'application/json');
      assert.equal(payload.requests.length, 1);
      const r = payload.requests[0];
      assert.equal(r.sku, sku);
      assert.equal(r.offers.length, 1);
      const fields = r.offers[0],
        o = offers.find((x) => x.offerId === fields.offerId);
      assert(o);
      if (state.result === 'reject')
        return Response.json({ errors: [{ errorId: 25759 }] }, { status: 400 });
      if (r.shipToLocationAvailability)
        inventory.availability.shipToLocationAvailability.quantity =
          r.shipToLocationAvailability.quantity;
      if (state.result !== 'partial') {
        if (fields.availableQuantity !== undefined) o.availableQuantity = fields.availableQuantity;
        if (fields.price) o.pricingSummary.price = fields.price;
      }
      await state.afterWrite?.();
      if (state.result === 'lost') throw new Error('FIXTURE_LOST_RESPONSE');
      const responses = [
        { sku, offerId: fields.offerId, statusCode: state.result === 'partial' ? 400 : 200 },
      ];
      return Response.json(
        { responses },
        { status: ['partial', '207'].includes(state.result) ? 207 : 200 },
      );
    }
    if (
      method === 'PUT' &&
      u.pathname === '/sell/inventory/v1/inventory_item/' + encodeURIComponent(sku)
    ) {
      assert.equal(new Headers(init.headers).get('content-type'), 'application/json');
      assert(new Headers(init.headers).get('content-language'));
      if (['reject', '401', '429', '503'].includes(state.inventoryResult))
        return Response.json(
          { errors: [{ errorId: 25759 }] },
          {
            status: state.inventoryResult === 'reject' ? 400 : Number(state.inventoryResult),
            headers: { 'retry-after': state.retryAfter },
          },
        );
      for (const key of Object.keys(inventory)) delete inventory[key];
      Object.assign(inventory, structuredClone(payload));
      state.inventoryExists = true;
      await state.afterInventoryWrite?.();
      if (state.inventoryResult === 'lost') throw new Error('FIXTURE_LOST_INVENTORY_RESPONSE');
      return new Response(null, { status: 204 });
    }
    if (method === 'POST' && u.pathname === '/sell/inventory/v1/offer') {
      assert.equal(new Headers(init.headers).get('content-type'), 'application/json');
      assert(new Headers(init.headers).get('content-language'));
      if (['reject', '401', '429', '503'].includes(state.offerResult))
        return Response.json(
          { errors: [{ errorId: 25759 }] },
          {
            status: state.offerResult === 'reject' ? 400 : Number(state.offerResult),
            headers: { 'retry-after': state.retryAfter },
          },
        );
      const offer = {
        ...structuredClone(payload),
        offerId: 'QA-CREATED-068',
        status: 'UNPUBLISHED',
      };
      offers.push(offer);
      await state.afterWrite?.();
      if (state.offerResult === 'lost') throw new Error('FIXTURE_LOST_OFFER_RESPONSE');
      return Response.json({ offerId: offer.offerId }, { status: 201 });
    }
    assert.equal(method, 'GET');
    if (state.unauthorizedOnce) {
      state.unauthorizedOnce = false;
      return Response.json({ errors: [{ errorId: 1001 }] }, { status: 401 });
    }
    let value: any;
    if (u.pathname === '/sell/inventory/v1/inventory_item/' + encodeURIComponent(sku)) {
      if (!state.inventoryExists)
        return Response.json({ errors: [{ errorId: 25710 }] }, { status: 404 });
      value = inventory;
    } else if (u.pathname.startsWith('/sell/inventory/v1/offer/'))
      value = offers.find((x) => x.offerId === decodeURIComponent(u.pathname.split('/').at(-1)!));
    else if (u.pathname.startsWith('/sell/inventory/v1/location/'))
      value = {
        merchantLocationKey: 'QA-LOCATION',
        merchantLocationStatus: 'ENABLED',
        location: { address: { country: 'DE', postalCode: '10115' } },
      };
    else {
      assert.equal(u.pathname, '/sell/inventory/v1/offer');
      assert.equal(u.searchParams.get('sku'), sku);
      assert.equal(
        u.searchParams.get('marketplace_id'),
        null,
        'Stock scope must include all markets',
      );
      assert.equal(u.searchParams.get('limit'), '25');
      const offset = Number(u.searchParams.get('offset'));
      const next = new URL(u);
      next.searchParams.set('offset', String(offset + 1));
      const rows = offers.slice(offset * 25, (offset + 1) * 25);
      value = {
        total: offers.length,
        limit: 25,
        size: rows.length,
        offers: rows,
        ...((offset + 1) * 25 < offers.length ? { next: next.toString() } : {}),
      };
    }
    value = structuredClone(value);
    state.edit?.(u, value);
    return Response.json(value);
  };
  return { sku, inventory, offers, state, calls, transport };
}
