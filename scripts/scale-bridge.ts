/**
 * Local scale bridge for browsers without Web Serial (Safari, Firefox). Reads ASCII weight frames
 * from a serial device (or stdin) and serves the latest reading on loopback only:
 *   GET http://127.0.0.1:4120/reading -> { status: 'stable', grams, at } | { status: <reason>, at }
 * The packing UI calls it directly when "Mostek wagi" is chosen in its scale settings.
 *
 *   npm run scale:bridge -- --device /dev/cu.usbserial-110 --baud 9600 [--frame 7E1] [--command SI]
 *   some-tool | npm run scale:bridge -- --stdin
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { open } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import type { Readable } from 'node:stream';
import { createScaleLineBuffer, createScaleTracker, parseScaleFrame } from '../web/scale-frame';

const DEFAULT_ORIGINS = [
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  'http://127.0.0.1:4100',
  'http://localhost:4100',
];
const STALE_MS = 2000;
const BAUD_RATES = new Set(['1200', '2400', '4800', '9600', '19200', '38400']);
const COMMANDS = new Set(['S', 'SI', 'W', 'P']);

const { values } = parseArgs({
  options: {
    device: { type: 'string' },
    stdin: { type: 'boolean', default: false },
    baud: { type: 'string', default: '9600' },
    frame: { type: 'string', default: '8N1' },
    command: { type: 'string' },
    port: { type: 'string', default: '4120' },
    'allow-origin': { type: 'string', multiple: true },
  },
  strict: true,
});

function fail(code: string): never {
  console.error(JSON.stringify({ status: 'SCALE_BRIDGE_FAILED', code }));
  process.exit(2);
}
if (Boolean(values.device) === values.stdin) fail('SCALE_BRIDGE_SOURCE_REQUIRED');
if (!BAUD_RATES.has(values.baud!)) fail('SCALE_BRIDGE_BAUD_INVALID');
if (!['8N1', '7E1'].includes(values.frame!)) fail('SCALE_BRIDGE_FRAME_INVALID');
if (values.command && (!COMMANDS.has(values.command) || values.stdin)) fail('SCALE_BRIDGE_COMMAND_INVALID');
const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) fail('SCALE_BRIDGE_PORT_INVALID');
const origins = new Set(values['allow-origin'] ?? DEFAULT_ORIGINS);
for (const origin of origins) if (!/^https?:\/\/[a-z0-9.[\]:-]+$/i.test(origin)) fail('SCALE_BRIDGE_ORIGIN_INVALID');

type Reading = { status: string; grams?: number; at: number };
let current: Reading | null = null;
const lines = createScaleLineBuffer();
const tracker = createScaleTracker();

function consume(chunk: Buffer | string) {
  for (const line of lines(typeof chunk === 'string' ? chunk : chunk.toString('latin1'))) {
    const frame = parseScaleFrame(line);
    if (frame.kind === 'empty') continue;
    const grams = tracker.push(frame);
    const at = Date.now();
    if (grams !== null) current = { status: 'stable', grams, at };
    else current = { status: frame.kind === 'weight' ? 'unstable' : frame.kind, at };
  }
}

async function source(): Promise<Readable> {
  if (values.stdin) return process.stdin;
  const device = values.device!;
  // Raw mode, no echo; stty takes -f on macOS and -F on Linux.
  const flag = process.platform === 'darwin' ? '-f' : '-F';
  const bits = values.frame === '7E1' ? ['cs7', 'parenb', '-parodd'] : ['cs8', '-parenb'];
  const stty = spawnSync('stty', [flag, device, values.baud!, 'raw', '-echo', '-cstopb', ...bits], {
    shell: false,
    stdio: 'ignore',
    env: { PATH: '/usr/bin:/bin', LANG: 'C' },
  });
  if (stty.status !== 0) fail('SCALE_BRIDGE_DEVICE_SETUP_FAILED');
  const handle = await open(device, 'r+').catch(() => fail('SCALE_BRIDGE_DEVICE_OPEN_FAILED'));
  if (values.command) {
    const bytes = Buffer.from(values.command + '\r\n', 'ascii');
    setInterval(() => void handle.write(bytes).catch(() => undefined), 500).unref();
  }
  return handle.createReadStream();
}

function reply(req: IncomingMessage, res: ServerResponse, status: number, body?: unknown) {
  const origin = req.headers.origin;
  if (origin && origins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Cache-Control', 'no-store');
  if (body === undefined) return res.writeHead(status).end();
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
}

const server = createServer((req, res) => {
  const listening = (server.address() as { port: number }).port;
  // Loopback Host only, so a rebinding DNS name cannot read the scale from a foreign page.
  if (!['127.0.0.1:' + listening, 'localhost:' + listening, '[::1]:' + listening].includes(req.headers.host ?? ''))
    return reply(req, res, 421, { status: 'host_refused' });
  if (req.headers.origin && !origins.has(req.headers.origin)) return reply(req, res, 403, { status: 'origin_refused' });
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    if (req.headers['access-control-request-private-network'] === 'true')
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
    return reply(req, res, 204);
  }
  if (req.method !== 'GET') return reply(req, res, 405, { status: 'method_refused' });
  if (req.url !== '/reading') return reply(req, res, 404, { status: 'not_found' });
  if (!current) return reply(req, res, 200, { status: 'no_data', at: null });
  if (Date.now() - current.at > STALE_MS) return reply(req, res, 200, { status: 'stale', at: current.at });
  return reply(req, res, 200, current);
});

const input = await source();
input.on('data', consume);
input.on('error', () => fail('SCALE_BRIDGE_DEVICE_READ_FAILED'));
server.listen(port, '127.0.0.1', () => {
  const address = server.address() as { port: number };
  console.log(JSON.stringify({ status: 'SCALE_BRIDGE_LISTENING', port: address.port, origins: [...origins] }));
});
const stop = () => {
  server.close(() => process.exit(0));
  server.closeAllConnections();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
