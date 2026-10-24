# Changelog

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
- Referer and Origin restoration for real-path-mode pages: their `Referer` is
  a bare relay path, so the real origin from the `__relay_ctx` cookie is
  paired with it (`resolvePageContext`).
- Panel additions: a `page:` row showing the current real URL, and a Link
  button that copies a working relay link for it. In real-path mode the
  `relay` button is present from page load rather than after the first
  failure.
- Diagnostic flags in the injected script, both off by default:
  `RELAY_LOG_NO_LINK` and `RELAY_LOG_NAV` (logs every
  `pushState`/`replaceState` as original → proxied). Debug mode (next entry)
  switches both on.
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
  a 400. On real-path pages the address bar is a bare path, so the consent
  SDK sends `href=<relay>/news`; a relay origin left after the wrapper is
  removed is replaced with the page's real origin (from the embedded
  `Referer`, or the `__relay_ctx` cookie) instead of being stripped to a
  meaningless `href=news`.
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
- Upstream `Origin` is now the visiting page's real origin when it can be
  determined (embedded `Referer`, or the cookie for real-path pages), instead
  of always the request target's own origin. Browsers send the page's origin
  on cross-origin requests, and media CDNs and CORS allow-lists check it; the
  target's own origin remains the fallback when the page is unknown.
- Range requests and HLS/DASH manifests (`.m3u8`, `.mpd`) bypass the blanket
  edge cache (`cacheEverything`).
- XHR `open` and `EventSource` coerce their URL argument with `String()`,
  so `URL` objects are proxied instead of bypassing the relay.
- GET form submission resolves its target through a
  `toProxied`/`fromProxied` round trip, so JS-created forms with a
  root-relative `action` no longer resolve to the relay's own origin
  ("Refusing to proxy itself").
- `NO_LINK` entries are no longer logged by default: clicks on non-anchor
  elements are not failures and were inflating N. Turn on debug mode (or set
  `RELAY_LOG_NO_LINK`) to bring them back when hunting for link-less
  navigation escapes.
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
- Video that would not play: live HLS/DASH playlists were edge-cached for 120
  seconds (stale within seconds), partial-content requests went through the
  cache, and hotlink-protected media CDNs received the CDN's own origin as
  `Origin` (and, on real-path pages, no `Referer`) instead of the page's.
