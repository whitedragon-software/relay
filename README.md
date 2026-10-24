# Relay

A single-file Cloudflare Worker that proxies web pages through your own
domain: links, forms, scripts, cookies, WebSockets and client-side navigation
stay on the relay instead of escaping to the real site.

```
https://relay.<username>.workers.dev/https://example.com/page?x=1
```

- `_worker.js`: the Worker. Single file, no build step, no dependencies.
- `wrangler.jsonc`: deploy config — Worker name `relay`, entry point `_worker.js`.
- `README.md`: this file.
- `CHANGELOG.md`: what changed in each version.
- `archive/`: previous versions of the worker, kept for reference.

---

## Deploy

From the folder containing `_worker.js` and `wrangler.jsonc`:

```
npx wrangler deploy
```

Validate first with `npx wrangler deploy --dry-run --outdir dist` — bundling
and config checks, nothing goes live. Wrangler uploads only the bundle built
from `_worker.js` (plus anything it imports); the folder's other files
(`README.md`, `CHANGELOG.md`, `archive/`, …) never leave your machine. The
dashboard's quick-edit view edits the deployed bundle directly, and the next
deploy overwrites it — treat the local file as the source of truth. The free
tier is enough.

### Optional: password protection

Set a `PASSWORD` secret and the whole relay (homepage, proxying, WebSockets,
everything) requires it:

```
npx wrangler secret put PASSWORD
```

(or Settings → Variables and Bindings → Add → **Secret** in the dashboard;
keep the `vars` block in `wrangler.jsonc` empty so a deploy never clobbers
it). **Unset, the relay behaves exactly as before.**

Local note: the session cookie is `Secure`, so the gate loops on plain-HTTP
`wrangler dev` (known issue) — test it on the deployed HTTPS URL.

| Path | Purpose |
|---|---|
| `/login` | Login form. Unauthenticated requests redirect here with `?redirect=<where you were going>`. |
| `/logout` | Expires the session cookie. Reached from the **Log out** button in the homepage header and the footer link, both shown only when a password is set. Bookmark it for shared machines. |

The old `/__relay_login` and `/__relay_logout` URLs redirect to these.
`/login` and `/logout` are short names that proxied sites use too, so a
request for one whose `Referer` is a proxied page is treated as that site's own
link and repaired like any other escape; typed or bookmarked visits, form
posts and the login redirect (`?redirect=`) are the relay's.

The session cookie holds a SHA-256 hash of the password (not the password),
`HttpOnly; Secure; SameSite=Lax`, 30 days. See *Limitations* for what this
does and doesn't protect against.

### Optional: Cloudflare zone settings

If the relay runs on your own zone (custom domain rather than `workers.dev`),
Cloudflare's own features can add noise that the Worker cannot remove: Speed
Brain adds a `Speculation-Rules` header that points at `/cdn-cgi/speculation`
(console warning, harmless), and Web Analytics auto-injection can post to
`/cdn-cgi/rum` on the relay's own origin (a 404). Turn those off in the
dashboard if you want a quiet console. Equivalent requests aimed at a
*target's* `/cdn-cgi/rum` and `/cdn-cgi/speculation` are answered with a 204
by the Worker.

---

## Using it

Open `https://relay.<username>.workers.dev/`, enter an address, and browse
normally. Bare domains work too (`/example.com` assumes `https://`). Old
`?url=` links redirect to the canonical form.

**Which version is live:** the homepage footer shows `build v0.10.0 ·
path-embedded`, and the diagnostic panel header shows `relay v0.10.0 — failed
requests`. (Before v0.9.0 the panel header never actually rendered — the
injected script was syntactically dead from v0.5.0 to v0.8.0; see
`CHANGELOG.md`.) If you don't see v0.10.0, you're testing an old deploy.

**Cookies:** sites you log into stay logged in — see *Cookie jar* below.
`/cookies` (linked from the homepage footer) lists the sites that have cookies
in this browser and clears one site or all of them; clearing signs you out of
those sites.

