// Simple forwarding proxy for Cloudflare Workers

export default {
  async fetch(request) {
    try {
      // Parse URL
      const url = new URL(request.url);
      const targetUrl = url.searchParams.get('url');
      
      // If no URL parameter, show usage
      if (!targetUrl) {
        return new Response(
          'Usage: ?url=https://example.com',
          { status: 200, headers: { 'Content-Type': 'text/plain' } }
        );
      }

      // Validate URL
      try {
        new URL(targetUrl);
      } catch {
        return new Response('Invalid URL', { status: 400 });
      }

      // Fetch the target website
      const response = await fetch(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      // Get content type
      const contentType = response.headers.get('content-type') || '';

      // If HTML, rewrite it
      if (contentType.includes('text/html')) {
        const html = await response.text();
        const rewrittenHtml = rewriteHtml(html, targetUrl);
        
        return new Response(rewrittenHtml, {
          status: response.status,
          headers: {
            'Content-Type': 'text/html',
            'Cache-Control': 'no-cache'
          }
        });
      }

      // If not HTML, return as-is
      return response;

    } catch (error) {
      return new Response('Error: ' + error.message, { status: 500 });
    }
  }
};

// Function to rewrite HTML
function rewriteHtml(html, baseUrl) {
  // Get the base URL for the proxy
  const proxyBase = '?url=';
  
  // Function to rewrite a URL
  function rewriteUrl(url) {
    if (!url) return url;
    
    // Skip javascript:, data:, mailto:, tel:, etc.
    if (url.match(/^(javascript|data|mailto|tel|#)/i)) {
      return url;
    }
    
    try {
      // Parse the URL
      const parsed = new URL(url, baseUrl);
      // Return the proxied URL
      return proxyBase + encodeURIComponent(parsed.href);
    } catch {
      return url;
    }
  }

  // Rewrite all links
  html = html.replace(/<a\s+([^>]*?)href=["']([^"']*)["']/gi, function(match, attrs, href) {
    const newHref = rewriteUrl(href);
    return `<a ${attrs}href="${newHref}"`;
  });

  // Rewrite all images
  html = html.replace(/<img\s+([^>]*?)src=["']([^"']*)["']/gi, function(match, attrs, src) {
    const newSrc = rewriteUrl(src);
    return `<img ${attrs}src="${newSrc}"`;
  });

  // Rewrite all script sources
  html = html.replace(/<script\s+([^>]*?)src=["']([^"']*)["']/gi, function(match, attrs, src) {
    const newSrc = rewriteUrl(src);
    return `<script ${attrs}src="${newSrc}"`;
  });

  // Rewrite all link href (CSS)
  html = html.replace(/<link\s+([^>]*?)href=["']([^"']*)["']/gi, function(match, attrs, href) {
    const newHref = rewriteUrl(href);
    return `<link ${attrs}href="${newHref}"`;
  });

  // Inject JavaScript to intercept clicks
  const script = `
    <script>
    (function() {
      const proxyBase = window.location.origin + '/?url=';
      
      // Intercept all link clicks
      document.addEventListener('click', function(e) {
        const link = e.target.closest('a');
        if (link && link.href && !link.href.startsWith('javascript:')) {
          // Skip if already a proxy URL
          if (link.href.includes('/?url=')) return;
          e.preventDefault();
          window.location.href = proxyBase + encodeURIComponent(link.href);
        }
      }, true);
      
      // Override location assignment
      const originalLocation = window.location;
      Object.defineProperty(window, 'location', {
        set: function(url) {
          if (url && !url.includes('/?url=')) {
            originalLocation.href = proxyBase + encodeURIComponent(url);
          } else {
            originalLocation.href = url;
          }
        },
        get: function() {
          return originalLocation;
        }
      });
      
      console.log('Proxy interception active');
    })();
    </script>
  `;

  // Inject script before </head> or at the end
  if (html.includes('</head>')) {
    html = html.replace('</head>', script + '</head>');
  } else if (html.includes('</body>')) {
    html = html.replace('</body>', script + '</body>');
  } else {
    html = html + script;
  }

  return html;
}
