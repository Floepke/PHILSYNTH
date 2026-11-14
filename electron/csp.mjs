// Content-Security-Policy of the desktop app's pages (electron/main.mjs). The window runs without
// the Chromium sandbox so the PATCH instance workers get Node (real-time priority,
// electron/realtime.cjs); this policy keeps code from anywhere but the app's own files from
// running: no remote scripts, no inline scripts except index.html's own (by hash), no blob or
// data workers (a worker would get Node), no plugins and no <base> rewriting.
import { createHash } from 'node:crypto';

const INLINE_SCRIPT = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;

export function contentSecurityPolicy(html) {
  const hashes = [...html.matchAll(INLINE_SCRIPT)]
    .map(([, code]) => `'sha256-${createHash('sha256').update(code, 'utf8').digest('base64')}'`);
  return [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval' ${hashes.join(' ')}`.trim(),
    "worker-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' data: blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}
