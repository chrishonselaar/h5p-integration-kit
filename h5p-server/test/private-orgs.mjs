// Checks private organisations (H5P_PRIVATE_ORGS): content of such an organisation has no public player or files; an
// account of that organisation, the admin and an editor session for it may open it, and an LTI tool's play pass opens
// it for one content until the pass expires (its files then come from /h5p/pass/). Other content stays public.
// Usage:
//   node test/accounts.mjs make <accounts.json> <accountPassword>     (team-a and team-b)
//   node test/private-orgs.mjs <baseUrl> <adminPassword> <accountPassword> <toolSecret> <dataPath> <package.h5p>
//     (server started with H5P_ADMIN_PASSWORD, H5P_ACCOUNTS=<accounts.json>, H5P_TOOL_SECRET=<toolSecret>,
//      H5P_PRIVATE_ORGS=team-a, H5P_DATA_PATH=<dataPath>, H5P_BASE_URL=<baseUrl>)
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const [BASE, ADMIN_PW, PW, SECRET, DATA, PACKAGE] = process.argv.slice(2);
if (!PACKAGE) { console.error('usage: node test/private-orgs.mjs <baseUrl> <adminPassword> <accountPassword> <toolSecret> <dataPath> <package.h5p>'); process.exit(2); }
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  (' + detail + ')' : ''}`); };
const ADMIN = { authorization: `Bearer ${ADMIN_PW}` };
const mac = (secret, message) => crypto.createHmac('sha256', secret).update(message).digest('base64url');
const now = () => Math.floor(Date.now() / 1000);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const pass = (contentId, exp = now() + 3600, secret = SECRET) => { const p = b64({ contentId, exp }); return `${p}.${mac(secret, 'h5p-play-pass.' + p)}`; };
const ticket = (fields) => { const p = b64({ sub: 't1', returnUrl: 'http://tool.example/done', jti: crypto.randomUUID(), exp: now() + 300, ...fields }); return `${p}.${mac(SECRET, 'h5p-editor-ticket.' + p)}`; };
const req = async (p, cookie, init = {}) => {
  const r = await fetch(BASE + p, { redirect: 'manual', ...init, headers: { ...(init.headers || {}), ...(cookie ? { cookie } : {}) } });
  return { status: r.status, text: await r.text(), headers: r.headers };
};
let ip = 50;
async function login(user) {
  const r = await fetch(BASE + '/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': `203.0.113.${ip++}` },
    body: new URLSearchParams({ user, password: PW }) });
  return (r.headers.getSetCookie().find((c) => c.startsWith('h5p_account=')) || '').split(';')[0];
}

// Two copies of the package: A for team-a (private), B for team-b (public)
const ids = [];
for (let i = 0; i < 2; i++) {
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(PACKAGE)]), 'package.h5p');
  ids.push((await (await fetch(`${BASE}/api/import`, { method: 'POST', headers: ADMIN, body: form })).json()).contentId);
}
const [A, B] = ids.map(String);
fs.writeFileSync(path.join(DATA, 'content-orgs.json'), JSON.stringify({ [A]: 'team-a', [B]: 'team-b' }));

// Anonymous
check('anonymous: private player -> 403', (await req(`/play/${A}`)).status === 403);
check('anonymous: private file -> 403', (await req(`/h5p/content/${A}/content.json`)).status === 403);
check('anonymous: public player -> 200', (await req(`/play/${B}`)).status === 200);
check('anonymous: public file -> 200', (await req(`/h5p/content/${B}/content.json`)).status === 200);

// Play pass
const good = pass(A);
const played = await req(`/play/${A}?pass=${encodeURIComponent(good)}`);
check('pass: player -> 200', played.status === 200);
check('pass: player not cached', /no-store/.test(played.headers.get('cache-control') || ''));
check('pass: player fetches files under /h5p/pass/', played.text.includes(`/h5p/pass/${good}/${A}`) && !played.text.includes(`/h5p/content/${A}`));
check('pass: file -> 200', (await req(`/h5p/pass/${good}/${A}/content.json`)).status === 200);
check('pass: file of another content -> 403', (await req(`/h5p/pass/${good}/${B}/content.json`)).status === 403);
check('pass: climbing out -> not 200', (await req(`/h5p/pass/${good}/${A}/..%2f${B}/content.json`)).status !== 200);
check('pass for another content -> 403', (await req(`/play/${A}?pass=${encodeURIComponent(pass(B))}`)).status === 403);
check('expired pass -> 403', (await req(`/play/${A}?pass=${encodeURIComponent(pass(A, now() - 1))}`)).status === 403);
check('pass too far ahead -> 403', (await req(`/play/${A}?pass=${encodeURIComponent(pass(A, now() + 25 * 3600))}`)).status === 403);
check('wrong secret -> 403', (await req(`/play/${A}?pass=${encodeURIComponent(pass(A, now() + 3600, 'other'))}`)).status === 403);
check('editor ticket is no pass -> 403', (await req(`/play/${A}?pass=${encodeURIComponent(ticket({ scope: 'new' }))}`)).status === 403);

// Logins
const a = await login('team-a'), b = await login('team-b');
check('team-a: player -> 200', (await req(`/play/${A}`, a)).status === 200);
check('team-a: file -> 200', (await req(`/h5p/content/${A}/content.json`, a)).status === 200);
check('team-b: player -> 403', (await req(`/play/${A}`, b)).status === 403);
check('team-b: file -> 403', (await req(`/h5p/content/${A}/content.json`, b)).status === 403);
check('admin: player -> 200', (await req(`/play/${A}`, '', { headers: ADMIN })).status === 200);

// Editor sessions from an LTI tool
const startEditor = async (fields) => (await req(`/editor/start?ticket=${encodeURIComponent(ticket(fields))}`)).headers.get('set-cookie').split(';')[0];
check('editor for team-a: file -> 200', (await req(`/h5p/content/${A}/content.json`, await startEditor({ scope: 'new', org: 'team-a' }))).status === 200);
check('editor for A: player -> 200', (await req(`/play/${A}`, await startEditor({ scope: 'edit', contentId: A }))).status === 200);
check('editor for team-b: file -> 403', (await req(`/h5p/content/${A}/content.json`, await startEditor({ scope: 'new', org: 'team-b' }))).status === 403);

const failed = results.filter((ok) => !ok).length;
console.log(failed ? `${failed} of ${results.length} FAILED` : `all ${results.length} passed`);
process.exit(failed ? 1 : 0);
