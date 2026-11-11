/** The instance belongs to the operator; selecting a test mode does not verify a sandbox. */
export function MiraklConnectionFields(){
 return <>
  <label>Adres instancji Mirakl (HTTPS)
   <input name="instance_url" type="url" placeholder="https://operator.mirakl.net" required/>
  </label>
  <label>ID sklepu w tej instancji
   <input name="shop_id" type="text" inputMode="numeric" pattern="[1-9][0-9]{0,15}" maxLength={16} required/>
  </label>
  <label>Waluta sklepu
   <select name="currency" required defaultValue="">
    <option value="" disabled>Wybierz walutę zgodną z kontem sklepu</option>
    {['PLN','EUR','USD','GBP','CZK'].map(value=><option key={value} value={value}>{value}</option>)}
   </select>
  </label>
  <p className="notice">Wprowadź adres i ID otrzymane od operatora marketplace. Zapis konfiguracji nie potwierdza dostępu do konta. Dostępność odczytów i importu sprawdź w zakresie integracji.</p>
 </>;
}
