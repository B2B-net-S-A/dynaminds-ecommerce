import { useState, type FormEvent } from "react";
import { api } from "./api";

export type OutcomeItem = {
  domain: "sms" | "email";
  id: string;
  label: string;
  order_number?: string | null;
};
type Batch = { id: string; mode: string; items: any[] };
const recipient = (domain: string, m: any) =>
  (domain === "sms" ? m?.recipient : m?.payload?.recipient) ?? "—";
const content = (domain: string, m: any) =>
  (domain === "sms" ? m?.payload : m?.payload?.subject) ?? "";
// A live SMS or an external SMTP account sends outside the app; that needs its own explicit consent.
const external = (domain: string, b: Batch) =>
  domain === "sms"
    ? b.mode === "provider_live"
    : b.mode === "smtp" && b.items[0]?.sender?.local_sink !== true;
const message = (e: unknown) =>
  e instanceof Error ? e.message : "Nie udało się zapisać decyzji";

/** AUTO-04: the operator records what the provider shows for an SMS or email whose send started and
 * returned no result. "Not sent" offers a new send: a new preview (new message id, so a new provider
 * idempotency key) that goes out only after its own approval. Nothing is retried automatically. */
export function MessageOutcomeDecision({
  item,
  onClose,
  onDecided,
}: {
  item: OutcomeItem;
  onClose: () => void;
  onDecided: () => void;
}) {
  const [outcome, setOutcome] = useState<"sent" | "not_sent">("sent"),
    [ref, setRef] = useState(""),
    [evidence, setEvidence] = useState(""),
    [checked, setChecked] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notSent, setNotSent] = useState(false),
    [key] = useState(() => crypto.randomUUID()),
    [batch, setBatch] = useState<Batch | null>(null),
    [consent, setConsent] = useState(false),
    [queued, setQueued] = useState(false);
  async function step(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  const base =
    "/operations/reconciliation-queue/" + item.domain + "/" + item.id;
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!checked) return;
    void step(async () => {
      await api(base + "/decision", "POST", {
        outcome,
        evidence: evidence.trim(),
        confirmed: true,
        ...(outcome === "sent" && ref.trim()
          ? { provider_ref: ref.trim() }
          : {}),
      });
      onDecided();
      if (outcome === "not_sent") setNotSent(true);
      else onClose();
    });
  };
  const draft = batch?.items[0];
  return (
    <section className="ops-decision" aria-label="Wynik wiadomości">
      <h3>Wynik sprawdzony u dostawcy: {item.label}</h3>
      {error && (
        <p className="notice import-error" role="alert">
          {error}
        </p>
      )}
      {!notSent && (
        <form className="form-grid shipping-form dpd-form" onSubmit={submit}>
          <p className="full-field muted">
            To ręczne potwierdzenie na podstawie panelu dostawcy. Aplikacja nie
            pyta dostawcy i nie ponawia wysyłki.
          </p>
          <label>
            Wynik u dostawcy
            <select
              name="outcome"
              value={outcome}
              onChange={(e) =>
                setOutcome(e.target.value as "sent" | "not_sent")
              }
            >
              <option value="sent">Dostawca potwierdza wysłanie</option>
              <option value="not_sent">
                Dostawca potwierdza, że nie wysłano
              </option>
            </select>
          </label>
          {outcome === "sent" && (
            <label>
              Identyfikator u dostawcy (jeśli znany)
              <input
                name="provider_ref"
                maxLength={200}
                value={ref}
                onChange={(e) => setRef(e.target.value)}
              />
            </label>
          )}
          <label>
            Co i gdzie sprawdzono
            <textarea
              name="evidence"
              minLength={10}
              maxLength={500}
              required
              value={evidence}
              onChange={(e) => setEvidence(e.target.value)}
            />
          </label>
          <label className="shipping-check full-field">
            <input
              name="confirmed"
              type="checkbox"
              required
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
            />
            Sprawdziłem wynik u dostawcy i potwierdzam jego zgodność.
          </label>
          <div className="full-field shipping-actions">
            <button
              className="button primary"
              disabled={busy || !checked || evidence.trim().length < 10}
            >
              Zapisz decyzję
            </button>
            <button type="button" className="button" onClick={onClose}>
              Zamknij
            </button>
          </div>
        </form>
      )}
      {notSent && !batch && (
        <div>
          <p className="notice" role="status">
            Zapisano: nie wysłano. Nowa wysyłka dostanie nowy identyfikator i
            wymaga osobnego zatwierdzenia.
          </p>
          <div className="shipping-actions">
            <button
              className="button"
              disabled={busy}
              onClick={() =>
                void step(async () =>
                  setBatch(
                    await api(base + "/retry", "POST", { client_key: key }),
                  ),
                )
              }
            >
              Przygotuj ponowną wysyłkę
            </button>
            <button type="button" className="button" onClick={onClose}>
              Zamknij
            </button>
          </div>
        </div>
      )}
      {batch && !queued && (
        <div>
          <p className="notice" role="status">
            Podgląd nowej wysyłki do {recipient(item.domain, draft)}
            {draft?.state === "invalid"
              ? " — nie można wysłać: " + (draft.error ?? "błędne dane")
              : ""}
          </p>
          {draft?.state === "draft" && (
            <p className="muted">{content(item.domain, draft)}</p>
          )}
          {external(item.domain, batch) && (
            <label className="shipping-check">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
              />
              Potwierdzam zewnętrzną wysyłkę do odbiorcy.
            </label>
          )}
          <div className="shipping-actions">
            <button
              className="button primary"
              disabled={
                busy ||
                draft?.state !== "draft" ||
                (external(item.domain, batch) && !consent)
              }
              onClick={() =>
                void step(async () => {
                  await api(
                    "/" + item.domain + "/batches/" + batch.id + "/queue",
                    "POST",
                    {
                      confirmed: true,
                      ...(external(item.domain, batch)
                        ? { confirm_external: true }
                        : {}),
                    },
                  );
                  setQueued(true);
                })
              }
            >
              Wyślij ponownie
            </button>
            <button type="button" className="button" onClick={onClose}>
              Zamknij
            </button>
          </div>
        </div>
      )}
      {queued && (
        <div>
          <p className="notice" role="status">
            Nowa wysyłka jest w kolejce jako osobna wiadomość. Pierwotna zostaje
            oznaczona jako niewysłana.
          </p>
          <button type="button" className="button" onClick={onClose}>
            Zamknij
          </button>
        </div>
      )}
    </section>
  );
}
