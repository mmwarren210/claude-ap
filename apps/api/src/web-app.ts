import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';

const types: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.map': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};

const isFile = async (path: string) => { try { return (await stat(path)).isFile(); } catch { return false; } };
const entries = async (dir: string) => { try { return await readdir(dir); } catch { return []; } };
const dynamic = (name: string) => /^\[[^\]]+\]$/.test(name);

/**
 * The page file for a URL path in an Expo Router static export: the file itself, `path.html`,
 * `path/index.html`, or a dynamic route such as `player/[lineId].html`.
 */
export async function webAppFile(root: string, urlPath: string): Promise<string | null> {
  const base = resolve(root);
  let decoded: string;
  try { decoded = decodeURIComponent(urlPath); } catch { return null; }
  const segments = decoded.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '..' || segment.includes('\\') || segment.includes('\0'))) return null;
  const direct = join(base, ...segments);
  if (direct !== base && !direct.startsWith(base + sep)) return null;
  if (!segments.length) return await isFile(join(base, 'index.html')) ? join(base, 'index.html') : null;
  for (const candidate of [direct, direct + '.html', join(direct, 'index.html')]) if (await isFile(candidate)) return candidate;
  // Dynamic routes: match each segment literally first, then against a [param] entry.
  let dir = base;
  for (const [index, segment] of segments.entries()) {
    const names = await entries(dir), last = index === segments.length - 1;
    if (last) {
      const page = names.includes(segment + '.html') ? segment + '.html'
        : names.find((name) => name.endsWith('.html') && dynamic(name.slice(0, -5)));
      if (page) return join(dir, page);
    }
    const next = names.includes(segment) ? segment : names.find(dynamic);
    if (!next) return null;
    dir = join(dir, next);
    if (last && await isFile(join(dir, 'index.html'))) return join(dir, 'index.html');
  }
  return null;
}

/** Serves the exported web app for GET paths outside the API; API paths keep their JSON 404. */
export function serveWebApp(app: FastifyInstance, root: string): void {
  app.setNotFoundHandler(async (request, reply) => {
    const path = request.url.split('?')[0];
    const api = path.startsWith('/v1/') || path === '/v1' || path === '/health';
    if (api || (request.method !== 'GET' && request.method !== 'HEAD'))
      return reply.code(404).send({ message: `Route ${request.method}:${path} not found`, error: 'Not Found', statusCode: 404 });
    const file = await webAppFile(root, path), missing = !file;
    const served = file ?? join(resolve(root), '+not-found.html');
    if (!await isFile(served)) return reply.code(404).send({ message: 'Not found', error: 'Not Found', statusCode: 404 });
    // Built scripts and assets have content hashes in their names; pages must always be rechecked.
    const hashed = path.startsWith('/_expo/') || path.startsWith('/assets/');
    return reply.code(missing ? 404 : 200).type(types[extname(served).toLowerCase()] ?? 'application/octet-stream')
      .header('Cache-Control', hashed && !missing ? 'public, max-age=31536000, immutable' : 'no-cache')
      .send(await readFile(served));
  });
}
