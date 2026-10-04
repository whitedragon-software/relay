# Changelog

Versions are identified by the **build marker** shown in the homepage footer
and in the diagnostic panel header (e.g. `B11-AUTHFIX`). If you don't see the
marker you expect, you're running an older deploy and any test result is
meaningless.

Only builds that improved something are listed. `B7-MOUSEDOWN` is omitted: it
added a diagnostic that was removed again before the next build, so it changed
nothing lasting. For the session-by-session narrative (including dead ends),
see `DEVLOG.md`.

Entries marked **unconfirmed live** were verified with isolated tests only; the
sandbox this was built in cannot load real sites through a deployed Worker.

---

## B11-AUTHFIX

### Fixed
- **Open redirect in the login flow (security).** The `redirect` value is
  user-controlled and was appended directly to the relay's origin. `@evil.com`
  parses as userinfo (host becomes `evil.com`) and `.evil.com` as a subdomain
  of the relay, so a crafted login link could send someone off-site after a
  correct password. `safeRedirectPath()` now requires a single leading `/`.
  **B10 shipped with this hole. If you deployed B10, upgrade.**
  Tested by extracting the real function from `relay.js` and running it against
  every escape vector. (A check I wrote earlier for this passed trivially and
  proved nothing; it was replaced.)
- **DuckDuckGo tab switching lost the embedded domain** (All -> Images /
  Videos / News produced `relay/?ia=images&q=...` with no `duckduckgo.com`).
  DDG ships `<meta name="referrer" content="origin">`, which makes the browser
  send only the bare origin as `Referer`; the server-side recovery that rebuilds
  a lost target needs the full path. `MetaReferrerRewriter` now forces
  `unsafe-url` on `meta[name=referrer]` and `meta[http-equiv=Referrer-Policy]`.
  This is not a new exposure specific to the relay: every request already
  passes through the Worker, and browser-to-relay is same-origin, which the
  default policy already sends in full.
  **Unconfirmed live.** The before/after recovery logic is tested in
  isolation; the real DDG tab flow has not been re-tested.

### Added
- **Clean login URL.** Unauthenticated requests redirect to
  `/__relay_login?redirect=...` instead of rendering the form at whatever URL
  was requested.
- **Logout.** `/__relay_logout` expires the session cookie and returns to the
  login page. A "log out" link appears in the homepage footer when `PASSWORD`
  is set. Intended for shared or public machines.

### Changed
- A wrong password now redirects back to the login page (POST-redirect-GET), so
  refreshing no longer triggers the browser's "resend form data" warning.

---

## B10-AUTH

### Added
- **Optional password gate** via the `PASSWORD` environment variable.
  Unset (the default), the relay behaves exactly as before.
- When set, the gate runs first in `fetch()`, before WebSocket upgrades, the
  Service Worker script, and everything else.
- The session cookie stores a **SHA-256 hash**, not the password. It is
  `HttpOnly; Secure; SameSite=Lax` with a 30-day lifetime.
- Lean login page (own small template; dark mode via `prefers-color-scheme`).

### Known issues shipped in this build
- Open redirect in the `redirect` parameter (fixed in B11).
- No rate limiting on attempts, and the password comparison is not
  timing-safe. Fine for keeping a personal relay away from casual scanners;
  not suitable for protecting anything sensitive.

---

## B9-LEAN

### Changed (performance; no feature intentionally removed)
- Dropped a `String(name).toLowerCase()` allocation from the `getAttribute` /
  `setAttribute` hooks. Those fire on **every** attribute access on the page,
  not just `href`/`src`, so it was wasted work for the vast majority of calls.
  Trade-off: `getAttribute("HREF")` in unusual uppercase form is no longer
  intercepted. React, JSX and normal DOM code use lowercase.
- Removed the `mouseover` re-assertion handler. It only existed to win a race
  against React reverting a rewrite, which B8 made unnecessary.
- `MutationObserver` now watches `childList` only. Attribute writes are caught
  at the source by the B8 hooks; `childList` is still needed for
  `innerHTML`-inserted content, which bypasses `setAttribute` entirely.
- About 29 lines shorter overall.

---

## B8-PROPHOOK

