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
// discarding any path prefix, by spec. Those are handled by explicit JS
// interception (click/submit/fetch/XHR) using the real target's origin,
// which we recover from document.baseURI at runtime.

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const proxyOrigin = url.origin;

    // Path-embedded target, e.g. "/https://example.com/page" + "?x=1"
    let targetUrl = url.pathname.slice(1) + url.search;

    // Legacy fallback for old ?url=... bookmarks/links.
    if (!targetUrl && url.searchParams.has('url')) {
      targetUrl = url.searchParams.get('url');
    }

    if (!targetUrl) {
      return new Response('Usage: https://<this-worker>/https://example.com', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' }
      });
    }

    if (!/^https?:\/\//i.test(targetUrl)) {
      targetUrl = 'https://' + targetUrl;
    }

    let parsedTarget;
    try {
      parsedTarget = new URL(targetUrl);
    } catch {
      return new Response('Invalid URL', { status: 400 });
    }
    if (!['http:', 'https:'].includes(parsedTarget.protocol)) {
      return new Response('Invalid protocol', { status: 400 });
    }

    // Edge cache: identical proxied requests skip origin + rewriting entirely.
    const cache = caches.default;
    const cacheKey = new Request(request.url, request);
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    let upstream;
    try {
      upstream = await fetch(parsedTarget.href, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        cf: { cacheTtl: 60, cacheEverything: false }
      });
    } catch (error) {
      return new Response('Error fetching target: ' + error.message, { status: 502 });
    }

    const contentType = upstream.headers.get('content-type') || '';

    // Non-HTML: pass through untouched, no buffering needed
    if (!contentType.includes('text/html')) {
      return upstream;
    }

    const baseUrl = parsedTarget.href;
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

    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  }
};

function proxify(absoluteUrl, proxyOrigin) {
  return proxyOrigin + '/' + absoluteUrl;
}

function resolveAndProxy(value, baseUrl, proxyOrigin) {
  if (value === null || value === undefined) return null;
  if (/^(javascript|data|mailto|tel|#)/i.test(value)) return null;
  try {
    const abs = new URL(value, baseUrl).href;
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

      function toProxied(raw) {
        try {
          if (typeof raw !== 'string' || !raw) return raw;
          if (/^(data|blob|javascript):/i.test(raw)) return raw;
          // Already a fully-proxied absolute URL (server-rewritten) — leave it.
          if (raw.indexOf(proxyOrigin + '/http') === 0) return raw;
          var abs = new URL(raw, realBase()).href;
          return proxyOrigin + '/' + abs;
        } catch (e) {
          return raw;
        }
      }

      // Page JS (Turbo navigation, search suggestions, settings menus, etc.)
      // calls fetch()/XHR with relative or root-relative URLs. Route them
      // through the proxy - same-origin from the browser's perspective, so
      // no CORS issue (the Worker does the real cross-origin fetch server-side).
      var origFetch = window.fetch;
      window.fetch = function(input, init) {
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
        return origFetch.call(this, input, init);
      };

      var origOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function(method, url) {
        try {
          arguments[1] = toProxied(url);
        } catch (e) {}
        return origOpen.apply(this, arguments);
      };

      // Use the RAW href attribute (not the browser-resolved .href), since a
      // root-relative raw value resolved natively would incorrectly bind to
      // the proxy's own origin rather than the real target's.
      document.addEventListener('click', function(e) {
        var link = e.target.closest('a');
        if (!link) return;
        var raw = link.getAttribute('href');
        if (!raw || /^(javascript|#|mailto|tel):/i.test(raw)) return;
        if (raw.indexOf(proxyOrigin + '/http') === 0) return; // already proxied
        e.preventDefault();
        window.location.href = toProxied(raw);
      }, true);

      document.addEventListener('submit', function(e) {
        var form = e.target;
        if (!form || form.tagName !== 'FORM') return;
        var target = form.getAttribute('data-proxy-target') || form.action;
        if (!target) return;
        var method = (form.getAttribute('method') || 'get').toLowerCase();
        if (method !== 'get') return; // POST left to default handling
        e.preventDefault();
        var urlObj = new URL(target, realBase());
        var params = new URLSearchParams();
        new FormData(form).forEach(function(value, key) {
          if (typeof value === 'string') params.append(key, value);
        });
        urlObj.search = params.toString();
        window.location.href = proxyOrigin + '/' + urlObj.href;
      }, true);
    })();
    </script>
  `,
      { html: true }
    );
  }
}
