import { SMSAPI_STATUS_NAMES, type SmsDeliveryCode } from '../server/sms-delivery-status';
const labels: Record<SmsDeliveryCode, string> = {
  401: 'Raport niedostępny',402:'Przedawniona',403:'Wysłana — brak potwierdzenia doręczenia',
  404:'Doręczona',405:'Niedoręczona',406:'Błąd wysyłki',407:'Odrzucona',408:'Brak potwierdzenia',
  409:'W kolejce dostawcy',410:'Przyjęta przez operatora',411:'Ponawianie',412:'Zatrzymana',
};
export function SmsDeliveryStatus({ mode, delivery }: { mode: string; delivery?: { status_code: number | null; needs_reconciliation: boolean } | null }) {
  if (mode === 'local' || mode === 'provider_test') return <small>Bez doręczenia — {mode === 'local' ? 'symulacja' : 'test SMSAPI'}</small>;
  if (mode !== 'provider_live') return <small>Raport doręczenia niedostępny dla tego trybu</small>;
  if (!delivery || delivery.status_code === null) return <small>Brak raportu doręczenia</small>;
  const code = delivery.status_code as SmsDeliveryCode;
  return <small role="status">{Object.hasOwn(SMSAPI_STATUS_NAMES,code) ? labels[code] : 'Nieznany raport'}{delivery.needs_reconciliation ? ' · wymaga sprawdzenia' : ''}</small>;
}
import React from 'react';
