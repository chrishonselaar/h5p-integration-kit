// Checks protected mode (H5P_ADMIN_PASSWORD set) over HTTP: only playing is public, every
// other route needs the admin login (login page + session cookie, or Basic/Bearer for scripts),
// wrong logins are slowed down per address, cross-site writes are refused, and request values
// cannot break out of the player's inline script.
// Usage: node test/protected-mode.mjs <baseUrl> <adminPassword> <package.h5p>
//   (server started with H5P_ADMIN_PASSWORD=<adminPassword>, H5P_BASE_URL=<baseUrl>)
import fs from 'fs';
import http from 'http';

const [BASE, PASSWORD, PACKAGE] = process.argv.slice(2);
if (!PACKAGE) { console.error('usage: node test/protected-mode.mjs <baseUrl> <adminPassword> <package.h5p>'); process.exit(2); }
const basic = (user, pw) => 'Basic ' + Buffer.from(`${user}:${pw}`).toString('base64');
const ADMIN = { authorization: basic('admin', PASSWORD) };
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  (' + detail + ')' : ''}`); };
const status = async (path, init = {}) => (await fetch(BASE + path, { redirect: 'manual', ...init })).status;

async function importPackage(headers, contentId) {
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(PACKAGE)]), 'package.h5p');
  const r = await fetch(`${BASE}/api/import${contentId ? '?contentId=' + encodeURIComponent(contentId) : ''}`, { method: 'POST', headers, body: form });
  return { status: r.status, body: await r.json().catch(() => null) };
}

// 1. Anonymous: everything but playing is closed
for (const [method, path] of [['GET', '/new'], ['GET', '/edit/x'], ['GET', '/api/content'], ['GET', '/api/content/x'],
  ['POST', '/api/save'], ['DELETE', '/api/content/x'], ['GET', '/api/content-types'], ['POST', '/api/import'],
  ['GET', '/h5p/ajax?action=content-type-cache'], ['POST', '/h5p/ajax?action=library-install&id=H5P.Blanks'],
  ['GET', '/h5p/download/x'], ['GET', '/temp-files/x'], ['OPTIONS', '/api/save'], ['POST', '/play/x'],
  ['GET', '/contentUserData/x/state/0'], ['POST', '/setFinished']]) {
  const s = await status(path, { method });
  check(`anonymous ${method} ${path} -> 401`, s === 401, String(s));
}
check('anonymous GET /health -> 200', (await status('/health')) === 200);
check('wrong password -> 401', (await status('/api/content', { headers: { authorization: basic('admin', PASSWORD + 'x') } })) === 401);
check('wrong user -> 401', (await status('/api/content', { headers: { authorization: basic('root', PASSWORD) } })) === 401);
// node:http, since fetch() sets Sec-Fetch-Mode itself; no mode = a non-browser client such as curl
const get = (path, mode, headers = {}) => new Promise((ok, fail) => http.get(BASE + path, { headers: { ...headers, ...(mode ? { 'sec-fetch-mode': mode } : {}) } },
  (r) => { r.resume(); ok({ status: r.statusCode, challenge: r.headers['www-authenticate'] || '', location: r.headers.location || '' }); }).on('error', fail));
