import { browserScript166 } from './buyer-address-portal';
import { SHIPMENT_STATUS_LABELS } from './shipment-status-labels';
export const htmlEscape = (v: unknown) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
function proformaBody(d: any) {
  const v = d.data;
  if (
    !v ||
    !v.seller ||
    !v.buyer?.address ||
    !Array.isArray(v.lines) ||
    !v.totals ||
    !['PLN', 'EUR', 'USD', 'GBP', 'CZK'].includes(v.currency)
  )
    throw new Error('Brak zamrożonych danych proformy');
  const money = (minor: unknown) => {
    if (typeof minor !== 'string' || !/^(0|[1-9][0-9]*)$/.test(minor))
      throw new Error('Niepoprawna zamrożona kwota proformy');
    const n = BigInt(minor);
    return htmlEscape(
      new Intl.NumberFormat('pl-PL', {
        style: 'currency',
        currency: v.currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
        .formatToParts(n / 100n)
        .map((p) => (p.type === 'fraction' ? (n % 100n).toString().padStart(2, '0') : p.value))
        .join(''),
    );
  };
  const address = (a: any) =>
    `${htmlEscape(a.street)}<br>${htmlEscape(a.postal_code)} ${htmlEscape(a.city)}<br>${htmlEscape(a.country)}`;
  return `<h2>Pro forma ${htmlEscape(d.number)}</h2><p>Propozycja rozliczenia. Nie jest fakturą podatkową ani potwierdzeniem wpłaty.</p>
<p>Sprzedawca: <strong>${htmlEscape(v.seller.name)}</strong><br>${address(v.seller)}${v.seller.tax_id ? `<br>NIP: ${htmlEscape(v.seller.tax_id)}` : ''}</p>
<p>Nabywca: <strong>${htmlEscape(v.buyer.name)}</strong><br>${address(v.buyer.address)}<br>${htmlEscape(v.buyer.email)}</p>
<p>Zamówienie: ${htmlEscape(v.order?.number)} · wystawiono: ${htmlEscape(v.issue_date)} · termin płatności: ${htmlEscape(v.due_date)}</p>
<table><tr><th>Produkt / dostawa</th><th>Ilość</th><th>VAT</th><th>Netto</th><th>VAT kwota</th><th>Brutto</th></tr>${v.lines.map((i: any) => `<tr><td>${htmlEscape(i.name)}${i.sku ? `<br>${htmlEscape(i.sku)}` : ''}</td><td>${htmlEscape(i.quantity)}</td><td>${htmlEscape(i.vat_rate)}%</td><td>${money(i.net_minor)}</td><td>${money(i.vat_minor)}</td><td>${money(i.gross_minor)}</td></tr>`).join('')}</table>
<p>Netto: ${money(v.totals.net_minor)} · VAT: ${money(v.totals.vat_minor)}</p><h3>Łącznie brutto: ${money(v.totals.gross_minor)}</h3>
${v.series?.payment_instructions ? `<p>Informacje o płatności: ${htmlEscape(v.series.payment_instructions)}</p>` : ''}${v.series?.notes ? `<p>Uwagi: ${htmlEscape(v.series.notes)}</p>` : ''}`;
}
export function documentBody(d: any) {
  if (d.kind === 'proforma' && d.mode === 'local') return proformaBody(d);
  const escape = htmlEscape,
    money = (n: number) =>
      new Intl.NumberFormat('pl-PL', { style: 'currency', currency: d.data.currency }).format(
        n / 100,
      );
  return `<h2>${escape(d.number)}</h2><p>${escape(d.data.seller)} → ${escape(d.data.customer)}</p><p>${escape(d.data.email)}</p>${d.data.imported ? '<p>Import: kwoty brutto z kanału sprzedaży, stawki VAT z lokalnego katalogu — wymagają sprawdzenia.</p>' : ''}<table><tr><th>Produkt</th><th>Ilość</th><th>VAT</th><th>Brutto</th></tr>${d.data.items.map((i: any) => `<tr><td>${escape(i.name)}</td><td>${i.quantity}</td><td>${i.vat}%</td><td>${escape(money(i.gross * (d.kind === 'correction' ? -1 : 1)))}</td></tr>`).join('')}</table><p>Dostawa: ${escape(money(d.data.shipping_cost * (d.kind === 'correction' ? -1 : 1)))}</p><h3>Łącznie: ${escape(money(d.data.total))}</h3>${d.data.original ? `<p>Korekta do: ${escape(d.data.original.number)}</p>` : ''}`;
}
export function portalHtml(d: any, nonce: string) {
  const escape = htmlEscape;
  return `<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(d.number)} · Twoje zamówienie</title>
 <style nonce="${nonce}">*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;background:#f5f6fb;color:#17213a;font:16px system-ui}header{background:#17213a;color:white;padding:26px max(24px,calc((100% - 960px)/2));display:flex;justify-content:space-between;gap:16px}main{max-width:1008px;margin:auto;padding:28px 24px}h1{font-size:28px;margin:8px 0}h2{font-size:20px}p{line-height:1.6}.muted,small{color:#63708a}section{background:white;border:1px solid #e2e6f0;border-radius:16px;padding:24px;margin:18px 0}.summary{display:flex;justify-content:space-between;gap:16px;align-items:center}.badge{border-radius:30px;padding:8px 12px;background:#edf0ff;color:#3445be;font-weight:600}table{width:100%;border-collapse:collapse}th,td{padding:12px 8px;text-align:left;border-bottom:1px solid #edf0f6}label{display:block;font-weight:600;margin:16px 0}input,select,textarea{display:block;font:inherit;width:100%;margin-top:8px;padding:11px;border:1px solid #cfd6e5;border-radius:8px}input[type=number]{width:100px}input[type=checkbox]{display:inline-block;width:auto;margin:0 8px 0 0;vertical-align:middle}textarea{min-height:100px}button,a.button{font:inherit;border-radius:8px;border:1px solid #cfd6e5;background:white;padding:11px 18px;cursor:pointer;text-decoration:none;display:inline-block;color:#17213a}button.primary{background:#3548cc;color:white;border:0}button:disabled{opacity:.5;cursor:default}.notice{padding:14px;border-radius:10px;background:#f0f3ff;color:#344166}.error{color:#b32331}.case{padding:16px 0;border-top:1px solid #e2e6f0}.contact-message-body{white-space:pre-wrap;overflow-wrap:anywhere}.scroll{overflow:auto}a{color:#3548cc}.row{display:flex;gap:12px;flex-wrap:wrap}.money{font-size:26px;font-weight:700}@media(max-width:600px){header,.summary{display:block}main{padding:12px}section{padding:18px}th,td{padding:8px}h1{font-size:24px}}</style></head><body>
 <header><strong>DYNAMINDS Ecommerce</strong><span>Twoje zamówienie</span></header><main>
 <div class="summary"><div><p class="muted">INFORMACJE DLA KUPUJĄCEGO</p><h1>${escape(d.number)}</h1><p id="status" class="badge">${escape(d.status_label)}</p></div><div><small>${d.fulfillment_kind === 'replacement' ? 'Bezpłatna wymiana reklamacyjna' : 'Wartość zakupu'}</small><p id="total" class="money">${escape(d.total_label)}</p></div></div>
 <p class="notice">To prywatny link do zamówienia. Zachowaj go dla siebie.</p>
 ${d.fulfillment_kind === 'replacement' ? '<section><h2>Wymiana reklamacyjna</h2><p>Zamiennik jest bezpłatny. Ta realizacja nie nalicza nowej sprzedaży ani płatności.</p></section>' : `<section><h2>Płatności</h2><p>${d.payment.payment_mode === 'cod' ? 'Za pobraniem' : 'Przedpłata'} · do zapłaty: <strong id="amount-due">${escape(new Intl.NumberFormat('pl-PL', { style: 'currency', currency: d.currency }).format(d.payment.amount_due / 100))}</strong></p><p id="payu-state" class="notice"${d.payu?.pending ? '' : ' hidden'}>Płatność PayU jest w toku. Jeśli już zapłaciłeś, poczekaj na potwierdzenie z PayU.</p><p><button id="payu-pay" class="primary" type="button"${d.payu?.available ? '' : ' hidden'}>Zapłać przez PayU</button></p><p id="payu-error" class="error" role="alert"></p><p class="muted" id="payment-history"${d.payment_as_of_merge ? '' : ' hidden'}>Saldo z chwili połączenia. Późniejsze wpłaty i zwroty wymagają przypisania do pierwotnego zakupu przez sprzedawcę.</p><p class="muted">Doręczenie nie potwierdza wpłaty. Informacje pochodzą z rejestru sprzedawcy.</p></section>`}
 <section><h2>${d.fulfillment_kind === 'replacement' ? 'Zamienniki' : 'Zakupione produkty'}</h2><div class="scroll"><table><thead><tr><th>Produkt</th><th>Ilość</th><th>Wartość</th></tr></thead><tbody>${d.items.map((i: any) => `<tr><td>${escape(i.name)}<br><small>${escape(i.sku)}</small></td><td>${i.quantity}</td><td>${escape(i.gross_label)}</td></tr>`).join('')}</tbody></table></div><p id="shipping-cost"></p></section>
 <section id="buyer-delivery-address"></section>
 <section><h2>Przesyłki</h2><div id="shipments"></div></section>
 <section><h2>Dokumenty</h2><p class="muted">Dokumenty oznaczone DEMO nie są dokumentami księgowymi.</p><div id="documents" class="row"></div></section>
 <section id="contact-section"><div class="summary"><h2>Kontakt ze sprzedawcą</h2><button id="contact-refresh" type="button">Odśwież wiadomości</button></div><p class="notice">Wiadomości i odpowiedzi są zapisywane na tej prywatnej stronie zamówienia. Zapis nie wysyła emaila ani SMS. Nowa wiadomość ponownie otworzy zamkniętą rozmowę.</p><p id="contact-state" class="muted"></p><p id="contact-notice" role="status"></p><p id="contact-error" class="error" role="alert"></p><button id="contact-more" type="button" hidden>Wczytaj starsze wiadomości</button><div id="contact-history"></div><form id="contact-form" hidden><label>Wiadomość do sprzedawcy<textarea id="contact-body" name="body" minlength="1" maxlength="4000" required></textarea></label><small id="contact-count">0 / 4000 znaków · zwykły tekst</small><p id="contact-retry" class="notice" hidden>Zachowano treść i klucz próby. Jeśli odpowiedź została utracona, wiadomość mogła już zostać zapisana. Ponowienie tej samej próby nie tworzy drugiej wiadomości.</p><p><button id="contact-submit" class="primary">Zapisz wiadomość w portalu</button></p></form><p id="contact-access" class="muted"></p></section>
 <section><div class="summary"><h2>Zwroty i reklamacje</h2><button id="refresh" type="button">Odśwież sprawy</button></div><p class="notice">Zgłoszenie trafi do sprzedawcy do rozpatrzenia. Wysłanie formularza nie wykonuje płatności ani nie oznacza przyjęcia towaru.</p><p id="message" role="status"></p><p id="error" class="error" role="alert"></p><form id="return-form" hidden><label>Rodzaj zgłoszenia<select name="kind"><option value="return">Zwrot</option><option value="complaint">Reklamacja</option></select></label><div id="quantities"></div><label>Proponowany zwrot kosztu dostawy<input name="shipping" inputmode="decimal" value="0.00" required></label><p id="shipping-limit" class="muted"></p><label>Powód zgłoszenia<textarea name="reason" minlength="3" maxlength="2000" required></textarea></label><button class="primary" id="submit">Wyślij zgłoszenie</button></form><p id="eligibility" class="muted"></p><h3>Historia zgłoszeń</h3><div id="cases"></div><button id="more" type="button" hidden>Starsze zgłoszenia</button></section>
 <p class="muted">DYNAMINDS Ecommerce · środowisko lokalne</p></main>
 <script nonce="${nonce}">
 ${browserScript166}
 const buyerAddressClient=BuyerAddressPortal166.mountBuyerAddressPortal166(document.getElementById('buyer-delivery-address'));
 window.addEventListener('pagehide',()=>buyerAddressClient.destroy(),{once:true});
 const base=(location.pathname.endsWith('/')?location.pathname.slice(0,-1):location.pathname), el=id=>document.getElementById(id);
 const names={requested:'Do rozpatrzenia',refund_pending:'Uznane — do rozliczenia',closed:'Zamknięte',rejected:'Odrzucone',cancelled:'Anulowane'};
 const shipmentNames=${JSON.stringify(SHIPMENT_STATUS_LABELS)},shipmentStatus=s=>Object.hasOwn(shipmentNames,s)?shipmentNames[s]:s;
 const replacementStatuses={new:'Nowe',paid:'Gotowe do kompletacji',picking:'W kompletacji',packed:'Spakowane',shipped:'Nadane',delivered:'Dostarczone',completed:'Zakończone',cancelled:'Anulowane'};
 let state,after=null,busy=false,key=crypto.randomUUID();
 const money=n=>new Intl.NumberFormat('pl-PL',{style:'currency',currency:state.currency}).format(n/100);
 function node(tag,text,parent){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;parent.append(n);return n;}
 async function request(path,body){const response=await fetch(base+path,{method:body?'POST':'GET',credentials:'omit',headers:body?{'Content-Type':'application/json'}:{},...(body?{body:JSON.stringify(body)}:{})});const d=await response.json();if(!response.ok)throw Object.assign(Error(d.detail||'Nie udało się wykonać operacji'),{status:response.status});return d;}
 function showCases(rows,append=false){
   if(!append)el('cases').replaceChildren();
   for(const r of rows){
     const a=node('article',undefined,el('cases'));a.className='case';
     node('strong',r.number+' · '+(r.kind==='complaint'?'Reklamacja':'Zwrot'),a);
     node('p',names[r.state]+' · '+new Date(r.created_at).toLocaleString('pl-PL'),a);
     node('p',r.reason,a);
     for(const i of r.items)node('p',i.name+': zgłoszono '+i.requested+', uznano '+i.accepted,a);
     if(r.remedy==='exchange'){node('p','Wymiana reklamacyjna — bez zwrotu środków.',a);if(r.exchange){node('p','Realizacja zamiennika: '+(r.exchange.replacement_number||'')+' · '+(replacementStatuses[r.exchange.replacement_status]||r.exchange.replacement_status||''),a);for(const s of r.exchange.shipments||[])node('p',s.carrier+' · '+s.tracking_number+' · '+(s.mode==='demo'?'Przesyłka demonstracyjna':shipmentStatus(s.status)),a);}}else if(r.accepted_at||r.received_at)node('p','Uznana kwota zwrotu: '+money(r.refund_amount),a);
     if(r.acceptance_kind==='partner')node('p','Sprzedawca uznał zwrot na podstawie przyjęcia przez dostawcę. Nie oznacza to przyjęcia do magazynu sprzedawcy ani wypłaty środków.',a);
     if(r.decision_note)node('p','Decyzja sprzedawcy: '+r.decision_note,a);
     if(r.refunded_at)node('p',r.settlement_amount===0?'Rozliczono należność bez wypłaty środków.':'Sprzedawca potwierdził zwrot środków: '+money(r.settlement_amount)+'.',a);
   }
   if(!rows.length&&!append)node('p','Brak zgłoszeń.',el('cases'));
 }
 async function load(){state=await request('/data');const paymentHistory=el('payment-history');if(paymentHistory)paymentHistory.hidden=!state.payment_as_of_merge;el('status').textContent=state.status_label;if(el('payu-pay')){el('payu-pay').hidden=!(state.payu&&state.payu.available);el('payu-state').hidden=!(state.payu&&state.payu.pending);el('amount-due').textContent=money(state.payment.amount_due);}el('total').textContent=state.total_label;el('shipping-cost').textContent='Dostawa: '+money(state.shipping_cost);el('shipments').replaceChildren();for(const s of state.shipments){const p=node('p',s.carrier+' · '+s.tracking_number+' · '+(s.mode==='demo'?'Przesyłka demonstracyjna':shipmentStatus(s.status))+' ',el('shipments'));if(s.tracking_url){const t=node('a','Śledź przesyłkę u przewoźnika',p);t.href=s.tracking_url;t.target='_blank';t.rel='noreferrer noopener';}}if(!state.shipments.length)node('p','Przesyłka nie została jeszcze nadana.',el('shipments'));el('documents').replaceChildren();for(const d of state.documents){if(d.download==='pdf'){const a=node('a',d.number+' · Pobierz PDF',el('documents'));a.className='button';a.href=base+'/documents/'+d.id+'/file';a.rel='noreferrer';a.setAttribute('download','');}else if(d.download_available){const a=node('a',d.number+' · '+(d.kind==='proforma'&&d.mode==='local'?'Pro forma':d.mode==='external'?'Dokument':'DEMO'),el('documents'));a.className='button';a.href=base+'/documents/'+d.id+'/print';a.target='_blank';a.rel='noreferrer';}else node('p',d.number+' · pobranie u sprzedawcy',el('documents'));}if(!state.documents.length)node('p','Brak udostępnionych dokumentów.',el('documents'));el('return-form').hidden=!state.can_request;el('eligibility').textContent=state.read_only?(state.status_label==='Realizacja przeniesiona przez łączenie zamówień'?'Historia pierwotnego zakupu — realizację i zgłoszenia obsługuje sprzedawca.':'Podgląd kopii — zgłoszenia są wyłączone.'):state.can_request?'':state.fulfillment_kind==='replacement'?'W sprawie zamiennika skontaktuj się ze sprzedawcą.':'Brak pozycji możliwych do zgłoszenia lub zamówienie nie zostało wydane.';el('quantities').replaceChildren();for(const i of state.items){const label=node('label',i.name+' (można zgłosić: '+i.available+')',el('quantities'));const input=node('input',undefined,label);input.type='number';input.name='qty-'+i.id;input.min='0';input.max=String(i.available);input.value='0';input.step='1';input.setAttribute('aria-label','Ilość zwrotu '+i.sku);}el('shipping-limit').textContent='Można zgłosić do '+money(state.shipping_available)+'.';showCases(state.cases);after=state.meta.cursor;el('more').hidden=!after;}
 el('refresh').onclick=()=>{el('message').textContent='';el('error').textContent='';load().catch(e=>el('error').textContent=e.message);};
 el('more').onclick=async()=>{el('more').disabled=true;try{const d=await request('/data?after='+encodeURIComponent(after));showCases(d.cases,true);after=d.meta.cursor;el('more').hidden=!after;}catch(e){el('error').textContent=e.message;}finally{el('more').disabled=false;}};
 el('return-form').onsubmit=async e=>{e.preventDefault();if(busy)return;el('error').textContent='';el('message').textContent='';try{const f=new FormData(e.currentTarget),s=String(f.get('shipping')).trim().replace(',','.');if(!/^\\d+(\\.\\d{1,2})?$/.test(s))throw Error('Kwota wymaga maksymalnie dwóch miejsc dziesiętnych');const parts=s.split('.'),shipping=Number(parts[0])*100+Number((parts[1]||'').padEnd(2,'0'));const items=state.items.map(i=>({item_id:i.id,quantity:Number(f.get('qty-'+i.id))})).filter(i=>i.quantity>0);if(!items.length)throw Error('Wybierz przynajmniej jedną sztukę');busy=true;el('submit').disabled=true;const result=await request('/returns',{client_key:key,kind:f.get('kind'),reason:f.get('reason'),shipping_refund:shipping,items});key=crypto.randomUUID();e.target.reset();await load();el('message').textContent='Zgłoszenie '+result.number+' zostało zapisane. Sprzedawca rozpatrzy Twoją sprawę.';}catch(e){el('error').textContent=e.message;}finally{busy=false;el('submit').disabled=false;}};
 let contactState=null,contactRows=[],contactCursor=null,contactBusy=false,contactGeneration=0,contactPending=null;
 function showContact(){el('contact-history').replaceChildren();for(const m of contactRows.filter(m=>m.kind==='buyer'||m.kind==='reply').slice().reverse()){const a=node('article',undefined,el('contact-history'));a.className='case';node('strong',m.kind==='buyer'?'Twoja wiadomość':'Odpowiedź sprzedawcy',a);node('small',' · '+new Date(m.created_at).toLocaleString('pl-PL'),a);const p=node('p',m.body,a);p.className='contact-message-body';}if(!contactRows.length)node('p',!contactState?'Wczytaj wiadomości, aby sprawdzić historię rozmowy.':contactState.available?'Nie ma jeszcze wiadomości. Możesz rozpocząć rozmowę.':'Historia wiadomości jest niedostępna w tej kopii.',el('contact-history'));el('contact-more').hidden=!contactCursor;el('contact-state').textContent=contactState&&contactState.status?(contactState.status==='open'?'Rozmowa otwarta':'Rozmowa zamknięta'):'';const writable=contactState&&contactState.available&&!contactState.read_only;el('contact-form').hidden=!writable;el('contact-access').textContent=contactState&&!contactState.available?'Ta kopia nie zawiera wiadomości klientów.':contactState&&contactState.read_only?'Podgląd kopii — zapis wiadomości jest wyłączony.':'';el('contact-body').disabled=contactBusy||!!contactPending;el('contact-submit').disabled=contactBusy||!writable;el('contact-refresh').disabled=contactBusy;el('contact-more').disabled=contactBusy;el('contact-retry').hidden=!contactPending;el('contact-submit').textContent=contactPending?'Ponów ten sam zapis':'Zapisz wiadomość w portalu';}
 async function loadContact(older=false){if(contactBusy)return;const current=++contactGeneration;contactBusy=true;showContact();try{const d=await request('/messages'+(older&&contactCursor?'?cursor='+encodeURIComponent(contactCursor):''));if(current!==contactGeneration)return;contactState=d;const ids=new Set(contactRows.map(m=>m.id));contactRows=older?contactRows.concat(d.data.filter(m=>!ids.has(m.id))):d.data;contactCursor=d.meta.cursor;showContact();}catch(e){el('contact-error').textContent=e.message;if([401,403,404,423,503].includes(e.status)){contactState=null;contactRows=[];contactCursor=null;}}finally{contactBusy=false;showContact();}}
 el('contact-body').oninput=()=>{el('contact-count').textContent=el('contact-body').value.length+' / 4000 znaków · zwykły tekst';};
 el('contact-refresh').onclick=()=>{el('contact-error').textContent='';loadContact();};
 el('contact-more').onclick=()=>{el('contact-error').textContent='';loadContact(true);};
 el('contact-form').onsubmit=async e=>{e.preventDefault();if(contactBusy||!contactState||!contactState.available||contactState.read_only)return;el('contact-error').textContent='';el('contact-notice').textContent='';const body=contactPending?contactPending.body:el('contact-body').value.trim();if(!body||body.length>4000){el('contact-error').textContent='Wpisz wiadomość od 1 do 4000 znaków.';return;}if(!contactPending)contactPending={client_key:crypto.randomUUID(),body};el('contact-body').value=contactPending.body;el('contact-count').textContent=body.length+' / 4000 znaków · zwykły tekst';contactBusy=true;showContact();try{await request('/messages',contactPending);contactPending=null;el('contact-body').value='';el('contact-count').textContent='0 / 4000 znaków · zwykły tekst';el('contact-notice').textContent='Wiadomość została zapisana. Odpowiedź sprzedawcy pojawi się na tej stronie; odśwież wiadomości, aby ją sprawdzić.';contactBusy=false;await loadContact();}catch(e){el('contact-error').textContent=e.message;if(e.status===422)contactPending=null;if([401,403,404,423,503].includes(e.status)){contactState=null;contactRows=[];contactCursor=null;}}finally{contactBusy=false;showContact();}};
 let payKey=null;
 if(el('payu-pay'))el('payu-pay').onclick=async()=>{const b=el('payu-pay');if(b.disabled)return;b.disabled=true;el('payu-error').textContent='';try{payKey=payKey||crypto.randomUUID();const r=await request('/payments/payu',{client_key:payKey});payKey=null;if(r.redirect){try{sessionStorage.setItem('payu-return:'+r.session_id,location.href);}catch{}location.assign(r.redirect);return;}await load();}catch(e){el('payu-error').textContent=e.message;if(e.status!==503)payKey=null;}finally{b.disabled=false;}};
 loadContact();
 load().catch(e=>{el('error').textContent=e.message;el('return-form').hidden=true;});
 </script></body></html>`;
}