**Diagnostic panel:** on any proxied page, failures (non-2xx fetch/XHR,
WebSocket errors, resources that failed to load) collapse into a small
top-right button, `relay · N`. It never opens by itself: click to expand.
Inside, the first line (`page: …`) shows the current page's real URL, **Link**
copies a working relay link for it, and **Copy** puts the failure list on the
clipboard without DevTools. Cloudflare's own `/cdn-cgi/` requests and preload
failures are filtered out so they don't inflate N.

**Debug mode:** visit `https://relay.<username>.workers.dev/__relay_debug` to
turn on verbose diagnostics for 24 hours (a cookie; `/__relay_debug?on=0` turns
it off) — handy on a phone, where editing the worker for a flag isn't an
option. It logs clicks with no `<a>` in their path (`RELAY_LOG_NO_LINK`, not
failures — only useful when hunting for link-less navigation escapes), every
`pushState`/`replaceState` call as original → proxied (`RELAY_LOG_NAV`) and,
where the browser supports the Navigation API (Chromium), every navigation
including `location.href = …` assignments. The log is also kept in
`sessionStorage`, so after a page jumps away (for example back to a site's
home page) the panel on the next page still shows what happened before the
jump. Failed `fetch`/XHR entries also include the first 200 characters of
the response body, which is how bot-protection responses explain themselves.
Open the panel and use Copy to paste it back.

**Real-path hosts (experimental):** on a few hosts the address bar shows a
bare real path (`/search?q=…`) instead of the embedded form
(`/https://github.com/search?q=…`) — see *Real-path mode* below. On those
pages the `relay` button is present from load, and **Link** is how you get a
shareable URL.

---

## How it works

**URL scheme.** The target lives in the path, not a query string, so the
browser's native relative-URL resolution (ES module imports, webpack chunks,
CSS `url()`) works inside files the relay never parses.

**Server side.**
- `HTMLRewriter` rewrites links, images, scripts, stylesheets, iframes, media,
  `srcset`, `<meta http-equiv="refresh">` and forms, in `text/html` and XHTML
  documents alike. Empty `src`/`href` values are left alone (an empty `src`
  must not resolve to the page itself). A forced permissive referrer policy
  keeps the recovery below working on sites that restrict it.
- Requests that reach the bare origin with no target (root-relative escapes)
  are repaired from the `Referer`; a Service Worker is a backstop. Paths whose
  `//` was collapsed by a client router (`/https:/host/x`) are restored to
  `/https://host/x` by both.
- A navigation whose upstream redirected (`bbc.com` → `www.bbc.com`) is
  answered with a 302 to the final proxied URL, so the address bar and the
  injected `<base>` agree.
- Real method, body and headers are forwarded (a denylist, so custom API
  headers survive). The visitor's real `User-Agent` is forwarded. `Referer`
  and `Origin` are corrected to the page's real URL and origin (for
  real-path pages, from the `__relay_ctx` cookie), which media CDNs and CORS
  allow-lists check. Relay-wrapped URLs inside an upstream query string (a
  consent manager's `href=<relay>/https://…`, or `href=<relay>/news` on a
  real-path page) are restored to the real URL. The browser's own cookies are
  never forwarded as-is: the target gets only the cookies from the jar below.
- Timeout, one retry for bodyless requests, `Retry-After`-aware backoff on
  429/503, and a styled error page for Cloudflare edge failures.
- Caching: edge cache for HTML and static assets (GET only), keyed partly on
  the request's `Accept` header with per-status TTLs (`cacheTtlByStatus`);
  Cloudflare's fetch cache; long browser caching for static types. Only
  anonymous responses are cached: a request that carries jar cookies bypasses
  every cache, a response that sets cookies is never stored, and with the
  cookie jar on, Cloudflare's fetch cache is limited to static assets. Large
  assets (>20 MB) skip the edge-cache copy. Range requests and HLS/DASH
  manifests (`.m3u8`, `.mpd`) bypass the blanket edge cache — a cached live
  playlist stalls playback.
- WebSockets are bridged browser to Worker to target, including subprotocol
  negotiation, the real `Origin` and the target's cookies.
- The relay answers `/favicon.ico` and `/robots.txt` at its own root, so
  those bare-origin requests never enter the target-recovery path. A target's
  own `/cdn-cgi/rum` and `/cdn-cgi/speculation` get a 204.
