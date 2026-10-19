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

    const proxyOrigin = url.origin;
    const baseUrl = parsedTarget.href;

    const rewriter = new HTMLRewriter()
      .on('a[href]', new AttrRewriter('href', baseUrl, proxyOrigin))
      .on('img[src]', new AttrRewriter('src', baseUrl, proxyOrigin))
      .on('script[src]', new AttrRewriter('src', baseUrl, proxyOrigin))
      .on('link[href]', new AttrRewriter('href', baseUrl, proxyOrigin))
      .on('form[action]', new AttrRewriter('action', baseUrl, proxyOrigin))
      .on('img[srcset]', new SrcsetRewriter(baseUrl, proxyOrigin))
      .on('source[srcset]', new SrcsetRewriter(baseUrl, proxyOrigin))
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

class ScriptInjector {
  constructor(proxyOrigin) {
    this.proxyOrigin = proxyOrigin;
  }
  element(el) {
    el.append(
      `
    <script>
    (function() {
      var proxyBase = '${this.proxyOrigin}/?url=';
      document.addEventListener('click', function(e) {
        var link = e.target.closest('a');
        if (!link || !link.href) return;
        if (link.href.startsWith('javascript:') || link.href.includes('/?url=')) return;
        e.preventDefault();
        window.location.href = proxyBase + encodeURIComponent(link.href);
      }, true);
    })();
    </script>
  `,
      { html: true }
    );
  }
}
