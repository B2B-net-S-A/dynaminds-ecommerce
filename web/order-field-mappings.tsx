import { useEffect, useRef, useState } from 'react';
import { api, ApiError, date } from './api';
import type { OrderFieldMapping } from '../server/order-field-mappings-schema';
import './order-field-mappings.css';

type Flags = {
  available: boolean;
  read_only: boolean;
  current_role?: string;
  can_admin: boolean;
  can_import: boolean;
  can_reconcile: boolean;
};
type Field = {
  id: string;
  key: string;
  label: string;
  type: OrderFieldMapping['type'];
  version: number;
  enabled: boolean;
  write_role: 'operator' | 'admin';
  options: { id: string; label: string; enabled: boolean }[];
};
type Channel = { id: string; name: string; provider: string; simulation: boolean };
type Metadata = Flags & {
  definitions: Field[];
  channels: Channel[];
  warehouses: { id: string; name: string }[];
  capabilities: {
    provider: string;
    source_kinds: string[];
    types: OrderFieldMapping['type'][];
    verified_account_identity: boolean;
  }[];
  limits: unknown;
};
type Profile = {
  id: string;
  channel_id: string;
  provider: string;
  label: string;
  enabled: boolean;
  version: number;
  mappings: OrderFieldMapping[];
  approved_by: string;
  created_at: string;
  updated_at: string;
};
type Page<T> = Partial<Flags> & { data: T[]; meta: { cursor: string | null } };
type SourceHead = {
  inbound_id: string;
  external_id: string;
  state: string;
  source_hash: string;
  order_id: string | null;
  order_version: number | string | null;
  observation_id: string | null;
  observed_at: string | null;
  needs_observation: boolean;
};
type Observation = Partial<Flags> & {
  id: string;
  inbound_id: string;
  profile_id: string;
  profile_version: number;
  source_hash: string;
  connection_hash: string;
  provider: string;
  observed_at: string;
  values: SourceValue[];
  issues: { code: string; message: string }[];
};
type SourceValue = {
  field_id: string;
  source: OrderFieldMapping['source'];
  status: 'present' | 'missing' | 'invalid';
  value?: string | string[];
  issue?: { code: string; message: string };
};
type Revision = { profile_id: string; version: number; snapshot: Profile; created_at: string };
type FrozenValue = {
  type: OrderFieldMapping['type'];
  value: string | string[];
  options_snapshot?: { id: string; label: string }[];
} | null;
type Row = {
  row_id: string;
  position: number;
  inbound_id: string;
  observation_id: string;
  source_hash: string;
  connection_hash: string;
  external_id: string;
  order_id: string | null;
  order_number: string | null;
  order_version: number | null;
  status: 'ready' | 'no_op' | 'invalid' | 'conflict';
  source_values: SourceValue[];
  changes: unknown;
  before: { field_id: string; value: FrozenValue }[];
  after: { field_id: string; value: FrozenValue }[];
  skipped: { field_id: string; reason: string }[];
  issues: { code: string; message: string }[];
  order_summary?: {
    customer_name: string;
    currency: string;
    total: number;
    shipping_cost: number;
    warehouse_id: string;
    stock_action: 'reserve_on_import';
    items: { external_id: string; name: string; quantity: number; line_total: number }[];
  };
};
type Preview = Partial<Flags> &
  Page<Row> & {
    id: string;
    kind: 'initial' | 'reconcile';
    profile_snapshot: Profile;
    definitions_snapshot: Field[];
    scope_hash: string;
    policy: 'fill_unset' | 'replace';
    warehouse_id: string | null;
    expires_at: string;
    summary: { total: number; ready: number; no_op: number; invalid: number; conflict: number };
  };
type ExecutionHead = {
  id: string;
  kind: 'initial' | 'reconcile';
  preview_id: string;
  state: 'queued' | 'done' | 'conflict' | 'failed' | 'cancelled';
  selected_count: number;
  origin: string;
  created_at: string;
  finished_at: string | null;
  result: unknown;
  error: string | null;
};
type Execution = Partial<Flags> &
  ExecutionHead & {
    consent: unknown;
    data: (Row & {
      result?: { row_id: string; order_id: string; changed: boolean; order_version: number } | null;
    })[];
  };
