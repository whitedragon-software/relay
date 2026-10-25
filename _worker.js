// Cloudflare Workers forwarding proxy — path-embedded scheme.
//
// Target URLs are embedded directly in the proxy's path instead of a query
// param: https://proxy.dev/https://example.com/page?x=1
// (Old bookmarks using ?url=... still work as a fallback.)
//
// Why: putting the real URL in the *path* preserves real directory
// structure, so the browser's native relative-URL resolution — used by ES
// module imports, webpack/rollup chunk loading, CSS url()/@import, etc. —
// resolves correctly on its own. None of that is reachable by rewriting
// HTML or by JS interception, since it happens inside already-fetched JS/CSS
// files we never parse. A query-string scheme collapses everything to the
// proxy's root path, so any such relative reference breaks.
//
// Root-relative references (a raw "/api/x") still can't be fixed by path
// structure alone — a leading "/" always resolves against the *origin*,
// discarding any path prefix, by spec. Click/submit/fetch/XHR are handled by
// injected JS. Direct `location.href = '/x'` or `location.assign('/x')`
// calls made by page JS can't be — you can't intercept assignment to
// `window.location` from a page script (redefining it throws in modern
// browsers).
//
// Every request that reaches the Worker without a properly embedded target
// is corrected server-side using the request's Referer header (see below) —
// this is the primary fix and works immediately, on the very first request.
// A Service Worker is also registered as a backstop for cases where a
// Referer isn't sent (stripped by a privacy setting, etc).
//
// Hardening notes:
// - The real request method/body/relevant headers are forwarded upstream
//   (previously every upstream fetch was an implicit GET, silently
//   dropping POST bodies from proxied fetch/XHR calls).
// - Relative URLs are resolved against upstream.url (the FINAL URL after
//   any redirects), not the originally-requested one, so a target that
//   redirects elsewhere doesn't break every relative link on the result.
// - A self-referential target (proxying the relay's own origin) is refused
//   to avoid recursive self-fetches.
// - WebSocket connections are bridged (see handleWebSocketUpgrade and the
//   client-side WebSocket override below) — browser <-> Worker <-> real
//   target, including converting the handshake's Origin header to the real
//   target's own origin, since many WS servers reject a mismatched one.
// - Every regex inside the ScriptInjector template below is DOUBLE-escaped
//   (\\/ etc.): the template literal consumes one level of backslashes, so
//   single-escaped regexes arrive at the browser corrupted (\\/ck\\/a$ //   collapsing to a line comment, killing the whole injected script).

const SW_PATH = '/__proxy_sw.js';

// "Real path" mode (EXPERIMENTAL). Sites whose client-side router reads
// location.pathname (Next.js, React Router, GitHub's React apps) can't work
// under a path-embedded scheme: they see "/https://host/page" instead of
// "/page", fail to match their routes, and crash or leave widgets inert.
// For these hosts the injected script rewrites the ADDRESS BAR to the real
// path right after load (relative-URL resolution uses our <base> tag, not the
// address bar, so loading is unaffected) and remembers the real origin in a
// short-lived cookie so a reload of the bare path can be routed back.
// Trade-off: the address bar no longer contains the embedded target. Add or
// remove hosts here; set to /^$/ to disable the mode entirely.
const REAL_PATH_HOSTS = /^(www\.)?(bbc\.com|bbc\.co\.uk|github\.com|react\.dev)$/i;
const CTX_COOKIE = '__relay_ctx';
const DEBUG_PATH = '/__relay_debug';
const COOKIES_PATH = '/cookies';

// ---- Cookie jar -------------------------------------------------------------
// Per-site cookies, so logins and sessions work. The Worker has no storage of
// its own, so the jar lives in the VISITOR'S BROWSER as cookies on the relay's
// origin: every upstream cookie becomes ONE relay cookie, named
//
//   __rj_h.<b64u host>.<b64u path>.<b64u name>   HttpOnly - marked HttpOnly upstream
//   __rj_s.<b64u host>.<b64u path>.<b64u name>   readable - the rest; document.cookie
//                                                 in the injected script is a shim over these
//
// with the value base64url(JSON [value, expiresMs (0 = session), secure,
// hostOnly, sameSite]) (sameSite: 0 None, 1 Lax - also the default, 2 Strict).
// One relay cookie per upstream cookie matters: parallel responses (a page and
// its XHRs all setting cookies at once) each touch only their own cookies, so
// none can overwrite another's - a blob per site would lose cookies, and with
// them logins, to that race. The host part is the cookie's Domain attribute
// (or the exact host for host-only cookies), so a request to a.example.com
// finds cookies filed under a.example.com, example.com, ... On each request
// the matching cookies become an ordinary Cookie header for the target, and
// each upstream Set-Cookie becomes one relay Set-Cookie (set or expire).
// Requests that carry jar cookies are personalized and bypass every cache.
// Set COOKIE_JAR to false to turn the jar off.
const COOKIE_JAR = true;
const JAR_PREFIX = '__rj_';
const JAR_COOKIE_MAX = 3800;      // one relay cookie, name + value (browsers cap a cookie near 4 KB)
const JAR_SITE_MAX = 6000;        // all of one site's cookies together
const JAR_BUDGET = 10000;         // every jar cookie together; keeps the Cookie header small
const JAR_MAX_AGE_MS = 400 * 24 * 3600 * 1000;
// There is no public-suffix list in a single-file Worker; these multi-label
// suffixes are the common ones, so a site cannot set a cookie for "co.uk".
const TWO_LEVEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'com.au', 'net.au', 'org.au', 'edu.au',
  'co.jp', 'or.jp', 'ne.jp', 'co.nz', 'org.nz', 'co.in', 'net.in', 'org.in', 'co.kr',
  'com.br', 'com.cn', 'com.mx', 'com.tr', 'com.sg', 'com.hk', 'com.tw', 'com.ar',
  'co.za', 'co.id', 'co.il', 'com.my', 'com.ph', 'com.vn', 'com.ua', 'com.pl'
]);

