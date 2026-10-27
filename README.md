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
| `/logout` | Expires the session cookie. Reached from the **Log out** button in the homepage header and the footer link, both shown only when a password is set. Bookmark it for shared machines. |

The old `/__relay_login` and `/__relay_logout` URLs redirect to these.
`/login` and `/logout` are short names that proxied sites use too, so a request
for one (GET or POST) whose `Referer` is a proxied page is treated as that
site's own link and repaired like any other escape; typed or bookmarked visits,
the relay's own login form and the login redirect (`?redirect=`) are the
relay's.

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

**Which version is live:** the homepage footer shows `build v0.11.0 ·
path-embedded`, and the diagnostic panel header shows `relay v0.11.0 — failed
requests`. (Before v0.9.0 the panel header never actually rendered — the
injected script was syntactically dead from v0.5.0 to v0.8.0; see
`CHANGELOG.md`.) If you don't see v0.11.0, you're testing an old deploy.

**Homepage controls:** the header has **Cookies** (the cookie manager),
**Sign out of sites** (one press clears every site's cookies in this browser)
and, when a password is set, **Log out** (ends the relay session). The same
links are in the footer. With no password set the homepage says the relay is
open to anyone with the address and that there is no relay login to log out of.

**IP widget:** under the address bar the homepage shows **you** — your real IP
as Cloudflare sees it, with country and network — and **sites see** — the IP the
relay fetches from, which is what the sites you visit see instead of yours —
plus the Cloudflare data center serving you, with a **refresh** link. In the
diagnostic panel the **IP** button shows the same two lines (it fetches only
when you press it, and the result is never stored or copied). "Sites see" is
measured from inside the Worker with an IP-echo service
(`api64.ipify.org`, `icanhazip.com`, `checkip.amazonaws.com`) and cached for a
minute; Cloudflare may use several outbound addresses, so it can vary from one
check to the next, and a failed lookup shows "unavailable". Your own IP is
never sent to the echo services — they only see the Worker's address. See the
privacy notes under *Limitations*, and set `IP_WIDGET` to `false` to remove the
widget and its `/__relay_ip` endpoint.

**Logging in:** sites you sign into stay signed in — see *Cookie jar* below.
Use a throwaway account to try it: your password passes through your Worker and
Cloudflare on its way to the site, and nothing here is safe for an account you
cannot afford to lose. `/cookies` lists the sites that have cookies in this
browser, with the cookie **names** (never values), and clears one site or all of
them; clearing signs you out of those sites. Login test sites are listed after
the checklist.

**Diagnostic panel:** on any proxied page, failures (non-2xx fetch/XHR,
WebSocket errors, resources that failed to load) collapse into a small
top-right button, `relay · N`. It never opens by itself: click to expand.
Inside, the first line (`page: …`) shows the current page's real URL, **IP**
shows your IP and the one sites see, **Link** copies a working relay link for
the page, and **Copy** puts the failure list on the clipboard without DevTools.
A failed request to a captcha provider is labelled as such. Cloudflare's own
`/cdn-cgi/` requests and preload failures are filtered out so they don't inflate
N. The panel exists on a page after its first failure, on real-path hosts, and
from page load when debug mode is on.

**Debug mode:** visit `https://relay.<username>.workers.dev/__relay_debug` to
turn on verbose diagnostics for 24 hours (a cookie; `/__relay_debug?on=0` turns
it off) — handy on a phone, where editing the worker for a flag isn't an
option. It logs clicks with no `<a>` in their path (`RELAY_LOG_NO_LINK`, not
failures — only useful when hunting for link-less navigation escapes), every
`pushState`/`replaceState` call as original → proxied (`RELAY_LOG_NAV`) and,
where the browser supports the Navigation API (Chromium), every navigation
including `location.href = …` assignments and form submissions. The log is
also kept in `sessionStorage`, so after a page jumps away (for example back to
a site's home page) the panel on the next page still shows what happened before
the jump. Failed `fetch`/XHR entries also include the first 200 characters of
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
  below. The visitor's IP is never forwarded (`CF-Connecting-IP`,
  `X-Forwarded-For` and friends are dropped).
- Timeout, one retry for bodyless requests, `Retry-After`-aware backoff on
  429/503, and a styled error page for Cloudflare edge failures.
- Caching: edge cache for static assets (GET only), keyed partly on the
  request's `Accept` header with per-status TTLs (`cacheTtlByStatus`);
  Cloudflare's fetch cache; long browser caching for static types. Only
  anonymous responses are cached: a request that carries jar cookies bypasses
  every cache, a response that sets cookies is never stored, HTML is never
  stored in the edge cache while the jar is on (a login page carries a CSRF
  token), and Cloudflare's fetch cache is limited to static assets. Large
  assets (>20 MB) skip the edge-cache copy. Range requests and HLS/DASH
  manifests (`.m3u8`, `.mpd`) bypass the blanket edge cache — a cached live
  playlist stalls playback.
- WebSockets are bridged browser to Worker to target, including subprotocol
  negotiation, the real `Origin` and the target's cookies. (A WebSocket
  handshake carries no `Referer`, so derived hostnames are not translated for
  sockets.)
