import type { IncomingMessage, Server } from 'node:http';
import type { FastifyRequest } from 'fastify';
import { normalizeIP } from '@fastify/rate-limit';

/** Capture before any asynchronous request hooks; no forwarded-header fallback. */
export function captureRateLimitPeer(server: Server) {
  const peers = new WeakMap<IncomingMessage, string>();
  const capture = (raw: IncomingMessage) => {
    const peer = raw.socket.remoteAddress;
    if (typeof peer === 'string' && peer.length > 0) peers.set(raw, peer);
  };
  server.prependListener('request', capture);
  const keyGenerator = (request: FastifyRequest): string => {
    const peer = request.ip || peers.get(request.raw);
    // One shared bucket fails conservatively when even the original peer is absent.
    if (!peer) return 'http-peer-unavailable';
    const config = request.routeOptions.config.rateLimit;
    const value = config && typeof config === 'object' ? config.ipv6Subnet : undefined;
    const subnet = typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 128
      ? Math.trunc(value) : 64;
    return normalizeIP(peer, subnet);
  };
  return { keyGenerator, detach: () => server.removeListener('request', capture) };
}