const challenge = async (mode) => (await get('/new', mode)).challenge;
check('401 without Sec-Fetch-Mode (curl) asks for Basic login', /^Basic /.test(await challenge()));
// a background request (fetch/XHR, e.g. from a public player) must not pop up a login dialog
check('401 on a background request has no login challenge', (await challenge('cors')) === '');
// a page load logs in at /login, so the browser reuses the login for the whole server (not only /edit/)
const isRedirect = (r, location) => [302, 303].includes(r.status) && r.location === location;
const nav = await get('/edit/x?a=1', 'navigate');
check('anonymous page load -> redirect to /login?next=', isRedirect(nav, '/login?next=' + encodeURIComponent('/edit/x?a=1')), `${nav.status} ${nav.location}`);
const login = await get('/login?next=%2Fedit%2Fx', 'navigate');
check('anonymous /login -> 200 login page, no Basic challenge', login.status === 200 && !login.challenge, `${login.status} ${login.challenge}`);
const loginHtml = await (await fetch(BASE + '/login?next=' + encodeURIComponent('/edit/x"><script>'))).text();
check('login page escapes next', loginHtml.includes('value="/edit/x&quot;&gt;&lt;script&gt;"') && !loginHtml.includes('"><script>'));
// the login form: each test address its own (X-Forwarded-For is trusted from loopback), so the slow-down cannot lock out the rest
const postLogin = (fields, headers = {}) => fetch(BASE + '/login', { method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '203.0.113.1', ...headers }, body: new URLSearchParams(fields) });
const bad = await postLogin({ user: 'admin', password: PASSWORD + 'x', next: '/edit/x' });
check('form login with a wrong password -> 401, no cookie', bad.status === 401 && !bad.headers.get('set-cookie'), String(bad.status));
const good = await postLogin({ user: 'admin', password: PASSWORD, next: '/edit/x?a=1' });
const cookie = (good.headers.get('set-cookie') || '').split(';')[0];
check('form login -> 303 to next with a session cookie', good.status === 303 && good.headers.get('location') === '/edit/x?a=1' && /^h5p_admin=\d+\.\d+\.[\w-]+$/.test(cookie), `${good.status} ${good.headers.get('location')}`);
check('session cookie is HttpOnly and SameSite=Lax', /HttpOnly/.test(good.headers.get('set-cookie')) && /SameSite=Lax/.test(good.headers.get('set-cookie')));
check('session cookie opens admin routes', (await status('/api/content', { headers: { cookie } })) === 200);
check('a forged session cookie -> 401', (await status('/api/content', { headers: { cookie: 'h5p_admin=9999999999.forged' } })) === 401);
check('an expired session cookie -> 401', (await status('/api/content', { headers: { cookie: cookie.replace(/=\d+/, '=1') } })) === 401);
check('cross-site write with the session cookie -> 403', (await status('/api/save', { method: 'POST', headers: { cookie, 'sec-fetch-site': 'cross-site' } })) === 403);
check('cross-site login post -> 403', (await postLogin({ user: 'admin', password: PASSWORD }, { 'sec-fetch-site': 'cross-site', 'x-forwarded-for': '203.0.113.2' })).status === 403);
const unsafe = await postLogin({ user: 'admin', password: PASSWORD, next: '//evil.example' }, { 'x-forwarded-for': '203.0.113.3' });
check('form login with unsafe next -> redirect to /', unsafe.headers.get('location') === '/', unsafe.headers.get('location'));
const out = await fetch(BASE + '/logout', { method: 'POST', redirect: 'manual', headers: { cookie } });
check('logout clears the cookie and goes to the login page', out.status === 303 && /h5p_admin=;.*Max-Age=0/.test(out.headers.get('set-cookie') || '') && out.headers.get('location') === '/login?out');
check('after logout a copy of the old cookie no longer works', (await status('/api/content', { headers: { cookie } })) === 401);
const relogin = (await postLogin({ user: 'admin', password: PASSWORD }, { 'x-forwarded-for': '203.0.113.6' })).headers.get('set-cookie')?.split(';')[0];
check('logging in again after logout works', (await status('/api/content', { headers: { cookie: relogin } })) === 200);
// a fresh address per run, so a second run against the same server does not start out waiting
const rnd = () => Math.floor(Math.random() * 0xffff).toString(16);
const slow = `2001:db8::${rnd()}:${rnd()}`;
let tries = [];
for (let i = 0; i < 6; i++) tries.push((await postLogin({ user: 'admin', password: 'nope' }, { 'x-forwarded-for': slow })).status);
const after = (await postLogin({ user: 'admin', password: PASSWORD }, { 'x-forwarded-for': slow })).status;
check('after 5 wrong logins an address waits (429), even with the right password', tries.join() === '401,401,401,401,401,429' && after === 429, `${tries} then ${after}`);
const scripted = `2001:db8::${rnd()}:${rnd()}`, viaHeader = [];
for (const auth of [basic('admin', 'x1'), basic('admin', 'x2'), 'Bearer x3', 'Bearer x4', basic('admin', 'x5'), basic('admin', PASSWORD)]) {
  viaHeader.push(await status('/api/content', { headers: { authorization: auth, 'x-forwarded-for': scripted } }));
}
check('wrong Basic/Bearer logins count too: the 6th try waits (429)', viaHeader.join() === '401,401,401,401,401,429', viaHeader.join());
check('a client-written X-Forwarded-For entry before a private hop is not trusted', await (async () => {
  const spoof = `2001:db8::${rnd()}:${rnd()}`;
  for (let i = 0; i < 6; i++) await postLogin({ user: 'admin', password: 'nope' }, { 'x-forwarded-for': `${spoof}, 172.17.0.1` });
  return (await postLogin({ user: 'admin', password: PASSWORD }, { 'x-forwarded-for': spoof })).status === 303;
})());
check('another address can still log in', (await postLogin({ user: 'admin', password: PASSWORD }, { 'x-forwarded-for': '203.0.113.5' })).status === 303);
const back = await get('/login?next=' + encodeURIComponent('/edit/x?a=1'), 'navigate', ADMIN);
check('admin /login -> redirect to next', isRedirect(back, '/edit/x?a=1'), `${back.status} ${back.location}`);
for (const next of ['//evil.example', 'https://evil.example', '/\\evil', '/\t/evil.example', 'evil']) {
  const r = await get('/login?next=' + encodeURIComponent(next), 'navigate', ADMIN);
  check(`admin /login with unsafe next ${JSON.stringify(next)} -> redirect to /`, isRedirect(r, '/'), `${r.status} ${r.location}`);
}

