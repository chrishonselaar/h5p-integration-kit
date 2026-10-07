// Checks accounts (H5P_ACCOUNTS): an account logs in on the same page as the admin, lands on its home, may use the
// editor for new content and for its own organisation's content, and its allow-list; nothing of the admin's or of
// another organisation. Logging out ends only that account's sessions.
// Usage:
//   node test/accounts.mjs make <accounts.json> <accountPassword>     writes two accounts: team-a and team-b
//   node test/accounts.mjs <baseUrl> <adminPassword> <accountPassword> <package.h5p>
//     (server started with H5P_ADMIN_PASSWORD=<adminPassword>, H5P_ACCOUNTS=<accounts.json>, H5P_BASE_URL=<baseUrl>)
import fs from 'fs';
import http from 'http';
import { hashPassword } from '../src/accounts.js';

if (process.argv[2] === 'make') {
  const [file, pw] = process.argv.slice(3);
  const account = (name) => ({ user: name, password: hashPassword(pw), org: name, home: `/portal/${name}/`, allow: [`/portal/${name}/`, '/plugin-api/'] });
  fs.writeFileSync(file, JSON.stringify([account('team-a'), { ...account('team-b'), uploads: true }], null, 1));
  process.exit(0);
}
const [BASE, ADMIN_PW, PW, PACKAGE] = process.argv.slice(2);
if (!PACKAGE) { console.error('usage: node test/accounts.mjs <baseUrl> <adminPassword> <accountPassword> <package.h5p>'); process.exit(2); }
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  (' + detail + ')' : ''}`); };
const ADMIN = { authorization: 'Basic ' + Buffer.from(`admin:${ADMIN_PW}`).toString('base64') };
let ip = 10;   // each login from its own address (X-Forwarded-For is trusted from loopback), so the slow-down stays out of the way
const login = (user, password, next = '/') => fetch(BASE + '/login', { method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': `203.0.113.${ip++}` }, body: new URLSearchParams({ user, password, next }) });
const cookieOf = (r, name) => ((r.headers.getSetCookie?.() || [r.headers.get('set-cookie') || '']).find((c) => c.startsWith(name + '=')) || '').split(';')[0];
const req = async (path, cookie, init = {}) => {
  const r = await fetch(BASE + path, { redirect: 'manual', ...init, headers: { ...(init.headers || {}), ...(cookie ? { cookie } : {}) } });
  return { status: r.status, location: r.headers.get('location') || '', text: await r.text() };
};

// an item of the admin's (no organisation)
const form = new FormData();
form.append('file', new Blob([fs.readFileSync(PACKAGE)]), 'package.h5p');
const adminItem = (await (await fetch(BASE + '/api/import', { method: 'POST', headers: ADMIN, body: form })).json()).contentId;
check('admin imports an item', !!adminItem, String(adminItem));

// 1. Logging in
const bad = await login('team-a', PW + 'x');
check('account with a wrong password -> 401, no cookie', bad.status === 401 && !bad.headers.get('set-cookie'), String(bad.status));
check('unknown user -> 401', (await login('team-c', PW)).status === 401);
const a = await login('team-a', PW);
const A = cookieOf(a, 'h5p_account');
check('account login -> 303 to its home, with an account cookie', a.status === 303 && a.headers.get('location') === '/portal/team-a/' && /^h5p_account=[\w-]+\.[\w-]+$/.test(A), `${a.status} ${a.headers.get('location')}`);
check('account login clears an admin cookie', /h5p_admin=;.*Max-Age=0/.test((a.headers.getSetCookie?.() || []).join('\n')));
const aNext = await login('team-a', PW, '/new');
check('account login with an allowed next -> next', aNext.headers.get('location') === '/new', aNext.headers.get('location'));
const aOther = await login('team-a', PW, '/api/content');
check('account login with a next it may not use -> its home', aOther.headers.get('location') === '/portal/team-a/', aOther.headers.get('location'));
const B = cookieOf(await login('team-b', PW), 'h5p_account');
check('admin password on an account name -> 401', (await login('team-a', ADMIN_PW)).status === 401);

// 2. What an account may not do
for (const [method, path] of [['GET', '/api/content'], ['GET', `/api/content/${adminItem}`], ['DELETE', `/api/content/${adminItem}`],
  ['POST', '/api/import'], ['GET', `/edit/${adminItem}`], ['POST', `/edit/${adminItem}`], ['GET', '/api/content-types'],
  ['POST', '/h5p/ajax?action=library-install&id=H5P.Blanks'], ['POST', '/h5p/ajax?action=library-upload'],
  ['GET', '/portal/team-b/'], ['GET', '/portal/'], ['GET', `/h5p/download/${adminItem}`], ['GET', '/editor-assets/x']]) {
  const r = await req(path, A, { method });
  check(`account ${method} ${path} -> 403`, r.status === 403, String(r.status));
}
// node:http, since fetch() sets Sec-Fetch-Mode itself
const home = await new Promise((ok, fail) => http.get(BASE + '/', { headers: { cookie: A, 'sec-fetch-mode': 'navigate' } },
  (r) => { r.resume(); ok({ status: r.statusCode, location: r.headers.location || '' }); }).on('error', fail));
check('account opening / -> redirect to its home', home.status === 303 && home.location === '/portal/team-a/', `${home.status} ${home.location}`);
check('a forged account cookie counts for nothing -> 401', (await req('/new', A.replace(/\.[\w-]+$/, '.forged'))).status === 401);
check('an account cookie with another user name counts for nothing -> 401', (await req('/new', 'h5p_account=' + Buffer.from(JSON.stringify({ u: 'team-b', iat: Date.now(), exp: 9999999999 })).toString('base64url') + '.' + A.split('.')[1])).status === 401);

// raw paths (fetch would remove "..", so node:http)
const raw = (path, headers = {}) => new Promise((ok, fail) => http.get({ host: new URL(BASE).hostname, port: new URL(BASE).port, path, headers },
  (r) => { r.resume(); ok(r.statusCode); }).on('error', fail));
for (const path of ['/temp-files/../content-orgs.json', '/temp-files/../../../../../../etc/hostname', '/temp-files/x/../../content-orgs.json',
  '/portal/team-a/../team-b/', '/portal/team-a//x', '/portal/team-a%2F..%2Fteam-b/', '/edit//1', `/edit/${adminItem}/..`]) {
  const s = await raw(path, { cookie: A });
  check(`account GET ${path} (raw) -> 400 or 403`, s === 400 || s === 403, String(s));
}
check('admin GET /temp-files/../content-orgs.json (raw ..) -> 400', (await raw('/temp-files/../content-orgs.json', { authorization: ADMIN.authorization })) === 400);
check('account: an ajax request with the action twice -> 403', (await req('/h5p/ajax?action=content-type-cache&action=library-install', A, { method: 'POST' })).status === 403);

// editor ajax: only the editor's own actions; a hub download (installs libraries; a bad id used to crash the server) is not one
check('account: get-content (hub download) -> 403', (await req('/h5p/ajax?action=get-content&hubId=0', A, { method: 'POST' })).status === 403);
const crash = await req('/h5p/ajax?action=get-content&hubId=0', null, { method: 'POST', headers: { ...ADMIN, 'content-type': 'application/json' }, body: '{}' });
check('admin: a failing hub download answers with an error and the server keeps running', crash.status >= 400 && (await req('/health')).status === 200, String(crash.status));

// editor files: served sandboxed and without sniffing; an account sees only its own
const xml = new FormData();
xml.append('field', JSON.stringify({ name: 'file', type: 'file' }));
xml.append('contentId', '0');
xml.append('file', new Blob(['<html xmlns="http://www.w3.org/1999/xhtml"><script>1</script></html>'], { type: 'application/xml' }), 'p.xml');
const up = await fetch(BASE + '/h5p/ajax?action=files', { method: 'POST', headers: { cookie: A }, body: xml });
const upPath = up.ok ? ((await up.json()).path || '').replace(/#tmp$/, '') : '';
const own = upPath ? await fetch(`${BASE}/temp-files/${upPath}`, { headers: { cookie: A } }) : null;
check('account uploads an editor file and opens it again', !!own && own.status === 200, `${up.status} ${upPath} ${own?.status}`);
check('an uploaded xml file is served sandboxed and with nosniff', !!own && /sandbox/.test(own.headers.get('content-security-policy') || '') && !/allow-same-origin/.test(own.headers.get('content-security-policy') || '') && own.headers.get('x-content-type-options') === 'nosniff');
check('another organisation cannot open that editor file', upPath && (await req(`/temp-files/${upPath}`, B)).status === 404);

// 3. What an account may do
check('account GET its allow-list (no such page: 404, not 401/403)', (await req('/portal/team-a/', A)).status === 404);
check('account GET /portal/team-a without "/" falls under its allow-list', (await req('/portal/team-a', A)).status === 404);
check('account GET /new -> 200 editor', (await req('/new', A)).status === 200);
check('account GET content-type cache -> 200', (await req('/h5p/ajax?action=content-type-cache', A)).status === 200);
check('player stays public', (await req(`/play/${adminItem}`)).status === 200);
const meta = await (await fetch(`${BASE}/api/content/${adminItem}`, { headers: ADMIN })).json();
const main = meta.preloadedDependencies.find((d) => d.machineName === meta.mainLibrary);
const content = await (await fetch(`${BASE}/h5p/content/${adminItem}/content.json`)).json();
const body = new FormData();
body.append('library', `${main.machineName} ${main.majorVersion}.${main.minorVersion}`);
body.append('params', JSON.stringify({ params: content, metadata: { title: 'Made by team-a' } }));
const saved = await fetch(BASE + '/new', { method: 'POST', headers: { cookie: A }, body });
const savedId = saved.ok ? (await saved.json()).contentId : null;
check('account saves new content', !!savedId, `${saved.status} ${savedId}`);
check('account GET /edit/<its own new item> -> 200', (await req(`/edit/${savedId}`, A)).status === 200);
check('another organisation GET /edit/<team-a item> -> 403', (await req(`/edit/${savedId}`, B)).status === 403);
check('cross-site write by an account -> 403', (await req('/new', A, { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } })).status === 403);
check('admin still opens everything', (await req('/api/content', null, { headers: ADMIN })).status === 200 && (await req(`/edit/${savedId}`, null, { headers: ADMIN })).status === 200);

// 4. Logging out
const out = await fetch(BASE + '/logout', { method: 'POST', redirect: 'manual', headers: { cookie: A } });
check('account logout clears its cookie and goes to the login page', out.status === 303 && /h5p_account=;.*Max-Age=0/.test((out.headers.getSetCookie?.() || []).join('\n')) && out.headers.get('location') === '/login?out');
check('after logout a copy of the old account cookie no longer works', (await req('/new', A)).status === 401);
check('another account stays logged in', (await req('/new', B)).status === 200);
check('the admin stays logged in', (await req('/api/content', null, { headers: ADMIN })).status === 200);

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
