import { JSDOM } from 'jsdom';
import fs from 'fs';
// Evaluate the template literal exactly as the Worker does, so we test what the
// browser actually receives (a lone "\/" in the source arrives as "/").
const src = fs.readFileSync(new URL('../relay.js', import.meta.url), 'utf8');
const tpl = src.match(/el\.prepend\(\s*`(\s*<script>[\s\S]*?<\/script>\s*)`,/)[1];
const out = new Function('SW_PATH', 'return `' + tpl + '`').call({ proxyOrigin: 'https://relay.test' }, '/__proxy_sw.js');
const js = out.match(/<script>([\s\S]*?)<\/script>/)[1];
const ORIGIN = 'https://relay.test';
const PAGE = ORIGIN + '/https://duckduckgo.com/?q=Hi&ia=web';

const dom = new JSDOM(
  `<!doctype html><html><head><base href="${PAGE}"></head><body><div id="r"></div></body></html>`,
  { url: PAGE, runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;
let errors = [];
w.addEventListener('error', (e) => errors.push(e.message));
const nativeGet = w.Element.prototype.getAttribute;      // originals, captured BEFORE the script hooks them
const nativeSet = w.Element.prototype.setAttribute;
const hrefGet = Object.getOwnPropertyDescriptor(w.HTMLAnchorElement.prototype, 'href').get;
w.eval(js);                                   // run the REAL evaluated script

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = got === want; ok ? pass++ : fail++;
  console.log((ok ? 'ok   ' : 'FAIL ') + label + (ok ? '' : `\n       got  ${got}\n       want ${want}`));
};
const P = (u) => ORIGIN + '/' + u;

check('script ran without throwing', errors.length, 0);

// THE REPORTED BUG: DDG tab switch via root-relative pushState
w.history.pushState(null, '', '/?ia=images&q=Hi&iax=images');
check('pushState "/?ia=images..." keeps embedded duckduckgo.com',
  w.location.href, P('https://duckduckgo.com/?ia=images&q=Hi&iax=images'));
w.history.replaceState(null, '', '/?ia=videos&q=Hi&iax=videos');
check('replaceState keeps embedded duckduckgo.com',
  w.location.href, P('https://duckduckgo.com/?ia=videos&q=Hi&iax=videos'));
w.history.pushState(null, '', w.location.origin + '/?ia=maps&q=Hi');
check('pushState with absolute URL built from location.origin',
  w.location.href, P('https://duckduckgo.com/?ia=maps&q=Hi'));

// DDG-style dynamic results: JS sets hrefs; hover/click must see proxied
const d = w.document, r = d.getElementById('r');
const REAL = 'https://dictionary.cambridge.org/dictionary/english/hi';
const a = d.createElement('a'); a.setAttribute('href', REAL); r.appendChild(a);
check('setAttribute STORES the proxied value (what hover preview shows)', nativeGet.call(a, 'href'), P(REAL));
check('getAttribute returns ORIGINAL (React sees no mismatch, no revert)', a.getAttribute('href'), REAL);
const b = d.createElement('a'); b.href = 'https://example.com/x';
check('.href property assignment stores proxied', nativeGet.call(b, 'href'), P('https://example.com/x'));
check('.href property read returns original', b.href, 'https://example.com/x');

// innerHTML bypasses setAttribute -> MutationObserver must catch it
r.innerHTML = '<a id="x" href="https://example.org/page">r</a>';
await new Promise((res) => setTimeout(res, 50));
check('innerHTML-inserted link rewritten by observer', nativeGet.call(d.getElementById('x'), 'href'), P('https://example.org/page'));

// click handling
const click = (el, type = 'click') => { const e = new w.MouseEvent(type, { bubbles: true, cancelable: true, composed: true }); el.dispatchEvent(e); return e.defaultPrevented; };
const mk = (href, extra = {}) => { const l = d.createElement('a'); nativeSet.call(l, 'href', href); for (const k in extra) nativeSet.call(l, k, extra[k]); r.appendChild(l); return l; };
check('raw absolute link click is intercepted', click(mk('https://grammarhow.com/hi-there/')), true);
check('raw link middle-click (auxclick) is intercepted', click(mk('https://grammarhow.com/x'), 'auxclick'), true);
check('ALREADY-proxied link is left to the browser', click(mk(P('https://ok.example/'))), false);
check('href="#" is left alone', click(mk('#')), false);
check('aria-haspopup menu trigger is left alone', click(mk('https://x.example/', { 'aria-haspopup': 'true' })), false);

// hot path sanity + the prototype bug the first run caught
const div = d.createElement('div');
div.setAttribute('class', 'result__a'); div.setAttribute('data-foo', 'https://x.y'); div.setAttribute('constructor', 'z');
check('class untouched', div.getAttribute('class'), 'result__a');
check('data-* untouched', div.getAttribute('data-foo'), 'https://x.y');
check('"constructor" attribute no longer rewritten (prototype bug)', div.getAttribute('constructor'), 'z');

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