function b64uEnc(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64uDec(b) {
  try {
    let t = String(b).replace(/-/g, '+').replace(/_/g, '/');
    while (t.length % 4) t += '=';
    const bin = atob(t);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function parseCookieHeader(header) {
  const out = [];
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    out.push([part.slice(0, i).trim(), part.slice(i + 1).trim()]);
  }
  return out;
}

function isPublicSuffix(domain) {
  return !domain.includes('.') || TWO_LEVEL_SUFFIXES.has(domain);
}

// Approximate "site" (registrable domain) for SameSite decisions.
function siteOf(host) {
  host = String(host || '').toLowerCase();
  if (/^[\d.]+$/.test(host) || host.includes(':')) return host;
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const last2 = labels.slice(-2).join('.');
  return TWO_LEVEL_SUFFIXES.has(last2) ? labels.slice(-3).join('.') : last2;
}

function jarPathMatch(reqPath, cookiePath) {
  if (reqPath === cookiePath) return true;
  if (!reqPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || reqPath.charAt(cookiePath.length) === '/';
}

function jarCookieName(kind, key, path, name) {
  return JAR_PREFIX + kind + '.' + b64uEnc(key) + '.' + b64uEnc(path) + '.' + b64uEnc(name);
}

function parseJarName(rawName) {
  if (!rawName.startsWith(JAR_PREFIX)) return null;
  const parts = rawName.split('.');
  if (parts.length !== 4) return null;
  const kind = parts[0].slice(JAR_PREFIX.length);
  if (kind !== 'h' && kind !== 's') return null;
  const key = b64uDec(parts[1]);
  const path = b64uDec(parts[2]);
  const name = b64uDec(parts[3]);
  if (!key || !path || !name) return null;
  return { kind, key, path, name };
}

function jarExpireHeader(name) {
  return name + '=; Path=/; Max-Age=0; Secure; SameSite=Lax';
}

function loadJar(request) {
  const jar = { records: [], raw: new Map(), ops: [], touched: new Set() };
  for (const [rawName, value] of parseCookieHeader(request.headers.get('Cookie'))) {
    const meta = parseJarName(rawName);
    if (!meta) continue;
    jar.raw.set(rawName, { size: rawName.length + value.length + 3, key: meta.key });
    const json = b64uDec(value);
    if (!json) continue;
    let v;
    try {
      v = JSON.parse(json);
    } catch {
      continue;
    }
    if (!Array.isArray(v) || typeof v[0] !== 'string') continue;
    jar.records.push({
      kind: meta.kind, key: meta.key, path: meta.path, name: meta.name, value: v[0],
      exp: Number(v[1]) || 0, secure: v[2] ? 1 : 0, hostOnly: v[3] ? 1 : 0,
      sameSite: v[4] === 0 ? 0 : v[4] === 2 ? 2 : 1, rawName
    });
  }
  return jar;
}

// The Cookie header for one request to `target` (a URL).
function jarCookieHeader(jar, target, crossSite, topLevelNav) {
  const host = target.hostname.toLowerCase();
  const path = target.pathname || '/';
  const https = target.protocol === 'https:';
  const now = Date.now();
  const picked = [];
  for (const r of jar.records) {
    if (!(host === r.key || host.endsWith('.' + r.key))) continue;
    if (r.key !== host && isPublicSuffix(r.key)) continue;   // never a cookie filed under "co.uk" / "com"
    if (r.exp && r.exp <= now) continue;                      // expired
    if (r.hostOnly && host !== r.key) continue;
    if (r.secure && !https) continue;
    if (!jarPathMatch(path, r.path)) continue;
    if (crossSite) {
      // A cross-site request carries only SameSite=None cookies, plus Lax ones
      // on a top-level navigation - as a browser would.
      if (r.sameSite === 2) continue;
      if (r.sameSite === 1 && !topLevelNav) continue;
    }
    picked.push(r);
  }
  picked.sort((a, b) => b.path.length - a.path.length);
  return picked.map((r) => r.name + '=' + r.value).join('; ');
}

// One Set-Cookie line -> a normalized cookie, or null if a browser would reject it.
function parseSetCookie(line, target, now) {
  const parts = String(line).split(';');
  const first = parts.shift() || '';
  const eq = first.indexOf('=');
  if (eq <= 0) return null;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  if (!name) return null;
  let domain = '';
  let path = '';
  let maxAge = null;
  let expires = null;
  let secure = false;
  let httpOnly = false;
  let sameSite = 1;
  for (const p of parts) {
    const i = p.indexOf('=');
    const k = (i < 0 ? p : p.slice(0, i)).trim().toLowerCase();
    const v = i < 0 ? '' : p.slice(i + 1).trim();
    if (k === 'domain') domain = v;
    else if (k === 'path') path = v;
    else if (k === 'max-age') { const n = parseInt(v, 10); if (!Number.isNaN(n)) maxAge = n; }
    else if (k === 'expires') expires = v;
    else if (k === 'secure') secure = true;
    else if (k === 'httponly') httpOnly = true;
    else if (k === 'samesite') { const sv = v.toLowerCase(); sameSite = sv === 'none' ? 0 : sv === 'strict' ? 2 : 1; }
  }
  const host = target.hostname.toLowerCase();
  let key = host;
  let hostOnly = true;
  if (domain) {
    const d = domain.replace(/^\./, '').toLowerCase();
    if (!(host === d || host.endsWith('.' + d))) return null;
    if (isPublicSuffix(d) && d !== host) return null;
    key = d;
    hostOnly = false;
  }
  if (!path || path.charAt(0) !== '/') {
    const pp = target.pathname || '/';
    const idx = pp.lastIndexOf('/');
    path = idx <= 0 ? '/' : pp.slice(0, idx);
  }
  if (secure && target.protocol !== 'https:') return null;
  if (name.startsWith('__Secure-') && !secure) return null;
  if (name.startsWith('__Host-') && !(secure && path === '/' && hostOnly)) return null;
  let del = false;
  let exp = 0;
  if (maxAge !== null) {
    if (maxAge <= 0) del = true;
    else exp = now + Math.min(maxAge * 1000, JAR_MAX_AGE_MS);
  } else if (expires) {
    const t = Date.parse(expires);
    if (!Number.isNaN(t)) {
      if (t <= now) del = true;
      else exp = Math.min(t, now + JAR_MAX_AGE_MS);
    }
  }
  return { name, value, path, key, hostOnly, secure, httpOnly, sameSite, exp, del };
}

// Several Set-Cookie headers, however the runtime exposes them.
function getSetCookies(headers) {
  try {
    if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
    if (typeof headers.getAll === 'function') return headers.getAll('Set-Cookie');
  } catch {
    // fall through
  }
  const raw = headers.get('Set-Cookie');
  return raw ? raw.split(/,(?=\s*[^;,=\s]+=)/) : [];
}

// Turn each upstream Set-Cookie into one relay Set-Cookie (set or expire).
function storeSetCookies(jar, target, lines) {
  const now = Date.now();
  for (const line of lines) {
    const c = parseSetCookie(line, target, now);
    if (!c) continue;
    const kind = c.httpOnly ? 'h' : 's';
    const nameK = jarCookieName(kind, c.key, c.path, c.name);
    const nameO = jarCookieName(kind === 'h' ? 's' : 'h', c.key, c.path, c.name);
    if (c.del) {
      // Always expire both flavours: a concurrent response may have set one
      // that this request's Cookie header does not show yet.
      jar.ops.push(jarExpireHeader(nameK), jarExpireHeader(nameO));
      jar.raw.delete(nameK);
      jar.raw.delete(nameO);
      continue;
    }
    if (jar.raw.has(nameO)) {                      // the same cookie, other flavour
      jar.ops.push(jarExpireHeader(nameO));
      jar.raw.delete(nameO);
    }
    const value = b64uEnc(JSON.stringify([c.value, c.exp, c.secure ? 1 : 0, c.hostOnly ? 1 : 0, c.sameSite]));
    const size = nameK.length + value.length + 3;
    if (size > JAR_COOKIE_MAX) continue;           // too big for one cookie: dropped
    let siteSize = 0;
    for (const [n, m] of jar.raw) if (m.key === c.key && n !== nameK) siteSize += m.size;
    if (siteSize + size > JAR_SITE_MAX) continue;  // one site cannot hog the budget
    let attrs = '; Path=/; Secure; SameSite=Lax' + (httpOnly(kind) ? '; HttpOnly' : '');
    if (c.exp) attrs += '; Max-Age=' + Math.max(1, Math.floor((c.exp - now) / 1000));
    jar.ops.push(nameK + '=' + value + attrs);
    jar.raw.set(nameK, { size, key: c.key });
    jar.touched.add(c.key);
  }
}

function httpOnly(kind) {
  return kind === 'h';
}

// The relay Set-Cookie lines for this request's jar changes. Also keeps the
// total jar size inside JAR_BUDGET by expiring the largest untouched sites, so
// a long browsing history can never bloat the Cookie header past what
// Cloudflare accepts (which would lock the visitor out of the relay).
function jarSetCookieHeaders(jar) {
  const out = jar.ops.slice();
  let total = 0;
  const bySite = new Map();
  for (const [n, m] of jar.raw) {
    total += m.size;
    if (jar.touched.has(m.key)) continue;
    const g = bySite.get(m.key) || { size: 0, names: [] };
    g.size += m.size;
    g.names.push(n);
    bySite.set(m.key, g);
  }
  if (total > JAR_BUDGET) {
    const victims = [...bySite.values()].sort((a, b) => b.size - a.size);
    for (const g of victims) {
      if (total <= JAR_BUDGET) break;
      for (const n of g.names) out.push(jarExpireHeader(n));
      total -= g.size;
    }
  }
  return out;
}

function withJarCookies(headers, setCookies) {
  headers.delete('Set-Cookie');
  for (const c of setCookies) headers.append('Set-Cookie', c);
}

function rebuildWithJarCookies(response, setCookies) {
  const headers = new Headers(response.headers);
  withJarCookies(headers, setCookies);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// Status for a "this request escaped to the relay's origin, go here instead"
// redirect: a POST (a login form, say) must keep its method and body, which
// only 307/308 do.
function recoverStatus(request) {
  return request.method === 'GET' || request.method === 'HEAD' ? 302 : 307;
}

// Is this request for one of the relay's own pages (/login, /logout, /cookies)
// rather than a proxied site's root-relative link of the same name that
// escaped to the relay's origin? A request whose Referer is a proxied page is
// an escape (the Referer logic then repairs it); the login redirect, which
// always carries ?redirect=, is the relay's. A POST is judged the same way: the
// relay's own forms post from the relay's own pages, a proxied site's form
// posts from a proxied page.
const RELAY_ROUTE_PATHS = new Set(['/', '/login', '/logout', '/cookies']);

function looksLikeProxiedPageReferer(request, proxyOrigin) {
  const ref = request.headers.get('Referer');
  if (!ref) return false;
  if (recoverRealUrl(ref, proxyOrigin)) return true;
  if (!getCtxOrigin(request)) return false;
  try {
    const r = new URL(ref);
    return r.origin === proxyOrigin && !RELAY_ROUTE_PATHS.has(r.pathname);
  } catch {
    return false;
  }
}

function isRelayOwnRequest(request, url, proxyOrigin) {
  if (url.searchParams.has('redirect') || url.searchParams.has('error')) return true;
  return !looksLikeProxiedPageReferer(request, proxyOrigin);
}

function cookiesPage(jar) {
  const sites = new Map();
  const now = Date.now();
  for (const r of jar.records) {
    if (r.exp && r.exp <= now) continue;
    const cur = sites.get(r.key) || { n: 0, names: [] };
    cur.n += 1;
    cur.names.push(r.name + (r.kind === 'h' ? ' (HttpOnly)' : ''));
    sites.set(r.key, cur);
  }
  const rows = [...sites.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([h, c]) => {
    const shown = c.names.slice(0, 12).map(escapeHtml).join(', ') + (c.names.length > 12 ? ', …' : '');
    return '<tr><td>' + escapeHtml(h) + '<div class="names">' + shown + '</div></td><td>' + c.n + '</td><td>' +
      '<form method="POST" action="' + COOKIES_PATH + '"><input type="hidden" name="host" value="' + escapeHtml(h) + '">' +
      '<button type="submit">Clear</button></form></td></tr>';
  }).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Relay — Cookies</title>
<style>
  :root { --bg:#FFFFFF; --surface:#F6F6F5; --border:#E1E1DE; --text:#131316; --text-dim:#6C6C72; --accent:#2547F4; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0A0A0C; --surface:#151517; --border:#29292D; --text:#F1F1EF; --text-dim:#8B8B91; --accent:#6C89FF; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
  .wrap { max-width:560px; margin:0 auto; padding:32px 24px 60px; }
  h1 { font-size:22px; margin:0 0 8px; }
  p { font-size:14px; line-height:1.5; color:var(--text-dim); margin:0 0 20px; }
  a { color:var(--accent); }
  table { width:100%; border-collapse:collapse; font-size:14px; margin-bottom:20px; }
  td, th { text-align:left; padding:10px 8px; border-bottom:1px solid var(--border); word-break:break-all; vertical-align:top; }
  th { color:var(--text-dim); font-weight:500; }
  .names { font-size:12px; color:var(--text-dim); margin-top:4px; }
  button { border:1px solid var(--border); background:var(--surface); color:var(--text); border-radius:4px; padding:6px 12px; cursor:pointer; font-size:13px; }
  button:hover { border-color:var(--text-dim); }
  form { margin:0; }
</style>
</head>
<body>
  <div class="wrap">
    <h1>Cookies</h1>
    <p>Cookies for the sites you browse are kept in this browser, on the relay's own address, and sent to each site as if they had been set by it. Only cookie names are shown here, never values. Clearing them signs you out of those sites. <a href="/">Back to relay</a></p>
    ${rows ? '<table><tr><th>Site</th><th>Cookies</th><th></th></tr>' + rows + '</table>' : '<p>No site cookies stored.</p>'}
    ${rows ? '<form method="POST" action="' + COOKIES_PATH + '"><input type="hidden" name="host" value="*"><button type="submit">Clear all cookies</button></form>' : ''}
  </div>
</body>
</html>`;
}

// Real origin of a real-path-mode page, from the cookie its injected script
// sets (null when absent or malformed).
function getCtxOrigin(request) {
  try {
    const raw = relayGetCookie(request, CTX_COOKIE);
    if (raw && /^https?:\/\/[^/\s]+$/i.test(raw)) return raw;
  } catch {
    // ignore malformed cookie
  }
  return null;
}

// What the visiting page's real URL/origin is, as best the request can say.
// Normal pages: the Referer is embedded (relay/https://site/page), so recover
// it. Real-path-mode pages: the Referer is a bare relay path (relay/news), so
// pair it with the real origin from the cookie. Used to restore Referer and
// Origin upstream (hotlink-protected media CDNs check them) and to repair
// URLs the page put in a query string.
function resolvePageContext(request, proxyOrigin) {
  const ref = request.headers.get('Referer');
  const real = recoverRealUrl(ref, proxyOrigin);
  if (real) {
    try {
      return { referer: real, origin: new URL(real).origin };
    } catch {
      // fall through
    }
  }
  const ctx = getCtxOrigin(request);
  if (ctx && ref) {
    try {
      const r = new URL(ref);
      if (r.origin === proxyOrigin) return { referer: ctx + r.pathname + r.search, origin: ctx };
    } catch {
      // fall through
    }
  }
  return { referer: null, origin: null };
}

// A first path segment that looks like a bare domain ("/example.com") is the
// "typed a domain straight after the relay URL" feature, not a real path.
function looksLikeBareDomain(pathname) {
  const seg = pathname.split('/')[1] || '';
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(seg) &&
    !/\.(ico|txt|html?|js|mjs|css|json|png|jpe?g|gif|svg|webp|xml|map|woff2?|ttf|wasm)$/i.test(seg);
}

const SW_SCRIPT = `
// Without these, a newly-deployed version of this script doesn't take over
// an already-open tab until every tab using the OLD version is closed —
// standard SW lifecycle behavior, but it means a redeploy can silently
// leave a browser running stale logic indefinitely, causing confusing
// behavior that only a hard reload (forcing a fresh update check) fixes.
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Some routers (Next.js) collapse "//" in paths: /https://host -> /https:/host.
  // Restore the double slash instead of treating it as a root-relative path.
  const collapsed = url.pathname.match(/^\\/(https?):\\/(?!\\/)(.*)$/i);
  if (collapsed) {
    event.respondWith(Response.redirect(self.location.origin + '/' + collapsed[1] + '://' + collapsed[2] + url.search,
      (req.method === 'GET' || req.method === 'HEAD') ? 302 : 307));
    return;
  }

  // The relay's own pages: the server decides whether one is the relay's or a
  // proxied site's escaped link of the same name.
  if (url.pathname === '/login' || url.pathname === '/logout' || url.pathname === '/cookies') return;

  // Already correctly path-embedded, or the SW script/root usage page — leave alone.
  if (/^\\/https?:\\/\\//.test(url.pathname)) return;
  if (url.pathname === '${SW_PATH}') return;
  if (url.pathname === '/' && !url.search) return;

  // A request landed at our bare origin with no embedded target — recover
  // the real site from whichever proxied page issued it.
  const ref = req.referrer;
  if (!ref) return;
  try {
    const refUrl = new URL(ref);
    const embedded = refUrl.pathname.slice(1);
    const m = embedded.match(/^(https?:\\/\\/[^/]+)/);
    if (!m) return;
    const corrected = self.location.origin + '/' + m[1] + url.pathname + url.search;
    // 307 for a POST (a login form) so its method and body survive.
    event.respondWith(Response.redirect(corrected, (req.method === 'GET' || req.method === 'HEAD') ? 302 : 307));
  } catch (e) {
    // fall through to default handling
  }
});
`;

const HOME_HTML = `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Relay</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #FFFFFF;
    --surface: #F6F6F5;
    --border: #E1E1DE;
    --text: #131316;
    --text-dim: #6C6C72;
    --accent: #2547F4;
    --accent-dim: #E9ECFE;
    --warn: #C7431E;
  }
  html[data-theme="dark"] {
    --bg: #0A0A0C;
    --surface: #151517;
    --border: #29292D;
    --text: #F1F1EF;
    --text-dim: #8B8B91;
    --accent: #6C89FF;
    --accent-dim: #16193A;
    --warn: #FF8A63;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: 'Space Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    -webkit-font-smoothing: antialiased;
    transition: background 0.25s ease, color 0.25s ease;
  }
  .wrap {
    min-height: 100%;
    display: flex;
    flex-direction: column;
    max-width: 640px;
    margin: 0 auto;
    padding: 28px 24px 60px;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: clamp(48px, 12vh, 96px);
  }
  .mark {
    display: flex;
    align-items: center;
    gap: 10px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    letter-spacing: 0.08em;
    color: var(--text-dim);
    text-transform: uppercase;
  }
  .mark .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
  }
  .theme-toggle {
    width: 34px;
    height: 34px;
    border-radius: 4px;
    border: 1px solid var(--border);
    background: var(--surface);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    color: var(--text);
    transition: border-color 0.15s ease;
  }
  .theme-toggle:hover { border-color: var(--text-dim); }
  .theme-toggle svg { width: 15px; height: 15px; }

  main { flex: 1; }

  .header-right { display: flex; align-items: center; gap: 10px; }
  .header-btn {
    display: flex;
    align-items: center;
    height: 34px;
    padding: 0 12px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--surface);
    color: var(--text);
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    text-decoration: none;
    transition: border-color 0.15s ease;
  }
  .header-btn:hover { border-color: var(--text-dim); }

  .eyebrow {
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--accent);
    margin: 0 0 14px;
  }
  h1 {
    font-size: clamp(36px, 7vw, 52px);
    font-weight: 600;
    line-height: 1.05;
    letter-spacing: -0.02em;
    margin: 0 0 16px;
  }
  .sub {
    font-size: 16px;
    line-height: 1.5;
    color: var(--text-dim);
    max-width: 46ch;
    margin: 0 0 40px;
  }

  form { margin-bottom: 56px; }
  .field {
    display: flex;
    align-items: center;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--surface);
    transition: border-color 0.15s ease;
  }
  .field:focus-within { border-color: var(--accent); }
  .field input {
    flex: 1;
    border: 0;
    background: transparent;
    outline: none;
    padding: 16px 4px 16px 16px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 14px;
    color: var(--text);
  }
  .field input::placeholder { color: var(--text-dim); }
  .field button {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 46px;
    height: 46px;
    margin: 4px;
    border: 0;
    border-radius: 3px;
    background: var(--accent);
    color: var(--bg);
    cursor: pointer;
    flex-shrink: 0;
    transition: opacity 0.15s ease;
  }
  html[data-theme="dark"] .field button { color: #0A0A0C; }
  .field button:hover { opacity: 0.85; }
  .field button svg { width: 17px; height: 17px; }
  .hint {
    margin: 10px 2px 0;
    font-size: 13px;
    color: var(--text-dim);
    min-height: 18px;
  }
  .hint.error { color: var(--warn); }

  .trace {
    display: flex;
    align-items: center;
    gap: 0;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--text-dim);
  }
  .trace .node { display: flex; flex-direction: column; align-items: center; gap: 8px; flex-shrink: 0; }
  .trace .node span.sq {
    width: 9px; height: 9px;
    border: 1px solid var(--text-dim);
  }
  .trace .node.active span.sq { background: var(--accent); border-color: var(--accent); }
  .trace .line {
    flex: 1;
    height: 1px;
    background: var(--border);
    position: relative;
    margin: 0 -1px;
    top: -13px;
  }
  .trace .line .pulse {
    position: absolute;
    top: -2px;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--accent);
    animation: travel 3.2s linear infinite;
  }
  @keyframes travel {
    0% { left: 0%; opacity: 0; }
    8% { opacity: 1; }
    92% { opacity: 1; }
    100% { left: 100%; opacity: 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    .trace .line .pulse { animation: none; opacity: 0.6; left: 50%; }
  }

  footer {
    margin-top: 64px;
    padding-top: 20px;
    border-top: 1px solid var(--border);
    display: flex;
    justify-content: space-between;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: var(--text-dim);
    letter-spacing: 0.04em;
  }

  @media (max-width: 460px) {
    .trace .node span.label { display: none; }
  }
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <div class="mark"><span class="dot"></span>relay</div>
      <div class="header-right">
      __RELAY_HEADER_ACTIONS__
      <button class="theme-toggle" id="themeToggle" aria-label="Switch theme" type="button">
        <svg id="themeIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
          <circle cx="12" cy="12" r="4.6"></circle>
          <path d="M12 2.4v2.4M12 19.2v2.4M4.4 12H2M22 12h-2.4M5.6 5.6l1.7 1.7M16.7 16.7l1.7 1.7M5.6 18.4l1.7-1.7M16.7 7.3l1.7-1.7"></path>
        </svg>
      </button>
      </div>
    </header>

    <main>
      <p class="eyebrow">// relay</p>
      <h1>Route any address<br>through here.</h1>
      <p class="sub">Enter a URL. It loads through this relay, links and scripts included, without leaving the address bar.</p>

      <form id="goForm" autocomplete="off">
        <div class="field">
          <input id="urlInput" type="text" inputmode="url" placeholder="example.com/path" spellcheck="false" autofocus>
          <button type="submit" aria-label="Go">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square">
              <path d="M4 12h15M13 6l6 6-6 6"></path>
            </svg>
          </button>
        </div>
        <p class="hint" id="hint">Prefix is optional — https:// is assumed.</p>
      </form>

      <div class="trace" id="trace">
        <div class="node active"><span class="sq"></span><span class="label">you</span></div>
        <div class="line"><span class="pulse"></span></div>
        <div class="node"><span class="sq"></span><span class="label">relay</span></div>
        <div class="line"><span class="pulse" style="animation-delay: 1.6s;"></span></div>
        <div class="node"><span class="sq"></span><span class="label">target</span></div>
      </div>
    </main>

    <footer>
      <span id="originLabel"></span>
      <span>build v0.11.0 · path-embedded __RELAY_LOGOUT_LINK__</span>
    </footer>
  </div>

<script>
(function() {
  var root = document.documentElement;
  var sunPath = 'M12 2.4v2.4M12 19.2v2.4M4.4 12H2M22 12h-2.4M5.6 5.6l1.7 1.7M16.7 16.7l1.7 1.7M5.6 18.4l1.7-1.7M16.7 7.3l1.7-1.7';
  var moonPath = 'M20 14.6A8.4 8.4 0 1 1 9.4 4a6.7 6.7 0 0 0 10.6 10.6z';

  function applyIcon(theme) {
    var circle = document.querySelector('#themeIcon circle');
    var path = document.querySelector('#themeIcon path');
    if (theme === 'dark') {
      if (circle) circle.setAttribute('r', '0');
      path.setAttribute('d', moonPath);
    } else {
      if (circle) circle.setAttribute('r', '4.6');
      path.setAttribute('d', sunPath);
    }
  }

  var saved = null;
  try { saved = localStorage.getItem('relay-theme'); } catch (e) {}
  var theme = saved || 'light';
  root.setAttribute('data-theme', theme);
  applyIcon(theme);

  document.getElementById('themeToggle').addEventListener('click', function() {
    theme = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', theme);
    applyIcon(theme);
    try { localStorage.setItem('relay-theme', theme); } catch (e) {}
  });

  document.getElementById('originLabel').textContent = location.origin.replace(/^https?:\\/\\//, '');

  var input = document.getElementById('urlInput');
  var hint = document.getElementById('hint');
  var trace = document.getElementById('trace');

  function go() {
    var val = input.value.trim();
    if (!val) { hint.textContent = 'Enter an address first.'; hint.className = 'hint error'; return; }
    if (!/^https?:\\/\\//i.test(val)) val = 'https://' + val;
    try {
      var u = new URL(val);
      if (u.origin === location.origin) {
        hint.textContent = "That's this relay's own address — enter the site you want to visit instead.";
        hint.className = 'hint error';
        return;
      }
      trace.classList.add('sending');
      window.location.href = location.origin + '/' + u.href;
    } catch (e) {
      hint.textContent = 'That address doesn\\'t look valid.';
      hint.className = 'hint error';
    }
  }

  document.getElementById('goForm').addEventListener('submit', function(e) {
    e.preventDefault();
    go();
  });

  input.addEventListener('input', function() {
    hint.textContent = 'Prefix is optional — https:// is assumed.';
    hint.className = 'hint';
  });
})();
</script>
</body>
</html>`;

// Shared error page — same design tokens, fonts, and theme toggle as
// HOME_HTML, kept as a separate template so the working homepage is never
// touched by changes here. status/title/message/detail/targetUrl are all
// escaped before interpolation.
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function errorPage({ status, title, message, detail, targetUrl, proxyOrigin }) {
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  const safeDetail = detail ? escapeHtml(detail) : '';
  const safeTarget = targetUrl ? escapeHtml(targetUrl) : '';
  const homeUrl = escapeHtml(proxyOrigin + '/');

  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${status} — Relay</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #FFFFFF;
    --surface: #F6F6F5;
    --border: #E1E1DE;
    --text: #131316;
    --text-dim: #6C6C72;
    --accent: #2547F4;
    --accent-dim: #E9ECFE;
    --warn: #C7431E;
  }
  html[data-theme="dark"] {
    --bg: #0A0A0C;
    --surface: #151517;
    --border: #29292D;
    --text: #F1F1EF;
    --text-dim: #8B8B91;
    --accent: #6C89FF;
    --accent-dim: #16193A;
    --warn: #FF8A63;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: 'Space Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    -webkit-font-smoothing: antialiased;
    transition: background 0.25s ease, color 0.25s ease;
  }
  .wrap {
    min-height: 100%;
    display: flex;
    flex-direction: column;
    max-width: 640px;
    margin: 0 auto;
    padding: 28px 24px 60px;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: clamp(48px, 12vh, 96px);
  }
  .mark {
    display: flex;
    align-items: center;
    gap: 10px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    letter-spacing: 0.08em;
    color: var(--text-dim);
    text-transform: uppercase;
    text-decoration: none;
  }
  .mark .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--warn);
  }
  .theme-toggle {
    width: 34px;
    height: 34px;
    border-radius: 4px;
    border: 1px solid var(--border);
    background: var(--surface);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    color: var(--text);
    transition: border-color 0.15s ease;
  }
  .theme-toggle:hover { border-color: var(--text-dim); }
  .theme-toggle svg { width: 15px; height: 15px; }

  main { flex: 1; }

  .code {
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--warn);
    margin: 0 0 14px;
  }
  h1 {
    font-size: clamp(30px, 6vw, 44px);
    font-weight: 600;
    line-height: 1.1;
    letter-spacing: -0.02em;
    margin: 0 0 16px;
  }
  .sub {
    font-size: 16px;
    line-height: 1.5;
    color: var(--text-dim);
    max-width: 50ch;
    margin: 0 0 8px;
  }
  .detail {
    font-size: 14px;
    line-height: 1.5;
    color: var(--text-dim);
    max-width: 50ch;
    margin: 0 0 32px;
  }
  .target {
    display: block;
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 12px 14px;
    margin: 0 0 32px;
    word-break: break-all;
  }
  .actions {
    display: flex;
    gap: 12px;
    margin-bottom: 56px;
  }
  .btn {
    font-family: 'Space Grotesk', sans-serif;
    font-size: 14px;
    font-weight: 500;
    text-decoration: none;
    padding: 12px 20px;
    border-radius: 4px;
    cursor: pointer;
    border: 1px solid transparent;
  }
  .btn.primary {
    background: var(--accent);
    color: var(--bg);
    border: 0;
  }
  html[data-theme="dark"] .btn.primary { color: #0A0A0C; }
  .btn.primary:hover { opacity: 0.85; }
  .btn.secondary {
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
  }
  .btn.secondary:hover { border-color: var(--text-dim); }

  .trace {
    display: flex;
    align-items: center;
    gap: 0;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--text-dim);
  }
  .trace .node { display: flex; flex-direction: column; align-items: center; gap: 8px; flex-shrink: 0; }
  .trace .node span.sq { width: 9px; height: 9px; border: 1px solid var(--text-dim); }
  .trace .node.active span.sq { background: var(--accent); border-color: var(--accent); }
  .trace .node.broken span.sq { background: var(--warn); border-color: var(--warn); }
  .trace .line { flex: 1; height: 1px; background: var(--border); margin: 0 -1px; top: -13px; position: relative; }
  .trace .line.broken { background: repeating-linear-gradient(90deg, var(--warn), var(--warn) 4px, transparent 4px, transparent 8px); }

  footer {
    margin-top: auto;
    padding-top: 20px;
    border-top: 1px solid var(--border);
    display: flex;
    justify-content: space-between;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: var(--text-dim);
    letter-spacing: 0.04em;
  }
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <a class="mark" href="/"><span class="dot"></span>relay</a>
      <button class="theme-toggle" id="themeToggle" aria-label="Switch theme" type="button">
        <svg id="themeIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
          <circle cx="12" cy="12" r="4.6"></circle>
          <path d="M12 2.4v2.4M12 19.2v2.4M4.4 12H2M22 12h-2.4M5.6 5.6l1.7 1.7M16.7 16.7l1.7 1.7M5.6 18.4l1.7-1.7M16.7 7.3l1.7-1.7"></path>
        </svg>
      </button>
    </header>

    <main>
      <p class="code">// error ${status}</p>
      <h1>${safeTitle}</h1>
      <p class="sub">${safeMessage}</p>
      ${safeDetail ? `<p class="detail">${safeDetail}</p>` : ''}
      ${safeTarget ? `<code class="target">${safeTarget}</code>` : ''}

      <div class="actions">
        <a class="btn primary" href="${homeUrl}">Back to relay</a>
        <button class="btn secondary" id="goBackBtn" type="button">Go back</button>
      </div>

      <div class="trace">
        <div class="node active"><span class="sq"></span><span>you</span></div>
        <div class="line"></div>
        <div class="node active"><span class="sq"></span><span>relay</span></div>
        <div class="line broken"></div>
        <div class="node broken"><span class="sq"></span><span>target</span></div>
      </div>
    </main>

    <footer>
      <span id="originLabel"></span>
      <span>status ${status}</span>
    </footer>
  </div>

<script>
(function() {
  var root = document.documentElement;
  var sunPath = 'M12 2.4v2.4M12 19.2v2.4M4.4 12H2M22 12h-2.4M5.6 5.6l1.7 1.7M16.7 16.7l1.7 1.7M5.6 18.4l1.7-1.7M16.7 7.3l1.7-1.7';
  var moonPath = 'M20 14.6A8.4 8.4 0 1 1 9.4 4a6.7 6.7 0 0 0 10.6 10.6z';

  function applyIcon(theme) {
    var circle = document.querySelector('#themeIcon circle');
    var path = document.querySelector('#themeIcon path');
    if (theme === 'dark') {
      if (circle) circle.setAttribute('r', '0');
      path.setAttribute('d', moonPath);
    } else {
      if (circle) circle.setAttribute('r', '4.6');
      path.setAttribute('d', sunPath);
    }
  }

  var saved = null;
  try { saved = localStorage.getItem('relay-theme'); } catch (e) {}
  var theme = saved || 'light';
  root.setAttribute('data-theme', theme);
  applyIcon(theme);

  document.getElementById('themeToggle').addEventListener('click', function() {
    theme = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', theme);
    applyIcon(theme);
    try { localStorage.setItem('relay-theme', theme); } catch (e) {}
  });

  document.getElementById('originLabel').textContent = location.origin.replace(/^https?:\\/\\//, '');

  document.getElementById('goBackBtn').addEventListener('click', function() {
    // history.length > 1 means there's actually somewhere to go back to —
    // if this page was the first entry in the tab (a directly pasted or
    // bookmarked URL), history.back() would otherwise silently do nothing.
    if (window.history.length > 1) {
      window.history.back();
    } else {
      window.location.href = '${homeUrl}';
    }
  });
})();
</script>
</body>
</html>`;
}

function errorResponse(proxyOrigin, status, title, message, detail, targetUrl) {
  return new Response(errorPage({ status, title, message, detail, targetUrl, proxyOrigin }), {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

// --- Password gate ---------------------------------------------------------
// Entirely optional: only active when the PASSWORD environment variable is
// set (via `wrangler secret put PASSWORD` or a dashboard env var). Unset —
// the default — means the relay behaves exactly as before, no auth at all.
const AUTH_COOKIE = '__relay_pwd';
const AUTH_PATH = '/login';
const LOGOUT_PATH = '/logout';
// Pre-v0.10 URLs; kept as redirects so old bookmarks keep working.
const OLD_AUTH_PATH = '/__relay_login';
const OLD_LOGOUT_PATH = '/__relay_logout';

// `redirect` is user-controlled and gets appended to our origin. Anything
// not a plain absolute path could escape it: "@evil.com" parses as userinfo
// (host becomes evil.com), ".evil.com" as a subdomain of ours. Require a
// single leading slash, else fall back to the homepage.
function safeRedirectPath(r) {
  return typeof r === 'string' && r.charAt(0) === '/' && r.charAt(1) !== '/' && r.charAt(1) !== '\\'
    ? r
    : '/';
}

// The cookie stores a hash of the password, not the password itself, so the
// raw secret isn't sitting in a cookie if it's ever exposed some other way.
async function relayHashPassword(pwd) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pwd));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function relayGetCookie(request, name) {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  const match = header.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

async function relayIsAuthed(request, env) {
  if (!env || !env.PASSWORD) return true;
  const cookieVal = relayGetCookie(request, AUTH_COOKIE);
  if (!cookieVal) return false;
  return cookieVal === (await relayHashPassword(env.PASSWORD));
}

// Deliberately lean, not sharing HOME_HTML/errorPage's full CSS — a login
// form doesn't need their trace diagram, theme-toggle JS, or font loading.
// prefers-color-scheme covers dark mode without needing that JS at all.
function authPage(redirectTo, wrongPassword) {
  const safeRedirect = escapeHtml(redirectTo || '/');
  const msg = wrongPassword ? 'Incorrect password.' : 'This relay is password-protected.';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Relay — Sign in</title>
<style>
  :root { --bg:#FFFFFF; --surface:#F6F6F5; --border:#E1E1DE; --text:#131316; --text-dim:#6C6C72; --accent:#2547F4; --warn:#C7431E; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0A0A0C; --surface:#151517; --border:#29292D; --text:#F1F1EF; --text-dim:#8B8B91; --accent:#6C89FF; --warn:#FF8A63; }
  }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; background:var(--bg); color:var(--text); font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
  .box { width:100%; max-width:300px; padding:24px; }
  h1 { font-size:20px; margin:0 0 8px; }
  p { font-size:14px; color:var(--text-dim); margin:0 0 20px; }
  p.err { color:var(--warn); }
  .field { display:flex; border:1px solid var(--border); border-radius:4px; background:var(--surface); }
  input { flex:1; min-width:0; border:0; background:transparent; outline:none; padding:12px; font-size:14px; color:var(--text); }
  button { border:0; background:var(--accent); color:#fff; padding:0 16px; border-radius:0 3px 3px 0; cursor:pointer; }
</style>
</head>
<body>
  <form class="box" method="POST" action="${AUTH_PATH}">
    <h1>relay</h1>
    <p class="${wrongPassword ? 'err' : ''}">${msg}</p>
    <input type="hidden" name="redirect" value="${safeRedirect}">
    <div class="field">
      <input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password">
      <button type="submit">Go</button>
    </div>
  </form>
</body>
</html>`;
}

// WebSocket bridging: browser <-> this Worker <-> the real target.
// The client-side WebSocket constructor override (in ScriptInjector) routes
// ws(s) connections through this same path-embedded scheme (e.g.
// /wss://real.com/socket); this is the server-side half that completes the
// handshake on both ends and relays messages/close/error between them.
//
// Cloudflare Workers negotiate an OUTBOUND WebSocket via a plain http(s)
// fetch() with an Upgrade header set — not a literal wss:// URL — and the
// far end is then exposed as `response.webSocket`.
async function handleWebSocketUpgrade(request, url, proxyOrigin) {
  const targetUrl = url.pathname.slice(1) + url.search;
  if (!/^wss?:\/\//i.test(targetUrl)) {
    return new Response('Invalid WebSocket target', { status: 400 });
  }

  let parsedTarget;
  try {
    parsedTarget = new URL(targetUrl);
  } catch {
    return new Response('Invalid WebSocket target', { status: 400 });
  }
  if (parsedTarget.origin.replace(/^wss?/, 'https') === proxyOrigin) {
    return new Response('Refusing to proxy the relay itself', { status: 400 });
  }

  const httpEquivalent = parsedTarget.href.replace(/^ws/, 'http');
  const realOrigin = parsedTarget.origin.replace(/^ws/, 'http');

  const upstreamHeaders = new Headers({
    'Upgrade': 'websocket',
    'Connection': 'Upgrade',
    // Real target origin, not our proxy's — many WebSocket servers reject
    // the handshake outright if Origin doesn't match their own site.
    'Origin': realOrigin,
    // Real browser UA, not a fixed spoofed one — see buildUpstreamHeaders.
    'User-Agent': request.headers.get('User-Agent') || FALLBACK_USER_AGENT
  });
  // Forward subprotocol negotiation. The browser's WebSocket constructor
  // sends its offered protocols in this header; it must eventually see
  // back whichever one the real server actually chose (below), or
  // socket.protocol is empty and strict clients reject the connection.
  const requestedProtocol = request.headers.get('Sec-WebSocket-Protocol');
  if (requestedProtocol) upstreamHeaders.set('Sec-WebSocket-Protocol', requestedProtocol);

  // The visitor's cookies for the target, so socket handshakes that
  // authenticate by cookie work.
  if (COOKIE_JAR) {
    try {
      const wsCookies = jarCookieHeader(loadJar(request), new URL(httpEquivalent), false, false);
      if (wsCookies) upstreamHeaders.set('Cookie', wsCookies);
    } catch {
      // no cookies for this socket
    }
  }

  let upstream;
  try {
    // 10s is generous for a handshake specifically (not the connection's
    // lifetime — once upstream.webSocket exists below, it's independent of
    // this timeout) while still failing fast on an unreachable game server
    // rather than leaving the connecting UI hanging indefinitely.
    upstream = await fetchUpstream(httpEquivalent, { headers: upstreamHeaders }, 10000);
  } catch (err) {
    return new Response('WebSocket upstream connection failed: ' + err.message, { status: 502 });
  }

  const upstreamSocket = upstream.webSocket;
  if (!upstreamSocket) {
    return new Response('Target did not upgrade to WebSocket', { status: 502 });
  }

  let client, server;
  try {
    upstreamSocket.accept();
    [client, server] = Object.values(new WebSocketPair());
    server.accept();
  } catch (err) {
    try { upstreamSocket.close(); } catch {}
    return new Response('WebSocket bridge setup failed: ' + err.message, { status: 502 });
  }

  server.addEventListener('message', (e) => {
    try { upstreamSocket.send(e.data); } catch {}
  });
  upstreamSocket.addEventListener('message', (e) => {
    try { server.send(e.data); } catch {}
  });
  server.addEventListener('close', (e) => {
    try { upstreamSocket.close(e.code, e.reason); } catch {}
  });
  upstreamSocket.addEventListener('close', (e) => {
    try { server.close(e.code, e.reason); } catch {}
  });
  server.addEventListener('error', () => { try { upstreamSocket.close(); } catch {} });
  upstreamSocket.addEventListener('error', () => { try { server.close(); } catch {} });

  // Echo back whichever subprotocol the REAL server actually accepted —
  // not simply the client's request verbatim.
  const acceptedProtocol = upstream.headers.get('Sec-WebSocket-Protocol');
  const responseInit = { status: 101, webSocket: client };
  if (acceptedProtocol) {
    responseInit.headers = { 'Sec-WebSocket-Protocol': acceptedProtocol };
  }
  return new Response(null, responseInit);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const proxyOrigin = url.origin;

    // Entirely a no-op when env.PASSWORD isn't set — see relayIsAuthed.
    if (env && env.PASSWORD) {
      // Pre-v0.10 URLs.
      if (url.pathname === OLD_LOGOUT_PATH) return Response.redirect(proxyOrigin + LOGOUT_PATH, 302);
      if (url.pathname === OLD_AUTH_PATH) return Response.redirect(proxyOrigin + AUTH_PATH + url.search, 302);

      // /login and /logout are short, common names: a proxied site's own
      // root-relative link to its /login that escaped to this origin must
      // still be repaired from the Referer, not answered by the relay.
      const ownRoute = (url.pathname === LOGOUT_PATH || url.pathname === AUTH_PATH) &&
        isRelayOwnRequest(request, url, proxyOrigin);

      if (ownRoute && url.pathname === LOGOUT_PATH) {
        const headers = new Headers({ Location: proxyOrigin + AUTH_PATH });
        headers.append('Set-Cookie', `${AUTH_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
        return new Response(null, { status: 302, headers });
      }

      if (ownRoute && url.pathname === AUTH_PATH) {
        if (request.method === 'POST') {
          const form = await request.formData();
          const submitted = String(form.get('password') || '');
          const redirectTo = safeRedirectPath(String(form.get('redirect') || '/'));
          if (submitted === env.PASSWORD) {
            const token = await relayHashPassword(env.PASSWORD);
            const headers = new Headers({ Location: proxyOrigin + redirectTo });
            headers.append(
              'Set-Cookie',
              `${AUTH_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`
            );
            return new Response(null, { status: 302, headers });
          }
          // Redirect back to the clean login URL rather than rendering the
          // form inline on this POST response — otherwise refreshing after
          // a wrong password re-submits it, and the browser warns about
          // resending form data.
          const back = AUTH_PATH + '?redirect=' + encodeURIComponent(redirectTo) + '&error=1';
          return Response.redirect(proxyOrigin + back, 302);
        }
        // GET (or any other method) — render the login form itself. This is
        // the clean, dedicated URL the address bar shows while signing in,
        // instead of whatever arbitrary destination was originally requested.
        const redirectTo = safeRedirectPath(url.searchParams.get('redirect') || '/');
        const wrongPassword = url.searchParams.get('error') === '1';
        return new Response(authPage(redirectTo, wrongPassword), {
          status: wrongPassword ? 401 : 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
      }

      if (!(await relayIsAuthed(request, env))) {
        const dest = url.pathname + url.search;
        return Response.redirect(
          proxyOrigin + AUTH_PATH + '?redirect=' + encodeURIComponent(dest),
          302
        );
      }
    }

    if (request.headers.get('Upgrade') === 'websocket') {
      return handleWebSocketUpgrade(request, url, proxyOrigin);
    }

    if (url.pathname === SW_PATH) {
      return new Response(SW_SCRIPT, {
        headers: { 'Content-Type': 'application/javascript' }
      });
    }

    // Debug mode switch: visit /__relay_debug to turn the injected script's
    // verbose diagnostics on for 24 h (cookie), /__relay_debug?on=0 to turn
    // them off. Meant for phones, where editing the worker for a flag is a pain.
    if (url.pathname === DEBUG_PATH) {
      const on = url.searchParams.get('on') !== '0';
      return new Response(
        '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<title>Relay debug</title><body style="font:16px system-ui;padding:24px;max-width:480px">' +
        '<h2>Relay debug mode: ' + (on ? 'ON' : 'OFF') + '</h2>' +
        (on
          ? '<p>Verbose diagnostics are on for 24 hours: navigation events, clicks with no link, and a log that survives page jumps.</p><p><a href="' + DEBUG_PATH + '?on=0">Turn off</a></p>'
          : '<p><a href="' + DEBUG_PATH + '">Turn on</a></p>') +
        '<p><a href="/">Back to relay</a></p>',
        {
          status: 200,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Set-Cookie': '__relay_debug=' + (on ? '1' : '') + '; Path=/; Max-Age=' + (on ? 86400 : 0) + '; Secure; SameSite=Lax',
            'Cache-Control': 'no-store'
          }
        }
      );
    }

    // Cookie manager: lists the sites that have cookies in this browser's jar
    // and clears them. Like /login, a proxied site's own /cookies link that
    // escaped to this origin is repaired from the Referer instead.
    if (COOKIE_JAR && url.pathname === COOKIES_PATH && isRelayOwnRequest(request, url, proxyOrigin)) {
      const jarForPage = loadJar(request);
      if (request.method === 'POST') {
        const form = await request.formData();
        const which = String(form.get('host') || '*');
        const headers = new Headers({ Location: proxyOrigin + COOKIES_PATH });
        for (const [name, meta] of jarForPage.raw) {
          if (which === '*' || meta.key === which) headers.append('Set-Cookie', jarExpireHeader(name));
        }
        return new Response(null, { status: 302, headers });
      }
      return new Response(cookiesPage(jarForPage), {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
      });
    }

    // Some client code (Next.js's router does this) collapses "//" in paths:
    // /https://host/x becomes /https:/host/x. Restore it before anything
    // else treats it as a root-relative reference.
    const collapsed = url.pathname.match(/^\/(https?):\/(?!\/)(.*)$/i);
    if (collapsed) {
      return Response.redirect(proxyOrigin + '/' + collapsed[1] + '://' + collapsed[2] + url.search, recoverStatus(request));
    }

    const alreadyEmbedded = /^\/https?:\/\//i.test(url.pathname);

    // Legacy ?url=... links: never served directly — always redirect to the
    // canonical path-embedded form, so ?url= never lingers in the URL bar.
    if (url.searchParams.has('url') && !alreadyEmbedded) {
      let legacy = url.searchParams.get('url');
      if (!/^https?:\/\//i.test(legacy)) legacy = 'https://' + legacy;
      try {
        const canonical = proxyOrigin + '/' + new URL(legacy).href;
        return Response.redirect(canonical, 301);
      } catch {
        return errorResponse(proxyOrigin, 400, "That address didn't parse", "The URL passed via ?url= couldn't be read as a valid address.", null, legacy);
      }
    }

    // Any other request that isn't already correctly path-embedded is a
    // root-relative reference that escaped to the bare origin (a direct
    // `location.href = '/x'` assignment, a request the Service Worker hasn't
    // taken control of yet, etc). Recover the real target from the request's
    // Referer — the browser sets this automatically to whichever proxied
    // page issued the request — and redirect to the corrected URL rather
    // than silently failing or mis-serving it.
    if (!alreadyEmbedded) {
      // Real-path-mode context (see REAL_PATH_HOSTS): the address bar holds a
      // bare real path, so Referer can't say which site it belongs to. The
      // injected script left the real origin in a cookie.
      let ctxOrigin = null;
      try {
        const rawCtx = relayGetCookie(request, CTX_COOKIE);
        if (rawCtx && /^https?:\/\/[^/\s]+$/i.test(rawCtx)) ctxOrigin = rawCtx;
      } catch {
        // ignore malformed cookie
      }
      const canUseCtx = !!ctxOrigin && (url.pathname !== '/' || !!url.search) && !looksLikeBareDomain(url.pathname);
      // A reload / typed address is browser-initiated: its Referer is stale
      // (whatever page originally linked here), so trust the cookie first.
      const browserInitiated =
        request.headers.get('Sec-Fetch-Site') === 'none' && request.headers.get('Sec-Fetch-Mode') === 'navigate';
      if (canUseCtx && browserInitiated) {
        return Response.redirect(proxyOrigin + '/' + ctxOrigin + url.pathname + url.search, recoverStatus(request));
      }

      const ref = request.headers.get('Referer');
      if (ref) {
        try {
          const refUrl = new URL(ref);
          if (refUrl.origin === proxyOrigin) {
            const embedded = refUrl.pathname.slice(1);
            const m = embedded.match(/^(https?:\/\/[^/]+)/);
            if (m) {
              const corrected = proxyOrigin + '/' + m[1] + url.pathname + url.search;
              return Response.redirect(corrected, recoverStatus(request));
            }
          }
        } catch {
          // fall through
        }
      }
      // Referer couldn't place it (e.g. the page is in real-path mode, so its
      // Referer is itself a bare path): fall back to the cookie.
      if (canUseCtx) {
        return Response.redirect(proxyOrigin + '/' + ctxOrigin + url.pathname + url.search, recoverStatus(request));
      }
    }

    // Placed after the Referer-recovery block above on purpose: a favicon
    // request issued from a proxied page carries a Referer and gets
    // redirected to the TARGET's own favicon — keep that. These only need
    // handling when recovery can't fire (homepage visits, stripped
    // referrers, crawlers), where they'd otherwise fall through to the
    // bare-hostname path and trigger a doomed upstream fetch of
    // https://favicon.ico plus a rendered 502 on every homepage visit.
    if (url.pathname === '/favicon.ico') {
      return new Response(null, {
        status: 204,
        headers: { 'Cache-Control': 'public, max-age=86400' }
      });
    }
    if (url.pathname === '/robots.txt') {
      return new Response('User-agent: *\nDisallow: /\n', {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }

    // Path-embedded target, e.g. "/https://example.com/page" + "?x=1"
    let targetUrl = url.pathname.slice(1) + url.search;

    if (!targetUrl) {
      // The log-out controls only exist when a password is configured —
      // otherwise there's no session to log out of.
      const hasPassword = !!(env && env.PASSWORD);
      const footerLinks = [];
      if (hasPassword) footerLinks.push(`<a href="${LOGOUT_PATH}" style="color:inherit;">log out</a>`);
      if (COOKIE_JAR) footerLinks.push(`<a href="${COOKIES_PATH}" style="color:inherit;">cookies</a>`);
      const headerActions = hasPassword ? `<a class="header-btn" href="${LOGOUT_PATH}">Log out</a>` : '';
      const homeHtml = HOME_HTML
        .replace('__RELAY_LOGOUT_LINK__', footerLinks.map((l) => ' · ' + l).join(''))
        .replace('__RELAY_HEADER_ACTIONS__', headerActions);
      return new Response(homeHtml, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    // No scheme and no Referer to recover from — treat as a bare domain
    // typed directly (e.g. someone navigated straight to
    // proxy.dev/example.com with no prior proxied page).
    if (!/^https?:\/\//i.test(targetUrl)) {
      targetUrl = 'https://' + targetUrl;
    }

    // Defensive cap against pathological input, before even trying to parse it.
    if (targetUrl.length > 8000) {
      return errorResponse(proxyOrigin, 414, 'That address is too long', "The target URL exceeds what this relay will attempt to proxy.", null, targetUrl.slice(0, 200) + '…');
    }

    let parsedTarget;
    try {
      parsedTarget = new URL(targetUrl);
    } catch {
      return errorResponse(proxyOrigin, 400, "That address didn't parse", "The target couldn't be read as a valid URL — check it for typos.", null, targetUrl);
    }
    if (!['http:', 'https:'].includes(parsedTarget.protocol)) {
      return errorResponse(proxyOrigin, 400, 'Unsupported protocol', 'This relay only forwards http:// and https:// addresses.', null, parsedTarget.href);
    }
    // Refuse a self-referential target — otherwise the Worker would fetch
    // its own origin, recursively, on a crafted or accidental link.
    if (parsedTarget.origin === proxyOrigin) {
      return errorResponse(proxyOrigin, 400, 'Refusing to proxy itself', "This address points back at the relay's own origin, which would cause it to fetch itself.", null, parsedTarget.href);
    }

    // Cloudflare analytics/speculation endpoints on the TARGET's domain (RUM
    // beacons, Speculation Rules) have no meaning through the relay and only
    // produce 404/405 noise. Acknowledge and drop them.
    if (parsedTarget.pathname === '/cdn-cgi/rum' || parsedTarget.pathname === '/cdn-cgi/speculation') {
      return new Response(null, { status: 204 });
    }

    // Edge cache: identical proxied requests skip origin + rewriting entirely.
    // GET-only — the Cache API throws on non-GET requests.
    // Cookie jar (see COOKIE_JAR): this visitor's cookies for the target, as an
    // ordinary Cookie header. A request carrying cookies is personalized, so
    // it bypasses every cache below.
    const jarOn = COOKIE_JAR;
    const jar = jarOn ? loadJar(request) : null;
    let jarCtx = null;
    let cookieHeader = '';
    if (jarOn) {
      let pageSite = '';
      try {
        const po = resolvePageContext(request, proxyOrigin).origin;
        if (po) pageSite = siteOf(new URL(po).hostname);
      } catch {
        // unknown page: treated as same-site
      }
      jarCtx = {
        pageSite,
        topNav: request.method === 'GET' &&
          request.headers.get('Sec-Fetch-Mode') === 'navigate' &&
          request.headers.get('Sec-Fetch-Dest') === 'document'
      };
      const crossSite = !!pageSite && siteOf(parsedTarget.hostname) !== pageSite;
      cookieHeader = jarCookieHeader(jar, parsedTarget, crossSite, jarCtx.topNav);
    }

    const cacheable = request.method === 'GET' && !cookieHeader;
    const cache = caches.default;
    // The cache key embeds a token derived from the request's Accept header:
    // the real browser's Accept is forwarded upstream, so the same URL can
    // legitimately have different bytes per browser (AVIF vs WebP vs PNG).
    // Keying on URL alone served the first visitor's format to everyone for
    // the full TTL. The token exists only in the cache key — the upstream
    // fetch still uses the untouched target URL.
    const acceptToken = request.headers.get('Accept') || 'no-accept';
    const cacheKey = new Request(
      request.url + (url.search ? '&' : '?') + '__relay_acc=' + encodeURIComponent(acceptToken),
      request
    );
    if (cacheable) {
      const cached = await cache.match(cacheKey);
      if (cached) return cached;
    }

    // Range requests and HLS/DASH manifests must not go through the blanket
    // edge cache: a cached live playlist is stale within seconds (live video
    // stalls), and caching a partial-content request is wrong.
    const noEdgeCache = request.headers.has('Range') || /\.(m3u8|mpd)$/i.test(parsedTarget.pathname);

    const upstreamInit = {
      method: request.method,
      headers: buildUpstreamHeaders(request, proxyOrigin, parsedTarget.origin),
      redirect: 'follow',
      // cacheEverything is only safe for anonymous responses, so it is off
      // for any request that carries jar cookies and — once the cookie jar is
      // on, since a first visit can set a cookie that a cached copy would
      // never replay to the next visitor — for everything except static
      // assets (script/style/image/font). With the jar off it applies as
      // before. It caches at Cloudflare's fetch layer (not just our own edge
      // cache below), which cuts a real origin round-trip on repeat hits.
      // cacheTtlByStatus, not cacheTtl: with cacheEverything, cacheTtl
      // applies to error statuses too, so a single transient 500/404 was
      // replayed from Cloudflare's cache to every visitor for the full
      // TTL. 1s on the error ranges is effectively "don't cache" without
      // relying on 0-TTL handling.
      cf: (noEdgeCache || cookieHeader || (jarOn && !/^(script|style|image|font)$/.test(request.headers.get('Sec-Fetch-Dest') || '')))
        ? undefined
        : { cacheEverything: true, cacheTtlByStatus: { '200-299': 120, '400-499': 1, '500-599': 1 } }
    };
    if (cookieHeader) upstreamInit.headers.set('Cookie', cookieHeader);

    // Forward the real request body for non-GET/HEAD methods — previously
    // every upstream fetch was an implicit GET regardless of the incoming
    // request, silently dropping POST bodies (breaks GraphQL calls, search
    // suggestions, and anything else proxied fetch/XHR calls send as POST).
    if (!['GET', 'HEAD'].includes(request.method) && request.body) {
      upstreamInit.body = request.body;
      upstreamInit.duplex = 'half';
    }

    const upstreamHref = stripProxyFromQuery(parsedTarget, proxyOrigin, resolvePageContext(request, proxyOrigin).origin);

    let upstream;
    try {
      if (jarOn) {
        // One hop only. A redirect is handed back to the browser (below), which
        // follows it by itself - exactly as it would against the real site:
        // method and body semantics, the address bar and one-shot content all
        // behave naturally - and each hop passes through the Worker again, so
        // cookies set on a redirect are stored before the next hop is made.
        upstream = await fetchUpstream(upstreamHref, Object.assign({}, upstreamInit, { redirect: 'manual' }));
        storeSetCookies(jar, new URL(upstreamHref), getSetCookies(upstream.headers));
      } else {
        upstream = await fetchUpstream(upstreamHref, upstreamInit);
      }
    } catch (error) {
      return errorResponse(proxyOrigin, 502, "Couldn't reach that address", 'The request to the target failed before any response came back.', error.message, parsedTarget.href);
    }

    // Cloudflare's own edge — not the target site — returns these statuses
    // for connectivity failures (DNS didn't resolve, origin unreachable,
    // etc). fetch() doesn't throw for these; it resolves as a normal-looking
    // HTML response, which would otherwise get rewritten and served as if
    // it were the real page. Show our own explanation instead.
    const CF_EDGE_ERROR_STATUSES = new Set([520, 521, 522, 523, 524, 525, 526, 527, 530]);
    if (CF_EDGE_ERROR_STATUSES.has(upstream.status)) {
      return errorResponse(proxyOrigin, 502, "Couldn't reach that address", "The target domain didn't respond — it may not exist, or is temporarily unreachable.", 'Double-check the address for typos.', parsedTarget.href);
    }

    // Cookie changes from this response, ready to hand to the browser.
    const jarSetCookies = jarOn ? jarSetCookieHeaders(jar) : [];

    // A redirect: rewrite Location to stay inside the relay and let the browser
    // follow it, with this hop's cookies attached.
    if (jarOn && [301, 302, 303, 307, 308].includes(upstream.status)) {
      const loc = upstream.headers.get('Location');
      let dest = '';
      if (loc) {
        try {
          const u = new URL(loc, upstreamHref);
          if (/^https?:$/.test(u.protocol)) dest = proxyOrigin + '/' + u.href;
        } catch {
          dest = '';
        }
      }
      if (dest) {
        const rh = new Headers({ Location: dest });
        const cc = upstream.headers.get('Cache-Control');
        if (cc) rh.set('Cache-Control', cc);
        withJarCookies(rh, jarSetCookies);
        return new Response(null, { status: upstream.status, headers: rh });
      }
    }

    const contentType = upstream.headers.get('content-type') || '';
    // XHTML is rewritable too — previously application/xhtml+xml streamed
    // through untouched (raw links, no injected script). Served as
    // text/html below, which real-world XHTML renders under fine; the one
    // known hazard is XHTML's legal self-closing external <script/>,
    // which HTML parsing treats as an unclosed <script> tag.
    const isHtml =
      contentType.includes('text/html') || contentType.includes('application/xhtml+xml');

    // Non-HTML: stream through untouched, but for static asset types (JS,
    // CSS, fonts, images) that browsers otherwise under-cache, extend
    // Cache-Control client-side AND store at the edge — a chunk fetched by
    // one visitor is then served instantly to the next, skipping the origin
    // and the Worker's rewriting path entirely.
    if (!isHtml) {
      // Search engines increasingly deliver actual result data via a
      // separate payload fetched by client-side JS (confirmed for
      // DuckDuckGo's links.duckduckgo.com/d.js) rather than embedding
      // results in the initial HTML at all — HTMLRewriter can never reach
      // this, since it only ever sees that initial response. Rewriting the
      // URLs in the response TEXT itself, here, means the data is already
      // correct by the time the page's own JS parses and uses it — no
      // fighting a framework's own re-rendering after the fact. Narrow and
      // explicit: a small, known list of search-engine data hosts, not a
      // general "rewrite URLs in any response" rule, which would risk
      // corrupting arbitrary application code that uses URL-like strings
      // for its own internal logic.
      if (SEARCH_DATA_HOSTS.has(parsedTarget.hostname)) {
        const text = await upstream.text();
        const rewritten = rewriteEmbeddedUrls(text, upstream.url || parsedTarget.href, proxyOrigin);
        const dataHeaders = new Headers(upstream.headers);
        withJarCookies(dataHeaders, jarSetCookies);
        return new Response(rewritten, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: dataHeaders
        });
      }

      if (upstream.status === 200 && isLongCacheable(contentType)) {
        const headers = new Headers(upstream.headers);
        headers.set('Cache-Control', 'public, max-age=86400');
        withJarCookies(headers, jarSetCookies);
        const asset = new Response(upstream.body, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers
        });
        // .clone() tees the stream, roughly doubling in-flight buffering —
        // fine for a typical script/image, wasteful and riskier for a large
        // game/WASM bundle (these commonly run 50-200MB+). Skip our OWN
        // edge-cache write above the threshold; the browser still benefits
        // from the Cache-Control header above either way.
        const lengthHeader = upstream.headers.get('content-length');
        const tooLargeToCache = lengthHeader && parseInt(lengthHeader, 10) > ASSET_CACHE_SIZE_LIMIT;
        if (cacheable && !tooLargeToCache && !jarSetCookies.length) ctx.waitUntil(cache.put(cacheKey, asset.clone()));
        return asset;
      }
      return jarSetCookies.length ? rebuildWithJarCookies(upstream, jarSetCookies) : stripSetCookie(upstream);
    }

    // If the target redirected (bbc.com -> www.bbc.com), send the browser to
    // the FINAL url so location.pathname matches the <base> we inject below.
    // Otherwise page JS that reads location.pathname and feeds it back into
    // history/URL APIs produces mismatched paths. Top-level/iframe
    // navigations only; subresource fetches follow redirects natively.
    if (request.method === 'GET' && request.headers.get('Sec-Fetch-Mode') === 'navigate' && upstream.url) {
      try {
        const finalUrl = new URL(upstream.url);
        const requestedUrl = new URL(upstreamHref);
        finalUrl.hash = '';
        requestedUrl.hash = '';
        if (finalUrl.href !== requestedUrl.href && finalUrl.origin !== proxyOrigin) {
          const rh = new Headers({ Location: proxyOrigin + '/' + finalUrl.href });
          withJarCookies(rh, jarSetCookies);
          return new Response(null, { status: 302, headers: rh });
        }
      } catch {
        // fall through and serve normally
      }
    }

    // upstream.url is the FINAL URL after any redirects fetch() followed
    // server-side — using the pre-redirect parsedTarget.href here would
    // resolve every relative link/script/etc against the wrong page
    // whenever the target redirects (auth flows, trailing-slash/canonical
    // redirects, moved domains).
    const baseUrl = upstream.url || parsedTarget.href;
    const proxiedBase = proxyOrigin + '/' + baseUrl;

    // Real-path mode: hand the injected script the real path to show.
    let spoofPath = '';
    try {
      const finalForPath = new URL(baseUrl);
      if (REAL_PATH_HOSTS.test(finalForPath.hostname)) spoofPath = finalForPath.pathname + finalForPath.search;
    } catch {
      // leave empty
    }

    const rewriter = new HTMLRewriter()
      .on('meta[name]', new MetaReferrerRewriter())
      .on('meta[http-equiv]', new MetaReferrerRewriter())
      .on('a[href]', new AttrRewriter('href', baseUrl, proxyOrigin))
      .on('img[src]', new AttrRewriter('src', baseUrl, proxyOrigin))
      .on('script[src]', new AttrRewriter('src', baseUrl, proxyOrigin))
      .on('link[href]', new AttrRewriter('href', baseUrl, proxyOrigin))
      .on('iframe[src]', new AttrRewriter('src', baseUrl, proxyOrigin))
      .on('video[src]', new AttrRewriter('src', baseUrl, proxyOrigin))
      .on('video[poster]', new AttrRewriter('poster', baseUrl, proxyOrigin))
      .on('audio[src]', new AttrRewriter('src', baseUrl, proxyOrigin))
      .on('source[src]', new AttrRewriter('src', baseUrl, proxyOrigin))
      .on('embed[src]', new AttrRewriter('src', baseUrl, proxyOrigin))
      .on('object[data]', new AttrRewriter('data', baseUrl, proxyOrigin))
      .on('form', new FormRewriter(baseUrl, proxyOrigin))
      .on('button[formaction]', new AttrRewriter('formaction', baseUrl, proxyOrigin))
      .on('input[formaction]', new AttrRewriter('formaction', baseUrl, proxyOrigin))
      .on('img[srcset]', new SrcsetRewriter(baseUrl, proxyOrigin))
      .on('source[srcset]', new SrcsetRewriter(baseUrl, proxyOrigin))
      .on('meta[http-equiv]', new MetaRefreshRewriter(baseUrl, proxyOrigin))
      .on('head', new BaseTagInjector(proxiedBase))
      .on('head', new ScriptInjector(proxyOrigin, spoofPath, COOKIE_JAR));

    const transformed = rewriter.transform(upstream);

    const htmlHeaders = new Headers({
      'Content-Type': 'text/html; charset=utf-8',
      // A page built with the visitor's cookies must not be stored by shared caches.
      'Cache-Control': (cookieHeader || jarSetCookies.length) ? 'private, no-cache' : 'public, max-age=60'
    });
    withJarCookies(htmlHeaders, jarSetCookies);
    const response = new Response(transformed.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: htmlHeaders
    });

    // With the jar on, HTML is never edge-cached: a login page carries a CSRF
    // token, and a cached copy would hand one visitor's token to the next.
    if (cacheable && !jarOn) ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  }
};

function proxify(absoluteUrl, proxyOrigin) {
  return proxyOrigin + '/' + absoluteUrl;
}

// Page JS sometimes puts its own location.href into a query parameter
// (consent managers do: href=<relay>/https://www.bbc.com/news). The upstream
// server validates that against its registered domains and rejects the
// relay-wrapped form (400), so unwrap it back to the real URL before
// forwarding. Query string only; everything else is untouched.
function stripProxyFromQuery(parsed, proxyOrigin, pageOrigin) {
  if (!parsed.search) return parsed.href;
  const esc = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lowerHex = (v) => v.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
  const encWrapped = encodeURIComponent(proxyOrigin + '/');
  const encOrigin = encodeURIComponent(proxyOrigin);
  let search = parsed.search;
  // 1. A relay wrapper in front of an embedded real URL: drop the wrapper.
  for (const w of [encWrapped, lowerHex(encWrapped), proxyOrigin + '/']) {
    search = search.replace(new RegExp(esc(w) + '(?=https?(?::|%3[Aa]))', 'g'), '');
  }
  // 2. Any relay origin left over means the page's URL was a bare real path
  //    (real-path mode): swap it for the page's real origin.
  if (pageOrigin) {
    search = search.split(encOrigin).join(encodeURIComponent(pageOrigin));
    search = search.split(lowerHex(encOrigin)).join(encodeURIComponent(pageOrigin));
    search = search.split(proxyOrigin).join(pageOrigin);
  }
  if (search === parsed.search) return parsed.href;
  const u = new URL(parsed.href);
  u.search = search;
  return u.href;
}

// Headers we set ourselves, that leak the proxy's own domain if forwarded
// verbatim, or that are hop-by-hop/infra-only and meaningless upstream.
// Everything else the page/browser actually sent is forwarded as-is — an
// allowlist here would always be one custom header behind real-world sites
// (anti-abuse tokens, API versioning headers, CSRF tokens, etc); a denylist
// is far more robust. Cookies specifically are never forwarded (see README
// limitations).
const DROP_HEADERS = new Set([
  'host', 'cookie', 'content-length', 'connection',
  'user-agent',
  'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor', 'cf-worker',
  'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host',
  'referer', 'origin' // handled specially below, not silently forwarded raw
]);

// Recovers the real target URL embedded in a proxy-origin header value
// (e.g. a Referer/Origin the browser set to our own domain), or null if the
// value isn't one of ours.
function recoverRealUrl(headerValue, proxyOrigin) {
  if (!headerValue) return null;
  try {
    const u = new URL(headerValue);
    if (u.origin !== proxyOrigin) return null;
    const embedded = u.pathname.slice(1);
    return /^https?:\/\//i.test(embedded) ? embedded : null;
  } catch {
    return null;
  }
}

function buildUpstreamHeaders(request, proxyOrigin, targetOrigin) {
  const headers = new Headers();
  // Forward the REAL browser's own User-Agent rather than a fixed spoofed
  // string. This request's Sec-Ch-Ua/Sec-Fetch-* headers (forwarded below,
  // since they're not in DROP_HEADERS) already reflect the real browser —
  // a substituted User-Agent that doesn't match them is an internal
  // inconsistency that bot-detection systems specifically look for. Only
  // fall back to a generic default if the client somehow sent none at all.
  const realUA = request.headers.get('User-Agent');
  headers.set('User-Agent', realUA || FALLBACK_USER_AGENT);
  // Accept-Encoding is NOT set here — the real browser's own value is
  // forwarded via the denylist loop below, for the same reason as
  // User-Agent above: a substituted value that doesn't match what a real
  // browser of that claimed identity would actually send is a detectable
  // inconsistency.

  for (const [name, value] of request.headers) {
    if (DROP_HEADERS.has(name.toLowerCase())) continue;
    headers.set(name, value);
  }

  // Referer carries a full path, so the real target can be recovered from
  // its content. Origin never carries a path (just scheme+host) — there's
  // nothing to recover from it, so when the browser sent one at all, set it
  // to the request's own known real target origin instead.
  // The page's real URL/origin (embedded Referer, or cookie for real-path
  // pages). A browser sends the PAGE's origin on cross-origin requests, which
  // media CDNs and CORS allow-lists check; fall back to the target's own
  // origin only when the page can't be determined.
  const pageCtx = resolvePageContext(request, proxyOrigin);
  if (pageCtx.referer) headers.set('Referer', pageCtx.referer);

  if (request.headers.get('Origin')) {
    headers.set('Origin', pageCtx.origin || targetOrigin);
  }

  return headers;
}

// Above this, skip our own edge-cache write for a static asset (still gets
// browser-side Cache-Control either way) — see the asset-caching branch.
const ASSET_CACHE_SIZE_LIMIT = 20 * 1024 * 1024; // 20MB

// Only used on the rare request that arrives with no User-Agent at all (the
// normal path forwards the real browser's own UA — see buildUpstreamHeaders
// and handleWebSocketUpgrade). Must be a complete, correctly-formed string:
// the previous fallback was truncated to just "AppleWebKit/537.36" with no
// "(KHTML, like Gecko) Chrome/... Safari/..." suffix — no real browser has
// ever sent that fragment alone, and it's exactly the kind of malformed
// signature basic bot-detection checks for.
const FALLBACK_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Parses Retry-After as either delta-seconds or an HTTP-date, per spec.
// Returns null when absent or unparseable.
function parseRetryAfterMs(header) {
  if (!header) return null;
  const asInt = parseInt(header, 10);
  if (!Number.isNaN(asInt) && String(asInt) === header.trim()) return asInt * 1000;
  const asDate = Date.parse(header);
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
  return null;
}

// Fails fast on a hung/stalled upstream rather than letting the request run
// indefinitely — bounded so a single slow connection can't quietly eat the
// Worker's whole execution budget. Only wraps the request itself; once a
// WebSocket handshake completes, the resulting socket lives independently
// of this signal and is unaffected by it.
async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 20000);
  try {
    return await fetch(url, Object.assign({}, init, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}

// One retry on transient network failure (DNS blip, connection reset) —
// not on HTTP error statuses, which are legitimate responses returned as-is
// either way. Only retried when there's no body: a ReadableStream can only
// be read once, so a request that already carries one gets a single try.
//
// Also adds a short, capped retry specifically for throttling responses
// (429/503) that include a short Retry-After — relevant for game traffic
// especially, since many concurrent relay users hitting the same game
// server can all appear to originate from Cloudflare's own IP ranges,
// making a real rate limit more likely to be hit than for ordinary
// browsing. Capped at 2s and one attempt so a single request can never
// stall for long chasing a throttle that isn't going to clear soon.
async function fetchUpstream(url, init, timeoutMs) {
  let response;
  try {
    response = await fetchWithTimeout(url, init, timeoutMs);
  } catch (err) {
    if (init.body) throw err;
    response = await fetchWithTimeout(url, init, timeoutMs);
  }

  if ((response.status === 429 || response.status === 503) && !init.body) {
    const waitMs = parseRetryAfterMs(response.headers.get('Retry-After'));
    if (waitMs !== null && waitMs <= 2000) {
      await sleep(waitMs);
      try {
        response = await fetchWithTimeout(url, init, timeoutMs);
      } catch {
        // keep the original throttled response if the retry itself fails
      }
    }
  }

  return response;
}

// Content-types safe to cache aggressively client-side: static, commonly
// content-hashed, and re-requested often by proxied SPAs. Deliberately
// excludes video/audio (range-request/seeking behavior) and anything
// JSON/API-shaped (freshness matters).
const STATIC_CACHE_TYPES = ['text/css', 'javascript', 'image/', 'font/'];
function isLongCacheable(contentType) {
  return STATIC_CACHE_TYPES.some((t) => contentType.includes(t));
}

// Target-issued Set-Cookie headers land on the proxy's OWN origin when
// passed through to the browser — where any other proxied page can read
// them via document.cookie, since everything shares this origin. And since
// cookies are never forwarded upstream, they're never used for anything
// either. Strip on every non-HTML path (the HTML path already rebuilds its
// headers from scratch). Only re-wraps when a Set-Cookie is actually
// present, so the streaming passthrough is untouched otherwise.
function stripSetCookie(response) {
  if (!response.headers.has('Set-Cookie')) return response;
  try {
    const headers = new Headers(response.headers);
    headers.delete('Set-Cookie');
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  } catch {
    return response; // fall back to today's behavior rather than fail the request
  }
}

// Known search-engine data endpoints — the actual result payload, not the
// page shell. Confirmed for DuckDuckGo by inspecting its response directly;
// add others here once their equivalent endpoint is identified the same way
// (this list is deliberately small and explicit, not a guess).
const SEARCH_DATA_HOSTS = new Set(['links.duckduckgo.com']);

// Image hosts that appear inside search-data payloads. These must NOT be
// pre-wrapped by rewriteEmbeddedUrls: the client-side attribute hooks proxy
// them when the page sets them on an element, and DDG's own page JS wraps
// the raw thumbnail URL into its external-content.duckduckgo.com/iuv/?u=
// image proxy — which can't fetch a relay-wrapped inner URL.
const REWRITE_SKIP_HOSTS = /(^|\.)mm\.bing\.net$|^external-content\.duckduckgo\.com$/i;

// Rewrites embedded absolute URLs in a search-data response's raw text,
// before the page's own JS ever parses it. Handles both plain
// (https://example.com) and JSON-escaped (https:\/\/example.com) forms,
// since these payloads are commonly JSONP-wrapped JSON — re-escaping the
// result the same way the match was found, so the surrounding JSON's own
// escaping convention stays consistent for whatever later parses it.
function rewriteEmbeddedUrls(text, baseUrl, proxyOrigin) {
  return text.replace(/https?:(?:\\\/|[^\s"'\\])+/g, (match) => {
    try {
      const wasEscaped = match.indexOf('\\/') !== -1;
      const unescaped = match.replace(/\\\//g, '/');
      const abs = new URL(unescaped, baseUrl).href;
      if (REWRITE_SKIP_HOSTS.test(new URL(abs).hostname)) return match;
      const proxied = proxyOrigin + '/' + abs;
      return wasEscaped ? proxied.replace(/\//g, '\\/') : proxied;
    } catch {
      return match;
    }
  });
}

// Major search engines wrap result links in a server-side click-tracking
// redirect that serves an interstitial page whose own JS then navigates
// onward — commonly via a direct, unpatchable location assignment straight
// to the real external destination, which escapes the proxy entirely
// (window.location can't be intercepted from page JS, and the resulting
// request never reaches this Worker to be recovered server-side).
// Decoding the real destination here and linking straight to it skips the
// interstitial, and its escape, altogether. Falls through to the tracking
// URL unchanged if no known pattern matches — never breaks a link.
function decodeTrackingRedirect(rawValue, baseUrl) {
  let u;
  try {
    u = new URL(rawValue, baseUrl);
  } catch {
    return null;
  }

  // Bing: /ck/a?...&u=a1<base64url, unpadded>...
  if (/\/ck\/a$/i.test(u.pathname)) {
    const encoded = u.searchParams.get('u');
    if (encoded && encoded.slice(0, 2) === 'a1') {
      try {
        let b64 = encoded.slice(2).replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4 !== 0) b64 += '=';
        const decoded = atob(b64);
        if (/^https?:\/\//i.test(decoded)) return decoded;
      } catch {
        // fall through
      }
    }
    return null;
  }

  // Google: /url?q=<url-encoded destination>
  if (/^\/url$/i.test(u.pathname) && /(^|\.)google\.[a-z.]+$/i.test(u.hostname)) {
    const q = u.searchParams.get('q');
    if (q && /^https?:\/\//i.test(q)) return q;
    return null;
  }

  // DuckDuckGo: /l/?uddg=<url-encoded destination>
  if (/^\/l\/?$/i.test(u.pathname) && /(^|\.)duckduckgo\.com$/i.test(u.hostname)) {
    const uddg = u.searchParams.get('uddg');
    if (uddg && /^https?:\/\//i.test(uddg)) return uddg;
    return null;
  }

  return null;
}

function resolveAndProxy(value, baseUrl, proxyOrigin) {
  if (value === null || value === undefined) return null;
  // An empty src/href must not resolve to the page itself (<img src=""> would
  // otherwise request the page's own HTML as an image).
  if (!value.trim()) return null;
  if (/^(javascript|data|mailto|tel|#)/i.test(value)) return null;
  try {
    const target = decodeTrackingRedirect(value, baseUrl) || value;
    const abs = new URL(target, baseUrl).href;
    return proxify(abs, proxyOrigin);
  } catch {
    return null;
  }
}

class AttrRewriter {
  constructor(attr, baseUrl, proxyOrigin) {
    this.attr = attr;
    this.baseUrl = baseUrl;
    this.proxyOrigin = proxyOrigin;
  }
  element(el) {
    const val = el.getAttribute(this.attr);
    const newVal = resolveAndProxy(val, this.baseUrl, this.proxyOrigin);
    if (newVal) el.setAttribute(this.attr, newVal);
  }
}

// GET forms strip any existing query string from `action` on submit, so a
// proxied action gets clobbered by the form's own fields. Instead, stash the
// resolved real target URL and let injected JS build the request.
class FormRewriter {
  constructor(baseUrl, proxyOrigin) {
    this.baseUrl = baseUrl;
    this.proxyOrigin = proxyOrigin;
  }
  element(el) {
    const actionVal = el.getAttribute('action') || '';
    let abs;
    try {
      abs = new URL(actionVal, this.baseUrl).href;
    } catch {
      abs = this.baseUrl;
    }
    el.setAttribute('data-proxy-target', abs);
    // A POST form (a login, above all) must submit THROUGH the relay: left
    // alone, a relative action lands on the bare relay origin and an absolute
    // one goes straight to the real site, skipping the relay and its cookies.
    // (An empty action posts to the page's own URL, which is already ours.)
    const method = (el.getAttribute('method') || 'get').toLowerCase();
    const trimmed = actionVal.trim();
    if (method !== 'get' && method !== 'dialog' && trimmed && !/^(javascript|data|mailto|tel|#)/i.test(trimmed)) {
      try {
        el.setAttribute('action', proxify(abs, this.proxyOrigin));
      } catch {
        // leave the action alone
      }
    }
  }
}

class SrcsetRewriter {
  constructor(baseUrl, proxyOrigin) {
    this.baseUrl = baseUrl;
    this.proxyOrigin = proxyOrigin;
  }
  element(el) {
    const val = el.getAttribute('srcset');
    if (!val) return;
    const rewritten = val
      .split(',')
      .map((part) => {
        const trimmed = part.trim();
        const spaceIdx = trimmed.search(/\s/);
        const u = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
        const descriptor = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx).trim();
        const proxied = resolveAndProxy(u, this.baseUrl, this.proxyOrigin);
        if (!proxied) return trimmed;
        return descriptor ? `${proxied} ${descriptor}` : proxied;
      })
      .join(', ');
    el.setAttribute('srcset', rewritten);
  }
}

// <meta http-equiv="refresh" content="N;url=..."> is a real HTML redirect
// mechanism, distinct from an HTTP 3xx response and untouched by any other
// rewriter — a page using it to redirect would otherwise send the browser
// straight to the real, un-proxied destination.
class MetaRefreshRewriter {
  constructor(baseUrl, proxyOrigin) {
    this.baseUrl = baseUrl;
    this.proxyOrigin = proxyOrigin;
  }
  element(el) {
    const httpEquiv = el.getAttribute('http-equiv');
    if (!httpEquiv || httpEquiv.toLowerCase() !== 'refresh') return;
    const content = el.getAttribute('content');
    if (!content) return;
    const match = content.match(/^(\s*[\d.]*\s*;\s*url\s*=\s*)(.+)$/i);
    if (!match) return;
    const [, prefix, rawUrl] = match;
    const cleanUrl = rawUrl.trim().replace(/^['"]|['"]$/g, '');
    const proxied = resolveAndProxy(cleanUrl, this.baseUrl, this.proxyOrigin);
    if (proxied) el.setAttribute('content', prefix + proxied);
  }
}

// A restrictive referrer policy (DuckDuckGo ships <meta name="referrer"
// content="origin">, sending only the bare origin on subsequent requests,
// not the path) silently breaks the server-side recovery in fetch() that
// depends on the FULL Referer path to reconstruct a lost embedded target —
// exactly what caused DDG's own tab navigation (All -> Images/Videos/News)
// to drop the embedded duckduckgo.com. Forcing "unsafe-url" here isn't a
// new privacy exposure specific to this proxy: every request already goes
// through this Worker regardless, and it's same-origin (browser-to-proxy)
// either way, which the DEFAULT policy already sends in full — this just
// stops the target site's own override from breaking that.
class MetaReferrerRewriter {
  element(el) {
    const name = (el.getAttribute('name') || '').toLowerCase();
    const httpEquiv = (el.getAttribute('http-equiv') || '').toLowerCase();
    if (name === 'referrer' || httpEquiv === 'referrer-policy') {
      el.setAttribute('content', 'unsafe-url');
    }
  }
}

// Makes directory-relative references from JS-created/dynamic content (never
// seen by HTMLRewriter, since it only runs on the initial HTML response)
// resolve against the *proxied* current page instead of escaping to the
// proxy's own root.
class BaseTagInjector {
  constructor(proxiedBase) {
    this.proxiedBase = proxiedBase;
  }
  element(el) {
    // proxiedBase is target-controlled (it's upstream.url — the final
    // redirect destination). URL normalization percent-encodes quotes, so
    // breakout *shouldn't* be reachable — but don't rely on that implicitly:
    // escape before interpolating into markup.
    el.prepend(`<base href="${escapeHtml(this.proxiedBase)}">`, { html: true });
  }
}

class ScriptInjector {
  constructor(proxyOrigin, realPath, cookieJar) {
    this.proxyOrigin = proxyOrigin;
    this.realPath = realPath || '';
    this.cookieJar = !!cookieJar;
  }
  element(el) {
    el.prepend(
      `
    <script>
    (function() {
      var proxyOrigin = '${this.proxyOrigin}';
      // Real-path mode (see REAL_PATH_HOSTS on the server). Empty = normal mode.
      var relaySpoofPath = ${JSON.stringify(this.realPath || '').replace(/</g, '\\u003c')};
      var relaySpoofReal = '';
      // Cookie jar (see COOKIE_JAR on the server): document.cookie is replaced
      // by a shim over the jar cookies. Everything in this script that needs
      // the page's REAL cookie string (the relay's own debug and context
      // cookies) goes through these two native accessors.
      var relayJarOn = ${this.cookieJar ? 'true' : 'false'};
      var relayCookieDesc = null;
      try { relayCookieDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie'); } catch (e) {}
      function relayRawCookie() {
        try { return relayCookieDesc && relayCookieDesc.get ? relayCookieDesc.get.call(document) : document.cookie; } catch (e) { return ''; }
      }
      function relayRawCookieSet(v) {
        try { if (relayCookieDesc && relayCookieDesc.set) relayCookieDesc.set.call(document, v); else document.cookie = v; } catch (e) {}
      }

      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('${SW_PATH}').catch(function() {});

        // Block the TARGET site's own Service Worker registration attempts.
        // A foreign site's SW can't function correctly under our proxied
        // URL scheme (its internal relative references assume the real
        // site's own paths), and if it takes over fetch handling on this
        // origin, its requests start failing — which is exactly the
        // trigger many sites use to show a "you're offline" fallback UI.
        navigator.serviceWorker.register = function() {
          return Promise.reject(new Error('Service Worker registration disabled by relay'));
        };
      }

      // Some sites gate an offline UI directly off navigator.onLine rather
      // than (or in addition to) a failed request — force it true so a
      // real network failure elsewhere doesn't get misread as "offline"
      // when the actual browser connection is fine.
      try {
        Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
      } catch (e) {}

      // document.baseURI is "<proxyOrigin>/<realAbsoluteUrl>" (see
      // BaseTagInjector). Strip the proxy prefix to recover the real
      // target's current URL, so we can resolve references (including
      // root-relative ones the browser can't handle via <base> alone)
      // against the REAL site, then wrap the result ourselves.
      function realBase() {
        var prefix = proxyOrigin + '/';
        if (document.baseURI.indexOf(prefix) === 0) {
          var baseRest = document.baseURI.slice(prefix.length);
          // Real-path mode, before our <base> is parsed: the document URL is a
          // bare real path, so fall back to the real URL captured at startup.
          if (relaySpoofReal && !/^https?:\\/\\//i.test(baseRest)) return relaySpoofReal;
          return baseRest;
        }
        return document.baseURI;
      }

      if (relaySpoofPath) {
        try {
          // Capture the real URL BEFORE changing the address bar.
          relaySpoofReal = realBase();
          history.replaceState(history.state, '', relaySpoofPath + location.hash);
          relayRawCookieSet('__relay_ctx=' + encodeURIComponent(new URL(relaySpoofReal).origin) +
            '; path=/; max-age=86400; samesite=lax; secure');
        } catch (e) {
          relaySpoofPath = '';
        }
      }

      // --- Cookie jar: document.cookie shim --------------------------------
      // The Worker keeps each site's cookies as one relay cookie per upstream
      // cookie (see COOKIE_JAR). A page's own JavaScript still expects
      // document.cookie to hold ITS cookies, so reads return the script-visible
      // ones for this page's real host and writes update that cookie. HttpOnly
      // cookies live under a different name prefix this script never reads. The
      // name scheme, record format and base64url codec must match the Worker's
      // exactly.
      function relayB64Enc(str) {
        return btoa(unescape(encodeURIComponent(str))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
      }
      function relayB64Dec(b) {
        var t = String(b).replace(/-/g, '+').replace(/_/g, '/');
        while (t.length % 4) t += '=';
        return decodeURIComponent(escape(atob(t)));
      }
      function relayPathMatch(reqPath, cp) {
        if (reqPath === cp) return true;
        if (reqPath.indexOf(cp) !== 0) return false;
        return cp.charAt(cp.length - 1) === '/' || reqPath.charAt(cp.length) === '/';
      }
      function relayJarName(key, path, name) {
        return '__rj_s.' + relayB64Enc(key) + '.' + relayB64Enc(path) + '.' + relayB64Enc(name);
      }
      function relayJarRecords() {
        var out = [];
        var parts = relayRawCookie().split(';');
        for (var i = 0; i < parts.length; i++) {
          var c = parts[i].trim();
          var eq = c.indexOf('=');
          if (eq <= 0 || c.indexOf('__rj_s.') !== 0) continue;
          var seg = c.slice(0, eq).split('.');
          if (seg.length !== 4) continue;
          try {
            var v = JSON.parse(relayB64Dec(c.slice(eq + 1)));
            out.push({ key: relayB64Dec(seg[1]), path: relayB64Dec(seg[2]), name: relayB64Dec(seg[3]),
              value: String(v[0]), exp: v[1] || 0, secure: v[2], hostOnly: v[3] });
          } catch (e) {}
        }
        return out;
      }
      function relayJarWrite(key, path, name, rec) {
        var cname = relayJarName(key, path, name);
        var secure = location.protocol === 'https:' ? '; Secure' : '';
        if (!rec) {
          relayRawCookieSet(cname + '=; Path=/; Max-Age=0' + secure);
          return;
        }
        var value = relayB64Enc(JSON.stringify([rec.value, rec.exp, rec.secure, rec.hostOnly, rec.sameSite]));
        if (cname.length + value.length + 3 > 3800) return;
        relayRawCookieSet(cname + '=' + value + '; Path=/; SameSite=Lax' + secure +
          (rec.exp ? '; Max-Age=' + Math.max(1, Math.floor((rec.exp - Date.now()) / 1000)) : ''));
      }
      function relayCookieGet() {
        var u = new URL(realBase());
        var host = u.hostname.toLowerCase();
        var path = u.pathname || '/';
        var https = u.protocol === 'https:';
        var now = Date.now();
        var recs = relayJarRecords();
        var picked = [];
        for (var i = 0; i < recs.length; i++) {
          var r = recs[i];
          if (!(host === r.key || host.slice(-(r.key.length + 1)) === '.' + r.key)) continue;
          if (r.key !== host && r.key.indexOf('.') < 0) continue;
          if (r.exp && r.exp <= now) continue;
          if (r.hostOnly && host !== r.key) continue;
          if (r.secure && !https) continue;
          if (!relayPathMatch(path, r.path)) continue;
          picked.push(r);
        }
        picked.sort(function(a, b) { return b.path.length - a.path.length; });
        return picked.map(function(r) { return r.name + '=' + r.value; }).join('; ');
      }
      function relayCookieSet(str) {
        var parts = String(str).split(';');
        var first = parts.shift() || '';
        var eq = first.indexOf('=');
        if (eq <= 0) return;
        var name = first.slice(0, eq).trim();
        var value = first.slice(eq + 1).trim();
        if (!name) return;
        var u = new URL(realBase());
        var host = u.hostname.toLowerCase();
        var domain = '', path = '', maxAge = null, expires = null, secure = false, sameSite = 1;
        for (var i = 0; i < parts.length; i++) {
          var p = parts[i];
          var j = p.indexOf('=');
          var k = (j < 0 ? p : p.slice(0, j)).trim().toLowerCase();
          var v = j < 0 ? '' : p.slice(j + 1).trim();
          if (k === 'domain') domain = v;
          else if (k === 'path') path = v;
          else if (k === 'max-age') { var n = parseInt(v, 10); if (!isNaN(n)) maxAge = n; }
          else if (k === 'expires') expires = v;
          else if (k === 'secure') secure = true;
          else if (k === 'samesite') { var sv = v.toLowerCase(); sameSite = sv === 'none' ? 0 : sv === 'strict' ? 2 : 1; }
        }
        var key = host, hostOnly = 1;
        if (domain) {
          var d = domain.replace(/^\\./, '').toLowerCase();
          if (!(host === d || host.slice(-(d.length + 1)) === '.' + d)) return;
          if (d !== host && d.indexOf('.') < 0) return;
          key = d;
          hostOnly = 0;
        }
        if (!path || path.charAt(0) !== '/') {
          var pp = u.pathname || '/';
          var idx = pp.lastIndexOf('/');
          path = idx <= 0 ? '/' : pp.slice(0, idx);
        }
        if (secure && u.protocol !== 'https:') return;
        var now = Date.now();
        var del = false, exp = 0;
        if (maxAge !== null) {
          if (maxAge <= 0) del = true; else exp = now + Math.min(maxAge * 1000, 400 * 24 * 3600 * 1000);
        } else if (expires) {
          var t = Date.parse(expires);
          if (!isNaN(t)) { if (t <= now) del = true; else exp = Math.min(t, now + 400 * 24 * 3600 * 1000); }
        }
        relayJarWrite(key, path, name, del ? null : { value: value, exp: exp, secure: secure ? 1 : 0, hostOnly: hostOnly, sameSite: sameSite });
      }
      if (relayJarOn && relayCookieDesc && relayCookieDesc.get && relayCookieDesc.set) {
        try {
          Object.defineProperty(Document.prototype, 'cookie', {
            get: function() { try { return relayCookieGet(); } catch (e) { return ''; } },
            set: function(v) { try { relayCookieSet(v); } catch (e) {} },
            configurable: true,
            enumerable: relayCookieDesc.enumerable
          });
        } catch (e) {}
      }

      // Mirrors decodeTrackingRedirect on the server side (same three
      // schemes). Needed here too because HTMLRewriter only ever sees the
      // initial server-rendered HTML — a search result link inserted into
      // the page by the site's OWN JavaScript (very likely, given how
      // JS-heavy modern search results rendering is) never passes through
      // server-side rewriting at all, only through this client-side path.
      // NOTE: every regex here is double-escaped (\\\\/ etc.) because this
      // whole script lives inside a template literal — one level of
      // backslashes is consumed when the template evaluates.
      function decodeTrackingRedirectClient(rawValue, baseUrl) {
        var u;
        try {
          u = new URL(rawValue, baseUrl);
        } catch (e) {
          return null;
        }
        if (/\\/ck\\/a$/i.test(u.pathname)) {
          var encoded = u.searchParams.get('u');
          if (encoded && encoded.slice(0, 2) === 'a1') {
            try {
              var b64 = encoded.slice(2).replace(/-/g, '+').replace(/_/g, '/');
              while (b64.length % 4 !== 0) b64 += '=';
              var decoded = atob(b64);
              if (/^https?:\\/\\//i.test(decoded)) return decoded;
            } catch (e) {}
          }
          return null;
        }
        if (/^\\/url$/i.test(u.pathname) && /(^|\\.)google\\.[a-z.]+$/i.test(u.hostname)) {
          var q = u.searchParams.get('q');
          if (q && /^https?:\\/\\//i.test(q)) return q;
          return null;
        }
        if (/^\\/l\\/?$/i.test(u.pathname) && /(^|\\.)duckduckgo\\.com$/i.test(u.hostname)) {
          var uddg = u.searchParams.get('uddg');
          if (uddg && /^https?:\\/\\//i.test(uddg)) return uddg;
          return null;
        }
        return null;
      }

      // Repairs a "scheme:/host" prefix that some client code (Next.js's
      // router) produces by collapsing the double slash: https:/host -> https://host
      function fixSlashes(s) {
        return s.replace(/^(https?:)\\/(?!\\/)/i, '$1//');
      }

      function toProxied(raw) {
        try {
          if (typeof raw !== 'string' || !raw) return raw;
          if (/^(data|blob|javascript):/i.test(raw)) return raw;
          // A root-relative path that is ALREADY a proxy path: page JS read
          // location.pathname (which is "/https://real.site/page" under this
          // scheme) and fed it back into history/URL APIs. Never re-resolve
          // it against the real site, or the target gets embedded twice.
          // The second form is the same path after a framework collapsed "//".
          if (/^\\/https?:\\/\\//i.test(raw)) return proxyOrigin + raw;
          if (/^\\/https?:\\/(?!\\/)/i.test(raw)) return proxyOrigin + '/' + fixSlashes(raw.slice(1));
          // Already a fully-proxied absolute URL (server-rewritten) — but
          // that doesn't mean there's nothing left to fix. The wrapped
          // target itself could still be an undecoded tracking-redirect
          // URL, so check it the same way an unwrapped one would be.
          var proxiedPrefix = proxyOrigin + '/http';
          if (raw.indexOf(proxiedPrefix) === 0) {
            var wrapped = fixSlashes(raw.slice(proxyOrigin.length + 1));
            var decodedWrapped = decodeTrackingRedirectClient(wrapped, realBase());
            return proxyOrigin + '/' + (decodedWrapped || wrapped);
          }
          // Some components pre-resolve a root-relative src/url against
          // document.baseURI (our proxied <base>) before calling fetch —
          // that drops the real target, landing on the bare proxy origin
          // (e.g. GitHub's lazy-loaded sort/filter/"..." menus). Recover
          // the leftover path+query and re-resolve it against the real site
          // instead of wrapping the already-broken URL a second time.
          if (raw.indexOf(proxyOrigin) === 0) {
            var rest = raw.slice(proxyOrigin.length);
            var recovered = new URL(rest, realBase()).href;
            return proxyOrigin + '/' + recovered;
          }
          var decodedTarget = decodeTrackingRedirectClient(raw, realBase());
          var abs = new URL(decodedTarget || raw, realBase()).href;
          return proxyOrigin + '/' + abs;
        } catch (e) {
          return raw;
        }
      }

      // --- Attribute / property interception ----------------------------
      // This is the piece that makes rewriting actually stick on JS-rendered
      // content, and it works on a different principle from the
      // MutationObserver further below.
      //
      // The observer is REACTIVE: React writes a raw href, the observer sees
      // it afterward and rewrites it. Two problems follow. There's a window
      // where the raw URL is genuinely live in the DOM (exactly what the
      // hover preview reads). And React keeps its own record of what it
      // wrote — on its next render it compares that against the DOM, sees
      // our value as a mismatch, and reverts it. We rewrite again. That loop
      // is not winnable by racing it faster.
      //
      // Hooking the setter/setAttribute instead is PREEMPTIVE: the value is
      // converted at the moment of assignment, so the raw URL never lands in
      // the DOM at all — no window to observe, nothing to revert.
      //
      // The getter is the other half, and it's what actually breaks the
      // revert loop: reads return the ORIGINAL unproxied URL. React reads
      // back exactly what it believes it wrote, sees no mismatch, and leaves
      // it alone. Site logic that compares or parses its own URLs also keeps
      // working, which a one-way rewrite would quietly break.
      var relayNativeGetAttr = Element.prototype.getAttribute;
      var relayNativeSetAttr = Element.prototype.setAttribute;

      // Inverse of toProxied: unwrap "<proxyOrigin>/<realUrl>" back to the
      // real URL. Used only by the getters below.
      function fromProxied(url) {
        if (typeof url !== 'string' || !url) return url;
        var prefix = proxyOrigin + '/';
        if (url.indexOf(prefix) === 0) {
          var rest = url.slice(prefix.length);
          if (/^https?:\\/\\//i.test(rest)) return rest;
        }
        return url;
      }

      var RELAY_URL_ATTR_NAMES = { href: 1, src: 1, action: 1, formaction: 1, data: 1, poster: 1 };

      try {
        Element.prototype.setAttribute = function(name, value) {
          try {
            if (RELAY_URL_ATTR_NAMES[name] && typeof value === 'string') {
              value = toProxied(value);
            }
          } catch (e) {}
          return relayNativeSetAttr.call(this, name, value);
        };
        Element.prototype.getAttribute = function(name) {
          var v = relayNativeGetAttr.call(this, name);
          try {
            if (RELAY_URL_ATTR_NAMES[name]) return fromProxied(v);
          } catch (e) {}
          return v;
        };
      } catch (e) {}

      // In real-path mode the address bar has lost the host, so keep the
      // relay button visible from the start (it normally appears only after
      // the first failure) so the real URL / a working link is one tap away.
      // (RELAY_DEBUG is assigned further down, so the check happens when the
      // event fires, not when this listener is registered.)
      document.addEventListener('DOMContentLoaded', function() {
        if (!(relaySpoofPath || RELAY_DEBUG)) return;
        try {
          relayEnsurePanel();
          var relayTg = document.getElementById('__relay_debug_toggle');
          if (relayTg && RELAY_DEBUG && __relayHist.length) relayTg.textContent = 'relay \u00b7 ' + __relayHist.length;
        } catch (e) {}
      });

      // Same treatment for the DOM *properties* (el.href = ...), which are a
      // separate code path from setAttribute — frameworks use one or the
      // other, so both need covering.
      try {
        var relayPropList = [
          [window.HTMLAnchorElement, 'href'], [window.HTMLAreaElement, 'href'],
          [window.HTMLScriptElement, 'src'], [window.HTMLImageElement, 'src'],
          [window.HTMLLinkElement, 'href'], [window.HTMLIFrameElement, 'src'],
          [window.HTMLVideoElement, 'src'], [window.HTMLAudioElement, 'src'],
          [window.HTMLSourceElement, 'src'], [window.HTMLObjectElement, 'data'],
          [window.HTMLFormElement, 'action']
        ];
        for (var relayPi = 0; relayPi < relayPropList.length; relayPi++) {
          (function(ctor, prop) {
            try {
              if (!ctor || !ctor.prototype) return;
              var d = Object.getOwnPropertyDescriptor(ctor.prototype, prop);
              if (!d || !d.get || !d.set) return;
              Object.defineProperty(ctor.prototype, prop, {
                get: function() { return fromProxied(d.get.call(this)); },
                set: function(v) { d.set.call(this, toProxied(String(v))); },
                configurable: true
              });
            } catch (e) {}
          })(relayPropList[relayPi][0], relayPropList[relayPi][1]);
        }
      } catch (e) {}

      // The real URL of the current page. In real-path mode the address bar
      // shows only a bare path, so the panel surfaces the full real URL and
      // can copy a working relay link for it.
      function relayCurrentRealUrl() {
        try {
          if (relaySpoofPath) return new URL(relaySpoofReal).origin + location.pathname + location.search + location.hash;
          return fromProxied(location.href);
        } catch (e) {
          return location.href;
        }
      }

      // --- Diagnostic overlay -------------------------------------------
      // Failed requests (non-2xx, network errors, failed resource loads,
      // unrewritten links) are collected in the background and surfaced
      // ONLY on demand: a small fixed "relay · N" button at the top-right.
      // The panel NEVER auto-opens — the previous auto-open-on-failure
      // behavior covered a large viewport area at max z-index on mobile and
      // intercepted every touch, blocking the page. Purely observational
      // otherwise: never alters a request or its result.
      var __relayFailures = [];
      var MAX_LOGGED = 15;
      var __relayNoLinkSeen = {};
      // NO_LINK entries just record clicks on non-anchor elements (buttons,
      // divs, spans). They are not failures. Flip to true only when hunting
      // for link-less navigation that escapes the proxy.
      // Debug mode is switched on by visiting /__relay_debug on the relay (a
      // 24 h cookie), so it can be enabled from a phone without editing this
      // file. It turns on NO_LINK and NAV logging, adds Navigation-API events,
      // and keeps a log in sessionStorage that survives page jumps.
      var RELAY_DEBUG = /(?:^|;\\s*)__relay_debug=1/.test(relayRawCookie());
      var RELAY_LOG_NO_LINK = RELAY_DEBUG;
      var __relayHist = [];
      if (RELAY_DEBUG) {
        try { __relayHist = JSON.parse(sessionStorage.getItem('__relay_hist') || '[]'); } catch (e) { __relayHist = []; }
      }
      function relayHistPush(entry) {
        try {
          __relayHist.unshift(entry);
          if (__relayHist.length > 60) __relayHist.length = 60;
          sessionStorage.setItem('__relay_hist', JSON.stringify(__relayHist));
        } catch (e) {}
      }
      function relayRows() { return RELAY_DEBUG ? __relayHist : __relayFailures; }
      // Logs every history.pushState/replaceState call (original -> proxied).
      // Turn on to see exactly which URL page JS handed the router.
      var RELAY_LOG_NAV = RELAY_DEBUG;

      // Single escape point for the debug panel: rows interpolate strings
      // that are page-controlled (fetch/XHR input URLs) or target-server-
      // controlled (WebSocket close reasons), straight into innerHTML.
      function relayEsc(s) {
        return String(s).replace(/[&<>"']/g, function(c) {
          return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
      }

      function relayEnsurePanel() {
        if (document.getElementById('__relay_debug_toggle')) return;

        var toggle = document.createElement('button');
        toggle.id = '__relay_debug_toggle';
        toggle.type = 'button';
        toggle.style.cssText = 'position:fixed;top:10px;right:10px;z-index:2147483647;' +
          'background:#111;border:1px solid #333;border-radius:4px;padding:6px 9px;' +
          'color:#ccc;font-family:ui-monospace,monospace;font-size:10px;letter-spacing:.04em;' +
          'cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.35);line-height:1;' +
          'touch-action:manipulation;-webkit-tap-highlight-color:transparent;';
        toggle.textContent = 'relay';

        var panel = document.createElement('div');
        panel.id = '__relay_debug_panel';
        panel.style.cssText = 'position:fixed;top:42px;right:10px;z-index:2147483647;' +
          'background:#111;border:1px solid #333;border-radius:6px;width:340px;' +
          'max-width:calc(100vw - 20px);max-height:60vh;overflow:auto;display:none;' +
          'box-shadow:0 4px 16px rgba(0,0,0,.4);' +
          'font-family:ui-monospace,monospace;font-size:11px;';
        panel.innerHTML =
          '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;' +
          'padding:6px 8px;background:#1a1a1a;border-bottom:1px solid #333;position:sticky;top:0;">' +
          '<span style="color:#ccc;">relay v0.11.0 \u2014 failed requests</span>' +
          '<span style="display:flex;gap:10px;align-items:center;">' +
          '<button id="__relay_debug_link" title="Copy a relay link to this page" style="background:none;border:1px solid #444;' +
          'color:#ccc;border-radius:3px;cursor:pointer;font-size:10px;padding:2px 6px;">Link</button>' +
          '<button id="__relay_debug_copy" style="background:none;border:1px solid #444;' +
          'color:#ccc;border-radius:3px;cursor:pointer;font-size:10px;padding:2px 6px;">Copy</button>' +
          '<button id="__relay_debug_close" style="background:none;border:0;color:#888;' +
          'cursor:pointer;font-size:14px;line-height:1;">\u00d7</button></span></div>' +
          '<div id="__relay_debug_list"></div>';

        var mount = document.body || document.documentElement;
        mount.appendChild(panel);
        mount.appendChild(toggle);

        // Press to show, press again to hide — the ONLY way the panel opens.
        toggle.addEventListener('click', function(e) {
          e.stopPropagation();
          var willOpen = panel.style.display === 'none';
          panel.style.display = willOpen ? 'block' : 'none';
          if (willOpen) relayRenderList();
        });
        // Keep clicks on our UI away from the page's own delegated
        // handlers — the site's JS has no business reacting to debug-panel
        // presses (this was half of the "pressing anything does something
        // weird" effect on the old panel).
        panel.addEventListener('click', function(e) { e.stopPropagation(); });
        document.getElementById('__relay_debug_close').addEventListener('click', function() {
          panel.style.display = 'none';
        });
        document.getElementById('__relay_debug_link').addEventListener('click', function() {
          var lbtn = document.getElementById('__relay_debug_link');
          function ldone(ok) { lbtn.textContent = ok ? 'Copied!' : 'Copy failed'; setTimeout(function() { lbtn.textContent = 'Link'; }, 1500); }
          var link = proxyOrigin + '/' + relayCurrentRealUrl();
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(link).then(function() { ldone(true); }, function() { ldone(false); });
          } else {
            ldone(false);
          }
        });
        document.getElementById('__relay_debug_copy').addEventListener('click', function() {
          var btn = document.getElementById('__relay_debug_copy');
          var text = relayRows().map(function(r) {
            return r.status + ' ' + r.method + ' ' + r.url + (r.note ? ' - ' + r.note : '');
          }).join('\\n');
          function done(ok) { btn.textContent = ok ? 'Copied!' : 'Copy failed'; setTimeout(function() { btn.textContent = 'Copy'; }, 1500); }
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function() { done(true); }, function() { done(false); });
          } else {
            done(false);
          }
        });
      }

      function relayRenderList() {
        try {
          var list = document.getElementById('__relay_debug_list');
          if (!list) return;
          list.innerHTML = '<div style="padding:6px 8px;border-bottom:1px solid #262626;color:#8fb4ff;' +
            'word-break:break-all;">page: ' + relayEsc(relayCurrentRealUrl()) + '</div>' + relayRows().map(function(r) {
            return '<div style="padding:6px 8px;border-bottom:1px solid #262626;color:#eee;' +
              'word-break:break-all;">' + (r.t ? '<span style="color:#789;">' + relayEsc(r.t) + '</span> ' : '') +
              '<b style="color:#ff8a63;">' + relayEsc(r.status) + '</b> ' +
              relayEsc(r.method) + ' ' + relayEsc(r.url) + (r.note ? ' \u2014 ' + relayEsc(r.note) : '') +
              (r.page ? '<div style="color:#789;">@ ' + relayEsc(r.page) + '</div>' : '') + '</div>';
          }).join('');
        } catch (e) {}
      }

      function relayLogFailure(method, realUrl, status, note) {
        try {
          // Cloudflare edge instrumentation on the target (RUM beacons like
          // POST /cdn-cgi/rum) 404s through the relay by design — it is
          // never a site defect, only log noise.
          if (typeof realUrl === 'string' && realUrl.indexOf('/cdn-cgi/') !== -1) return;
          relayEnsurePanel();
          __relayFailures.unshift({ method: method, url: realUrl, status: status, note: note || '' });
          if (__relayFailures.length > MAX_LOGGED) __relayFailures.pop();
          if (RELAY_DEBUG) {
            relayHistPush({ t: new Date().toTimeString().slice(0, 8), page: relayCurrentRealUrl(),
              method: method, url: realUrl, status: status, note: note || '' });
          }
          // Update the collapsed button's count badge; the panel itself
          // only re-renders if the user has it open.
          var toggle = document.getElementById('__relay_debug_toggle');
          if (toggle) {
            var relayRowCount = relayRows().length;
            toggle.textContent = relayRowCount ? 'relay \u00b7 ' + relayRowCount : 'relay';
          }
          var panel = document.getElementById('__relay_debug_panel');
          if (panel && panel.style.display !== 'none') relayRenderList();
        } catch (e) {}
      }

      // Resource load failures (a broken image, a CSS/JS file 404ing, a
      // script 404ing) don't fire on fetch/XHR/WebSocket at all, and these
      // error events don't bubble — a capture-phase listener on window is
      // the only way to observe them globally. Preload/prefetch/modulepreload
      // hint failures are EXCLUDED: they're non-breaking by design, and
      // they fire transient errors in the race between insertion and href
      // rewriting (DDG's wpm.* webpack preloads did exactly this — the page
      // itself kept working). Real <script>/<img> failures still log.
      window.addEventListener('error', function(e) {
        var el = e.target;
        if (!el || !el.tagName) return;
        var tag = el.tagName.toUpperCase();
        if (['IMG', 'SCRIPT', 'LINK', 'AUDIO', 'VIDEO', 'SOURCE', 'IFRAME'].indexOf(tag) === -1) return;
        if (tag === 'LINK') {
          var rel = (el.rel || '').toLowerCase();
          if (/preload|prefetch|prerender|preconnect|dns-prefetch|modulepreload/.test(rel)) return;
        }
        var src = el.src || el.href || '?';
        relayLogFailure(tag, src, 'LOAD_ERR', 'failed to load');
      }, true);
      // ---------------------------------------------------------------

      // Debug mode: record EVERY navigation, including location.href = ...
      // assignments that no script can intercept, via the Navigation API
      // (Chromium; absent in some Safari versions), and note page unloads in
      // the persisted log so a jump back to a home page can be traced.
      if (RELAY_LOG_NAV) {
        try {
          if (window.navigation && typeof window.navigation.addEventListener === 'function') {
            window.navigation.addEventListener('navigate', function(e) {
              try {
                relayLogFailure('NAVIGATE', e.destination.url, e.navigationType,
                  (e.formData ? 'form submit, ' : '') + (e.sameDocument ? 'same-document' : 'new document'));
              } catch (x) {}
            });
          }
          window.addEventListener('pagehide', function() {
            try {
              relayHistPush({ t: new Date().toTimeString().slice(0, 8), page: relayCurrentRealUrl(),
                method: 'PAGEHIDE', url: '-', status: 'UNLOAD', note: 'document unloading' });
            } catch (x) {}
          });
        } catch (e) {}
      }

      // Rebuilds a Request object against the proxied URL. The body is
      // BUFFERED rather than re-streamed: a streamed upload needs HTTP/2
      // plus duplex:'half' and fails outright on any redirect, which showed
      // up as "Failed to fetch" on POSTs built with new Request(url, {body}).
      // Falls back to the original Request if anything here throws.
      function relayRebuildRequest(req) {
        var newUrl = toProxied(req.url);
        var opts = {
          method: req.method,
          headers: req.headers,
          credentials: req.credentials,
          redirect: req.redirect,
          signal: req.signal
        };
        var hasBody = req.body !== null && ['GET', 'HEAD'].indexOf(req.method) === -1;
        if (!hasBody) {
          try { return Promise.resolve(new Request(newUrl, opts)); }
          catch (e) { return Promise.resolve(req); }
        }
        var cloned;
        try { cloned = req.clone(); } catch (e) { return Promise.resolve(req); }
        return cloned.arrayBuffer().then(function(buf) {
          opts.body = buf;
          return new Request(newUrl, opts);
        }).catch(function() { return req; });
      }

      // Patched fetch: pages commonly call fetch()/XHR with relative or
      // root-relative URLs. Route them through the proxy — same-origin from
      // the browser's perspective, so no CORS issue (the Worker does the
      // real cross-origin fetch server-side). Handles string URLs, URL
      // objects, and Request objects.
      try {
        var origFetch = window.fetch;
        window.fetch = function(input, init) {
          var self = this;
          var method = (init && init.method) || (input && input.method) || 'GET';
          var originalForLog = typeof input === 'string' ? input :
            (input && (input.url || input.href)) || '';
          var prepared;
          try {
            if (typeof input === 'string') {
              prepared = Promise.resolve(toProxied(input));
            } else if (input && typeof input.url === 'string') {
              prepared = relayRebuildRequest(input);
            } else if (input && typeof input.href === 'string') {
              prepared = Promise.resolve(toProxied(input.href));
            } else {
              prepared = Promise.resolve(input);
            }
          } catch (e) {
            prepared = Promise.resolve(input);
          }
          return prepared.then(function(p) {
            return origFetch.call(self, p, init);
          }).then(function(res) {
            if (!res.ok) {
              if (RELAY_DEBUG) {
                // Debug mode: include the start of the response body. Anti-bot
                // endpoints explain themselves there (a 418 with a challenge
                // type, a rate-limit code, ...).
                try {
                  res.clone().text().then(function(t) {
                    relayLogFailure(method, originalForLog, res.status, t.slice(0, 200));
                  }, function() { relayLogFailure(method, originalForLog, res.status); });
                } catch (e) { relayLogFailure(method, originalForLog, res.status); }
              } else {
                relayLogFailure(method, originalForLog, res.status);
              }
            }
            return res;
          }, function(err) {
            relayLogFailure(method, originalForLog, 'ERR', err && err.message);
            throw err;
          });
        };
      } catch (e) {}

      try {
        var origOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url) {
          this.__relayMethod = method;
          this.__relayUrl = url;
          try {
            if (url !== undefined && url !== null) arguments[1] = toProxied(String(url));
          } catch (e) {}
          return origOpen.apply(this, arguments);
        };

        var origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.send = function() {
          var xhr = this;
          xhr.addEventListener('loadend', function() {
            if (xhr.status === 0 || xhr.status >= 400) {
              var xhrNote = '';
              if (RELAY_DEBUG) {
                try {
                  if (!xhr.responseType || xhr.responseType === 'text') xhrNote = String(xhr.responseText || '').slice(0, 200);
                } catch (e) {}
              }
              relayLogFailure(xhr.__relayMethod || '?', xhr.__relayUrl || '?', xhr.status || 'ERR', xhrNote);
            }
          });
          return origSend.apply(this, arguments);
        };
      } catch (e) {}

      // Search results (Bing, Google, etc.) very commonly open a result via
      // a JS window.open(url, '_blank') call rather than a plain link — a
      // separate API from fetch/XHR/click, previously unpatched entirely.
      // Rewrite the URL before it reaches the real window.open, same as
      // every other patched API above.
      try {
        if (typeof window.open === 'function') {
          var origWindowOpen = window.open;
          window.open = function(url, target, features) {
            var proxied;
            try {
              proxied = (url && !/^about:/i.test(url)) ? toProxied(String(url)) : url;
            } catch (e) {
              proxied = url;
            }
            return origWindowOpen.call(window, proxied, target, features);
          };
        }
      } catch (e) {}

      // EventSource (Server-Sent Events) is a distinct API from fetch/XHR —
      // many streaming chat/AI apps use it to deliver responses token by
      // token. Unpatched, a relative or cross-origin EventSource URL either
      // resolves against the wrong origin or hits a real CORS wall, and the
      // stream never opens — which can look like "nothing happens" on the
      // page (a message that never sends or never gets a reply).
      try {
        if (typeof window.EventSource === 'function') {
          var OrigEventSource = window.EventSource;
          var PatchedEventSource = function(url, opts) {
            return new OrigEventSource(toProxied(String(url)), opts);
          };
          PatchedEventSource.prototype = OrigEventSource.prototype;
          PatchedEventSource.CONNECTING = OrigEventSource.CONNECTING;
          PatchedEventSource.OPEN = OrigEventSource.OPEN;
          PatchedEventSource.CLOSED = OrigEventSource.CLOSED;
          window.EventSource = PatchedEventSource;
        }
      } catch (e) {}

      // WebSocket is a separate global, untouched by the fetch/XHR patches
      // above. Unpatched, a page connecting to wss://real-site.com/socket
      // would either bypass the proxy entirely, or get rejected by the
      // target's own Origin check (the handshake's Origin header reflects
      // THIS page's origin — our proxy's — not the real site's). Route it
      // through the same path-embedded scheme instead.
      try {
        if (typeof window.WebSocket === 'function') {
          var OrigWebSocket = window.WebSocket;
          var proxyWsOrigin = proxyOrigin.replace(/^http/, 'ws');

          // Reuses toProxied()'s relative-URL resolution AND its
          // self-referential-origin recovery, by converting ws(s) <-> http(s)
          // around it, rather than duplicating that logic separately. Without
          // the recovery step, a page building its WS url from its own
          // location.origin — which, under this proxy, IS our own origin, a
          // common "connect to same-host websocket" pattern — produces a
          // self-referential URL the server has to refuse outright, which is
          // exactly what caused an endless connect/retry loop.
          var toProxiedWs = function(raw) {
            var httpForm = String(raw).replace(/^ws/, 'http');
            var proxiedHttp = toProxied(httpForm);
            var prefix = proxyOrigin + '/';
            if (proxiedHttp.indexOf(prefix) === 0) {
              return proxyWsOrigin + '/' + proxiedHttp.slice(prefix.length).replace(/^http/, 'ws');
            }
            return proxiedHttp.replace(/^http/, 'ws');
          };

          var PatchedWebSocket = function(url, protocols) {
            var proxied, realTarget;
            try {
              proxied = toProxiedWs(url);
              var wsPrefix = proxyWsOrigin + '/';
              realTarget = proxied.indexOf(wsPrefix) === 0 ? proxied.slice(wsPrefix.length) : proxied;
            } catch (e) {
              proxied = url;
              realTarget = url;
            }
            var sock = protocols !== undefined
              ? new OrigWebSocket(proxied, protocols)
              : new OrigWebSocket(proxied);
            sock.addEventListener('error', function() {
              relayLogFailure('WS', realTarget, 'ERR', 'connection failed');
            });
            sock.addEventListener('close', function(e) {
              // 1000/1005 are normal closure codes — anything else is worth
              // surfacing (e.g. the Worker rejected the upgrade, or the real
              // target refused the handshake).
              if (e.code !== 1000 && e.code !== 1005) {
                relayLogFailure('WS', realTarget, e.code, e.reason || 'closed unexpectedly');
              }
            });
            return sock;
          };
          PatchedWebSocket.prototype = OrigWebSocket.prototype;
          PatchedWebSocket.CONNECTING = OrigWebSocket.CONNECTING;
          PatchedWebSocket.OPEN = OrigWebSocket.OPEN;
          PatchedWebSocket.CLOSING = OrigWebSocket.CLOSING;
          PatchedWebSocket.CLOSED = OrigWebSocket.CLOSED;
          window.WebSocket = PatchedWebSocket;
        }
      } catch (e) {}

      // Under this proxy, two frames that the page author believes are on
      // different real origins (a game's outer chrome and its embedded
      // iframe, for instance) are BOTH actually served from this proxy's
      // own origin. postMessage's targetOrigin argument exists specifically
      // to restrict delivery to a matching origin — used correctly (an
      // explicit real origin, not '*'), it would silently fail here, since
      // the actual origin never matches what the page author wrote. This
      // was flagged previously as a likely contributor to cross-frame
      // game/widget communication breaking under the proxy.
      //
      // Rewriting to '*' trades away that origin check for correctness of
      // delivery — reasonable for a personal browsing proxy, but worth
      // being explicit about: this is not preserving the security boundary
      // the original page author intended.
      // Wrapped in try/catch deliberately: reassigning a native prototype
      // method can throw in some browser contexts, and an unguarded throw
      // here would silently halt the REST of this script's top-level
      // execution — including everything registered after it (pushState
      // patching, the click/submit interceptors). A postMessage patch
      // failing should cost only postMessage rewriting, not every
      // safety-critical patch that comes after it in the file.
      // postMessage's targetOrigin check can never pass under this proxy: the
      // page author writes the REAL origin, but every frame is served from OUR
      // origin. For the Window interface, postMessage is an OWN property of
      // each window object, not of Window.prototype, so the earlier prototype
      // patch never took effect. Patch the instance instead, and patch
      // same-origin iframe windows (including about:blank ones the page
      // creates itself, which never run this script) the first time the page
      // touches them via iframe.contentWindow.
      // Rewriting targetOrigin to '*' trades away the origin check the page
      // author intended, for correctness of delivery.
      function relayPatchPostMessage(w) {
        try {
          if (!w || w.__relayPM) return;
          var orig = w.postMessage;
          if (typeof orig !== 'function') return;
          var wrapped = function(message, targetOrigin) {
            var args = Array.prototype.slice.call(arguments);
            try {
              var t = args[1];
              if (typeof t === 'string' && t !== '*') {
                args[1] = '*';
              } else if (t && typeof t === 'object' && typeof t.targetOrigin === 'string' && t.targetOrigin !== '*') {
                args[1] = Object.assign({}, t, { targetOrigin: '*' });
              }
            } catch (e) {}
            return orig.apply(w, args);
          };
          Object.defineProperty(w, '__relayPM', { value: true });
          w.postMessage = wrapped;
        } catch (e) {}
      }
      relayPatchPostMessage(window);

      try {
        var relayCwDesc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
        if (relayCwDesc && relayCwDesc.get) {
          Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
            get: function() {
              var w = relayCwDesc.get.call(this);
              relayPatchPostMessage(w);
              return w;
            },
            configurable: true
          });
        }
      } catch (e) {}

      // SPA client-side routing (history.pushState/replaceState) changes the
      // address bar directly, with no network request at all — none of the
      // fetch/XHR/WebSocket interceptors above can see this. A page's own
      // pushState('/results?q=hi') resolves against the CURRENT address
      // (our proxy), landing on the bare proxy origin with no embedded
      // target at all — this is what produced a URL like
      // "proxy.../results?search_query=hi" with youtube.com missing.
      function relayUpdateBaseTag(proxiedUrl) {
        try {
          var prefix = proxyOrigin + '/';
          if (proxiedUrl.indexOf(prefix + 'http') !== 0) return;
          var baseEl = document.querySelector('base');
          if (baseEl) baseEl.setAttribute('href', proxiedUrl);
        } catch (e) {}
      }

      // Wrapped for the same reason as the postMessage patch above: a throw
      // here must not be able to silently disable everything registered
      // after it, especially the click/submit interceptors.
      // In real-path mode the address bar must keep showing real paths, so the
      // proxied URL is used only for <base>; the history entry gets the real
      // path. Cross-origin or unparseable URLs fall back to the proxied form.
      function relayAddressUrl(proxiedUrl) {
        if (!relaySpoofPath) return proxiedUrl;
        try {
          var ru = new URL(fromProxied(proxiedUrl));
          if (ru.origin === new URL(relaySpoofReal).origin) return ru.pathname + ru.search + ru.hash;
        } catch (e) {}
        return proxiedUrl;
      }

      try {
        var origPushState = history.pushState;
        var origReplaceState = history.replaceState;

        history.pushState = function(state, title, url) {
          if (url !== undefined && url !== null) {
            var relayOrigPush = String(url);
            url = toProxied(relayOrigPush);
            if (RELAY_LOG_NAV) relayLogFailure('PUSH', relayOrigPush, 'NAV', '-> ' + url);
            var relayAddrPush = relayAddressUrl(url);
            relayUpdateBaseTag(url);
            url = relayAddrPush;
          }
          return origPushState.call(this, state, title, url);
        };

        history.replaceState = function(state, title, url) {
          if (url !== undefined && url !== null) {
            var relayOrigReplace = String(url);
            url = toProxied(relayOrigReplace);
            if (RELAY_LOG_NAV) relayLogFailure('REPLACE', relayOrigReplace, 'NAV', '-> ' + url);
            var relayAddrReplace = relayAddressUrl(url);
            relayUpdateBaseTag(url);
            url = relayAddrReplace;
          }
          return origReplaceState.call(this, state, title, url);
        };
      } catch (e) {}

      // Back/forward navigation between pushState entries restores the URL
      // without a network request either — keep <base> in sync there too.
      window.addEventListener('popstate', function() {
        if (relaySpoofPath) {
          try {
            relayUpdateBaseTag(proxyOrigin + '/' + new URL(relaySpoofReal).origin +
              location.pathname + location.search);
          } catch (e) {}
          return;
        }
        relayUpdateBaseTag(location.href);
      });

      // Dynamically-created content (React, Vue, or any JS setting
      // href/src directly from already-fetched data) never passes through
      // server-side HTMLRewriter (which only sees the initial HTML) NOR
      // any of the fetch/XHR/WebSocket patches above (no new request
      // happens at render time — the data was already fetched earlier).
      // This is what left DuckDuckGo's actual result links — rendered by
      // React from a separately-fetched payload — completely unrewritten,
      // and it's a general pattern on any JS-heavy site, not DDG-specific.
      // Watching the DOM directly, rather than any particular request or
      // event, is the only way to catch this regardless of framework.
      var RELAY_URL_ATTRS = {
        A: 'href', IMG: 'src', SCRIPT: 'src', LINK: 'href', IFRAME: 'src',
        VIDEO: 'src', AUDIO: 'src', SOURCE: 'src', EMBED: 'src', OBJECT: 'data',
        FORM: 'action'
      };
      var RELAY_URL_SELECTOR =
        'a[href],img[src],script[src],link[href],iframe[src],' +
        'video[src],audio[src],source[src],embed[src],object[data],form[action]';

      function relayRewriteElement(el) {
        try {
          var attr = RELAY_URL_ATTRS[el.tagName];
          if (!attr) return;
          // Native accessors deliberately: the hooked getAttribute returns
          // the UNWRAPPED original, so the already-proxied check below would
          // never match and this would re-rewrite the same element forever,
          // each write retriggering the observer that called us.
          // GET forms are handled by the submit interceptor; only forms that
          // POST (a login, above all) need their action pointed through the relay.
          if (el.tagName === 'FORM' && (relayNativeGetAttr.call(el, 'method') || 'get').toLowerCase() === 'get') return;
          var raw = relayNativeGetAttr.call(el, attr);
          if (!raw || raw.charAt(0) === '#' || /^(javascript|data|blob|mailto|tel):/i.test(raw)) return;
          // Already correctly proxied — no-op. Also what stops this from
          // re-triggering itself forever: writing the rewritten value
          // below is itself an attribute mutation the observer sees, and
          // on that second pass this check is what makes it a no-op.
          if (raw.indexOf(proxyOrigin + '/http') === 0) return;
          var proxied = toProxied(raw);
          if (proxied && proxied !== raw) relayNativeSetAttr.call(el, attr, proxied);
        } catch (e) {}
      }

      function relayScanForUrlElements(node) {
        if (!node || node.nodeType !== 1) return;
        if (RELAY_URL_ATTRS[node.tagName]) relayRewriteElement(node);
        if (node.querySelectorAll) {
          var els = node.querySelectorAll(RELAY_URL_SELECTOR);
          for (var i = 0; i < els.length; i++) relayRewriteElement(els[i]);
        }
      }

      relayScanForUrlElements(document.documentElement);

      // Diagnostic sweep: find any <a href> that's still a raw absolute
      // external URL, not proxied at all — this is the concrete check for
      // whether relayScanForUrlElements/the MutationObserver above are
      // actually catching everything, rather than relying on manual
      // inspection. Runs a few times at increasing delays to also catch
      // content that renders later (lazy-loaded results, infinite scroll).
      function relayScanForStaleLinks() {
        try {
          var anchors = document.querySelectorAll('a[href]');
          var found = [];
          for (var i = 0; i < anchors.length && found.length < 5; i++) {
            // Native accessor, same reason as relayRewriteElement: the hooked
            // getAttribute unwraps proxified URLs back to the real target,
            // which made every correctly-rewritten link read as "stale".
            var href = relayNativeGetAttr.call(anchors[i], 'href');
            if (!/^https?:\\/\\//i.test(href)) continue; // only absolute http(s) hrefs are unambiguous
            if (href.indexOf(proxyOrigin) === 0) continue; // already correctly proxied
            found.push(href);
          }
          for (var j = 0; j < found.length; j++) {
            relayLogFailure('LINK', found[j], 'UNREWRITTEN', 'raw absolute href still in DOM');
          }
        } catch (e) {}
      }
      setTimeout(relayScanForStaleLinks, 1500);
      setTimeout(relayScanForStaleLinks, 4000);
      setTimeout(relayScanForStaleLinks, 8000);

      if (typeof MutationObserver === 'function') {
        var relayObserver = new MutationObserver(function(mutations) {
          for (var i = 0; i < mutations.length; i++) {
            var addedNodes = mutations[i].addedNodes;
            for (var j = 0; j < addedNodes.length; j++) {
              relayScanForUrlElements(addedNodes[j]);
            }
          }
        });
        relayObserver.observe(document.documentElement, { childList: true, subtree: true });
      }

      // Link click interception. Capture phase: must run BEFORE the page's
      // own click-tracking-then-navigate handlers, not after. Search
      // engines commonly intercept result clicks (preventDefault, log a
      // beacon) then navigate via their own location.href assignment
      // shortly after — bubble phase + checking e.defaultPrevented (an
      // earlier approach) saw defaultPrevented=true from that same
      // preventDefault call and backed off, letting their un-proxied
      // navigation through untouched. That's what let every search
      // engine's result clicks escape the proxy.
      //
      // Skip elements that are semantically UI controls (menu/dropdown
      // triggers, tabs) rather than real navigation, using ARIA attributes
      // rather than timing — this preserves GitHub-style menus wrapped in
      // <a> that the page handles itself. role="button" and aria-expanded
      // are deliberately NOT used as skip signals: both are commonly
      // applied to genuine navigating links too, and treating either as a
      // skip let those escape uncontrolled.
      //
      // 'click' and 'auxclick' share this handler — auxclick is what fires
      // for middle-click/open-in-new-tab, a DIFFERENT event from 'click',
      // so that path otherwise used the raw, un-rewritten href with no
      // interception at all.
      function relayHandleLinkClick(e) {
        if (e.defaultPrevented) return;
        // Our own debug UI (toggle button + panel): never intercepted and
        // never logged. The interceptor previously fell through to the
        // NO_LINK diagnostic for the panel's own Copy button, so every
        // panel press logged itself.
        try {
          if (e.target && e.target.closest &&
              (e.target.closest('#__relay_debug_toggle') || e.target.closest('#__relay_debug_panel'))) {
            return;
          }
        } catch (err) {}
        // e.target is retargeted to the shadow host for clicks originating
        // inside a Shadow DOM boundary (Web Components), so .closest('a')
        // on it can miss the actual link entirely, letting the click fall
        // through to native, unintercepted navigation. composedPath()
        // includes the true originating chain regardless of shadow
        // boundaries; falls back to [e.target] where unsupported.
        var path = typeof e.composedPath === 'function' ? e.composedPath() : [e.target];
        var link = null;
        for (var i = 0; i < path.length; i++) {
          if (path[i] && path[i].tagName === 'A') { link = path[i]; break; }
        }
        if (!link) {
          // Diagnostic: no <a> anywhere in the click's path at all. If a
          // site's "links" are actually non-anchor clickable elements (a
          // <div> or <span> with its own onClick, common in React UIs),
          // this interceptor can never see them regardless of any
          // href-handling logic — logging what WAS clicked is the only way
          // to confirm that rather than keep guessing blindly.
          // Ordinary form controls (buttons, inputs, textareas, selects)
          // are EXPECTED clickables, not fake links — logging every tap
          // flooded the panel. Skipped. Remaining entries dedupe per
          // element so repeated taps (menus, carousels, scroll regions)
          // log once, not every press.
          if (!RELAY_LOG_NO_LINK) return;
          try {
            var clickedEl = path[0];
            if (clickedEl && clickedEl.nodeType === 1) {
              if (['BUTTON', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'LABEL', 'SUMMARY'].indexOf(clickedEl.tagName) !== -1) return;
              var cls = clickedEl.className;
              var desc = clickedEl.tagName +
                (clickedEl.id ? '#' + clickedEl.id : '') +
                (typeof cls === 'string' && cls ? '.' + cls.trim().split(/\\s+/).join('.') : '');
              if (__relayNoLinkSeen[desc]) return;
              __relayNoLinkSeen[desc] = 1;
              relayLogFailure(e.type.toUpperCase(), desc, 'NO_LINK', 'no <a> found in click path');
            }
          } catch (err) {}
          return;
        }
        // aria-haspopup is a strong, unambiguous signal that this isn't
        // real navigation — it specifically means "opens a menu/dialog".
        var haspopup = link.getAttribute('aria-haspopup');
        var isUiControl = haspopup && haspopup.toLowerCase() !== 'false';
        if (isUiControl) return;
        // Native accessor: the hooked getAttribute returns the unwrapped
        // original, which would defeat the already-proxied check below and
        // make this hijack every click instead of letting correct links
        // navigate natively.
        var raw = relayNativeGetAttr.call(link, 'href');
        if (!raw || raw.charAt(0) === '#' || /^(javascript|mailto|tel):/i.test(raw)) return;
        // Already correctly proxied (the common case — any link server-side
        // rewriting already handled) — do nothing and let native browser
        // behavior take it from here. Intercepting anyway needlessly blocks
        // any other legitimate click handler the site had on this link (via
        // stopImmediatePropagation below), and forcing target="_blank"
        // through window.open() instead of native anchor behavior is
        // exactly the kind of pattern some browsers' popup blockers flag.
        if (raw.indexOf(proxyOrigin + '/http') === 0) return;
        e.preventDefault();
        // Without this, the page's own handler still runs afterward
        // (preventDefault doesn't stop propagation) and its un-proxied
        // location.href assignment would overwrite ours a moment later —
        // same tick, last assignment wins.
        e.stopImmediatePropagation();
        var proxied = toProxied(raw);
        // auxclick (middle-click) always means a new tab, regardless of the
        // link's own target attribute — that's the whole point of the
        // gesture. Plain click respects target="_blank" the same as before.
        if (e.type === 'auxclick' || (link.target && link.target !== '_self')) {
          window.open(proxied, e.type === 'auxclick' ? '_blank' : link.target);
        } else {
          window.location.href = proxied;
        }
      }
      document.addEventListener('click', relayHandleLinkClick, true);
      document.addEventListener('auxclick', relayHandleLinkClick, true);

      // Shared by both the 'submit' event listener below (catches
      // requestSubmit() and genuine user-triggered submissions) and the
      // HTMLFormElement.prototype.submit() patch further down (catches
      // direct .submit() calls, which — per spec — never fire a 'submit'
      // event at all, so the listener alone can't see them).
      function relaySubmitGetForm(form) {
        var target = form.getAttribute('data-proxy-target') || form.action;
        if (!target) return false;
        var method = (form.getAttribute('method') || 'get').toLowerCase();
        if (method !== 'get') return false; // POST left to default handling
        // toProxied/fromProxied round-trip: a JS-created form whose action
        // resolved against our proxied <base> (e.g. "<proxy>/search") is
        // recovered against the REAL site instead of the relay's own origin.
        var urlObj = new URL(fromProxied(toProxied(target)), realBase());
        var params = new URLSearchParams();
        new FormData(form).forEach(function(value, key) {
          if (typeof value === 'string') params.append(key, value);
        });
        urlObj.search = params.toString();
        window.location.href = proxyOrigin + '/' + urlObj.href;
        return true;
      }

      document.addEventListener('submit', function(e) {
        var form = e.target;
        if (!form || form.tagName !== 'FORM') return;
        if (relaySubmitGetForm(form)) e.preventDefault();
      }, true);

      // form.submit() bypasses the 'submit' event entirely (a documented
      // DOM quirk) — a <textarea>-based search box (which doesn't submit
      // on Enter natively, unlike a single-line <input>) commonly has its
      // own JS call this directly to make Enter work, which is invisible
      // to the listener above no matter what it does.
      try {
        var origFormSubmit = HTMLFormElement.prototype.submit;
        HTMLFormElement.prototype.submit = function() {
          try {
            if (relaySubmitGetForm(this)) return;
          } catch (e) {}
          return origFormSubmit.call(this);
        };
      } catch (e) {}
    })();
    </script>
  `,
      { html: true }
    );
  }
  }
