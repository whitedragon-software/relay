# Relay test checklist (v0.13.0)

`RELAY` = your relay's address, for example `https://relay.whitedragon-dev.com`.
A site is opened as `RELAY/https://site.com`.

**How to use it.** Go tier by tier; each tier assumes the one before it passes. Every
item says what you should see. If something is off, turn the **debug bar** on in
Settings, reload, press **Copy** in the `relay` panel and send me the text with the
item number (for example "5.3"). Items marked **(partial)** or **(expected to fail)**
are included so you know what a failure there means; they are not bugs by themselves.

Sites change and some block datacenter addresses, so a site that fails in tier 6 or 8
is not proof of a relay fault: compare it with the same site opened directly.

---

## 0. Is it alive and configured (2 min)

- [ ] 0.1 `RELAY/__relay_health` shows `{"ok":true}`, also when signed out with a password set.
- [ ] 0.2 The homepage footer says `build v0.13.0`; the header has one **Settings** button.
- [ ] 0.3 The address field accepts `example.com` (no `https://`) and opens it.
- [ ] 0.4 `RELAY/https://gitbub.com` (typo) shows the relay's styled error page, not Cloudflare's.
- [ ] 0.5 `RELAY/https://127.0.0.1/`, `/https://localhost/` and `/https://169.254.169.254/` each show "Address not allowed" (403).
- [ ] 0.6 Settings opens; Light/Dark switch the theme and it survives a reload.
- [ ] 0.7 Settings → **Check my IP**: nothing before the press; then *you* and *sites see* differ.

## 1. Ordinary sites

- [ ] 1.1 `https://example.com` renders; its link opens `iana.org` and stays on the relay (address bar still `RELAY/https://…`).
- [ ] 1.2 `https://en.wikipedia.org/wiki/Cloudflare`: images, tables and the search box work; the language links stay on the relay.
- [ ] 1.3 `https://developer.mozilla.org/en-US/`: renders, the search suggestions appear, code samples display.
- [ ] 1.4 `https://news.ycombinator.com`: renders; opening a story and going back works.
- [ ] 1.5 `https://www.gnu.org`, `https://www.w3.org`: old-style static pages render with CSS.
- [ ] 1.6 Right-click a link → "Open in new tab": the new tab is on the relay too.
- [ ] 1.7 A page with a form (`https://httpbin.org/forms/post`): submit works and echoes your input.

## 2. Settings, privacy and the relay's own behaviour

- [ ] 2.1 **Browsing mode**: `RELAY/https://poki.com` is blank at first; add `poki.com` (suggestion button), reload: the portal renders and the bar shows `/en…`. Close the browser, reopen: still real-path. **Use original** undoes it.
- [ ] 2.2 `gist.github.com` is not affected by `github.com` being real-path (exact host match).
- [ ] 2.3 **Debug bar** on: the `relay` button appears on every page, with IP, Mode, Frames, Link, Copy. Off removes it.
- [ ] 2.4 Panel **Mode** on any page opens Settings with that site filled in.
- [ ] 2.5 **Privacy and sign-ins → WebRTC protection** on, then a WebRTC leak test page: it shows none of your addresses, or cannot connect. Off restores it.
- [ ] 2.6 **Keep sign-ins** and **Isolate site storage** toggle on/off with a confirmation message and survive a reload (details in tiers 4 and 9).
- [ ] 2.7 With a password set: any URL redirects to `/login`; after login you land on the page you wanted; `/logout` ends it; eight wrong passwords from one address show "Too many attempts"; another address is unaffected.
- [ ] 2.8 `POST` safety: open DevTools on another site and run `fetch('RELAY/settings',{method:'POST',body:'action=debug_on',headers:{'Content-Type':'application/x-www-form-urlencoded'}})`: the relay answers 403 (cross-site refused).
- [ ] 2.9 In DevTools → Network, any proxied page response has **no** `Strict-Transport-Security`, `Content-Security-Policy` or `X-Frame-Options`; Settings has `frame-ancestors 'self'`.
- [ ] 2.10 `RELAY/https://httpbin.org/response-headers?Strict-Transport-Security=max-age=1` : the response headers contain no `Strict-Transport-Security`.

## 3. Search engines

