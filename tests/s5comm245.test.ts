/** Migration 245_s5_comm (prepared as placeholder 253; object names keep that prefix): units without a database.
 * - the manifest row: number, name, file, native_id, contract, exact bytes and sha256, after 244;
 * - the SQL shape: own prefixes only, no sealed-fingerprint name, no foreign key to a table it does not own, no row
 *   written, RLS per tenant on every new table, dyna_app without DELETE and append-only where evidence is kept;
 * - COM-PORTAL-4: default link validity and its input;
 * - COM-005: our own Message-ID in In-Reply-To / References, order numbers in a subject, the match decision;
 * - COM-008: the connector-port input and the inbox labels/thread list rendering.
 * DB flows are in tests/s5comm245.database.test.ts. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { portalExpiry, portalLinkPolicyInput } from '../server/portal-link-policy253';
import { decideMatch, ownMessageIds, subjectOrderTokens, inboundScheduleInput, nextRunAt } from '../server/inbound-auto253';
import { channelIngestInput, channelThreadPatch, CHANNELS } from '../server/channel-inbox253-input';
import { channelLabel, matchLabel, scheduleOutcomeLabel, portalPolicySummary } from '../web/s5comm253-labels';
import { ChannelThreadList } from '../web/channel-inbox253';
import { RELEASE_MIGRATIONS } from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/migration-manifest.mjs';

const file = new URL('../server/245_s5_comm.sql', import.meta.url);
const sql = readFileSync(file, 'utf8');
const code = sql.replace(/--.*$/gm, '');
const TABLES = [
  'portal253_link_policies',
  'inbound253_schedules',
  'inbound253_matches',
  'channel253_connections',
  'channel253_threads',
  'channel253_messages',
];
// Patterns of sealed fingerprints in server/*.sql (LIKE treats _ as any character); a new name must match none.
const SEALED = [
  'catalog_stock_control_%', 'competitor_observation%', 'catalog_stock_legacy_group_%', 'warehouse_wz_issuer_%',
  'catalog_stock_return_%', 'warehouse_automatic_wz_%', 'stocktake_adjustment_%', 'allegro_oauth_recovery_%', 'xml%',
  'return_%', 'email_inbound_%', 'warehouse_inventory_policy_%', 'stock_file_import_%', 'proforma_batch_%',
  'product_catalog_%', 'price_matrix_import_%', 'price_file_import_%', 'packed_label_print_%', 'order_parcel_%',
  'language_file_import_%', 'label_cache_%', 'label_batch_%', 'b2b_dropship_return_%', 'b2b_catalog_scope_%',
  'customer_message_%', 'wz_issuer239_%', 'buyer_available236%', 'verdict241_%', 'ordinary18%', 'payu242_%',
];
const like = (p: string) => new RegExp('^' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/_/g, '.').replace(/%/g, '.*') + '$');

test('245 follows 244 in the release list and pins the exact SQL bytes', () => {
  assert(existsSync(file), 'server/245_s5_comm.sql exists');
  const i = RELEASE_MIGRATIONS.findIndex((m) => m.number === 245), row = RELEASE_MIGRATIONS[i], b = readFileSync(file);
  assert(row, 'manifest row 245');
  assert.equal(row.name, '245_s5_comm');
  assert.equal(row.file, '245_s5_comm.sql');
  assert.equal(row.native_id, 's5_comm245');
  assert.equal(row.cold.contract, 's5-comm245');
  assert.equal(row.cold.project, 'projectCompiledS5Comm245Catalogue');
  assert.equal(row.bytes, b.length);
  assert.equal(row.sha256, createHash('sha256').update(b).digest('hex'));
  assert.equal(row.bytes, 10704);
  assert.equal(row.sha256, '973c09c113d2f076d7bb6f267b17c6096fa5f883a47122ea5a62011509feb057');
  assert.equal(RELEASE_MIGRATIONS[i - 1].name, '244_custom_events_checksums');
  assert.equal(RELEASE_MIGRATIONS[i + 1]?.name, '246_b2b_trade_credit_directory', '246 follows 245');
});

test('245 creates only own objects; the only objects on existing tables are two indexes', () => {
  assert.deepEqual([...code.matchAll(/CREATE\s+TABLE\s+([a-z0-9_]+)/g)].map((m) => m[1]), TABLES);
  const names = [...code.matchAll(/CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|FUNCTION|TRIGGER|VIEW|TYPE|SEQUENCE|POLICY)\s+([a-z0-9_]+)/gi)].map((m) => m[1]);
  for (const n of names.filter((n) => n !== 'tenant_scope')) {
    assert.match(n, /^(comm253|portal253|inbound253|channel253)_/, n);
    for (const p of SEALED) assert.doesNotMatch(n, like(p), n + ' matches sealed pattern ' + p);
  }
  const onExisting = [...code.matchAll(/\bON\s+(?!CONFLICT\b)(?:TABLE\s+)?(?:public\.)?([a-z0-9_]+)/gi)].map((m) => m[1]).filter((t) => !TABLES.includes(t));
  assert.deepEqual(onExisting, ['email_messages', 'sms_messages']);
  assert.match(code, /CREATE INDEX comm253_email_order ON email_messages\(tenant_id, order_id, created_at DESC, id DESC\);/);
  assert.match(code, /CREATE INDEX comm253_sms_order ON sms_messages\(tenant_id, order_id, created_at DESC, id DESC\);/);
  for (const m of code.matchAll(/\bREFERENCES\s+([a-z0-9_]+)/gi)) assert(TABLES.includes(m[1]), 'foreign key only to own tables: ' + m[0]);
  assert.doesNotMatch(code, /\b(?:INSERT\s+INTO|UPDATE\s+[a-z_.]+\s+SET|DELETE\s+FROM)\b/i, 'the migration writes no rows');
  assert.doesNotMatch(code, /\bALTER\s+TABLE\s+(?!(?:portal253|inbound253|channel253)_)/i, 'no existing table is altered');
  assert.doesNotMatch(code, /SECURITY\s+DEFINER|EVENT\s+TRIGGER|CREATE\s+TRIGGER|CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION|\bDROP\b/i);
});

test('245 tables: RLS per tenant, dyna_app never deletes, evidence is append-only', () => {
  for (const t of TABLES) {
    assert.match(code, new RegExp(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`));
    assert.match(code, new RegExp(`CREATE POLICY tenant_scope ON ${t} USING \\(tenant_id=NULLIF\\(current_setting\\('app\\.tenant_id',true\\),''\\)::uuid\\) WITH CHECK \\(tenant_id=NULLIF\\(current_setting\\('app\\.tenant_id',true\\),''\\)::uuid\\);`));
  }
  assert.match(code, new RegExp(`REVOKE ALL ON TABLE ${TABLES.join(', ')} FROM PUBLIC,dyna_app;`));
  assert.deepEqual([...code.matchAll(/\bGRANT\s+([A-Z, ]+)\s+ON\s+TABLE\s+(\S+)\s+TO\s+(\S+);/g)].map((m) => [m[1].trim(), m[2]]), [
    ['SELECT,INSERT,UPDATE', 'portal253_link_policies'],
    ['SELECT,INSERT,UPDATE', 'inbound253_schedules'],
    ['SELECT,INSERT', 'inbound253_matches'],
    ['SELECT,INSERT,UPDATE', 'channel253_connections'],
    ['SELECT,INSERT,UPDATE', 'channel253_threads'],
    ['SELECT,INSERT', 'channel253_messages'],
  ]);
  assert.match(code, /default_days integer CHECK \(default_days BETWEEN 1 AND 365\)/);
  assert.match(code, /interval_minutes integer NOT NULL DEFAULT 15 CHECK \(interval_minutes BETWEEN 5 AND 1440\)/);
  assert.match(code, /order_id uuid,\n subject/, 'a channel thread does not need an order');
  assert.match(code, /UNIQUE \(tenant_id, connection_id, external_thread_id\)/);
  assert.match(code, /CREATE UNIQUE INDEX channel253_messages_external ON channel253_messages\(tenant_id, thread_id, external_message_id\) WHERE external_message_id IS NOT NULL;/);
  assert.match(code, /CHECK \(\(kind = 'inbound'\) = \(actor_id IS NULL\)\)/);
  assert.match(code, /CHECK \(\(outcome = 'bound'\) = \(binding_id IS NOT NULL\)\)/);
});

test('COM-PORTAL-4: default validity in whole days, or none; the input is strict', () => {
  const now = new Date('2026-10-27T10:00:00.000Z');
  assert.equal(portalExpiry(now, null), null);
  assert.equal(portalExpiry(now, 30)!.toISOString(), '2026-11-26T10:00:00.000Z');
  assert.equal(portalExpiry(now, 1)!.toISOString(), '2026-10-28T10:00:00.000Z');
  assert.deepEqual(portalLinkPolicyInput.parse({ default_days: 30, version: 0 }), { default_days: 30, version: 0 });
  assert.deepEqual(portalLinkPolicyInput.parse({ default_days: null, version: 2 }), { default_days: null, version: 2 });
  for (const bad of [{ default_days: 0, version: 0 }, { default_days: 366, version: 0 }, { default_days: 1.5, version: 0 }, { default_days: 30 }, { default_days: 30, version: 0, extra: 1 }])
    assert.equal(portalLinkPolicyInput.safeParse(bad).success, false, JSON.stringify(bad));
  assert.equal(portalPolicySummary(null), 'Linki bez terminu ważności');
  assert.equal(portalPolicySummary(30), 'Nowe linki ważne 30 dni');
  assert.equal(portalPolicySummary(1), 'Nowe linki ważne 1 dzień');
});

test('COM-005: only our own Message-ID counts; foreign and malformed ids are ignored', () => {
  const a = '0b8a9a3e-3d1c-4c55-9a7e-1f2e3d4c5b6a', b = '7f1e2d3c-4b5a-4968-8776-655443322110';
  assert.deepEqual(ownMessageIds({ in_reply_to: `<${a}@dynaminds.local>`, references: [] }), { in_reply_to: [a], references: [] });
  assert.deepEqual(
    ownMessageIds({ in_reply_to: '<x@example.test>', references: [`<x@example.test> <${b}@dynaminds.local>`, `<${a.toUpperCase()}@dynaminds.local>`] }),
    { in_reply_to: [], references: [b, a] },
  );
  for (const h of [`<${a}@dynaminds.local.evil.test>`, `<${a}@evil.test>`, `${a}@dynaminds.local`, `<not-a-uuid@dynaminds.local>`, `<${a}x@dynaminds.local>`])
    assert.deepEqual(ownMessageIds({ in_reply_to: h, references: [h] }), { in_reply_to: [], references: [] }, h);
  // At most 20 references are looked at (a thread can carry 100).
  const many = Array.from({ length: 30 }, (_, i) => `<${a.slice(0, -2)}${String(i).padStart(2, '0')}@dynaminds.local>`);
  assert.equal(ownMessageIds({ in_reply_to: null, references: many }).references.length, 20);
});

test('COM-005: order-number tokens in a subject', () => {
  assert.deepEqual(subjectOrderTokens('Re: Zamówienie DE-20261027-3F2A1B0C — pytanie'), ['DE-20261027-3F2A1B0C']);
  assert.deepEqual(subjectOrderTokens('Pytanie o ZAM/2026/10/15 i 1234567'), ['ZAM/2026/10/15', '1234567']);
  assert.deepEqual(subjectOrderTokens('Dzień dobry, kiedy wysyłka?'), [], 'words without a digit are not order numbers');
  assert.deepEqual(subjectOrderTokens('12 sztuk'), [], 'too short');
  assert.equal(subjectOrderTokens(Array.from({ length: 30 }, (_, i) => 'NR-' + (1000 + i)).join(' ')).length, 10);
});

test('COM-005: the match decision prefers In-Reply-To, then References, then the subject; more than one order = ambiguous', () => {
  const A = 'a'.repeat(8) + '-0000-4000-8000-' + '0'.repeat(12), B = 'b'.repeat(8) + '-0000-4000-8000-' + '0'.repeat(12);
  assert.deepEqual(decideMatch({ replyOrders: [A], referenceOrders: [B], subjectOrders: [B] }), { outcome: 'bound', method: 'in_reply_to', order_id: A, candidates: 1 });
  assert.deepEqual(decideMatch({ replyOrders: [], referenceOrders: [B, B], subjectOrders: [A] }), { outcome: 'bound', method: 'references', order_id: B, candidates: 1 });
  assert.deepEqual(decideMatch({ replyOrders: [], referenceOrders: [], subjectOrders: [A] }), { outcome: 'bound', method: 'subject_number', order_id: A, candidates: 1 });
  assert.deepEqual(decideMatch({ replyOrders: [A, B], referenceOrders: [], subjectOrders: [] }), { outcome: 'ambiguous', method: 'in_reply_to', order_id: null, candidates: 2 });
  assert.deepEqual(decideMatch({ replyOrders: [], referenceOrders: [A, B], subjectOrders: [A] }), { outcome: 'ambiguous', method: 'references', order_id: null, candidates: 2 });
  assert.deepEqual(decideMatch({ replyOrders: [], referenceOrders: [], subjectOrders: [A, B] }), { outcome: 'ambiguous', method: 'subject_number', order_id: null, candidates: 2 });
  assert.deepEqual(decideMatch({ replyOrders: [], referenceOrders: [], subjectOrders: [] }), { outcome: 'none', method: null, order_id: null, candidates: 0 });
  assert.equal(matchLabel('in_reply_to'), 'automatycznie: odpowiedź na naszą wiadomość');
  assert.equal(matchLabel('subject_number'), 'automatycznie: numer zamówienia w temacie i adres kupującego');
  assert.equal(scheduleOutcomeLabel('refused'), 'Wstrzymany: brak uprawnień osoby, która włączyła odbiór');
});

test('COM-005: schedule input and next run', () => {
  assert.deepEqual(inboundScheduleInput.parse({ enabled: true, interval_minutes: 15, auto_bind: true, version: 0 }), { enabled: true, interval_minutes: 15, auto_bind: true, version: 0 });
  for (const bad of [{ enabled: true, interval_minutes: 4, auto_bind: true, version: 0 }, { enabled: true, interval_minutes: 1441, auto_bind: true, version: 0 }, { enabled: 'yes', interval_minutes: 15, auto_bind: true, version: 0 }])
    assert.equal(inboundScheduleInput.safeParse(bad).success, false, JSON.stringify(bad));
  assert.equal(nextRunAt(new Date('2026-10-27T10:00:00Z'), 15).toISOString(), '2026-10-27T10:15:00.000Z');
});

test('COM-008: connector-port input is bounded and strict', () => {
  const m = { external_thread_id: 'T-1', external_message_id: 'M-1', body: 'Czy produkt jest dostępny?' };
  assert.deepEqual(channelIngestInput.parse({ messages: [m] }).messages[0], { ...m, subject: '', buyer_ref: '', sent_at: null, order_number: null });
  for (const bad of [
    { messages: [] },
    { messages: Array.from({ length: 51 }, (_, i) => ({ ...m, external_message_id: 'M' + i })) },
    { messages: [{ ...m, body: '' }] },
    { messages: [{ ...m, body: 'x'.repeat(4001) }] },
    { messages: [{ ...m, external_thread_id: 'x'.repeat(201) }] },
    { messages: [{ ...m, buyer_ref: 'a\u0000b' }] },
    { messages: [{ ...m, extra: 1 }] },
  ])
    assert.equal(channelIngestInput.safeParse(bad).success, false, JSON.stringify(bad).slice(0, 80));
  assert.deepEqual(CHANNELS, ['allegro', 'ebay', 'amazon', 'helpdesk']);
  assert.equal(channelThreadPatch.safeParse({ version: 1 }).success, false, 'a patch changes something');
  assert.equal(channelThreadPatch.safeParse({ version: 1, status: 'closed' }).success, true);
  assert.equal(channelThreadPatch.safeParse({ version: 1, order_number: 'DE-1' , order_id: null }).success, false, 'one way to set the order');
  assert.equal(channelLabel('allegro'), 'Allegro');
  assert.equal(channelLabel('helpdesk'), 'Helpdesk');
});

test('COM-008: the thread list shows the channel, a missing order and a pending reply', () => {
  const html = renderToStaticMarkup(
    createElement(ChannelThreadList, {
      threads: [
        { id: '1', channel: 'allegro', connection_name: 'Allegro sklep', subject: 'Pytanie o rozmiar', buyer_ref: 'kupujacy_1', order_id: null, order_number: null, status: 'open', assigned_name: null, message_count: 1, pending_replies: 0, last_message_at: '2026-10-27T10:00:00Z' },
        { id: '2', channel: 'helpdesk', connection_name: 'Helpdesk', subject: '<b>Reklamacja</b>', buyer_ref: 'anna@example.test', order_id: 'o', order_number: 'DE-1', status: 'closed', assigned_name: 'Operator', message_count: 3, pending_replies: 1, last_message_at: '2026-10-27T11:00:00Z' },
      ],
      selected: '2',
      onSelect: () => {},
    }),
  );
  assert.match(html, /Allegro/);
  assert.match(html, /Bez zamówienia/);
  assert.match(html, /Helpdesk/);
  assert.match(html, /DE-1/);
  assert.match(html, /1 odpowiedź czeka na konektor/);
  assert.match(html, /&lt;b&gt;Reklamacja&lt;\/b&gt;/, 'the subject is text, not HTML');
  assert.match(html, /aria-current="true"/);
});
