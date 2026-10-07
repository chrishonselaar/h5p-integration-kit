// Checks editor tickets (protected mode + H5P_TOOL_SECRET): an LTI tool's signed ticket opens the editor for one
// scope only ("new", or "edit" of one content id), works once, expires, and a save is signed back to the tool.
// Usage: node test/editor-tickets.mjs <baseUrl> <adminPassword> <toolSecret> <package.h5p>
//   (server started with H5P_ADMIN_PASSWORD=<adminPassword>, H5P_TOOL_SECRET=<toolSecret>, H5P_BASE_URL=<baseUrl>)
import crypto from 'crypto';
import fs from 'fs';

const [BASE, PASSWORD, SECRET, PACKAGE] = process.argv.slice(2);
if (!PACKAGE) { console.error('usage: node test/editor-tickets.mjs <baseUrl> <adminPassword> <toolSecret> <package.h5p>'); process.exit(2); }
const ADMIN = { authorization: `Bearer ${PASSWORD}` };
const RETURN = 'http://tool.example/lti/editor/done?ticket=x';
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  (' + detail + ')' : ''}`); };
const mac = (secret, message) => crypto.createHmac('sha256', secret).update(message).digest('base64url');
const now = () => Math.floor(Date.now() / 1000);

function ticket(fields, secret = SECRET) {
  const payload = Buffer.from(JSON.stringify({ sub: 'teacher-1', returnUrl: RETURN, jti: crypto.randomUUID(), exp: now() + 300, ...fields })).toString('base64url');
  return `${payload}.${mac(secret, 'h5p-editor-ticket.' + payload)}`;
}
async function start(t) {
  const r = await fetch(`${BASE}/editor/start?ticket=${encodeURIComponent(t)}`, { redirect: 'manual' });
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  return { status: r.status, location: r.headers.get('location') || '', cookie };
}
const req = (path, cookie, init = {}) => fetch(BASE + path, { redirect: 'manual', ...init, headers: { cookie, ...(init.headers || {}) } });

// Content to edit: import the package as admin
const form = new FormData();
form.append('file', new Blob([fs.readFileSync(PACKAGE)]), 'package.h5p');
const imported = await (await fetch(`${BASE}/api/import`, { method: 'POST', headers: ADMIN, body: form })).json();
const A = imported.contentId;
const content = await (await fetch(`${BASE}/h5p/content/${A}/content.json`)).json();
const h5pJson = await (await fetch(`${BASE}/h5p/content/${A}/h5p.json`)).json();
const dep = h5pJson.preloadedDependencies.find((d) => d.machineName === h5pJson.mainLibrary);
const library = `${dep.machineName} ${dep.majorVersion}.${dep.minorVersion}`;
const saveBody = (title) => JSON.stringify({ library, params: { params: content, metadata: { title } } });

// 1. Bad tickets
check('wrong secret -> 403', (await start(ticket({ scope: 'new' }, 'other-secret'))).status === 403);
check('expired -> 403', (await start(ticket({ scope: 'new', exp: now() - 1 }))).status === 403);
check('too far ahead -> 403', (await start(ticket({ scope: 'new', exp: now() + 3600 }))).status === 403);
check('unknown scope -> 403', (await start(ticket({ scope: 'admin' }))).status === 403);
check('javascript: return URL -> 403', (await start(ticket({ scope: 'new', returnUrl: 'javascript:alert(1)' }))).status === 403);
const once = ticket({ scope: 'new' });
check('first use -> 303', (await start(once)).status === 303);
check('second use -> 403', (await start(once)).status === 403);

