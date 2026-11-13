# Changelog

## v0.13.0

### Added
- Settings page at `/settings`, reached from a **Settings** button in the
  homepage header. It now holds everything that used to sit in the homepage
  header, plus the browsing mode:
  - **Appearance**: Light and Dark buttons (stored in `localStorage`, as the
    homepage theme was);
  - **Browsing mode**: see the next entry;
  - **Debug bar**: turns debug mode on or off from the page (the same
    24-hour `__relay_debug` cookie that `/__relay_debug` sets, which still
    works) and shows its current state;
  - **Your IP**: a **Check my IP** button; nothing is requested until it is
    pressed, nothing is stored, and `IP_WIDGET = false` removes the section;
  - **Cookie jar**: the sites that have cookies in this browser with a
    **Clear** button each, **Clear all cookies**, and a link to `/cookies`
    (the names-only list);
  - **Session**: **Log out**, present only when `PASSWORD` is set.
  The homepage header is reduced to the single Settings button; the IP box,
  the Cookies and Sign out of sites buttons, the Log out button, the theme
  toggle and the footer links are gone from it. With a password set the page
  sits behind the login like everything else.
- Per-site browsing mode. Every site now opens in **original** mode (the
  target embedded in the path, `relay/https://site`). A site that needs
  **real-path** mode is switched in Settings, either by typing the site in the
  field or with one tap on a suggestion (`poki.com`, `playhop.com`,
  `crazygames.com`, `github.com`, `bbc.com`, `bbc.co.uk`, `react.dev`,
  `SUGGESTED_REAL_PATH`), and the choice is remembered per site. The Worker
  still has no storage: the list lives in one `__relay_rp` cookie on the
  relay's origin (`HttpOnly; Secure; SameSite=Lax`, one year, bare hosts
  without `www.`, separated by `|`, at most 40 sites). A host matches exactly,
  with or without `www.`: `poki.com` does not cover `poki-gdn.com`, which is
  deliberate — real-path mode keeps one real origin in a cookie shared by every
  frame, so only the portal belongs in the list, never a game's own host.
  Switching a site in either direction also expires the `__relay_ctx` cookie,
  so a stale real-path context cannot keep re-routing bare paths. Clearing all
  browser cookies forgets the list; **Clear all cookies** in Settings and
  **Sign out of sites** only touch the cookie jar and leave it alone.
- **Mode** button in the debug panel: opens `/settings?site=<host>` for the
  site being viewed, with a card showing its current mode and a one-tap
  switch. This is the way to switch a site that renders blank (Poki): turn the
  debug bar on once, tap `relay`, then **Mode**, then reload the site.
  `/settings` follows the same rule as `/login` and `/cookies`: a request
  without a proxied-page `Referer`, or carrying `?site=` or `?note=`, is the
  relay's own; a proxied site's own `/settings` link that escaped to the
  relay's origin is still repaired from the `Referer`. The Service Worker
  leaves it alone and routes it straight to the network.
