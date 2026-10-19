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

---

## Using it

Open `https://relay.<username>.workers.dev/`, enter an address, and browse
normally. Bare domains work too (`/example.com` assumes `https://`). Old
`?url=` links redirect to the canonical form.

**Which version is live:** the homepage footer shows `build v0.9.0 ·
path-embedded`, and the diagnostic panel header shows `relay v0.9.0 — failed
requests`. (Before v0.9.0 the panel header never actually rendered — the
injected script was syntactically dead from v0.5.0 to v0.8.0; see
`CHANGELOG.md`.) If you don't see v0.9.0, you're testing an old deploy.

**Diagnostic panel:** on any proxied page, failures (non-2xx fetch/XHR,
WebSocket errors, resources that failed to load, clicks with no link in their
path) collapse into a small top-right button, `relay · N`. It never opens by
itself: click to expand, and use the Copy button inside to paste failures
without DevTools. Cloudflare's own `/cdn-cgi/` requests and preload failures
are filtered out so they don't inflate N.

---

## How it works

**URL scheme.** The target lives in the path, not a query string, so the
browser's native relative-URL resolution (ES module imports, webpack chunks,
CSS `url()`) works inside files the relay never parses.

**Server side.**
- `HTMLRewriter` rewrites links, images, scripts, stylesheets, iframes, media,
  `srcset`, `<meta http-equiv="refresh">` and forms, in `text/html` and XHTML
  documents alike. A forced permissive referrer policy keeps the recovery
  below working on sites that restrict it.
- Requests that reach the bare origin with no target (root-relative escapes)
  are repaired from the `Referer`; a Service Worker is a backstop.
- Real method, body and headers are forwarded (a denylist, so custom API
  headers survive). The visitor's real `User-Agent` is forwarded. `Referer`
  and `Origin` are corrected to the real site. Cookies are never forwarded,
  and upstream `Set-Cookie` headers are stripped.
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
  those bare-origin requests never enter the target-recovery path.
- Narrow search-engine special case: embedded URLs in
  `links.duckduckgo.com` responses are rewritten server-side
  (`SEARCH_DATA_HOSTS`; add other engines only after inspecting their payload).

**Client side (injected script).** Patches `fetch` (with `duplex: 'half'` for
streamed bodies), XHR, `EventSource`, `window.open`, `WebSocket`,
`postMessage`, `pushState`/`replaceState` and `form.submit()`; hooks
`setAttribute`/`getAttribute` and the `href`/`src` properties so URLs written
by JS frameworks are proxied at assignment and read back unmodified (this
stops React reverting the rewrite); intercepts clicks and middle-clicks in
the capture phase; blocks the target site's own Service Worker registration.
A `MutationObserver` covers `innerHTML`-inserted content. Each risky patch
is wrapped in its own `try`/`catch` so one failing patch cannot silently
disable the rest.

---

## Editing and verifying `_worker.js`

The injected script is a string inside a template literal (in
`ScriptInjector`), so **`node --check _worker.js` does not validate it.** A
syntax error there stops the whole script in the browser while the outer file
still checks clean — this has happened twice: a stray brace (caught
pre-deploy) and the template-escaping bug that shipped from v0.5.0 to
v0.9.0. Run all three checks:

```
node --check _worker.js

python3 - << 'PY'
import re
src = open('_worker.js').read()
i = src.index('ScriptInjector')   # anchor where the injected script lives
m = re.search(r'<script>(.*?)</script>', src[i:], re.DOTALL)
open('inj.js', 'w').write(m.group(1))
PY
node --check inj.js
```

(Adjust the anchor if the template moves — what matters is syntax-checking
the script text itself.)

**Backslash rule:** a backslash inside the injected script must be written
**doubled** in the source. The template literal consumes one level: source
`\/` emits `/`, which is how `/\/ck\/a$/i` became the line comment
`//ck/a$/i` and killed the whole client script from v0.5.0 until v0.9.0. The
extraction above checks the *source text*, so it cannot catch this — the
panel smoke test in the checklist can.

Inside the injected script, read link attributes with
`relayNativeGetAttr` / write with `relayNativeSetAttr`. The hooked
`getAttribute` returns the *unwrapped* URL, so using it for an "already
proxied" check never matches and causes an infinite rewrite loop.

---

## Quick test checklist

1. Homepage loads; footer shows `build v0.9.0 · path-embedded`.
2. `/https://example.com`: page renders, link clicks stay on the relay.
3. DuckDuckGo search: result links show the relay prefix on hover and stay on
   the relay when clicked; switching All / Images / Videos / News keeps
   `duckduckgo.com` embedded in the relay URL.
4. `https://echo.websocket.org/.ws`: connects and echoes (WebSocket bridge).
5. With `PASSWORD` set: any URL redirects to `/__relay_login`; a wrong password
   returns to the form with an error and no resubmit prompt; a correct one
   lands on the original destination; `/__relay_logout` ends the session.
6. Deliberately bad input (`/https://gitbub.com`) shows a styled error page,
   not Cloudflare's.
7. Panel smoke test (proves the injected script is alive): open a proxied
   page with at least one broken subresource — the top-right shows
   `relay · N`, it stays collapsed until clicked, and clicking inside it
   doesn't navigate. Copy produces the failure list.

---

## Limitations

- **CAPTCHAs (reCAPTCHA, hCaptcha, Turnstile) generally will not work.** They
  validate the page's origin and are designed to detect embedding and proxying,
  which is exactly what a relay is. This is not fixed and a general fix is not
  expected. The diagnostic panel will show which requests fail.
- **No session cookies are forwarded**, so logging into sites does not work
  and logged-in-only content renders as signed out. Upstream `Set-Cookie`
  headers are stripped too, so nothing accumulates on the relay's own origin
  either.
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
- Attribute hooks match lowercase names only (`getAttribute("HREF")` is not
  intercepted).
- `postMessage` target origins are widened to `*`, trading the page author's
  origin check for cross-frame messages that work under the relay.
- The password gate has no rate limiting, a non-timing-safe comparison, and
  recomputes the password hash on every request. The `Secure` session cookie
  loops the login on plain-HTTP local development. It keeps casual visitors
  and crawlers out; it is not hardened access control.
- This is an open relay for anyone with the URL unless `PASSWORD` is set.
  Consider a target allow-list and rate limiting before exposing it publicly.
