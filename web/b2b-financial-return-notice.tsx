/** Source-only162 presentation. Caller supplies a row from a complete native
 * source validated under current actor/epoch. No amount/PZ inference or writes. */
import type {AcceptedReturn} from './b2b-correction-model';
import {cash} from './b2b-correction-model';
export function B2bFinancialReturnNotice({acceptance:a,readOnly}:{acceptance:AcceptedReturn;readOnly:boolean}){
 if(a.acceptance_kind!=='financial_no_restock')return null;
 return <aside className="notice" role="status" style={{display:'block'}} aria-label="Zwrot finansowy bez przywrócenia zapasu">
  <strong>Zwrot finansowy bez przywrócenia zapasu</strong>
  <p>{a.number} · przyjęcie {a.receipt_sequence} · {a.received_at}</p>
  <p>Uznana kwota zwrotu: {cash(a.refund_amount_minor)}. W tym zwrot dostawy: {cash(a.refunded_shipping_minor)}.</p>
  <p>Uznane sztuki nie zostały przywrócone do zapasu. Ten dowód nie jest dokumentem PZ.</p>
  <p>Uznanie kwoty nie potwierdza wypłaty. Korekta wymaga osobnego podglądu i zgody; nie jest przesyłana do KSeF.</p>
  {readOnly&&<p>Kopia tylko do odczytu — zapisane przyjęcie i pełną historię można przeglądać. Podgląd i wystawienie korekty są wyłączone.</p>}
 </aside>;
}
