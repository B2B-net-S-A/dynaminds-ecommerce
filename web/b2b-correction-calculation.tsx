/** SOURCE_ONLY readonly projection. Supplied pure calculation is not native authority. */
import React from 'react';
import type {B2bCorrectionCalculation,CorrectionMoney,CorrectionAmounts} from '../server/b2b-credit-arithmetic';
import './b2b-corrections.css';
export type B2bCorrectionViewProps={calculation:B2bCorrectionCalculation|null;issued?:boolean};
function cash(value:string){const n=BigInt(value),absolute=n<0n?-n:n;return `${n<0n?'-':''}${absolute/100n},${String(absolute%100n).padStart(2,'0')} PLN`;}
function MoneyCells({money}:{money:CorrectionMoney}){return <><td>{cash(money.gross_minor)}</td><td>{cash(money.net_minor)}</td><td>{cash(money.vat_minor)}</td></>;}
function AmountCells({amount}:{amount:CorrectionAmounts}){return <><td>{amount.quantity}</td><MoneyCells money={amount}/></>;}
function CompareHeaders({quantities=false}:{quantities?:boolean}){const labels=quantities?['Ilość','Brutto','Netto','VAT']:['Brutto','Netto','VAT'];return <tr>{['Przed','Po','Zmiana'].flatMap(group=>labels.map(label=><th key={group+label} scope="col">{group}: {label}</th>))}</tr>;}
function Party({party,label}:{party:B2bCorrectionCalculation['fiscal_snapshot']['buyer'];label:string}){return <section aria-label={label}><h3>{label}</h3><p><strong>{party.name}</strong><br/>NIP: {party.tax_id}<br/>{party.address.line1}<br/>{party.address.line2}<br/>{party.address.country}</p></section>;}
export function B2bInvoiceCorrectionView({calculation:c,issued=false}:B2bCorrectionViewProps){
 if(!c)return <section className="b2b-correction-view"><h2>Obliczenie korekty B2B</h2><p>Brak obliczenia do wyświetlenia.</p></section>;
 return <section className="b2b-correction-view" aria-label="Pełne rozliczenie korekty B2B">
  <h2>Obliczenie korekty B2B</h2><p className="b2b-correction-notice" role="status"><strong>{issued?'Historyczne obliczenie wydanej korekty.':'Podgląd bez numeru korekty.'}</strong> Zwrot płatności i wysłanie do KSeF wymagają odrębnych procesów.</p>
  <p>Faktura źródłowa: <strong>{c.original.number}</strong>. Wybrany zwrot: <strong>{c.acceptance.number}</strong>, kolejność przyjęcia {c.acceptance.receipt_sequence}, zapis przyjęcia {c.acceptance.received_at}. Waluta: {c.currency}. Metoda VAT: zaokrąglenie połowy w górę od brutto pozycji.</p>
  <div className="b2b-correction-parties"><Party label="Zapisany sprzedawca" party={c.fiscal_snapshot.seller}/><Party label="Zapisany nabywca fakturowy" party={c.fiscal_snapshot.buyer}/></div>
  <h3>Pełne pozycje — przed, po i zmiana</h3><p>Dane pozycji i stron pochodzą z zapisanej faktury źródłowej. Wiersze bez zmiany pozostają w zestawieniu.</p>
  <p className="b2b-correction-notice">Dostawa jest korektą wartości. Jej ilość pozostaje 1, a zmiana ilości 0 także po wyzerowaniu kwoty. Ilość przyjęta służy rozliczeniu handlowemu; ilość odtworzona w magazynie nie wyznacza kwot netto ani VAT.</p>
  <div className="b2b-correction-scroll" tabIndex={0} role="region" aria-label="Wszystkie pozycje obliczenia">
   <table className="b2b-correction-rows"><caption>{c.rows.length} pełnych pozycji faktury źródłowej</caption><thead><tr><th rowSpan={2} scope="col">Pozycja i zapisane dane</th>{['Przed','Po','Zmiana'].map(x=><th key={x} colSpan={4} scope="colgroup">{x}</th>)}</tr><CompareHeaders quantities/></thead><tbody>
    {c.rows.map(r=><tr key={r.line_id} data-line-id={r.line_id} data-source-item-id={r.source_item_id??''} data-kind={r.kind} data-affected={String(r.affected)}>
     <th scope="row"><span className="b2b-correction-name">{r.ordinal}. {r.name}</span><small>{r.unit} · VAT {r.vat_code==='0 KR'?'0% krajowe':r.vat_code+'%'} · {r.affected?'Pozycja zmieniona':'Bez zmiany'}</small>{r.zero_domestic_basis!==null&&<small>Podstawa stawki 0: {r.zero_domestic_basis}</small>}{r.kind==='shipping'&&<small>Dostawa — tylko korekta wartości</small>}</th>
     <AmountCells amount={r.before}/><AmountCells amount={r.after}/><AmountCells amount={r.delta}/>
    </tr>)}
   </tbody></table>
  </div>
  <h3>Pełne kwoty dokumentu</h3><div className="b2b-correction-scroll" tabIndex={0} role="region" aria-label="Pełne sumy dokumentu"><table className="b2b-correction-totals"><thead><CompareHeaders/></thead><tbody><tr><MoneyCells money={c.totals.before}/><MoneyCells money={c.totals.after}/><MoneyCells money={c.totals.delta}/></tr></tbody></table></div>
  <h3>Zestawienie według stawek VAT</h3><div className="b2b-correction-scroll" tabIndex={0} role="region" aria-label="Wszystkie stawki VAT"><table className="b2b-correction-vat"><thead><tr><th rowSpan={2} scope="col">Stawka VAT</th>{['Przed','Po','Zmiana'].map(x=><th key={x} colSpan={3} scope="colgroup">{x}</th>)}</tr><CompareHeaders/></thead><tbody>{c.vat_buckets.map(b=><tr key={b.vat_code} data-vat-code={b.vat_code}><th scope="row">{b.vat_code==='0 KR'?'0% krajowe':b.vat_code+'%'}</th><MoneyCells money={b.before}/><MoneyCells money={b.after}/><MoneyCells money={b.delta}/></tr>)}</tbody></table></div>
  <details><summary>Powiązania obliczenia i łańcuch wcześniejszych korekt</summary><p>Te identyfikatory i skróty wiążą obliczenie. Potwierdzenie oryginalnych zapisów natywnych należy do odrębnego procesu weryfikacji źródła.</p><dl>
   <dt>Faktura źródłowa</dt><dd>{c.original.document_id}</dd><dt>Potwierdzenie faktury źródłowej</dt><dd>{c.original.receipt_id}</dd><dt>Zakres źródłowej faktury</dt><dd>{c.original.scope_hash}</dd><dt>Skrót zapisanych danych fakturowych</dt><dd>{c.original.fiscal_snapshot_hash}</dd><dt>Skrót podstawy wydania źródłowej faktury</dt><dd>{c.original.issued_basis_hash}</dd>
   <dt>Wybrany zwrot</dt><dd>{c.acceptance.return_id}</dd><dt>Potwierdzenie przyjęcia zwrotu</dt><dd>{c.acceptance.receipt_id}</dd><dt>Powiązanie przyjęcia</dt><dd>{c.acceptance.admission_id}</dd><dt>Skrót zapisu przyjęcia</dt><dd>{c.acceptance.receipt_snapshot_hash}</dd><dt>Skrót zapisanych kwot zwrotu</dt><dd>{c.acceptance.financial_hash}</dd><dt>Łańcuch wcześniejszych korekt</dt><dd>{c.previous_chain_hash}</dd>
  </dl></details>
 </section>;
}
