import React,{useState}from'react';
export function SmsLiveEndpointSetup({create}:{create:(body:Record<string,unknown>)=>Promise<{callback_url:string}>}){
 const[name,setName]=useState(''),[sender,setSender]=useState(''),[token,setToken]=useState(''),[account,setAccount]=useState(''),[origin,setOrigin]=useState(''),[consent,setConsent]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[callback,setCallback]=useState('');
 return <details><summary>Rzeczywista wysyłka SMSAPI — konfiguracja administratora</summary>
 <p>Wymaga aktualnej sesji z MFA, tokenu konta i publicznego HTTPS callbacku. Konfiguracja nie wysyła SMS. Raport doręczenia pochodzi z callbacku SMSAPI.</p>
 <form onSubmit={async e=>{e.preventDefault();if(!consent||busy)return;setBusy(true);setError('');try{const r=await create({name,sender,access_token:token,account_username:account,callback_origin:origin,confirm_external:true});setToken('');setConsent(false);setCallback(r.callback_url);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}>
 <label>Nazwa<input required maxLength={120} value={name} onChange={e=>setName(e.target.value)}/></label>
 <label>Nadawca SMSAPI<input required maxLength={11} value={sender} onChange={e=>setSender(e.target.value)}/></label>
 <label>Token SMSAPI<input required type="password" autoComplete="off" value={token} onChange={e=>setToken(e.target.value)}/></label>
 <label>Nazwa konta SMSAPI dla callbacku<input required maxLength={200} value={account} onChange={e=>setAccount(e.target.value)}/></label>
 <label>Publiczny adres aplikacji HTTPS<input required type="url" value={origin} onChange={e=>setOrigin(e.target.value)} placeholder="https://aplikacja.example"/></label>
 <label><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/>Zgadzam się na skonfigurowanie rzeczywistej, płatnej wysyłki. Każda partia wymaga osobnego zatwierdzenia.</label>
 <button disabled={!consent||busy}>Zapisz połączenie i callback</button>
 </form>{error&&<p role="alert">{error}</p>}{callback&&<p>Callback: <code>{callback}</code>. Każda wysyłka dopisuje do tego adresu tajny token (przechowywany zaszyfrowany), a raport bez tokenu albo spoza adresów IP SMSAPI jest odrzucany. Dostępność sieciową i raporty SMSAPI trzeba odebrać na koncie; ten zapis ich nie potwierdza.</p>}
 </details>;
}
