/** Small shared pieces of the order card. Badge, Empty, Loading and ErrorBlock are copies of the
 * main.tsx helpers of the same name, so the card does not import the app entry (a cycle that would
 * also run the app in component tests). */
import type { ReactNode } from 'react';
import { AlertCircle, Box, LoaderCircle } from 'lucide-react';
import { statusNames } from './api';

export type Notice = (message: string, error?: boolean) => void;

export function Badge({ status }: { status: string }) {
  return (
    <span className={`badge status-${status}`}>
      {statusNames[status] ?? ({ demo: 'DEMO', live: 'API produkcyjne', sandbox: 'Sandbox' } as Record<string, string>)[status] ?? status}
    </span>
  );
}
export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="empty">
      <Box size={30} />
      <p>{children}</p>
    </div>
  );
}
export function Loading() {
  return (
    <div className="loading">
      <LoaderCircle className="spin" size={24} /> Wczytywanie danych…
    </div>
  );
}
export function ErrorBlock({ message }: { message: string }) {
  return (
    <div className="error-block">
      <AlertCircle size={18} />
      {message}
    </div>
  );
}
