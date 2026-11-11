// SYNTHETIC inputs for DHL carrier tests: invented addresses and a checksum-valid but fictitious NRB.
import { readFileSync } from 'node:fs';
export const dhlFixture = (name: string) =>
  readFileSync(new URL('./' + name, import.meta.url), 'utf8');
export function syntheticNrb(bban = '109010140000071219812874') {
  let rest = 0;
  for (const d of bban + '252100') rest = (rest * 10 + Number(d)) % 97;
  return String(98 - rest).padStart(2, '0') + bban;
}
const party = {
  name: 'Sklep Testowy',
  address: 'Prosta 5/12',
  city: 'Warszawa',
  postalCode: '00-838',
  phone: '+48500100200',
  email: 'nadawca@example.test',
};
export const validInput = {
  channel_id: '7d3c6f9e-2a51-4c1b-9f0e-1b2c3d4e5f60',
  sender: party,
  receiver: { ...party, name: 'Jan Kowalski', address: 'Długa 1', city: 'Kraków', postalCode: '31-147' },
  weight: 2.5,
  dimensions: { length: 30, width: 20, height: 10 },
  content: 'Odzież',
};
// Monday 2026-10-26 10:00 in Warsaw (CET, the day after the autumn change).
export const NOW = new Date('2026-10-26T09:00:00Z');