- Gaming-site handling (`GAME_MODE`, on by default). Game portals (Poki,
  PlayHop, CrazyGames, GameDistribution, GameMonetize, Y8, itch.io, Kongregate,
  Newgrounds, Miniclip, Armor Games, Addicting Games and the Yandex games
  hosts, `GAME_HOSTS`) host each game in a cross-origin iframe, load large
  wasm/data bundles with `fetch()`/XHR and talk to ad SDKs, none of which the
  generic rules were tuned for. A request is in "game context" when its target
  host or the page that made it (from the `Referer`) is in `GAME_HOSTS`. In
  game context:
  - game assets (`.wasm`, `.unityweb`, `.data`, `.bundle`, `.pck`, `.mem`,
    `.glb`, `.gltf`, `.ktx2`, `.basis`, audio and similar, `GAME_ASSET_PATH`)
    are cached at Cloudflare's fetch layer and in the relay's edge cache even
    though they are fetched with destination `empty`, which the jar-on rules
    exclude, and get the 24 h browser cache when upstream gives no freshness
    policy;
  - the debug button no longer appears over the game after the first failed or
    refused request (debug mode still shows it);
  - optional ad and analytics refusal (`GAME_BLOCK_ADS`, **off** by default):
    hosts in `GAME_AD_HOSTS` get an empty `403`, which is what a browser
    ad-blocker looks like to an SDK (the script's error event fires), so the
    SDK takes its "no ads" path. It is off because how each game reacts is
    not predictable; turn it on per deployment if ad requests stall a game.
- `.wasm` responses are served as `application/wasm` when upstream sends
  another type, so `WebAssembly.instantiateStreaming` works, and
  `application/wasm` joins the long-cacheable types.
- Client patches: `Worker` and `SharedWorker` URLs go through the relay (an
  absolute URL bypassed it and was refused as cross-origin, a root-relative
  one escaped to the relay's origin; `blob:` and `data:` pass through
  untouched); `navigator.sendBeacon` goes through the relay (beacons used to
  go straight from the browser to third parties, around the relay and showing
  the real IP); `document.referrer` shows the real referring URL instead of
  `<relay>/https://real.site/…`, which game SDKs and embeds check.
- Page markup: a `<meta http-equiv="Content-Security-Policy">` (and the
  report-only variant) is removed. It is the in-markup twin of the CSP header
  the relay already drops, and once everything is served from the relay's
  origin its host lists block the proxied copies of the site's own scripts,
  images and requests.

### Changed
- Real-path mode is no longer a hard-coded list. `REAL_PATH_HOSTS` is gone and
  no site uses real-path mode until it is switched in Settings. **Upgrade
  note:** `bbc.com`, `bbc.co.uk`, `github.com` and `react.dev` previously
  switched automatically; they now open in original mode until switched
  (they are one-tap suggestions), and the same applies to `poki.com`, which
  renders nothing in original mode.
- Speed. The injected client script (about 39 KB minified) is no longer
  inlined in every HTML page. It is served from `/__relay_inject.js?v=<hash>`
  with `Cache-Control: public, max-age=31536000, immutable` and an `ETag`,
  built and minified once per isolate, with the SHA-256 prefix of the text as
  the version, so a redeploy that changes the script changes the URL. The page
  carries only a small config script (`window.__relayCfg`: the real path for
  real-path mode and the game-context flag) and a `<script src>`. If the
  config script is ever blocked the file falls back to normal mode, so the
  failure costs a feature, never the page. A side effect: the script also loads
  on pages whose CSP forbids inline scripts, since a same-origin file passes
  `script-src 'self'`. The route is answered before the escape-recovery logic
  and is in the Service Worker's own-path list; it sits behind the password
  gate like everything else.
- Upstream response headers that would act on the relay's own origin are now
  stripped from every passthrough (`UNSAFE_RESPONSE_HEADERS`):
  `Strict-Transport-Security`, `Clear-Site-Data`, `Content-Security-Policy`
  and its report-only variant, `X-Frame-Options`, `Link`, `Report-To`,
  `Reporting-Endpoints`, `NEL`, `Alt-Svc`, `Expect-CT`, `Public-Key-Pins` and
  the report-only variant, and `Referrer-Policy` as before. Every proxied site
  shares the relay's origin, so these did harm there: a target's
  `includeSubDomains` HSTS could pin the relay's whole parent domain,
  `Clear-Site-Data` could wipe the relay's cookie jar and storage, a CSP
  written for the real site broke workers and framed documents served from the
  relay, and `Link: rel=preload` carried raw URLs that bypassed it. The
  response is re-wrapped only when one of them is present.
- Edge cache and Range: `noEdgeCache` (Range requests, `.m3u8`, `.mpd`) is
  decided before the cache lookup and removes the request from `cacheable`
  altogether. The cache key ignores `Range`, so a cached full body could be
  returned for a Range request, which broke media seeking and resumed
  downloads. A throwing `cache.match` is now treated as a miss instead of
  failing the request.
- Upstream retry: the single retry after a network failure, and the capped
  retry after a 429/503 with a short `Retry-After`, apply only to `GET` and
  `HEAD` without a body. A bodyless `POST` used to be eligible and could act
  twice. A timeout is reported as `The target did not answer within N
  seconds.` and is not retried, instead of costing a second full wait.
- WebSocket bridge: `close()` is called with a code a Worker accepts. A peer
  closing with 1005, 1006, 1011 and similar made `close()` throw, which was
  swallowed and left the other half of the bridge open forever; codes outside
  1000 and 3000–4999 are mapped (1001/1005/none to 1000, the rest to 4011) and
  the reason is cut to 40 characters (the limit is 123 bytes). An error on
  either side now closes the other.
- Self-reference check compares the host as well as the origin, in the Worker
  and in the WebSocket bridge, so `http://<relay>` cannot slip past a check
  made on the `https` origin.
- Client-identifying and loop-control headers are not forwarded upstream:
  `True-Client-IP`, `X-Real-IP`, `Forwarded`, `Via`, `CDN-Loop`,
  `CF-Connecting-IPv6`, `CF-Pseudo-IPv4` and the `cf-` geo set (city,
  continent, latitude, longitude, region, region code, postal code, timezone,
  metro code, `cf-ew-via`).
- The `GAME_BLOCK_ADS`, `GAME_MODE`, `GAME_HOSTS`, `GAME_AD_HOSTS` and
  `GAME_ASSET_PATH` constants sit next to the other switches at the top of the
  file, with comments, so a portal can be added without touching the logic.
- Stability pass (no feature changes; carried from the start of this release):
  - rewritten search-data payloads no longer inherit stale `Content-Encoding`
    / `Content-Length` — `.text()` had already decoded the body, so a gzip
    claim could make the browser fail the response;
  - a 3xx whose `Location` the relay cannot safely wrap (custom scheme,
    unparseable value) has the header dropped, so the browser renders the body
    instead of silently leaving the relay;
  - static-asset caching respects an explicit upstream `no-store`, `no-cache`,
    `private` or real `max-age` instead of blanket-overriding it with a 24 h
    browser cache;
  - `Referrer-Policy` is dropped from non-HTML passthrough: on a CSS file it
    strips the `Referer` from that file's own subrequests, which the
    server-side escape recovery depends on;
  - `cache.put` failures (a `Vary: *` response, an oversized entry) are
    swallowed instead of surfacing as unhandled rejections; a malformed form
    POST to `/login` or `/cookies` redirects back instead of throwing a
    Cloudflare 1101; and the whole fetch handler is wrapped, so an unexpected
    error renders the relay's own error page;
  - `resolveAndProxy()` refuses to re-wrap an already-proxied URL, which keeps
    the injected `<base>` safe from double-wrapping;
  - client: `fetch(Request, init)` merges `init` like the spec (a body/method
    conflict used to throw `TypeError`), GET forms with a `target` attribute
    open in the requested target, and the idle stale-link sweep runs only in
    debug mode — it was pure diagnostics and cost main-thread time on every
    page load.
- Version markers: the homepage footer reads `build v0.13.0 ·
  path-embedded` and the panel header `relay v0.13.0 — failed requests`.

### Fixed
- `upstream.url` was blanked whenever a header was stripped. Re-wrapping a
  `Response` gives it an empty `.url`, and any site sending `Referrer-Policy`
  triggered it, so with the cookie jar off the final-URL `<base>` and the
  redirect handling silently fell back to the pre-redirect address. The final
  URL is now captured before any re-wrap and used from there.
- A `304`, `204` or `205` response that advertised `text/html` was fed to
  `HTMLRewriter` and wrapped in a new `Response` with a body, which throws a
  `TypeError` (a null-body status cannot carry a body) and showed the relay's
  500 page instead of the real status. These statuses now pass through as
  non-HTML.
- Range requests could receive a cached full `200` body (see Changed).
- A bodyless `POST` could be sent twice by the upstream retry (see Changed).
- A WebSocket closed with an abnormal code left its peer open forever (see
  Changed).
- A target's `Strict-Transport-Security` or `Clear-Site-Data` reached the
  browser on the relay's origin (see Changed).
- Poki rendered nothing in original mode: its client-side router reads
  `location.pathname`. It now works once the site is switched to real-path mode
  in Settings (see Added), and the setting is remembered.
- Game assets fetched with `fetch()`/XHR were never cached with the jar on
  (see Added: gaming-site handling), and wasm served with a generic type could
  not be streamed.
- A leftover `__relay_ctx` cookie could keep re-routing bare paths after a
  site was taken out of real-path mode (see Added: per-site browsing mode).

### Known limits
- All proxied sites share one `localStorage` and IndexedDB, so two games using
  the same save key can collide.
- The real-path context cookie (`__relay_ctx`) is shared between tabs: two
  real-path sites open at once can confuse reload and escape recovery.
- Games and SDKs that check the real hostname (the Yandex games SDK, site
  locks) cannot be satisfied from inside the relay, and sites that refuse
  Cloudflare's outbound addresses cannot be reached at all.
- `GAME_BLOCK_ADS` is a guess about each SDK's ad-blocker path; it stays off
  until a game is known to need it.

## v0.12.0

### Added
- IP widget toggle. The homepage IP widget no longer shows itself on load: the
  two lines — **you**, the visitor's IP as Cloudflare sees it
  (`CF-Connecting-IP`) with country and network, and **sites see**, the relay's
  outbound IP, plus the data center and the refresh link — now start folded
  behind a small **IP** button under the address bar, and pressing it toggles
  the readout open and closed. Off is the default on every page load, and the
  choice is deliberately not remembered — no cookie, no `localStorage`, nothing
  — so it can never stay on automatically; an IP readout that turns itself back
  on would stop being one. The `/__relay_ip` fetch moved with it: nothing is
  requested until the first press, so a visitor who never opens the widget
  never triggers the lookup or the outbound-IP echo behind it, and the
  homepage HTML still never contains an IP. The readout is held in memory only,
  until the page unloads; the refresh link still forces a new lookup;
  everything rendered is still escaped and nothing is stored. The diagnostic
  panel's **IP** button already fetched only when pressed and is unchanged.
  `IP_WIDGET` itself stays on by default; set it to `false` and the widget,
  the toggle and the endpoint all disappear together.

### Changed
- Stability, the priority for this release. The rule the pass follows: one
  failure may cost one feature, never the page and never the relay. On the
  client, every patch the injected script installs — the attribute and
  property hooks, `fetch`, XHR, `WebSocket`, `EventSource`, `window.open`,
  `postMessage`, the history wrappers, the submit and click handlers, the
  `MutationObserver`, the captcha and tracking-redirect repairs, the panel
  and the IP widget — is applied only after a feature test and runs inside
  its own `try`/`catch` (the v0.5.0 guard covered only the prototype
  reassignments), so a browser without an API skips that one patch instead of
  dying mid-install, and a patch that throws logs one panel entry and hands
  back the native behaviour while the page keeps working. If the injected
  script itself fails to parse or install, the load-bearing server-side
  layers — `<base>`, `HTMLRewriter` rewriting, Referer recovery, the
  WebSocket bridge — carry the page alone, exactly as they did before the
  client script existed (v0.5.0 through v0.8.0 proved they do). On the
  server, the rewrite path is isolated the same way: an element handler that
  throws no longer aborts the `HTMLRewriter` stream mid-body — that element
  passes through unrewritten and the rest of the document still reaches the
  browser — and an unexpected error after the upstream response has arrived
  falls back to returning that response with the headers corrected and the
  body untouched, instead of Cloudflare's Worker-exception page. No
  site-facing rewrite rule changed in this release: every change here is
  isolation, feature detection or caching with identical output, so nothing
  that worked in v0.11.0 stops working.
- Speed. Fast paths added behind the stability guard, with no change to any
  rewritten byte:
  - static-asset fast path: requests whose path ends in a static extension
    (`js`, `css`, images, fonts, media) skip the page-context resolution, the
    escape-repair probes and the rewriter decision tree and go straight to
    the upstream fetch and the cache rules; with the jar on their cookies are
    still attached — only the page-only work is skipped — and the response's
    `Content-Type` still has the final word if an "asset" turns out to be a
    document;
  - on-demand injection: the load-bearing patches install during script
    evaluation exactly as before, but the diagnostic panel and the IP widget
    are built after the `load` event or on first use, so the diagnostics
    never compete with the page's own boot;
  - one rewriter pass: all element handlers (anchors, media, forms, meta
    referrer, `<base>`, the script injection) attach to a single
    `HTMLRewriter` chain, so the body is traversed once;
  - the injected-script cache holds one minified string per variant (debug
    off/on), with the real-path substitution still applied per request, so
    toggling debug mode no longer rebuilds anything;
  - the relay's Service Worker routes the collapsed `/https:/…` form,
    `/favicon.ico` and `/robots.txt` straight to the network like the
    `/http…` route, so the Worker is not woken for them.
- Mobile support, for the relay's own UI only — nothing extra is injected
  into proxied pages for it, so no target renders differently:
  - tap targets: the panel's collapsed button and its controls, the homepage
    header buttons and the new IP toggle meet the ~44 px coarse-pointer
    minimum;
  - the panel never widens a phone: it is capped to the viewport, its log
    lines wrap instead of scrolling the page sideways, and it clears the
    notch and home indicator via `env(safe-area-inset-*)`;
  - the homepage and login address fields are 16 px or larger, so iOS Safari
    does not zoom the page when the keyboard opens;
  - the homepage folds to a single column on narrow screens, with the header
    controls wrapping instead of overflowing.
- Version markers: the homepage footer reads `build v0.12.0 · path-embedded`
  and the panel header `relay v0.12.0 — failed requests`.

### Fixed
- The homepage IP widget fetched `/__relay_ip` on every homepage load even
  for visitors who never opened the readout (see Added: the fetch is now part
  of the toggle).
- Long log lines in the diagnostic panel could push the whole page sideways
  on phones instead of scrolling only the log (see Changed: mobile support).

## v0.11.0

### Added
- Cookie jar, so logins and sessions work (`COOKIE_JAR`, on by default; set it
  to `false` to turn the jar off). The Worker has no storage, so the jar lives
  in the visitor's browser as cookies on the relay's origin, **one relay
  cookie per upstream cookie**: `__rj_h.<host>.<path>.<name>` (HttpOnly) or
  `__rj_s.<host>.<path>.<name>` (script-visible), each part base64url, with a
  base64url JSON value `[value, expiresMs, secure, hostOnly, sameSite]`. One
  cookie per upstream cookie matters: parallel responses (a page and its XHRs
  all setting cookies at once) each touch only their own cookies, so none can
  overwrite another's — a single blob per site would lose cookies, and with
  them logins, to that race. On each request the matching cookies become an
  ordinary `Cookie` header for the target (host-only vs. `Domain`, `Path`,
  `Secure`, expiry and `SameSite` honoured, with cross-site requests judged
  against the page's site, and `__Secure-`/`__Host-` prefixes enforced); each
  upstream `Set-Cookie` becomes one relay `Set-Cookie`, set or expire. A small
  list of multi-label suffixes stands in for the public-suffix list, so a site
  cannot set a cookie for `co.uk`. Limits: about 3.8 KB per cookie, 6 KB per
  site and 10 KB in total — past that the largest untouched sites are expired,
  so the browser's `Cookie` header can never grow past what Cloudflare accepts
  and lock the visitor out of the relay.
- Login support. POST forms now submit through the relay: the Worker rewrites
  `action` (and `formaction`) to the proxied URL, and the injected script does
  the same for forms inserted or changed by JavaScript. Previously a relative
  action landed on the bare relay origin and an absolute one went straight to
  the real site, skipping the relay and its cookies. GET forms are unchanged. A
  form with no `action` posts to the page's own (already proxied) URL.
- Redirects are handed to the browser while the jar is on: the Worker makes one
  upstream request, rewrites a 3xx `Location` to stay inside the relay and
  returns it with that hop's cookies. The browser follows it as it would on the
  real site, so method and body semantics, the address bar and one-shot content
  (a flash message after login) behave naturally, and cookies set on a redirect
  are stored before the next hop — the usual login flow is POST, then 302 with
  `Set-Cookie`, then the page.
- `document.cookie` shim in the injected script: reads return the
  script-visible cookies for the page's real host, writes update the matching
  relay cookie, and HttpOnly cookies are never exposed. The relay's own cookies
  (`__relay_ctx`, `__relay_debug`) go through the native accessors.
- WebSocket handshakes carry the target's cookies.
- `/cookies`: a cookie manager that lists the sites with cookies in this
  browser — cookie **names** only, never values, with the HttpOnly ones marked —
  and clears one site or all of them.
- Homepage controls: a **Cookies** button (the manager) and a **Sign out of
  sites** button (one press clears every site's cookies in this browser) in the
  header, a **Log out** button next to them when `PASSWORD` is set, and the same
  links in the footer. With no password set the homepage says so: the relay is
  open to anyone with the address and there is no relay login to log out of.
- IP widget (`IP_WIDGET`, on by default). The homepage shows two lines under the
  address bar — **you**, the visitor's real IP as Cloudflare sees it
  (`CF-Connecting-IP`) with the country and network it derived, and **sites
  see**, the relay's outbound IP — plus the Cloudflare data center serving the
  request, with a refresh link. The diagnostic panel has an **IP** button that
  shows the same two lines. `/__relay_ip` returns them as JSON, `Cache-Control:
  no-store`. "Sites see" is found by asking an IP-echo service from inside the
  Worker (`api64.ipify.org`, then `icanhazip.com`, then `checkip.amazonaws.com`;
  2.5 s each, 5 s overall, concurrent requests share one lookup, cached for a
  minute), so it is what an outside site sees right now — Cloudflare may use
  several outbound addresses, so it can vary — and the echo services only ever
  see the Worker's own address. A failed lookup shows "unavailable" and the
  visitor's own IP still appears. The homepage HTML never contains an IP (the
  widget fetches it after load), the panel fetches only when pressed, ignores
  clicks made by a page's script, escapes everything it renders, and never
  stores the result (not in the log history, not in Copy). With a password set the
  endpoint is behind the login. Set `IP_WIDGET` to `false` to remove the
  endpoint and both widgets. Privacy note: every proxied page shares the relay's
  origin, so a script written to attack the relay can fetch `/__relay_ip` too,
  and the relay does not hide the visitor's IP from WebRTC.
- Derived-host aliasing (`DERIVED_HOST_ALIASES`, on by default). Sites that
  build server names from `location.hostname` — Proton turns
  `account.proton.me` into `account-api.proton.me` — ask the relay for names
  such as `relay-api.<your domain>`, which do not exist and ended in a 502.
  When the page's real site is known (from the `Referer`), the Worker applies
  the same derivation to the real host: `<relay label>-<suffix>.<relay rest>`
  becomes `<page label>-<suffix>.<page rest>` and `<prefix>.<relay host>`
  becomes `<prefix>.<page host>`, so `relay-api.whitedragon.us.ci` requested
  from `account.proton.me` is fetched from `account-api.proton.me`; cookies and
  cache entries use the translated host. With no page context nothing is
  translated, and when a name under the relay's own domain still cannot be
  reached the error page says why.
- Captcha widgets. A captcha checks which site is hosting it, and the page's
  script fills that in from `location`, which under the relay is the relay's
  address, so the provider rejects the sitekey. For URLs of the well-known
  providers (hCaptcha, reCAPTCHA, Cloudflare Turnstile, Arkose/FunCaptcha,
  GeeTest, Friendly Captcha, DataDome, captcha-delivery) the injected script
  swaps the relay's name for the embedding page's real one in `host=`,
  `hostname=`, `domain=`, `parent=` and `origin=` (query or fragment) and
  re-encodes reCAPTCHA's `co=`. Failed requests to a captcha provider are
  labelled in the diagnostic panel. This removes the mechanical reasons a
  captcha cannot work through the relay; whether a provider accepts a solve is
  its own decision (many also judge the network a request comes from, and
  Turnstile sends the site name in a message rather than a URL).
- `MessageEvent.origin` reports the origin a frame really has. Every page and
  frame the relay serves lives on the relay's origin, so origin checks on
  incoming messages ("is this really hcaptcha.com?") in widgets, captchas,
  payment and sign-in frames always failed. A message from a frame of a
  different real site now reports that site's origin; from a frame of the
  page's own site it keeps the relay origin, which is what `location.origin`
  says; names derived from the relay's host are mapped back to the derived form
  the page expects.
- Optional speed switch `BLOCKED_HOSTS` (off by default): hostnames matching it
  are answered with an empty 204 instead of being fetched, which removes
  analytics and ad requests — each a full Worker round trip — from every page.
  Blocking can break pages that expect those scripts, which is why it is off;
  the comment above the constant carries a starter list.
- In debug mode, navigations that are form submissions are labelled `form
  submit` in the log.

### Changed
- Speed. The injected script is built and minified once per isolate instead of
  being rebuilt as a ~61 KB string for every page: full-line comments and
  indentation are stripped (about half of the source, 61 KB → 31 KB per page),
  and the real path of a real-path page is substituted into a placeholder per
  request, JSON-escaped and inserted literally. The minified script parses to a
  syntax tree identical to the original. Further:
  - the relay's Service Worker registers a static route (Chromium's `addRoutes`
    API) sending requests whose path already starts with an embedded
    `http(s)` URL straight to the network, so the worker is no longer woken for
    every subresource; browsers without the API behave as before;
  - with the jar on, requests for documents and API calls skip the edge-cache
    lookup (a network round trip), because HTML is never stored there, and the
    cache key is built from the URL alone instead of copying every request
    header;
  - the password hash is computed once per isolate instead of on every request;
  - the cookie jar decodes only the cookies that can apply to the requested host
    (the size budget still counts every site's);
  - the query-string check for relay-wrapped URLs exits immediately when the
    query does not mention the relay (nearly every request);
  - link rewriting parses the page's base URL once and skips the
    tracking-redirect parse for ordinary links (the cheap pre-check matches
    exactly the paths the full check can match), about 1.8x faster in a
    micro-benchmark with identical output; the page context is resolved once
    per request instead of three times;
  - the injected script's `MutationObserver` no longer rescans a node whose
    ancestor was added in the same batch, and the diagnostic stale-link sweep
    runs when the browser is idle.
- Login and logout moved to `/login` and `/logout` (previously
  `/__relay_login` and `/__relay_logout`, which now redirect there). These are
  common names on other sites, so a request for either — GET or POST — whose
  `Referer` is a proxied page is treated as that site's escaped link and
  repaired like any other; typed or bookmarked visits, the relay's own login
  form (posted from `/login`) and the login redirect (`?redirect=`) are the
  relay's. The relay's Service Worker leaves `/login`, `/logout`, `/cookies`,
  `/__relay_ip` and `/__relay_debug` alone and lets the server decide.
- The homepage is sent `Cache-Control: private, no-store`.
- Caching with the jar on: requests that carry jar cookies bypass every cache
  (Cloudflare's fetch cache and the relay's edge cache); `cacheEverything`
  applies only to static assets (`script`/`style`/`image`/`font`), because a
  first visit can set a cookie that a cached copy would never replay to the
  next visitor; HTML is never stored in the relay's edge cache, because a login
  page carries a CSRF token that a cached copy would hand to the next visitor;
  HTML built with a visitor's cookies is sent `Cache-Control: private,
  no-cache`. With the jar off, caching is exactly as before.
- Escape-recovery redirects (a request that reached the bare relay origin, or
  a collapsed `/https:/host/…` path) answer 307 for anything but GET/HEAD, in
  the Worker and the Service Worker, so a POST keeps its method and body
  instead of being downgraded to a GET by a 302.
- POST forms go through the relay even with the jar off (without cookies).

### Fixed
- POST forms bypassed the relay (see Added), which made logins impossible.
- Cookies set on a redirect hop were lost, because the Worker followed
  redirects itself with a throwaway cookie view (see Added).
- A POST that escaped to the relay origin was turned into a GET (see Changed).
- Proton's human-verification step ended in a 502 for
  `relay-api.<your domain>`, a name the page derived from the relay's own
  hostname (see Added: derived-host aliasing).

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
  re-assertion), which could only race a revert loop.
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
