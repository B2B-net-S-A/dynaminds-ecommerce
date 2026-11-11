// uwaga klienta §7 (migration 266): "Drukuj etykietę przy pakowaniu" — the DEMO label right after packing, per company.
import { useEffect, useState } from 'react';
import { Printer } from 'lucide-react';
import { api } from './api';

interface OrderSettings {
  available: boolean;
  print_label_at_packing: boolean;
  version: number;
  read_only: boolean;
}
interface Props {
  admin: boolean;
  readOnly: boolean;
}

export function OrderPackingLabelSetting({ admin, readOnly }: Props) {
  const [s, setS] = useState<OrderSettings | null>(null),
    [error, setError] = useState(''),
    [info, setInfo] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    api<OrderSettings>('/order-settings')
      .then((v) => active && setS(v))
      .catch((e) => active && setError(e.message));
    return () => { active = false; };
  }, []);
  if (!s) return error ? <p className="notice error" role="alert">{error}</p> : null;
  if (!s.available) return null;
  const locked = !admin || readOnly || s.read_only || busy;
  async function toggle(next: boolean) {
    if (locked || !s) return;
    setBusy(true);
    setError('');
    setInfo('');
    try {
      const saved = await api<OrderSettings>('/order-settings', 'PUT', { print_label_at_packing: next, version: s.version });
      setS(saved);
      setInfo(saved.print_label_at_packing ? 'Włączono: etykieta DEMO powstanie po spakowaniu zamówienia.' : 'Wyłączono drukowanie etykiety przy pakowaniu.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel" aria-label="Etykieta przy pakowaniu">
      <div className="panel-heading">
        <h2><Printer size={18} /> Etykieta przy pakowaniu</h2>
        <span>{s.print_label_at_packing ? 'Włączone' : 'Wyłączone'}</span>
      </div>
      <div className="shipping-body">
        {error && <p className="notice error" role="alert">{error}</p>}
        {info && <p className="notice" role="status">{info}</p>}
        <label className="check" style={{ display: 'flex', flexDirection: 'row', gap: 10, alignItems: 'center', fontWeight: 600 }}>
          <input
            type="checkbox"
            style={{ width: 'auto', margin: 0 }}
            checked={s.print_label_at_packing}
            disabled={locked}
            onChange={(e) => void toggle(e.target.checked)}
          />
          Drukuj etykietę przy pakowaniu
        </label>
        <p className="muted">
          Po zeskanowaniu ostatniego produktu i spakowaniu zamówienie dostaje etykietę DEMO i ma etap „Gotowe do nadania”.
          Dotyczy tylko przewoźnika DEMO (bez wybranego przewoźnika albo „Symulator lokalny”). Dla prawdziwych przewoźników
          (np. DPD, InPost) etykieta nie powstaje automatycznie, bo prawdziwa etykieta kosztuje — utworzysz ją ręcznie w karcie zamówienia.
        </p>
        {!admin && <p className="muted">Ustawienie zmienia administrator.</p>}
      </div>
    </section>
  );
}
