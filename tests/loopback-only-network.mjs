/** Test preload (node --import): every outgoing TCP connection is refused unless it goes to a
 * loopback host on a port listed in DYNA_TEST_ALLOWED_PORTS. Lets a real worker run against a
 * restored clone without reaching any provider, SMTP or HTTP endpoint outside the test. */
import net from 'node:net';

const allowed = new Set(
  (process.env.DYNA_TEST_ALLOWED_PORTS ?? '')
    .split(',')
    .filter(Boolean)
    .map(Number),
);
const loopback = new Set([undefined, 'localhost', '127.0.0.1', '::1']);
const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  let o = args[0];
  if (Array.isArray(o)) o = o[0];
  let host, port, path;
  if (o && typeof o === 'object') ({ host, port, path } = o);
  else if (typeof o === 'number' || /^\d+$/.test(String(o))) [port, host] = [o, typeof args[1] === 'string' ? args[1] : undefined];
  else if (typeof o === 'string') path = o;
  if (!path && loopback.has(host) && allowed.has(Number(port))) return original.apply(this, args);
  process.stderr.write(JSON.stringify({ network_guard: 'refused', host: host ?? null, port: port ?? null, path: path ?? null }) + '\n');
  const socket = this;
  process.nextTick(() =>
    socket.destroy(Object.assign(new Error(`Network guard refused ${host}:${port}`), { code: 'ECONNREFUSED' })),
  );
  return this;
};