- The relay answers `/favicon.ico` and `/robots.txt` at its own root, so
  those bare-origin requests never enter the target-recovery path. A target's
  own `/cdn-cgi/rum` and `/cdn-cgi/speculation` get a 204.
- **IP widget endpoint.** `/__relay_ip` (GET/HEAD, behind the password gate,
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

**Speed.** The injected script is built and minified once per Worker instance
(full-line comments and indentation stripped: about 61 KB → 31 KB added to every
page) and only the real path is substituted per request. The relay's Service
Worker registers a static route (Chromium's `addRoutes`) so requests whose path
already starts with an embedded URL skip the worker instead of waking it for
every subresource. Documents and API calls skip the edge-cache lookup (HTML is
never stored there); the cache key is built from the URL alone. The password
hash is computed once per instance; the cookie jar decodes only the cookies that
can apply to the requested host; the query-string check exits immediately when
the query does not mention the relay; link rewriting parses the page's base URL
once. In the browser, the `MutationObserver` skips nodes covered by an ancestor
added in the same batch and the diagnostic stale-link sweep waits for idle time.
Optional, off by default: `BLOCKED_HOSTS` answers analytics and ad hosts with an
empty 204 instead of fetching them (each is a full Worker round trip) — blocking
can break pages that expect those scripts, so it is a switch, not a default.

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
browser's `Cookie` header can never grow past what Cloudflare accepts. To turn
the jar off, set `COOKIE_JAR` to `false` at the top of `_worker.js` (redirects
and caching then behave as in v0.10.0; POST forms still go through the relay,
without cookies).

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
`EventSource`, `window.open`, `WebSocket`, `postMessage` (on the window
instance and on iframe windows as they are first touched),
`pushState`/`replaceState` and `form.submit()`; replaces `document.cookie`
with a shim over the cookie jar; reports real origins on `MessageEvent.origin`;
repairs captcha widget URLs; hooks `setAttribute`/`getAttribute` and the
`href`/`src`/`action` properties so URLs written by JS frameworks are proxied
at assignment and read back unmodified (this stops React reverting the
rewrite); points the `action` of forms that POST — including ones inserted by
JavaScript — through the relay; intercepts clicks and middle-clicks in the
capture phase; blocks the target site's own Service Worker registration. A
`MutationObserver` covers `innerHTML`-inserted content. Each risky patch is
wrapped in its own `try`/`catch` so one failing patch cannot silently disable
the rest.

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
`ScriptInjector.scriptText()`), so **`node --check _worker.js` does not validate
it.** A syntax error there stops the whole script in the browser while the outer
file still checks clean — this has happened twice: a stray brace (caught
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

`inj.js` is the client script exactly as the browser gets it (minified; real-path
mode on and cookie jar on — the constructor's arguments are the relay origin,
the real path and the jar flag; pass `''` and `false` to check the normal,
jar-off variants), `sw.js` the relay's Service Worker script. The Service Worker
script is also a template literal and has the same backslash rule.

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
site's.

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

---

## Quick test checklist

1. Homepage loads; footer shows `build v0.11.0 · path-embedded`; the header has
   **Cookies** and **Sign out of sites** (and **Log out** when a password is set;
   with no password the page says so).
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
   doesn't navigate. Copy produces the failure list. View the page source: the
   injected `<script>` has no comment lines or indentation.
8. Real-path hosts: `/https://react.dev` stays on the page (no redirect to a
   broken `https:/react.dev`) and shows `/` in the address bar; a GitHub repo
   opens its search-filter and "…" menus, and a GitHub search shows the real
   URL in the panel's `page:` row; `/https://www.bbc.com/news` renders without
   the "client-side exception" screen. Reload on a non-root real-path page
   lands back on the same site. A host outside the list (for example
   `gist.github.com`) keeps its embedded address.
9. With `COOKIE_JAR` set to `false`: `/https://bbc.com/news` ends on
   `www.bbc.com` with the address bar matching the final URL (redirect-follow
   check).
10. `/__relay_debug` shows "Relay debug mode: ON"; on any proxied page the
    `relay` button is then present from load, and it keeps entries from the
    previous page after a navigation. `/__relay_debug?on=0` turns it off.
11. Cookie plumbing, `httpbin.org` (or `httpbingo.org`): `/cookies/set?a=1&b=2`
    redirects to `/cookies` and shows both cookies; the relay's `/cookies`
    page then lists `httpbin.org` with `a` and `b`; `/cookies/delete?a` leaves
    only `b`; `/forms/post` submits a POST form and echoes it back;
    `/redirect/3` ends on the final page with the address bar correct;
    `/basic-auth/user/passwd` (user `user`, password `passwd`) authenticates.
12. A proxied site's own `/login` link (for example one on GitHub or BBC) takes
    you to that site's login page, not the relay's, whether or not a password
    is set — both as a link and as a form post.
13. A real login (see below): after logging in you stay signed in across a
    reload and across clicks to other pages; the site's cookie names appear on
    `/cookies`; the browser's own cookie view shows only `__rj_…` cookies on
    the relay's origin, not the site's own cookie names; logging out signs you
    out; **Clear** on `/cookies` signs you out; **Sign out of sites** on the
    homepage signs you out of every site.
14. Derived hostnames: a page that builds API names from its hostname (Proton's
    sign-up page) loads its human-verification step without a 502 for
    `relay-api.<your domain>`; in the panel (or debug log) the request went to
    the page's real API host. A captcha widget may still refuse — that is the
    provider's decision, not the relay's.
15. IP widget: the homepage shows your IP under **you** and a different IP
    under **sites see** (compare with what an IP-check site such as
    `httpbin.org/ip` reports when opened through the relay — that one is what a
    site really sees, and should match **sites see** or be another address from
    the same Cloudflare range); **refresh** re-checks; in a proxied page's panel
    the **IP** button shows the same two lines and the lines disappear from
    **Copy**.

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
  host with `__Host-` and `SameSite=Strict` cookies; use an account without
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
  the relay does not intercept), and the IP widget adds one more way to read it:
  every proxied page shares the relay's origin, so a script written to attack the
  relay could fetch `/__relay_ip`. The panel button is guarded (it fetches only
  on a real click, never stores the result, and keeps it out of Copy) and the
  homepage HTML never embeds an IP, but that is mitigation, not isolation; real
  isolation needs each site on its own origin (see the roadmap in the project
  notes). "Sites see" is a spot check from an outside echo service: Cloudflare
  may use several outbound addresses, sites on Cloudflare itself see further
  Cloudflare-specific signals, and the lookup can fail ("unavailable").
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
  the above: anything that validates its own origin in ways the relay cannot
  virtualize (consent and anti-bot SDKs often do), or loads origin-locked
  resources.
- The Service Worker route that skips the worker for proxied requests needs
  Chromium; other browsers wake the worker for every request, as before.
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
