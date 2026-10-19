// Cloudflare Workers forwarding proxy
// Fixed: HTMLRewriter instead of regex (stable across attr order/quoting),
// streaming (faster TTFB), edge caching, srcset/form[action] support,
// removed unsafe window.location override.

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const targetUrl = url.searchParams.get('url');

    if (!targetUrl) {
      return new Response('Usage: ?url=https://example.com', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' }
      });
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

    // Edge cache: identical proxied requests skip origin + rewriting entirely
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

    const proxyOrigin = url.origin;
    const baseUrl = parsedTarget.href;

    const rewriter = new HTMLRewriter()
      .on('a[href]', new AttrRewriter('href', baseUrl, proxyOrigin))
      .on('img[src]', new AttrRewriter('src', baseUrl, proxyOrigin))
      .on('script[src]', new AttrRewriter('src', baseUrl, proxyOrigin))
      .on('link[href]', new AttrRewriter('href', baseUrl, proxyOrigin))
      .on('form', new FormRewriter(baseUrl))
      .on('img[srcset]', new SrcsetRewriter(baseUrl, proxyOrigin))
      .on('source[srcset]', new SrcsetRewriter(baseUrl, proxyOrigin))
      .on('head', new BaseTagInjector(baseUrl))
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

function resolveAndProxy(value, baseUrl, proxyOrigin) {
  if (!value) return null;
  if (/^(javascript|data|mailto|tel|#)/i.test(value)) return null;
  try {
    const abs = new URL(value, baseUrl).href;
    return `${proxyOrigin}/?url=${encodeURIComponent(abs)}`;
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
// proxied `?url=...` action gets clobbered by the form's own fields. Instead,
// stash the resolved real target URL and let injected JS build the request.
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

// Makes relative URLs from JS-created/dynamic content (not present in the
// original server HTML, so HTMLRewriter never sees them) resolve against the
// real target site instead of the proxy's own origin.
class BaseTagInjector {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
  }
  element(el) {
    el.prepend(`<base href="${this.baseUrl}">`, { html: true });
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
      var proxyBase = '${this.proxyOrigin}/?url=';

      function toProxied(url) {
        try {
          if (typeof url !== 'string') return url;
          if (url.indexOf('/?url=') !== -1) return url; // already proxied
          if (/^(data|blob|javascript):/i.test(url)) return url;
          var abs = new URL(url, document.baseURI).href;
          return proxyBase + encodeURIComponent(abs);
        } catch (e) {
          return url;
        }
      }

      // Page JS (Turbo navigation, search suggestions, settings menus, etc.)
      // calls fetch()/XHR with relative/root-relative URLs. Those resolve
      // correctly against the <base> tag, but the browser then tries to hit
      // the real site directly and gets blocked by CORS. Route them through
      // the proxy instead - same-origin from the browser's perspective.
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

      document.addEventListener('click', function(e) {
        var link = e.target.closest('a');
        if (!link || !link.href) return;
        if (link.href.indexOf('javascript:') === 0) return;
        if (link.href.indexOf('/?url=') !== -1) return;
        e.preventDefault();
        window.location.href = proxyBase + encodeURIComponent(link.href);
      }, true);

      document.addEventListener('submit', function(e) {
        var form = e.target;
        if (!form || form.tagName !== 'FORM') return;
        // Prefer the server-resolved target; fall back to the DOM-resolved
        // action, which the <base> tag now points at the real site for
        // forms created dynamically by page JS.
        var target = form.getAttribute('data-proxy-target') || form.action;
        if (!target) return;
        var method = (form.getAttribute('method') || 'get').toLowerCase();
        if (method !== 'get') return; // POST left to default handling
        e.preventDefault();
        var url = new URL(target);
        var params = new URLSearchParams();
        new FormData(form).forEach(function(value, key) {
          if (typeof value === 'string') params.append(key, value);
        });
        url.search = params.toString();
        window.location.href = proxyBase + encodeURIComponent(url.href);
      }, true);
    })();
    </script>
  `,
      { html: true }
    );
  }
}