type ProfileDraft = {
  id?: string;
  version?: number;
  channel_id: string;
  label: string;
  enabled: boolean;
  mappings: OrderFieldMapping[];
};
type Attempt = {
  path: string;
  method: 'POST' | 'PATCH';
  body: unknown;
  permission: 'admin' | 'import' | 'reconcile';
  title: string;
  success: (r: any) => void | Promise<void>;
};
type Context = {
  workspaceId: string;
  userId: string;
  role: string;
  readOnly: boolean;
  onError: (m: string) => void;
};
const prefix = '/order-field-mappings';
const statuses: Record<string, string> = {
  ready: 'Gotowy',
  no_op: 'Bez zmiany',
  invalid: 'Błąd danych',
  conflict: 'Konflikt',
  queued: 'W kolejce',
  done: 'Zakończono',
  failed: 'Błąd',
  cancelled: 'Anulowano',
  staged: 'Zapisano źródło',
  imported: 'Zaimportowano',
  error: 'Błąd źródła',
};
const typeNames: Record<OrderFieldMapping['type'], string> = {
  text: 'Tekst',
  number: 'Liczba dokładna',
  date: 'Data',
  select: 'Lista wyboru',
  radio: 'Wybór pojedynczy',
  multi_select: 'Wiele opcji',
};
const sourceNames: Record<OrderFieldMapping['source']['kind'], string> = {
  woo_customer_note: 'Uwagi kupującego (customer_note)',
  woo_meta: 'Dokładny klucz meta_data',
  allegro_message_to_seller: 'Wiadomość dla sprzedawcy',
  allegro_buyer_login: 'Login kupującego',
  allegro_delivery_method_name: 'Nazwa metody dostawy',
  shopify_note: 'Notatka zamówienia (note)',
  shopify_name: 'Nazwa zamówienia (name)',
};
function sourceKinds(provider: string): OrderFieldMapping['source']['kind'][] {
  return provider === 'woocommerce'
    ? ['woo_customer_note', 'woo_meta']
    : provider === 'allegro'
      ? ['allegro_message_to_seller', 'allegro_buyer_login', 'allegro_delivery_method_name']
      : provider === 'shopify'
        ? ['shopify_note', 'shopify_name']
        : [];
}
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const privateError = (e: unknown) => e instanceof ApiError && [401, 403].includes(e.status);
const literal = (s: string, max: number, label: string) => {
  if (
    !s.length ||
    s.length > max ||
    new TextDecoder().decode(new TextEncoder().encode(s)) !== s ||
    s.includes('\0')
  )
    throw Error(`${label}: od 1 do ${max} znaków, poprawny tekst bez NUL.`);
};
function version(value: number | string | null) {
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value)))
    throw Error('Źródło nie ma prawidłowej wersji własnego zamówienia. Odczytaj je ponownie.');
  return Number(value);
}
function Evidence({ title, value }: { title: string; value: unknown }) {
  return (
    <details className="ofm-evidence">
      <summary>{title}</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}
function valueText(v: FrozenValue) {
  if (v === null) return 'Nieustawione';
  const label = (id: string) => v.options_snapshot?.find((o) => o.id === id)?.label ?? id;
  if (Array.isArray(v.value))
    return v.value.length ? v.value.map(label).join(', ') : 'Ustawiona pusta lista';
  if (['select', 'radio'].includes(v.type)) return label(v.value);
  return v.value === '' ? 'Ustawiony pusty tekst' : v.value;
}
function OrderSummary({
  summary,
  warehouses,
}: {
  summary: NonNullable<Row['order_summary']>;
  warehouses: { id: string; name: string }[];
}) {
  const money = (minor: number) =>
    Number.isSafeInteger(minor)
      ? `${(minor / 100).toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${summary.currency}`
      : 'Brak poprawnej kwoty w źródle';
  return (
    <section className="ofm-order-summary">
      <h4>Zamówienie ze źródła</h4>
      <div className="ofm-summary">
        <span>
          Klient: <strong>{summary.customer_name || 'Nie podano'}</strong>
        </span>
        <span>
          Razem: <strong>{money(summary.total)}</strong>
        </span>
        <span>
          Dostawa: <strong>{money(summary.shipping_cost)}</strong>
        </span>
        <span>
          Magazyn:{' '}
          <strong>
            {warehouses.find((w) => w.id === summary.warehouse_id)?.name ??
              'Magazyn zapisany w podglądzie'}
          </strong>
        </span>
      </div>
      <div className="ofm-table-wrap">
        <table>
          <thead>
            <tr>
              <th>ID produktu w kanale</th>
              <th>Pozycja ze źródła</th>
              <th>Ilość</th>
              <th>Kwota pozycji</th>
            </tr>
          </thead>
          <tbody>
            {summary.items.map((item, i) => (
              <tr key={i}>
                <td>{item.external_id}</td>
                <td>{item.name}</td>
                <td>{item.quantity}</td>
                <td>{money(item.line_total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        Rezerwacja zostanie sprawdzona przy imporcie. Dane ze źródła nie potwierdzają lokalnej
        dostępności produktów.
      </p>
      <Evidence
        title="Identyfikator wybranego magazynu"
        value={{ warehouse_id: summary.warehouse_id }}
      />
    </section>
  );
}
function RowEvidence({ row, fields }: { row: Row; fields: Field[] }) {
  const ids = [...new Set([...row.before, ...row.after].map((v) => v.field_id))];
  const reasons: Record<string, string> = {
    protected_existing: 'Chroniona istniejąca wartość',
    unchanged: 'Bez zmiany',
    already_unset: 'Już nieustawione',
    missing: 'Brak źródła — pominięto',
    missing_skip: 'Brak źródła — pominięto',
    source_missing: 'Brak źródła — pominięto',
  };
  return (
    <>
      <SourceValues values={row.source_values} fields={fields} />
      <div className="ofm-table-wrap">
        <table>
          <thead>
            <tr>
              <th>Pole</th>
              <th>Przed</th>
              <th>Typowany wynik / po</th>
              <th>Wyjaśnienie</th>
            </tr>
          </thead>
          <tbody>
            {ids.map((id) => (
              <tr key={id}>
                <th>{fields.find((f) => f.id === id)?.label ?? 'Pole z podglądu'}</th>
                <td>
                  {row.before.some((v) => v.field_id === id)
                    ? valueText(row.before.find((v) => v.field_id === id)!.value)
                    : 'Brak wartości przed importem'}
                </td>
                <td>
                  {row.after.some((v) => v.field_id === id)
                    ? valueText(row.after.find((v) => v.field_id === id)!.value)
                    : 'Brak dostępnego wyniku'}
                </td>
                <td>
                  {row.skipped
                    .filter((s) => s.field_id === id)
                    .map((s) => reasons[s.reason] ?? s.reason)
                    .join('; ') || 'W pokazanym zakresie'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {row.skipped.length > 0 && (
        <ul>
          {row.skipped.map((s, i) => (
            <li key={i}>
              {fields.find((f) => f.id === s.field_id)?.label ?? 'Pole'}:{' '}
              {reasons[s.reason] ?? s.reason}
            </li>
          ))}
        </ul>
      )}
      <Evidence title="Dokładne zmiany, wartości i identyfikatory źródła" value={row} />
    </>
  );
}
function SourceValues({ values, fields }: { values: SourceValue[]; fields: Field[] }) {
  return (
    <div className="ofm-table-wrap">
      <table>
        <thead>
          <tr>
            <th>Źródło</th>
            <th>Pole docelowe</th>
            <th>Zaobserwowana wartość</th>
            <th>Stan</th>
          </tr>
        </thead>
        <tbody>
          {values.map((s, i) => (
            <tr key={i}>
              <td>
                {sourceNames[s.source.kind]}
                {s.source.kind === 'woo_meta' ? `: ${s.source.key}` : ''}
              </td>
              <td>{fields.find((f) => f.id === s.field_id)?.label ?? 'Pole z obserwacji'}</td>
              <td>
                {s.status === 'present'
                  ? Array.isArray(s.value)
                    ? s.value.length
                      ? JSON.stringify(s.value)
                      : 'Jawna pusta tablica'
                    : s.value === ''
                      ? 'Pusty tekst'
                      : s.value
                  : 'Brak poprawnej wartości'}
              </td>
              <td>
                {s.status === 'present'
                  ? 'Obecna'
                  : s.status === 'missing'
                    ? 'Brak źródła'
                    : 'Nieprawidłowe źródło'}
                {s.issue && (
                  <p className="ofm-error">
                    {s.issue.message} ({s.issue.code})
                  </p>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function ProfileSummary({ profile, fields }: { profile: Profile; fields: Field[] }) {
  return (
    <section className="ofm-row">
      <h3>
        {profile.label} · wersja {profile.version}
      </h3>
      <p>
        {profile.enabled ? 'Aktywny profil' : 'Profil wyłączony'} · {profile.provider} ·{' '}
        {profile.mappings.length}/20 mapowań
      </p>
      <div className="ofm-table-wrap">
        <table>
          <thead>
            <tr>
              <th>Źródło</th>
              <th>Własne pole / wersja</th>
              <th>Konwerter</th>
              <th>Brak źródła</th>
            </tr>
          </thead>
          <tbody>
            {profile.mappings.map((m) => (
              <tr key={m.field_id}>
                <td>
                  {sourceNames[m.source.kind]}
                  {m.source.kind === 'woo_meta' ? `: ${m.source.key}` : ''}
                </td>
                <td>
                  {fields.find((f) => f.id === m.field_id)?.label ?? 'Pole profilu'} ·{' '}
                  {m.definition_version}
                </td>
                <td>
                  {m.conversion.kind === 'direct'
                    ? 'Dokładna wartość bezpośrednia'
                    : `${m.conversion.codes.length} dokładnych kodów · ${m.conversion.input === 'array' ? 'tablica' : 'pojedynczy tekst'}`}
                </td>
                <td>
                  {m.on_missing === 'skip' ? 'Pomiń i pokaż przyczynę' : 'Zablokuj wyjątkiem'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Evidence title="Dokładne słowniki, UUID i grant profilu" value={profile} />
    </section>
  );
}
function newMapping(field: Field, provider: string): OrderFieldMapping {
  return {
    source: { kind: sourceKinds(provider)[0] } as OrderFieldMapping['source'],
    field_id: field.id,
    definition_version: field.version,
    type: field.type,
    conversion: ['select', 'radio', 'multi_select'].includes(field.type)
      ? { kind: 'option_map', input: 'scalar', codes: [] }
      : { kind: 'direct' },
    on_missing: 'error',
  };
}

export function OrderFieldMappings(props: Context) {
  return (
    <MappingSession
      key={`${props.workspaceId}:${props.userId}:${props.role}:${props.readOnly}`}
      {...props}
    />
  );
}
function MappingSession({ role, readOnly, onError }: Context) {
  const [meta, setMeta] = useState<Metadata | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [tab, setTab] = useState<'profiles' | 'initial' | 'reconcile' | 'history'>('profiles');
  const [profiles, setProfiles] = useState<Page<Profile> | null>(null),
    [activeProfile, setActiveProfile] = useState<Profile | null>(null),
    [draft, setDraft] = useState<ProfileDraft | null>(null),
    [latestProfile, setLatestProfile] = useState<Profile | null>(null),
    [profileReview, setProfileReview] = useState(false),
    [revisions, setRevisions] = useState<Page<Revision> | null>(null),
    [revisionProfileId, setRevisionProfileId] = useState('');
  const [channelId, setChannelId] = useState(''),
    [profileId, setProfileId] = useState(''),
    [warehouse, setWarehouse] = useState(''),
    [policy, setPolicy] = useState<'fill_unset' | 'replace'>('fill_unset');
  const [sources, setSources] = useState<Page<SourceHead> | null>(null),
    [observation, setObservation] = useState<Observation | null>(null),
    [selectedSources, setSelectedSources] = useState<Record<string, SourceHead>>({}),
    [initialSource, setInitialSource] = useState<SourceHead | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null),
    [rows, setRows] = useState<Row[]>([]),
    [selectedRows, setSelectedRows] = useState<Record<string, Row>>({}),
    [consent, setConsent] = useState(false),
    [exceptions, setExceptions] = useState(false),
    [execution, setExecution] = useState<Execution | null>(null),
    [importedOrder, setImportedOrder] = useState<{
      execution_id: string;
      id: string;
      number: string;
      version: number;
    } | null>(null);
  const [previewHistory, setPreviewHistory] = useState<Page<Preview> | null>(null),
    [executionHistory, setExecutionHistory] = useState<Page<ExecutionHead> | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null),
    [retryConsent, setRetryConsent] = useState(false);
  const alive = useRef(true),
    epoch = useRef(0),
    viewEpoch = useRef(0),
    pending = useRef<Attempt | null>(null),
    sending = useRef(false);
  const can = (p: Attempt['permission']) =>
    !!meta?.available &&
    !readOnly &&
    !meta.read_only &&
    (p === 'admin' ? meta.can_admin : p === 'import' ? meta.can_import : meta.can_reconcile);
  const locked = busy || !!attempt;
  const selectionScope = JSON.stringify({
    id: preview?.id,
    hash: preview?.scope_hash,
    policy: preview?.policy,
    rows: Object.keys(selectedRows).sort(),
  });
  useEffect(
    () => setConsent(false),
    [
      selectionScope,
      channelId,
      profileId,
      activeProfile?.version,
      warehouse,
      policy,
      initialSource,
      selectedSources,
      readOnly,
      meta?.current_role,
    ],
  );
  useEffect(() => setProfileReview(false), [draft]);
  useEffect(() => setRetryConsent(false), [attempt]);
  useEffect(() => {
    alive.current = true;
    void metadata();
    return () => {
      alive.current = false;
      epoch.current++;
      viewEpoch.current++;
      pending.current = null;
    };
  }, []);
  function purge() {
    epoch.current++;
    viewEpoch.current++;
    pending.current = null;
    setBusy(false);
    setMeta(null);
    setProfiles(null);
    setActiveProfile(null);
    setDraft(null);
    setLatestProfile(null);
    setRevisions(null);
    setRevisionProfileId('');
    setChannelId('');
    setProfileId('');
    setWarehouse('');
    setSources(null);
    setObservation(null);
    setSelectedSources({});
    setInitialSource(null);
    setPreview(null);
    setRows([]);
    setSelectedRows({});
    setExecution(null);
    setImportedOrder(null);
    setPreviewHistory(null);
    setExecutionHistory(null);
    setAttempt(null);
    setConsent(false);
    setProfileReview(false);
  }
  function fail(e: unknown) {
    if (!alive.current) return;
    if (privateError(e)) purge();
    if (e instanceof ApiError && e.status === 423)
      setMeta((m) =>
        m
          ? { ...m, read_only: true, can_admin: false, can_import: false, can_reconcile: false }
          : m,
      );
    setError(errorText(e));
    onError(errorText(e));
  }
  function flags(f: Partial<Flags>) {
    if (f.current_role && f.current_role !== role) {
      purge();
      const s = 'Rola konta zmieniła się. Odśwież sesję przed dalszą pracą.';
      setError(s);
      onError(s);
      throw Error(s);
    }
    if (typeof f.available === 'boolean')
      setMeta((old) =>
        old
          ? {
              ...old,
              available: f.available!,
              read_only: f.read_only ?? old.read_only,
              current_role: f.current_role ?? old.current_role,
              can_admin: f.can_admin ?? old.can_admin,
              can_import: f.can_import ?? old.can_import,
              can_reconcile: f.can_reconcile ?? old.can_reconcile,
            }
          : old,
      );
  }
  async function metadata() {
    if (pending.current) return;
    const e = ++epoch.current;
    viewEpoch.current++;
    setMeta(null);
    setSources(null);
    setObservation(null);
    setPreview(null);
    setRows([]);
    setSelectedRows({});
    setSelectedSources({});
    setInitialSource(null);
    setExecution(null);
    setImportedOrder(null);
    setActiveProfile(null);
    setProfileId('');
    setChannelId('');
    setWarehouse('');
    setDraft(null);
    setLatestProfile(null);
    setRevisions(null);
    setRevisionProfileId('');
    setProfiles(null);
    setPreviewHistory(null);
    setExecutionHistory(null);
    setBusy(true);
    setError('');
    try {
      const data = await api<Metadata>(prefix + '/metadata');
      if (!alive.current || e !== epoch.current) return;
      if (data.current_role && data.current_role !== role) {
        flags(data);
        return;
      }
      setMeta(data);
      if (!data.available) return;
      const list = await api<Page<Profile>>(prefix + '/profiles');
      if (!alive.current || e !== epoch.current) return;
      flags(list);
      setProfiles(list);
    } catch (err) {
      if (alive.current && e === epoch.current) fail(err);
    } finally {
      if (alive.current && e === epoch.current) setBusy(false);
    }
  }
  async function read<T extends Partial<Flags>>(path: string, apply: (data: T) => void) {
    if (pending.current) return;
    const e = epoch.current,
      v = ++viewEpoch.current;
    setBusy(true);
    setError('');
    try {
      const data = await api<T>(path);
      if (!alive.current || e !== epoch.current || v !== viewEpoch.current) return;
      flags(data);
      apply(data);
    } catch (err) {
      if (alive.current && e === epoch.current && v === viewEpoch.current) fail(err);
    } finally {
      if (alive.current && e === epoch.current && v === viewEpoch.current) setBusy(false);
    }
  }
  async function mutate(a: Attempt, retry = false) {
    if (!can(a.permission) || sending.current || (!retry && pending.current)) return;
    const frozen = retry ? pending.current : { ...a, body: structuredClone(a.body) };
    if (!frozen) return;
    pending.current = frozen;
    setAttempt(frozen);
    sending.current = true;
    setBusy(true);
    setError('');
    const e = epoch.current;
    let confirmed = false;
    try {
      const result = await api(frozen.path, frozen.method, frozen.body);
      confirmed = true;
      if (!alive.current || e !== epoch.current) return;
      flags(result);
      pending.current = null;
      setAttempt(null);
      await frozen.success(result);
    } catch (err) {
      if (!alive.current || e !== epoch.current) return;
      if (!confirmed && err instanceof ApiError && [409, 422, 423].includes(err.status)) {
        pending.current = null;
        setAttempt(null);
        setConsent(false);
        setProfileReview(false);
      }
      fail(err);
    } finally {
      sending.current = false;
      if (alive.current) setBusy(false);
    }
  }
  function resetPlan() {
    setPreview(null);
    setRows([]);
    setSelectedRows({});
    setConsent(false);
    setExecution(null);
    setImportedOrder(null);
  }
  function changeChannel(id: string) {
    setChannelId(id);
    setProfileId('');
    setActiveProfile(null);
    setSources(null);
    setObservation(null);
    setInitialSource(null);
    setSelectedSources({});
    setWarehouse('');
    resetPlan();
  }
  async function profileDetail(id: string, edit = false, check = false) {
    await read<Partial<Flags> & { profile: Profile }>(prefix + '/profiles/' + id, (result) => {
      const p = result.profile;
      if (check) {
        setLatestProfile(p);
        return;
      }
      setActiveProfile(p);
      setProfileId(p.id);
      setChannelId(p.channel_id);
      setRevisions(null);
      resetPlan();
      setSources(null);
      setObservation(null);
      setInitialSource(null);
      setSelectedSources({});
      if (edit)
        setDraft({
          id: p.id,
          version: p.version,
          channel_id: p.channel_id,
          label: p.label,
          enabled: p.enabled,
          mappings: structuredClone(p.mappings),
        });
    });
  }
  async function profileList(cursor?: string) {
    await read<Page<Profile>>(
      prefix + '/profiles' + (cursor ? '?' + new URLSearchParams({ cursor }) : ''),
      setProfiles,
    );
  }
  function editMapping(i: number, fn: (m: OrderFieldMapping) => OrderFieldMapping) {
    setDraft((d) =>
      d ? { ...d, mappings: d.mappings.map((m, j) => (i === j ? fn(structuredClone(m)) : m)) } : d,
    );
  }
  async function saveProfile() {
    try {
      if (!draft || !profileReview) return;
      literal(draft.label, 120, 'Nazwa profilu');
      const ch = meta?.channels.find((c) => c.id === draft.channel_id);
      if (!ch) throw Error('Wybierz własny obsługiwany kanał.');
      if (
        !draft.mappings.length ||
        draft.mappings.length > 20 ||
        new Set(draft.mappings.map((m) => m.field_id)).size !== draft.mappings.length
      )
        throw Error('Profil wymaga 1..20 różnych pól.');
      for (const m of draft.mappings) {
        const f = meta?.definitions.find((f) => f.id === m.field_id);
        if (!f || !f.enabled || f.version !== m.definition_version || f.type !== m.type)
          throw Error(
            'Pole lub wersja definicji jest niedostępna/stara. Zaktualizuj mapowanie jawnie.',
          );
        if (!sourceKinds(ch.provider).includes(m.source.kind))
          throw Error('Źródło nie jest obsługiwane przez wybrany adapter.');
        if (m.source.kind === 'woo_meta') literal(m.source.key, 160, 'Dokładny klucz meta_data');
        if (m.conversion.kind === 'option_map') {
          if (!m.conversion.codes.length || m.conversion.codes.length > 100)
            throw Error('Słownik wymaga 1..100 kodów.');
          if (new Set(m.conversion.codes.map((c) => c.code)).size !== m.conversion.codes.length)
            throw Error('Powtórzony kod źródła w słowniku.');
          for (const c of m.conversion.codes) {
            literal(c.code, 120, 'Kod źródła');
            if (!f.options.some((o) => o.id === c.option_id && o.enabled))
              throw Error('Kod musi wskazywać aktywną własną opcję.');
          }
          if (m.type !== 'multi_select' && m.conversion.input !== 'scalar')
            throw Error('Tablica źródłowa jest dostępna wyłącznie dla wielu opcji.');
        }
      }
      const body = draft.id
        ? {
            client_key: crypto.randomUUID(),
            version: draft.version,
            label: draft.label,
            enabled: draft.enabled,
            mappings: draft.mappings,
          }
        : {
            client_key: crypto.randomUUID(),
            channel_id: draft.channel_id,
            label: draft.label,
            enabled: draft.enabled,
            mappings: draft.mappings,
          };
      await mutate({
        path: prefix + '/profiles' + (draft.id ? '/' + draft.id : ''),
        method: draft.id ? 'PATCH' : 'POST',
        body,
        permission: 'admin',
        title: 'Zapis wersji profilu',
        success: async (r) => {
          setDraft(null);
          setLatestProfile(null);
          setActiveProfile(r.profile);
          setProfileId(r.profile.id);
          setChannelId(r.profile.channel_id);
          resetPlan();
          await profileList();
        },
      });
    } catch (err) {
      fail(err);
    }
  }
  async function loadSources(cursor?: string) {
    if (!channelId) {
      fail(Error('Wybierz własny kanał.'));
      return;
    }
    await read<Page<SourceHead>>(
      prefix +
        '/sources?' +
        new URLSearchParams({ channel_id: channelId, ...(cursor ? { cursor } : {}) }),
      setSources,
    );
  }
  async function createPreview() {
    try {
      if (!activeProfile || !activeProfile.enabled || activeProfile.channel_id !== channelId)
        throw Error('Wybierz aktywny profil tego kanału i odczytaj jego aktualną wersję.');
      if (
        activeProfile.mappings.some((m) => {
          const field = meta?.definitions.find((f) => f.id === m.field_id);
          return (
            !field ||
            !field.enabled ||
            field.version !== m.definition_version ||
            (role !== 'admin' && field.write_role !== 'operator')
          );
        })
      )
        throw Error(
          'Profil zawiera starą lub niedostępną do zapisu definicję. Administrator musi zaktualizować profil.',
        );
      let body: unknown;
      if (tab === 'initial') {
        if (
          !initialSource ||
          initialSource.order_id ||
          initialSource.needs_observation ||
          !initialSource.observation_id
        )
          throw Error('Wybierz jedno niezaimportowane źródło z aktualną obserwacją.');
        if (!warehouse) throw Error('Wybierz magazyn importu jawnie.');
        body = {
          client_key: crypto.randomUUID(),
          kind: 'initial',
          profile_id: activeProfile.id,
          profile_version: activeProfile.version,
          inbound_id: initialSource.inbound_id,
          observation_id: initialSource.observation_id,
          source_hash: initialSource.source_hash,
          warehouse_id: warehouse,
        };
      } else {
        const chosen = Object.values(selectedSources);
        if (!chosen.length || chosen.length > 100)
          throw Error('Wybierz 1..100 wcześniej zaimportowanych zamówień.');
        body = {
          client_key: crypto.randomUUID(),
          kind: 'reconcile',
          profile_id: activeProfile.id,
          profile_version: activeProfile.version,
          policy,
          orders: chosen.map((s) => {
            if (!s.order_id || !s.observation_id || s.needs_observation)
              throw Error('Wybór zawiera zamówienie bez aktualnej obserwacji.');
            return {
              inbound_id: s.inbound_id,
              observation_id: s.observation_id,
              source_hash: s.source_hash,
              order_id: s.order_id,
              order_version: version(s.order_version),
            };
          }),
        };
      }
      await mutate({
        path: prefix + '/previews',
        method: 'POST',
        body,
        permission: tab === 'initial' ? 'import' : 'reconcile',
        title: 'Zamrożony podgląd mapowania',
        success: (p) => {
          setPreview(p);
          setRows(p.data);
          setSelectedRows({});
          setExecution(null);
          setImportedOrder(null);
          setConsent(false);
        },
      });
    } catch (err) {
      fail(err);
    }
  }
  async function previewDetail(id: string, cursor?: string, keep = false) {
    if (!keep) {
      setSelectedRows({});
      setRows([]);
      setPreview(null);
      setExecution(null);
      setImportedOrder(null);
    }
    await read<Preview>(
      prefix + '/previews/' + id + (cursor ? '?' + new URLSearchParams({ cursor }) : ''),
      (p) => {
        setPreview(p);
        setRows(p.data);
      },
    );
  }
  async function executionDetail(id: string) {
    await read<Execution>(prefix + '/executions/' + id, (e) => {
      setExecution(e);
      setPreview(null);
      setRows([]);
      setSelectedRows({});
      setConsent(false);
    });
  }
  async function approve() {
    if (!preview || !consent) return;
    if (new Date(preview.expires_at).getTime() <= Date.now()) {
      setConsent(false);
      fail(Error('Podgląd wygasł. Przygotuj nowy przed zatwierdzeniem.'));
      return;
    }
    if (preview.kind === 'initial') {
      if (
        preview.summary.total !== 1 ||
        rows.length !== 1 ||
        !rows.every((r) => ['ready', 'no_op'].includes(r.status) && !!r.order_summary)
      ) {
        setConsent(false);
        fail(Error('Import wymaga jednego gotowego wiersza ze szczegółami zamówienia.'));
        return;
      }
      await mutate({
        path: prefix + '/previews/' + preview.id + '/import',
        method: 'POST',
        body: {
          client_key: crypto.randomUUID(),
          consent: { scope_hash: preview.scope_hash, local_only: true },
        },
        permission: 'import',
        title: 'Import zamówienia i mapowanych pól',
        success: async (r) => {
          setImportedOrder({ ...r.order, execution_id: r.execution.id });
          setConsent(false);
          await executionDetail(r.execution.id);
        },
      });
    } else {
      const ids = Object.keys(selectedRows).sort();
      if (!ids.length || ids.length > 100) {
        fail(Error('Wybierz 1..100 gotowych wierszy.'));
        return;
      }
      await mutate({
        path: prefix + '/previews/' + preview.id + '/queue',
        method: 'POST',
        body: {
          client_key: crypto.randomUUID(),
          selected_rows: ids,
          consent: {
            scope_hash: preview.scope_hash,
            selected_count: ids.length,
            policy: preview.policy,
            local_only: true,
          },
        },
        permission: 'reconcile',
        title: 'Zatwierdzenie wybranego uzgodnienia pól',
        success: async (r) => {
          setConsent(false);
          setSelectedRows({});
          await executionDetail(r.execution.id);
        },
      });
    }
  }
  const channel = meta?.channels.find((c) => c.id === channelId),
    draftChannel = meta?.channels.find((c) => c.id === draft?.channel_id);
  const profileOptions = profiles?.data.filter((p) => p.channel_id === channelId) ?? [];
  if (
    activeProfile?.channel_id === channelId &&
    !profileOptions.some((p) => p.id === activeProfile.id)
  )
    profileOptions.unshift(activeProfile);
  return (
    <div className="order-field-mappings">
      <section className="panel ofm-panel">
        <div className="panel-heading">
          <div>
            <h2>Pola — mapowania kanałów</h2>
            <p>
              WooCommerce, Allegro i Shopify: jawny profil, obserwacja, podgląd oraz osobna zgoda na
              lokalny zapis.
            </p>
          </div>
          <button className="button" disabled={locked} onClick={() => void metadata()}>
            Odśwież dostępność / wyczyść szkic
          </button>
        </div>
        {error && (
          <p className="ofm-error" role="alert">
            {error}
          </p>
        )}
        {!meta ? (
          <p>Odczytywanie dostępności…</p>
        ) : !meta.available ? (
          <p>Mapowania pól są niedostępne w tej kopii aplikacji.</p>
        ) : (
          <>
            <p className="notice">
              Zwykły import w Integracjach pozostaje importem bez mapowania pól. Profil nie zapisuje
              pól automatycznie podczas synchronizacji lub pobierania płatności. Ten panel używa
              wyłącznie lokalnych, zapisanych obserwacji.
            </p>
            {(readOnly || meta.read_only) && (
              <p className="notice">
                Kopia tylko do odczytu: profile, źródła, podglądy i wyniki można odczytać. Zapisy są
                wyłączone.
              </p>
            )}
            <div className="ofm-tabs">
              {(
                [
                  ['profiles', 'Profile'],
                  ['initial', 'Import początkowy'],
                  ['reconcile', 'Uzgodnienie'],
                  ['history', 'Historia'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  className={'button ' + (tab === id ? 'primary' : '')}
                  disabled={locked}
                  onClick={() => {
                    setTab(id);
                    setConsent(false);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            {tab === 'profiles' && (
              <>
                <div className="ofm-toolbar">
                  <button className="button" disabled={locked} onClick={() => void profileList()}>
                    Odczytaj profile
                  </button>
                  <button
                    className="button primary"
                    disabled={locked || !can('admin')}
                    onClick={() => {
                      setDraft({ channel_id: '', label: '', enabled: false, mappings: [] });
                      setLatestProfile(null);
                      setRevisions(null);
                    }}
                  >
                    Nowy profil
                  </button>
                  {profiles?.meta.cursor && (
                    <button
                      className="button"
                      disabled={locked}
                      onClick={() => void profileList(profiles.meta.cursor!)}
                    >
                      Starsze profile
                    </button>
                  )}
                </div>
                <ul>
                  {profiles?.data.map((p) => (
                    <li key={p.id}>
                      <strong>{p.label}</strong> ·{' '}
                      {meta.channels.find((c) => c.id === p.channel_id)?.name ?? p.provider} ·
                      wersja {p.version} · {p.enabled ? 'aktywny' : 'wyłączony'}{' '}
                      <button
                        className="button"
                        disabled={locked}
                        onClick={() => void profileDetail(p.id, false)}
                      >
                        Odczytaj
                      </button>
                      <button
                        className="button"
                        disabled={locked || !can('admin')}
                        onClick={() => void profileDetail(p.id, true)}
                      >
                        Edytuj
                      </button>
                      <button
                        className="button"
                        disabled={locked}
                        onClick={() =>
                          void read<Page<Revision>>(
                            prefix + '/profiles/' + p.id + '/revisions',
                            (r) => {
                              setRevisions(r);
                              setRevisionProfileId(p.id);
                            },
                          )
                        }
                      >
                        Rewizje
                      </button>
                    </li>
                  ))}
                </ul>
                {activeProfile && (
                  <ProfileSummary profile={activeProfile} fields={meta.definitions} />
                )}{' '}
                {revisions && (
                  <>
                    <h3>Niezmienne rewizje</h3>
                    {revisions.data.map((r) => (
                      <article key={r.version}>
                        <p>
                          Rewizja {r.version} · {date(r.created_at)}
                        </p>
                        <ProfileSummary profile={r.snapshot} fields={meta.definitions} />
                      </article>
                    ))}
                    {revisions.meta.cursor && revisionProfileId && (
                      <button
                        className="button"
                        disabled={locked}
                        onClick={() =>
                          void read<Page<Revision>>(
                            prefix +
                              '/profiles/' +
                              revisionProfileId +
                              '/revisions?' +
                              new URLSearchParams({ cursor: revisions.meta.cursor! }),
                            setRevisions,
                          )
                        }
                      >
                        Starsze rewizje
                      </button>
                    )}
                  </>
                )}
                {draft && (
                  <section className="ofm-row">
                    <h3>{draft.id ? 'Edycja wersji ' + draft.version : 'Nowy profil'}</h3>
                    <fieldset disabled={locked || !can('admin')} className="ofm-inputs">
                      <div className="ofm-grid">
                        <label>
                          Własny kanał
                          <select
                            value={draft.channel_id}
                            disabled={!!draft.id}
                            onChange={(e) =>
                              setDraft((d) =>
                                d ? { ...d, channel_id: e.target.value, mappings: [] } : d,
                              )
                            }
                          >
                            <option value="">Wybierz kanał jawnie</option>
                            {meta.channels.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name} ({c.provider}){c.simulation ? ' — DEMO' : ''}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          Nazwa profilu
                          <input
                            value={draft.label}
                            onChange={(e) =>
                              setDraft((d) => (d ? { ...d, label: e.target.value } : d))
                            }
                          />
                        </label>
                      </div>
                      <label className="ofm-check">
                        <input
                          type="checkbox"
                          checked={draft.enabled}
                          onChange={(e) =>
                            setDraft((d) => (d ? { ...d, enabled: e.target.checked } : d))
                          }
                        />
                        Aktywny profil — nowe obserwacje podczas zwykłego pobierania zamówień; zapis
                        pól nadal wymaga osobnego podglądu i zgody.
                      </label>
                      {draft.mappings.map((m, i) => {
                        const f = meta.definitions.find((f) => f.id === m.field_id);
                        const options = f?.options ?? [];
                        return (
                          <fieldset className="ofm-mapping" key={m.field_id}>
                            <legend>
                              {f?.label ?? 'Niedostępne pole'} — {typeNames[m.type]}, wersja
                              definicji {m.definition_version}
                            </legend>
                            {(!f || !f.enabled || f.version !== m.definition_version) && (
                              <p className="ofm-error">
                                Definicja jest wyłączona, niedostępna lub ma inną wersję. Profil nie
                                zostanie zapisany.
                              </p>
                            )}
                            {f && f.enabled && f.version !== m.definition_version && (
                              <button
                                className="button"
                                onClick={() =>
                                  editMapping(i, (old) => ({
                                    ...old,
                                    type: f.type,
                                    definition_version: f.version,
                                    conversion: ['select', 'radio', 'multi_select'].includes(f.type)
                                      ? { kind: 'option_map', input: 'scalar', codes: [] }
                                      : { kind: 'direct' },
                                  }))
                                }
                              >
                                Jawnie użyj wersji {f.version} (wyczyść konwerter)
                              </button>
                            )}
                            <div className="ofm-grid">
                              <label>
                                Źródło adaptera
                                <select
                                  value={m.source.kind}
                                  onChange={(e) =>
                                    editMapping(i, (old) => ({
                                      ...old,
                                      source:
                                        e.target.value === 'woo_meta'
                                          ? { kind: 'woo_meta', key: '' }
                                          : ({
                                              kind: e.target.value,
                                            } as OrderFieldMapping['source']),
                                    }))
                                  }
                                >
                                  {sourceKinds(draftChannel?.provider ?? '').map((kind) => (
                                    <option key={kind} value={kind}>
                                      {sourceNames[kind]}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              {m.source.kind === 'woo_meta' && (
                                <label>
                                  Dokładny klucz meta_data
                                  <input
                                    value={m.source.key}
                                    onChange={(e) =>
                                      editMapping(i, (old) => ({
                                        ...old,
                                        source: { kind: 'woo_meta', key: e.target.value },
                                      }))
                                    }
                                  />
                                </label>
                              )}
                              <label>
                                Brak wartości źródłowej
                                <select
                                  value={m.on_missing}
                                  onChange={(e) =>
                                    editMapping(i, (old) => ({
                                      ...old,
                                      on_missing: e.target.value as 'skip' | 'error',
                                    }))
                                  }
                                >
                                  <option value="error">Zablokuj wiersz wyjątkiem</option>
                                  <option value="skip">Pomiń jawnie i pokaż przyczynę</option>
                                </select>
                              </label>
                            </div>
                            {m.conversion.kind === 'direct' ? (
                              <p>
                                Bezpośrednia, dokładna wartość typu {typeNames[m.type]}. Bez
                                domyślnych wartości, konwersji float i zgadywania daty.
                              </p>
                            ) : (
                              <>
                                <label>
                                  Kształt źródła
                                  <select
                                    value={m.conversion.input}
                                    onChange={(e) =>
                                      editMapping(i, (old) => ({
                                        ...old,
                                        conversion:
                                          old.conversion.kind === 'option_map'
                                            ? {
                                                ...old.conversion,
                                                input: e.target.value as 'scalar' | 'array',
                                              }
                                            : old.conversion,
                                      }))
                                    }
                                  >
                                    <option value="scalar">Jeden dokładny kod tekstowy</option>
                                    {m.type === 'multi_select' && (
                                      <option value="array">Jawna tablica kodów tekstowych</option>
                                    )}
                                  </select>
                                </label>
                                {m.conversion.codes.map((code, j) => (
                                  <div className="ofm-dictionary" key={j}>
                                    <label>
                                      Kod źródła
                                      <input
                                        value={code.code}
                                        onChange={(e) =>
                                          editMapping(i, (old) => ({
                                            ...old,
                                            conversion:
                                              old.conversion.kind === 'option_map'
                                                ? {
                                                    ...old.conversion,
                                                    codes: old.conversion.codes.map((c, k) =>
                                                      j === k ? { ...c, code: e.target.value } : c,
                                                    ),
                                                  }
                                                : old.conversion,
                                          }))
                                        }
                                      />
                                    </label>
                                    <label>
                                      Własna opcja
                                      <select
                                        value={code.option_id}
                                        onChange={(e) =>
                                          editMapping(i, (old) => ({
                                            ...old,
                                            conversion:
                                              old.conversion.kind === 'option_map'
                                                ? {
                                                    ...old.conversion,
                                                    codes: old.conversion.codes.map((c, k) =>
                                                      j === k
                                                        ? { ...c, option_id: e.target.value }
                                                        : c,
                                                    ),
                                                  }
                                                : old.conversion,
                                          }))
                                        }
                                      >
                                        <option value="">Wybierz opcję</option>
                                        {options.map((o) => (
                                          <option key={o.id} value={o.id} disabled={!o.enabled}>
                                            {o.label}
                                            {!o.enabled ? ' (wycofana)' : ''}
                                          </option>
                                        ))}
                                      </select>
                                    </label>
                                    <button
                                      className="button"
                                      onClick={() =>
                                        editMapping(i, (old) => ({
                                          ...old,
                                          conversion:
                                            old.conversion.kind === 'option_map'
                                              ? {
                                                  ...old.conversion,
                                                  codes: old.conversion.codes.filter(
                                                    (_, k) => k !== j,
                                                  ),
                                                }
                                              : old.conversion,
                                        }))
                                      }
                                    >
                                      Usuń kod
                                    </button>
                                  </div>
                                ))}
                                <button
                                  className="button"
                                  disabled={m.conversion.codes.length >= 100}
                                  onClick={() =>
                                    editMapping(i, (old) => ({
                                      ...old,
                                      conversion:
                                        old.conversion.kind === 'option_map'
                                          ? {
                                              ...old.conversion,
                                              codes: [
                                                ...old.conversion.codes,
                                                { code: '', option_id: '' },
                                              ],
                                            }
                                          : old.conversion,
                                    }))
                                  }
                                >
                                  Dodaj dokładny kod
                                </button>
                                <p className="ofm-help">
                                  Nie dzielimy tekstu na listę. Kody są dokładne; bez dopasowania
                                  nazw i niejawnego obcinania spacji.
                                </p>
                              </>
                            )}
                            <button
                              className="button"
                              onClick={() =>
                                setDraft((d) =>
                                  d ? { ...d, mappings: d.mappings.filter((_, j) => i !== j) } : d,
                                )
                              }
                            >
                              Usuń mapowanie
                            </button>
                          </fieldset>
                        );
                      })}
                      <label>
                        Dodaj pole
                        <select
                          value=""
                          disabled={!draftChannel || draft.mappings.length >= 20}
                          onChange={(e) => {
                            const f = meta.definitions.find((f) => f.id === e.target.value);
                            if (f && draftChannel)
                              setDraft((d) =>
                                d
                                  ? {
                                      ...d,
                                      mappings: [
                                        ...d.mappings,
                                        newMapping(f, draftChannel.provider),
                                      ],
                                    }
                                  : d,
                              );
                          }}
                        >
                          <option value="">Wybierz pole ({draft.mappings.length}/20)</option>
                          {meta.definitions
                            .filter(
                              (f) => f.enabled && !draft.mappings.some((m) => m.field_id === f.id),
                            )
                            .map((f) => (
                              <option key={f.id} value={f.id}>
                                {f.label} — {typeNames[f.type]}
                              </option>
                            ))}
                        </select>
                      </label>
                      <label className="ofm-check">
                        <input
                          type="checkbox"
                          checked={profileReview}
                          onChange={(e) => setProfileReview(e.target.checked)}
                        />
                        Sprawdziłem kanał, definicje, źródła, słowniki i zachowanie przy braku
                        danych. Zatwierdzam tę wersję profilu.
                      </label>
                      <button
                        className="button primary"
                        disabled={!profileReview}
                        onClick={() => void saveProfile()}
                      >
                        Zapisz rewizję profilu
                      </button>
                      <button className="button" onClick={() => setDraft(null)}>
                        Zamknij szkic
                      </button>
                    </fieldset>
                    {draft.id && (
                      <button
                        className="button"
                        disabled={locked}
                        onClick={() => void profileDetail(draft.id!, false, true)}
                      >
                        Odczytaj aktualny profil, zachowaj szkic
                      </button>
                    )}
                    {latestProfile && (
                      <>
                        <Evidence
                          title="Aktualny zapisany profil do porównania"
                          value={latestProfile}
                        />
                        <button
                          className="button"
                          disabled={locked || !can('admin')}
                          onClick={() => {
                            setDraft({
                              id: latestProfile.id,
                              version: latestProfile.version,
                              channel_id: latestProfile.channel_id,
                              label: latestProfile.label,
                              enabled: latestProfile.enabled,
                              mappings: structuredClone(latestProfile.mappings),
                            });
                            setLatestProfile(null);
                          }}
                        >
                          Zastąp lokalny szkic aktualną wersją
                        </button>
                      </>
                    )}
                  </section>
                )}
              </>
            )}
            {(tab === 'initial' || tab === 'reconcile') && (
              <>
                <h3>
                  {tab === 'initial'
                    ? '1. Nowe zamówienie: wybór źródła i magazynu'
                    : '1. Istniejące zamówienia: jawny zakres uzgodnienia'}
                </h3>
                <div className="ofm-grid">
                  <label>
                    Własny kanał
                    <select
                      value={channelId}
                      disabled={locked}
                      onChange={(e) => changeChannel(e.target.value)}
                    >
                      <option value="">Wybierz kanał</option>
                      {meta.channels.map((c) => (
                        <option value={c.id} key={c.id}>
                          {c.name}
                          {c.simulation ? ' — DEMO' : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Profil i rewizja
                    <select
                      value={profileId}
                      disabled={locked || !channelId}
                      onChange={(e) => {
                        setProfileId(e.target.value);
                        setActiveProfile(null);
                        resetPlan();
                        setSources(null);
                        setInitialSource(null);
                        setSelectedSources({});
                        if (e.target.value) void profileDetail(e.target.value);
                      }}
                    >
                      <option value="">Wybierz i odczytaj profil</option>
                      {profileOptions.map((p) => (
                        <option key={p.id} value={p.id} disabled={!p.enabled}>
                          {p.label} · wersja {p.version}
                          {!p.enabled ? ' (wyłączony)' : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                  {tab === 'initial' ? (
                    <label>
                      Magazyn tworzenia zamówienia
                      <select
                        value={warehouse}
                        disabled={locked}
                        onChange={(e) => {
                          setWarehouse(e.target.value);
                          resetPlan();
                        }}
                      >
                        <option value="">Wybierz jawnie magazyn</option>
                        {meta.warehouses.map((w) => (
                          <option key={w.id} value={w.id}>
                            {w.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <label>
                      Polityka uzgodnienia
                      <select
                        value={policy}
                        disabled={locked}
                        onChange={(e) => {
                          setPolicy(e.target.value as typeof policy);
                          resetPlan();
                        }}
                      >
                        <option value="fill_unset">Uzupełnij wyłącznie nieustawione</option>
                        <option value="replace">Zastąp istniejące wartości</option>
                      </select>
                      <small>
                        Zero, pusty tekst i pusta lista są chronionymi istniejącymi wartościami.
                      </small>
                    </label>
                  )}
                </div>
                {channel && (
                  <p className="notice">
                    {channel.simulation
                      ? 'DEMO — lokalne dane syntetyczne; bez API dostawcy.'
                      : 'Kanał rzeczywisty. Ten panel odczytuje wyłącznie zapisane lokalne obserwacje; nie pobiera API dostawcy.'}
                  </p>
                )}
                {channel &&
                  meta.capabilities.find((c) => c.provider === channel.provider)
                    ?.verified_account_identity === false && (
                    <p className="ofm-help">
                      Ten adapter nie potwierdza tożsamości konta dostawcy. Podgląd wiąże zapisane
                      źródło z bieżącą lokalną konfiguracją kanału.
                    </p>
                  )}
                <div className="ofm-toolbar">
                  <button
                    className="button"
                    disabled={locked || !channelId}
                    onClick={() => void loadSources()}
                  >
                    Odczytaj lokalne źródła
                  </button>
                  {sources?.meta.cursor && (
                    <button
                      className="button"
                      disabled={locked}
                      onClick={() => void loadSources(sources.meta.cursor!)}
                    >
                      Następne 20 źródeł
                    </button>
                  )}
                </div>
                <p>
                  Brak obserwacji wymaga jawnego użycia „Pobierz zamówienia” w Integracjach po
                  aktywacji profilu. Nie podpisujemy historycznych danych nowym kontem.
                </p>
                <div className="ofm-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Wybór</th>
                        <th>ID w kanale</th>
                        <th>Stan</th>
                        <th>Obserwacja</th>
                        <th>Odczyt</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sources?.data.map((s) => (
                        <tr key={s.inbound_id}>
                          <td>
                            {tab === 'initial' ? (
                              <input
                                type="radio"
                                name="initial-source"
                                aria-label={'Wybierz źródło ' + s.external_id}
                                disabled={
                                  locked ||
                                  !can('import') ||
                                  !!s.order_id ||
                                  s.needs_observation ||
                                  !s.observation_id
                                }
                                checked={initialSource?.inbound_id === s.inbound_id}
                                onChange={() => {
                                  setInitialSource(s);
                                  resetPlan();
                                }}
                              />
                            ) : (
                              <input
                                type="checkbox"
                                aria-label={'Wybierz uzgodnienie ' + s.external_id}
                                disabled={
                                  locked ||
                                  !can('reconcile') ||
                                  !s.order_id ||
                                  s.needs_observation ||
                                  !s.observation_id ||
                                  (!selectedSources[s.inbound_id] &&
                                    Object.keys(selectedSources).length >= 100)
                                }
                                checked={!!selectedSources[s.inbound_id]}
                                onChange={(e) => {
                                  setSelectedSources((old) => {
                                    const a = { ...old };
                                    if (e.target.checked) a[s.inbound_id] = s;
                                    else delete a[s.inbound_id];
                                    return a;
                                  });
                                  resetPlan();
                                }}
                              />
                            )}
                          </td>
                          <td>
                            {s.external_id}
                            {s.order_id && (
                              <small> · już zaimportowano, wersja {s.order_version}</small>
                            )}
                          </td>
                          <td>{statuses[s.state] ?? s.state}</td>
                          <td>
                            {s.needs_observation
                              ? 'Wymaga ponownego pobrania zamówień'
                              : s.observed_at
                                ? date(s.observed_at)
                                : 'Brak obserwacji'}
                          </td>
                          <td>
                            {s.observation_id && (
                              <button
                                className="button"
                                disabled={locked}
                                onClick={() =>
                                  void read<Observation>(
                                    prefix + '/sources/' + s.observation_id,
                                    setObservation,
                                  )
                                }
                              >
                                Zaobserwowane wartości
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {observation && (
                  <section className="ofm-row">
                    <h3>Własna obserwacja źródła</h3>
                    <p>
                      Profil w obserwacji: wersja {observation.profile_version},{' '}
                      {date(observation.observed_at)}
                    </p>
                    {observation.issues.map((i, j) => (
                      <p className="ofm-error" key={j}>
                        {i.message} ({i.code})
                      </p>
                    ))}
                    <SourceValues values={observation.values} fields={meta.definitions} />
                    <Evidence
                      title="Dokładne mapowane wartości i dowód obserwacji"
                      value={observation}
                    />
                  </section>
                )}
                {tab === 'reconcile' && (
                  <details open>
                    <summary>
                      Wybrane do uzgodnienia: {Object.keys(selectedSources).length}/100
                    </summary>
                    <ul>
                      {Object.values(selectedSources).map((s) => (
                        <li key={s.inbound_id}>
                          {s.external_id} · wersja {s.order_version}
                          <button
                            className="button"
                            disabled={locked}
                            onClick={() => {
                              setSelectedSources((old) => {
                                const a = { ...old };
                                delete a[s.inbound_id];
                                return a;
                              });
                              resetPlan();
                            }}
                          >
                            Usuń z wyboru
                          </button>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                <button
                  className="button primary"
                  disabled={
                    locked || !can(tab === 'initial' ? 'import' : 'reconcile') || !activeProfile
                  }
                  onClick={() => void createPreview()}
                >
                  Utwórz niezmienny podgląd {tab === 'initial' ? 'importu' : 'uzgodnienia'}
                </button>
              </>
            )}
            {tab === 'history' && (
              <>
                {(['previews', 'executions'] as const).map((kind) => {
                  const h = kind === 'previews' ? previewHistory : executionHistory;
                  return (
                    <section key={kind}>
                      <h3>{kind === 'previews' ? 'Podglądy' : 'Wykonania i dowody importu'}</h3>
                      <button
                        className="button"
                        disabled={locked}
                        onClick={() =>
                          kind === 'previews'
                            ? void read<Page<Preview>>(prefix + '/previews', setPreviewHistory)
                            : void read<Page<ExecutionHead>>(
                                prefix + '/executions',
                                setExecutionHistory,
                              )
                        }
                      >
                        Odczytaj historię
                      </button>
                      <ul>
                        {h?.data.map((item) => (
                          <li key={item.id}>
                            <button
                              className="button"
                              disabled={locked}
                              onClick={() =>
                                kind === 'previews'
                                  ? void previewDetail(item.id)
                                  : void executionDetail(item.id)
                              }
                            >
                              {item.kind === 'initial' ? 'Import początkowy' : 'Uzgodnienie'}{' '}
                              {'state' in item ? statuses[String(item.state)] : ''}{' '}
                              {'created_at' in item ? date(String(item.created_at)) : ''}
                            </button>
                          </li>
                        ))}
                      </ul>
                      {h?.meta.cursor && (
                        <button
                          className="button"
                          disabled={locked}
                          onClick={() =>
                            kind === 'previews'
                              ? void read<Page<Preview>>(
                                  prefix +
                                    '/previews?' +
                                    new URLSearchParams({ cursor: h.meta.cursor! }),
                                  setPreviewHistory,
                                )
                              : void read<Page<ExecutionHead>>(
                                  prefix +
                                    '/executions?' +
                                    new URLSearchParams({ cursor: h.meta.cursor! }),
                                  setExecutionHistory,
                                )
                          }
                        >
                          Starsze 20 wpisów
                        </button>
                      )}
                    </section>
                  );
                })}
              </>
            )}
          </>
        )}
      </section>
      {attempt && (
        <section className="panel ofm-panel">
          <h3>
            {attempt.title}: {busy ? 'trwa próba' : 'odpowiedź niepewna'}
          </h3>
          <p>
            Treść i klucz próby są zamrożone. Ponowienie nie zmienia zgody, rewizji ani zakresu.
          </p>
          <Evidence title="Dokładna treść próby" value={attempt.body} />
          <label className="ofm-check">
            <input
              type="checkbox"
              disabled={busy || !can(attempt.permission)}
              checked={retryConsent}
              onChange={(e) => setRetryConsent(e.target.checked)}
            />
            Sprawdziłem ten sam zakres i chcę ponowić niezmienną próbę.
          </label>
          <button
            className="button primary"
            disabled={busy || !can(attempt.permission) || !retryConsent}
            onClick={() => void mutate(attempt, true)}
          >
            Ponów tę samą próbę
          </button>
          <p>
            Zamknięcie strony porzuca jedynie lokalną pamięć próby, nie anuluje możliwego
            zatwierdzonego skutku.
          </p>
        </section>
      )}
      {preview && (
        <section className="panel ofm-panel">
          <div className="panel-heading">
            <div>
              <h2>
                2. Zamrożony podgląd{' '}
                {preview.kind === 'initial' ? 'importu początkowego' : 'uzgodnienia'}
              </h2>
              <p>
                {preview.profile_snapshot.label} · rewizja {preview.profile_snapshot.version} ·
                ważny do {date(preview.expires_at)}
              </p>
            </div>
            <button
              className="button"
              disabled={locked}
              onClick={() => void previewDetail(preview.id)}
            >
              Odczytaj ponownie / wyczyść wybór
            </button>
          </div>
          <p>Zmiana szkicu nie zmienia tego planu. Nowe dane wymagają nowego podglądu.</p>
          {preview.kind === 'initial' && (
            <p className="notice">
              Import tworzy jedno lokalne zamówienie, jego pozycje, rezerwacje oraz mapowane pola w
              tej samej transakcji. Magazyn:{' '}
              {meta?.warehouses.find((w) => w.id === preview.warehouse_id)?.name ??
                'wybrany w planie'}
              . Ponowienie tej samej próby nie tworzy drugiego zamówienia ani nie stosuje nowego
              profilu.
            </p>
          )}
          <div className="ofm-summary">
            {Object.entries(preview.summary).map(([k, v]) => (
              <span key={k}>
                {(
                  {
                    total: 'Wiersze',
                    ready: 'Gotowe',
                    no_op: 'Bez zmiany',
                    invalid: 'Błędne',
                    conflict: 'Konflikty',
                  } as Record<string, string>
                )[k] ?? k}
                : <strong>{v}</strong>
              </span>
            ))}
          </div>
          <label className="ofm-check">
            <input
              type="checkbox"
              checked={exceptions}
              onChange={(e) => setExceptions(e.target.checked)}
            />
            Wyłącznie wyjątki na bieżącej stronie
          </label>
          <p>
            Bieżąca strona: {rows.length}/{preview.summary.total} wierszy; wybór uzgodnienia:{' '}
            {Object.keys(selectedRows).length}/100.
          </p>
          {(exceptions ? rows.filter((r) => ['invalid', 'conflict'].includes(r.status)) : rows).map(
            (r) => (
              <article className="ofm-row" key={r.row_id}>
                <h3>
                  {preview.kind === 'reconcile' && (
                    <input
                      type="checkbox"
                      aria-label={'Zatwierdź wiersz ' + r.external_id}
                      checked={!!selectedRows[r.row_id]}
                      disabled={
                        locked ||
                        !can('reconcile') ||
                        !['ready', 'no_op'].includes(r.status) ||
                        (!selectedRows[r.row_id] && Object.keys(selectedRows).length >= 100)
                      }
                      onChange={(e) =>
                        setSelectedRows((old) => {
                          const a = { ...old };
                          if (e.target.checked) a[r.row_id] = r;
                          else delete a[r.row_id];
                          return a;
                        })
                      }
                    />
                  )}{' '}
                  {r.order_number ?? r.external_id} · {statuses[r.status]}
                </h3>
                {r.issues.map((i, j) => (
                  <p className="ofm-error" key={j}>
                    {i.message} ({i.code})
                  </p>
                ))}
                {preview.kind === 'initial' &&
                  (r.order_summary ? (
                    <OrderSummary summary={r.order_summary} warehouses={meta?.warehouses ?? []} />
                  ) : (
                    <p className="ofm-error">
                      Ten podgląd nie zawiera szczegółów zamówienia. Przygotuj nowy podgląd przed
                      zgodą na import.
                    </p>
                  ))}
                <RowEvidence row={r} fields={preview.definitions_snapshot} />
              </article>
            ),
          )}
          {preview.meta.cursor && (
            <button
              className="button"
              disabled={locked}
              onClick={() => void previewDetail(preview.id, preview.meta.cursor!, true)}
            >
              Następne 50 wierszy / zachowaj wybór
            </button>
          )}
          {preview.kind === 'reconcile' && (
            <details open>
              <summary>Dokładnie wybrane wiersze: {Object.keys(selectedRows).length}</summary>
              {Object.values(selectedRows).map((r) => (
                <details key={r.row_id}>
                  <summary>
                    {r.order_number ?? r.external_id} · wersja {r.order_version}
                  </summary>
                  <RowEvidence row={r} fields={preview.definitions_snapshot} />
                  <button
                    className="button"
                    disabled={locked}
                    onClick={() =>
                      setSelectedRows((old) => {
                        const a = { ...old };
                        delete a[r.row_id];
                        return a;
                      })
                    }
                  >
                    Usuń z zatwierdzanego zakresu
                  </button>
                </details>
              ))}
            </details>
          )}
          <Evidence
            title="Techniczny dowód zakresu, profil, źródła i wybór"
            value={{
              scope_hash: preview.scope_hash,
              profile: preview.profile_snapshot,
              warehouse_id: preview.warehouse_id,
              policy: preview.policy,
              selected_rows: Object.keys(selectedRows).sort(),
            }}
          />
          <label className="ofm-check">
            <input
              type="checkbox"
              checked={consent}
              disabled={
                locked ||
                !can(preview.kind === 'initial' ? 'import' : 'reconcile') ||
                (preview.kind === 'initial' &&
                  (preview.summary.total !== 1 ||
                    rows.length !== 1 ||
                    !rows.every(
                      (r) => ['ready', 'no_op'].includes(r.status) && !!r.order_summary,
                    ))) ||
                (preview.kind === 'reconcile' && !Object.keys(selectedRows).length)
              }
              onChange={(e) => setConsent(e.target.checked)}
            />
            {preview.kind === 'initial'
              ? 'Zatwierdzam utworzenie tego jednego zamówienia, rezerwacji i pokazanych mapowanych pól w wybranym magazynie.'
              : `Zatwierdzam dokładnie ${Object.keys(selectedRows).length} wybranych wierszy: ${preview.policy === 'replace' ? 'zastąpienie pokazanych wartości' : 'uzupełnienie tylko nieustawionych wartości'}.`}{' '}
            Zapis wyłącznie lokalny.
          </label>
          <p>
            Zmiana źródła, konta, profilu, definicji, zamówienia lub uprawnień blokuje nieaktualny
            plan. Wybrane uzgodnienie jest atomowe: konflikt jednego wiersza cofa cały zakres.
          </p>
          <button
            className="button primary"
            disabled={
              locked ||
              !can(preview.kind === 'initial' ? 'import' : 'reconcile') ||
              !consent ||
              new Date(preview.expires_at).getTime() <= Date.now()
            }
            onClick={() => void approve()}
          >
            {preview.kind === 'initial'
              ? 'Importuj jedno zamówienie z mapowanymi polami'
              : 'Zatwierdź wybrane uzgodnienie i dodaj do kolejki'}
          </button>
        </section>
      )}
      {execution && (
        <section className="panel ofm-panel">
          <div className="panel-heading">
            <div>
              <h2>{execution.kind === 'initial' ? 'Dowód importu' : 'Wynik uzgodnienia'}</h2>
              <p>
                {statuses[execution.state]} · {execution.selected_count} wierszy
              </p>
            </div>
            <button
              className="button"
              disabled={locked}
              onClick={() => void executionDetail(execution.id)}
            >
              Odczytaj stan lokalny
            </button>
          </div>
          {importedOrder?.execution_id === execution.id && (
            <p>
              Utworzono zamówienie {importedOrder.number}, wersja {importedOrder.version}.
            </p>
          )}
          {execution.error && <p className="ofm-error">{execution.error}</p>}
          {execution.data.map((r) => (
            <article key={r.row_id} className="ofm-row">
              <h3>{r.order_number ?? r.external_id}</h3>
              <p>
                {r.result
                  ? r.result.changed
                    ? 'Zapisano pokazane zmiany'
                    : 'Bez zmiany wartości'
                  : execution.state === 'queued'
                    ? 'W kolejce — oczekuje na wykonanie'
                    : 'Patrz końcowy dowód wykonania'}
                {r.result ? ` · wersja zamówienia ${r.result.order_version}` : ''}
              </p>
              <RowEvidence row={r} fields={meta?.definitions ?? []} />
            </article>
          ))}
          <Evidence title="Niezmienny wynik, dowód wykonania i zgoda" value={execution} />
          {execution.kind === 'reconcile' && execution.state === 'queued' && (
            <button
              className="button"
              disabled={locked || !can('reconcile')}
              onClick={() =>
                void mutate({
                  path: prefix + '/executions/' + execution.id + '/cancel',
                  method: 'POST',
                  body: {},
                  permission: 'reconcile',
                  title: 'Anulowanie przed zapisem',
                  success: () => executionDetail(execution.id),
                })
              }
            >
              Anuluj przed zatwierdzeniem efektu
            </button>
          )}
          <p>
            Odczyt stanu nie wywołuje dostawcy. Zatwierdzonego importu lub wykonanego uzgodnienia
            nie można anulować po fakcie.
          </p>
        </section>
      )}
    </div>
  );
}
