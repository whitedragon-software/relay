# Relay

A single-file Cloudflare Worker that proxies web pages through your own
domain: links, forms, scripts, WebSockets and client-side navigation stay on
the relay instead of escaping to the real site.

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
| `/__relay_login` | Login form. Unauthenticated requests redirect here with `?redirect=<where you were going>`. |
| `/__relay_logout` | Expires the session cookie. Linked from the homepage footer when a password is set. Bookmark it for shared machines. |

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

**Diagnostic panel:** on any proxied page, failures (non-2xx fetch/XHR,
WebSocket errors, resources that failed to load) collapse into a small
top-right button, `relay · N`. It never opens by itself: click to expand.
Inside, the first line (`page: …`) shows the current page's real URL, **Link**
copies a working relay link for it, and **Copy** puts the failure list on the
clipboard without DevTools. Cloudflare's own `/cdn-cgi/` requests and preload
failures are filtered out so they don't inflate N.

Two debugging flags sit at the top of the diagnostic section of the injected
script, both off by default: `RELAY_LOG_NO_LINK` (log clicks on elements with
no `<a>` in their path — these are not failures, only useful when hunting for
link-less navigation escapes) and `RELAY_LOG_NAV` (log every
`pushState`/`replaceState` call as original → proxied).

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
  and `Origin` are corrected to the real site. Relay-wrapped URLs inside an
  upstream query string (a consent manager's `href=<relay>/https://…`) are
  restored to the real URL. Cookies are never forwarded, and upstream
  `Set-Cookie` headers are stripped.
- Timeout, one retry for bodyless requests, `Retry-After`-aware backoff on
  429/503, and a styled error page for Cloudflare edge failures.
- Caching: edge cache for HTML and static assets (GET only), keyed partly on
  the request's `Accept` header with per-status TTLs (`cacheTtlByStatus`);
  Cloudflare's fetch cache; long browser caching for static types. Safe
  because every response is anonymous. Large assets (>20 MB) skip the
  edge-cache copy.
- WebSockets are bridged browser to Worker to target, including subprotocol
  negotiation and the real `Origin`.
- The relay answers `/favicon.ico` and `/robots.txt` at its own root, so
  those bare-origin requests never enter the target-recovery path. A target's
  own `/cdn-cgi/rum` and `/cdn-cgi/speculation` get a 204.
- Narrow search-engine special case: embedded URLs in
  `links.duckduckgo.com` responses are rewritten server-side
  (`SEARCH_DATA_HOSTS`; add other engines only after inspecting their
  payload). Image hosts inside those payloads (`REWRITE_SKIP_HOSTS`) are left
  alone — pre-wrapping them breaks DDG's own image proxy.

**Client side (injected script).** Patches `fetch` (string, `URL` and
`Request` inputs; `Request` bodies are buffered rather than re-streamed), XHR,
`EventSource`, `window.open`, `WebSocket`, `postMessage` (on the window
instance and on iframe windows as they are first touched),
`pushState`/`replaceState` and `form.submit()`; hooks
`setAttribute`/`getAttribute` and the `href`/`src` properties so URLs written
by JS frameworks are proxied at assignment and read back unmodified (this
stops React reverting the rewrite); intercepts clicks and middle-clicks in
the capture phase; blocks the target site's own Service Worker registration.
A `MutationObserver` covers `innerHTML`-inserted content. Each risky patch
is wrapped in its own `try`/`catch` so one failing patch cannot silently
disable the rest.

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

Set it to /^$/ to disable the mode everywhere. Add a host only when it shows
the same symptoms (a client-side crash or dead widgets, with
location.pathname visible in the error); sites that already work should not
be added.

---

Editing and verifying _worker.js

The injected script is a string inside a template literal (in
ScriptInjector), so node --check _worker.js does not validate it. A
syntax error there stops the whole script in the browser while the outer file
still checks clean — this has happened twice: a stray brace (caught
pre-deploy) and the template-escaping bug that shipped from v0.5.0 to
v0.9.0. The injected script contains ${…} placeholders, so check the text
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
new globalThis.__SI('https://relay.test', '/x').element({ prepend: (s) => { out = s; } });
fs.writeFileSync('inj.js', out.replace(/^\s*<script>/, '').replace(/<\/script>\s*$/, ''));
fs.writeFileSync('sw.js', globalThis.__SW);
JS
node --check inj.js
node --check sw.js
```

inj.js is the client script as emitted (with real-path mode on — pass ''
instead of '/x' to check the normal mode), sw.js the relay's Service
Worker script. The Service Worker script is also a template literal and has
the same backslash rule.

Backslash rule: a backslash inside the injected script (and the Service
Worker script) must be written doubled in the source. The template
literal consumes one level: source \/ emits /, which is how /\/ck\/a$/i
became the line comment //ck/a$/i and killed the whole client script from
v0.5.0 until v0.9.0. Evaluating the template, as above, catches a mis-escape
that produces a syntax error. It does not catch one that still parses
but means something else — a missing \\/ once turned "path starts with
/https://" into "starts with /https:/" and passed every syntax check. For
URL logic, run the function on sample inputs (toProxied('/https:/react.dev/')
and friends) or the panel smoke test below, not just --check.

Inside the injected script, read link attributes with
relayNativeGetAttr / write with relayNativeSetAttr. The hooked
getAttribute returns the unwrapped URL, so using it for an "already
proxied" check never matches and causes an infinite rewrite loop.

---

Quick test checklist

1. Homepage loads; footer shows build v0.10.0 · path-embedded.
2. /https://example.com: page renders, link clicks stay on the relay.
3. DuckDuckGo search: result links show the relay prefix on hover and stay on
   the relay when clicked; switching All / Images / Videos / News keeps
   duckduckgo.com embedded in the relay URL; video thumbnails load.
4. https://echo.websocket.org/.ws: connects and echoes (WebSocket bridge).
5. With PASSWORD set: any URL redirects to /__relay_login; a wrong password
   returns to the form with an error and no resubmit prompt; a correct one
   lands on the original destination; /__relay_logout ends the session.
6. Deliberately bad input (/https://gitbub.com) shows a styled error page,
   not Cloudflare's.
7. Panel smoke test (proves the injected script is alive): open a proxied
   page with at least one broken subresource — the top-right shows
   relay · N, it stays collapsed until clicked, and clicking inside it
   doesn't navigate. Copy produces the failure list.
8. Real-path hosts: /https://react.dev stays on the page (no redirect to a
   broken https:/react.dev) and shows / in the address bar; a GitHub repo
   opens its search-filter and "…" menus, and a GitHub search shows the real
   URL in the panel's page: row; /https://www.bbc.com/news renders without
   the "client-side exception" screen. Reload on a non-root real-path page
   lands back on the same site. A host outside the list (for example
   gist.github.com) keeps its embedded address.
9. /https://bbc.com/news ends on www.bbc.com with the address bar matching
   the final URL (redirect-follow check).

---

Limitations

· CAPTCHAs (reCAPTCHA, hCaptcha, Turnstile) generally will not work. They
  validate the page's origin and are designed to detect embedding and proxying,
  which is exactly what a relay is. This is not fixed and a general fix is not
  expected. The diagnostic panel will show which requests fail.
· No session cookies are forwarded, so logging into sites does not work
  and logged-in-only content renders as signed out. Upstream Set-Cookie
  headers are stripped too, so nothing accumulates on the relay's own origin
  either. (The one exception is the relay's own __relay_ctx cookie in
  real-path mode, which is never sent upstream.)
· POST forms are not proxied (they submit straight to the real site).
  fetch/XHR POSTs are proxied.
· Target sites can block Cloudflare's IP ranges (some anti-bot systems do).
  No code change can fix that; the diagnostic panel shows the status codes.
· Free-plan WebSocket idle timeout is 100 s. An idle game or chat
  connection can drop. A keepalive was deliberately not added: it would inject
  unexpected messages into the real application protocol.
· All proxied sites share the relay origin, so their
  localStorage/sessionStorage can collide. Per-target storage isolation
  is deliberately deferred.
· Real-path mode trade-offs. The address bar on those hosts carries no
  target host, so a copied bar URL does not work (use the panel's Link
  button). The __relay_ctx cookie is shared between tabs, so reloading an
  older real-path tab after opening a different real-path site in another tab
  can land on the wrong site. Reloading a site's root page (/) lands on the
  relay homepage. Sites that read their origin or full URL, not just the path,
  can still misbehave.
· Some sites cannot work at all under path embedding and are not fixed by
  the above: anything that needs a first-party session, validates its own
  origin (consent and anti-bot SDKs often do), or loads origin-locked
  resources.
· Attribute hooks match lowercase names only (getAttribute("HREF") is not
  intercepted).
· postMessage target origins are widened to *, trading the page author's
  origin check for cross-frame messages that work under the relay.
· The password gate has no rate limiting, a non-timing-safe comparison, and
  recomputes the password hash on every request. The Secure session cookie
  loops the login on plain-HTTP local development. It keeps casual visitors
  and crawlers out; it is not hardened access control.
· This is an open relay for anyone with the URL unless PASSWORD is set.
  Consider a target allow-list and rate limiting before exposing it publicly.

```
