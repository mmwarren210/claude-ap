import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import type { FastifyInstance } from 'fastify';

const gzipAsync = promisify(gzip);

/**
 * Gzips large responses for clients that accept it (2026-10-08: the Board list had grown to 32 MB of JSON, too much for a
 * phone to download and parse). Compression runs on libuv's thread pool, so other requests keep moving.
 */
export function registerCompression(app: FastifyInstance, minBytes = 64 * 1024): void {
  app.addHook('onSend', async (request, reply, payload) => {
    if (reply.getHeader('content-encoding') || !/\bgzip\b/.test(String(request.headers['accept-encoding'] ?? ''))) return payload;
    const body = typeof payload === 'string' ? Buffer.from(payload) : Buffer.isBuffer(payload) ? payload : null;
    if (!body || body.length < minBytes) return payload;
    const zipped = await gzipAsync(body, { level: 5 });
    reply.header('content-encoding', 'gzip');
    reply.header('content-length', zipped.length);
    reply.header('vary', 'accept-encoding');
    return zipped;
  });
}
