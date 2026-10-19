import vm from 'vm';
const worker = (await import('../relay.js')).default;
const O = 'https://relay.test';
let pass = 0, fail = 0;
const check = (l, g, w) => { const ok = g === w; ok ? pass++ : fail++; console.log((ok ? 'ok   ' : 'FAIL ') + l + (ok ? '' : `\n       got ${g}\n       want ${w}`)); };
const get = (p, env = {}, init) => worker.fetch(new Request(O + p, init), env, { waitUntil() {} });
const scripts = (html) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const syntaxOK = (html) => scripts(html).every((j) => { try { new vm.Script(j); return true; } catch { return false; } });

let r = await get('/'); let h = await r.text();
check('homepage 200', r.status, 200);
check('homepage: placeholder fully replaced', h.includes('__RELAY_LOGOUT_LINK__'), false);
check('homepage: no logout link without a password', h.includes('log out'), false);
check('homepage: inline script parses', syntaxOK(h), true);
check('homepage: build marker', h.includes('B12-ROOTFIX'), true);
h = await (await get('/', { PASSWORD: 'pw' }, { headers: { Cookie: '' } })).text();
check('homepage with PASSWORD set redirects (not authed) instead of leaking', h.includes('Route any address'), false);

const env = { PASSWORD: 'hunter2' };
r = await get('/https://duckduckgo.com/?q=hi', env);
check('unauthenticated -> 302', r.status, 302);
check('  to the clean login URL', new URL(r.headers.get('location')).pathname, '/__relay_login');
check('  destination preserved', new URL(r.headers.get('location')).searchParams.get('redirect'), '/https://duckduckgo.com/?q=hi');

r = await get('/__relay_login?redirect=%2F', env); h = await r.text();
check('login page 200', r.status, 200);
check('login page uses the shared shell (header, toggle, eyebrow)', ['class="mark"', 'themeToggle', 'eyebrow', 'Sign in.'].every((x) => h.includes(x)), true);
check('login page: inline script parses', syntaxOK(h), true);
r = await get('/__relay_login?redirect=%2F&error=1', env); h = await r.text();
check('wrong-password state: 401 + message', r.status === 401 && h.includes('Incorrect password'), true);

const post = (pw, redirect) => get('/__relay_login', env, { method: 'POST', body: new URLSearchParams({ password: pw, redirect }), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
r = await post('nope', '/x');
check('wrong password -> redirect back with error=1', r.status === 302 && r.headers.get('location').includes('error=1'), true);
r = await post('hunter2', '/https://duckduckgo.com/?q=hi');
check('right password -> 302 to original destination', r.headers.get('location'), O + '/https://duckduckgo.com/?q=hi');
const cookie = r.headers.get('set-cookie');
check('session cookie is HttpOnly+Secure and holds a hash, not the password', cookie.includes('HttpOnly') && cookie.includes('Secure') && !cookie.includes('hunter2'), true);
for (const evil of ['@evil.com', '.evil.com', '//evil.com/x']) {
  r = await post('hunter2', evil);
  check(`open-redirect blocked: ${evil}`, new URL(r.headers.get('location')).host, 'relay.test');
}
r = await get('/https://example.com/', env, { headers: { Cookie: cookie.split(';')[0] } }).catch(() => null);
check('with the cookie the gate lets the request through (reaches proxy code)', r === null || r.status !== 302 || !r.headers.get('location')?.includes('__relay_login'), true);
r = await get('/__relay_logout', env);
check('logout expires the cookie and returns to login', r.headers.get('set-cookie').includes('Max-Age=0') && r.headers.get('location').endsWith('/__relay_login'), true);
h = await (await get('/__relay_login', { PASSWORD: 'x' })).text();

r = await get('/https://');                         h = await r.text();
check('bad target -> styled error page (not blank, not plain text)', r.status === 400 && h.includes('// error 400') && h.includes('Back to relay'), true);
check('error page: inline script parses', syntaxOK(h), true);
check('error page: shared shell', h.includes('themeToggle') && h.includes('class="err"'), true);

console.log(`\n${pass}/${pass + fail} passed`); process.exit(fail ? 1 : 0);
