# Changelog

## Unreleased

### Added
- Cookie jar, so logins and sessions work (`COOKIE_JAR`, on by default; set it
  to `false` to restore the old anonymous behavior exactly). The Worker has no
  storage, so the jar lives in the visitor's browser as cookies on the relay's
  origin, one per target host and visibility (`__rj_h_…` HttpOnly, `__rj_s_…`
  script-visible). On each request the matching records become an ordinary
  `Cookie` header for the target (host-only vs. `Domain`, `Path`, `Secure`,
  expiry and `SameSite` honoured, with cross-site requests judged against the
  page's site); each upstream `Set-Cookie` — including those on redirect hops
  — is folded back into the jar. A small list of multi-label suffixes stands
  in for the public-suffix list, so a site cannot set a cookie for `co.uk`.
  Each jar cookie is capped at about 3 KB (oldest records dropped first) and
  all jar cookies together at about 9 KB: past that, the largest untouched
  jars are expired, so the browser's `Cookie` header can never grow past what
  Cloudflare accepts and lock the visitor out of the relay.
- Redirects are followed by hand while the jar is on, so a cookie set on a
  redirect hop (the usual login flow: POST, then 302 with `Set-Cookie`) is
  kept and the right cookies go out on the next hop. A 307/308 whose streamed
  request body cannot be replayed is handed back to the browser, rewritten to
  stay inside the relay, with the cookies attached.
- `document.cookie` shim in the injected script: reads return the
  script-visible cookies for the page's real host, writes update that jar,
  and HttpOnly cookies are never exposed. The relay's own cookies
  (`__relay_ctx`, `__relay_debug`) go through the native accessors.
- WebSocket handshakes carry the target's cookies.
- `/cookies`: a cookie manager that lists the sites with cookies in this
  browser's jar and clears one site or all of them. Linked from the homepage
  footer.
- Homepage: a visible **Log out** button in the header, next to the theme
  toggle, in addition to the footer link. Both appear only when `PASSWORD` is
  set (there is no session to end otherwise).
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
- Login and logout moved to `/login` and `/logout` (previously
  `/__relay_login` and `/__relay_logout`, which now redirect there). These
  are common names on other sites, so a request for either whose `Referer` is
  a proxied page is treated as that site's escaped link and repaired like any
  other; typed or bookmarked visits, form posts and the login redirect
  (`?redirect=`) are the relay's. The relay's Service Worker leaves `/login`,
  `/logout` and `/cookies` alone and lets the server decide.
- Caching with the jar on: requests that carry jar cookies bypass every cache
  (Cloudflare's fetch cache and the relay's edge cache); `cacheEverything`
  applies only to static assets (`script`/`style`/`image`/`font`), because a
  first visit can set a cookie that a cached copy would never replay to the
  next visitor; responses that set cookies are never stored; HTML built with
  a visitor's cookies is sent `Cache-Control: private, no-cache`. With the jar
  off, caching is exactly as before.
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
