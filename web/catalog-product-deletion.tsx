import { useState } from 'react';
import { api, ApiError } from './api';
import { productDeletionBody, readProductDeletion, type ProductDeletion } from './catalog-list-model';

/** In-card confirmation of POST /products/:id/deletion; the card stays open on any refusal. */
export function ProductDeletionConfirm({
  product,
  blocked,
  cancel,
  onBusyChange,
  deleted,
}: {
  product: { id: string; sku: string; name: string; version: number };
  blocked: boolean;
  cancel: () => void;
  onBusyChange: (busy: boolean) => void;
  deleted: (result: ProductDeletion) => void;
}) {
  const [reason, setReason] = useState(''),
    [busy, setBusy] = useState(false),
    [refused, setRefused] = useState(false),
    [error, setError] = useState('');
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy || blocked || refused) return;
    setError('');
    let body;
    try {
      body = productDeletionBody(product.version, reason);
    } catch (err) {
      setError((err as Error).message);
      return;
    }
    setBusy(true);
    onBusyChange(true);
    try {
      const result = readProductDeletion(await api('/products/' + product.id + '/deletion', 'POST', body), product.id);
      deleted(result);
    } catch (err) {
      setError((err as Error).message);
      // Denied access, a missing migration or an already deleted product will not change on retry.
      if (err instanceof ApiError && [401, 403, 404, 423, 503].includes(err.status)) setRefused(true);
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  }
  return (
    <form onSubmit={submit}>
      <div className="form-body">
        <p>
          Usuwasz produkt <strong>{product.sku}</strong> · {product.name}.
        </p>
        <ul className="catalog-description">
          <li>Produkt zniknie z katalogu, z wyszukiwarek produktów w formularzach i z Base API.</li>
          <li>Zamówienia, zwroty i dokumenty, które go zawierają, zachowają jego dane.</li>
          <li>SKU {product.sku} pozostanie zarezerwowane i nie da się go użyć dla nowego produktu.</li>
          <li>Tej operacji nie można cofnąć.</li>
        </ul>
        <label>
          Powód usunięcia (opcjonalnie)
          <textarea
            value={reason}
            maxLength={500}
            rows={3}
            disabled={busy}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        {error && (
          <div className="notice import-error" role="alert">
            {error}
          </div>
        )}
      </div>
      <div className="form-footer inline-actions">
        <button type="button" className="button" disabled={busy} onClick={cancel}>
          Anuluj
        </button>
        <button className="button danger" disabled={busy || blocked || refused}>
          {busy ? 'Usuwanie…' : 'Usuń produkt'}
        </button>
      </div>
    </form>
  );
}
