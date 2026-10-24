# Changelog

## Unreleased

### Added
- Debug mode: visit `/__relay_debug` on the relay (`?on=0` to turn it off)
  to set a 24-hour cookie that turns on verbose diagnostics in the injected
  script, so phones don't need a code edit. It enables `NO_LINK` and
  `pushState`/`replaceState` logging, records every navigation through the
  Navigation API — including `location.href = …` assignments that nothing
  can intercept (Chromium; absent in some Safari versions) — notes page
  unloads, keeps the button visible from page load, and mirrors the log into
  `sessionStorage`, so the panel still shows what happened on the previous
  page after a page jumps away.
- In debug mode, failed `fetch`/XHR entries include the first 200 characters
  of the response body, so bot-protection responses identify themselves (for
  example the `418` challenge type from duck.ai's chat endpoint).
- Referer and Origin restoration for real-path-mode pages: their `Referer` is
  a bare relay path, so the real origin from the `__relay_ctx` cookie is
  paired with it (`resolvePageContext`).

### Changed
- Upstream `Origin` is now the visiting page's real origin when it can be
  determined (embedded `Referer`, or the cookie for real-path pages), instead
  of always the request target's own origin. Browsers send the page's origin
  on cross-origin requests, and media CDNs and CORS allow-lists check it; the
  target's own origin remains the fallback when the page is unknown.
- Query unwrapping (`stripProxyFromQuery`) handles real-path pages: a relay
  origin left in an upstream query string after the wrapper is removed — the
  page's URL was a bare real path (`href=<relay>/news`) — is replaced with
  the page's real origin instead of being stripped to a meaningless
  `href=news`.
- Range requests and HLS/DASH manifests (`.m3u8`, `.mpd`) bypass the blanket
  edge cache (`cacheEverything`).

### Fixed
- BBC consent `400` persisted in real-path mode: with the address bar showing
  `/news`, the consent SDK's `href=https://relay…/news` was stripped to
  `href=news`; it now arrives as `href=https://www.bbc.com/news`.
- Video that would not play: live HLS/DASH playlists were edge-cached for 120
  seconds (stale within seconds), partial-content requests went through the
  cache, and hotlink-protected media CDNs received no `Referer` (real-path
  pages) and the CDN's own origin as `Origin`.

## v0.10.0

### Added
- Real-path mode (experimental) for hosts whose client-side routers read
  `location.pathname` — Next.js, React Router, GitHub's React apps. Under
  the path-embedded scheme they see `/https://host/page` instead of
  `/page`, fail to match their routes, and either crash (BBC: `Cannot
  destructure property 'title'`, React error #423), hard-navigate to a
  collapsed `/https:/host` (react.dev) or leave widgets inert (GitHub's
  filter and "…" menus). For hosts in `REAL_PATH_HOSTS` — `bbc.com`,
  `bbc.co.uk`, `github.com`, `react.dev`, each with or without `www.`,
  exact hostnames only (`gist.github.com` is not included) — the injected
  script rewrites the address bar to the real path right after load.
  Loading is unaffected: relative URLs resolve through `<base>`, not the
  address bar. `pushState`/`replaceState`/`popstate` keep real paths in the
  bar with `<base>` in sync (`relayAddressUrl`), and `realBase()` falls back
  to the real URL captured at startup while `<base>` is not yet parsed.
  Trade-off: the address bar no longer carries the target host, so copied
  bar URLs don't work — use the panel's Link button. Set `REAL_PATH_HOSTS`
  to `/^$/` to disable the mode.
- Reload recovery for real-path mode: those pages leave a one-day
  `__relay_ctx` cookie holding the real origin. It is set client-side, so
  it also covers edge-cache hits, and is never forwarded upstream. A
  browser-initiated navigation (`Sec-Fetch-Site: none`) to a bare path is
  redirected to the cookie's origin before any `Referer` logic runs — its
  `Referer` is stale — and bare requests whose `Referer` can't place them
  fall back to it. The bare homepage and bare-domain input
  (`/example.com`, `looksLikeBareDomain()`) are exempt. Known limits: the
  cookie is shared between tabs, and reloading a site's root (`/`) lands
  on the relay homepage.
- Panel additions: a `page:` row showing the current real URL, and a Link
  button that copies a working relay link for it. In real-path mode the
  `relay` button is present from page load rather than after the first
  failure.
- Diagnostic flags in the injected script, both off by default:
  `RELAY_LOG_NO_LINK` and `RELAY_LOG_NAV` (logs every
  `pushState`/`replaceState` as original → proxied).
- Navigations that followed an upstream redirect (`bbc.com` →
  `www.bbc.com`) are answered with a 302 to the final proxied URL, so the
  address bar matches the `<base>` the page gets — previously page JS that
  read `location.pathname` and fed it back produced
  `/https://www.bbc.com/https://bbc.com/news`. Navigations only
  (`Sec-Fetch-Mode: navigate`); fetch/XHR follow redirects natively.
- Collapsed-path repair: some routers (Next.js) collapse `//` in paths,
  turning `/https://host/x` into `/https:/host/x`. The Worker and the
  relay's Service Worker now 302 that back to the double-slash form.
- Query unwrapping (`stripProxyFromQuery`): relay-wrapped URLs inside an
  upstream query string — consent managers send
  `href=<relay>/https://www.bbc.com/news` — are restored to the real URL
  before forwarding. Upstream servers rejected the relay-wrapped form with
  a 400.
- Target-side `/cdn-cgi/rum` and `/cdn-cgi/speculation` requests are
  answered with a 204 instead of producing 404/405 noise.
- `iframe.contentWindow` is patched on first access, so `postMessage` is
  widened inside same-origin frames the page creates itself (blank frames
  never run the injected script).

### Changed
- Client `toProxied` recognises a root-relative path that is already a
  proxy path (`/https://host/…`, or the collapsed `/https:/host/…`) and
  keeps it as one, instead of resolving it against the real site. Pages
  that fed `location.pathname` back into history/URL APIs doubled the
  embedded target (`/https://react.dev/https:/react.dev`).
- Patched `fetch` handles string, `URL` and `Request` inputs and is
  promise-based. `Request` bodies are now buffered (`arrayBuffer()`) and
  the abort `signal` is carried over, replacing v0.9.0's streamed body with
  `duplex: 'half'`: streamed uploads need HTTP/2 and fail outright on any
  redirect, which surfaced as `Failed to fetch` on YouTube's POSTs.
- XHR `open` and `EventSource` coerce their URL argument with `String()`,
  so `URL` objects are proxied instead of bypassing the relay.
- GET form submission resolves its target through a
  `toProxied`/`fromProxied` round trip, so JS-created forms with a
  root-relative `action` no longer resolve to the relay's own origin
  ("Refusing to proxy itself").
- `NO_LINK` entries are no longer logged by default: clicks on non-anchor
  elements are not failures and were inflating N. Set `RELAY_LOG_NO_LINK`
  to bring them back when hunting for link-less navigation escapes.
- Version markers: the homepage footer reads `build v0.10.0 ·
  path-embedded` and the panel header `relay v0.10.0 — failed requests`.
  Changelog headings and in-text version references now carry the `v`
  prefix.

### Fixed
- `<img src="">` resolved to the page itself and was requested as an image
  (`LOAD_ERR IMG https://www.youtube.com/`); `resolveAndProxy` now skips
  empty values.
- The `postMessage` patch never took effect: on a window, `postMessage` is
  an own property, not a member of `Window.prototype`, so the prototype
  check was always false and `targetOrigin` errors continued (BBC's
  consent frames). It is now patched on the window instance, and the
  options-object form (`{ targetOrigin }`) is handled.
- DuckDuckGo video thumbnails (`iuv/?u=…`) failing: `rewriteEmbeddedUrls`
  wrapped the inner Bing thumbnail URLs in the search payload, then DDG's
  own code wrapped them again in its image proxy, which cannot fetch a
  relay URL. Image hosts (`REWRITE_SKIP_HOSTS`: `*.mm.bing.net`,
  `external-content.duckduckgo.com`) are now left alone and proxied by the
  client attribute hooks instead.
- `fetch(new Request(url, { body }))` failed with `Failed to fetch` (see
  Changed), and `fetch(new URL(…))` bypassed the relay entirely.

## v0.9.0

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
- The injected client script now actually runs. Since v0.5.0, every regex in
  the injected-script template literal was single-escaped; a template
  literal consumes one level of backslashes, so the Bing tracking-redirect
  pattern `/\/ck\/a$/i` reached the browser as `//ck/a$/i` — a line
  comment, i.e. a syntax error — and one syntax error kills the entire
  script. Every client-side patch and the diagnostic panel were inert from
  v0.5.0 through v0.8.0; browsing kept working the whole time because the
  load-bearing layers (`HTMLRewriter`, `<base>`, Referer recovery, the
  WebSocket bridge) are server-side, which is also why the panel header
  marker never rendered. All template regexes are now double-escaped;
  backslashes inside the injected script must always be written doubled.

## v0.8.0

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
  single leading `/`. v0.7.0 shipped with this hole; upgrade if it's
  deployed.
- DuckDuckGo tab switching lost the embedded domain (All → Images produced
  `relay/?ia=images&q=…` with no `duckduckgo.com`): DDG ships
  `<meta name="referrer" content="origin">`, which reduces the browser's
  `Referer` to the bare origin, but the server-side recovery that rebuilds
  a lost target needs the full path. `MetaReferrerRewriter` now forces
  `unsafe-url` on `meta[name=referrer]` and
  `meta[http-equiv=Referrer-Policy]` — no new exposure, since every request
  already passes through the worker and browser-to-relay is same-origin.

## v0.7.0

### Added
- Password protection: set a `PASSWORD` secret and the whole relay
  (homepage, proxying, WebSockets, everything) sits behind a login screen.
  A correct password sets a session cookie holding a SHA-256 hash of the
  password — not the password itself — `HttpOnly; Secure; SameSite=Lax`,
  30 days. The gate runs first in `fetch()`, before WebSocket upgrades, the
  Service Worker script and everything else. Unset, the relay behaves
  exactly as before. The login page is a lean template with dark mode via
  `prefers-color-scheme`.

## v0.6.0

### Changed
- Dropped a per-call `toLowerCase()` allocation from the
  `getAttribute`/`setAttribute` hooks — those fire on every attribute
  access on the page, not just `href`/`src`. Trade-off: uppercase names
  such as `getAttribute("HREF")` are no longer intercepted; React, JSX and
  normal DOM code use lowercase.
- Removed the `mouseover` re-assertion handler; it only existed to win a
  race against React reverting a rewrite, which the v0.5.0 property hooks
  made unnecessary.
- `MutationObserver` watches `childList` only: attribute writes are caught
  at the source by the hooks, while `innerHTML`-inserted content still
  needs `childList`.
- About 29 lines shorter overall.

## v0.5.0

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
  failing patch cannot disable the rest. (`fetch`/XHR date to v0.3.0.)
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

## v0.4.0

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

## v0.3.0

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

## v0.2.0

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

## v0.1.0

### Added
- Initial release: a single-file Cloudflare Worker that proxies web pages
  through your own domain — links inside the page rewritten to keep
  browsing on the relay. No build step, no dependencies; the free tier is
  enough.
- `?url=` query scheme:
  `https://relay.<username>.workers.dev/?url=https://example.com/page`.
- Regex-based HTML rewriting: anchors and embedded resources rewritten by
  pattern matching (replaced by `HTMLRewriter` in v0.2.0).
- Upstream `Location` headers on 3xx responses rewritten so redirect hops
  stay inside the relay.
- Homepage with an address field; the real request method and body
  forwarded.
