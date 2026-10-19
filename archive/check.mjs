// Evaluates the injected-script template literal exactly as the Worker does,
// then syntax-checks what the BROWSER would actually receive.
import fs from 'fs';
import vm from 'vm';
const file = process.argv[2] || new URL('../relay.js', import.meta.url).pathname;
const src = fs.readFileSync(file, 'utf8');
const m = src.match(/el\.prepend\(\s*`(\s*<script>[\s\S]*?<\/script>\s*)`,/);
if (!m) { console.error('injected template not found'); process.exit(2); }
const out = new Function('SW_PATH', 'return `' + m[1] + '`')
  .call({ proxyOrigin: 'https://relay.test' }, '/__proxy_sw.js');
const js = out.match(/<script>([\s\S]*?)<\/script>/)[1];
fs.writeFileSync(new URL('./.injected.evaluated.js', import.meta.url).pathname, js);
try { new vm.Script(js); console.log('INJECTED (as the browser receives it): OK'); }
catch (e) { console.log('INJECTED SYNTAX ERROR:', e.message); process.exit(1); }