- Narrow search-engine special case: embedded URLs in
  `links.duckduckgo.com` responses are rewritten server-side
  (`SEARCH_DATA_HOSTS`; add other engines only after inspecting their
  payload). Image hosts inside those payloads (`REWRITE_SKIP_HOSTS`) are left
  alone — pre-wrapping them breaks DDG's own image proxy.

**Cookie jar.** The Worker has no storage, so each visitor's browser keeps its
own jar, as cookies on the relay's origin — one per target host and
visibility: `__rj_h_<host>` holds the cookies a site marked HttpOnly (the
relay sets it HttpOnly too, so page scripts cannot read it) and `__rj_s_<host>`
the rest, which the injected `document.cookie` shim exposes to the page.
On every request the Worker turns the records that match the target
(host-only vs. `Domain`, `Path`, `Secure`, expiry, and `SameSite` judged
against the page's site) into an ordinary `Cookie` header, and folds each
upstream `Set-Cookie` back into the jar. While the jar is on, redirects are
followed by hand so cookies set on a redirect hop — the usual login flow — are
kept and sent on the next hop. Jar cookies are capped at about 3 KB each and
9 KB in total; past that the largest untouched jars are expired so the browser's
`Cookie` header can never grow past what Cloudflare accepts. To disable the jar
and restore the old anonymous behavior exactly, set `COOKIE_JAR` to `false` at
the top of `_worker.js`.

**Client side (injected script).** Patches `fetch` (string, `URL` and
`Request` inputs; `Request` bodies are buffered rather than re-streamed), XHR,
`EventSource`, `window.open`, `WebSocket`, `postMessage` (on the window
instance and on iframe windows as they are first touched),
`pushState`/`replaceState` and `form.submit()`; replaces `document.cookie`
with a shim over the cookie jar; hooks `setAttribute`/`getAttribute` and the
`href`/`src` properties so URLs written by JS frameworks are proxied at
assignment and read back unmodified (this stops React reverting the rewrite);
intercepts clicks and middle-clicks in the capture phase; blocks the target
site's own Service Worker registration. A `MutationObserver` covers
`innerHTML`-inserted content. Each risky patch is wrapped in its own
`try`/`catch` so one failing patch cannot silently disable the rest.

**Real-path mode (experimental).** Sites whose client-side router reads
`location.pathname` (Next.js, React Router, GitHub's React apps) cannot work
under a path-embedded scheme: they see `/https://host/page` instead of
`/page`, fail to match their routes, and crash, hard-navigate to a collapsed
path, or leave widgets inert. For hosts matched by `REAL_PATH_HOSTS` — today
`bbc.com`, `bbc.co.uk`, `github.com` and `react.dev`, each with or without
`www.`, **exact hostnames only** (`gist.github.com` is not included) — the
injected script rewrites the address bar to the real path right after load.
Loading is unaffected, because relative URLs resolve through the injected
`<base>`, not the address bar. History calls keep real paths in the bar, and a
one-day `__relay_ctx` cookie (set client-side, never forwarded upstream)
remembers the real origin so a reload of the bare path — and bare requests
whose `Referer` can't place them — are routed back to the right site. Every
other host keeps the full embedded address.

To change which hosts use it, edit the single constant near the top of
`_worker.js`:

```js
const REAL_PATH_HOSTS = /^(www\.)?(bbc\.com|bbc\.co\.uk|github\.com|react\.dev)$/i;
```

Set it to `/^$/` to disable the mode everywhere. Add a host only when it shows
the same symptoms (a client-side crash or dead widgets, with
`location.pathname` visible in the error); sites that already work should not
be added.

---

## Editing and verifying `_worker.js`

The injected script is a string inside a template literal (in
`ScriptInjector`), so **`node --check _worker.js` does not validate it.** A
syntax error there stops the whole script in the browser while the outer file
still checks clean — this has happened twice: a stray brace (caught
pre-deploy) and the template-escaping bug that shipped from v0.5.0 to
v0.9.0. The injected script contains `${…}` placeholders, so check the text
the browser actually receives — evaluate the template, don't grep the source.
Run all three checks:

```
node --check _worker.js

node --input-type=module - << 'JS'
import fs from 'fs';
const src = fs.readFileSync('_worker.js', 'utf8')
  .replace('export default {', 'const __worker = {') +
  '\nglobalThis.__SI = ScriptInjector; globalThis.__SW = SW_SCRIPT;';
fs.writeFileSync('/tmp/_w.mjs', src);
await import('/tmp/_w.mjs');
let out = '';
new globalThis.__SI('https://relay.test', '/x', true).element({ prepend: (s) => { out = s; } });
fs.writeFileSync('inj.js', out.replace(/^\s*<script>/, '').replace(/<\/script>\s*$/, ''));
fs.writeFileSync('sw.js', globalThis.__SW);
JS
node --check inj.js
node --check sw.js
```

`inj.js` is the client script as emitted (real-path mode on and cookie jar on —
the constructor's arguments are the relay origin, the real path, and the jar
flag; pass `''` and `false` to check the normal, jar-off variants), `sw.js` the
relay's Service Worker script. The Service Worker script is also a template
literal and has the same backslash rule.

**Backslash rule:** a backslash inside the injected script (and the Service
Worker script) must be written **doubled** in the source. The template
literal consumes one level: source `\/` emits `/`, which is how `/\/ck\/a$/i`
became the line comment `//ck/a$/i` and killed the whole client script from
v0.5.0 until v0.9.0. Evaluating the template, as above, catches a mis-escape
that produces a syntax error. It does **not** catch one that still parses
but means something else — a missing `\\/` once turned "path starts with
`/https://`" into "starts with `/https:/`" and passed every syntax check. For
URL and cookie logic, run the function on sample inputs
(`toProxied('/https:/react.dev/')` and friends) or the checks below, not just
`--check`.

Also avoid backticks and `${` inside the injected script's comments and code:
they end or interpolate the template literal itself.

Inside the injected script, read link attributes with
`relayNativeGetAttr` / write with `relayNativeSetAttr`. The hooked
`getAttribute` returns the *unwrapped* URL, so using it for an "already
proxied" check never matches and causes an infinite rewrite loop. Likewise,
read the page's real cookie string with `relayRawCookie()` /
`relayRawCookieSet()`: `document.cookie` is the jar shim, which hides the
relay's own cookies.

The jar's record format and base64url codec exist twice — the Worker's
`loadJar`/`jarSetCookieHeaders` and the injected script's
`relayJarRead`/`relayJarWrite` — and must stay identical. After touching
either, round-trip a cookie both ways (Worker builds a jar cookie, the shim
reads it; the shim writes one, the Worker reads it).

---

## Quick test checklist

1. Homepage loads; footer shows `build v0.10.0 · path-embedded`.
2. `/https://example.com`: page renders, link clicks stay on the relay.
3. DuckDuckGo search: result links show the relay prefix on hover and stay on
   the relay when clicked; switching All / Images / Videos / News keeps
   `duckduckgo.com` embedded in the relay URL; video thumbnails load.
4. `https://echo.websocket.org/.ws`: connects and echoes (WebSocket bridge).
5. With `PASSWORD` set: any URL redirects to `/login`; a wrong password
   returns to the form with an error and no resubmit prompt; a correct one
   lands on the original destination; `/logout` ends the session; the homepage
   shows a **Log out** button in the header and a footer link; `/__relay_login`
   and `/__relay_logout` redirect to the new URLs.
6. Deliberately bad input (`/https://gitbub.com`) shows a styled error page,
   not Cloudflare's.
7. Panel smoke test (proves the injected script is alive): open a proxied
   page with at least one broken subresource — the top-right shows
   `relay · N`, it stays collapsed until clicked, and clicking inside it
   doesn't navigate. Copy produces the failure list.
8. Real-path hosts: `/https://react.dev` stays on the page (no redirect to a
   broken `https:/react.dev`) and shows `/` in the address bar; a GitHub repo
   opens its search-filter and "…" menus, and a GitHub search shows the real
   URL in the panel's `page:` row; `/https://www.bbc.com/news` renders without
   the "client-side exception" screen. Reload on a non-root real-path page
   lands back on the same site. A host outside the list (for example
   `gist.github.com`) keeps its embedded address.
9. `/https://bbc.com/news` ends on `www.bbc.com` with the address bar matching
   the final URL (redirect-follow check).
10. `/__relay_debug` shows "Relay debug mode: ON"; on any proxied page the
    `relay` button is then present from load, and it keeps entries from the
    previous page after a navigation. `/__relay_debug?on=0` turns it off.
11. Cookie jar: log into a site that has a login form (use a throwaway
    account) and reload — you stay signed in; `/cookies` lists the site;
    "Clear" signs you out. In the browser's cookie view the relay's origin
    holds `__rj_…` cookies, and the site's own cookie names do not appear
    there.
12. A proxied site's own `/login` link (for example one on GitHub or BBC) takes
    you to that site's login page, not the relay's, whether or not a password
    is set.

---

## Limitations

- **CAPTCHAs (reCAPTCHA, hCaptcha, Turnstile) generally will not work.** They
  validate the page's origin and are designed to detect embedding and proxying,
  which is exactly what a relay is. This is not fixed and a general fix is not
  expected. The diagnostic panel will show which requests fail.
- **Cookie jar limits.** Cookies are stored in the visitor's browser on the
  relay's origin, so every proxied site shares that origin: a page's script can
  read the *script-visible* (non-HttpOnly) cookies of other proxied sites by
  bypassing the shim, just as proxied sites already share `localStorage`. Treat
  the relay as one browser profile, not isolated sites. Each site is capped at
  about 3 KB of cookies (oldest dropped first) and all sites together at about
  9 KB (largest untouched jars expired); heavy cookie users can be signed out of
  sites. `SameSite` is enforced from the page's site as best the relay can tell,
  `credentials: 'omit'` is not honoured, a built-in short list of multi-label
  suffixes stands in for the public-suffix list, and session cookies are
  discarded when the browser closes. A site that checks cookies against
  fingerprinting or datacenter-IP signals can still refuse a login.
- **POST forms are not proxied** (they submit straight to the real site).
  `fetch`/XHR POSTs *are* proxied.
- **Target sites can block Cloudflare's IP ranges** (some anti-bot systems do).
  No code change can fix that; the diagnostic panel shows the status codes.
- **Free-plan WebSocket idle timeout is 100 s.** An idle game or chat
  connection can drop. A keepalive was deliberately not added: it would inject
  unexpected messages into the real application protocol.
- **All proxied sites share the relay origin**, so their
  `localStorage`/`sessionStorage` can collide. Per-target storage isolation
  is deliberately deferred.
- **Real-path mode trade-offs.** The address bar on those hosts carries no
  target host, so a copied bar URL does not work (use the panel's Link
  button). The `__relay_ctx` cookie is shared between tabs, so reloading an
  older real-path tab after opening a different real-path site in another tab
  can land on the wrong site. Reloading a site's root page (`/`) lands on the
  relay homepage. Sites that read their origin or full URL, not just the path,
  can still misbehave.
- **Bot-protected services** (AI chat endpoints such as duck.ai's, which
  answer `418` and ask to "verify you're human" over and over) may still not
  work even with the cookie jar. Their checks also rely on fingerprint and
  datacenter-IP signals that a proxy cannot reproduce.
- **Some sites cannot work at all under path embedding** and are not fixed by
  the above: anything that validates its own origin (consent and anti-bot SDKs
  often do), or loads origin-locked resources.
- Attribute hooks match lowercase names only (`getAttribute("HREF")` is not
  intercepted).
- `postMessage` target origins are widened to `*`, trading the page author's
  origin check for cross-frame messages that work under the relay.
- The password gate has no rate limiting, a non-timing-safe comparison, and
  recomputes the password hash on every request. The `Secure` session cookie
  loops the login on plain-HTTP local development, and so do the cookie jar's
  `Secure` cookies. It keeps casual visitors and crawlers out; it is not
  hardened access control.
- This is an open relay for anyone with the URL unless `PASSWORD` is set.
  Consider a target allow-list and rate limiting before exposing it publicly.
