import { ensure, Problem } from './errors';
import { PP_DUPLICATE, PP_UNCERTAIN, type PocztaPolska, type PocztaPolskaCreated } from './carrier-pocztapolska';
import { pocztaPolskaBodyHash, type PocztaPolskaShipment } from './carrier-pocztapolska-values';

// Exactly-once creation of one eNadawca parcel. The guid (from the plan id) is the
// idempotency key. The journal is an interface so that wiring can back it with
// shipping_plans.phase (create_started / numbers_ready / rejected) under the plan lock;
// tests and the local simulation use the in-memory journal below.

export type PocztaPolskaCreateState = 'started' | 'created' | 'rejected' | 'uncertain' | 'absent';
export type PocztaPolskaCreateRecord = {
  key: string;
  body_hash: string;
  state: PocztaPolskaCreateState;
  tracking_number: string | null;
  error: string | null;
};
export interface PocztaPolskaJournal {
  get(key: string): Promise<PocztaPolskaCreateRecord | undefined>;
  /** Atomic insert-if-absent; false when another attempt already holds the key. */
  insert(rec: PocztaPolskaCreateRecord): Promise<boolean>;
  /** Compare-and-set on state; false when the record moved meanwhile. */
  replace(key: string, from: PocztaPolskaCreateState, rec: PocztaPolskaCreateRecord): Promise<boolean>;
}

export function memoryPocztaPolskaJournal(): PocztaPolskaJournal & {
  records: Map<string, PocztaPolskaCreateRecord>;
} {
  const records = new Map<string, PocztaPolskaCreateRecord>();
  return {
    records,
    async get(key) {
      const r = records.get(key);
      return r && { ...r };
    },
    async insert(rec) {
      if (records.has(rec.key)) return false;
      records.set(rec.key, { ...rec });
      return true;
    },
    async replace(key, from, rec) {
      if (records.get(key)?.state !== from) return false;
      records.set(key, { ...rec });
      return true;
    },
  };
}

export type PocztaPolskaCreateResult = PocztaPolskaCreated & {
  /** true when answered from the journal or recovered by reading the buffer, without a new addShipment. */
  replayed: boolean;
};
type CreateOptions = { bufferId?: string; retryAfterAbsent?: boolean };

const busy = () =>
  new Problem(409, 'Tworzenie tej przesyłki Poczty Polskiej już trwa', 'PP_CREATE_IN_PROGRESS');

/**
 * Creates the parcel at most once per guid:
 * - same key + same body after success → stored result, no network;
 * - same key + different body → 409;
 * - lost answer (uncertain) → reconcile by reading the buffer, never by repeating addShipment;
 * - read finds nothing → 'absent', a new addShipment only with retryAfterAbsent (explicit operator step).
 */
export async function createPocztaPolskaShipment(
  client: PocztaPolska,
  shipment: PocztaPolskaShipment,
  journal: PocztaPolskaJournal,
  o: CreateOptions = {},
): Promise<PocztaPolskaCreateResult> {
  const key = shipment.guid,
    body_hash = pocztaPolskaBodyHash(shipment);
  const record = (state: PocztaPolskaCreateState, patch: Partial<PocztaPolskaCreateRecord> = {}) => ({
    key,
    body_hash,
    state,
    tracking_number: null,
    error: null,
    ...patch,
  });
  const existing = await journal.get(key);
  ensure(
    !existing || existing.body_hash === body_hash,
    409,
    'Klucz idempotencji przesyłki użyto z innymi danymi; utwórz nowy plan',
  );
  if (existing?.state === 'created')
    return { guid: key, tracking_number: existing.tracking_number!, replayed: true };
  if (existing?.state === 'rejected')
    throw new Problem(422, existing.error ?? 'Poczta Polska odrzuciła tę przesyłkę', 'PP_REJECTED');
  if (existing?.state === 'started' || existing?.state === 'uncertain')
    return reconcile(client, journal, existing, record, o.bufferId);
  if (existing?.state === 'absent') {
    ensure(o.retryAfterAbsent, 409, 'Przesyłki nie ma w buforze eNadawcy; potwierdź ponowne utworzenie');
    if (!(await journal.replace(key, 'absent', record('started')))) throw busy();
  } else if (!(await journal.insert(record('started')))) throw busy();

  let created: PocztaPolskaCreated;
  try {
    created = await client.create(shipment, o.bufferId);
  } catch (e) {
    if (e instanceof Problem && (e.code === PP_UNCERTAIN || e.code === PP_DUPLICATE)) {
      await journal.replace(key, 'started', record('uncertain', { error: e.message }));
      // A duplicate guid proves the parcel exists: read it back right away.
      if (e.code === PP_DUPLICATE)
        return reconcile(client, journal, record('uncertain'), record, o.bufferId);
      throw e;
    }
    if (e instanceof Problem && e.status >= 400 && e.status < 500 && e.status !== 401) {
      await journal.replace(key, 'started', record('rejected', { error: e.message }));
      throw e;
    }
    // Auth or other definite refusal before acceptance: nothing created, the key can be retried.
    await journal.replace(key, 'started', record('absent', { error: e instanceof Error ? e.message : null }));
    throw e;
  }
  ensure(
    await journal.replace(key, 'started', record('created', { tracking_number: created.tracking_number })),
    409,
    'Stan tworzenia przesyłki zmienił się w trakcie',
  );
  return { ...created, replayed: false };
}

async function reconcile(
  client: PocztaPolska,
  journal: PocztaPolskaJournal,
  existing: PocztaPolskaCreateRecord,
  record: (s: PocztaPolskaCreateState, p?: Partial<PocztaPolskaCreateRecord>) => PocztaPolskaCreateRecord,
  bufferId?: string,
): Promise<PocztaPolskaCreateResult> {
  const found = await client.findShipment(existing.key, bufferId);
  if (found) {
    ensure(
      await journal.replace(existing.key, existing.state, record('created', { tracking_number: found.tracking_number })),
      409,
      'Stan tworzenia przesyłki zmienił się w trakcie',
    );
    return { ...found, replayed: true };
  }
  await journal.replace(existing.key, existing.state, record('absent'));
  throw new Problem(
    409,
    'Przesyłki nie ma w buforze eNadawcy po niepewnym wyniku; sprawdź eNadawcę i potwierdź ponowne utworzenie',
    'PP_RECONCILE_ABSENT',
  );
}
