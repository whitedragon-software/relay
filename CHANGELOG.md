# Changelog

## 0.9.0

### Added
- Stale-link sweep through native accessors: the sweep that catches links
  inserted past the hooks (`innerHTML` and friends) now reads and writes
  attributes through `relayNativeGetAttr`/`relayNativeSetAttr` — the old
  path went through the hooked getters, which return the unwrapped original
  URL and defeat the "already proxied" check.
- `duplex: 'half'` in the patched client `fetch`, so requests with streamed
  bodies are legal in the browser (they throw without it).
- Per-status edge-cache TTLs (`cacheTtlByStatus`) instead of one blanket
  value for every status.
- The edge-cache key derives partly from the request's `Accept` header, so
  content-negotiated responses — navigation vs. script vs. image requests
  for the same URL — no longer collide in the cache.
- Upstream `Set-Cookie` headers are stripped: previously a target could
  plant cookies scoped to the relay's own origin, where they would ride
  along on later requests and break the anonymous-response assumption the
  shared edge cache depends on.
- XHTML documents (`application/xhtml+xml`) go through `HTMLRewriter` too,
  not just `text/html`.
- `/favicon.ico` and `/robots.txt` are answered at the relay's own root, so
  those bare-origin requests never enter the target-recovery path.

### Changed
- Panel redesign: failures collapse into a small top-right button,
  `relay · N`, that never opens itself — click to expand, Copy inside.
  Cloudflare's own `/cdn-cgi/` requests and preload failures are filtered
  out so they don't inflate N; clicks on the panel and on form controls are
  exempt from link interception; duplicate NO_LINK entries are deduplicated.
- Version markers renamed to version tags: the homepage footer reads
  `build v0.9.0 · path-embedded` and the panel header
  `relay v0.9.0 — failed requests` (previously build markers such as
  `B11-AUTHFIX`).

### Fixed
- The injected client script now actually runs. Since 0.5.0, every regex in
  the injected-script template literal was single-escaped; a template
  literal consumes one level of backslashes, so the Bing tracking-redirect
  pattern `/\/ck\/a$/i` reached the browser as `//ck/a$/i` — a line
  comment, i.e. a syntax error — and one syntax error kills the entire
  script. Every client-side patch and the diagnostic panel were inert from
  0.5.0 through 0.8.0; browsing kept working the whole time because the
  load-bearing layers (`HTMLRewriter`, `<base>`, Referer recovery, the
  WebSocket bridge) are server-side, which is also why the panel header
  marker never rendered. All template regexes are now double-escaped;
  backslashes inside the injected script must always be written doubled.

## 0.8.0

### Added
- Clean login URL: unauthenticated requests redirect to
  `/__relay_login?redirect=…` instead of rendering the login form at
  whatever URL was requested.
- Logout: `/__relay_logout` expires the session cookie and returns to the
  login page; a "log out" link appears in the homepage footer when
  `PASSWORD` is set — intended for shared or public machines.

### Changed
- A wrong password redirects back to the login page (POST-redirect-GET), so
  refreshing no longer triggers the browser's "resend form data" warning.

### Fixed
- Open redirect in the login flow: the `redirect` parameter is
  user-controlled and was appended to the relay's origin directly —
  `@evil.com` parses as userinfo (host becomes `evil.com`) and `.evil.com`
  as a subdomain of the relay, so a crafted login link could send someone
  off-site after a correct password. `safeRedirectPath()` now requires a
  single leading `/`. 0.7.0 shipped with this hole; upgrade if it's
  deployed.
- DuckDuckGo tab switching lost the embedded domain (All → Images produced
  `relay/?ia=images&q=…` with no `duckduckgo.com`): DDG ships
  `<meta name="referrer" content="origin">`, which reduces the browser's
  `Referer` to the bare origin, but the server-side recovery that rebuilds
  a lost target needs the full path. `MetaReferrerRewriter` now forces
  `unsafe-url` on `meta[name=referrer]` and
  `meta[http-equiv=Referrer-Policy]` — no new exposure, since every request
  already passes through the worker and browser-to-relay is same-origin.

## 0.7.0

### Added
- Password protection: set a `PASSWORD` secret and the whole relay
  (homepage, proxying, WebSockets, everything) sits behind a login screen.
  A correct password sets a session cookie holding a SHA-256 hash of the
  password — not the password itself — `HttpOnly; Secure; SameSite=Lax`,
  30 days. The gate runs first in `fetch()`, before WebSocket upgrades, the
  Service Worker script and everything else. Unset, the relay behaves
  exactly as before. The login page is a lean template with dark mode via
  `prefers-color-scheme`.

## 0.6.0

### Changed
- Dropped a per-call `toLowerCase()` allocation from the
  `getAttribute`/`setAttribute` hooks — those fire on every attribute
  access on the page, not just `href`/`src`. Trade-off: uppercase names
  such as `getAttribute("HREF")` are no longer intercepted; React, JSX and
  normal DOM code use lowercase.
- Removed the `mouseover` re-assertion handler; it only existed to win a
  race against React reverting a rewrite, which the 0.5.0 property hooks
  made unnecessary.
- `MutationObserver` watches `childList` only: attribute writes are caught
  at the source by the hooks, while `innerHTML`-inserted content still
  needs `childList`.
- About 29 lines shorter overall.

## 0.5.0

