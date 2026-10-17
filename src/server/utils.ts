/**
 * Server Utilities
 *
 * Shared helpers for the TraceMind HTTP server.
 */

import { timingSafeEqual } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import type { IncomingMessage, ServerResponse } from 'http';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';

export interface ApiEnvelope<T = unknown> {
  data?: T;
  error?: { code: string; message: string };
  meta?: {
    durationMs?: number;
    provenance?: string;
    graphProjection?: {
      status: 'queued' | 'applied' | 'failed' | 'partial';
      requestedServiceIds: string[];
      linkedServiceIds: string[];
    };
  };
}

export function sendJson<T>(res: ServerResponse, status: number, body: ApiEnvelope<T>): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

export class RequestBodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Request body exceeds ${maxBytes} bytes`);
    this.name = 'RequestBodyTooLargeError';
  }
}

export function readBody(req: IncomingMessage, maxBytes = 1_048_576): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let byteLength = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      byteLength += chunk.length;
      if (byteLength > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(new RequestBodyTooLargeError(maxBytes));
        return;
      }
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

export function authenticateRequest(req: IncomingMessage, expectedKey: string): boolean {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return false;
  }

  const token = authHeader.slice(7);
  if (token.length !== expectedKey.length) {
    return false;
  }

  try {
    return timingSafeEqual(Buffer.from(token), Buffer.from(expectedKey));
  } catch {
    return false;
  }
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export async function serveAdminFile(path: string, res: ServerResponse): Promise<void> {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  // admin-dist is a sibling of this file (src/server/admin-dist/ or dist/admin-dist/)
  // When running via tsx: currentDir = src/server/
  // When running compiled: currentDir = dist/ — we look relative to the source tree
  const adminDir = existsSync(resolve(currentDir, 'admin-dist'))
    ? resolve(currentDir, 'admin-dist')
    : resolve(currentDir, '..', 'src', 'server', 'admin-dist');

  // Decode once, then constrain the resolved path to the built UI directory.
  // Encoded separators and dot segments must not escape the static root.
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(path);
  } catch {
    sendJson(res, 400, { error: { code: 'bad_request', message: 'Invalid admin asset path' } });
    return;
  }
  let filePath = decodedPath.replace(/^\/admin\/?/, '') || 'index.html';

  // SPA routing: paths without file extensions serve index.html
  const ext = extname(filePath);
  if (!ext) {
    filePath = 'index.html';
  }

  const fullPath = resolve(adminDir, filePath);
  const pathFromRoot = relative(adminDir, fullPath);
  if (
    isAbsolute(pathFromRoot) ||
    pathFromRoot === '..' ||
    pathFromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  ) {
    sendJson(res, 404, { error: { code: 'not_found', message: 'Admin asset not found' } });
    return;
  }

  if (!existsSync(fullPath)) {
    // For SPA routes, fall back to index.html
    const indexPath = join(adminDir, 'index.html');
    if (existsSync(indexPath)) {
      const content = readFileSync(indexPath);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': content.length,
        'Cache-Control': 'no-cache',
      });
      res.end(content);
      return;
    }
    sendJson(res, 404, {
      error: { code: 'not_found', message: 'Admin UI not built. Run: npm run build:admin' },
    });
    return;
  }

  const content = readFileSync(fullPath);
  const mimeType = MIME_TYPES[extname(fullPath)] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': mimeType,
    'Content-Length': content.length,
    // These admin asset filenames are stable (index.js/index.css), not content-hashed.
    // Revalidate them so a server update cannot leave the browser running stale auth code.
    'Cache-Control': 'no-cache',
  });
  res.end(content);
}

/** Serve the public TraceMind launch page and its two static assets. */
export async function serveLaunchFile(path: string, res: ServerResponse): Promise<void> {
  const assets: Record<string, string> = {
    '/': 'launch.html',
    '/launch.html': 'launch.html',
    '/launch.css': 'launch.css',
    '/launch.js': 'launch.js',
  };
  const asset = assets[path];
  if (!asset) {
    sendJson(res, 404, { error: { code: 'not_found', message: 'Launch asset not found' } });
    return;
  }

  const launchDir = resolve(process.cwd(), 'docs');
  const fullPath = resolve(launchDir, asset);
  if (!existsSync(fullPath)) {
    sendJson(res, 404, { error: { code: 'not_found', message: 'Launch page assets not found' } });
    return;
  }

  const content = readFileSync(fullPath);
  res.writeHead(200, {
    'Content-Type': MIME_TYPES[extname(fullPath)] || 'application/octet-stream',
    'Content-Length': content.length,
    'Cache-Control': 'no-cache',
  });
  res.end(content);
}
