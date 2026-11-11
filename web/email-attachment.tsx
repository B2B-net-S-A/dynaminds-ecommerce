export function EmailAttachment({ file, messageId }: { file: any; messageId?: string }) {
  if (!file) return null;
  return (
    <div className="email-file">
      <strong>Załącznik: {file.filename}</strong>
      <small>
        {file.source === 'demo'
          ? 'Dokument DEMO HTML'
          : file.source === 'odoo'
            ? file.mode === 'simulation'
              ? 'PDF Odoo DEMO - plik symulatora'
              : 'PDF Odoo'
            : 'PDF Fakturowni'}{' '}
        · {(file.size / 1024).toFixed(1)} KiB · SHA256 {file.sha256.slice(0, 12)}…
      </small>
      {messageId && (
        <a className="text-button" href={'/api/email/messages/' + messageId + '/attachment'}>
          Pobierz zapisany załącznik
        </a>
      )}
    </div>
  );
}
