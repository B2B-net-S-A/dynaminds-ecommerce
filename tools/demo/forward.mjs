#!/usr/bin/env node
// Plain TCP relays for the demo instance, run inside the demo PostgreSQL container's network namespace
// (tools/demo/demo.sh). Bytes are piped unchanged (TLS to the local Woo stores stays end-to-end).
//
//   node tools/demo/forward.mjs <listen host:port>=<target host:port> ...
//
// Inbound:  0.0.0.0:14300=127.0.0.1:4300        published port of the container -> release CLI (loopback only)
// Outbound: 127.0.0.1:18443=host.docker.internal:18443   release -> local Woo store / KSeF fake / fiscal printer fake
import net from 'node:net';

const specs = process.argv.slice(2).map((s) => {
  const m = /^([0-9.]+):(\d{2,5})=([a-z0-9.-]+):(\d{2,5})$/.exec(s);
  if (!m) throw new Error('bad relay spec: ' + s);
  return { host: m[1], port: Number(m[2]), target: m[3], targetPort: Number(m[4]) };
});
if (!specs.length) throw new Error('usage: forward.mjs <listen host:port>=<target host:port> ...');
for (const r of specs) {
  net.createServer((client) => {
    const upstream = net.connect(r.targetPort, r.target);
    const close = () => { client.destroy(); upstream.destroy(); };
    client.on('error', close); upstream.on('error', close);
    client.pipe(upstream); upstream.pipe(client);
  }).listen(r.port, r.host, () => console.log(JSON.stringify({ relay: `${r.host}:${r.port}`, to: `${r.target}:${r.targetPort}` })));
}