### Added
- Preemptive URL interception: hooks on
  `Element.prototype.setAttribute`/`getAttribute` and on the
  `href`/`src`/`action`/`data` property descriptors of anchors, areas,
  scripts, images, links, iframes, video, audio, sources, objects and
  forms. Writes are converted to proxied form at the moment of assignment —
  the raw URL never lands in the DOM, so hover previews and framework
  diffs see nothing to leak — and reads return the original URL, so
  frameworks like React find no mismatch and stop reverting the rewrite.
  This ended the earlier reactive arms race (observer, polling, hover
  re-assertion), which could only race a revert loop. Technique taken from
  a reference implementation (cf-proxy-ex) — only the technique, not its
  location string-replacement, cookie handling, password page or
  `document.write`.
- Client-side patch suite: `EventSource`, `window.open`, `postMessage`
  (target origin widened to `*`), `pushState`/`replaceState` with `<base>`
  kept in sync, `form.submit()`, blocking the target site's own Service
  Worker registration, `navigator.onLine` forced true. Every
  native-prototype reassignment is wrapped in its own `try`/`catch` so one
  failing patch cannot disable the rest. (`fetch`/XHR date to 0.3.0.)
- Click interception in the capture phase with
  `stopImmediatePropagation`, `composedPath()` for Shadow DOM,
  `aria-haspopup` as the only skip signal (`aria-expanded` and
  `role="button"` were tried and removed — both are common on real
  navigating links), middle-click via `auxclick`, and `target="_blank"`
  routed through the patched `window.open`.
- WebSocket bridge: `WebSocketPair` connects browser → Worker → target with
  subprotocol negotiation and the real `Origin`; a client-side `WebSocket`
  patch recovers URLs built from `location.origin`.
- Bare-origin recovery: requests that reach the relay origin with no target
  in the path are repaired server-side from the `Referer`; a small
  relay-owned Service Worker is the backstop for escapes the repair misses.
- Tracking-redirect decoding — Google `/url?q=`, Bing `/ck/a`, DuckDuckGo
  `/l/?uddg=` — on both server and client.
- Search-engine data rewriting: `SEARCH_DATA_HOSTS` (currently only
  `links.duckduckgo.com`) — embedded URLs in that host's response bodies
  are rewritten server-side, including JSON-escaped (`\/`) forms, before
  the page's JS parses them. Deliberately narrow; a general "rewrite URLs
  in any JS response" rule would risk corrupting application bundles, and
  it is excluded from the long-cache path since results are
  query-specific.
- Upstream fidelity: headers are forwarded on a denylist basis (custom API
  headers such as DDG's `x-vqd-4` survive), `Referer` and `Origin` are
  corrected to the real target, and the visitor's real `User-Agent` is
  forwarded.
- Resilience: per-request timeout, one retry for bodyless requests,
  `Retry-After`-aware backoff on 429/503, and Cloudflare edge-error
  detection (520–527, 530) with a styled page instead of passing
  Cloudflare's own through.
- UI: light/dark homepage, styled error pages, and the on-page diagnostic
  panel (failed fetch/XHR/WebSocket/resource loads, clicks with no link in
  their path — copyable without DevTools).

### Fixed
- Infinite rewrite loop: our own `relayRewriteElement` and click handler
  now read the raw stored value through the native accessors — with the
  hooks installed, the hooked getter returns the unwrapped original, which
  defeats the "already proxied" check (reproduced in a test).
- A stray `}, true);` left by a refactor — a syntax error in the injected
  script that would have stopped the entire script from running.
  `node --check` on the worker file cannot catch this because the injected
  script is a string inside a template literal; verification now extracts
  it and checks it separately.

## 0.4.0

### Added
- Media and embedding coverage: media elements, embeds, objects and
  `srcset` rewritten alongside the core tag set.
- `realBase()`, centralizing reconstruction of the real target base URL for
  the rewriting and recovery paths.
- Static-asset caching refinements: long browser-side `Cache-Control` for
  static types; assets over 20 MB skip the edge-cache copy.
- Safety limits: self-referential targets (the relay proxying itself) are
  refused, and target URLs are capped at 8000 characters.

### Changed
- Path-embedded URLs: the target moved out of the query string into the
  path (`/https://example.com/page`), so the browser's native relative-URL
  resolution works inside files the relay never parses — ES module imports,
  webpack chunks, CSS `url()`. Legacy `?url=` links 301 to the canonical
  form.

## 0.3.0

### Added
- `BaseTagInjector`: injects a `<base>` element so relative URLs inside the
  page resolve inside the relay's URL space instead of collapsing onto the
  relay origin.
- `FormRewriter`: GET forms stash the real action in `data-proxy-target` —
  native GET submission discards the action's own query string — and
  reassemble it at submit time.
- First client-side patches: `fetch` and `XMLHttpRequest` are wrapped so
  dynamically requested URLs go through the relay instead of escaping to
  the real origin.

## 0.2.0

### Added
- Edge caching: GET requests for HTML and static assets are cached at the
  edge, plus Cloudflare's fetch-layer cache. Safe because responses are
  anonymous — no cookies are forwarded.

### Changed
- `HTMLRewriter` instead of regex: per-element selectors replace string
  surgery, so rewriting survives odd formatting, comments and attribute
  orders that break regexes, and runs as a stream — the browser starts
  painting before the upstream response finishes. Coverage at this point:
  anchors, images, scripts, stylesheets, iframes.

## 0.1.0

### Added
- Initial release: a single-file Cloudflare Worker that proxies web pages
  through your own domain — links inside the page rewritten to keep
  browsing on the relay. No build step, no dependencies; the free tier is
  enough.
- `?url=` query scheme:
  `https://relay.<username>.workers.dev/?url=https://example.com/page`.
- Regex-based HTML rewriting: anchors and embedded resources rewritten by
  pattern matching (replaced by `HTMLRewriter` in 0.2.0).
- Upstream `Location` headers on 3xx responses rewritten so redirect hops
  stay inside the relay.
- Homepage with an address field; the real request method and body
  forwarded.
