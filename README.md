# Relay

A single-file Cloudflare Worker that proxies web pages through your own
domain: links, forms, scripts, cookies, logins, WebSockets and client-side
navigation stay on the relay instead of escaping to the real site.

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
it). **Unset, the relay behaves exactly as before** — and the homepage says so,
because without a password anyone with the address can use the relay.

Local note: the session cookie is `Secure`, so the gate loops on plain-HTTP
`wrangler dev` (known issue) — test it on the deployed HTTPS URL.

| Path | Purpose |
|---|---|
| `/login` | Login form. Unauthenticated requests redirect here with `?redirect=<where you were going>`. |
| `/logout` | Expires the session cookie. Reached from **Log out** on the Settings page, shown only when a password is set. Bookmark it for shared machines. |

The old `/__relay_login` and `/__relay_logout` URLs redirect to these.
`/login` and `/logout` are short names that proxied sites use too, so a request
for one (GET or POST) whose `Referer` is a proxied page is treated as that
site's own link and repaired like any other escape; typed or bookmarked visits,
the relay's own login form and the login redirect (`?redirect=`) are the
relay's. `/settings` and `/cookies` follow the same rule.

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
`?url=` links redirect to the canonical form. Every site opens in **original**
mode (the address contains the site: `relay/https://site.com`) unless you
switched it to real-path mode in Settings.

**Which version is live:** the homepage footer shows `build v0.13.0 ·
path-embedded`, and the diagnostic panel header shows `relay v0.13.0 — failed
requests`. (Before v0.9.0 the panel header never actually rendered — the
injected script was syntactically dead from v0.5.0 to v0.8.0; see
`CHANGELOG.md`.) If you don't see v0.13.0, you're testing an old deploy.

**Homepage:** the address field, and one **Settings** button in the header.
Everything that used to be in the header — the IP lines, **Cookies**, **Sign
out of sites**, **Log out**, the theme toggle — moved to the Settings page in
v0.13.0, along with the footer links. With no password set the homepage says
the relay is open to anyone with the address and that there is no relay login
to log out of; a **Log out** button then appears in Settings once a password
is set.

**Settings** (`/settings`): one page for everything about the relay itself. It
sits behind the password gate like everything else, and each change is a plain
form post that redirects back with a short confirmation.

- **Appearance** — **Light** and **Dark** buttons. Stored in this browser
  (`localStorage`, the same key the homepage always used).
- **Browsing mode** — which sites open in original mode (the default for every
  site) and which in real-path mode; see below.
- **Debug bar** — shows the state of debug mode and turns it on or off. On, the
  small `relay` button is present on every page, with the failed-request log, a
  **Link** button and a **Mode** button for the current site. It turns itself
  off after 24 hours (the same cookie `/__relay_debug` sets).
- **Your IP** — a **Check my IP** button; see below. The section is absent when
  `IP_WIDGET` is `false`.
- **Cookie jar** — the sites that have cookies in this browser, with the number
  of cookies, a **Clear** button per site, **Clear all cookies**, and a link to
  `/cookies` (the names-only list).
- **Session** — **Log out**, present only when a password is set.

**Browsing mode.** **Original** is the default for every site: the target is
embedded in the path. **Real path** keeps the site's own address in the address
bar (`/search?q=…` instead of `/https://github.com/search?q=…`) and is needed by
sites that render nothing or crash in original mode — typically client-side apps
whose router reads `location.pathname` (Poki renders a blank page in original
mode; GitHub, BBC and react.dev misbehave). See *Real-path mode* below. You
switch a site in Settings: type it in the field and press **Use real path**, or
tap one of the suggestions (`poki.com`, `playhop.com`, `crazygames.com`,
`github.com`, `bbc.com`, `bbc.co.uk`, `react.dev`), then reload the site. Each
listed site has a **Use original** button that takes it back. The choice is
remembered **per site, in this browser**: it is stored in one `__relay_rp`
cookie on the relay's origin (bare hosts without `www.`, up to 40 sites, one
year), so it survives a restart, does not depend on any storage in the Worker,
and is forgotten if you clear all of the browser's cookies for the relay.
**Clear all cookies** in Settings and **Sign out of sites** only touch the
cookie jar, not this list. A site matches by exact host (with or without
`www.`): `poki.com` does not cover `poki-gdn.com`, and that is deliberate — only
a portal belongs in the list, never the host of a game it embeds (see *Real-path
mode*). To switch a site you are looking at, turn the debug bar on once, tap
`relay` and then **Mode**: it opens Settings with that site already filled in and
a one-tap switch. Switching a site in either direction also clears the leftover
real-path context cookie, so it cannot keep re-routing bare paths.

**IP check.** Settings → **Your IP** shows nothing until you press **Check my
IP**. The press fetches `/__relay_ip` once and shows **you** — your real IP as
Cloudflare sees it, with country and network — **sites see** — the IP the relay
fetches from, which is what the sites you visit see instead of yours — and the
Cloudflare data center serving you. Nothing is remembered: every load starts
with the lines hidden, the readings live only in the page's memory, and a failed
fetch shows "unavailable" (press again to retry). In the diagnostic panel the
**IP** button shows the same two lines (it fetches only when you press it, and
the result is never stored or copied). "Sites see" is measured from inside the
Worker with an IP-echo service (`api64.ipify.org`, `icanhazip.com`,
`checkip.amazonaws.com`) and cached for a minute; Cloudflare may use several
outbound addresses, so it can vary from one check to the next, and a failed
lookup shows "unavailable". Your own IP is never sent to the echo services —
they only see the Worker's address. See the privacy notes under *Limitations*,
and set `IP_WIDGET` to `false` to remove the section, the panel's **IP** button
and the `/__relay_ip` endpoint.

**Logging in:** sites you sign into stay signed in — see *Cookie jar* below.
Use a throwaway account to try it: your password passes through your Worker and
Cloudflare on its way to the site, and nothing here is safe for an account you
cannot afford to lose. The Settings page and `/cookies` list the sites that have
cookies in this browser — `/cookies` shows the cookie **names** (never values)
and clears one site or all of them; clearing signs you out of those sites. Login
test sites are listed after the checklist.

