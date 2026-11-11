/** FA(3) files of received invoices for the ksef-purchase tests (no legal force). */
export const BUYER = '1234563218', SELLER = '5260250995', OTHER_SELLER = '7740001454';
export type Fa3Opts = { seller?: string; sellerName?: string; buyer?: string; number?: string; date?: string; kind?: string; currency?: string; extraFa?: string; korRefs?: { number: string; date: string; ksef?: string }[]; gross?: string };
export function receivedFa3(o: Fa3Opts = {}): Buffer {
  const kind = o.kind ?? 'VAT', refs = (o.korRefs ?? []).map(r => `<DaneFaKorygowanej><DataWystFaKorygowanej>${r.date}</DataWystFaKorygowanej><NrFaKorygowanej>${r.number}</NrFaKorygowanej>${r.ksef ? `<NrKSeF>1</NrKSeF><NrKSeFFaKorygowanej>${r.ksef}</NrKSeFFaKorygowanej>` : '<NrKSeFN>1</NrKSeFN>'}</DaneFaKorygowanej>`).join('');
  const kor = kind.startsWith('KOR') ? `<PrzyczynaKorekty>Rabat posprzedażowy</PrzyczynaKorekty><TypKorekty>1</TypKorekty>${refs}` : '';
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><Faktura xmlns="http://crd.gov.pl/wzor/2025/06/25/13775/"><Naglowek><KodFormularza kodSystemowy="FA (3)" wersjaSchemy="1-0E">FA</KodFormularza><WariantFormularza>3</WariantFormularza><DataWytworzeniaFa>2026-10-20T09:00:00Z</DataWytworzeniaFa></Naglowek>`
    + `<Podmiot1><DaneIdentyfikacyjne><NIP>${o.seller ?? SELLER}</NIP><Nazwa>${o.sellerName ?? 'Hurtownia Testowa sp. z o.o.'}</Nazwa></DaneIdentyfikacyjne><Adres><KodKraju>PL</KodKraju><AdresL1>ul. Magazynowa 2</AdresL1></Adres></Podmiot1>`
    + `<Podmiot2><DaneIdentyfikacyjne><NIP>${o.buyer ?? BUYER}</NIP><Nazwa>Sklep DYNAMINDS sp. z o.o.</Nazwa></DaneIdentyfikacyjne><JST>2</JST><GV>2</GV></Podmiot2>`
    + `<Fa><KodWaluty>${o.currency ?? 'PLN'}</KodWaluty><P_1>${o.date ?? '2026-10-20'}</P_1><P_2>${o.number ?? 'FZ/1/10/2026'}</P_2><P_6>2026-10-19</P_6>`
    + `<P_13_1>1000.00</P_13_1><P_14_1>230.00</P_14_1><P_13_2>100.50</P_13_2><P_14_2>8.04</P_14_2><P_13_7>50</P_13_7><P_15>${o.gross ?? '1388.54'}</P_15>`
    + `<Adnotacje><P_16>2</P_16><P_17>2</P_17><P_18>2</P_18><P_18A>1</P_18A><Zwolnienie><P_19N>1</P_19N></Zwolnienie><NoweSrodkiTransportu><P_22N>1</P_22N></NoweSrodkiTransportu><P_23>2</P_23><PMarzy><P_PMarzyN>1</P_PMarzyN></PMarzy></Adnotacje>`
    + `<RodzajFaktury>${kind}</RodzajFaktury>${kor}${o.extraFa ?? ''}<FaWiersz><NrWierszaFa>1</NrWierszaFa><P_7>Towar</P_7><P_8B>1</P_8B><P_11>1000.00</P_11><P_12>23</P_12></FaWiersz>`
    + `<Platnosc><TerminPlatnosci><Termin>2026-11-03</Termin></TerminPlatnosci></Platnosc></Fa></Faktura>`, 'utf8');
}
