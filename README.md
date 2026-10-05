# Relay

A single-file Cloudflare Worker that proxies web pages through your own
domain: links, forms, scripts, WebSockets and client-side navigation stay on
the relay instead of escaping to the real site.

```
https://your-relay.workers.dev/https://example.com/page?x=1
```

- `relay.js`: the Worker. Deploy this file as-is; no build step, no dependencies.
- `CHANGELOG.md`: what changed in each build, and what is still unconfirmed.
- `DEVLOG.md`: session-by-session narrative, including dead ends.

---

## Deploy

```
wrangler deploy relay.js
```

or paste the file into the Worker editor in the Cloudflare dashboard. The free
tier is enough.

### Optional: password protection

Set a `PASSWORD` secret and the whole relay (homepage, proxying, WebSockets,
everything) requires it:

```
wrangler secret put PASSWORD
```

(or add `PASSWORD` as an environment variable in the dashboard). **Unset, the
relay behaves exactly as before.**

| Path | Purpose |
|---|---|
| `/__relay_login` | Login form. Unauthenticated requests redirect here with `?redirect=<where you were going>`. |
| `/__relay_logout` | Expires the session cookie. Linked from the homepage footer when a password is set. Bookmark it for shared machines. |

The session cookie holds a SHA-256 hash of the password (not the password),
`HttpOnly; Secure; SameSite=Lax`, 30 days. See *Limitations* for what this
does and doesn't protect against.

---

## Using it

Open the relay's URL, enter an address, and browse normally. Bare domains work
too (`/example.com` assumes `https://`). Old `?url=` links redirect to the
canonical form.

**Which build is live:** the homepage footer and the diagnostic panel header
both show a build marker such as `B11-AUTHFIX`. If it isn't the one you
expect, you are testing an old deploy.

**Diagnostic panel:** a small panel appears bottom-right on any proxied page
when something fails (non-2xx fetch/XHR, WebSocket errors, resources that
failed to load, clicks with no link in their path). It has a Copy button, so
you can paste failures without opening DevTools.

---

## How it works

**URL scheme.** The target lives in the path, not a query string, so the
browser's native relative-URL resolution (ES module imports, webpack chunks,
CSS `url()`) works inside files the relay never parses.

**Server side.**
- `HTMLRewriter` rewrites links, images, scripts, stylesheets, iframes, media,
  `srcset`, `<meta http-equiv="refresh">` and forms. A forced permissive
  referrer policy keeps the recovery below working on sites that restrict it.
- Requests that reach the bare origin with no target (root-relative escapes)
  are repaired from the `Referer`; a Service Worker is a backstop.
- Real method, body and headers are forwarded (a denylist, so custom API
  headers survive). The visitor's real `User-Agent` is forwarded. `Referer`
  and `Origin` are corrected to the real site. Cookies are never forwarded.
- Timeout, one retry for bodyless requests, `Retry-After`-aware backoff on
  429/503, and a styled error page for Cloudflare edge failures.
- Caching: edge cache for HTML and static assets (GET only), Cloudflare's
  fetch cache, long browser caching for static types. Safe because every
  response is anonymous (no cookies forwarded). Large assets (>20 MB) skip the
  edge-cache copy.
- WebSockets are bridged browser to Worker to target, including subprotocol
  negotiation and the real `Origin`.
- Narrow search-engine special case: embedded URLs in
  `links.duckduckgo.com` responses are rewritten server-side
  (`SEARCH_DATA_HOSTS`; add other engines only after inspecting their payload).

**Client side (injected script).** Patches `fetch`, XHR, `EventSource`,
`window.open`, `WebSocket`, `postMessage`, `pushState`/`replaceState` and
`form.submit()`; hooks `setAttribute`/`getAttribute` and the `href`/`src`
properties so URLs written by JS frameworks are proxied at assignment and read
back unmodified (this stops React reverting the rewrite); intercepts clicks and
middle-clicks in the capture phase; blocks the target site's own Service Worker
registration. A `MutationObserver` covers `innerHTML`-inserted content.
Each risky patch is wrapped in its own `try`/`catch` so one failing patch
cannot silently disable the rest.

---

## Editing and verifying `relay.js`

The injected script is a string inside a template literal, so
**`node --check relay.js` does not validate it.** A syntax error there stops
the whole script from running in the browser while the outer file still
checks clean (this happened once). Always run both:

```
node --check relay.js

python3 - << 'PY'
import re
src = open('relay.js').read()
m = re.search(r"el\.prepend\(\s*`\s*<script>(.*?)</script>\s*`,", src, re.DOTALL)
open('inj.js', 'w').write(m.group(1))
PY
node --check inj.js
```

Inside the injected script, read link attributes with
`relayNativeGetAttr` / write with `relayNativeSetAttr`. The hooked
`getAttribute` returns the *unwrapped* URL, so using it for an "already
proxied" check never matches and causes an infinite rewrite loop.

---

## Quick test checklist

1. Homepage loads; footer shows the expected build marker.
2. `/https://example.com`: page renders, link clicks stay on the relay.
3. DuckDuckGo search: result links show the relay prefix on hover and stay on
   the relay when clicked; switching All / Images / Videos / News keeps
   `https://duckduckgo.com` in the address bar.
4. `https://echo.websocket.org/.ws`: connects and echoes (WebSocket bridge).
5. With `PASSWORD` set: any URL redirects to `/__relay_login`; a wrong password
   returns to the form with an error and no resubmit prompt; a correct one
   lands on the original destination; `/__relay_logout` ends the session.
6. Deliberately bad input (`/https://gitbub.com`) shows a styled error page,
   not Cloudflare's.

---

## Limitations

- **CAPTCHAs (reCAPTCHA, hCaptcha, Turnstile) generally will not work.** They
  validate the page's origin and are designed to detect embedding and proxying,
  which is exactly what a relay is. This is not fixed and a general fix is not
  expected. The diagnostic panel will show which requests fail.
- **No session cookies are forwarded**, so logging into sites does not work
  and logged-in-only content renders as signed out.
- **POST forms are not proxied** (they submit straight to the real site).
  `fetch`/XHR POSTs *are* proxied.
- **Target sites can block Cloudflare's IP ranges** (some anti-bot systems do).
  No code change can fix that; the diagnostic panel shows the status codes.
- **Free-plan WebSocket idle timeout is 100 s.** An idle game or chat
  connection can drop. A keepalive was deliberately not added: it would inject
  unexpected messages into the real application protocol.
- Attribute hooks match lowercase names only (`getAttribute("HREF")` is not
  intercepted).
- `postMessage` target origins are widened to `*`, trading the page author's
  origin check for cross-frame messages that work under the relay.
- The password gate has no rate limiting and a non-timing-safe comparison.
  It keeps casual visitors and crawlers out; it is not hardened access control.
- Unconfirmed on live sites (tested in isolation only): the DuckDuckGo tab
  navigation fix (B11) and DuckDuckGo result links no longer escaping (B8).
  See `CHANGELOG.md`.
- This is an open relay for anyone with the URL unless `PASSWORD` is set.
  Consider a target allow-list and rate limiting before exposing it publicly.