- [ ] 3.1 `https://duckduckgo.com/?q=cloudflare+workers`: results load; clicking one stays on the relay; All/Images/Videos/News tabs keep `duckduckgo.com` embedded; image thumbnails load.
- [ ] 3.2 `https://html.duckduckgo.com/html/?q=test` (lite version) works, including its form.
- [ ] 3.3 `https://www.bing.com/search?q=cloudflare`: results load; hover a result: it shows the relay prefix and the real target, not a `bing.com/ck/a` tracking address.
- [ ] 3.4 `https://search.brave.com/search?q=cloudflare`: results load and open on the relay.
- [ ] 3.5 `https://search.yahoo.com/search?p=cloudflare`: results load; clicking one goes straight to the target (no `r.search.yahoo.com/…/RU=` redirect page).
- [ ] 3.6 `https://www.startpage.com/do/search?q=test` **(partial)**: may show a consent or bot page.
- [ ] 3.7 `https://www.google.com/search?q=test` **(expected to fail or partly)**: a consent page, a "sorry" captcha page or empty results are Google refusing a datacenter address, not the relay. If results do appear, the result links must not go through `/url?q=`.
- [ ] 3.8 Search suggestions (type in any engine's box): the dropdown fills without console errors.

## 4. Logins, cookies and sessions

- [ ] 4.1 `RELAY/https://httpbin.org/cookies/set?a=1&b=2` → shows both cookies; Settings → Cookie jar lists `httpbin.org` (2 cookies); `/cookies/delete?a` leaves only `b`.
- [ ] 4.2 `https://the-internet.herokuapp.com/login` (`tomsmith` / `SuperSecretPassword!`): you log in, see the one-time green flash message after the redirect, stay logged in after a reload; **Logout** works.
- [ ] 4.3 `https://www.saucedemo.com` (`standard_user` / `secret_sauce`): login works (the page's own JavaScript writes a cookie); the cart persists across pages.
- [ ] 4.4 `https://opensource-demo.orangehrmlive.com` (`Admin` / `admin123`): a single-page app with a CSRF token and an XHR login works.
- [ ] 4.5 `https://httpbin.org/basic-auth/user/passwd`: the browser asks for credentials once; `user` / `passwd` opens the page. Then open a different site: it does **not** receive those credentials.
- [ ] 4.6 **Logout through Clear-Site-Data:** after 4.1, open `RELAY/https://httpbin.org/response-headers?Clear-Site-Data=%22cookies%22`; Settings → Cookie jar no longer lists `httpbin.org`.
- [ ] 4.7 **Keep sign-ins:** with it **off**, log in at 4.2, close the whole browser, reopen: signed out. Turn it **on**, log in again, close and reopen: still signed in.
- [ ] 4.8 Settings → Cookie jar → **Clear** for one site signs you out of it only; **Clear all cookies** signs you out of all.
- [ ] 4.9 Real login on a real service with a **throwaway account**: `https://news.ycombinator.com/login`, `https://en.wikipedia.org/w/index.php?title=Special:UserLogin`. Stays signed in across clicks.
- [ ] 4.10 `https://github.com/login` with `github.com` switched to real path **(partial)**: the form loads and posts; 2FA or a new-device check may block it.
- [ ] 4.11 Heavy cookie sites **(partial)**: `https://www.amazon.com` or `https://www.microsoft.com` load while signed out; a sign-in there is expected to be refused or to loop.
- [ ] 4.12 "Sign in with Google/Microsoft/Facebook" popups **(expected to fail)**: the popup opens on the relay; the provider rejects the browser or loops. A failure here is not a relay bug.

## 5. Captchas and bot checks

Open each demo, then in the panel (debug bar on) check the failures for entries labelled "captcha provider".

- [ ] 5.1 `https://www.google.com/recaptcha/api2/demo`: the "I'm not a robot" box renders with **no** "Invalid domain for site key" error. Solving it and pressing Submit **(partial)**: Google may show an image challenge or refuse.
- [ ] 5.2 `https://accounts.hcaptcha.com/demo`: the widget renders, no "invalid domain"; solving **(partial)**.
- [ ] 5.3 `https://demo.turnstile.workers.dev/`: the Turnstile widget renders and usually finishes by itself (Turnstile reads the page's origin through a message, which the relay virtualises).
- [ ] 5.4 `https://2captcha.com/demo/recaptcha-v2` and `https://2captcha.com/demo/hcaptcha`: widgets render with the correct site name.
- [ ] 5.5 `https://www.geetest.com/en/demo`: the slider or icon widget loads **(partial)**.
- [ ] 5.6 A site behind Cloudflare's "Checking your browser" interstitial **(expected to fail)**: the check page appears; the clearance is tied to your own address and does not carry over to the relay's. A loop here is the known limit.
- [ ] 5.7 `https://nowsecure.nl` or another bot-detection test **(expected to fail)**: shown only so you know what "blocked" looks like.

## 6. Streaming: video, audio and live data

Network tab check for every item: media requests go to the relay origin, not to a CDN directly.

- [ ] 6.1 HTML5 video from a static file: `https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4` plays; **seeking** to the middle works immediately (a `206` response, no full re-download).
- [ ] 6.2 Audio: any `.mp3` (for example on `https://archive.org`): plays and seeks.
- [ ] 6.3 **HLS:** `https://hls-js.netlify.app/demo/` with the default Big Buck Bunny test stream: playback starts, quality switching works, **every** `.ts`/`.m4s` and key request goes to the relay (absolute URLs inside the playlist were rewritten).
- [ ] 6.4 **HLS direct:** open `RELAY/https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8` as text: absolute and root-relative entries now start with `RELAY/https://…`; plain relative entries are unchanged.
- [ ] 6.5 **DASH:** `https://reference.dashif.org/dash.js/latest/samples/dash-if-reference-player/index.html` with a default stream: plays; the manifest's `BaseURL` entries are on the relay.
- [ ] 6.6 `https://archive.org/details/BigBuckBunny_124`: the built-in player plays.
- [ ] 6.7 Server-Sent Events: `https://stream.wikimedia.org/v2/stream/recentchange` shows a continuous flow of `data:` lines (streamed, not buffered until the end).
- [ ] 6.8 Chunked streaming: `RELAY/https://httpbin.org/stream/20` shows 20 JSON lines; `RELAY/https://httpbin.org/drip?duration=5&numbytes=5` fills in over 5 seconds rather than all at once.
- [ ] 6.9 Live-style playlist **(partial)**: a public live HLS test stream keeps advancing (the playlist is never cached).
- [ ] 6.10 YouTube `https://www.youtube.com/watch?v=aqz-KE-bpKQ` **(partial)**: the page loads and video may play; changes by Google may break it. Failures to note: which request in the panel failed.
- [ ] 6.11 Twitch / Vimeo / Dailymotion **(partial)**: the page loads; playback depends on each site's own checks.
- [ ] 6.12 Netflix, Spotify web, Disney+ **(expected to fail)**: DRM-protected playback cannot work through any proxy.

## 7. Downloads and encodings

- [ ] 7.1 `https://proof.ovh.net/files/10Mb.dat`: downloads in full with the right file name and a progress bar (a `Content-Length`).
- [ ] 7.2 A 100 MB file (`https://proof.ovh.net/files/100Mb.dat`): downloads without stalling; **pause and resume** in the browser's download manager continues (a `Range` request).
- [ ] 7.3 `RELAY/https://httpbin.org/range/4096`: returns 4096 bytes; with DevTools: `fetch('RELAY/https://httpbin.org/range/4096',{headers:{Range:'bytes=0-9'}})` answers `206` with 10 bytes.
- [ ] 7.4 A GitHub release asset: from a release page click an asset: it redirects through `objects.githubusercontent.com` and downloads with the right name.
- [ ] 7.5 **HTML sent as a download:** `RELAY/https://httpbin.org/response-headers?Content-Type=text/html&Content-Disposition=attachment%3B%20filename%3Dx.html` downloads a file; opening it shows the original text with **no** relay scripts inside.
- [ ] 7.6 `<a download>` links on a page download rather than navigate; a `blob:` download made by a page (for example "Export" in `https://excalidraw.com`) works.
- [ ] 7.7 A PDF (`https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf`) opens in the browser viewer.
- [ ] 7.8 Compression: `RELAY/https://httpbin.org/gzip`, `/brotli`, `/deflate` each show JSON with the right flag set.
- [ ] 7.9 **Character sets:** open an older site in Shift_JIS, GBK or windows-1251 (a university department page, a classic forum); the text is readable, not mojibake. DevTools shows `Content-Type: text/html; charset=…` matching the original. A UTF-8 page still shows non-ASCII text correctly.
- [ ] 7.10 Images: `RELAY/https://httpbin.org/image/webp`, `/image/png`, `/image/svg` display.

## 8. Complex sites and single-page apps

For each: does it load, does navigation inside it work, does the panel show errors worth reporting?

- [ ] 8.1 `https://react.dev` (real path): stays on the page; the sidebar and search work.
- [ ] 8.2 `https://github.com` (real path): a repository page opens; the file tree, the "…" menus and code search work; a GitHub search keeps the real URL in the panel's `page:` row.
- [ ] 8.3 `https://www.bbc.com/news` (real path): renders without the "client-side exception" screen.
- [ ] 8.4 `https://www.openstreetmap.org`: the map tiles load (many small image requests) and dragging/zooming is smooth.
- [ ] 8.5 `https://excalidraw.com` **(complex)**: loads; drawing works; the share/collab link connects (WebSocket); the scene survives a reload (IndexedDB/localStorage).
- [ ] 8.6 `https://www.desmos.com/calculator`: plots; the keyboard and sliders work.
- [ ] 8.7 `https://codepen.io` / `https://jsfiddle.net` **(complex)**: the editor loads; the preview iframe renders your code.
- [ ] 8.8 `https://regex101.com`, `https://app.diagrams.net` **(complex)**: load and are usable.
- [ ] 8.9 `https://www.npmjs.com`, `https://stackoverflow.com` **(partial)**: Cloudflare-fronted; may show a bot check.
- [ ] 8.10 `https://www.reddit.com`, `https://x.com` **(expected to fail or partly)**: login walls and bot checks.
- [ ] 8.11 `https://discord.com/app`, `https://web.whatsapp.com` **(expected to fail)**: heavy WebSocket, service-worker and fingerprint checks.
- [ ] 8.12 Single-page-app navigation: on `https://react.dev` or `https://www.openstreetmap.org`, use the browser **Back** and **Forward** buttons after several in-page clicks: the page follows and the address bar stays valid.
- [ ] 8.13 **Navigation guard (Chromium):** on any proxied page, in the console `location.href='https://example.org'` lands on `RELAY/https://example.org`, not the real site.
- [ ] 8.14 `window.open`: in the console `window.open('https://example.org')` opens a **relay** tab.
- [ ] 8.15 **Edge cases** (`httpbin.org`): `/redirect/5` ends on the final page with the right address; `/status/204` and `/status/404` show the right status, not the relay's 500 page; `/anything?x=1&y=2` echoes the query; `/delay/3` completes; `/headers` shows `Sec-Fetch-Site` (and no `X-Forwarded-For`, `Via` or `Cf-*` headers).
- [ ] 8.16 Timeouts: `RELAY/https://httpbin.org/delay/25` ends with a readable "did not answer within 20 seconds" page (not a hang); `RELAY/https://httpbin.org/delay/25?transport=polling` waits and **succeeds** (long-poll allowance).
- [ ] 8.17 A very long URL (a 5,000-character query) loads; a 9,000-character one shows the "address is too long" page.
- [ ] 8.18 A site on a non-default port (`https://example.com:8443` **(partial)** if available) and an IDN host (`https://münchen.de`) open.

## 9. Storage isolation (Settings → Privacy and sign-ins → Isolate site storage)

- [ ] 9.1 With isolation **off**: on `RELAY/https://example.com` run `localStorage.k='A'` in the console; on `RELAY/https://example.org` run `localStorage.k` → `'A'` (the shared-origin collision).
- [ ] 9.2 Turn isolation **on**, reload both pages: `example.org` now sees `null` for `k`; `example.com` sees its own values only.
- [ ] 9.3 `indexedDB.databases()` and `caches.keys()` on each site list only that site's names (without the prefix).
- [ ] 9.4 The relay still works: the debug panel keeps its log across a page jump, and the navigation guard still counts (they use the real session storage).
- [ ] 9.5 Sites that use storage heavily still run with isolation on: `https://excalidraw.com`, `https://www.desmos.com/calculator`. A site that looked signed in before may need signing in once; that is expected.
- [ ] 9.6 Turning isolation **off** again returns the shared view; data written while it was on is no longer visible, and data written before is visible again.

## 10. Games and multiplayer

- [ ] 10.1 `https://poki.com` (real path): the portal renders; a game (Tiger Tank, Subway Surfers…) opens in its iframe, runs, and no `relay` button covers it.
- [ ] 10.2 Reload a game you already played: it starts faster and the Network tab shows `.wasm`/`.data` from cache.
- [ ] 10.3 `https://www.crazygames.com` (real path) **(partial)**: the portal loads and stays on the relay; many games open. A game showing "Oooops … can be played exclusively on CrazyGames.com" is CrazyGames' own embedding block (see the README, *Game frames*). With a second hostname set: press **Frames** in the game's iframe and report what it prints.
- [ ] 10.4 `https://playhop.com` (real path) **(partial)**: portal loads; games depend on the Yandex SDK's own hostname checks.
- [ ] 10.5 `https://itch.io/games/html5`: open an HTML5 game page; it runs in its iframe.
- [ ] 10.6 `https://html5.gamedistribution.com` demo game **(partial)**.
- [ ] 10.7 **WebSocket echo:** `https://echo.websocket.org/.ws` (or `https://www.piesocket.com/websocket-tester`) connects and echoes; the debug panel shows `WS OPEN` and, on closing, `WS CLOSE 1000 … s, N messages`.
- [ ] 10.8 **socket.io:** `https://socket.io/demos/chat/`: join, send messages, open a second tab and see them arrive (polling then upgrade to WebSocket).
- [ ] 10.9 **Lichess:** `https://lichess.org`: play a bot or open a puzzle; moves register instantly (WebSocket); the lobby shows live games.
- [ ] 10.10 **OpenFront:** `https://openfront.io` (add it to real path in Settings first): the lobby loads and a game connects. If not, with the debug bar on read the `WS` lines: `4403` = the server refused the handshake, `4502` = unreachable, `WS CLOSE 1006 … after N s` = it dropped after connecting. Report them.
- [ ] 10.11 `https://skribbl.io`: join a public room and see other players (socket.io).
- [ ] 10.12 `https://tetr.io` or `https://slither.io` **(partial)**: connects; fast WebSocket traffic; note latency.
- [ ] 10.13 Failed handshake diagnostics: with the debug bar on, open a WebSocket to a server that refuses you (`new WebSocket('RELAY'.replace('https','wss')+'/wss://echo.websocket.org/x')` may refuse): the panel shows `WS … 4403 target refused the socket (HTTP 403)` or similar, not a bare 1006.
- [ ] 10.14 Idle: leave a lobby idle for two minutes; note whether the socket drops (the free plan can close an idle socket).
- [ ] 10.15 **Page origin on sockets:** open DevTools → Network → WS on a game site: the socket URL contains `__relay_po=`; (server side) a game server that checks `Origin` accepts the connection.
- [ ] 10.16 Latency feel: a fast game (10.12) is playable. If it lags, note your location and try Smart Placement (README, *Speed*).

## 11. Privacy and leaks

- [ ] 11.1 `https://httpbin.org/ip` through the relay shows the relay's address, not yours.
- [ ] 11.2 `https://httpbin.org/headers` shows no `X-Forwarded-For`, `X-Real-Ip`, `True-Client-Ip`, `Via`, `Forwarded` or `Cf-*` headers, and `Sec-Fetch-Site` is `cross-site` for an embedded third-party request and `none`/`same-origin` for a typed address.
- [ ] 11.3 In the console `navigator.sendBeacon('https://httpbin.org/post','x')` appears in Network as a request to the **relay**.
- [ ] 11.4 `new Worker('https://example.com/x.js')` in a console: the request goes to the relay.
- [ ] 11.5 `document.referrer` inside a page opened from another proxied page shows the real referring URL, not `RELAY/https://…`.
- [ ] 11.6 WebRTC: see 2.5.

## 12. Known limits (confirm you see these, so you recognise them)

- [ ] 12.1 `import('https://cdn.example/x.js')` in page code and absolute `url(https://…)` inside a stylesheet are fetched **directly** (not through the relay): shown in Network.
- [ ] 12.2 Two real-path sites open at once, then reload the older tab: it may land on the wrong site (the shared context cookie).
- [ ] 12.3 A game or SDK that reads `location.hostname` of its own document, or `location.ancestorOrigins`, refuses to run (CrazyGames' block, the Yandex SDK).
- [ ] 12.4 Firefox / older Safari: the navigation guard is inactive (no Navigation API), so a script assigning `location` to the real site can leave the relay.

---

### What to send me when something fails

1. The item number (for example `7.5`).
2. What you saw versus what the item says should happen.
3. The debug-bar log: Settings → Debug bar → on, reload the page, open the `relay` panel, press **Copy**, paste.
4. For games: also press **Frames** inside the game's iframe and paste what it shows.
5. Whether the same page works when opened directly, without the relay.
