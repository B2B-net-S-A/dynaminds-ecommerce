import { useState } from 'react';

const NAMESPACE = 'http://crd.gov.pl/wzor/2025/06/25/13775/';
interface Fa3DownloadProps { documentId: string; workspaceId: string; number: string }

/** Download of the local FA(3) XML of one issued document (FV or KOR) from the single
 * server entry point; a refusal shows the server's Polish reason. Nothing is sent to KSeF. */
export function Fa3DownloadButton({ documentId, workspaceId, number }: Fa3DownloadProps) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function download() {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/fa3/documents/' + encodeURIComponent(documentId) + '/fa3.xml', { credentials: 'same-origin', headers: { 'X-Workspace-ID': workspaceId } });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { detail?: string } | null;
        throw new Error(body?.detail ?? 'Nie udało się pobrać XML FA(3).');
      }
      const xml = await response.text();
      const parsed = new DOMParser().parseFromString(xml, 'application/xml');
      const p2 = parsed.getElementsByTagNameNS(NAMESPACE, 'P_2');
      if (/<!DOCTYPE|<!ENTITY/i.test(xml) || parsed.getElementsByTagName('parsererror').length || parsed.documentElement.namespaceURI !== NAMESPACE || p2.length !== 1 || p2[0].textContent !== number)
        throw new Error('Serwer zwrócił XML, który nie odpowiada temu dokumentowi.');
      const name = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? number.replace(/\//g, '-') + '.fa3.xml';
      const url = URL.createObjectURL(new Blob([xml], { type: 'application/xml;charset=utf-8' }));
      const link = document.createElement('a'); link.href = url; link.download = name;
      try { document.body.appendChild(link); link.click(); } finally { link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <span className="fa3-download" style={{ marginLeft: 8 }}><button type="button" className="button" disabled={busy} onClick={() => void download()}>{busy ? 'Przygotowanie XML…' : 'Pobierz XML FA(3)'}</button>
    {error && <span role="alert" className="notice error"> {error}</span>}</span>;
}