**Diagnostic panel:** on any proxied page, failures (non-2xx fetch/XHR,
WebSocket errors, resources that failed to load) collapse into a small
top-right button, `relay · N`. It never opens by itself: click to expand.
Inside, the first line (`page: …`) shows the current page's real URL, **IP**
shows your IP and the one sites see (the button is removed when `IP_WIDGET` is
`false`), **Mode** opens Settings for the current site (see *Browsing mode*),
**Link** copies a working relay link for the page, and **Copy** puts the failure
list on the clipboard without DevTools. A failed request to a captcha provider
is labelled as such. Cloudflare's own `/cdn-cgi/` requests and preload failures
are filtered out so they don't inflate N, and on game sites so are failed
requests to ad and tracking hosts (Google ad and tag hosts, Bing's pixel,
IntentIQ, Prebid and similar), which are expected and would bury the failures
that matter — debug mode shows them again. The panel exists on a page after its
first failure, on real-path sites, and from page load when the debug bar is on.
On game sites it is not created after a failure at all (it would sit on top of
the game), only when the debug bar is on.

**Debug mode:** turn it on in Settings → **Debug bar**, or visit
`https://relay.<username>.workers.dev/__relay_debug` (`?on=0` turns it off), for
verbose diagnostics for 24 hours (a cookie) — handy on a phone, where editing the
worker for a flag isn't an option. It logs clicks with no `<a>` in their path
(`RELAY_LOG_NO_LINK`, not failures — only useful when hunting for link-less
navigation escapes), every `pushState`/`replaceState` call as original →
proxied (`RELAY_LOG_NAV`) and, where the browser supports the Navigation API
(Chromium), every navigation including `location.href = …` assignments and form
submissions. The log is also kept in `sessionStorage`, so after a page jumps
away (for example back to a site's home page) the panel on the next page still
shows what happened before the jump. Failed `fetch`/XHR entries also include the
first 200 characters of the response body, which is how bot-protection responses
explain themselves. Open the panel and use Copy to paste it back.

**Mobile:** the relay's own pages work on a phone: buttons and inputs get
roughly 44-pixel touch targets, inputs are at least 16 px so iOS Safari does
not zoom the page when you focus them, the diagnostic panel is capped to the
viewport and respects the notch (`env(safe-area-inset-*)`), long log lines wrap
instead of stretching the page sideways, and on narrow screens the homepage and
Settings lay out in a single column. This covers the relay's own UI only —
proxied sites are passed through untouched, so their own mobile behaviour is
their own.

**Paths the relay answers itself:**

| Path | Purpose |
|---|---|
| `/` | Homepage. |
| `/settings` | Settings page and its form posts. `?site=<host>` opens it with that site filled in (the panel's **Mode** button); `?note=` carries the confirmation after a change. |
| `/cookies` | Cookie manager (names only); POST clears one site or all. |
| `/login`, `/logout` | Password gate (only with `PASSWORD`). |
| `/__relay_ip` | IP lookup JSON (GET/HEAD), behind the password gate. |
| `/__relay_debug` | Turns debug mode on (`?on=0` off) for 24 hours. |
| `/__relay_inject.js?v=<hash>` | The injected client script, cached for a year. |
| `/__proxy_sw.js` | The relay's Service Worker. |
| `/favicon.ico`, `/robots.txt` | Answered at the root so they never enter target recovery. |

A proxied site's own link to one of these names that escaped to the relay's
origin (its `/settings`, `/login`, `/cookies`) is repaired from the `Referer`
instead, except where the request carries `?site=` / `?note=` on `/settings` or
`?redirect=` / `?error=` on `/login`.

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
  keeps the recovery below working on sites that restrict it. A
  `<meta http-equiv="Content-Security-Policy">` (and the report-only variant) is
  removed: it is evaluated against the relay's origin, where its host lists
  block the proxied copies of the site's own scripts and requests — the same
  reason the CSP *header* is dropped (below).
- **Stability fallbacks.** An unexpected error no longer takes the response
  down with it: if the rewriter's handler throws on a single element, that
  element is passed through unrewritten and the stream continues, and if
  anything else fails after the upstream response has already arrived, the
  relay answers with the original body and only the headers corrected. None of
  this changes how any site is rewritten — the fallbacks cover only what
  happens when something unexpectedly throws. A `204`, `205` or `304` response
  that advertises `text/html` is passed through as it is instead of being run
  through the rewriter (a null-body status cannot carry a body, and wrapping one
  used to end in the relay's 500 page).
- **Upstream response headers that would act on the relay's origin are
  stripped** from every passthrough: `Strict-Transport-Security` (a target's
  `includeSubDomains` could pin the relay's whole parent domain),
  `Clear-Site-Data` (could wipe the relay's cookie jar and storage),
  `Content-Security-Policy` and its report-only variant and `X-Frame-Options`
  (written for the real site; on a script, worker or framed document served from
  the relay they only break it), `Link` (carries raw preload URLs that bypass the
  relay), `Report-To`, `Reporting-Endpoints`, `NEL`, `Alt-Svc`, `Expect-CT`,
  `Public-Key-Pins` and, as before, `Referrer-Policy` (it strips the `Referer`
  from a file's own subrequests, which the recovery below depends on) and
  `Set-Cookie`. The response is re-wrapped only when one of them is present. The
  final URL after redirects is read **before** any re-wrap, because a re-wrapped
  `Response` has an empty `.url`.
- **Forms.** A POST form's `action` (and any `formaction`) is rewritten to the
  proxied URL, so the submission goes through the relay with its cookies; a
  form with no `action` posts to the page's own, already proxied, URL. GET
  forms keep their real target in `data-proxy-target` and are submitted by the
  injected script.
- Requests that reach the bare origin with no target (root-relative escapes)
  are repaired from the `Referer`; a Service Worker is a backstop. Paths whose
  `//` was collapsed by a client router (`/https:/host/x`) are restored to
  `/https://host/x` by both. These recovery redirects answer 302 for GET/HEAD
  and 307 for anything else, so a POST keeps its method and body.
- **Derived hostnames.** Some sites build server names from `location.hostname`
  — Proton turns `account.proton.me` into `account-api.proton.me` — and under
  the relay that hostname is the relay's, so the page asks for names such as
  `relay-api.<your domain>`, which do not exist. When the page's real site is
  known (from the `Referer`), the Worker applies the same derivation to the real
  host: `<relay label>-<suffix>.<relay rest>` becomes `<page label>-<suffix>.<page
  rest>` and `<prefix>.<relay host>` becomes `<prefix>.<page host>`. Cookies and
  cache entries use the translated host. With no page context nothing is
  translated, and if a name under the relay's own domain still cannot be reached
  the error page says why. Switch: `DERIVED_HOST_ALIASES`.
- **Redirects.** With the cookie jar on, a 3xx from the target is rewritten to
  stay inside the relay and handed to the browser together with that hop's
  cookies; the browser follows it as it would on the real site (method and body
  semantics, the address bar, one-shot content such as a flash message) and
  each hop passes through the Worker again. With the jar off, the Worker
  follows redirects itself and a navigation whose upstream redirected
  (`bbc.com` → `www.bbc.com`) is answered with a 302 to the final proxied URL,
  so the address bar and the injected `<base>` agree.
- Real method, body and headers are forwarded (a denylist, so custom API
  headers survive). The visitor's real `User-Agent` is forwarded. `Referer`
  and `Origin` are corrected to the page's real URL and origin (for
  real-path pages, from the `__relay_ctx` cookie), which media CDNs, CSRF checks
  and CORS allow-lists look at. Relay-wrapped URLs inside an upstream query
  string (a consent manager's `href=<relay>/https://…`, or `href=<relay>/news`
  on a real-path page) are restored to the real URL. The browser's own cookies
  are never forwarded as-is: the target gets only the cookies from the jar
  below. **The visitor's IP is never forwarded**: `CF-Connecting-IP`,
  `X-Forwarded-For`, `True-Client-IP`, `X-Real-IP`, `Forwarded`, `Via`,
  `CDN-Loop` and the `cf-` geo headers (city, region, postal code, timezone,
  latitude, longitude and so on) are all dropped.
- A target that is the relay itself is refused, compared by host as well as
  origin, so `http://<relay>` cannot slip past a check made on the `https`
  origin; the WebSocket bridge applies the same check.
- Timeout (a stalled target is reported as "did not answer within N seconds" and
  is **not** retried), one retry after a network failure and a capped
  `Retry-After`-aware retry on 429/503 — **both only for `GET`/`HEAD` without a
  body**, so a bodyless `POST` is never sent twice — and a styled error page for
  Cloudflare edge failures. In game context there is one more retry on a
  transient 5xx (see *Gaming sites*).
- Caching: edge cache for static assets (GET only), keyed partly on the
  request's `Accept` header with per-status TTLs (`cacheTtlByStatus`);
  Cloudflare's fetch cache; long browser caching for static types (scripts,
  styles, images, fonts, `application/wasm`). Only anonymous responses are
  cached: a request that carries jar cookies bypasses every cache, a response
  that sets cookies is never stored, HTML is never stored in the edge cache
  while the jar is on (a login page carries a CSRF token), and Cloudflare's fetch
  cache is limited to static assets (and game assets, below). Large assets
  (>20 MB) skip the edge-cache copy. **Range requests** and HLS/DASH manifests
  (`.m3u8`, `.mpd`) bypass every cache — lookup and store — because the cache
  key ignores `Range`: a cached full body must never answer a Range request, and
  a cached live playlist stalls playback. A throwing cache lookup counts as a
  miss, never a failed request.
- WebSockets are bridged browser to Worker to target, including subprotocol
  negotiation, the real `Origin` and the target's cookies. (A WebSocket
  handshake carries no `Referer`, so derived hostnames are not translated for
  sockets.) A Worker's `close()` accepts only 1000 and 3000–4999, so a peer
  closing with 1005, 1006, 1011 and similar is mapped (1001, 1005 or no code to
  1000, anything else to 4011) and the reason is cut short; an error or close on
  either side closes the other, so the two halves can no longer be left open.
- The relay answers `/favicon.ico` and `/robots.txt` at its own root, so
  those bare-origin requests never enter the target-recovery path. A target's
  own `/cdn-cgi/rum` and `/cdn-cgi/speculation` get a 204.
- **IP check endpoint.** `/__relay_ip` (GET/HEAD, behind the password gate,
  before the escape-recovery logic) returns `{ you: { ip, country, city, region,
  asn, org }, relay: { ip, source } | null, colo }` with `Cache-Control:
  no-store`. `you` comes from `CF-Connecting-IP` and Cloudflare's request
  metadata; `relay` from an IP-echo lookup run in the Worker (three services in
  turn, 2.5 s each and 5 s overall, one shared lookup for concurrent requests,
  cached for a minute). Switch: `IP_WIDGET`.
- Narrow search-engine special case: embedded URLs in
  `links.duckduckgo.com` responses are rewritten server-side
  (`SEARCH_DATA_HOSTS`; add other engines only after inspecting their
  payload). Image hosts inside those payloads (`REWRITE_SKIP_HOSTS`) are left
  alone — pre-wrapping them breaks DDG's own image proxy.

**Gaming sites.** Game portals (Poki, PlayHop, CrazyGames, GameDistribution,
GameMonetize, Y8, itch.io, Kongregate, Newgrounds, Miniclip, Armor Games,
Addicting Games and the Yandex games hosts) put each game in a cross-origin
iframe, load large wasm and data bundles with `fetch()`/XHR, and talk to ad SDKs
and to the portal through `postMessage` — none of which the generic rules were
tuned for. `GAME_MODE` (on by default) adds, in **game context** — a request
whose target host or whose page (from the `Referer`) is in `GAME_HOSTS`:

- **Game assets** (`.wasm`, `.unityweb`, `.data`, `.bundle`, `.pck`, `.mem`,
  `.glb`, `.gltf`, `.ktx2`, `.basis`, `.atlas`, `.skel`, `.fnt`, audio, `.br`,
  `.gz`; `GAME_ASSET_PATH`) are cached at Cloudflare's fetch layer and in the
  relay's edge cache even though they are fetched with destination `empty`
  (which the jar-on rules otherwise exclude), and get the 24 h browser cache
  when upstream gives no freshness policy of its own.
- `.wasm` is served as `application/wasm` when upstream sends another type, so
  `WebAssembly.instantiateStreaming` works.
- The debug button is not created after a failed request (see *Diagnostic
  panel*).
- **Retries** (`GAME_RETRY`, on by default). The Worker retries a `GET`/`HEAD`
  once, 250 ms later, after a `500`, `502`, `503`, `504` or a Cloudflare edge
  status (520–524). The injected `fetch` retries a game's `GET` up to twice more
  (after 0.4 s and 1.2 s) on a network error or a gateway status (502–504,
  520–524), unless the request was aborted. Requests with a body are never
  retried, and the client does not retry a `500`, because a game's own API may
  return one on purpose. The WebSocket handshake is retried once on those
  statuses for every socket.
- **Cache lifetimes.** Game assets are kept at Cloudflare's fetch layer for a day
  (other static assets in game context for an hour; ordinary browsing keeps five
  minutes). A game asset that upstream marks `no-cache` or `max-age=0` — common
  for versioned bundles — gets `Cache-Control: public, max-age=3600` instead of
  being re-downloaded on every replay and counted against the Worker's request
  quota; `no-store` and `private` are still honoured.
- **Lean mode** for the document that hosts the game itself
  (`GAME_FRAME_HOSTS`: `poki-gdn.com`, `html5.gamedistribution.com`, `itch.zone`,
  `ungrounded.net`, `gamemonetize.co`, `games.crazygames.com`, the Yandex
  hosts): the client script does not start its DOM mutation watcher there. A game
  page on a host the list does not know gets the same treatment at runtime when it
  has a `<canvas>` and fewer than five links. Fetches, sockets, workers and
  messages still go through the relay.
- **Ad and analytics refusal** (`GAME_BLOCK_ADS`, **off** by default): requests to
  `GAME_AD_HOSTS` get an empty `403`, which is how a browser ad-blocker looks to
  an SDK (the script's error event fires), so the SDK takes its "no ads" path
  instead of waiting on an ad request. It is off because how each game reacts is
  not predictable; turn it on if ad requests stall a game.

A portal built as a client-side app (Poki, PlayHop, CrazyGames) also needs
real-path mode for the **portal**, in Settings; the game's own host
(`poki-gdn.com` and similar) must stay in original mode. Add a portal to
`GAME_HOSTS` and a pattern to `GAME_ASSET_PATH` / `GAME_AD_HOSTS` at the top of
`_worker.js`; nothing else needs to change.

**Speed.** The injected client script is **not** inlined in every page any more
(v0.13.0): it is built and minified once per Worker instance (full-line comments
and indentation stripped: about 61 KB → 39 KB with the v0.13.0 additions) and
served from `/__relay_inject.js?v=<hash>` with `Cache-Control: public,
max-age=31536000, immutable` and an `ETag`. The version is the SHA-256 prefix of
the script text, so a deploy that changes the script changes the URL. Each HTML
page carries only a one-line config script (`window.__relayCfg`: the real path
for real-path mode and the game-context flag) and a `<script src>`; if the
config script is ever blocked, the file falls back to normal mode. As a side
effect the script also loads on pages whose CSP forbids inline scripts. The
route is answered before the escape-recovery logic, sits behind the password
gate, and is in the Service Worker's own-path list. The relay's Service Worker
registers a static route (Chromium's `addRoutes`) so requests whose path already
starts with an embedded URL — including the collapsed `/https:/host/…` form a
client-side router can produce — and the relay's own paths skip the Service
Worker instead of waking it for every subresource. Requests for static asset
types, matched by extension (`.js`, `.css`, images, fonts, media), take a fast
path that skips the page-context probe, the escape-recovery logic and the
rewriter decision tree entirely; jar cookies are still applied. HTML goes
through a single `HTMLRewriter` chain — one traversal of the document. Documents
and API calls skip the edge-cache lookup (HTML is never stored there); the cache
key is built from the URL alone. The password hash is computed once per
instance; the cookie jar decodes only the cookies that can apply to the
requested host; the query-string check exits immediately when the query does not
mention the relay; link rewriting parses the page's base URL once. In the
browser, the diagnostic panel and the IP lines are built lazily — after load, or
on first use — instead of during injection; the `MutationObserver` skips nodes
covered by an ancestor added in the same batch and the diagnostic stale-link
sweep waits for idle time. Optional, off by default: `BLOCKED_HOSTS` answers
analytics and ad hosts with an empty 204 instead of fetching them (each is a
full Worker round trip) — blocking can break pages that expect those scripts, so
it is a switch, not a default.

**Cookie jar.** The Worker has no storage, so each visitor's browser keeps its
own jar, as cookies on the relay's origin — **one relay cookie per upstream
cookie**, named `__rj_h.<host>.<path>.<name>` (the site marked it HttpOnly; the
relay sets it HttpOnly too, so page scripts cannot read it) or
`__rj_s.<host>.<path>.<name>` (readable; the injected `document.cookie` shim
exposes these to the page), each part base64url, with a base64url JSON value
`[value, expiresMs, secure, hostOnly, sameSite]`. One relay cookie per
upstream cookie is deliberate: parallel responses (a page and its XHRs all
setting cookies at once) each touch only their own cookies, so none can
overwrite another's — a blob per site would lose cookies, and with them logins,
to that race. On every request the Worker turns the cookies that match the
target (host-only vs. `Domain`, `Path`, `Secure`, expiry, `__Secure-`/`__Host-`
prefixes, and `SameSite` judged against the page's site) into an ordinary
`Cookie` header, and turns each upstream `Set-Cookie` into one relay
`Set-Cookie` (set or expire). Limits: about 3.8 KB per cookie, 6 KB per site
and 10 KB in total; past that the largest untouched sites are expired so the
browser's `Cookie` header can never grow past what Cloudflare accepts. The
relay's own cookies live beside the jar and are not part of it: `__relay_pwd`
(login), `__relay_rp` (the real-path site list), `__relay_ctx` (real-path
context) and `__relay_debug`. To turn the jar off, set `COOKIE_JAR` to `false` at
the top of `_worker.js` (redirects and caching then behave as in v0.10.0; POST
forms still go through the relay, without cookies).

**Captchas and embedded widgets.** A captcha checks which site is hosting it:
its widget URL carries that site's name (hCaptcha: `host=` in the fragment or
query; reCAPTCHA: `co=`, the base64 of the origin) and the page's script fills
it in from `location` — which under the relay is the relay's address — so the
provider rejects the sitekey. For URLs of the well-known providers (hCaptcha,
reCAPTCHA, Cloudflare Turnstile, Arkose/FunCaptcha, GeeTest, Friendly Captcha,
DataDome, captcha-delivery) the injected script swaps the relay's name for the
embedding page's real one in `host=`, `hostname=`, `domain=`, `parent=` and
`origin=`, and re-encodes `co=`. Separately, `MessageEvent.origin` reports the
origin a frame really has: every page and frame the relay serves lives on the
relay's origin, so the origin checks widgets, captchas, payment and sign-in
frames run on incoming messages ("is this really hcaptcha.com?") always failed.
A message from a frame of a different real site now reports that site's origin;
from a frame of the page's own site it keeps the relay origin (what
`location.origin` says); names derived from the relay's host are mapped back to
the derived form the page expects. These remove the mechanical reasons a captcha
cannot work through the relay. Whether a provider accepts a solve is its own
decision — see *Limitations*.

**Client side (injected script).** Patches `fetch` (string, `URL` and
`Request` inputs; `Request` bodies are buffered rather than re-streamed), XHR,
`EventSource`, `window.open`, `WebSocket`, `Worker` and `SharedWorker` (their
script URLs; `blob:` and `data:` pass through), `navigator.sendBeacon` (beacons
used to go from the browser straight to third parties, around the relay),
`postMessage` (on the window instance and on iframe windows as they are first
touched), `pushState`/`replaceState` and `form.submit()`; replaces
`document.cookie` with a shim over the cookie jar; shows the real referring URL
in `document.referrer` instead of `<relay>/https://real.site/…` (game SDKs and
embeds check it); reports real origins on `MessageEvent.origin`; repairs captcha
widget URLs; hooks `setAttribute`/`getAttribute` and the `href`/`src`/`action`
properties so URLs written by JS frameworks are proxied at assignment and read
back unmodified (this stops React reverting the rewrite); points the `action` of
forms that POST — including ones inserted by JavaScript — through the relay;
intercepts clicks and middle-clicks in the capture phase; blocks the target
site's own Service Worker registration; and, where the browser has the
Navigation API (Chromium), guards navigations: a script that sets
`location.href`, `location.assign` or `location.replace` to an address on the
real site (a canonical-domain redirect, a game's site lock, an SDK sending the
top window home) is cancelled and redone through the relay, which a page script
cannot otherwise intercept. A redirect to the page already open is only
cancelled, more than four guarded navigations in ten seconds (per tab) are
cancelled without being redone, and form posts and non-cancelable navigations
are left alone, so the guard cannot loop. Debug mode logs each decision as
`NAVGUARD`. A `MutationObserver` covers
`innerHTML`-inserted content. Every patch is feature-tested before it is
installed — an API the browser does not provide is skipped rather than patched
blindly — and each risky patch is wrapped in its own `try`/`catch` so one failing
patch cannot silently disable the rest.

**Real-path mode.** Sites whose client-side router reads `location.pathname`
(Next.js, React Router, GitHub's React apps, Poki) cannot work under a
path-embedded scheme: they see `/https://host/page` instead of `/page`, fail to
match their routes, and render nothing, crash, hard-navigate to a collapsed
path, or leave widgets inert. For a site switched to real-path mode in Settings
(see *Browsing mode*) the injected script rewrites the address bar to the real
path right after load. Loading is unaffected, because relative URLs resolve
through the injected `<base>`, not the address bar. History calls keep real
paths in the bar, and a one-day `__relay_ctx` cookie (set client-side, never
forwarded upstream) remembers the real origin so a reload of the bare path — and
bare requests whose `Referer` can't place them — are routed back to the right
site. The Worker decides per page: the final host of the response (after
redirects) is looked up in the `__relay_rp` list, and the real path is handed to
the injected script through its config script. Every site not in the list keeps
the full embedded address. **Only the portal belongs in the list:** the context
cookie holds a single real origin shared by every frame, so a game's own host
(`poki-gdn.com`) in real-path mode would overwrite the portal's.

Two constants near the top of `_worker.js` belong to it:

```js
const MODE_COOKIE = '__relay_rp';
const SUGGESTED_REAL_PATH = ['poki.com', 'playhop.com', 'crazygames.com', 'github.com', 'bbc.com', 'bbc.co.uk', 'react.dev'];
```

`SUGGESTED_REAL_PATH` only fills the one-tap buttons in Settings; nothing is
switched automatically. Suggest a site only when it shows the same symptoms (a
blank page, a client-side crash or dead widgets, with `location.pathname`
visible in the error); sites that already work should not be added. Before
v0.13.0 a hard-coded `REAL_PATH_HOSTS` list switched `bbc.com`, `bbc.co.uk`,
`github.com` and `react.dev` automatically; those now open in original mode
until switched.

---

## Editing and verifying `_worker.js`

The injected script is a string inside a template literal (in
`buildInjectedScript()`), so **`node --check _worker.js` does not validate it.**
A syntax error there stops the whole script in the browser while the outer file
still checks clean — this has happened twice: a stray brace (caught pre-deploy)
and the template-escaping bug that shipped from v0.5.0 to v0.9.0. The injected
script contains `${…}` placeholders, so check the text the browser actually
receives — evaluate the template, don't grep the source. Since v0.13.0
`buildInjectedScript()` returns plain JavaScript (no `<script>` tags) and
`getInjected()` minifies it and computes the version. Run all three checks:

```
node --check _worker.js

node --input-type=module - << 'JS'
import fs from 'fs';
fs.writeFileSync('/tmp/_w.mjs', fs.readFileSync('_worker.js', 'utf8') + '\nexport { getInjected, SW_SCRIPT, settingsPage };\n');
const m = await import('/tmp/_w.mjs');
const inj = await m.getInjected('https://relay.test', true);
fs.writeFileSync('inj.js', inj.text);
fs.writeFileSync('sw.js', m.SW_SCRIPT);
JS
node --check inj.js
node --check sw.js
```

`inj.js` is the client script exactly as the browser gets it from
`/__relay_inject.js` (minified; the arguments are the relay origin and the jar
flag — pass `false` to check the jar-off variant), `sw.js` the relay's Service
Worker script. The Service Worker script is also a template literal and has the
same backslash rule. The per-page settings (real path, game flag) are no longer
arguments: they arrive as `window.__relayCfg` from the inline config script that
`ScriptInjector` writes in front of the file.

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
`--check`. The Settings page and the homepage are ordinary template literals in
the Worker: regexes in their inline scripts need the same doubling, which is why
the Settings script avoids regexes altogether.

**Template rule:** avoid backticks and `${` inside the injected script's
comments and code: they end or interpolate the template literal itself.

**Minifier rule:** the Worker minifies the injected script once per instance by
dropping every line that starts (after indentation) with `//` and stripping
indentation. So keep comments on their own `//` lines; never start a line of
real code with `//` (a line continuing a string or regex that begins with `//`
would be deleted); and do not use block comments or multi-line strings in the
injected script. It parses to the identical syntax tree as the unminified
source — if you change the minifier, prove that again (parse both with a JS
parser and compare the trees).

Inside the injected script, read link attributes with
`relayNativeGetAttr` / write with `relayNativeSetAttr`. The hooked
`getAttribute` returns the *unwrapped* URL, so using it for an "already
proxied" check never matches and causes an infinite rewrite loop. Likewise,
read the page's real cookie string with `relayRawCookie()` /
`relayRawCookieSet()`: `document.cookie` is the jar shim, which hides the
relay's own cookies. To call the relay itself from the injected script (the
panel's IP button does), use the native fetch (`origFetch`) with an absolute
relay URL: the patched `fetch` would rewrite a relay path into the proxied
site's. The panel's **Mode** button navigates to `/settings?site=<host>`; keep
the `site=` parameter, because the server uses it to tell that request apart
from a proxied site's own `/settings` link.

The jar's cookie-name scheme, record format and base64url codec exist twice —
the Worker's `jarCookieName`/`loadJar`/`storeSetCookies` and the injected
script's `relayJarName`/`relayJarRecords`/`relayJarWrite` — and must stay
identical. Likewise the derived-host mapping exists on the server
(`mapDerivedHost`) and, inverted, in the injected script
(`relayVirtualOrigin`). After touching either, round-trip a cookie both ways
(the Worker builds a jar cookie and the shim reads it; the shim writes one and
the Worker reads it), and re-run a login flow against a mocked site: GET the
login page (CSRF cookie), POST the form (302 with `Set-Cookie`), follow the
redirect with the stored cookies, and check that parallel responses setting
different cookies all survive.

Settings routes can be exercised without Cloudflare: Node's `Request` and
`Response` are enough to call the exported `fetch` handler for `/settings` (it
answers before anything that needs the Cache API). `GET /settings` returns the
page; `POST /settings` with `action=mode_real&site=poki.com` answers a 302 to
`/settings?note=real` with a `__relay_rp` `Set-Cookie`, and a following GET
carrying that cookie lists the site; `action=mode_original` removes it;
`GET /settings?site=…` with a proxied-page `Referer` must still return the page,
while a bare `GET /settings` with a proxied-page `Referer` must be redirected into
the target.

---

## Quick test checklist

1. Homepage loads; footer shows `build v0.13.0 · path-embedded`; the header has
   a single **Settings** button (with no password the page says so).
2. `/https://example.com`: page renders, link clicks stay on the relay.
3. DuckDuckGo search: result links show the relay prefix on hover and stay on
   the relay when clicked; switching All / Images / Videos / News keeps
   `duckduckgo.com` embedded in the relay URL; video thumbnails load.
4. `https://echo.websocket.org/.ws`: connects and echoes (WebSocket bridge).
5. With `PASSWORD` set: any URL redirects to `/login`; a wrong password
   returns to the form with an error and no resubmit prompt; a correct one
   lands on the original destination; `/logout` ends the session; Settings shows
   a **Log out** button; `/__relay_login` and `/__relay_logout` redirect to the
   new URLs; `/settings` redirects to `/login` when signed out.
6. Deliberately bad input (`/https://gitbub.com`) shows a styled error page,
   not Cloudflare's.
7. Panel smoke test (proves the injected script is alive): open a proxied
   page with at least one broken subresource — the top-right shows
   `relay · N`, it stays collapsed until clicked, and clicking inside it
   doesn't navigate. Copy produces the failure list. View the page source: the
   head starts with a one-line `window.__relayCfg=…` script and a
   `<script src=".../__relay_inject.js?v=…">`, and opening that URL returns the
   script (no comment lines or indentation) with `Cache-Control: public,
   max-age=31536000, immutable`; a second request with `If-None-Match` answers 304.
8. Settings page: **Light** and **Dark** switch the theme and it persists after
   a reload; **Check my IP** shows lines only after the press; **Turn on** under
   Debug bar makes the `relay` button appear on a proxied page, **Turn off**
   removes it; the cookie list matches `/cookies`; **Clear** and **Clear all
   cookies** sign you out of the sites involved.
9. Per-site mode: with nothing switched, `/https://react.dev` and
   `/https://github.com` show the embedded address. In Settings add `react.dev`
   (or tap its suggestion): after a reload `/https://react.dev` stays on the page
   (no redirect to a broken `https:/react.dev`) and shows `/` in the address
   bar; a GitHub repo opens its search-filter and "…" menus once `github.com` is
   switched, and the panel's `page:` row shows the real URL;
   `/https://www.bbc.com/news` renders without the "client-side exception"
   screen once `bbc.com` is switched. Reload on a non-root real-path page lands
   back on the same site. The choice survives closing the browser; **Use
   original** takes the site back to the embedded address; a site not in the list
   (`gist.github.com`) keeps its embedded address. **Mode** in the panel opens
   Settings with the current site filled in.
10. Debug bar: Settings → **Turn on** (or `/__relay_debug`) shows "ON"; on any
    proxied page the `relay` button is then present from load, and it keeps
    entries from the previous page after a navigation. Turning it off (or
    `/__relay_debug?on=0`) removes it.
11. Cookie plumbing, `httpbin.org` (or `httpbingo.org`): `/cookies/set?a=1&b=2`
    redirects to `/cookies` and shows both cookies; the relay's `/cookies`
    page then lists `httpbin.org` with `a` and `b`; `/cookies/delete?a` leaves
    only `b`; `/forms/post` submits a POST form and echoes it back;
    `/redirect/3` ends on the final page with the address bar correct;
    `/basic-auth/user/passwd` (user `user`, password `passwd`) authenticates.
12. A proxied site's own `/login` or `/settings` link (for example one on GitHub
    or BBC) takes you to that site's page, not the relay's, whether or not a
    password is set — both as a link and as a form post.
13. A real login (see below): after logging in you stay signed in across a
    reload and across clicks to other pages; the site's cookie names appear on
    `/cookies`; the browser's own cookie view shows only `__rj_…` cookies (plus
    the relay's own `__relay_…`) on the relay's origin, not the site's own cookie
    names; logging out signs you out; **Clear** signs you out; **Clear all
    cookies** in Settings signs you out of every site.
14. Derived hostnames: a page that builds API names from its hostname (Proton's
    sign-up page) loads its human-verification step without a 502 for
    `relay-api.<your domain>`; in the panel (or debug log) the request went to
    the page's real API host. A captcha widget may still refuse — that is the
    provider's decision, not the relay's.
15. IP check: Settings shows no IP lines until you press **Check my IP**; the
    press fetches them once (your IP under **you**, a different one under **sites
    see** — compare with what an IP-check site such as `httpbin.org/ip` reports
    when opened through the relay — that one is what a site really sees, and
    should match **sites see** or be another address from the same Cloudflare
    range); a reload starts hidden again and nothing requests `/__relay_ip` until
    you press the button. With `/__relay_ip` blocked in DevTools request
    blocking, the press shows "unavailable" and the next press retries. In a
    proxied page's panel the **IP** button shows the same two lines and the lines
    disappear from **Copy**.
16. Gaming: `/https://poki.com` is blank until `poki.com` is switched to real path
    in Settings; after that the portal renders, a game opens in its iframe and
    stays in original mode (`poki-gdn.com` is not in the list), and the `relay`
    button does not cover the game. Game assets (`.wasm`, `.data`) load with
    `Content-Type: application/wasm` for wasm and, on a repeat visit, come from
    cache. If ads stall a game, set `GAME_BLOCK_ADS` to `true` and retry.
17. Headers: through the relay, a target that sends `Strict-Transport-Security`,
    `Content-Security-Policy` or `X-Frame-Options` (for example
    `https://example.com` or `https://github.com`) does not return them — check
    the response headers in DevTools; a Range request (a video seek) is answered
    with `206` from upstream, not a cached full body.

### Login test sites

Use throwaway accounts: your password passes through your Worker and
Cloudflare, and a provider may treat a login through a proxy as suspicious.
None of these are guaranteed to be up, and the public demo credentials can
change.

- **No account needed:** `httpbin.org` / `httpbingo.org` (checklist item 11).
- **Public practice sites with published demo credentials:**
  `the-internet.herokuapp.com/login` (`tomsmith` / `SuperSecretPassword!`; a
  one-time flash message after the redirect proves redirects are handled
  right), `practicetestautomation.com/practice-test-login/` (`student` /
  `Password123`), `saucedemo.com` (`standard_user` / `secret_sauce`; the page's
  own JavaScript writes its session cookie, which exercises the
  `document.cookie` shim), `opensource-demo.orangehrmlive.com` (`Admin` /
  `admin123`; a single-page app with a CSRF token and an XHR login).
- **Real services, throwaway account:** `news.ycombinator.com/login`,
  Wikipedia (cookies scoped to `.wikipedia.org`), `github.com` (a real-path
  site with `__Host-` and `SameSite=Strict` cookies; use an account without
  2FA and expect a new-device verification), `meta.discourse.org` (a
  single-page app that logs in over fetch), a Mastodon instance.
- **Expected not to work, or only partly:** Google, Microsoft, Facebook and
  Amazon sign-in, sites behind Cloudflare Turnstile, Reddit and Stack Overflow,
  and sign-ups that demand a captcha (Proton's human verification now loads, but
  the captcha provider may still refuse). Do not test banks, payment pages or
  accounts you care about.

---

## Limitations

- **Captchas are only partly handled.** Widget URLs for the well-known
  providers (hCaptcha, reCAPTCHA, Turnstile, Arkose, GeeTest, Friendly Captcha,
  DataDome) are repaired so they name the page's real site instead of the relay,
  and message origins are mapped so their origin checks can pass — but a
  provider can still refuse: many also judge the network a request comes from
  (requests from Cloudflare's servers are often flagged), Turnstile sends the
  site name in a message rather than a URL, and a site's own backend validates
  the solve. For a sign-up that demands a captcha (Proton, for instance), plan
  on doing that step on the real site. Use throwaway accounts for everything:
  never put an account you cannot afford to lose through the relay.
- **Logins will not work everywhere.** Form and fetch logins on ordinary sites
  should; sites that require a CAPTCHA or bot check, a two-factor or
  device-verification step that depends on browser signals, "Sign in with
  Google/Microsoft/Facebook" popups, or that fingerprint the browser or block
  datacenter IPs will refuse or loop. Your credentials pass through your Worker
  and Cloudflare, and providers sometimes lock or alert on a login that arrives
  through a proxy: use throwaway accounts.
- **Your IP: what is and is not hidden.** The relay never forwards your IP in
  headers, so sites you fetch through it see the relay's outbound address, not
  yours — but Cloudflare, and whoever runs the Worker, see it. It is not hidden
  from WebRTC (a page can discover your address through a peer connection, which
  the relay does not intercept), and the IP endpoint adds one more way to read
  it: every proxied page shares the relay's origin, so a script written to attack
  the relay could fetch `/__relay_ip` — setting `IP_WIDGET` to `false` removes
  the endpoint and closes that particular route, though the shared origin itself
  remains. The homepage HTML never embeds an IP, Settings shows none until you
  press **Check my IP**, and the panel button is guarded the same way (it
  fetches only on a real click, never stores the result, and keeps it out of
  Copy). That is mitigation, not isolation; real isolation needs each site on
  its own origin (see the roadmap in the project notes). "Sites see" is a spot
  check from an outside echo service: Cloudflare may use several outbound
  addresses, sites on Cloudflare itself see further Cloudflare-specific signals,
  and the lookup can fail ("unavailable"). Beacons are routed through the relay
  since v0.13.0, but any other way a page can reach a third party directly (a
  WebRTC connection, an image or CSS `url()` written as an absolute URL in an
  inline style) still shows your own address.
- **Cookie jar limits.** Cookies are stored in the visitor's browser on the
  relay's origin, so every proxied site shares that origin: a page's script can
  read the *script-visible* (non-HttpOnly) cookies of other proxied sites by
  bypassing the shim, just as proxied sites already share `localStorage`. Treat
  the relay as one browser profile, not isolated sites. A cookie over about
  3.8 KB is dropped, a site is capped at about 6 KB of cookies and all sites
  together at about 10 KB (the largest untouched sites are expired), so heavy
  cookie users can be signed out of sites. `SameSite` is enforced from the
  page's site as best the relay can tell, `credentials: 'omit'` is not
  honoured, a built-in short list of multi-label suffixes stands in for the
  public-suffix list, and session cookies are discarded when the browser
  closes. A site that checks cookies against fingerprinting or datacenter-IP
  signals can still refuse a login.
- **Derived-hostname translation needs a page context.** It works when the
  request's `Referer` names the page's real site; WebSocket handshakes carry no
  `Referer`, so they are not translated, and a name the page derives some other
  way than the two patterns above is not recognised.
- **Target sites can block Cloudflare's IP ranges** (some anti-bot systems do).
  No code change can fix that; the diagnostic panel shows the status codes.
- **Free-plan WebSocket idle timeout is 100 s.** An idle game or chat
  connection can drop. A keepalive was deliberately not added: it would inject
  unexpected messages into the real application protocol.
- **All proxied sites share the relay origin**, so their
  `localStorage`/`sessionStorage` and IndexedDB can collide — two games that use
  the same save key overwrite each other. Per-target storage isolation is
  deliberately deferred.
- **Games.** A game, SDK or site lock that checks the real hostname
  (`location.hostname`, `top.location`, the Yandex games SDK) sees the relay's and
  cannot be satisfied from inside the relay; `document.referrer` is the only
  such value that is virtualised. `GAME_BLOCK_ADS` is a guess about how each
  SDK reacts to a refused ad request, so it stays off until a game is known to
  need it. Cross-origin isolation (`SharedArrayBuffer`, threaded wasm builds) is
  not available, because the relay does not send the COOP/COEP headers. Some
  portals block Cloudflare's outbound addresses outright.
- **Real-path mode trade-offs.** The address bar on those sites carries no
  target host, so a copied bar URL does not work (use the panel's Link
  button). The `__relay_ctx` cookie is shared between tabs, so reloading an
  older real-path tab after opening a different real-path site in another tab
  can land on the wrong site. Reloading a site's root page (`/`) lands on the
  relay homepage, and a real-path site whose own page lives at `/settings` or
  `/cookies` is reached through the relay's own page of that name on a
  browser-initiated reload. The site list lives in a cookie: it is per browser,
  capped at 40 sites, and forgotten when cookies are cleared. Sites that read
  their origin or full URL, not just the path, can still misbehave.
- **Bot-protected services** (AI chat endpoints such as duck.ai's, which
  answer `418` and ask to "verify you're human" over and over) may still not
  work even with the cookie jar. Their checks also rely on fingerprint and
  datacenter-IP signals that a proxy cannot reproduce.
- **Some sites cannot work at all under path embedding** and are not fixed by
  the above: anything that validates its own origin in ways the relay cannot
  virtualize (consent and anti-bot SDKs often do), or loads origin-locked
  resources.
- The Service Worker route that skips the worker for proxied requests needs
  Chromium; other browsers wake the worker for every request, as before. The
  navigation guard needs the Navigation API too, so in Firefox and older Safari a
  script that assigns `location` to the real site still leaves the relay.
- Attribute hooks match lowercase names only (`getAttribute("HREF")` is not
  intercepted).
- `postMessage` target origins are widened to `*`, trading the page author's
  origin check for cross-frame messages that work under the relay.
- The password gate has no rate limiting, a non-timing-safe comparison, and a
  session cookie that holds a hash of the password. The `Secure` session cookie
  loops the login on plain-HTTP local development, and so do the cookie jar's
  `Secure` cookies. It keeps casual visitors and crawlers out; it is not
  hardened access control.
- This is an open relay for anyone with the URL unless `PASSWORD` is set.
  Consider a target allow-list and rate limiting before exposing it publicly.
