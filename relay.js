// Cloudflare Workers forwarding proxy — path-embedded scheme.
//
// Target URLs are embedded directly in the proxy's path instead of a query
// param: https://proxy.dev/https://example.com/page?x=1
// (Old bookmarks using ?url=... still work as a fallback.)
//
// Why: putting the real URL in the *path* preserves real directory
// structure, so the browser's native relative-URL resolution — used by ES
// module imports, webpack/rollup chunk loading, CSS url()/@import, etc. —
// resolves correctly on its own. None of that is reachable by rewriting
// HTML or by JS interception, since it happens inside already-fetched JS/CSS
// files we never parse. A query-string scheme collapses everything to the
// proxy's root path, so any such relative reference breaks.
//
// Root-relative references (a raw "/api/x") still can't be fixed by path
// structure alone — a leading "/" always resolves against the *origin*,
// discarding any path prefix, by spec. Click/submit/fetch/XHR are handled by
// injected JS. Direct `location.href = '/x'` or `location.assign('/x')`
// calls made by page JS can't be — you can't intercept assignment to
// `window.location` from a page script (redefining it throws in modern
// browsers).
//
// Every request that reaches the Worker without a properly embedded target
// is corrected server-side using the request's Referer header (see below) —
// this is the primary fix and works immediately, on the very first request.
// A Service Worker is also registered as a backstop for cases where a
// Referer isn't sent (stripped by a privacy setting, etc).
//
// Hardening notes:
// - The real request method/body/relevant headers are forwarded upstream
//   (previously every upstream fetch was an implicit GET, silently
//   dropping POST bodies from proxied fetch/XHR calls).
// - Relative URLs are resolved against upstream.url (the FINAL URL after
//   any redirects), not the originally-requested one, so a target that
//   redirects elsewhere doesn't break every relative link on the result.
// - A self-referential target (proxying the relay's own origin) is refused
//   to avoid recursive self-fetches.
// - WebSocket connections are bridged (see handleWebSocketUpgrade and the
//   client-side WebSocket override below) — browser <-> Worker <-> real
//   target, including converting the handshake's Origin header to the real
//   target's own origin, since many WS servers reject a mismatched one.

const SW_PATH = '/__proxy_sw.js';

const SW_SCRIPT = `
// Without these, a newly-deployed version of this script doesn't take over
// an already-open tab until every tab using the OLD version is closed —
// standard SW lifecycle behavior, but it means a redeploy can silently
// leave a browser running stale logic indefinitely, causing confusing
// behavior that only a hard reload (forcing a fresh update check) fixes.
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Already correctly path-embedded, or the SW script/root usage page — leave alone.
  if (/^\\/https?:\\/\\//.test(url.pathname)) return;
  if (url.pathname === '${SW_PATH}') return;
  if (url.pathname === '/' && !url.search) return;

  // A request landed at our bare origin with no embedded target — recover
  // the real site from whichever proxied page issued it.
  const ref = req.referrer;
  if (!ref) return;
  try {
    const refUrl = new URL(ref);
    const embedded = refUrl.pathname.slice(1);
    const m = embedded.match(/^(https?:\\/\\/[^/]+)/);
    if (!m) return;
    const corrected = self.location.origin + '/' + m[1] + url.pathname + url.search;
    event.respondWith(Response.redirect(corrected, 302));
  } catch (e) {
    // fall through to default handling
  }
});
`;

const HOME_HTML = `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Relay</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #FFFFFF;
    --surface: #F6F6F5;
    --border: #E1E1DE;
    --text: #131316;
    --text-dim: #6C6C72;
    --accent: #2547F4;
    --accent-dim: #E9ECFE;
    --warn: #C7431E;
  }
  html[data-theme="dark"] {
    --bg: #0A0A0C;
    --surface: #151517;
    --border: #29292D;
    --text: #F1F1EF;
    --text-dim: #8B8B91;
    --accent: #6C89FF;
    --accent-dim: #16193A;
    --warn: #FF8A63;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: 'Space Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    -webkit-font-smoothing: antialiased;
    transition: background 0.25s ease, color 0.25s ease;
  }
  .wrap {
    min-height: 100%;
    display: flex;
    flex-direction: column;
    max-width: 640px;
    margin: 0 auto;
    padding: 28px 24px 60px;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: clamp(48px, 12vh, 96px);
  }
  .mark {
    display: flex;
    align-items: center;
    gap: 10px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    letter-spacing: 0.08em;
    color: var(--text-dim);
    text-transform: uppercase;
  }
  .mark .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
  }
  .theme-toggle {
    width: 34px;
    height: 34px;
    border-radius: 4px;
    border: 1px solid var(--border);
    background: var(--surface);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    color: var(--text);
    transition: border-color 0.15s ease;
  }
  .theme-toggle:hover { border-color: var(--text-dim); }
  .theme-toggle svg { width: 15px; height: 15px; }

  main { flex: 1; }

  .eyebrow {
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--accent);
    margin: 0 0 14px;
  }
  h1 {
    font-size: clamp(36px, 7vw, 52px);
    font-weight: 600;
    line-height: 1.05;
    letter-spacing: -0.02em;
    margin: 0 0 16px;
  }
  .sub {
    font-size: 16px;
    line-height: 1.5;
    color: var(--text-dim);
    max-width: 46ch;
    margin: 0 0 40px;
  }

  form { margin-bottom: 56px; }
  .field {
    display: flex;
    align-items: center;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--surface);
    transition: border-color 0.15s ease;
  }
  .field:focus-within { border-color: var(--accent); }
  .field input {
    flex: 1;
    border: 0;
    background: transparent;
    outline: none;
    padding: 16px 4px 16px 16px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 14px;
    color: var(--text);
  }
  .field input::placeholder { color: var(--text-dim); }
  .field button {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 46px;
    height: 46px;
    margin: 4px;
    border: 0;
    border-radius: 3px;
    background: var(--accent);
    color: var(--bg);
    cursor: pointer;
    flex-shrink: 0;
    transition: opacity 0.15s ease;
  }
  html[data-theme="dark"] .field button { color: #0A0A0C; }
  .field button:hover { opacity: 0.85; }
  .field button svg { width: 17px; height: 17px; }
  .hint {
    margin: 10px 2px 0;
    font-size: 13px;
    color: var(--text-dim);
    min-height: 18px;
  }
  .hint.error { color: var(--warn); }

  .trace {
    display: flex;
    align-items: center;
    gap: 0;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--text-dim);
  }
  .trace .node { display: flex; flex-direction: column; align-items: center; gap: 8px; flex-shrink: 0; }
  .trace .node span.sq {
    width: 9px; height: 9px;
    border: 1px solid var(--text-dim);
  }
  .trace .node.active span.sq { background: var(--accent); border-color: var(--accent); }
  .trace .line {
    flex: 1;
    height: 1px;
    background: var(--border);
    position: relative;
    margin: 0 -1px;
    top: -13px;
  }
  .trace .line .pulse {
    position: absolute;
    top: -2px;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--accent);
    animation: travel 3.2s linear infinite;
  }
  @keyframes travel {
    0% { left: 0%; opacity: 0; }
    8% { opacity: 1; }
    92% { opacity: 1; }
    100% { left: 100%; opacity: 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    .trace .line .pulse { animation: none; opacity: 0.6; left: 50%; }
  }

  footer {
    margin-top: 64px;
    padding-top: 20px;
    border-top: 1px solid var(--border);
    display: flex;
    justify-content: space-between;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: var(--text-dim);
    letter-spacing: 0.04em;
  }

  @media (max-width: 460px) {
    .trace .node span.label { display: none; }
  }
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <div class="mark"><span class="dot"></span>relay</div>
      <button class="theme-toggle" id="themeToggle" aria-label="Switch theme" type="button">
        <svg id="themeIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
          <circle cx="12" cy="12" r="4.6"></circle>
          <path d="M12 2.4v2.4M12 19.2v2.4M4.4 12H2M22 12h-2.4M5.6 5.6l1.7 1.7M16.7 16.7l1.7 1.7M5.6 18.4l1.7-1.7M16.7 7.3l1.7-1.7"></path>
        </svg>
      </button>
    </header>

    <main>
      <p class="eyebrow">// relay</p>
      <h1>Route any address<br>through here.</h1>
      <p class="sub">Enter a URL. It loads through this relay, links and scripts included, without leaving the address bar.</p>

      <form id="goForm" autocomplete="off">
        <div class="field">
          <input id="urlInput" type="text" inputmode="url" placeholder="example.com/path" spellcheck="false" autofocus>
          <button type="submit" aria-label="Go">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square">
              <path d="M4 12h15M13 6l6 6-6 6"></path>
            </svg>
          </button>
        </div>
        <p class="hint" id="hint">Prefix is optional — https:// is assumed.</p>
      </form>

      <div class="trace" id="trace">
        <div class="node active"><span class="sq"></span><span class="label">you</span></div>
        <div class="line"><span class="pulse"></span></div>
        <div class="node"><span class="sq"></span><span class="label">relay</span></div>
        <div class="line"><span class="pulse" style="animation-delay: 1.6s;"></span></div>
        <div class="node"><span class="sq"></span><span class="label">target</span></div>
      </div>
    </main>

    <footer>
      <span id="originLabel"></span>
      <span>build B10-AUTH · path-embedded</span>
    </footer>
  </div>

<script>
(function() {
  var root = document.documentElement;
  var sunPath = 'M12 2.4v2.4M12 19.2v2.4M4.4 12H2M22 12h-2.4M5.6 5.6l1.7 1.7M16.7 16.7l1.7 1.7M5.6 18.4l1.7-1.7M16.7 7.3l1.7-1.7';
  var moonPath = 'M20 14.6A8.4 8.4 0 1 1 9.4 4a6.7 6.7 0 0 0 10.6 10.6z';

  function applyIcon(theme) {
    var circle = document.querySelector('#themeIcon circle');
    var path = document.querySelector('#themeIcon path');
    if (theme === 'dark') {
      if (circle) circle.setAttribute('r', '0');
      path.setAttribute('d', moonPath);
    } else {
      if (circle) circle.setAttribute('r', '4.6');
      path.setAttribute('d', sunPath);
    }
  }

  var saved = null;
  try { saved = localStorage.getItem('relay-theme'); } catch (e) {}
  var theme = saved || 'light';
  root.setAttribute('data-theme', theme);
  applyIcon(theme);

  document.getElementById('themeToggle').addEventListener('click', function() {
    theme = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', theme);
    applyIcon(theme);
    try { localStorage.setItem('relay-theme', theme); } catch (e) {}
  });

  document.getElementById('originLabel').textContent = location.origin.replace(/^https?:\\/\\//, '');

  var input = document.getElementById('urlInput');
  var hint = document.getElementById('hint');
  var trace = document.getElementById('trace');

  function go() {
    var val = input.value.trim();
    if (!val) { hint.textContent = 'Enter an address first.'; hint.className = 'hint error'; return; }
    if (!/^https?:\\/\\//i.test(val)) val = 'https://' + val;
    try {
      var u = new URL(val);
      if (u.origin === location.origin) {
        hint.textContent = "That's this relay's own address — enter the site you want to visit instead.";
        hint.className = 'hint error';
        return;
      }
      trace.classList.add('sending');
      window.location.href = location.origin + '/' + u.href;
    } catch (e) {
      hint.textContent = 'That address doesn\\'t look valid.';
      hint.className = 'hint error';
    }
  }

  document.getElementById('goForm').addEventListener('submit', function(e) {
    e.preventDefault();
    go();
  });

  input.addEventListener('input', function() {
    hint.textContent = 'Prefix is optional — https:// is assumed.';
    hint.className = 'hint';
  });
})();
</script>
</body>
</html>`;

// Shared error page — same design tokens, fonts, and theme toggle as
// HOME_HTML, kept as a separate template so the working homepage is never
// touched by changes here. status/title/message/detail/targetUrl are all
// escaped before interpolation.
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function errorPage({ status, title, message, detail, targetUrl, proxyOrigin }) {
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  const safeDetail = detail ? escapeHtml(detail) : '';
  const safeTarget = targetUrl ? escapeHtml(targetUrl) : '';
  const homeUrl = escapeHtml(proxyOrigin + '/');

  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${status} — Relay</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #FFFFFF;
    --surface: #F6F6F5;
    --border: #E1E1DE;
    --text: #131316;
    --text-dim: #6C6C72;
    --accent: #2547F4;
    --accent-dim: #E9ECFE;
    --warn: #C7431E;
  }
  html[data-theme="dark"] {
    --bg: #0A0A0C;
    --surface: #151517;
    --border: #29292D;
    --text: #F1F1EF;
    --text-dim: #8B8B91;
    --accent: #6C89FF;
    --accent-dim: #16193A;
    --warn: #FF8A63;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: 'Space Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    -webkit-font-smoothing: antialiased;
    transition: background 0.25s ease, color 0.25s ease;
  }
  .wrap {
    min-height: 100%;
    display: flex;
    flex-direction: column;
    max-width: 640px;
    margin: 0 auto;
    padding: 28px 24px 60px;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: clamp(48px, 12vh, 96px);
  }
  .mark {
    display: flex;
    align-items: center;
    gap: 10px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    letter-spacing: 0.08em;
    color: var(--text-dim);
    text-transform: uppercase;
    text-decoration: none;
  }
  .mark .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--warn);
  }
  .theme-toggle {
    width: 34px;
    height: 34px;
    border-radius: 4px;
    border: 1px solid var(--border);
    background: var(--surface);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    color: var(--text);
    transition: border-color 0.15s ease;
  }
  .theme-toggle:hover { border-color: var(--text-dim); }
  .theme-toggle svg { width: 15px; height: 15px; }

  main { flex: 1; }

  .code {
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--warn);
    margin: 0 0 14px;
  }
  h1 {
    font-size: clamp(30px, 6vw, 44px);
    font-weight: 600;
    line-height: 1.1;
    letter-spacing: -0.02em;
    margin: 0 0 16px;
  }
  .sub {
    font-size: 16px;
    line-height: 1.5;
    color: var(--text-dim);
    max-width: 50ch;
    margin: 0 0 8px;
  }
  .detail {
    font-size: 14px;
    line-height: 1.5;
    color: var(--text-dim);
    max-width: 50ch;
    margin: 0 0 32px;
  }
  .target {
    display: block;
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 12px 14px;
    margin: 0 0 32px;
    word-break: break-all;
  }
  .actions {
    display: flex;
    gap: 12px;
    margin-bottom: 56px;
  }
  .btn {
    font-family: 'Space Grotesk', sans-serif;
    font-size: 14px;
    font-weight: 500;
    text-decoration: none;
    padding: 12px 20px;
    border-radius: 4px;
    cursor: pointer;
    border: 1px solid transparent;
  }
  .btn.primary {
    background: var(--accent);
    color: var(--bg);
    border: 0;
  }
  html[data-theme="dark"] .btn.primary { color: #0A0A0C; }
  .btn.primary:hover { opacity: 0.85; }
  .btn.secondary {
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
  }
  .btn.secondary:hover { border-color: var(--text-dim); }

  .trace {
    display: flex;
    align-items: center;
    gap: 0;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--text-dim);
  }
  .trace .node { display: flex; flex-direction: column; align-items: center; gap: 8px; flex-shrink: 0; }
  .trace .node span.sq { width: 9px; height: 9px; border: 1px solid var(--text-dim); }
  .trace .node.active span.sq { background: var(--accent); border-color: var(--accent); }
  .trace .node.broken span.sq { background: var(--warn); border-color: var(--warn); }
  .trace .line { flex: 1; height: 1px; background: var(--border); margin: 0 -1px; top: -13px; position: relative; }
  .trace .line.broken { background: repeating-linear-gradient(90deg, var(--warn), var(--warn) 4px, transparent 4px, transparent 8px); }

  footer {
    margin-top: auto;
    padding-top: 20px;
    border-top: 1px solid var(--border);
    display: flex;
    justify-content: space-between;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: var(--text-dim);
    letter-spacing: 0.04em;
  }
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <a class="mark" href="/"><span class="dot"></span>relay</a>
      <button class="theme-toggle" id="themeToggle" aria-label="Switch theme" type="button">
        <svg id="themeIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
          <circle cx="12" cy="12" r="4.6"></circle>
          <path d="M12 2.4v2.4M12 19.2v2.4M4.4 12H2M22 12h-2.4M5.6 5.6l1.7 1.7M16.7 16.7l1.7 1.7M5.6 18.4l1.7-1.7M16.7 7.3l1.7-1.7"></path>
        </svg>
      </button>
    </header>

    <main>
      <p class="code">// error ${status}</p>
      <h1>${safeTitle}</h1>
      <p class="sub">${safeMessage}</p>
      ${safeDetail ? `<p class="detail">${safeDetail}</p>` : ''}
      ${safeTarget ? `<code class="target">${safeTarget}</code>` : ''}

      <div class="actions">
        <a class="btn primary" href="${homeUrl}">Back to relay</a>
        <button class="btn secondary" id="goBackBtn" type="button">Go back</button>
      </div>

      <div class="trace">
        <div class="node active"><span class="sq"></span><span>you</span></div>
        <div class="line"></div>
        <div class="node active"><span class="sq"></span><span>relay</span></div>
        <div class="line broken"></div>
        <div class="node broken"><span class="sq"></span><span>target</span></div>
      </div>
    </main>

    <footer>
      <span id="originLabel"></span>
      <span>status ${status}</span>
    </footer>
  </div>

<script>
(function() {
  var root = document.documentElement;
  var sunPath = 'M12 2.4v2.4M12 19.2v2.4M4.4 12H2M22 12h-2.4M5.6 5.6l1.7 1.7M16.7 16.7l1.7 1.7M5.6 18.4l1.7-1.7M16.7 7.3l1.7-1.7';
  var moonPath = 'M20 14.6A8.4 8.4 0 1 1 9.4 4a6.7 6.7 0 0 0 10.6 10.6z';

  function applyIcon(theme) {
    var circle = document.querySelector('#themeIcon circle');
    var path = document.querySelector('#themeIcon path');
    if (theme === 'dark') {
      if (circle) circle.setAttribute('r', '0');
      path.setAttribute('d', moonPath);
    } else {
      if (circle) circle.setAttribute('r', '4.6');
      path.setAttribute('d', sunPath);
    }
  }

  var saved = null;
  try { saved = localStorage.getItem('relay-theme'); } catch (e) {}
  var theme = saved || 'light';
  root.setAttribute('data-theme', theme);
  applyIcon(theme);

  document.getElementById('themeToggle').addEventListener('click', function() {
    theme = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', theme);
    applyIcon(theme);
    try { localStorage.setItem('relay-theme', theme); } catch (e) {}
  });

  document.getElementById('originLabel').textContent = location.origin.replace(/^https?:\\/\\//, '');

  document.getElementById('goBackBtn').addEventListener('click', function() {
    // history.length > 1 means there's actually somewhere to go back to —
    // if this page was the first entry in the tab (a directly pasted or
    // bookmarked URL), history.back() would otherwise silently do nothing.
    if (window.history.length > 1) {
      window.history.back();
    } else {
      window.location.href = '${homeUrl}';
    }
  });
})();
</script>
</body>
</html>`;
}

function errorResponse(proxyOrigin, status, title, message, detail, targetUrl) {
  return new Response(errorPage({ status, title, message, detail, targetUrl, proxyOrigin }), {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

// --- Password gate ---------------------------------------------------------
// Entirely optional: only active when the PASSWORD environment variable is
// set (via `wrangler secret put PASSWORD` or a dashboard env var). Unset —
// the default — means the relay behaves exactly as before, no auth at all.
const AUTH_COOKIE = '__relay_pwd';
const AUTH_PATH = '/__relay_login';

// The cookie stores a hash of the password, not the password itself, so the
// raw secret isn't sitting in a cookie if it's ever exposed some other way.
async function relayHashPassword(pwd) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pwd));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function relayGetCookie(request, name) {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  const match = header.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

async function relayIsAuthed(request, env) {
  if (!env || !env.PASSWORD) return true;
  const cookieVal = relayGetCookie(request, AUTH_COOKIE);
  if (!cookieVal) return false;
  return cookieVal === (await relayHashPassword(env.PASSWORD));
}

// Deliberately lean, not sharing HOME_HTML/errorPage's full CSS — a login
// form doesn't need their trace diagram, theme-toggle JS, or font loading.
// prefers-color-scheme covers dark mode without needing that JS at all.
function authPage(redirectTo, wrongPassword) {
  const safeRedirect = escapeHtml(redirectTo || '/');
  const msg = wrongPassword ? 'Incorrect password.' : 'This relay is password-protected.';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Relay — Sign in</title>
<style>
  :root { --bg:#FFFFFF; --surface:#F6F6F5; --border:#E1E1DE; --text:#131316; --text-dim:#6C6C72; --accent:#2547F4; --warn:#C7431E; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0A0A0C; --surface:#151517; --border:#29292D; --text:#F1F1EF; --text-dim:#8B8B91; --accent:#6C89FF; --warn:#FF8A63; }
  }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; background:var(--bg); color:var(--text); font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
  .box { width:100%; max-width:300px; padding:24px; }
  h1 { font-size:20px; margin:0 0 8px; }
  p { font-size:14px; color:var(--text-dim); margin:0 0 20px; }
  p.err { color:var(--warn); }
  .field { display:flex; border:1px solid var(--border); border-radius:4px; background:var(--surface); }
  input { flex:1; min-width:0; border:0; background:transparent; outline:none; padding:12px; font-size:14px; color:var(--text); }
  button { border:0; background:var(--accent); color:#fff; padding:0 16px; border-radius:0 3px 3px 0; cursor:pointer; }
</style>
</head>
<body>
  <form class="box" method="POST" action="${AUTH_PATH}">
    <h1>relay</h1>
    <p class="${wrongPassword ? 'err' : ''}">${msg}</p>
    <input type="hidden" name="redirect" value="${safeRedirect}">
    <div class="field">
      <input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password">
      <button type="submit">Go</button>
    </div>
  </form>
</body>
</html>`;
}

