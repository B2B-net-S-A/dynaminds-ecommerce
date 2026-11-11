/** Per-section editing on the order card (Uwagi v3 §6): a card with its own "✎ Edytuj", the form in
 * place of the card body, a padlock with the reason when the section is locked, the confirm dialog
 * listing only this section's changes and the "Zapisz / Porzuć zmiany" question when another
 * section is opened. State lives in the card (OrderDetail); these pieces only render it. */
import type { ReactNode } from 'react';
import { Lock } from 'lucide-react';
import type { OrderSection, SectionChange, SectionLock, SectionLocks } from '../shared/order-sections';
import { Dialog } from './order-detail-parts';
import { SECTION_FIELDS, sectionLabel, type Draft, type EditableSection, type EditState } from './order-card-model';

export interface SectionControl {
  edit: EditState | null;
  locks: SectionLocks;
  /** Writes allowed at all (role, read-only preview, card custody). */
  canEdit: boolean;
  busy: boolean;
  errors: string[];
  onEdit: (section: OrderSection) => void;
  onDraft: (draft: Draft) => void;
  onCancel: () => void;
  onSave: () => void;
  onLockAction: (lock: SectionLock) => void;
}

const LOCK_ACTIONS: Record<NonNullable<SectionLock['action']>, string> = {
  cancel_label: 'Przejdź do etykiety',
  correction: 'Wystaw korektę',
};
export function SectionLockNote({ lock, onAction }: { lock: SectionLock; onAction: (lock: SectionLock) => void }) {
  return (
    <span className="order-section-lock" title={lock.reason}>
      <Lock size={13} aria-hidden="true" />
      <span>{lock.reason ?? 'Sekcja zablokowana'}</span>
      {lock.action && (
        <button type="button" className="text-button" onClick={() => onAction(lock)}>
          {LOCK_ACTIONS[lock.action]}
        </button>
      )}
    </span>
  );
}

/** "✎ Edytuj" or the padlock, for a section heading. */
export function SectionEditControl({ section, control, label = '✎ Edytuj' }: { section: OrderSection; control: SectionControl; label?: string }) {
  const lock = control.locks[section];
  if (lock?.locked) return <SectionLockNote lock={lock} onAction={control.onLockAction} />;
  if (!control.canEdit || control.edit?.section === section) return null;
  return (
    <button type="button" className="text-button order-section-edit" disabled={control.busy} aria-label={`Edytuj: ${sectionLabel(section)}`} onClick={() => control.onEdit(section)}>
      {label}
    </button>
  );
}

export function SectionForm({ section, control }: { section: EditableSection; control: SectionControl }) {
  const draft = control.edit?.draft ?? {};
  const set = (field: string, value: string | boolean) => control.onDraft({ ...draft, [field]: value });
  return (
    <form
      className="order-section-form"
      noValidate
      aria-label={`Edycja: ${sectionLabel(section)}`}
      onSubmit={(e) => {
        e.preventDefault();
        control.onSave();
      }}
    >
      {SECTION_FIELDS[section].map((f, i) =>
        f.kind === 'checkbox' ? (
          <label key={f.field} className="order-section-check">
            <input type="checkbox" checked={Boolean(draft[f.field])} onChange={(e) => set(f.field, e.target.checked)} />
            {f.label}
          </label>
        ) : (
          <label key={f.field}>
            {f.label}
            {f.kind === 'select' ? (
              <select value={String(draft[f.field] ?? '')} onChange={(e) => set(f.field, e.target.value)} autoFocus={i === 0}>
                {f.options?.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            ) : f.kind === 'textarea' ? (
              <textarea value={String(draft[f.field] ?? '')} maxLength={f.max} rows={3} onChange={(e) => set(f.field, e.target.value)} autoFocus={i === 0} />
            ) : (
              <input
                value={String(draft[f.field] ?? '')}
                type={f.kind === 'date' ? 'date' : f.kind === 'email' ? 'email' : 'text'}
                inputMode={f.kind === 'money' ? 'decimal' : f.kind === 'tel' ? 'tel' : undefined}
                maxLength={f.max}
                onChange={(e) => set(f.field, e.target.value)}
                autoFocus={i === 0}
              />
            )}
          </label>
        ),
      )}
      {control.errors.length > 0 && (
        <ul className="error" role="alert">
          {control.errors.map((x) => <li key={x}>{x}</li>)}
        </ul>
      )}
      <div className="order-form-actions">
        <button type="button" className="button" onClick={control.onCancel}>Anuluj</button>
        <button className="button primary" disabled={control.busy}>Zapisz {sectionLabel(section).toLowerCase()}</button>
      </div>
    </form>
  );
}

/** A right-column card: heading with the edit control, then either the view or the form. */
export function SectionCard({ section, title, control, children, aside, className }: {
  section: EditableSection;
  title: string;
  control: SectionControl;
  children: ReactNode;
  aside?: ReactNode;
  className?: string;
}) {
  const editing = control.edit?.section === section;
  return (
    <section className={'panel order-section-card' + (className ? ' ' + className : '') + (editing ? ' editing' : '')} aria-label={title}>
      <div className="panel-heading">
        <h2>{title}</h2>
        <div className="order-section-heading-actions">
          {aside}
          <SectionEditControl section={section} control={control} />
        </div>
      </div>
      <div className="info-body">{editing ? <SectionForm section={section} control={control} /> : children}</div>
    </section>
  );
}

export function SectionConfirmDialog({ section, changes, notes, busy, onBack, onConfirm }: {
  section: OrderSection;
  changes: SectionChange[];
  notes: string[];
  busy: boolean;
  onBack: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog title={`Zapisać zmiany: ${sectionLabel(section)}?`} onClose={onBack} className="order-section-confirm">
      <div className="form-body">
        <ul className="order-change-list">
          {changes.map((c) => (
            <li key={c.field}>
              <strong>{c.label}:</strong> <span className="before">{c.before}</span> → <span className="after">{c.after}</span>
            </li>
          ))}
        </ul>
        {notes.map((n) => (
          <p key={n} className="notice">{n}</p>
        ))}
        <div className="order-form-actions">
          <button type="button" className="button" onClick={onBack}>Wróć</button>
          <button type="button" className="button primary" disabled={busy} onClick={onConfirm} autoFocus>Zapisz</button>
        </div>
      </div>
    </Dialog>
  );
}

export function SectionSwitchDialog({ from, to, onSave, onDiscard, onClose }: {
  from: OrderSection;
  to: OrderSection;
  onSave: () => void;
  onDiscard: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog title="Niezapisane zmiany" onClose={onClose}>
      <div className="form-body">
        <p>
          W sekcji „{sectionLabel(from)}” są niezapisane zmiany. Zapisz je albo porzuć, zanim zaczniesz edytować „{sectionLabel(to)}”.
        </p>
        <div className="order-form-actions">
          <button type="button" className="button danger" onClick={onDiscard}>Porzuć zmiany</button>
          <button type="button" className="button primary" onClick={onSave} autoFocus>Zapisz</button>
        </div>
      </div>
    </Dialog>
  );
}
