/**
 * Final-Bankai — streaming reverse proxy for the three member systems.
 *
 * Route:  /sys/{roster|hiring|tickets}/**  →  matching upstream app.
 *
 * Why: the sidebar opens every system "complete" (own UI, own data) inside
 * the platform shell. External iframes are blocked (X-Frame-Options), and
 * root-absolute asset paths break inside a sub-path, so the platform rewrites:
 *
 *   - strips frame-busting / CSP headers from upstream responses
 *   - prefixes root-absolute URLs ("/api /assets /static, href="/…" src="/…")
 *     inside HTML & JS bodies so they travel through the proxy as well
 *   - rewrites `Location` redirect headers to the proxied prefix
 *   - rewrites upstream cookies onto our origin (drops Domain attr)
 *
 * Non-HTML/JS responses (images, CSV, SSE, upload payloads) stream untouched.
 * Upstreams are configurable via ROSTER_URL / HIRING_URL / TICKETS_URL.
 */

import express from 'express';
import { Readable } from 'node:stream';

export const SYSTEM_UPSTREAMS = {
  roster:  { url: process.env.ROSTER_URL  || 'https://bankairosterattendancee-production.up.railway.app' },
  hiring:  { url: process.env.HIRING_URL  || 'https://bankai-hiring-production.up.railway.app' },
  tickets: { url: process.env.TICKETS_URL || 'https://das-ticketing-system-production.up.railway.app' }
};

/* hop-by-hop / noisy headers we never forward */
const REQ_DROP = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'expect']);
const RES_DROP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'x-frame-options',
                          'content-security-policy', 'content-security-policy-report-only',
                          'cross-origin-opener-policy', 'cross-origin-embedder-policy',
                          'cross-origin-resource-policy', 'permissions-policy', 'strict-transport-security',
                          'content-length']);

/* text bodies that need URL prefixing */
const RW_MIME = /^(?:text\/html|application\/javascript|text\/javascript)\b/;
const RW_MAX = 3 * 1024 * 1024; // don't buffer anything bigger

const router = express.Router();

/* NOTE: this router is mounted at "/sys", so paths arrive pre-stripped: "/roster/api/…" */
router.use('/:key', (req, res, next) => {
  if (process.env.PROXY_DEBUG) console.log(`[proxy] enter ${req.method} /${req.params.key}${req.url}`);
  const sys = req.params.key;
  const upstream = SYSTEM_UPSTREAMS[sys];
  if (!upstream) return res.status(404).json({ error: 'Unknown system.' });

  const prefix = `/sys/${sys}`;
  const sub = req.originalUrl.slice(prefix.length) || '/';
  const target = new URL(sub, upstream.url);

  /* ---- forward headers we care about; force identity encoding (we may rewrite) ---- */
  const headers = {};
  for (const [raw, val] of Object.entries(req.headers)) {
    const h = raw.toLowerCase();
    if (REQ_DROP.has(h) || h.startsWith('if-') || h === 'accept-encoding') continue;
    if (val) headers[h] = val;
  }
  headers['accept-encoding'] = 'identity';
  headers['x-forwarded-host'] = req.headers['x-forwarded-host'] || req.headers.host || '';
  headers['x-forwarded-proto'] = req.headers['x-forwarded-proto'] || req.protocol;
  headers['x-bankai-proxy'] = '1';

  const ac = new AbortController();
  /* cancel the upstream fetch only when the CLIENT connection drops early
     (NB: req 'close' also fires on normal completion — never abort on it) */
  res.on('close', () => { if (!res.writableFinished) ac.abort(); });

  /* Buffer the request body (uploads are capped well below this) — streaming
     Node request streams into undici proved fragile (UND_ERR_SOCKET). */
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > 20 * 1024 * 1024) { req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', drain);
  function drain() {
    if (drain.done) return;
    drain.done = true;
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks);
    if (body) { headers['content-length'] = String(body.length); }
    fetch(target, {
      method: req.method,
      headers,
      body,
      redirect: 'manual',
      signal: ac.signal
    })
      .then(async (up) => {
      const type = String(up.headers.get('content-type') || '');
      if (process.env.PROXY_DEBUG) console.log(`[proxy] ${req.method} ${req.originalUrl} → ${target} :: ${up.status} ${type}`);

      /* ---- redirects: re-point to the proxy prefix ---- */
      const location = up.headers.get('location');
      if (location && [301, 302, 303, 307, 308].includes(up.status)) {
        return res.redirect(up.status, mapLocation(location, target, prefix, up.url));
      }

      /* ---- response headers (minus frame locks) ---- */
      for (const [raw, val] of up.headers) {
        const h = raw.toLowerCase();
        if (RES_DROP.has(h)) continue;
        if (h === 'set-cookie') { res.append('set-cookie', rewriteCookie(val)); continue; }
        res.set(h, val);
      }

      /* ---- HTML/JS bodies: rewrite then send ---- */
      if (up.status >= 200 && up.status < 300 && RW_MIME.test(type) && up.body) {
        let text = await up.text();
        if (text.length <= RW_MAX) text = prefixUrls(text, sys);
        res.setHeader('content-length', String(Buffer.byteLength(text)));
        return res.send(text);
      }

      /* ---- everything else: stream straight through ---- */
      if (up.body) Readable.fromWeb(up.body).pipe(res);
      else res.end();
    })
    .catch((err) => {
      if (ac.signal.aborted) return res.destroy();
      console.error(`proxy ${prefix}:`, err?.cause?.code || err?.message || err);
      if (!res.headersSent) res.status(502).json({ error: `The ${sys} system is not reachable.` });
    });
  }
});

/** Root-absolute URLs inside quotes/attributes → proxied prefix. */
function prefixUrls(text, sys) {
  const p = `/sys/${sys}`;
  return text
    // string literals in JS/HTML: '/api/…   "/assets/…   `/static/…
    .replace(/(['"`])\/(?!sys\/)((?:api|assets|static|favicon\.ico)\/?)/g,
             (m, q, path) => `${q}${p}/${path}`)
    // attributes: href="/x"  src="/y"  action="/z"  (skip values already proxied)
    .replace(/((?:href|src|action|poster)\s*=\s*)(["'])\/(?!sys\/|\/|\w+:)([^/"'])/g,
             (m, attr, q, first) => `${attr}${q}${p}/${first}`);
}

/** Rewrite 3xx Location headers through the prefix. */
function mapLocation(location, target, prefix) {
  try {
    const abs = new URL(location, target);
    if (abs.origin !== target.origin) return location; // genuinely external
    let path = abs.pathname + abs.search + abs.hash;
    if (/^\/(api|assets|static)\//.test(path)) return prefix + path;
    return path.startsWith('/sys/') ? path : prefix + (path === '/' ? '/' : path);
  } catch {
    return location;
  }
}

/** Upstream cookies → scoped to our origin. */
function rewriteCookie(cookie) {
  return cookie
    .replace(/Domain=[^;]+;?/gi, '')
    .replace(/SameSite=[^;]*;?/gi, 'SameSite=Lax;')
    .replace(/;?$/, '');
}

export default router;