// WebSocket bridging: browser <-> this Worker <-> the real target.
// The client-side WebSocket constructor override (in ScriptInjector) routes
// ws(s) connections through this same path-embedded scheme (e.g.
// /wss://real.com/socket); this is the server-side half that completes the
// handshake on both ends and relays messages/close/error between them.
//
// Cloudflare Workers negotiate an OUTBOUND WebSocket via a plain http(s)
// fetch() with an Upgrade header set — not a literal wss:// URL — and the
// far end is then exposed as `response.webSocket`.
async function handleWebSocketUpgrade(request, url, proxyOrigin) {
  const targetUrl = url.pathname.slice(1) + url.search;
  if (!/^wss?:\/\//i.test(targetUrl)) {
    return new Response('Invalid WebSocket target', { status: 400 });
  }

  let parsedTarget;
  try {
    parsedTarget = new URL(targetUrl);
  } catch {
    return new Response('Invalid WebSocket target', { status: 400 });
  }
  if (parsedTarget.origin.replace(/^wss?/, 'https') === proxyOrigin) {
    return new Response('Refusing to proxy the relay itself', { status: 400 });
  }

  const httpEquivalent = parsedTarget.href.replace(/^ws/, 'http');
  const realOrigin = parsedTarget.origin.replace(/^ws/, 'http');

  const upstreamHeaders = new Headers({
    'Upgrade': 'websocket',
    'Connection': 'Upgrade',
    // Real target origin, not our proxy's — many WebSocket servers reject
    // the handshake outright if Origin doesn't match their own site.
    'Origin': realOrigin,
    // Real browser UA, not a fixed spoofed one — see buildUpstreamHeaders.
    'User-Agent': request.headers.get('User-Agent') || FALLBACK_USER_AGENT
  });
  // Forward subprotocol negotiation. The browser's WebSocket constructor
  // sends its offered protocols in this header; it must eventually see
  // back whichever one the real server actually chose (below), or
  // socket.protocol is empty and strict clients reject the connection.
  const requestedProtocol = request.headers.get('Sec-WebSocket-Protocol');
  if (requestedProtocol) upstreamHeaders.set('Sec-WebSocket-Protocol', requestedProtocol);

  let upstream;
  try {
    // 10s is generous for a handshake specifically (not the connection's
    // lifetime — once upstream.webSocket exists below, it's independent of
    // this timeout) while still failing fast on an unreachable game server
    // rather than leaving the connecting UI hanging indefinitely.
    upstream = await fetchUpstream(httpEquivalent, { headers: upstreamHeaders }, 10000);
  } catch (err) {
    return new Response('WebSocket upstream connection failed: ' + err.message, { status: 502 });
  }

  const upstreamSocket = upstream.webSocket;
  if (!upstreamSocket) {
    return new Response('Target did not upgrade to WebSocket', { status: 502 });
  }

  let client, server;
  try {
    upstreamSocket.accept();
    [client, server] = Object.values(new WebSocketPair());
    server.accept();
  } catch (err) {
    try { upstreamSocket.close(); } catch {}
    return new Response('WebSocket bridge setup failed: ' + err.message, { status: 502 });
  }

  server.addEventListener('message', (e) => {
    try { upstreamSocket.send(e.data); } catch {}
  });
  upstreamSocket.addEventListener('message', (e) => {
    try { server.send(e.data); } catch {}
  });
  server.addEventListener('close', (e) => {
    try { upstreamSocket.close(e.code, e.reason); } catch {}
  });
  upstreamSocket.addEventListener('close', (e) => {
    try { server.close(e.code, e.reason); } catch {}
  });
  server.addEventListener('error', () => { try { upstreamSocket.close(); } catch {} });
  upstreamSocket.addEventListener('error', () => { try { server.close(); } catch {} });

  // Echo back whichever subprotocol the REAL server actually accepted —
  // not simply the client's request verbatim.
  const acceptedProtocol = upstream.headers.get('Sec-WebSocket-Protocol');
  const responseInit = { status: 101, webSocket: client };
  if (acceptedProtocol) {
    responseInit.headers = { 'Sec-WebSocket-Protocol': acceptedProtocol };
  }
  return new Response(null, responseInit);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const proxyOrigin = url.origin;

    // Entirely a no-op when env.PASSWORD isn't set — see relayIsAuthed.
    if (env && env.PASSWORD) {
      if (url.pathname === AUTH_PATH && request.method === 'POST') {
        const form = await request.formData();
        const submitted = String(form.get('password') || '');
        const redirectTo = String(form.get('redirect') || '/');
        if (submitted === env.PASSWORD) {
          const token = await relayHashPassword(env.PASSWORD);
          const headers = new Headers({ Location: proxyOrigin + redirectTo });
          headers.append(
            'Set-Cookie',
            `${AUTH_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`
          );
          return new Response(null, { status: 302, headers });
        }
        return new Response(authPage(redirectTo, true), {
          status: 401,
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
      }
      if (!(await relayIsAuthed(request, env))) {
        return new Response(authPage(url.pathname + url.search, false), {
          status: 401,
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
      }
    }

    if (request.headers.get('Upgrade') === 'websocket') {
      return handleWebSocketUpgrade(request, url, proxyOrigin);
    }

    if (url.pathname === SW_PATH) {
      return new Response(SW_SCRIPT, {
        headers: { 'Content-Type': 'application/javascript' }
      });
    }

    const alreadyEmbedded = /^\/https?:\/\//i.test(url.pathname);

    // Legacy ?url=... links: never served directly — always redirect to the
    // canonical path-embedded form, so ?url= never lingers in the URL bar.
    if (url.searchParams.has('url') && !alreadyEmbedded) {
      let legacy = url.searchParams.get('url');
      if (!/^https?:\/\//i.test(legacy)) legacy = 'https://' + legacy;
      try {
        const canonical = proxyOrigin + '/' + new URL(legacy).href;
        return Response.redirect(canonical, 301);
      } catch {
        return errorResponse(proxyOrigin, 400, "That address didn't parse", "The URL passed via ?url= couldn't be read as a valid address.", null, legacy);
      }
    }

    // Any other request that isn't already correctly path-embedded is a
    // root-relative reference that escaped to the bare origin (a direct
    // `location.href = '/x'` assignment, a request the Service Worker hasn't
    // taken control of yet, etc). Recover the real target from the request's
    // Referer — the browser sets this automatically to whichever proxied
    // page issued the request — and redirect to the corrected URL rather
    // than silently failing or mis-serving it.
    if (!alreadyEmbedded) {
      const ref = request.headers.get('Referer');
      if (ref) {
        try {
          const refUrl = new URL(ref);
          if (refUrl.origin === proxyOrigin) {
            const embedded = refUrl.pathname.slice(1);
            const m = embedded.match(/^(https?:\/\/[^/]+)/);
            if (m) {
              const corrected = proxyOrigin + '/' + m[1] + url.pathname + url.search;
              return Response.redirect(corrected, 302);
            }
          }
        } catch {
          // fall through
        }
      }
    }

    // Path-embedded target, e.g. "/https://example.com/page" + "?x=1"
    let targetUrl = url.pathname.slice(1) + url.search;

    if (!targetUrl) {
      return new Response(HOME_HTML, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    // No scheme and no Referer to recover from — treat as a bare domain
    // typed directly (e.g. someone navigated straight to
    // proxy.dev/example.com with no prior proxied page).
    if (!/^https?:\/\//i.test(targetUrl)) {
      targetUrl = 'https://' + targetUrl;
    }

    // Defensive cap against pathological input, before even trying to parse it.
    if (targetUrl.length > 8000) {
      return errorResponse(proxyOrigin, 414, 'That address is too long', "The target URL exceeds what this relay will attempt to proxy.", null, targetUrl.slice(0, 200) + '…');
    }

    let parsedTarget;
    try {
      parsedTarget = new URL(targetUrl);
    } catch {
      return errorResponse(proxyOrigin, 400, "That address didn't parse", "The target couldn't be read as a valid URL — check it for typos.", null, targetUrl);
    }
    if (!['http:', 'https:'].includes(parsedTarget.protocol)) {
      return errorResponse(proxyOrigin, 400, 'Unsupported protocol', 'This relay only forwards http:// and https:// addresses.', null, parsedTarget.href);
    }
    // Refuse a self-referential target — otherwise the Worker would fetch
    // its own origin, recursively, on a crafted or accidental link.
    if (parsedTarget.origin === proxyOrigin) {
      return errorResponse(proxyOrigin, 400, 'Refusing to proxy itself', "This address points back at the relay's own origin, which would cause it to fetch itself.", null, parsedTarget.href);
    }

    // Edge cache: identical proxied requests skip origin + rewriting entirely.
    // GET-only — the Cache API throws on non-GET requests.
    const cacheable = request.method === 'GET';
    const cache = caches.default;
    const cacheKey = new Request(request.url, request);
    if (cacheable) {
      const cached = await cache.match(cacheKey);
      if (cached) return cached;
    }

    const upstreamInit = {
      method: request.method,
      headers: buildUpstreamHeaders(request, proxyOrigin, parsedTarget.origin),
      redirect: 'follow',
      // cacheEverything is safe here specifically because this proxy never
      // forwards cookies (see README limitations) — every response is
      // already the same generic, non-personalized view for everyone, so
      // caching it at Cloudflare's fetch layer (not just our own edge
      // cache below) cuts a real origin round-trip on repeat hits.
      cf: { cacheTtl: 120, cacheEverything: true }
    };
    // Forward the real request body for non-GET/HEAD methods — previously
    // every upstream fetch was an implicit GET regardless of the incoming
    // request, silently dropping POST bodies (breaks GraphQL calls, search
    // suggestions, and anything else proxied fetch/XHR calls send as POST).
    if (!['GET', 'HEAD'].includes(request.method) && request.body) {
      upstreamInit.body = request.body;
      upstreamInit.duplex = 'half';
    }

    let upstream;
    try {
      upstream = await fetchUpstream(parsedTarget.href, upstreamInit);
    } catch (error) {
      return errorResponse(proxyOrigin, 502, "Couldn't reach that address", 'The request to the target failed before any response came back.', error.message, parsedTarget.href);
    }

    // Cloudflare's own edge — not the target site — returns these statuses
    // for connectivity failures (DNS didn't resolve, origin unreachable,
    // etc). fetch() doesn't throw for these; it resolves as a normal-looking
    // HTML response, which would otherwise get rewritten and served as if
    // it were the real page. Show our own explanation instead.
    const CF_EDGE_ERROR_STATUSES = new Set([520, 521, 522, 523, 524, 525, 526, 527, 530]);
    if (CF_EDGE_ERROR_STATUSES.has(upstream.status)) {
      return errorResponse(proxyOrigin, 502, "Couldn't reach that address", "The target domain didn't respond — it may not exist, or is temporarily unreachable.", 'Double-check the address for typos.', parsedTarget.href);
    }

    const contentType = upstream.headers.get('content-type') || '';

    // Non-HTML: stream through untouched, but for static asset types (JS,
    // CSS, fonts, images) that browsers otherwise under-cache, extend
    // Cache-Control client-side AND store at the edge — a chunk fetched by
    // one visitor is then served instantly to the next, skipping the origin
    // and the Worker's rewriting path entirely.
    if (!contentType.includes('text/html')) {
      // Search engines increasingly deliver actual result data via a
      // separate payload fetched by client-side JS (confirmed for
      // DuckDuckGo's links.duckduckgo.com/d.js) rather than embedding
      // results in the initial HTML at all — HTMLRewriter can never reach
      // this, since it only ever sees that initial response. Rewriting the
      // URLs in the response TEXT itself, here, means the data is already
      // correct by the time the page's own JS parses and uses it — no
      // fighting a framework's own re-rendering after the fact. Narrow and
      // explicit: a small, known list of search-engine data hosts, not a
      // general "rewrite URLs in any response" rule, which would risk
      // corrupting arbitrary application code that uses URL-like strings
      // for its own internal logic.
      if (SEARCH_DATA_HOSTS.has(parsedTarget.hostname)) {
        const text = await upstream.text();
        const rewritten = rewriteEmbeddedUrls(text, upstream.url || parsedTarget.href, proxyOrigin);
        return new Response(rewritten, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: upstream.headers
        });
      }

      if (upstream.status === 200 && isLongCacheable(contentType)) {
        const headers = new Headers(upstream.headers);
        headers.set('Cache-Control', 'public, max-age=86400');
        const asset = new Response(upstream.body, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers
        });
        // .clone() tees the stream, roughly doubling in-flight buffering —
        // fine for a typical script/image, wasteful and riskier for a large
        // game/WASM bundle (these commonly run 50-200MB+). Skip our OWN
        // edge-cache write above the threshold; the browser still benefits
        // from the Cache-Control header above either way.
        const lengthHeader = upstream.headers.get('content-length');
        const tooLargeToCache = lengthHeader && parseInt(lengthHeader, 10) > ASSET_CACHE_SIZE_LIMIT;
        if (cacheable && !tooLargeToCache) ctx.waitUntil(cache.put(cacheKey, asset.clone()));
        return asset;
      }
      return upstream;
    }

    // upstream.url is the FINAL URL after any redirects fetch() followed
    // server-side — using the pre-redirect parsedTarget.href here would
    // resolve every relative link/script/etc against the wrong page
    // whenever the target redirects (auth flows, trailing-slash/canonical
    // redirects, moved domains).
    const baseUrl = upstream.url || parsedTarget.href;
    const proxiedBase = proxyOrigin + '/' + baseUrl;

    const rewriter = new HTMLRewriter()
      .on('a[href]', new AttrRewriter('href', baseUrl, proxyOrigin))
      .on('img[src]', new AttrRewriter('src', baseUrl, proxyOrigin))
      .on('script[src]', new AttrRewriter('src', baseUrl, proxyOrigin))
      .on('link[href]', new AttrRewriter('href', baseUrl, proxyOrigin))
      .on('iframe[src]', new AttrRewriter('src', baseUrl, proxyOrigin))
      .on('video[src]', new AttrRewriter('src', baseUrl, proxyOrigin))
      .on('video[poster]', new AttrRewriter('poster', baseUrl, proxyOrigin))
      .on('audio[src]', new AttrRewriter('src', baseUrl, proxyOrigin))
      .on('source[src]', new AttrRewriter('src', baseUrl, proxyOrigin))
      .on('embed[src]', new AttrRewriter('src', baseUrl, proxyOrigin))
      .on('object[data]', new AttrRewriter('data', baseUrl, proxyOrigin))
      .on('form', new FormRewriter(baseUrl))
      .on('img[srcset]', new SrcsetRewriter(baseUrl, proxyOrigin))
      .on('source[srcset]', new SrcsetRewriter(baseUrl, proxyOrigin))
      .on('meta[http-equiv]', new MetaRefreshRewriter(baseUrl, proxyOrigin))
      .on('head', new BaseTagInjector(proxiedBase))
      .on('head', new ScriptInjector(proxyOrigin));

    const transformed = rewriter.transform(upstream);

    const response = new Response(transformed.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=60'
      }
    });

    if (cacheable) ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  }
};

function proxify(absoluteUrl, proxyOrigin) {
  return proxyOrigin + '/' + absoluteUrl;
}

// Headers we set ourselves, that leak the proxy's own domain if forwarded
// verbatim, or that are hop-by-hop/infra-only and meaningless upstream.
// Everything else the page/browser actually sent is forwarded as-is — an
// allowlist here would always be one custom header behind real-world sites
// (anti-abuse tokens, API versioning headers, CSRF tokens, etc); a denylist
// is far more robust. Cookies specifically are never forwarded (see README
// limitations).
const DROP_HEADERS = new Set([
  'host', 'cookie', 'content-length', 'connection',
  'user-agent',
  'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor', 'cf-worker',
  'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host',
  'referer', 'origin' // handled specially below, not silently forwarded raw
]);

// Recovers the real target URL embedded in a proxy-origin header value
// (e.g. a Referer/Origin the browser set to our own domain), or null if the
// value isn't one of ours.
function recoverRealUrl(headerValue, proxyOrigin) {
  if (!headerValue) return null;
  try {
    const u = new URL(headerValue);
    if (u.origin !== proxyOrigin) return null;
    const embedded = u.pathname.slice(1);
    return /^https?:\/\//i.test(embedded) ? embedded : null;
  } catch {
    return null;
  }
}

function buildUpstreamHeaders(request, proxyOrigin, targetOrigin) {
  const headers = new Headers();
  // Forward the REAL browser's own User-Agent rather than a fixed spoofed
  // string. This request's Sec-Ch-Ua/Sec-Fetch-* headers (forwarded below,
  // since they're not in DROP_HEADERS) already reflect the real browser —
  // a substituted User-Agent that doesn't match them is an internal
  // inconsistency that bot-detection systems specifically look for. Only
  // fall back to a generic default if the client somehow sent none at all.
  const realUA = request.headers.get('User-Agent');
  headers.set('User-Agent', realUA || FALLBACK_USER_AGENT);
  // Accept-Encoding is NOT set here — the real browser's own value is
  // forwarded via the denylist loop below, for the same reason as
  // User-Agent above: a substituted value that doesn't match what a real
  // browser of that claimed identity would actually send is a detectable
  // inconsistency.

  for (const [name, value] of request.headers) {
    if (DROP_HEADERS.has(name.toLowerCase())) continue;
    headers.set(name, value);
  }

  // Referer carries a full path, so the real target can be recovered from
  // its content. Origin never carries a path (just scheme+host) — there's
  // nothing to recover from it, so when the browser sent one at all, set it
  // to the request's own known real target origin instead.
  const realReferer = recoverRealUrl(request.headers.get('Referer'), proxyOrigin);
  if (realReferer) headers.set('Referer', realReferer);

  if (request.headers.get('Origin')) {
    headers.set('Origin', targetOrigin);
  }

  return headers;
}

// Above this, skip our own edge-cache write for a static asset (still gets
// browser-side Cache-Control either way) — see the asset-caching branch.
const ASSET_CACHE_SIZE_LIMIT = 20 * 1024 * 1024; // 20MB

// Only used on the rare request that arrives with no User-Agent at all (the
// normal path forwards the real browser's own UA — see buildUpstreamHeaders
// and handleWebSocketUpgrade). Must be a complete, correctly-formed string:
// the previous fallback was truncated to just "AppleWebKit/537.36" with no
// "(KHTML, like Gecko) Chrome/... Safari/..." suffix — no real browser has
// ever sent that fragment alone, and it's exactly the kind of malformed
// signature basic bot-detection checks for.
const FALLBACK_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Parses Retry-After as either delta-seconds or an HTTP-date, per spec.
// Returns null when absent or unparseable.
function parseRetryAfterMs(header) {
  if (!header) return null;
  const asInt = parseInt(header, 10);
  if (!Number.isNaN(asInt) && String(asInt) === header.trim()) return asInt * 1000;
  const asDate = Date.parse(header);
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
  return null;
}

// Fails fast on a hung/stalled upstream rather than letting the request run
// indefinitely — bounded so a single slow connection can't quietly eat the
// Worker's whole execution budget. Only wraps the request itself; once a
// WebSocket handshake completes, the resulting socket lives independently
// of this signal and is unaffected by it.
async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 20000);
  try {
    return await fetch(url, Object.assign({}, init, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}

// One retry on transient network failure (DNS blip, connection reset) —
// not on HTTP error statuses, which are legitimate responses returned as-is
// either way. Only retried when there's no body: a ReadableStream can only
// be read once, so a request that already carries one gets a single try.
//
// Also adds a short, capped retry specifically for throttling responses
// (429/503) that include a short Retry-After — relevant for game traffic
// especially, since many concurrent relay users hitting the same game
// server can all appear to originate from Cloudflare's own IP ranges,
// making a real rate limit more likely to be hit than for ordinary
// browsing. Capped at 2s and one attempt so a single request can never
// stall for long chasing a throttle that isn't going to clear soon.
async function fetchUpstream(url, init, timeoutMs) {
  let response;
  try {
    response = await fetchWithTimeout(url, init, timeoutMs);
  } catch (err) {
    if (init.body) throw err;
    response = await fetchWithTimeout(url, init, timeoutMs);
  }

  if ((response.status === 429 || response.status === 503) && !init.body) {
    const waitMs = parseRetryAfterMs(response.headers.get('Retry-After'));
    if (waitMs !== null && waitMs <= 2000) {
      await sleep(waitMs);
      try {
        response = await fetchWithTimeout(url, init, timeoutMs);
      } catch {
        // keep the original throttled response if the retry itself fails
      }
    }
  }

  return response;
}

// Content-types safe to cache aggressively client-side: static, commonly
// content-hashed, and re-requested often by proxied SPAs. Deliberately
// excludes video/audio (range-request/seeking behavior) and anything
// JSON/API-shaped (freshness matters).
const STATIC_CACHE_TYPES = ['text/css', 'javascript', 'image/', 'font/'];
function isLongCacheable(contentType) {
  return STATIC_CACHE_TYPES.some((t) => contentType.includes(t));
}

// Known search-engine data endpoints — the actual result payload, not the
// page shell. Confirmed for DuckDuckGo by inspecting its response directly;
// add others here once their equivalent endpoint is identified the same way
// (this list is deliberately small and explicit, not a guess).
const SEARCH_DATA_HOSTS = new Set(['links.duckduckgo.com']);

// Rewrites embedded absolute URLs in a search-data response's raw text,
// before the page's own JS ever parses it. Handles both plain
// (https://example.com) and JSON-escaped (https:\/\/example.com) forms,
// since these payloads are commonly JSONP-wrapped JSON — re-escaping the
// result the same way the match was found, so the surrounding JSON's own
// escaping convention stays consistent for whatever later parses it.
function rewriteEmbeddedUrls(text, baseUrl, proxyOrigin) {
  return text.replace(/https?:(?:\\\/|[^\s"'\\])+/g, (match) => {
    try {
      const wasEscaped = match.indexOf('\\/') !== -1;
      const unescaped = match.replace(/\\\//g, '/');
      const abs = new URL(unescaped, baseUrl).href;
      const proxied = proxyOrigin + '/' + abs;
      return wasEscaped ? proxied.replace(/\//g, '\\/') : proxied;
    } catch {
      return match;
    }
  });
}

// Bing (and similar) wrap search-result links in a server-side
// click-tracking redirect (bing.com/ck/a?...&u=a1<base64>...) that serves
// an interstitial page whose own JS then navigates onward — commonly via a
// direct, unpatchable location assignment straight to the real external
// destination, which escapes the proxy entirely (window.location can't be
// intercepted from page JS, and the resulting request never reaches this
// Worker to be recovered server-side). Decoding the real destination here
// and linking straight to it skips the interstitial, and its escape,
// altogether. Falls through to the tracking URL unchanged if the pattern
// or encoding doesn't match — never breaks the link.
// Major search engines wrap result links in a server-side click-tracking
// redirect that serves an interstitial page whose own JS then navigates
// onward — commonly via a direct, unpatchable location assignment straight
// to the real external destination, which escapes the proxy entirely
// (window.location can't be intercepted from page JS, and the resulting
// request never reaches this Worker to be recovered server-side).
// Decoding the real destination here and linking straight to it skips the
// interstitial, and its escape, altogether. Falls through to the tracking
// URL unchanged if no known pattern matches — never breaks a link.
function decodeTrackingRedirect(rawValue, baseUrl) {
  let u;
  try {
    u = new URL(rawValue, baseUrl);
  } catch {
    return null;
  }

  // Bing: /ck/a?...&u=a1<base64url, unpadded>...
  if (/\/ck\/a$/i.test(u.pathname)) {
    const encoded = u.searchParams.get('u');
    if (encoded && encoded.slice(0, 2) === 'a1') {
      try {
        let b64 = encoded.slice(2).replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4 !== 0) b64 += '=';
        const decoded = atob(b64);
        if (/^https?:\/\//i.test(decoded)) return decoded;
      } catch {
        // fall through
      }
    }
    return null;
  }

  // Google: /url?q=<url-encoded destination>
  if (/^\/url$/i.test(u.pathname) && /(^|\.)google\.[a-z.]+$/i.test(u.hostname)) {
    const q = u.searchParams.get('q');
    if (q && /^https?:\/\//i.test(q)) return q;
    return null;
  }

  // DuckDuckGo: /l/?uddg=<url-encoded destination>
  if (/^\/l\/?$/i.test(u.pathname) && /(^|\.)duckduckgo\.com$/i.test(u.hostname)) {
    const uddg = u.searchParams.get('uddg');
    if (uddg && /^https?:\/\//i.test(uddg)) return uddg;
    return null;
  }

  return null;
}

function resolveAndProxy(value, baseUrl, proxyOrigin) {
  if (value === null || value === undefined) return null;
  if (/^(javascript|data|mailto|tel|#)/i.test(value)) return null;
  try {
    const target = decodeTrackingRedirect(value, baseUrl) || value;
    const abs = new URL(target, baseUrl).href;
    return proxify(abs, proxyOrigin);
  } catch {
    return null;
  }
}

class AttrRewriter {
  constructor(attr, baseUrl, proxyOrigin) {
    this.attr = attr;
    this.baseUrl = baseUrl;
    this.proxyOrigin = proxyOrigin;
  }
  element(el) {
    const val = el.getAttribute(this.attr);
    const newVal = resolveAndProxy(val, this.baseUrl, this.proxyOrigin);
    if (newVal) el.setAttribute(this.attr, newVal);
  }
}

// GET forms strip any existing query string from `action` on submit, so a
// proxied action gets clobbered by the form's own fields. Instead, stash the
// resolved real target URL and let injected JS build the request.
class FormRewriter {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
  }
  element(el) {
    const actionVal = el.getAttribute('action') || '';
    let abs;
    try {
      abs = new URL(actionVal, this.baseUrl).href;
    } catch {
      abs = this.baseUrl;
    }
    el.setAttribute('data-proxy-target', abs);
  }
}

class SrcsetRewriter {
  constructor(baseUrl, proxyOrigin) {
    this.baseUrl = baseUrl;
    this.proxyOrigin = proxyOrigin;
  }
  element(el) {
    const val = el.getAttribute('srcset');
    if (!val) return;
    const rewritten = val
      .split(',')
      .map((part) => {
        const trimmed = part.trim();
        const spaceIdx = trimmed.search(/\s/);
        const u = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
        const descriptor = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx).trim();
        const proxied = resolveAndProxy(u, this.baseUrl, this.proxyOrigin);
        if (!proxied) return trimmed;
        return descriptor ? `${proxied} ${descriptor}` : proxied;
      })
      .join(', ');
    el.setAttribute('srcset', rewritten);
  }
}

// <meta http-equiv="refresh" content="N;url=..."> is a real HTML redirect
// mechanism, distinct from an HTTP 3xx response and untouched by any other
// rewriter — a page using it to redirect would otherwise send the browser
// straight to the real, un-proxied destination.
class MetaRefreshRewriter {
  constructor(baseUrl, proxyOrigin) {
    this.baseUrl = baseUrl;
    this.proxyOrigin = proxyOrigin;
  }
  element(el) {
    const httpEquiv = el.getAttribute('http-equiv');
    if (!httpEquiv || httpEquiv.toLowerCase() !== 'refresh') return;
    const content = el.getAttribute('content');
    if (!content) return;
    const match = content.match(/^(\s*[\d.]*\s*;\s*url\s*=\s*)(.+)$/i);
    if (!match) return;
    const [, prefix, rawUrl] = match;
    const cleanUrl = rawUrl.trim().replace(/^['"]|['"]$/g, '');
    const proxied = resolveAndProxy(cleanUrl, this.baseUrl, this.proxyOrigin);
    if (proxied) el.setAttribute('content', prefix + proxied);
  }
}

// Makes directory-relative references from JS-created/dynamic content (never
// seen by HTMLRewriter, since it only runs on the initial HTML response)
// resolve against the *proxied* current page instead of escaping to the
// proxy's own root.
class BaseTagInjector {
  constructor(proxiedBase) {
    this.proxiedBase = proxiedBase;
  }
  element(el) {
    el.prepend(`<base href="${this.proxiedBase}">`, { html: true });
  }
}

class ScriptInjector {
  constructor(proxyOrigin) {
    this.proxyOrigin = proxyOrigin;
  }
  element(el) {
    el.prepend(
      `
    <script>
    (function() {
      var proxyOrigin = '${this.proxyOrigin}';

      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('${SW_PATH}').catch(function() {});

        // Block the TARGET site's own Service Worker registration attempts.
        // A foreign site's SW can't function correctly under our proxied
        // URL scheme (its internal relative references assume the real
        // site's own paths), and if it takes over fetch handling on this
        // origin, its requests start failing — which is exactly the
        // trigger many sites use to show a "you're offline" fallback UI.
        navigator.serviceWorker.register = function() {
          return Promise.reject(new Error('Service Worker registration disabled by relay'));
        };
      }

      // Some sites gate an offline UI directly off navigator.onLine rather
      // than (or in addition to) a failed request — force it true so a
      // real network failure elsewhere doesn't get misread as "offline"
      // when the actual browser connection is fine.
      try {
        Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
      } catch (e) {}

      // document.baseURI is "<proxyOrigin>/<realAbsoluteUrl>" (see
      // BaseTagInjector). Strip the proxy prefix to recover the real
      // target's current URL, so we can resolve references (including
      // root-relative ones the browser can't handle via <base> alone)
      // against the REAL site, then wrap the result ourselves.
      function realBase() {
        var prefix = proxyOrigin + '/';
        if (document.baseURI.indexOf(prefix) === 0) {
          return document.baseURI.slice(prefix.length);
        }
        return document.baseURI;
      }

      // Mirrors decodeTrackingRedirect on the server side (same three
      // schemes). Needed here too because HTMLRewriter only ever sees the
      // initial server-rendered HTML — a search result link inserted into
      // the page by the site's OWN JavaScript (very likely, given how
      // JS-heavy modern search results rendering is) never passes through
      // server-side rewriting at all, only through this client-side path.
      function decodeTrackingRedirectClient(rawValue, baseUrl) {
        var u;
        try {
          u = new URL(rawValue, baseUrl);
        } catch (e) {
          return null;
        }
        if (/\/ck\/a$/i.test(u.pathname)) {
          var encoded = u.searchParams.get('u');
          if (encoded && encoded.slice(0, 2) === 'a1') {
            try {
              var b64 = encoded.slice(2).replace(/-/g, '+').replace(/_/g, '/');
              while (b64.length % 4 !== 0) b64 += '=';
              var decoded = atob(b64);
              if (/^https?:\/\//i.test(decoded)) return decoded;
            } catch (e) {}
          }
          return null;
        }
        if (/^\/url$/i.test(u.pathname) && /(^|\.)google\.[a-z.]+$/i.test(u.hostname)) {
          var q = u.searchParams.get('q');
          if (q && /^https?:\/\//i.test(q)) return q;
          return null;
        }
        if (/^\/l\/?$/i.test(u.pathname) && /(^|\.)duckduckgo\.com$/i.test(u.hostname)) {
          var uddg = u.searchParams.get('uddg');
          if (uddg && /^https?:\/\//i.test(uddg)) return uddg;
          return null;
        }
        return null;
      }

      function toProxied(raw) {
        try {
          if (typeof raw !== 'string' || !raw) return raw;
          if (/^(data|blob|javascript):/i.test(raw)) return raw;
          // Already a fully-proxied absolute URL (server-rewritten) — but
          // that doesn't mean there's nothing left to fix. The wrapped
          // target itself could still be an undecoded tracking-redirect
          // URL, so check it the same way an unwrapped one would be.
          var proxiedPrefix = proxyOrigin + '/http';
          if (raw.indexOf(proxiedPrefix) === 0) {
            var wrapped = raw.slice(proxyOrigin.length + 1);
            var decodedWrapped = decodeTrackingRedirectClient(wrapped, realBase());
            return decodedWrapped ? proxyOrigin + '/' + decodedWrapped : raw;
          }
          // Some components pre-resolve a root-relative src/url against
          // document.baseURI (our proxied <base>) before calling fetch —
          // that drops the real target, landing on the bare proxy origin
          // (e.g. GitHub's lazy-loaded sort/filter/"..." menus). Recover
          // the leftover path+query and re-resolve it against the real site
          // instead of wrapping the already-broken URL a second time.
          if (raw.indexOf(proxyOrigin) === 0) {
            var rest = raw.slice(proxyOrigin.length);
            var recovered = new URL(rest, realBase()).href;
            return proxyOrigin + '/' + recovered;
          }
          var decodedTarget = decodeTrackingRedirectClient(raw, realBase());
          var abs = new URL(decodedTarget || raw, realBase()).href;
          return proxyOrigin + '/' + abs;
        } catch (e) {
          return raw;
        }
      }

      // --- Attribute / property interception ----------------------------
      // This is the piece that makes rewriting actually stick on JS-rendered
      // content, and it works on a different principle from the
      // MutationObserver further below.
      //
      // The observer is REACTIVE: React writes a raw href, the observer sees
      // it afterward and rewrites it. Two problems follow. There's a window
      // where the raw URL is genuinely live in the DOM (exactly what the
      // hover preview reads). And React keeps its own record of what it
      // wrote — on its next render it compares that against the DOM, sees
      // our value as a mismatch, and reverts it. We rewrite again. That loop
      // is not winnable by racing it faster.
      //
      // Hooking the setter/setAttribute instead is PREEMPTIVE: the value is
      // converted at the moment of assignment, so the raw URL never lands in
      // the DOM at all — no window to observe, nothing to revert.
      //
      // The getter is the other half, and it's what actually breaks the
      // revert loop: reads return the ORIGINAL unproxied URL. React reads
      // back exactly what it believes it wrote, sees no mismatch, and leaves
      // it alone. Site logic that compares or parses its own URLs also keeps
      // working, which a one-way rewrite would quietly break.
      var relayNativeGetAttr = Element.prototype.getAttribute;
      var relayNativeSetAttr = Element.prototype.setAttribute;

      // Inverse of toProxied: unwrap "<proxyOrigin>/<realUrl>" back to the
      // real URL. Used only by the getters below.
      function fromProxied(url) {
        if (typeof url !== 'string' || !url) return url;
        var prefix = proxyOrigin + '/';
        if (url.indexOf(prefix) === 0) {
          var rest = url.slice(prefix.length);
          if (/^https?:\/\//i.test(rest)) return rest;
        }
        return url;
      }

      var RELAY_URL_ATTR_NAMES = { href: 1, src: 1, action: 1, data: 1, poster: 1 };

      try {
        Element.prototype.setAttribute = function(name, value) {
          try {
            if (RELAY_URL_ATTR_NAMES[name] && typeof value === 'string') {
              value = toProxied(value);
            }
          } catch (e) {}
          return relayNativeSetAttr.call(this, name, value);
        };
        Element.prototype.getAttribute = function(name) {
          var v = relayNativeGetAttr.call(this, name);
          try {
            if (RELAY_URL_ATTR_NAMES[name]) return fromProxied(v);
          } catch (e) {}
          return v;
        };
      } catch (e) {}

      // Same treatment for the DOM *properties* (el.href = ...), which are a
      // separate code path from setAttribute — frameworks use one or the
      // other, so both need covering.
      try {
        var relayPropList = [
          [window.HTMLAnchorElement, 'href'], [window.HTMLAreaElement, 'href'],
          [window.HTMLScriptElement, 'src'], [window.HTMLImageElement, 'src'],
          [window.HTMLLinkElement, 'href'], [window.HTMLIFrameElement, 'src'],
          [window.HTMLVideoElement, 'src'], [window.HTMLAudioElement, 'src'],
          [window.HTMLSourceElement, 'src'], [window.HTMLObjectElement, 'data'],
          [window.HTMLFormElement, 'action']
        ];
        for (var relayPi = 0; relayPi < relayPropList.length; relayPi++) {
          (function(ctor, prop) {
            try {
              if (!ctor || !ctor.prototype) return;
              var d = Object.getOwnPropertyDescriptor(ctor.prototype, prop);
              if (!d || !d.get || !d.set) return;
              Object.defineProperty(ctor.prototype, prop, {
                get: function() { return fromProxied(d.get.call(this)); },
                set: function(v) { d.set.call(this, toProxied(String(v))); },
                configurable: true
              });
            } catch (e) {}
          })(relayPropList[relayPi][0], relayPropList[relayPi][1]);
        }
      } catch (e) {}

      // --- Diagnostic overlay -------------------------------------------
      // Shows failed (non-2xx, network-error, or failed-to-load-resource)
      // requests in a small on-page panel — method, real target URL,
      // status — so a failure is visible and copyable as plain text
      // without opening DevTools or taking a screenshot. Purely
      // observational: never alters a request or its result, only logs
      // after the fact.
      var __relayFailures = [];
      var MAX_LOGGED = 15;

      function relayEnsurePanel() {
        if (document.getElementById('__relay_debug_panel')) return;
        var panel = document.createElement('div');
        panel.id = '__relay_debug_panel';
        panel.style.cssText = 'position:fixed;bottom:12px;right:12px;z-index:2147483647;' +
          'background:#111;border:1px solid #333;border-radius:6px;width:340px;max-height:280px;' +
          'overflow:auto;display:none;box-shadow:0 4px 16px rgba(0,0,0,.4);' +
          'font-family:ui-monospace,monospace;font-size:11px;';
        panel.innerHTML =
          '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;' +
          'padding:6px 8px;background:#1a1a1a;border-bottom:1px solid #333;">' +
          '<span style="color:#ccc;">relay B10-AUTH \u2014 failed requests</span>' +
          '<span style="display:flex;gap:10px;align-items:center;">' +
          '<button id="__relay_debug_copy" style="background:none;border:1px solid #444;' +
          'color:#ccc;border-radius:3px;cursor:pointer;font-size:10px;padding:2px 6px;">Copy</button>' +
          '<button id="__relay_debug_close" style="background:none;border:0;color:#888;' +
          'cursor:pointer;font-size:14px;line-height:1;">\u00d7</button></span></div>' +
          '<div id="__relay_debug_list"></div>';
        (document.body || document.documentElement).appendChild(panel);
        document.getElementById('__relay_debug_close').addEventListener('click', function() {
          panel.style.display = 'none';
        });
        document.getElementById('__relay_debug_copy').addEventListener('click', function() {
          var btn = document.getElementById('__relay_debug_copy');
          var text = __relayFailures.map(function(r) {
            return r.status + ' ' + r.method + ' ' + r.url + (r.note ? ' - ' + r.note : '');
          }).join('\n');
          function done(ok) { btn.textContent = ok ? 'Copied!' : 'Copy failed'; setTimeout(function() { btn.textContent = 'Copy'; }, 1500); }
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function() { done(true); }, function() { done(false); });
          } else {
            done(false);
          }
        });
      }

      function relayLogFailure(method, realUrl, status, note) {
        try {
          relayEnsurePanel();
          __relayFailures.unshift({ method: method, url: realUrl, status: status, note: note || '' });
          if (__relayFailures.length > MAX_LOGGED) __relayFailures.pop();
          var panel = document.getElementById('__relay_debug_panel');
          var list = document.getElementById('__relay_debug_list');
          if (!panel || !list) return;
          panel.style.display = 'block';
          list.innerHTML = __relayFailures.map(function(r) {
            return '<div style="padding:6px 8px;border-bottom:1px solid #262626;color:#eee;' +
              'word-break:break-all;"><b style="color:#ff8a63;">' + r.status + '</b> ' +
              r.method + ' ' + r.url + (r.note ? ' \u2014 ' + r.note : '') + '</div>';
          }).join('');
        } catch (e) {}
      }

      // own script 404ing) don't fire on fetch/XHR/WebSocket at all, and
      // these error events don't bubble — a capture-phase listener on
      // window is the only way to observe them globally. Previously
      // invisible to this panel entirely, despite being a very common
      // reason a page (or game) fails to render correctly.
      window.addEventListener('error', function(e) {
        var el = e.target;
        if (!el || !el.tagName) return;
        var tag = el.tagName.toUpperCase();
        if (['IMG', 'SCRIPT', 'LINK', 'AUDIO', 'VIDEO', 'SOURCE', 'IFRAME'].indexOf(tag) === -1) return;
        var src = el.src || el.href || '?';
        relayLogFailure(tag, src, 'LOAD_ERR', 'failed to load');
      }, true);
      // ---------------------------------------------------------------

      // calls fetch()/XHR with relative or root-relative URLs. Route them
      // through the proxy - same-origin from the browser's perspective, so
      // no CORS issue (the Worker does the real cross-origin fetch server-side).
      try {
        var origFetch = window.fetch;
        window.fetch = function(input, init) {
          var method = (init && init.method) || (input && input.method) || 'GET';
          var originalForLog = typeof input === 'string' ? input : (input && input.url) || '';
          try {
            if (typeof input === 'string') {
              input = toProxied(input);
            } else if (input && input.url) {
              input = new Request(toProxied(input.url), {
                method: input.method,
                headers: input.headers,
                body: ['GET', 'HEAD'].includes(input.method) ? undefined : input.body,
                credentials: input.credentials,
                redirect: input.redirect
              });
            }
          } catch (e) {}
          return origFetch.call(this, input, init).then(function(res) {
            if (!res.ok) relayLogFailure(method, originalForLog, res.status);
            return res;
          }, function(err) {
            relayLogFailure(method, originalForLog, 'ERR', err && err.message);
            throw err;
          });
        };
      } catch (e) {}

      try {
        var origOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url) {
          this.__relayMethod = method;
          this.__relayUrl = url;
          try {
            arguments[1] = toProxied(url);
          } catch (e) {}
          return origOpen.apply(this, arguments);
        };

        var origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.send = function() {
          var xhr = this;
          xhr.addEventListener('loadend', function() {
            if (xhr.status === 0 || xhr.status >= 400) {
              relayLogFailure(xhr.__relayMethod || '?', xhr.__relayUrl || '?', xhr.status || 'ERR');
            }
          });
          return origSend.apply(this, arguments);
        };
      } catch (e) {}

      // Search results (Bing, Google, etc.) very commonly open a result via
      // a JS window.open(url, '_blank') call rather than a plain link — a
      // separate API from fetch/XHR/click, previously unpatched entirely.
      // Rewrite the URL before it reaches the real window.open, same as
      // every other patched API above.
      try {
        if (typeof window.open === 'function') {
          var origWindowOpen = window.open;
          window.open = function(url, target, features) {
            var proxied;
            try {
              proxied = (url && !/^about:/i.test(url)) ? toProxied(String(url)) : url;
            } catch (e) {
              proxied = url;
            }
            return origWindowOpen.call(window, proxied, target, features);
          };
        }
      } catch (e) {}

      // EventSource (Server-Sent Events) is a distinct API from fetch/XHR —
      // many streaming chat/AI apps use it to deliver responses token by
      // token. Unpatched, a relative or cross-origin EventSource URL either
      // resolves against the wrong origin or hits a real CORS wall, and the
      // stream never opens — which can look like "nothing happens" on the
      // page (a message that never sends or never gets a reply).
      try {
        if (typeof window.EventSource === 'function') {
          var OrigEventSource = window.EventSource;
          var PatchedEventSource = function(url, opts) {
            return new OrigEventSource(toProxied(url), opts);
          };
          PatchedEventSource.prototype = OrigEventSource.prototype;
          PatchedEventSource.CONNECTING = OrigEventSource.CONNECTING;
          PatchedEventSource.OPEN = OrigEventSource.OPEN;
          PatchedEventSource.CLOSED = OrigEventSource.CLOSED;
          window.EventSource = PatchedEventSource;
        }
      } catch (e) {}

      // WebSocket is a separate global, untouched by the fetch/XHR patches
      // above. Unpatched, a page connecting to wss://real-site.com/socket
      // would either bypass the proxy entirely, or get rejected by the
      // target's own Origin check (the handshake's Origin header reflects
      // THIS page's origin — our proxy's — not the real site's). Route it
      // through the same path-embedded scheme instead.
      try {
        if (typeof window.WebSocket === 'function') {
          var OrigWebSocket = window.WebSocket;
          var proxyWsOrigin = proxyOrigin.replace(/^http/, 'ws');

          // Reuses toProxied()'s relative-URL resolution AND its
          // self-referential-origin recovery, by converting ws(s) <-> http(s)
          // around it, rather than duplicating that logic separately. Without
          // the recovery step, a page building its WS url from its own
          // location.origin — which, under this proxy, IS our own origin, a
          // common "connect to same-host websocket" pattern — produces a
          // self-referential URL the server has to refuse outright, which is
          // exactly what caused an endless connect/retry loop.
          var toProxiedWs = function(raw) {
            var httpForm = String(raw).replace(/^ws/, 'http');
            var proxiedHttp = toProxied(httpForm);
            var prefix = proxyOrigin + '/';
            if (proxiedHttp.indexOf(prefix) === 0) {
              return proxyWsOrigin + '/' + proxiedHttp.slice(prefix.length).replace(/^http/, 'ws');
            }
            return proxiedHttp.replace(/^http/, 'ws');
          };

          var PatchedWebSocket = function(url, protocols) {
            var proxied, realTarget;
            try {
              proxied = toProxiedWs(url);
              var wsPrefix = proxyWsOrigin + '/';
              realTarget = proxied.indexOf(wsPrefix) === 0 ? proxied.slice(wsPrefix.length) : proxied;
            } catch (e) {
              proxied = url;
              realTarget = url;
            }
            var sock = protocols !== undefined
              ? new OrigWebSocket(proxied, protocols)
              : new OrigWebSocket(proxied);
            sock.addEventListener('error', function() {
              relayLogFailure('WS', realTarget, 'ERR', 'connection failed');
            });
            sock.addEventListener('close', function(e) {
              // 1000/1005 are normal closure codes — anything else is worth
              // surfacing (e.g. the Worker rejected the upgrade, or the real
              // target refused the handshake).
              if (e.code !== 1000 && e.code !== 1005) {
                relayLogFailure('WS', realTarget, e.code, e.reason || 'closed unexpectedly');
              }
            });
            return sock;
          };
          PatchedWebSocket.prototype = OrigWebSocket.prototype;
          PatchedWebSocket.CONNECTING = OrigWebSocket.CONNECTING;
          PatchedWebSocket.OPEN = OrigWebSocket.OPEN;
          PatchedWebSocket.CLOSING = OrigWebSocket.CLOSING;
          PatchedWebSocket.CLOSED = OrigWebSocket.CLOSED;
          window.WebSocket = PatchedWebSocket;
        }
      } catch (e) {}

      // Under this proxy, two frames that the page author believes are on
      // different real origins (a game's outer chrome and its embedded
      // iframe, for instance) are BOTH actually served from this proxy's
      // own origin. postMessage's targetOrigin argument exists specifically
      // to restrict delivery to a matching origin — used correctly (an
      // explicit real origin, not '*'), it would silently fail here, since
      // the actual origin never matches what the page author wrote. This
      // was flagged previously as a likely contributor to cross-frame
      // game/widget communication breaking under the proxy.
      //
      // Rewriting to '*' trades away that origin check for correctness of
      // delivery — reasonable for a personal browsing proxy, but worth
      // being explicit about: this is not preserving the security boundary
      // the original page author intended.
      // Wrapped in try/catch deliberately: reassigning a native prototype
      // method can throw in some browser contexts, and an unguarded throw
      // here would silently halt the REST of this script's top-level
      // execution — including everything registered after it (pushState
      // patching, the click/submit interceptors). A postMessage patch
      // failing should cost only postMessage rewriting, not every
      // safety-critical patch that comes after it in the file.
      try {
        if (typeof Window !== 'undefined' && Window.prototype && Window.prototype.postMessage) {
          var origPostMessage = Window.prototype.postMessage;
          Window.prototype.postMessage = function(message, targetOrigin, transfer) {
            try {
              if (typeof targetOrigin === 'string' && targetOrigin !== '*') {
                targetOrigin = '*';
              }
            } catch (e) {}
            return origPostMessage.call(this, message, targetOrigin, transfer);
          };
        }
      } catch (e) {}

      // Use the RAW href attribute (not the browser-resolved .href), since a
      // root-relative raw value resolved natively would incorrectly bind to
      // the proxy's own origin rather than the real target's.
      //
      // Bubble phase (not capture), and back off if the page's own JS
      // already called preventDefault(). Sites commonly wrap non-navigating
      // controls — dropdown/menu triggers, tabs — in an <a> for styling and
      // handle the click themselves; capturing first stole those clicks and
      // forced a full reload instead of letting the page open its menu.
      // SPA client-side routing (history.pushState/replaceState) changes the
      // address bar directly, with no network request at all — none of the
      // fetch/XHR/WebSocket interceptors above can see this. A page's own
      // pushState('/results?q=hi') resolves against the CURRENT address
      // (our proxy), landing on the bare proxy origin with no embedded
      // target at all — this is what produced a URL like
      // "proxy.../results?search_query=hi" with youtube.com missing.
      function relayUpdateBaseTag(proxiedUrl) {
        try {
          var prefix = proxyOrigin + '/';
          if (proxiedUrl.indexOf(prefix + 'http') !== 0) return;
          var baseEl = document.querySelector('base');
          if (baseEl) baseEl.setAttribute('href', proxiedUrl);
        } catch (e) {}
      }

      // Wrapped for the same reason as the postMessage patch above: a throw
      // here must not be able to silently disable everything registered
      // after it, especially the click/submit interceptors.
      try {
        var origPushState = history.pushState;
        var origReplaceState = history.replaceState;

        history.pushState = function(state, title, url) {
          if (url !== undefined && url !== null) {
            url = toProxied(String(url));
            relayUpdateBaseTag(url);
          }
          return origPushState.call(this, state, title, url);
        };

        history.replaceState = function(state, title, url) {
          if (url !== undefined && url !== null) {
            url = toProxied(String(url));
            relayUpdateBaseTag(url);
          }
          return origReplaceState.call(this, state, title, url);
        };
      } catch (e) {}

      // Back/forward navigation between pushState entries restores the URL
      // without a network request either — keep <base> in sync there too.
      window.addEventListener('popstate', function() {
        relayUpdateBaseTag(location.href);
      });

      // Capture phase: must run BEFORE the page's own click-tracking-then-
      // navigate handlers, not after. Search engines commonly intercept
      // result clicks (preventDefault, log a beacon) then navigate via
      // their own location.href assignment shortly after — bubble phase +
      // checking e.defaultPrevented (an earlier approach) saw
      // defaultPrevented=true from that same preventDefault call and backed
      // off, letting their un-proxied navigation through untouched. That's
      // what let every search engine's result clicks escape the proxy.
      //
      // Skip elements that are semantically UI controls (menu/dropdown
      // triggers, tabs) rather than real navigation, using ARIA attributes
      // rather than timing — this preserves the original reason bubble
      // phase was tried (GitHub-style menus wrapped in <a> that the page
      // handles itself) without needing to run after the page to detect it.
      // Dynamically-created content (React, Vue, or any JS setting
      // href/src directly from already-fetched data) never passes through
      // server-side HTMLRewriter (which only sees the initial HTML) NOR
      // any of the fetch/XHR/WebSocket patches above (no new request
      // happens at render time — the data was already fetched earlier).
      // This is what left DuckDuckGo's actual result links — rendered by
      // React from a separately-fetched payload — completely unrewritten,
      // and it's a general pattern on any JS-heavy site, not DDG-specific.
      // Watching the DOM directly, rather than any particular request or
      // event, is the only way to catch this regardless of framework.
      var RELAY_URL_ATTRS = {
        A: 'href', IMG: 'src', SCRIPT: 'src', LINK: 'href', IFRAME: 'src',
        VIDEO: 'src', AUDIO: 'src', SOURCE: 'src', EMBED: 'src', OBJECT: 'data'
      };
      var RELAY_URL_SELECTOR =
        'a[href],img[src],script[src],link[href],iframe[src],' +
        'video[src],audio[src],source[src],embed[src],object[data]';

      function relayRewriteElement(el) {
        try {
          var attr = RELAY_URL_ATTRS[el.tagName];
          if (!attr) return;
          // Native accessors deliberately: the hooked getAttribute returns
          // the UNWRAPPED original, so the already-proxied check below would
          // never match and this would re-rewrite the same element forever,
          // each write retriggering the observer that called us.
          var raw = relayNativeGetAttr.call(el, attr);
          if (!raw || raw.charAt(0) === '#' || /^(javascript|data|blob|mailto|tel):/i.test(raw)) return;
          // Already correctly proxied — no-op. Also what stops this from
          // re-triggering itself forever: writing the rewritten value
          // below is itself an attribute mutation the observer sees, and
          // on that second pass this check is what makes it a no-op.
          if (raw.indexOf(proxyOrigin + '/http') === 0) return;
          var proxied = toProxied(raw);
          if (proxied && proxied !== raw) relayNativeSetAttr.call(el, attr, proxied);
        } catch (e) {}
      }

      function relayScanForUrlElements(node) {
        if (!node || node.nodeType !== 1) return;
        if (RELAY_URL_ATTRS[node.tagName]) relayRewriteElement(node);
        if (node.querySelectorAll) {
          var els = node.querySelectorAll(RELAY_URL_SELECTOR);
          for (var i = 0; i < els.length; i++) relayRewriteElement(els[i]);
        }
      }

      relayScanForUrlElements(document.documentElement);

      // Diagnostic sweep: find any <a href> that's still a raw absolute
      // external URL, not proxied at all — this is the concrete check for
      // whether relayScanForUrlElements/the MutationObserver above are
      // actually catching everything, rather than relying on manual
      // inspection. Runs a few times at increasing delays to also catch
      // content that renders later (lazy-loaded results, infinite scroll).
      function relayScanForStaleLinks() {
        try {
          var anchors = document.querySelectorAll('a[href]');
          var found = [];
          for (var i = 0; i < anchors.length && found.length < 5; i++) {
            var href = anchors[i].getAttribute('href');
            if (!/^https?:\/\//i.test(href)) continue; // only absolute http(s) hrefs are unambiguous
            if (href.indexOf(proxyOrigin) === 0) continue; // already correctly proxied
            found.push(href);
          }
          for (var j = 0; j < found.length; j++) {
            relayLogFailure('LINK', found[j], 'UNREWRITTEN', 'raw absolute href still in DOM');
          }
        } catch (e) {}
      }
      setTimeout(relayScanForStaleLinks, 1500);
      setTimeout(relayScanForStaleLinks, 4000);
      setTimeout(relayScanForStaleLinks, 8000);

      if (typeof MutationObserver === 'function') {
        var relayObserver = new MutationObserver(function(mutations) {
          for (var i = 0; i < mutations.length; i++) {
            var addedNodes = mutations[i].addedNodes;
            for (var j = 0; j < addedNodes.length; j++) {
              relayScanForUrlElements(addedNodes[j]);
            }
          }
        });
        relayObserver.observe(document.documentElement, { childList: true, subtree: true });
      }

      // Shared by 'click' and 'auxclick' below — auxclick is what fires for
      // middle-click/open-in-new-tab, a DIFFERENT event from 'click' that
      // this interceptor never saw before, so that path always used the
      // raw, un-rewritten href with no interception at all.
      function relayHandleLinkClick(e) {
        if (e.defaultPrevented) return;
        // e.target is retargeted to the shadow host for clicks originating
        // inside a Shadow DOM boundary (Web Components), so .closest('a')
        // on it can miss the actual link entirely, letting the click fall
        // through to native, unintercepted navigation. composedPath()
        // includes the true originating chain regardless of shadow
        // boundaries; falls back to [e.target] where unsupported.
        var path = typeof e.composedPath === 'function' ? e.composedPath() : [e.target];
        var link = null;
        for (var i = 0; i < path.length; i++) {
          if (path[i] && path[i].tagName === 'A') { link = path[i]; break; }
        }
        if (!link) {
          // Diagnostic: no <a> anywhere in the click's path at all. If a
          // site's "links" are actually non-anchor clickable elements (a
          // <div> or <span> with its own onClick, common in React UIs),
          // this interceptor can never see them regardless of any
          // href-handling logic — logging what WAS clicked is the only way
          // to confirm that rather than keep guessing blindly.
          try {
            var clickedEl = path[0];
            if (clickedEl && clickedEl.nodeType === 1) {
              var cls = clickedEl.className;
              var desc = clickedEl.tagName +
                (clickedEl.id ? '#' + clickedEl.id : '') +
                (typeof cls === 'string' && cls ? '.' + cls.trim().split(/\s+/).join('.') : '');
              relayLogFailure(e.type.toUpperCase(), desc, 'NO_LINK', 'no <a> found in click path');
            }
          } catch (err) {}
          return;
        }
        // aria-haspopup is a strong, unambiguous signal that this isn't
        // real navigation — it specifically means "opens a menu/dialog".
        // role="button" and aria-expanded are NOT reliable signals — both
        // are commonly applied to genuine navigating links too (component
        // libraries often mark any clickable-styled element this way,
        // search result titles included, regardless of whether it
        // navigates), and treating either as a skip signal let those
        // escape uncontrolled. Deliberately excluded.
        var haspopup = link.getAttribute('aria-haspopup');
        var isUiControl = haspopup && haspopup.toLowerCase() !== 'false';
        if (isUiControl) return;
        // Native accessor: the hooked getAttribute returns the unwrapped
        // original, which would defeat the already-proxied check below and
        // make this hijack every click instead of letting correct links
        // navigate natively.
        var raw = relayNativeGetAttr.call(link, 'href');
        if (!raw || raw.charAt(0) === '#' || /^(javascript|mailto|tel):/i.test(raw)) return;
        // Already correctly proxied (the common case — any link server-side
        // rewriting already handled) — do nothing and let native browser
        // behavior take it from here. Intercepting anyway needlessly blocks
        // any other legitimate click handler the site had on this link (via
        // stopImmediatePropagation below), and forcing target="_blank"
        // through window.open() instead of native anchor behavior is
        // exactly the kind of pattern some browsers' popup blockers flag.
        if (raw.indexOf(proxyOrigin + '/http') === 0) return;
        e.preventDefault();
        // Without this, the page's own handler still runs afterward (
        // preventDefault doesn't stop propagation) and its un-proxied
        // location.href assignment would overwrite ours a moment later —
        // same tick, last assignment wins.
        e.stopImmediatePropagation();
        var proxied = toProxied(raw);
        // auxclick (middle-click) always means a new tab, regardless of the
        // link's own target attribute — that's the whole point of the
        // gesture. Plain click respects target="_blank" the same as before.
        if (e.type === 'auxclick' || (link.target && link.target !== '_self')) {
          window.open(proxied, e.type === 'auxclick' ? '_blank' : link.target);
        } else {
          window.location.href = proxied;
        }
      }
      document.addEventListener('click', relayHandleLinkClick, true);
      document.addEventListener('auxclick', relayHandleLinkClick, true);

      // Shared by both the 'submit' event listener below (catches
      // requestSubmit() and genuine user-triggered submissions) and the
      // HTMLFormElement.prototype.submit() patch further down (catches
      // direct .submit() calls, which — per spec — never fire a 'submit'
      // event at all, so the listener alone can't see them).
      function relaySubmitGetForm(form) {
        var target = form.getAttribute('data-proxy-target') || form.action;
        if (!target) return false;
        var method = (form.getAttribute('method') || 'get').toLowerCase();
        if (method !== 'get') return false; // POST left to default handling
        var urlObj = new URL(target, realBase());
        var params = new URLSearchParams();
        new FormData(form).forEach(function(value, key) {
          if (typeof value === 'string') params.append(key, value);
        });
        urlObj.search = params.toString();
        window.location.href = proxyOrigin + '/' + urlObj.href;
        return true;
      }

      document.addEventListener('submit', function(e) {
        var form = e.target;
        if (!form || form.tagName !== 'FORM') return;
        if (relaySubmitGetForm(form)) e.preventDefault();
      }, true);

      // form.submit() bypasses the 'submit' event entirely (a documented
      // DOM quirk) — a <textarea>-based search box (which doesn't submit
      // on Enter natively, unlike a single-line <input>) commonly has its
      // own JS call this directly to make Enter work, which is invisible
      // to the listener above no matter what it does.
      try {
        var origFormSubmit = HTMLFormElement.prototype.submit;
        HTMLFormElement.prototype.submit = function() {
          try {
            if (relaySubmitGetForm(this)) return;
          } catch (e) {}
          return origFormSubmit.call(this);
        };
      } catch (e) {}
    })();
    </script>
  `,
      { html: true }
    );
  }
}//   to avoid recursive self-fetches.
// - WebSocket connections are bridged (see handleWebSocketUpgrade and the
//   client-side WebSocket override below) — browser <-> Worker <-> real
//   target, including converting the handshake's Origin header to the real
//   target's own origin, since many WS servers reject a mismatched one.

const SW_PATH = '/__proxy_sw.js';

const SW_SCRIPT = `
// Without these, a newly-deployed version of this script doesn't take over
// an already-open tab until every tab using the OLD version is closed —
// standard SW lifecycle behavior, but it means a redeploy can silently
// leave a browser running stale logic indefinitely, causing confusing
// behavior that only a hard reload (forcing a fresh update check) fixes.
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Already correctly path-embedded, or the SW script/root usage page — leave alone.
  if (/^\\/https?:\\/\\//.test(url.pathname)) return;
  if (url.pathname === '${SW_PATH}') return;
  if (url.pathname === '/' && !url.search) return;

  // A request landed at our bare origin with no embedded target — recover
  // the real site from whichever proxied page issued it.
  const ref = req.referrer;
  if (!ref) return;
  try {
    const refUrl = new URL(ref);
    const embedded = refUrl.pathname.slice(1);
    const m = embedded.match(/^(https?:\\/\\/[^/]+)/);
    if (!m) return;
    const corrected = self.location.origin + '/' + m[1] + url.pathname + url.search;
    event.respondWith(Response.redirect(corrected, 302));
  } catch (e) {
    // fall through to default handling
  }
});
`;

const HOME_HTML = `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Relay</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #FFFFFF;
    --surface: #F6F6F5;
    --border: #E1E1DE;
    --text: #131316;
    --text-dim: #6C6C72;
    --accent: #2547F4;
    --accent-dim: #E9ECFE;
    --warn: #C7431E;
  }
  html[data-theme="dark"] {
    --bg: #0A0A0C;
    --surface: #151517;
    --border: #29292D;
    --text: #F1F1EF;
    --text-dim: #8B8B91;
    --accent: #6C89FF;
    --accent-dim: #16193A;
    --warn: #FF8A63;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: 'Space Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    -webkit-font-smoothing: antialiased;
    transition: background 0.25s ease, color 0.25s ease;
  }
  .wrap {
    min-height: 100%;
    display: flex;
    flex-direction: column;
    max-width: 640px;
    margin: 0 auto;
    padding: 28px 24px 60px;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: clamp(48px, 12vh, 96px);
  }
  .mark {
    display: flex;
    align-items: center;
    gap: 10px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    letter-spacing: 0.08em;
    color: var(--text-dim);
    text-transform: uppercase;
  }
  .mark .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
  }
  .theme-toggle {
    width: 34px;
    height: 34px;
    border-radius: 4px;
    border: 1px solid var(--border);
    background: var(--surface);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    color: var(--text);
    transition: border-color 0.15s ease;
  }
  .theme-toggle:hover { border-color: var(--text-dim); }
  .theme-toggle svg { width: 15px; height: 15px; }

  main { flex: 1; }

  .eyebrow {
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--accent);
    margin: 0 0 14px;
  }
  h1 {
    font-size: clamp(36px, 7vw, 52px);
    font-weight: 600;
    line-height: 1.05;
    letter-spacing: -0.02em;
    margin: 0 0 16px;
  }
  .sub {
    font-size: 16px;
    line-height: 1.5;
    color: var(--text-dim);
    max-width: 46ch;
    margin: 0 0 40px;
  }

  form { margin-bottom: 56px; }
  .field {
    display: flex;
    align-items: center;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--surface);
    transition: border-color 0.15s ease;
  }
  .field:focus-within { border-color: var(--accent); }
  .field input {
    flex: 1;
    border: 0;
    background: transparent;
    outline: none;
    padding: 16px 4px 16px 16px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 14px;
    color: var(--text);
  }
  .field input::placeholder { color: var(--text-dim); }
  .field button {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 46px;
    height: 46px;
    margin: 4px;
    border: 0;
    border-radius: 3px;
    background: var(--accent);
    color: var(--bg);
    cursor: pointer;
    flex-shrink: 0;
    transition: opacity 0.15s ease;
  }
  html[data-theme="dark"] .field button { color: #0A0A0C; }
  .field button:hover { opacity: 0.85; }
  .field button svg { width: 17px; height: 17px; }
  .hint {
    margin: 10px 2px 0;
    font-size: 13px;
    color: var(--text-dim);
    min-height: 18px;
  }
  .hint.error { color: var(--warn); }

  .trace {
    display: flex;
    align-items: center;
    gap: 0;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--text-dim);
  }
  .trace .node { display: flex; flex-direction: column; align-items: center; gap: 8px; flex-shrink: 0; }
  .trace .node span.sq {
    width: 9px; height: 9px;
    border: 1px solid var(--text-dim);
  }
  .trace .node.active span.sq { background: var(--accent); border-color: var(--accent); }
  .trace .line {
    flex: 1;
    height: 1px;
    background: var(--border);
    position: relative;
    margin: 0 -1px;
    top: -13px;
  }
  .trace .line .pulse {
    position: absolute;
    top: -2px;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--accent);
    animation: travel 3.2s linear infinite;
  }
  @keyframes travel {
    0% { left: 0%; opacity: 0; }
    8% { opacity: 1; }
    92% { opacity: 1; }
    100% { left: 100%; opacity: 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    .trace .line .pulse { animation: none; opacity: 0.6; left: 50%; }
  }

  footer {
    margin-top: 64px;
    padding-top: 20px;
    border-top: 1px solid var(--border);
    display: flex;
    justify-content: space-between;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: var(--text-dim);
    letter-spacing: 0.04em;
  }

  @media (max-width: 460px) {
    .trace .node span.label { display: none; }
  }
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <div class="mark"><span class="dot"></span>relay</div>
      <button class="theme-toggle" id="themeToggle" aria-label="Switch theme" type="button">
        <svg id="themeIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
          <circle cx="12" cy="12" r="4.6"></circle>
          <path d="M12 2.4v2.4M12 19.2v2.4M4.4 12H2M22 12h-2.4M5.6 5.6l1.7 1.7M16.7 16.7l1.7 1.7M5.6 18.4l1.7-1.7M16.7 7.3l1.7-1.7"></path>
        </svg>
      </button>
    </header>

    <main>
      <p class="eyebrow">// relay</p>
      <h1>Route any address<br>through here.</h1>
      <p class="sub">Enter a URL. It loads through this relay, links and scripts included, without leaving the address bar.</p>

      <form id="goForm" autocomplete="off">
        <div class="field">
          <input id="urlInput" type="text" inputmode="url" placeholder="example.com/path" spellcheck="false" autofocus>
          <button type="submit" aria-label="Go">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square">
              <path d="M4 12h15M13 6l6 6-6 6"></path>
            </svg>
          </button>
        </div>
        <p class="hint" id="hint">Prefix is optional — https:// is assumed.</p>
      </form>

      <div class="trace" id="trace">
        <div class="node active"><span class="sq"></span><span class="label">you</span></div>
        <div class="line"><span class="pulse"></span></div>
        <div class="node"><span class="sq"></span><span class="label">relay</span></div>
        <div class="line"><span class="pulse" style="animation-delay: 1.6s;"></span></div>
        <div class="node"><span class="sq"></span><span class="label">target</span></div>
      </div>
    </main>

    <footer>
      <span id="originLabel"></span>
      <span>build B9-LEAN · path-embedded</span>
    </footer>
  </div>

<script>
(function() {
  var root = document.documentElement;
  var sunPath = 'M12 2.4v2.4M12 19.2v2.4M4.4 12H2M22 12h-2.4M5.6 5.6l1.7 1.7M16.7 16.7l1.7 1.7M5.6 18.4l1.7-1.7M16.7 7.3l1.7-1.7';
  var moonPath = 'M20 14.6A8.4 8.4 0 1 1 9.4 4a6.7 6.7 0 0 0 10.6 10.6z';

  function applyIcon(theme) {
    var circle = document.querySelector('#themeIcon circle');
    var path = document.querySelector('#themeIcon path');
    if (theme === 'dark') {
      if (circle) circle.setAttribute('r', '0');
      path.setAttribute('d', moonPath);
    } else {
      if (circle) circle.setAttribute('r', '4.6');
      path.setAttribute('d', sunPath);
    }
  }

  var saved = null;
  try { saved = localStorage.getItem('relay-theme'); } catch (e) {}
  var theme = saved || 'light';
  root.setAttribute('data-theme', theme);
  applyIcon(theme);

  document.getElementById('themeToggle').addEventListener('click', function() {
    theme = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', theme);
    applyIcon(theme);
    try { localStorage.setItem('relay-theme', theme); } catch (e) {}
  });

  document.getElementById('originLabel').textContent = location.origin.replace(/^https?:\\/\\//, '');

  var input = document.getElementById('urlInput');
  var hint = document.getElementById('hint');
  var trace = document.getElementById('trace');

  function go() {
    var val = input.value.trim();
    if (!val) { hint.textContent = 'Enter an address first.'; hint.className = 'hint error'; return; }
    if (!/^https?:\\/\\//i.test(val)) val = 'https://' + val;
    try {
      var u = new URL(val);
      if (u.origin === location.origin) {
        hint.textContent = "That's this relay's own address — enter the site you want to visit instead.";
        hint.className = 'hint error';
        return;
      }
      trace.classList.add('sending');
      window.location.href = location.origin + '/' + u.href;
    } catch (e) {
      hint.textContent = 'That address doesn\\'t look valid.';
      hint.className = 'hint error';
    }
  }

  document.getElementById('goForm').addEventListener('submit', function(e) {
    e.preventDefault();
    go();
  });

  input.addEventListener('input', function() {
    hint.textContent = 'Prefix is optional — https:// is assumed.';
    hint.className = 'hint';
  });
})();
</script>
</body>
</html>`;

// Shared error page — same design tokens, fonts, and theme toggle as
// HOME_HTML, kept as a separate template so the working homepage is never
// touched by changes here. status/title/message/detail/targetUrl are all
// escaped before interpolation.
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function errorPage({ status, title, message, detail, targetUrl, proxyOrigin }) {
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  const safeDetail = detail ? escapeHtml(detail) : '';
  const safeTarget = targetUrl ? escapeHtml(targetUrl) : '';
  const homeUrl = escapeHtml(proxyOrigin + '/');

  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${status} — Relay</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #FFFFFF;
    --surface: #F6F6F5;
    --border: #E1E1DE;
    --text: #131316;
    --text-dim: #6C6C72;
    --accent: #2547F4;
    --accent-dim: #E9ECFE;
    --warn: #C7431E;
  }
  html[data-theme="dark"] {
    --bg: #0A0A0C;
    --surface: #151517;
    --border: #29292D;
    --text: #F1F1EF;
    --text-dim: #8B8B91;
    --accent: #6C89FF;
    --accent-dim: #16193A;
    --warn: #FF8A63;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: 'Space Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    -webkit-font-smoothing: antialiased;
    transition: background 0.25s ease, color 0.25s ease;
  }
  .wrap {
    min-height: 100%;
    display: flex;
    flex-direction: column;
    max-width: 640px;
    margin: 0 auto;
    padding: 28px 24px 60px;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: clamp(48px, 12vh, 96px);
  }
  .mark {
    display: flex;
    align-items: center;
    gap: 10px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    letter-spacing: 0.08em;
    color: var(--text-dim);
    text-transform: uppercase;
    text-decoration: none;
  }
  .mark .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--warn);
  }
  .theme-toggle {
    width: 34px;
    height: 34px;
    border-radius: 4px;
    border: 1px solid var(--border);
    background: var(--surface);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    color: var(--text);
    transition: border-color 0.15s ease;
  }
  .theme-toggle:hover { border-color: var(--text-dim); }
  .theme-toggle svg { width: 15px; height: 15px; }

  main { flex: 1; }

  .code {
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--warn);
    margin: 0 0 14px;
  }
  h1 {
    font-size: clamp(30px, 6vw, 44px);
    font-weight: 600;
    line-height: 1.1;
    letter-spacing: -0.02em;
    margin: 0 0 16px;
  }
  .sub {
    font-size: 16px;
    line-height: 1.5;
    color: var(--text-dim);
    max-width: 50ch;
    margin: 0 0 8px;
  }
  .detail {
    font-size: 14px;
    line-height: 1.5;
    color: var(--text-dim);
    max-width: 50ch;
    margin: 0 0 32px;
  }
  .target {
    display: block;
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 12px 14px;
    margin: 0 0 32px;
    word-break: break-all;
  }
  .actions {
    display: flex;
    gap: 12px;
    margin-bottom: 56px;
  }
  .btn {
    font-family: 'Space Grotesk', sans-serif;
    font-size: 14px;
    font-weight: 500;
    text-decoration: none;
    padding: 12px 20px;
    border-radius: 4px;
    cursor: pointer;
    border: 1px solid transparent;
  }
  .btn.primary {
    background: var(--accent);
    color: var(--bg);
    border: 0;
  }
  html[data-theme="dark"] .btn.primary { color: #0A0A0C; }
  .btn.primary:hover { opacity: 0.85; }
  .btn.secondary {
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
  }
  .btn.secondary:hover { border-color: var(--text-dim); }

  .trace {
    display: flex;
    align-items: center;
    gap: 0;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--text-dim);
  }
  .trace .node { display: flex; flex-direction: column; align-items: center; gap: 8px; flex-shrink: 0; }
  .trace .node span.sq { width: 9px; height: 9px; border: 1px solid var(--text-dim); }
  .trace .node.active span.sq { background: var(--accent); border-color: var(--accent); }
  .trace .node.broken span.sq { background: var(--warn); border-color: var(--warn); }
  .trace .line { flex: 1; height: 1px; background: var(--border); margin: 0 -1px; top: -13px; position: relative; }
  .trace .line.broken { background: repeating-linear-gradient(90deg, var(--warn), var(--warn) 4px, transparent 4px, transparent 8px); }

  footer {
    margin-top: auto;
    padding-top: 20px;
    border-top: 1px solid var(--border);
    display: flex;
    justify-content: space-between;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: var(--text-dim);
    letter-spacing: 0.04em;
  }
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <a class="mark" href="/"><span class="dot"></span>relay</a>
      <button class="theme-toggle" id="themeToggle" aria-label="Switch theme" type="button">
        <svg id="themeIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
          <circle cx="12" cy="12" r="4.6"></circle>
          <path d="M12 2.4v2.4M12 19.2v2.4M4.4 12H2M22 12h-2.4M5.6 5.6l1.7 1.7M16.7 16.7l1.7 1.7M5.6 18.4l1.7-1.7M16.7 7.3l1.7-1.7"></path>
        </svg>
      </button>
    </header>

    <main>
      <p class="code">// error ${status}</p>
      <h1>${safeTitle}</h1>
      <p class="sub">${safeMessage}</p>
      ${safeDetail ? `<p class="detail">${safeDetail}</p>` : ''}
      ${safeTarget ? `<code class="target">${safeTarget}</code>` : ''}

      <div class="actions">
        <a class="btn primary" href="${homeUrl}">Back to relay</a>
        <button class="btn secondary" id="goBackBtn" type="button">Go back</button>
      </div>

      <div class="trace">
        <div class="node active"><span class="sq"></span><span>you</span></div>
        <div class="line"></div>
        <div class="node active"><span class="sq"></span><span>relay</span></div>
        <div class="line broken"></div>
        <div class="node broken"><span class="sq"></span><span>target</span></div>
      </div>
    </main>

    <footer>
      <span id="originLabel"></span>
      <span>status ${status}</span>
    </footer>
  </div>

<script>
(function() {
  var root = document.documentElement;
  var sunPath = 'M12 2.4v2.4M12 19.2v2.4M4.4 12H2M22 12h-2.4M5.6 5.6l1.7 1.7M16.7 16.7l1.7 1.7M5.6 18.4l1.7-1.7M16.7 7.3l1.7-1.7';
  var moonPath = 'M20 14.6A8.4 8.4 0 1 1 9.4 4a6.7 6.7 0 0 0 10.6 10.6z';

  function applyIcon(theme) {
    var circle = document.querySelector('#themeIcon circle');
    var path = document.querySelector('#themeIcon path');
    if (theme === 'dark') {
      if (circle) circle.setAttribute('r', '0');
      path.setAttribute('d', moonPath);
    } else {
      if (circle) circle.setAttribute('r', '4.6');
      path.setAttribute('d', sunPath);
    }
  }

  var saved = null;
  try { saved = localStorage.getItem('relay-theme'); } catch (e) {}
  var theme = saved || 'light';
  root.setAttribute('data-theme', theme);
  applyIcon(theme);

  document.getElementById('themeToggle').addEventListener('click', function() {
    theme = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', theme);
    applyIcon(theme);
    try { localStorage.setItem('relay-theme', theme); } catch (e) {}
  });

  document.getElementById('originLabel').textContent = location.origin.replace(/^https?:\\/\\//, '');

  document.getElementById('goBackBtn').addEventListener('click', function() {
    // history.length > 1 means there's actually somewhere to go back to —
    // if this page was the first entry in the tab (a directly pasted or
    // bookmarked URL), history.back() would otherwise silently do nothing.
    if (window.history.length > 1) {
      window.history.back();
    } else {
      window.location.href = '${homeUrl}';
    }
  });
})();
</script>
</body>
</html>`;
}

function errorResponse(proxyOrigin, status, title, message, detail, targetUrl) {
  return new Response(errorPage({ status, title, message, detail, targetUrl, proxyOrigin }), {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

// WebSocket bridging: browser <-> this Worker <-> the real target.
// The client-side WebSocket constructor override (in ScriptInjector) routes
// ws(s) connections through this same path-embedded scheme (e.g.
// /wss://real.com/socket); this is the server-side half that completes the
// handshake on both ends and relays messages/close/error between them.
//
// Cloudflare Workers negotiate an OUTBOUND WebSocket via a plain http(s)
// fetch() with an Upgrade header set — not a literal wss:// URL — and the
// far end is then exposed as `response.webSocket`.
async function handleWebSocketUpgrade(request, url, proxyOrigin) {
  const targetUrl = url.pathname.slice(1) + url.search;
  if (!/^wss?:\/\//i.test(targetUrl)) {
    return new Response('Invalid WebSocket target', { status: 400 });
  }

  let parsedTarget;
  try {
    parsedTarget = new URL(targetUrl);
  } catch {
    return new Response('Invalid WebSocket target', { status: 400 });
  }
  if (parsedTarget.origin.replace(/^wss?/, 'https') === proxyOrigin) {
    return new Response('Refusing to proxy the relay itself', { status: 400 });
  }

  const httpEquivalent = parsedTarget.href.replace(/^ws/, 'http');
  const realOrigin = parsedTarget.origin.replace(/^ws/, 'http');

  const upstreamHeaders = new Headers({
    'Upgrade': 'websocket',
    'Connection': 'Upgrade',
    // Real target origin, not our proxy's — many WebSocket servers reject
    // the handshake outright if Origin doesn't match their own site.
    'Origin': realOrigin,
    // Real browser UA, not a fixed spoofed one — see buildUpstreamHeaders.
    'User-Agent': request.headers.get('User-Agent') || FALLBACK_USER_AGENT
  });
  // Forward subprotocol negotiation. The browser's WebSocket constructor
  // sends its offered protocols in this header; it must eventually see
  // back whichever one the real server actually chose (below), or
  // socket.protocol is empty and strict clients reject the connection.
  const requestedProtocol = request.headers.get('Sec-WebSocket-Protocol');
  if (requestedProtocol) upstreamHeaders.set('Sec-WebSocket-Protocol', requestedProtocol);

  let upstream;
  try {
    // 10s is generous for a handshake specifically (not the connection's
    // lifetime — once upstream.webSocket exists below, it's independent of
    // this timeout) while still failing fast on an unreachable game server
    // rather than leaving the connecting UI hanging indefinitely.
    upstream = await fetchUpstream(httpEquivalent, { headers: upstreamHeaders }, 10000);
  } catch (err) {
    return new Response('WebSocket upstream connection failed: ' + err.message, { status: 502 });
  }

  const upstreamSocket = upstream.webSocket;
  if (!upstreamSocket) {
    return new Response('Target did not upgrade to WebSocket', { status: 502 });
  }

  let client, server;
  try {
    upstreamSocket.accept();
    [client, server] = Object.values(new WebSocketPair());
    server.accept();
  } catch (err) {
    try { upstreamSocket.close(); } catch {}
    return new Response('WebSocket bridge setup failed: ' + err.message, { status: 502 });
  }

  server.addEventListener('message', (e) => {
    try { upstreamSocket.send(e.data); } catch {}
  });
  upstreamSocket.addEventListener('message', (e) => {
    try { server.send(e.data); } catch {}
  });
  server.addEventListener('close', (e) => {
    try { upstreamSocket.close(e.code, e.reason); } catch {}
  });
  upstreamSocket.addEventListener('close', (e) => {
    try { server.close(e.code, e.reason); } catch {}
  });
  server.addEventListener('error', () => { try { upstreamSocket.close(); } catch {} });
  upstreamSocket.addEventListener('error', () => { try { server.close(); } catch {} });

  // Echo back whichever subprotocol the REAL server actually accepted —
  // not simply the client's request verbatim.
  const acceptedProtocol = upstream.headers.get('Sec-WebSocket-Protocol');
  const responseInit = { status: 101, webSocket: client };
  if (acceptedProtocol) {
    responseInit.headers = { 'Sec-WebSocket-Protocol': acceptedProtocol };
  }
  return new Response(null, responseInit);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const proxyOrigin = url.origin;

    if (request.headers.get('Upgrade') === 'websocket') {
      return handleWebSocketUpgrade(request, url, proxyOrigin);
    }

    if (url.pathname === SW_PATH) {
      return new Response(SW_SCRIPT, {
        headers: { 'Content-Type': 'application/javascript' }
      });
    }

    const alreadyEmbedded = /^\/https?:\/\//i.test(url.pathname);

    // Legacy ?url=... links: never served directly — always redirect to the
    // canonical path-embedded form, so ?url= never lingers in the URL bar.
    if (url.searchParams.has('url') && !alreadyEmbedded) {
      let legacy = url.searchParams.get('url');
      if (!/^https?:\/\//i.test(legacy)) legacy = 'https://' + legacy;
      try {
        const canonical = proxyOrigin + '/' + new URL(legacy).href;
        return Response.redirect(canonical, 301);
      } catch {
        return errorResponse(proxyOrigin, 400, "That address didn't parse", "The URL passed via ?url= couldn't be read as a valid address.", null, legacy);
      }
    }

    // Any other request that isn't already correctly path-embedded is a
    // root-relative reference that escaped to the bare origin (a direct
    // `location.href = '/x'` assignment, a request the Service Worker hasn't
    // taken control of yet, etc). Recover the real target from the request's
    // Referer — the browser sets this automatically to whichever proxied
    // page issued the request — and redirect to the corrected URL rather
    // than silently failing or mis-serving it.
    if (!alreadyEmbedded) {
      const ref = request.headers.get('Referer');
      if (ref) {
        try {
          const refUrl = new URL(ref);
          if (refUrl.origin === proxyOrigin) {
            const embedded = refUrl.pathname.slice(1);
            const m = embedded.match(/^(https?:\/\/[^/]+)/);
            if (m) {
              const corrected = proxyOrigin + '/' + m[1] + url.pathname + url.search;
              return Response.redirect(corrected, 302);
            }
          }
        } catch {
          // fall through
        }
      }
    }

    // Path-embedded target, e.g. "/https://example.com/page" + "?x=1"
    let targetUrl = url.pathname.slice(1) + url.search;

    if (!targetUrl) {
      return new Response(HOME_HTML, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    // No scheme and no Referer to recover from — treat as a bare domain
    // typed directly (e.g. someone navigated straight to
    // proxy.dev/example.com with no prior proxied page).
    if (!/^https?:\/\//i.test(targetUrl)) {
      targetUrl = 'https://' + targetUrl;
    }

    // Defensive cap against pathological input, before even trying to parse it.
    if (targetUrl.length > 8000) {
      return errorResponse(proxyOrigin, 414, 'That address is too long', "The target URL exceeds what this relay will attempt to proxy.", null, targetUrl.slice(0, 200) + '…');
    }

    let parsedTarget;
    try {
      parsedTarget = new URL(targetUrl);
    } catch {
      return errorResponse(proxyOrigin, 400, "That address didn't parse", "The target couldn't be read as a valid URL — check it for typos.", null, targetUrl);
    }
    if (!['http:', 'https:'].includes(parsedTarget.protocol)) {
      return errorResponse(proxyOrigin, 400, 'Unsupported protocol', 'This relay only forwards http:// and https:// addresses.', null, parsedTarget.href);
    }
    // Refuse a self-referential target — otherwise the Worker would fetch
    // its own origin, recursively, on a crafted or accidental link.
    if (parsedTarget.origin === proxyOrigin) {
      return errorResponse(proxyOrigin, 400, 'Refusing to proxy itself', "This address points back at the relay's own origin, which would cause it to fetch itself.", null, parsedTarget.href);
    }

    // Edge cache: identical proxied requests skip origin + rewriting entirely.
    // GET-only — the Cache API throws on non-GET requests.
    const cacheable = request.method === 'GET';
    const cache = caches.default;
    const cacheKey = new Request(request.url, request);
    if (cacheable) {
      const cached = await cache.match(cacheKey);
      if (cached) return cached;
    }

    const upstreamInit = {
      method: request.method,
      headers: buildUpstreamHeaders(request, proxyOrigin, parsedTarget.origin),
      redirect: 'follow',
      // cacheEverything is safe here specifically because this proxy never
      // forwards cookies (see README limitations) — every response is
      // already the same generic, non-personalized view for everyone, so
      // caching it at Cloudflare's fetch layer (not just our own edge
      // cache below) cuts a real origin round-trip on repeat hits.
      cf: { cacheTtl: 120, cacheEverything: true }
    };
    // Forward the real request body for non-GET/HEAD methods — previously
    // every upstream fetch was an implicit GET regardless of the incoming
    // request, silently dropping POST bodies (breaks GraphQL calls, search
    // suggestions, and anything else proxied fetch/XHR calls send as POST).
    if (!['GET', 'HEAD'].includes(request.method) && request.body) {
      upstreamInit.body = request.body;
      upstreamInit.duplex = 'half';
    }

    let upstream;
    try {
      upstream = await fetchUpstream(parsedTarget.href, upstreamInit);
    } catch (error) {
      return errorResponse(proxyOrigin, 502, "Couldn't reach that address", 'The request to the target failed before any response came back.', error.message, parsedTarget.href);
    }

    // Cloudflare's own edge — not the target site — returns these statuses
    // for connectivity failures (DNS didn't resolve, origin unreachable,
    // etc). fetch() doesn't throw for these; it resolves as a normal-looking
    // HTML response, which would otherwise get rewritten and served as if
    // it were the real page. Show our own explanation instead.
    const CF_EDGE_ERROR_STATUSES = new Set([520, 521, 522, 523, 524, 525, 526, 527, 530]);
    if (CF_EDGE_ERROR_STATUSES.has(upstream.status)) {
      return errorResponse(proxyOrigin, 502, "Couldn't reach that address", "The target domain didn't respond — it may not exist, or is temporarily unreachable.", 'Double-check the address for typos.', parsedTarget.href);
    }

    const contentType = upstream.headers.get('content-type') || '';

    // Non-HTML: stream through untouched, but for static asset types (JS,
    // CSS, fonts, images) that browsers otherwise under-cache, extend
    // Cache-Control client-side AND store at the edge — a chunk fetched by
    // one visitor is then served instantly to the next, skipping the origin
    // and the Worker's rewriting path entirely.
    if (!contentType.includes('text/html')) {
      // Search engines increasingly deliver actual result data via a
      // separate payload fetched by client-side JS (confirmed for
      // DuckDuckGo's links.duckduckgo.com/d.js) rather than embedding
      // results in the initial HTML at all — HTMLRewriter can never reach
      // this, since it only ever sees that initial response. Rewriting the
      // URLs in the response TEXT itself, here, means the data is already
      // correct by the time the page's own JS parses and uses it — no
      // fighting a framework's own re-rendering after the fact. Narrow and
      // explicit: a small, known list of search-engine data hosts, not a
      // general "rewrite URLs in any response" rule, which would risk
      // corrupting arbitrary application code that uses URL-like strings
      // for its own internal logic.
      if (SEARCH_DATA_HOSTS.has(parsedTarget.hostname)) {
        const text = await upstream.text();
        const rewritten = rewriteEmbeddedUrls(text, upstream.url || parsedTarget.href, proxyOrigin);
        return new Response(rewritten, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: upstream.headers
        });
      }

      if (upstream.status === 200 && isLongCacheable(contentType)) {
        const headers = new Headers(upstream.headers);
        headers.set('Cache-Control', 'public, max-age=86400');
        const asset = new Response(upstream.body, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers
        });
        // .clone() tees the stream, roughly doubling in-flight buffering —
        // fine for a typical script/image, wasteful and riskier for a large
        // game/WASM bundle (these commonly run 50-200MB+). Skip our OWN
        // edge-cache write above the threshold; the browser still benefits
        // from the Cache-Control header above either way.
        const lengthHeader = upstream.headers.get('content-length');
        const tooLargeToCache = lengthHeader && parseInt(lengthHeader, 10) > ASSET_CACHE_SIZE_LIMIT;
        if (cacheable && !tooLargeToCache) ctx.waitUntil(cache.put(cacheKey, asset.clone()));
        return asset;
      }
      return upstream;
    }

    // upstream.url is the FINAL URL after any redirects fetch() followed
    // server-side — using the pre-redirect parsedTarget.href here would
    // resolve every relative link/script/etc against the wrong page
    // whenever the target redirects (auth flows, trailing-slash/canonical
    // redirects, moved domains).
    const baseUrl = upstream.url || parsedTarget.href;
    const proxiedBase = proxyOrigin + '/' + baseUrl;

    const rewriter = new HTMLRewriter()
      .on('a[href]', new AttrRewriter('href', baseUrl, proxyOrigin))
      .on('img[src]', new AttrRewriter('src', baseUrl, proxyOrigin))
      .on('script[src]', new AttrRewriter('src', baseUrl, proxyOrigin))
      .on('link[href]', new AttrRewriter('href', baseUrl, proxyOrigin))
      .on('iframe[src]', new AttrRewriter('src', baseUrl, proxyOrigin))
      .on('video[src]', new AttrRewriter('src', baseUrl, proxyOrigin))
      .on('video[poster]', new AttrRewriter('poster', baseUrl, proxyOrigin))
      .on('audio[src]', new AttrRewriter('src', baseUrl, proxyOrigin))
      .on('source[src]', new AttrRewriter('src', baseUrl, proxyOrigin))
      .on('embed[src]', new AttrRewriter('src', baseUrl, proxyOrigin))
      .on('object[data]', new AttrRewriter('data', baseUrl, proxyOrigin))
      .on('form', new FormRewriter(baseUrl))
      .on('img[srcset]', new SrcsetRewriter(baseUrl, proxyOrigin))
      .on('source[srcset]', new SrcsetRewriter(baseUrl, proxyOrigin))
      .on('meta[http-equiv]', new MetaRefreshRewriter(baseUrl, proxyOrigin))
      .on('head', new BaseTagInjector(proxiedBase))
      .on('head', new ScriptInjector(proxyOrigin));

    const transformed = rewriter.transform(upstream);

    const response = new Response(transformed.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=60'
      }
    });

    if (cacheable) ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  }
};

function proxify(absoluteUrl, proxyOrigin) {
  return proxyOrigin + '/' + absoluteUrl;
}

// Headers we set ourselves, that leak the proxy's own domain if forwarded
// verbatim, or that are hop-by-hop/infra-only and meaningless upstream.
// Everything else the page/browser actually sent is forwarded as-is — an
// allowlist here would always be one custom header behind real-world sites
// (anti-abuse tokens, API versioning headers, CSRF tokens, etc); a denylist
// is far more robust. Cookies specifically are never forwarded (see README
// limitations).
const DROP_HEADERS = new Set([
  'host', 'cookie', 'content-length', 'connection',
  'user-agent',
  'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor', 'cf-worker',
  'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host',
  'referer', 'origin' // handled specially below, not silently forwarded raw
]);

// Recovers the real target URL embedded in a proxy-origin header value
// (e.g. a Referer/Origin the browser set to our own domain), or null if the
// value isn't one of ours.
function recoverRealUrl(headerValue, proxyOrigin) {
  if (!headerValue) return null;
  try {
    const u = new URL(headerValue);
    if (u.origin !== proxyOrigin) return null;
    const embedded = u.pathname.slice(1);
    return /^https?:\/\//i.test(embedded) ? embedded : null;
  } catch {
    return null;
  }
}

function buildUpstreamHeaders(request, proxyOrigin, targetOrigin) {
  const headers = new Headers();
  // Forward the REAL browser's own User-Agent rather than a fixed spoofed
  // string. This request's Sec-Ch-Ua/Sec-Fetch-* headers (forwarded below,
  // since they're not in DROP_HEADERS) already reflect the real browser —
  // a substituted User-Agent that doesn't match them is an internal
  // inconsistency that bot-detection systems specifically look for. Only
  // fall back to a generic default if the client somehow sent none at all.
  const realUA = request.headers.get('User-Agent');
  headers.set('User-Agent', realUA || FALLBACK_USER_AGENT);
  // Accept-Encoding is NOT set here — the real browser's own value is
  // forwarded via the denylist loop below, for the same reason as
  // User-Agent above: a substituted value that doesn't match what a real
  // browser of that claimed identity would actually send is a detectable
  // inconsistency.

  for (const [name, value] of request.headers) {
    if (DROP_HEADERS.has(name.toLowerCase())) continue;
    headers.set(name, value);
  }

  // Referer carries a full path, so the real target can be recovered from
  // its content. Origin never carries a path (just scheme+host) — there's
  // nothing to recover from it, so when the browser sent one at all, set it
  // to the request's own known real target origin instead.
  const realReferer = recoverRealUrl(request.headers.get('Referer'), proxyOrigin);
  if (realReferer) headers.set('Referer', realReferer);

  if (request.headers.get('Origin')) {
    headers.set('Origin', targetOrigin);
  }

  return headers;
}

// Above this, skip our own edge-cache write for a static asset (still gets
// browser-side Cache-Control either way) — see the asset-caching branch.
const ASSET_CACHE_SIZE_LIMIT = 20 * 1024 * 1024; // 20MB

// Only used on the rare request that arrives with no User-Agent at all (the
// normal path forwards the real browser's own UA — see buildUpstreamHeaders
// and handleWebSocketUpgrade). Must be a complete, correctly-formed string:
// the previous fallback was truncated to just "AppleWebKit/537.36" with no
// "(KHTML, like Gecko) Chrome/... Safari/..." suffix — no real browser has
// ever sent that fragment alone, and it's exactly the kind of malformed
// signature basic bot-detection checks for.
const FALLBACK_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Parses Retry-After as either delta-seconds or an HTTP-date, per spec.
// Returns null when absent or unparseable.
function parseRetryAfterMs(header) {
  if (!header) return null;
  const asInt = parseInt(header, 10);
  if (!Number.isNaN(asInt) && String(asInt) === header.trim()) return asInt * 1000;
  const asDate = Date.parse(header);
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
  return null;
}

// Fails fast on a hung/stalled upstream rather than letting the request run
// indefinitely — bounded so a single slow connection can't quietly eat the
// Worker's whole execution budget. Only wraps the request itself; once a
// WebSocket handshake completes, the resulting socket lives independently
// of this signal and is unaffected by it.
async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 20000);
  try {
    return await fetch(url, Object.assign({}, init, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}

// One retry on transient network failure (DNS blip, connection reset) —
// not on HTTP error statuses, which are legitimate responses returned as-is
// either way. Only retried when there's no body: a ReadableStream can only
// be read once, so a request that already carries one gets a single try.
//
// Also adds a short, capped retry specifically for throttling responses
// (429/503) that include a short Retry-After — relevant for game traffic
// especially, since many concurrent relay users hitting the same game
// server can all appear to originate from Cloudflare's own IP ranges,
// making a real rate limit more likely to be hit than for ordinary
// browsing. Capped at 2s and one attempt so a single request can never
// stall for long chasing a throttle that isn't going to clear soon.
async function fetchUpstream(url, init, timeoutMs) {
  let response;
  try {
    response = await fetchWithTimeout(url, init, timeoutMs);
  } catch (err) {
    if (init.body) throw err;
    response = await fetchWithTimeout(url, init, timeoutMs);
  }

  if ((response.status === 429 || response.status === 503) && !init.body) {
    const waitMs = parseRetryAfterMs(response.headers.get('Retry-After'));
    if (waitMs !== null && waitMs <= 2000) {
      await sleep(waitMs);
      try {
        response = await fetchWithTimeout(url, init, timeoutMs);
      } catch {
        // keep the original throttled response if the retry itself fails
      }
    }
  }

  return response;
}

// Content-types safe to cache aggressively client-side: static, commonly
// content-hashed, and re-requested often by proxied SPAs. Deliberately
// excludes video/audio (range-request/seeking behavior) and anything
// JSON/API-shaped (freshness matters).
const STATIC_CACHE_TYPES = ['text/css', 'javascript', 'image/', 'font/'];
function isLongCacheable(contentType) {
  return STATIC_CACHE_TYPES.some((t) => contentType.includes(t));
}

// Known search-engine data endpoints — the actual result payload, not the
// page shell. Confirmed for DuckDuckGo by inspecting its response directly;
// add others here once their equivalent endpoint is identified the same way
// (this list is deliberately small and explicit, not a guess).
const SEARCH_DATA_HOSTS = new Set(['links.duckduckgo.com']);

// Rewrites embedded absolute URLs in a search-data response's raw text,
// before the page's own JS ever parses it. Handles both plain
// (https://example.com) and JSON-escaped (https:\/\/example.com) forms,
// since these payloads are commonly JSONP-wrapped JSON — re-escaping the
// result the same way the match was found, so the surrounding JSON's own
// escaping convention stays consistent for whatever later parses it.
function rewriteEmbeddedUrls(text, baseUrl, proxyOrigin) {
  return text.replace(/https?:(?:\\\/|[^\s"'\\])+/g, (match) => {
    try {
      const wasEscaped = match.indexOf('\\/') !== -1;
      const unescaped = match.replace(/\\\//g, '/');
      const abs = new URL(unescaped, baseUrl).href;
      const proxied = proxyOrigin + '/' + abs;
      return wasEscaped ? proxied.replace(/\//g, '\\/') : proxied;
    } catch {
      return match;
    }
  });
}

// Bing (and similar) wrap search-result links in a server-side
// click-tracking redirect (bing.com/ck/a?...&u=a1<base64>...) that serves
// an interstitial page whose own JS then navigates onward — commonly via a
// direct, unpatchable location assignment straight to the real external
// destination, which escapes the proxy entirely (window.location can't be
// intercepted from page JS, and the resulting request never reaches this
// Worker to be recovered server-side). Decoding the real destination here
// and linking straight to it skips the interstitial, and its escape,
// altogether. Falls through to the tracking URL unchanged if the pattern
// or encoding doesn't match — never breaks the link.
// Major search engines wrap result links in a server-side click-tracking
// redirect that serves an interstitial page whose own JS then navigates
// onward — commonly via a direct, unpatchable location assignment straight
// to the real external destination, which escapes the proxy entirely
// (window.location can't be intercepted from page JS, and the resulting
// request never reaches this Worker to be recovered server-side).
// Decoding the real destination here and linking straight to it skips the
// interstitial, and its escape, altogether. Falls through to the tracking
// URL unchanged if no known pattern matches — never breaks a link.
function decodeTrackingRedirect(rawValue, baseUrl) {
  let u;
  try {
    u = new URL(rawValue, baseUrl);
  } catch {
    return null;
  }

  // Bing: /ck/a?...&u=a1<base64url, unpadded>...
  if (/\/ck\/a$/i.test(u.pathname)) {
    const encoded = u.searchParams.get('u');
    if (encoded && encoded.slice(0, 2) === 'a1') {
      try {
        let b64 = encoded.slice(2).replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4 !== 0) b64 += '=';
        const decoded = atob(b64);
        if (/^https?:\/\//i.test(decoded)) return decoded;
      } catch {
        // fall through
      }
    }
    return null;
  }

  // Google: /url?q=<url-encoded destination>
  if (/^\/url$/i.test(u.pathname) && /(^|\.)google\.[a-z.]+$/i.test(u.hostname)) {
    const q = u.searchParams.get('q');
    if (q && /^https?:\/\//i.test(q)) return q;
    return null;
  }

  // DuckDuckGo: /l/?uddg=<url-encoded destination>
  if (/^\/l\/?$/i.test(u.pathname) && /(^|\.)duckduckgo\.com$/i.test(u.hostname)) {
    const uddg = u.searchParams.get('uddg');
    if (uddg && /^https?:\/\//i.test(uddg)) return uddg;
    return null;
  }

  return null;
}

function resolveAndProxy(value, baseUrl, proxyOrigin) {
  if (value === null || value === undefined) return null;
  if (/^(javascript|data|mailto|tel|#)/i.test(value)) return null;
  try {
    const target = decodeTrackingRedirect(value, baseUrl) || value;
    const abs = new URL(target, baseUrl).href;
    return proxify(abs, proxyOrigin);
  } catch {
    return null;
  }
}

class AttrRewriter {
  constructor(attr, baseUrl, proxyOrigin) {
    this.attr = attr;
    this.baseUrl = baseUrl;
    this.proxyOrigin = proxyOrigin;
  }
  element(el) {
    const val = el.getAttribute(this.attr);
    const newVal = resolveAndProxy(val, this.baseUrl, this.proxyOrigin);
    if (newVal) el.setAttribute(this.attr, newVal);
  }
}

// GET forms strip any existing query string from `action` on submit, so a
// proxied action gets clobbered by the form's own fields. Instead, stash the
// resolved real target URL and let injected JS build the request.
class FormRewriter {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
  }
  element(el) {
    const actionVal = el.getAttribute('action') || '';
    let abs;
    try {
      abs = new URL(actionVal, this.baseUrl).href;
    } catch {
      abs = this.baseUrl;
    }
    el.setAttribute('data-proxy-target', abs);
  }
}

class SrcsetRewriter {
  constructor(baseUrl, proxyOrigin) {
    this.baseUrl = baseUrl;
    this.proxyOrigin = proxyOrigin;
  }
  element(el) {
    const val = el.getAttribute('srcset');
    if (!val) return;
    const rewritten = val
      .split(',')
      .map((part) => {
        const trimmed = part.trim();
        const spaceIdx = trimmed.search(/\s/);
        const u = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
        const descriptor = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx).trim();
        const proxied = resolveAndProxy(u, this.baseUrl, this.proxyOrigin);
        if (!proxied) return trimmed;
        return descriptor ? `${proxied} ${descriptor}` : proxied;
      })
      .join(', ');
    el.setAttribute('srcset', rewritten);
  }
}

// <meta http-equiv="refresh" content="N;url=..."> is a real HTML redirect
// mechanism, distinct from an HTTP 3xx response and untouched by any other
// rewriter — a page using it to redirect would otherwise send the browser
// straight to the real, un-proxied destination.
class MetaRefreshRewriter {
  constructor(baseUrl, proxyOrigin) {
    this.baseUrl = baseUrl;
    this.proxyOrigin = proxyOrigin;
  }
  element(el) {
    const httpEquiv = el.getAttribute('http-equiv');
    if (!httpEquiv || httpEquiv.toLowerCase() !== 'refresh') return;
    const content = el.getAttribute('content');
    if (!content) return;
    const match = content.match(/^(\s*[\d.]*\s*;\s*url\s*=\s*)(.+)$/i);
    if (!match) return;
    const [, prefix, rawUrl] = match;
    const cleanUrl = rawUrl.trim().replace(/^['"]|['"]$/g, '');
    const proxied = resolveAndProxy(cleanUrl, this.baseUrl, this.proxyOrigin);
    if (proxied) el.setAttribute('content', prefix + proxied);
  }
}

// Makes directory-relative references from JS-created/dynamic content (never
// seen by HTMLRewriter, since it only runs on the initial HTML response)
// resolve against the *proxied* current page instead of escaping to the
// proxy's own root.
class BaseTagInjector {
  constructor(proxiedBase) {
    this.proxiedBase = proxiedBase;
  }
  element(el) {
    el.prepend(`<base href="${this.proxiedBase}">`, { html: true });
  }
}

class ScriptInjector {
  constructor(proxyOrigin) {
    this.proxyOrigin = proxyOrigin;
  }
  element(el) {
    el.prepend(
      `
    <script>
    (function() {
      var proxyOrigin = '${this.proxyOrigin}';

      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('${SW_PATH}').catch(function() {});

        // Block the TARGET site's own Service Worker registration attempts.
        // A foreign site's SW can't function correctly under our proxied
        // URL scheme (its internal relative references assume the real
        // site's own paths), and if it takes over fetch handling on this
        // origin, its requests start failing — which is exactly the
        // trigger many sites use to show a "you're offline" fallback UI.
        navigator.serviceWorker.register = function() {
          return Promise.reject(new Error('Service Worker registration disabled by relay'));
        };
      }

      // Some sites gate an offline UI directly off navigator.onLine rather
      // than (or in addition to) a failed request — force it true so a
      // real network failure elsewhere doesn't get misread as "offline"
      // when the actual browser connection is fine.
      try {
        Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
      } catch (e) {}

      // document.baseURI is "<proxyOrigin>/<realAbsoluteUrl>" (see
      // BaseTagInjector). Strip the proxy prefix to recover the real
      // target's current URL, so we can resolve references (including
      // root-relative ones the browser can't handle via <base> alone)
      // against the REAL site, then wrap the result ourselves.
      function realBase() {
        var prefix = proxyOrigin + '/';
        if (document.baseURI.indexOf(prefix) === 0) {
          return document.baseURI.slice(prefix.length);
        }
        return document.baseURI;
      }

      // Mirrors decodeTrackingRedirect on the server side (same three
      // schemes). Needed here too because HTMLRewriter only ever sees the
      // initial server-rendered HTML — a search result link inserted into
      // the page by the site's OWN JavaScript (very likely, given how
      // JS-heavy modern search results rendering is) never passes through
      // server-side rewriting at all, only through this client-side path.
      function decodeTrackingRedirectClient(rawValue, baseUrl) {
        var u;
        try {
          u = new URL(rawValue, baseUrl);
        } catch (e) {
          return null;
        }
        if (/\/ck\/a$/i.test(u.pathname)) {
          var encoded = u.searchParams.get('u');
          if (encoded && encoded.slice(0, 2) === 'a1') {
            try {
              var b64 = encoded.slice(2).replace(/-/g, '+').replace(/_/g, '/');
              while (b64.length % 4 !== 0) b64 += '=';
              var decoded = atob(b64);
              if (/^https?:\/\//i.test(decoded)) return decoded;
            } catch (e) {}
          }
          return null;
        }
        if (/^\/url$/i.test(u.pathname) && /(^|\.)google\.[a-z.]+$/i.test(u.hostname)) {
          var q = u.searchParams.get('q');
          if (q && /^https?:\/\//i.test(q)) return q;
          return null;
        }
        if (/^\/l\/?$/i.test(u.pathname) && /(^|\.)duckduckgo\.com$/i.test(u.hostname)) {
          var uddg = u.searchParams.get('uddg');
          if (uddg && /^https?:\/\//i.test(uddg)) return uddg;
          return null;
        }
        return null;
      }

      function toProxied(raw) {
        try {
          if (typeof raw !== 'string' || !raw) return raw;
          if (/^(data|blob|javascript):/i.test(raw)) return raw;
          // Already a fully-proxied absolute URL (server-rewritten) — but
          // that doesn't mean there's nothing left to fix. The wrapped
          // target itself could still be an undecoded tracking-redirect
          // URL, so check it the same way an unwrapped one would be.
          var proxiedPrefix = proxyOrigin + '/http';
          if (raw.indexOf(proxiedPrefix) === 0) {
            var wrapped = raw.slice(proxyOrigin.length + 1);
            var decodedWrapped = decodeTrackingRedirectClient(wrapped, realBase());
            return decodedWrapped ? proxyOrigin + '/' + decodedWrapped : raw;
          }
          // Some components pre-resolve a root-relative src/url against
          // document.baseURI (our proxied <base>) before calling fetch —
          // that drops the real target, landing on the bare proxy origin
          // (e.g. GitHub's lazy-loaded sort/filter/"..." menus). Recover
          // the leftover path+query and re-resolve it against the real site
          // instead of wrapping the already-broken URL a second time.
          if (raw.indexOf(proxyOrigin) === 0) {
            var rest = raw.slice(proxyOrigin.length);
            var recovered = new URL(rest, realBase()).href;
            return proxyOrigin + '/' + recovered;
          }
          var decodedTarget = decodeTrackingRedirectClient(raw, realBase());
          var abs = new URL(decodedTarget || raw, realBase()).href;
          return proxyOrigin + '/' + abs;
        } catch (e) {
          return raw;
        }
      }

      // --- Attribute / property interception ----------------------------
      // This is the piece that makes rewriting actually stick on JS-rendered
      // content, and it works on a different principle from the
      // MutationObserver further below.
      //
      // The observer is REACTIVE: React writes a raw href, the observer sees
      // it afterward and rewrites it. Two problems follow. There's a window
      // where the raw URL is genuinely live in the DOM (exactly what the
      // hover preview reads). And React keeps its own record of what it
      // wrote — on its next render it compares that against the DOM, sees
      // our value as a mismatch, and reverts it. We rewrite again. That loop
      // is not winnable by racing it faster.
      //
      // Hooking the setter/setAttribute instead is PREEMPTIVE: the value is
      // converted at the moment of assignment, so the raw URL never lands in
      // the DOM at all — no window to observe, nothing to revert.
      //
      // The getter is the other half, and it's what actually breaks the
      // revert loop: reads return the ORIGINAL unproxied URL. React reads
      // back exactly what it believes it wrote, sees no mismatch, and leaves
      // it alone. Site logic that compares or parses its own URLs also keeps
      // working, which a one-way rewrite would quietly break.
      var relayNativeGetAttr = Element.prototype.getAttribute;
      var relayNativeSetAttr = Element.prototype.setAttribute;

      // Inverse of toProxied: unwrap "<proxyOrigin>/<realUrl>" back to the
      // real URL. Used only by the getters below.
      function fromProxied(url) {
        if (typeof url !== 'string' || !url) return url;
        var prefix = proxyOrigin + '/';
        if (url.indexOf(prefix) === 0) {
          var rest = url.slice(prefix.length);
          if (/^https?:\/\//i.test(rest)) return rest;
        }
        return url;
      }

      var RELAY_URL_ATTR_NAMES = { href: 1, src: 1, action: 1, data: 1, poster: 1 };

      try {
        Element.prototype.setAttribute = function(name, value) {
          try {
            if (RELAY_URL_ATTR_NAMES[name] && typeof value === 'string') {
              value = toProxied(value);
            }
          } catch (e) {}
          return relayNativeSetAttr.call(this, name, value);
        };
        Element.prototype.getAttribute = function(name) {
          var v = relayNativeGetAttr.call(this, name);
          try {
            if (RELAY_URL_ATTR_NAMES[name]) return fromProxied(v);
          } catch (e) {}
          return v;
        };
      } catch (e) {}

      // Same treatment for the DOM *properties* (el.href = ...), which are a
      // separate code path from setAttribute — frameworks use one or the
      // other, so both need covering.
      try {
        var relayPropList = [
          [window.HTMLAnchorElement, 'href'], [window.HTMLAreaElement, 'href'],
          [window.HTMLScriptElement, 'src'], [window.HTMLImageElement, 'src'],
          [window.HTMLLinkElement, 'href'], [window.HTMLIFrameElement, 'src'],
          [window.HTMLVideoElement, 'src'], [window.HTMLAudioElement, 'src'],
          [window.HTMLSourceElement, 'src'], [window.HTMLObjectElement, 'data'],
          [window.HTMLFormElement, 'action']
        ];
        for (var relayPi = 0; relayPi < relayPropList.length; relayPi++) {
          (function(ctor, prop) {
            try {
              if (!ctor || !ctor.prototype) return;
              var d = Object.getOwnPropertyDescriptor(ctor.prototype, prop);
              if (!d || !d.get || !d.set) return;
              Object.defineProperty(ctor.prototype, prop, {
                get: function() { return fromProxied(d.get.call(this)); },
                set: function(v) { d.set.call(this, toProxied(String(v))); },
                configurable: true
              });
            } catch (e) {}
          })(relayPropList[relayPi][0], relayPropList[relayPi][1]);
        }
      } catch (e) {}

      // --- Diagnostic overlay -------------------------------------------
      // Shows failed (non-2xx, network-error, or failed-to-load-resource)
      // requests in a small on-page panel — method, real target URL,
      // status — so a failure is visible and copyable as plain text
      // without opening DevTools or taking a screenshot. Purely
      // observational: never alters a request or its result, only logs
      // after the fact.
      var __relayFailures = [];
      var MAX_LOGGED = 15;

      function relayEnsurePanel() {
        if (document.getElementById('__relay_debug_panel')) return;
        var panel = document.createElement('div');
        panel.id = '__relay_debug_panel';
        panel.style.cssText = 'position:fixed;bottom:12px;right:12px;z-index:2147483647;' +
          'background:#111;border:1px solid #333;border-radius:6px;width:340px;max-height:280px;' +
          'overflow:auto;display:none;box-shadow:0 4px 16px rgba(0,0,0,.4);' +
          'font-family:ui-monospace,monospace;font-size:11px;';
        panel.innerHTML =
          '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;' +
          'padding:6px 8px;background:#1a1a1a;border-bottom:1px solid #333;">' +
          '<span style="color:#ccc;">relay B9-LEAN \u2014 failed requests</span>' +
          '<span style="display:flex;gap:10px;align-items:center;">' +
          '<button id="__relay_debug_copy" style="background:none;border:1px solid #444;' +
          'color:#ccc;border-radius:3px;cursor:pointer;font-size:10px;padding:2px 6px;">Copy</button>' +
          '<button id="__relay_debug_close" style="background:none;border:0;color:#888;' +
          'cursor:pointer;font-size:14px;line-height:1;">\u00d7</button></span></div>' +
          '<div id="__relay_debug_list"></div>';
        (document.body || document.documentElement).appendChild(panel);
        document.getElementById('__relay_debug_close').addEventListener('click', function() {
          panel.style.display = 'none';
        });
        document.getElementById('__relay_debug_copy').addEventListener('click', function() {
          var btn = document.getElementById('__relay_debug_copy');
          var text = __relayFailures.map(function(r) {
            return r.status + ' ' + r.method + ' ' + r.url + (r.note ? ' - ' + r.note : '');
          }).join('\n');
          function done(ok) { btn.textContent = ok ? 'Copied!' : 'Copy failed'; setTimeout(function() { btn.textContent = 'Copy'; }, 1500); }
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function() { done(true); }, function() { done(false); });
          } else {
            done(false);
          }
        });
      }

      function relayLogFailure(method, realUrl, status, note) {
        try {
          relayEnsurePanel();
          __relayFailures.unshift({ method: method, url: realUrl, status: status, note: note || '' });
          if (__relayFailures.length > MAX_LOGGED) __relayFailures.pop();
          var panel = document.getElementById('__relay_debug_panel');
          var list = document.getElementById('__relay_debug_list');
          if (!panel || !list) return;
          panel.style.display = 'block';
          list.innerHTML = __relayFailures.map(function(r) {
            return '<div style="padding:6px 8px;border-bottom:1px solid #262626;color:#eee;' +
              'word-break:break-all;"><b style="color:#ff8a63;">' + r.status + '</b> ' +
              r.method + ' ' + r.url + (r.note ? ' \u2014 ' + r.note : '') + '</div>';
          }).join('');
        } catch (e) {}
      }

      // own script 404ing) don't fire on fetch/XHR/WebSocket at all, and
      // these error events don't bubble — a capture-phase listener on
      // window is the only way to observe them globally. Previously
      // invisible to this panel entirely, despite being a very common
      // reason a page (or game) fails to render correctly.
      window.addEventListener('error', function(e) {
        var el = e.target;
        if (!el || !el.tagName) return;
        var tag = el.tagName.toUpperCase();
        if (['IMG', 'SCRIPT', 'LINK', 'AUDIO', 'VIDEO', 'SOURCE', 'IFRAME'].indexOf(tag) === -1) return;
        var src = el.src || el.href || '?';
        relayLogFailure(tag, src, 'LOAD_ERR', 'failed to load');
      }, true);
      // ---------------------------------------------------------------

      // calls fetch()/XHR with relative or root-relative URLs. Route them
      // through the proxy - same-origin from the browser's perspective, so
      // no CORS issue (the Worker does the real cross-origin fetch server-side).
      try {
        var origFetch = window.fetch;
        window.fetch = function(input, init) {
          var method = (init && init.method) || (input && input.method) || 'GET';
          var originalForLog = typeof input === 'string' ? input : (input && input.url) || '';
          try {
            if (typeof input === 'string') {
              input = toProxied(input);
            } else if (input && input.url) {
              input = new Request(toProxied(input.url), {
                method: input.method,
                headers: input.headers,
                body: ['GET', 'HEAD'].includes(input.method) ? undefined : input.body,
                credentials: input.credentials,
                redirect: input.redirect
              });
            }
          } catch (e) {}
          return origFetch.call(this, input, init).then(function(res) {
            if (!res.ok) relayLogFailure(method, originalForLog, res.status);
            return res;
          }, function(err) {
            relayLogFailure(method, originalForLog, 'ERR', err && err.message);
            throw err;
          });
        };
      } catch (e) {}

      try {
        var origOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url) {
          this.__relayMethod = method;
          this.__relayUrl = url;
          try {
            arguments[1] = toProxied(url);
          } catch (e) {}
          return origOpen.apply(this, arguments);
        };

        var origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.send = function() {
          var xhr = this;
          xhr.addEventListener('loadend', function() {
            if (xhr.status === 0 || xhr.status >= 400) {
              relayLogFailure(xhr.__relayMethod || '?', xhr.__relayUrl || '?', xhr.status || 'ERR');
            }
          });
          return origSend.apply(this, arguments);
        };
      } catch (e) {}

      // Search results (Bing, Google, etc.) very commonly open a result via
      // a JS window.open(url, '_blank') call rather than a plain link — a
      // separate API from fetch/XHR/click, previously unpatched entirely.
      // Rewrite the URL before it reaches the real window.open, same as
      // every other patched API above.
      try {
        if (typeof window.open === 'function') {
          var origWindowOpen = window.open;
          window.open = function(url, target, features) {
            var proxied;
            try {
              proxied = (url && !/^about:/i.test(url)) ? toProxied(String(url)) : url;
            } catch (e) {
              proxied = url;
            }
            return origWindowOpen.call(window, proxied, target, features);
          };
        }
      } catch (e) {}

      // EventSource (Server-Sent Events) is a distinct API from fetch/XHR —
      // many streaming chat/AI apps use it to deliver responses token by
      // token. Unpatched, a relative or cross-origin EventSource URL either
      // resolves against the wrong origin or hits a real CORS wall, and the
      // stream never opens — which can look like "nothing happens" on the
      // page (a message that never sends or never gets a reply).
      try {
        if (typeof window.EventSource === 'function') {
          var OrigEventSource = window.EventSource;
          var PatchedEventSource = function(url, opts) {
            return new OrigEventSource(toProxied(url), opts);
          };
          PatchedEventSource.prototype = OrigEventSource.prototype;
          PatchedEventSource.CONNECTING = OrigEventSource.CONNECTING;
          PatchedEventSource.OPEN = OrigEventSource.OPEN;
          PatchedEventSource.CLOSED = OrigEventSource.CLOSED;
          window.EventSource = PatchedEventSource;
        }
      } catch (e) {}

      // WebSocket is a separate global, untouched by the fetch/XHR patches
      // above. Unpatched, a page connecting to wss://real-site.com/socket
      // would either bypass the proxy entirely, or get rejected by the
      // target's own Origin check (the handshake's Origin header reflects
      // THIS page's origin — our proxy's — not the real site's). Route it
      // through the same path-embedded scheme instead.
      try {
        if (typeof window.WebSocket === 'function') {
          var OrigWebSocket = window.WebSocket;
          var proxyWsOrigin = proxyOrigin.replace(/^http/, 'ws');

          // Reuses toProxied()'s relative-URL resolution AND its
          // self-referential-origin recovery, by converting ws(s) <-> http(s)
          // around it, rather than duplicating that logic separately. Without
          // the recovery step, a page building its WS url from its own
          // location.origin — which, under this proxy, IS our own origin, a
          // common "connect to same-host websocket" pattern — produces a
          // self-referential URL the server has to refuse outright, which is
          // exactly what caused an endless connect/retry loop.
          var toProxiedWs = function(raw) {
            var httpForm = String(raw).replace(/^ws/, 'http');
            var proxiedHttp = toProxied(httpForm);
            var prefix = proxyOrigin + '/';
            if (proxiedHttp.indexOf(prefix) === 0) {
              return proxyWsOrigin + '/' + proxiedHttp.slice(prefix.length).replace(/^http/, 'ws');
            }
            return proxiedHttp.replace(/^http/, 'ws');
          };

          var PatchedWebSocket = function(url, protocols) {
            var proxied, realTarget;
            try {
              proxied = toProxiedWs(url);
              var wsPrefix = proxyWsOrigin + '/';
              realTarget = proxied.indexOf(wsPrefix) === 0 ? proxied.slice(wsPrefix.length) : proxied;
            } catch (e) {
              proxied = url;
              realTarget = url;
            }
            var sock = protocols !== undefined
              ? new OrigWebSocket(proxied, protocols)
              : new OrigWebSocket(proxied);
            sock.addEventListener('error', function() {
              relayLogFailure('WS', realTarget, 'ERR', 'connection failed');
            });
            sock.addEventListener('close', function(e) {
              // 1000/1005 are normal closure codes — anything else is worth
              // surfacing (e.g. the Worker rejected the upgrade, or the real
              // target refused the handshake).
              if (e.code !== 1000 && e.code !== 1005) {
                relayLogFailure('WS', realTarget, e.code, e.reason || 'closed unexpectedly');
              }
            });
            return sock;
          };
          PatchedWebSocket.prototype = OrigWebSocket.prototype;
          PatchedWebSocket.CONNECTING = OrigWebSocket.CONNECTING;
          PatchedWebSocket.OPEN = OrigWebSocket.OPEN;
          PatchedWebSocket.CLOSING = OrigWebSocket.CLOSING;
          PatchedWebSocket.CLOSED = OrigWebSocket.CLOSED;
          window.WebSocket = PatchedWebSocket;
        }
      } catch (e) {}

      // Under this proxy, two frames that the page author believes are on
      // different real origins (a game's outer chrome and its embedded
      // iframe, for instance) are BOTH actually served from this proxy's
      // own origin. postMessage's targetOrigin argument exists specifically
      // to restrict delivery to a matching origin — used correctly (an
      // explicit real origin, not '*'), it would silently fail here, since
      // the actual origin never matches what the page author wrote. This
      // was flagged previously as a likely contributor to cross-frame
      // game/widget communication breaking under the proxy.
      //
      // Rewriting to '*' trades away that origin check for correctness of
      // delivery — reasonable for a personal browsing proxy, but worth
      // being explicit about: this is not preserving the security boundary
      // the original page author intended.
      // Wrapped in try/catch deliberately: reassigning a native prototype
      // method can throw in some browser contexts, and an unguarded throw
      // here would silently halt the REST of this script's top-level
      // execution — including everything registered after it (pushState
      // patching, the click/submit interceptors). A postMessage patch
      // failing should cost only postMessage rewriting, not every
      // safety-critical patch that comes after it in the file.
      try {
        if (typeof Window !== 'undefined' && Window.prototype && Window.prototype.postMessage) {
          var origPostMessage = Window.prototype.postMessage;
          Window.prototype.postMessage = function(message, targetOrigin, transfer) {
            try {
              if (typeof targetOrigin === 'string' && targetOrigin !== '*') {
                targetOrigin = '*';
              }
            } catch (e) {}
            return origPostMessage.call(this, message, targetOrigin, transfer);
          };
        }
      } catch (e) {}

      // Use the RAW href attribute (not the browser-resolved .href), since a
      // root-relative raw value resolved natively would incorrectly bind to
      // the proxy's own origin rather than the real target's.
      //
      // Bubble phase (not capture), and back off if the page's own JS
      // already called preventDefault(). Sites commonly wrap non-navigating
      // controls — dropdown/menu triggers, tabs — in an <a> for styling and
      // handle the click themselves; capturing first stole those clicks and
      // forced a full reload instead of letting the page open its menu.
      // SPA client-side routing (history.pushState/replaceState) changes the
      // address bar directly, with no network request at all — none of the
      // fetch/XHR/WebSocket interceptors above can see this. A page's own
      // pushState('/results?q=hi') resolves against the CURRENT address
      // (our proxy), landing on the bare proxy origin with no embedded
      // target at all — this is what produced a URL like
      // "proxy.../results?search_query=hi" with youtube.com missing.
      function relayUpdateBaseTag(proxiedUrl) {
        try {
          var prefix = proxyOrigin + '/';
          if (proxiedUrl.indexOf(prefix + 'http') !== 0) return;
          var baseEl = document.querySelector('base');
          if (baseEl) baseEl.setAttribute('href', proxiedUrl);
        } catch (e) {}
      }

      // Wrapped for the same reason as the postMessage patch above: a throw
      // here must not be able to silently disable everything registered
      // after it, especially the click/submit interceptors.
      try {
        var origPushState = history.pushState;
        var origReplaceState = history.replaceState;

        history.pushState = function(state, title, url) {
          if (url !== undefined && url !== null) {
            url = toProxied(String(url));
            relayUpdateBaseTag(url);
          }
          return origPushState.call(this, state, title, url);
        };

        history.replaceState = function(state, title, url) {
          if (url !== undefined && url !== null) {
            url = toProxied(String(url));
            relayUpdateBaseTag(url);
          }
          return origReplaceState.call(this, state, title, url);
        };
      } catch (e) {}

      // Back/forward navigation between pushState entries restores the URL
      // without a network request either — keep <base> in sync there too.
      window.addEventListener('popstate', function() {
        relayUpdateBaseTag(location.href);
      });

      // Capture phase: must run BEFORE the page's own click-tracking-then-
      // navigate handlers, not after. Search engines commonly intercept
      // result clicks (preventDefault, log a beacon) then navigate via
      // their own location.href assignment shortly after — bubble phase +
      // checking e.defaultPrevented (an earlier approach) saw
      // defaultPrevented=true from that same preventDefault call and backed
      // off, letting their un-proxied navigation through untouched. That's
      // what let every search engine's result clicks escape the proxy.
      //
      // Skip elements that are semantically UI controls (menu/dropdown
      // triggers, tabs) rather than real navigation, using ARIA attributes
      // rather than timing — this preserves the original reason bubble
      // phase was tried (GitHub-style menus wrapped in <a> that the page
      // handles itself) without needing to run after the page to detect it.
      // Dynamically-created content (React, Vue, or any JS setting
      // href/src directly from already-fetched data) never passes through
      // server-side HTMLRewriter (which only sees the initial HTML) NOR
      // any of the fetch/XHR/WebSocket patches above (no new request
      // happens at render time — the data was already fetched earlier).
      // This is what left DuckDuckGo's actual result links — rendered by
      // React from a separately-fetched payload — completely unrewritten,
      // and it's a general pattern on any JS-heavy site, not DDG-specific.
      // Watching the DOM directly, rather than any particular request or
      // event, is the only way to catch this regardless of framework.
      var RELAY_URL_ATTRS = {
        A: 'href', IMG: 'src', SCRIPT: 'src', LINK: 'href', IFRAME: 'src',
        VIDEO: 'src', AUDIO: 'src', SOURCE: 'src', EMBED: 'src', OBJECT: 'data'
      };
      var RELAY_URL_SELECTOR =
        'a[href],img[src],script[src],link[href],iframe[src],' +
        'video[src],audio[src],source[src],embed[src],object[data]';

      function relayRewriteElement(el) {
        try {
          var attr = RELAY_URL_ATTRS[el.tagName];
          if (!attr) return;
          // Native accessors deliberately: the hooked getAttribute returns
          // the UNWRAPPED original, so the already-proxied check below would
          // never match and this would re-rewrite the same element forever,
          // each write retriggering the observer that called us.
          var raw = relayNativeGetAttr.call(el, attr);
          if (!raw || raw.charAt(0) === '#' || /^(javascript|data|blob|mailto|tel):/i.test(raw)) return;
          // Already correctly proxied — no-op. Also what stops this from
          // re-triggering itself forever: writing the rewritten value
          // below is itself an attribute mutation the observer sees, and
          // on that second pass this check is what makes it a no-op.
          if (raw.indexOf(proxyOrigin + '/http') === 0) return;
          var proxied = toProxied(raw);
          if (proxied && proxied !== raw) relayNativeSetAttr.call(el, attr, proxied);
        } catch (e) {}
      }

      function relayScanForUrlElements(node) {
        if (!node || node.nodeType !== 1) return;
        if (RELAY_URL_ATTRS[node.tagName]) relayRewriteElement(node);
        if (node.querySelectorAll) {
          var els = node.querySelectorAll(RELAY_URL_SELECTOR);
          for (var i = 0; i < els.length; i++) relayRewriteElement(els[i]);
        }
      }

      relayScanForUrlElements(document.documentElement);

      // Diagnostic sweep: find any <a href> that's still a raw absolute
      // external URL, not proxied at all — this is the concrete check for
      // whether relayScanForUrlElements/the MutationObserver above are
      // actually catching everything, rather than relying on manual
      // inspection. Runs a few times at increasing delays to also catch
      // content that renders later (lazy-loaded results, infinite scroll).
      function relayScanForStaleLinks() {
        try {
          var anchors = document.querySelectorAll('a[href]');
          var found = [];
          for (var i = 0; i < anchors.length && found.length < 5; i++) {
            var href = anchors[i].getAttribute('href');
            if (!/^https?:\/\//i.test(href)) continue; // only absolute http(s) hrefs are unambiguous
            if (href.indexOf(proxyOrigin) === 0) continue; // already correctly proxied
            found.push(href);
          }
          for (var j = 0; j < found.length; j++) {
            relayLogFailure('LINK', found[j], 'UNREWRITTEN', 'raw absolute href still in DOM');
          }
        } catch (e) {}
      }
      setTimeout(relayScanForStaleLinks, 1500);
      setTimeout(relayScanForStaleLinks, 4000);
      setTimeout(relayScanForStaleLinks, 8000);

      if (typeof MutationObserver === 'function') {
        var relayObserver = new MutationObserver(function(mutations) {
          for (var i = 0; i < mutations.length; i++) {
            var addedNodes = mutations[i].addedNodes;
            for (var j = 0; j < addedNodes.length; j++) {
              relayScanForUrlElements(addedNodes[j]);
            }
          }
        });
        relayObserver.observe(document.documentElement, { childList: true, subtree: true });
      }

      // Shared by 'click' and 'auxclick' below — auxclick is what fires for
      // middle-click/open-in-new-tab, a DIFFERENT event from 'click' that
      // this interceptor never saw before, so that path always used the
      // raw, un-rewritten href with no interception at all.
      function relayHandleLinkClick(e) {
        if (e.defaultPrevented) return;
        // e.target is retargeted to the shadow host for clicks originating
        // inside a Shadow DOM boundary (Web Components), so .closest('a')
        // on it can miss the actual link entirely, letting the click fall
        // through to native, unintercepted navigation. composedPath()
        // includes the true originating chain regardless of shadow
        // boundaries; falls back to [e.target] where unsupported.
        var path = typeof e.composedPath === 'function' ? e.composedPath() : [e.target];
        var link = null;
        for (var i = 0; i < path.length; i++) {
          if (path[i] && path[i].tagName === 'A') { link = path[i]; break; }
        }
        if (!link) {
          // Diagnostic: no <a> anywhere in the click's path at all. If a
          // site's "links" are actually non-anchor clickable elements (a
          // <div> or <span> with its own onClick, common in React UIs),
          // this interceptor can never see them regardless of any
          // href-handling logic — logging what WAS clicked is the only way
          // to confirm that rather than keep guessing blindly.
          try {
            var clickedEl = path[0];
            if (clickedEl && clickedEl.nodeType === 1) {
              var cls = clickedEl.className;
              var desc = clickedEl.tagName +
                (clickedEl.id ? '#' + clickedEl.id : '') +
                (typeof cls === 'string' && cls ? '.' + cls.trim().split(/\s+/).join('.') : '');
              relayLogFailure(e.type.toUpperCase(), desc, 'NO_LINK', 'no <a> found in click path');
            }
          } catch (err) {}
          return;
        }
        // aria-haspopup is a strong, unambiguous signal that this isn't
        // real navigation — it specifically means "opens a menu/dialog".
        // role="button" and aria-expanded are NOT reliable signals — both
        // are commonly applied to genuine navigating links too (component
        // libraries often mark any clickable-styled element this way,
        // search result titles included, regardless of whether it
        // navigates), and treating either as a skip signal let those
        // escape uncontrolled. Deliberately excluded.
        var haspopup = link.getAttribute('aria-haspopup');
        var isUiControl = haspopup && haspopup.toLowerCase() !== 'false';
        if (isUiControl) return;
        // Native accessor: the hooked getAttribute returns the unwrapped
        // original, which would defeat the already-proxied check below and
        // make this hijack every click instead of letting correct links
        // navigate natively.
        var raw = relayNativeGetAttr.call(link, 'href');
        if (!raw || raw.charAt(0) === '#' || /^(javascript|mailto|tel):/i.test(raw)) return;
        // Already correctly proxied (the common case — any link server-side
        // rewriting already handled) — do nothing and let native browser
        // behavior take it from here. Intercepting anyway needlessly blocks
        // any other legitimate click handler the site had on this link (via
        // stopImmediatePropagation below), and forcing target="_blank"
        // through window.open() instead of native anchor behavior is
        // exactly the kind of pattern some browsers' popup blockers flag.
        if (raw.indexOf(proxyOrigin + '/http') === 0) return;
        e.preventDefault();
        // Without this, the page's own handler still runs afterward (
        // preventDefault doesn't stop propagation) and its un-proxied
        // location.href assignment would overwrite ours a moment later —
        // same tick, last assignment wins.
        e.stopImmediatePropagation();
        var proxied = toProxied(raw);
        // auxclick (middle-click) always means a new tab, regardless of the
        // link's own target attribute — that's the whole point of the
        // gesture. Plain click respects target="_blank" the same as before.
        if (e.type === 'auxclick' || (link.target && link.target !== '_self')) {
          window.open(proxied, e.type === 'auxclick' ? '_blank' : link.target);
        } else {
          window.location.href = proxied;
        }
      }
      document.addEventListener('click', relayHandleLinkClick, true);
      document.addEventListener('auxclick', relayHandleLinkClick, true);

      // Shared by both the 'submit' event listener below (catches
      // requestSubmit() and genuine user-triggered submissions) and the
      // HTMLFormElement.prototype.submit() patch further down (catches
      // direct .submit() calls, which — per spec — never fire a 'submit'
      // event at all, so the listener alone can't see them).
      function relaySubmitGetForm(form) {
        var target = form.getAttribute('data-proxy-target') || form.action;
        if (!target) return false;
        var method = (form.getAttribute('method') || 'get').toLowerCase();
        if (method !== 'get') return false; // POST left to default handling
        var urlObj = new URL(target, realBase());
        var params = new URLSearchParams();
        new FormData(form).forEach(function(value, key) {
          if (typeof value === 'string') params.append(key, value);
        });
        urlObj.search = params.toString();
        window.location.href = proxyOrigin + '/' + urlObj.href;
        return true;
      }

      document.addEventListener('submit', function(e) {
        var form = e.target;
        if (!form || form.tagName !== 'FORM') return;
        if (relaySubmitGetForm(form)) e.preventDefault();
      }, true);

      // form.submit() bypasses the 'submit' event entirely (a documented
      // DOM quirk) — a <textarea>-based search box (which doesn't submit
      // on Enter natively, unlike a single-line <input>) commonly has its
      // own JS call this directly to make Enter work, which is invisible
      // to the listener above no matter what it does.
      try {
        var origFormSubmit = HTMLFormElement.prototype.submit;
        HTMLFormElement.prototype.submit = function() {
          try {
            if (relaySubmitGetForm(this)) return;
          } catch (e) {}
          return origFormSubmit.call(this);
        };
      } catch (e) {}
    })();
    </script>
  `,
      { html: true }
    );
  }
}