### Added
- **Preemptive URL interception.** Hooks on `Element.prototype.setAttribute` /
  `getAttribute` and on the `href` / `src` / `action` / `data` property
  descriptors of anchors, areas, scripts, images, links, iframes, video, audio,
  sources, objects and forms.
  - Writes are converted to proxied form at the moment of assignment, so the
    raw URL never lands in the DOM (nothing for a hover preview to show).
  - Reads return the **original** URL, so frameworks like React see exactly what
    they wrote, find no mismatch, and stop reverting the rewrite. This is what
    the earlier reactive approaches (observer, polling, re-assertion on hover)
    could not achieve, because they were racing a revert loop.
  - Technique taken from a reference implementation (cf-proxy-ex). Only this
    technique was adopted; its location string-replacement, cookie handling,
    password page and `document.write` approach were not.
- **Search-engine data rewriting.** `SEARCH_DATA_HOSTS` (currently only
  `links.duckduckgo.com`): embedded URLs in that host's response bodies are
  rewritten server-side, including JSON-escaped (`\/`) forms, before the page's
  JS parses them. Deliberately narrow; a general "rewrite URLs in any JS
  response" rule would risk corrupting application bundles. Excluded from the
  long-cache path since results are query-specific.

### Fixed
- Our own `relayRewriteElement` and click handler now read the raw stored value
  through the native accessors. With the hooks installed, the hooked getter
  returns the unwrapped original, which defeats the "already proxied" check and
  causes an infinite rewrite loop with the observer (reproduced in a test).
- A syntax error I introduced in the injected script (a stray `}, true);` left
  by a refactor) that would have stopped the **entire** script from running.
  `node --check relay.js` cannot catch this, because the injected script is a
  string inside a template literal. Verification now extracts the injected
  script and checks it separately (see README).

### Removed
- The `mousedown` + `localStorage` click diagnostic from B7.

**Unconfirmed live:** that DuckDuckGo result links no longer escape the proxy.
This build targets the mechanism identified for that bug; no live confirmation
was recorded.

---

## Before build markers (unversioned)

Everything below predates the marker system. In rough order of importance:

- **Path-embedded URL scheme** (`/https://example.com/...`) so relative
  imports, chunks and CSS `url()` resolve natively. Legacy `?url=` links 301 to
  it. Requests that reach the bare origin are repaired server-side from the
  `Referer`, with a Service Worker as backstop.
- **`HTMLRewriter` coverage:** anchors, images, scripts, links, iframes,
  media, embeds, objects, `srcset`, `<meta http-equiv="refresh">`, GET forms
  (stashed in `data-proxy-target` because native GET submission discards the
  action's query string).
- **Upstream fidelity:** real method and body forwarded; header **denylist**
  (custom headers such as DuckDuckGo's `x-vqd-4` survive); `Referer`/`Origin`
  corrected to the real target; the visitor's real `User-Agent` forwarded;
  relative URLs resolved against the post-redirect URL; self-referential
  targets refused; 8000-character target cap.
- **Resilience:** per-request timeout, one retry for bodyless requests,
  `Retry-After`-aware backoff on 429/503, Cloudflare edge-error detection
  (520-527, 530) with a styled page instead of passing Cloudflare's own page
  through.
- **Caching:** edge cache for HTML and static assets (GET only), Cloudflare
  fetch-layer cache, long browser `Cache-Control` for static types, 20 MB cap
  on edge-caching large assets.
- **WebSocket bridge** (`WebSocketPair`) with subprotocol negotiation and
  `Origin` set to the real target; client-side `WebSocket` patch that recovers
  URLs built from `location.origin`.
- **Client-side patches:** `fetch`, XHR, `EventSource`, `window.open`,
  `postMessage` (target origin widened to `*`), `pushState`/`replaceState`
  with `<base>` kept in sync, `form.submit()`, blocking the target site's own
  Service Worker registration, `navigator.onLine` forced true.
- **Link interception:** capture phase with `stopImmediatePropagation`,
  `composedPath()` for Shadow DOM, `aria-haspopup` as the only skip signal
  (`aria-expanded` and `role="button"` were tried and removed: both are common
  on real navigating links), "already proxied" short-circuit, `auxclick`
  (middle-click), `target="_blank"` through `window.open`.
- **Failure isolation:** every native-prototype reassignment wrapped in its own
  `try`/`catch`, so one failing patch cannot silently disable the ones after it.
- **Tracking-redirect decoding** (Google `/url?q=`, Bing `/ck/a`, DuckDuckGo
  `/l/?uddg=`) on both server and client.
- **UI:** light/dark homepage, styled error pages, on-page diagnostic panel
  (failed fetch/XHR/WebSocket/resource loads, copyable).
- **Reverted experiments:** a 400 ms whole-document polling loop (disproportionate
  for a cosmetic issue) and the `role="button"` skip signal.