// 2. Admin: import with a chosen id, Bearer works too, bad ids are refused
const id = 'pm-test-' + Date.now();
const imp = await importPackage(ADMIN, id);
check('admin import with contentId', imp.status === 200 && imp.body?.contentId === id, JSON.stringify(imp.body));
const again = await importPackage({ authorization: `Bearer ${PASSWORD}` }, id);
check('Bearer import replaces the same id', again.status === 200 && again.body?.contentId === id, JSON.stringify(again.body));
check('bad contentId refused', (await importPackage(ADMIN, '../etc')).status === 400);
check('admin GET /api/content -> 200', (await status('/api/content', { headers: ADMIN })) === 200);
const editor = await fetch(`${BASE}/edit/${id}`, { headers: ADMIN });
check('admin GET /edit/:id -> 200, not framable by other sites', editor.status === 200 && /frame-ancestors 'self'/.test(editor.headers.get('content-security-policy') || ''));

// 3. CSRF: a write with Basic credentials started by another site is refused
check('cross-site Origin write -> 403', (await status(`/api/content/${id}`, { method: 'DELETE', headers: { ...ADMIN, origin: 'https://evil.example' } })) === 403);
check('Sec-Fetch-Site cross-site write -> 403', (await status(`/api/content/${id}`, { method: 'DELETE', headers: { ...ADMIN, 'sec-fetch-site': 'cross-site' } })) === 403);
check('same-origin write passes the check', (await status('/api/save', { method: 'POST', headers: { ...ADMIN, origin: new URL(BASE).origin, 'content-type': 'application/json' }, body: '{}' })) !== 403);

// 4. Public play: anonymous, no webhook, no user state, nothing injected
const evil = `</script><script>window.__pwned=1</script>`;
const play = await fetch(`${BASE}/play/${id}?webhookUrl=${encodeURIComponent('https://evil.example/' + evil)}&userId=${encodeURIComponent(evil)}`);
const html = await play.text();
check('anonymous GET /play/:id -> 200', play.status === 200, String(play.status));
check('play is framable (no X-Frame-Options / frame-ancestors)', !play.headers.get('x-frame-options') && !/frame-ancestors/.test(play.headers.get('content-security-policy') || ''));
check('play ignores webhookUrl', /const webhookUrl = "";/.test(html));
check('play ignores userId (anonymous)', /userId: "anonymous"/.test(html) && !html.includes('__pwned'));
const integration = JSON.parse(html.match(/window\.H5PIntegration = ([\s\S]*?);\s*<\/script>/)[1]);
check('no user state saving', integration.saveFreq === false, String(integration.saveFreq));
// without a user, H5P core does not ask /contentUserData for saved state (that route is admin-only)
check('no user in the player (no state requests)', integration.user === undefined, JSON.stringify(integration.user));
const lib = Object.keys(integration.contents[`cid-${id}`].scripts || {}).length ? integration.contents[`cid-${id}`].scripts[0] : integration.core.scripts[0];
check('static library/core file is public', (await status(lib.replace(/^https?:\/\/[^/]+/, ''))) === 200, lib);

// 5. Clean up
check('admin DELETE /api/content/:id', (await status(`/api/content/${id}`, { method: 'DELETE', headers: ADMIN })) === 200);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