// 2. "new" scope
const n = await start(ticket({ scope: 'new' }));
check('new: redirects to /new', n.status === 303 && n.location.startsWith('/new?'), n.location);
check('new: cookie is HttpOnly editor cookie', /^h5p_editor=/.test(n.cookie));
check('new: GET /new -> 200', (await req('/new', n.cookie)).status === 200);
check('new: editor ajax -> 200', (await req('/h5p/ajax?action=content-type-cache', n.cookie)).status === 200);
check('new: GET /edit/A -> 401', (await req(`/edit/${A}`, n.cookie)).status === 401);
check('new: GET /api/content -> 401', (await req('/api/content', n.cookie)).status === 401);
check('new: DELETE /api/content/A -> 401', (await req(`/api/content/${A}`, n.cookie, { method: 'DELETE' })).status === 401);
check('new: library-install -> 401', (await req('/h5p/ajax?action=library-install&id=H5P.Blanks', n.cookie, { method: 'POST' })).status === 401);
check('new: /api/import -> 401', (await req('/api/import', n.cookie, { method: 'POST' })).status === 401);
const cross = await req('/new', n.cookie, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: saveBody('x') });
check('new: cross-site save -> 403', cross.status === 403, String(cross.status));
const saved = await req('/new?returnUrl=' + encodeURIComponent('http://evil.example/'), n.cookie, {
  method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: saveBody('From ticket') });
const savedJson = await saved.json().catch(() => ({}));
const back = new URL(savedJson.redirectUrl || 'http://none/');
const nJti = JSON.parse(Buffer.from(n.cookie.split('=')[1].split('.')[0], 'base64url')).jti;
check('new: save -> 200', saved.status === 200, String(saved.status));
check('new: returns to the ticket URL, not the query', back.origin === 'http://tool.example', back.origin);
check('new: save is signed for the tool', back.searchParams.get('sig') === mac(SECRET, `h5p-editor-saved.${nJti}.${savedJson.contentId}`));

// 3. "edit" scope
const e = await start(ticket({ scope: 'edit', contentId: A }));
check('edit: redirects to /edit/A', e.location.startsWith(`/edit/${A}?`), e.location);
check('edit: GET /edit/A -> 200', (await req(`/edit/${A}`, e.cookie)).status === 200);
check('edit: GET /params/A -> 200', (await req(`/params/${A}`, e.cookie)).status === 200);
check('edit: GET /edit/<other> -> 401', (await req(`/edit/${savedJson.contentId}`, e.cookie)).status === 401);
check('edit: GET /params/<other> -> 401', (await req(`/params/${savedJson.contentId}`, e.cookie)).status === 401);
check('edit: GET /new -> 401', (await req('/new', e.cookie)).status === 401);
const edited = await req(`/edit/${A}`, e.cookie, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: saveBody('Edited') });
check('edit: save -> 200', edited.status === 200, String(edited.status));

// 4. Forged cookie, and admin logout ends editor sessions
// a ticket with an organisation: its session may use plugin APIs under /library/api/ (no plugin here: 404, not 401)
const withOrg = await start(ticket({ scope: 'new', org: 'team-a' }));
check('ticket with org -> 303', withOrg.status === 303, String(withOrg.status));
check('session with org reaches /library/api/ (404 without a plugin, not 401)', (await req('/library/api/config', withOrg.cookie)).status === 404);
check('session without org may not use /library/api/ -> 401', (await req('/library/api/config', n.cookie)).status === 401);
check('ticket with a malformed org -> 403', (await start(ticket({ scope: 'new', org: '../x' }))).status === 403);
check('forged cookie -> 401', (await req('/new', n.cookie.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')))).status === 401);
const login = await fetch(`${BASE}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE },
  body: `user=admin&password=${encodeURIComponent(PASSWORD)}` });
const adminCookie = (login.headers.get('set-cookie') || '').split(';')[0];
await fetch(`${BASE}/logout`, { method: 'POST', redirect: 'manual', headers: { cookie: adminCookie, origin: BASE } });
check('after admin logout: editor session ends', (await req(`/edit/${A}`, e.cookie)).status === 401);

await fetch(`${BASE}/api/content/${A}`, { method: 'DELETE', headers: ADMIN });
if (savedJson.contentId) await fetch(`${BASE}/api/content/${savedJson.contentId}`, { method: 'DELETE', headers: ADMIN });
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
