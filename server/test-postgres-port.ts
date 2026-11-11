/** Strict, source-owned loopback test-cluster port. No request input reaches this helper. */
export function testPostgresPort(value: string | undefined): number {
  if (value === undefined) return 55432;
  if (!/^[1-9][0-9]{0,4}$/.test(value)) throw new Error('Nieprawidłowy DYNA_TEST_PG_PORT');
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535)
    throw new Error('Nieprawidłowy DYNA_TEST_PG_PORT');
  return port;
}
/** Operator-configured local URL owns the port; no test mode is needed for a retained cluster. */
export function recoveryPostgresPort(databaseUrl: string | undefined = process.env.DATABASE_URL): number {
  if (databaseUrl !== undefined) {
    let selected: URL;
    try { selected = new URL(databaseUrl); } catch { throw new Error('Nieprawidłowy lokalny adres bazy odzyskiwania'); }
    if (!['postgres:', 'postgresql:'].includes(selected.protocol) ||
        !['127.0.0.1', 'localhost', '[::1]'].includes(selected.hostname) ||
        selected.username !== 'postgres' || selected.search !== '' || selected.hash !== '' ||
        !/^\/[a-z][a-z0-9_]*$/.test(selected.pathname))
      throw new Error('Odzyskiwanie wymaga jawnego lokalnego adresu PostgreSQL operatora');
    return testPostgresPort(selected.port === '' ? '0' : selected.port);
  }
  return process.env.DYNA_TEST === 'true' ? testPostgresPort(process.env.DYNA_TEST_PG_PORT) : 55432;
}
