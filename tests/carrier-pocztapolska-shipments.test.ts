import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Problem } from '../server/errors';
import { PocztaPolska } from '../server/carrier-pocztapolska';
import { pocztaPolskaInput, pocztaPolskaShipment } from '../server/carrier-pocztapolska-values';
import { createPocztaPolskaShipment, memoryPocztaPolskaJournal } from '../server/carrier-pocztapolska-shipments';
import { pocztaPolskaFake } from '../server/carrier-pocztapolska-fake';

// Exactly-once creation against the SYNTHETIC local fake; no network.
const address = {
  name: 'Jan Kowalski',
  address: 'Długa 5/3',
  city: 'Kraków',
  postalCode: '30-001',
  phone: '+48600100200',
  email: 'jan@example.test',
};
const shipment = (planId = randomUUID(), content = 'Odzież') =>
  pocztaPolskaShipment(
    planId,
    pocztaPolskaInput.parse({
      channel_id: randomUUID(),
      service: 'pocztex_kurier',
      sender: { ...address, name: 'Sklep DYNA' },
      receiver: address,
      weight: 2,
      dimensions: { length: 30, width: 20, height: 10 },
      content,
    }),
  );
function setup() {
  const fake = pocztaPolskaFake();
  const client = new PocztaPolska('sandbox', fake.settings, fake.credentials, fake.transport, { sleep: async () => {} });
  const adds = () => fake.calls.filter((c) => c === 'addShipment').length;
  return { fake, client, journal: memoryPocztaPolskaJournal(), adds };
}
const problem = (status: number, code?: string) => (e: unknown) =>
  e instanceof Problem && e.status === status && (!code || e.code === code);

test('duplicate creation is prevented: same key replays the stored result without a request', async () => {
  const { client, journal, adds } = setup();
  const s = shipment();
  const first = await createPocztaPolskaShipment(client, s, journal);
  assert.equal(first.replayed, false);
  const again = await createPocztaPolskaShipment(client, s, journal);
  assert.deepEqual(again, { ...first, replayed: true });
  assert.equal(adds(), 1);
  assert.equal(journal.records.get(s.guid)!.state, 'created');
});

test('same key with a different body is refused', async () => {
  const { client, journal } = setup();
  const id = randomUUID();
  await createPocztaPolskaShipment(client, shipment(id), journal);
  await assert.rejects(createPocztaPolskaShipment(client, shipment(id, 'Inna zawartość'), journal), problem(409));
});

test('concurrent attempt on a started key is refused, not sent twice', async () => {
  const { client, journal, adds } = setup();
  const s = shipment();
  const [a, b] = await Promise.allSettled([
    createPocztaPolskaShipment(client, s, journal),
    createPocztaPolskaShipment(client, s, journal),
  ]);
  assert.equal(adds(), 1);
  const ok = [a, b].filter((r) => r.status === 'fulfilled');
  assert.equal(ok.length >= 1, true);
  for (const r of [a, b]) if (r.status === 'rejected') assert(problem(409)(r.reason) || problem(409, 'PP_CREATE_IN_PROGRESS')(r.reason));
});

test('ACK loss: the parcel exists, recovery reads the buffer and never repeats addShipment', async () => {
  const { fake, client, journal, adds } = setup();
  const s = shipment();
  fake.fail({ kind: 'lose_answer' });
  await assert.rejects(createPocztaPolskaShipment(client, s, journal), problem(502, 'PP_OUTCOME_UNCERTAIN'));
  assert.equal(journal.records.get(s.guid)!.state, 'uncertain');
  const recovered = await createPocztaPolskaShipment(client, s, journal);
  assert.equal(recovered.replayed, true);
  assert.equal(recovered.tracking_number, fake.buffer.get(s.guid)!.number);
  assert.equal(adds(), 1);
  assert.equal(fake.buffer.size, 1);
});

test('uncertain without effect: read finds nothing → absent; re-create only on explicit confirmation', async () => {
  const { fake, client, journal, adds } = setup();
  const s = shipment();
  fake.fail({ kind: 'status', status: 504 });
  await assert.rejects(createPocztaPolskaShipment(client, s, journal), problem(504, 'PP_OUTCOME_UNCERTAIN'));
  await assert.rejects(createPocztaPolskaShipment(client, s, journal), problem(409, 'PP_RECONCILE_ABSENT'));
  assert.equal(journal.records.get(s.guid)!.state, 'absent');
  await assert.rejects(createPocztaPolskaShipment(client, s, journal), problem(409));
  const r = await createPocztaPolskaShipment(client, s, journal, { retryAfterAbsent: true });
  assert.equal(r.replayed, false);
  assert.equal(adds(), 1);
});

test('duplicate guid reported by the provider is reconciled by reading, not treated as a new parcel', async () => {
  const { fake, client, adds } = setup();
  const s = shipment();
  await client.create(s); // created earlier by an attempt whose journal entry was lost
  const r = await createPocztaPolskaShipment(client, s, memoryPocztaPolskaJournal());
  assert.equal(r.replayed, true);
  assert.equal(r.tracking_number, fake.buffer.get(s.guid)!.number);
  assert.equal(adds(), 2);
  assert.equal(fake.buffer.size, 1);
});

test('definite provider rejection is stored and not retried; auth failure leaves the key retryable', async () => {
  const fake = pocztaPolskaFake({ reject: () => ['Brak numeru domu'] });
  const client = new PocztaPolska('sandbox', fake.settings, fake.credentials, fake.transport, { sleep: async () => {} });
  const journal = memoryPocztaPolskaJournal();
  const s = shipment();
  await assert.rejects(createPocztaPolskaShipment(client, s, journal), problem(422, 'PP_REJECTED'));
  await assert.rejects(createPocztaPolskaShipment(client, s, journal), /Brak numeru domu/);
  assert.equal(fake.calls.filter((c) => c === 'addShipment').length, 1);

  const ok = setup();
  const wrong = new PocztaPolska('sandbox', ok.fake.settings, { username: 'fixture-user', password: 'x' }, ok.fake.transport);
  const t = shipment();
  await assert.rejects(createPocztaPolskaShipment(wrong, t, ok.journal), problem(401));
  assert.equal(ok.journal.records.get(t.guid)!.state, 'absent');
  assert.equal((await createPocztaPolskaShipment(ok.client, t, ok.journal, { retryAfterAbsent: true })).replayed, false);
});
