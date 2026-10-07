/**
 * Universal H5P Server using @lumieducation/h5p-server
 *
 * Provides:
 * - H5P content player (view/play content)
 * - H5P content editor (create/edit content)
 * - Content management API
 * - xAPI events via postMessage (for iframe embedding)
 * - Optional webhook for xAPI events (pass ?webhookUrl=...)
 */

import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import fileUpload from 'express-fileupload';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import fs from 'fs/promises';
import { readFileSync, writeFileSync } from 'fs';
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { BlockList } from 'net';
import * as H5P from '@lumieducation/h5p-server';
import { loadAccounts } from './accounts.js';
import { createRequire } from 'module';

// Lumi's own editor page template (wrapped below so its inline JSON is escaped)
const lumiEditorRenderer = createRequire(import.meta.url)('@lumieducation/h5p-server/build/src/renderers/default.js').default;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
// Behind a reverse proxy (nginx in front of a container) every request comes from a local or private address. Trust
// exactly that one hop: req.ip is then the last X-Forwarded-For entry, the one the proxy added itself, never an entry
// the client wrote (used to slow down wrong logins per address). A request straight from the internet is not trusted
// at all. Nothing else in the server reads req.ip, req.protocol or req.hostname. H5P_TRUST_PROXY overrides (Express
// `trust proxy` syntax).
const PROXY_NETS = new BlockList();
for (const [net, bits, type] of [['127.0.0.0', 8, 'ipv4'], ['10.0.0.0', 8, 'ipv4'], ['172.16.0.0', 12, 'ipv4'], ['192.168.0.0', 16, 'ipv4'],
    ['169.254.0.0', 16, 'ipv4'], ['::1', 128, 'ipv6'], ['fc00::', 7, 'ipv6'], ['fe80::', 10, 'ipv6']]) PROXY_NETS.addSubnet(net, bits, type);
const isProxyAddress = (addr) => {
    const v4 = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
    try { return PROXY_NETS.check(v4, v4.includes(':') ? 'ipv6' : 'ipv4'); } catch { return false; }
};
app.set('trust proxy', process.env.H5P_TRUST_PROXY ?? ((addr, hop) => hop === 0 && isProxyAddress(addr)));

// Configuration from environment
const PORT = process.env.PORT || process.env.H5P_PORT || 3000;
const H5P_BASE_URL = process.env.H5P_BASE_URL || `http://localhost:${PORT}`;

// Storage paths (configurable for Docker deployment)
const H5P_DATA_PATH = process.env.H5P_DATA_PATH || path.resolve(__dirname, '../h5p');

// Protected mode (opt-in, for a server on the internet): set H5P_ADMIN_PASSWORD.
// Accounts (opt-in, H5P_ACCOUNTS): extra logins, each tied to one organisation; see accounts.js.
// Then only playing is public (GET /play/:id and the static files it loads);
// everything else (editor, save, delete, import, content list, H5P ajax) needs the
// admin login. People log in on the /login page (user H5P_ADMIN_USER, default "admin"),
// which sets a signed session cookie for H5P_SESSION_HOURS (default 12); POST /logout
// ends it, and changing the password ends every session. Scripts send
// "Authorization: Bearer <H5P_ADMIN_PASSWORD>" or HTTP Basic instead. Players are
// anonymous and keep no user state. Without the variable the server behaves as before
// (open, for development).
const ADMIN_USER = process.env.H5P_ADMIN_USER || 'admin';
// The language of the login page, the editor and its buttons: "en" or "nl". Unset: the login page follows the
// browser and the editor is English (as before)
const UI_LANGUAGE = ['en', 'nl'].includes(process.env.H5P_UI_LANGUAGE) ? process.env.H5P_UI_LANGUAGE : '';
const EDITOR_LANGUAGE = UI_LANGUAGE || 'en';
const EDITOR_BUTTONS = { en: { save: 'Save', create: 'Create', cancel: 'Cancel' }, nl: { save: 'Opslaan', create: 'Maken', cancel: 'Annuleren' } }[EDITOR_LANGUAGE];
const ADMIN_PASSWORD = process.env.H5P_ADMIN_PASSWORD || '';
const PROTECTED = ADMIN_PASSWORD !== '';
const PUBLIC_ORIGIN = new URL(H5P_BASE_URL).origin;
const PUBLIC_PATHS = /^\/(health$|play\/[^/]+$|h5p\/(core|libraries|content)\/)/;

const sameSecret = (a, b) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

// Session cookie: "<issued, ms>.<expiry, s>.<HMAC of both>", keyed by the password, so a new password ends every
// session. Logging out ends every session too (there is one shared account): only sessions issued after the last
// logout count (the epoch is at least the newest issue time, so even one issued in the same millisecond ends). That moment is kept in <data path>/session-epoch, so it survives a restart. On https the cookie is
// __Host-h5p_admin, which no other (sub)domain can set.
const SECURE_COOKIE = PUBLIC_ORIGIN.startsWith('https:');
const SESSION_COOKIE = SECURE_COOKIE ? '__Host-h5p_admin' : 'h5p_admin';
const SESSION_SECONDS = Math.round((Number(process.env.H5P_SESSION_HOURS) || 12) * 3600);
const sessionKey = createHmac('sha256', ADMIN_PASSWORD).update('h5p-admin-session-v3').digest();
const signSession = (issued, expiry) => createHmac('sha256', sessionKey).update(`${issued}.${expiry}`).digest('base64url');
const EPOCH_FILE = path.join(H5P_DATA_PATH, 'session-epoch');
let sessionEpoch = 0, lastIssued = 0;
try { sessionEpoch = Number(readFileSync(EPOCH_FILE, 'utf8')) || 0; } catch { /* no logout yet */ }
const now = () => Math.floor(Date.now() / 1000);
const newSession = () => {
    const issued = lastIssued = Math.max(Date.now(), sessionEpoch + 1), expiry = now() + SESSION_SECONDS;
    return `${issued}.${expiry}.${signSession(issued, expiry)}`;
};
function endAllSessions() {
    sessionEpoch = Math.max(Date.now(), lastIssued);
    try { writeFileSync(EPOCH_FILE, String(sessionEpoch)); } catch (e) { console.error('session-epoch not saved:', e.message); }
}
const cookieValue = (req, name) => {
    for (const part of (req.get('cookie') || '').split(';')) {
        const i = part.indexOf('=');
        if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
    }
    return '';
};
function hasSession(req) {
    const [issued, expiry, mac] = cookieValue(req, SESSION_COOKIE).split('.');
    return !!mac && /^\d+$/.test(issued) && /^\d+$/.test(expiry) && Number(issued) > sessionEpoch && Number(expiry) > now()
        && sameSecret(mac, signSession(issued, expiry));
}
const sessionCookie = (value, seconds) =>
    `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${seconds}; HttpOnly; SameSite=Lax${SECURE_COOKIE ? '; Secure' : ''}`;

// Accounts (opt-in): H5P_ACCOUNTS names a file of extra logins, each tied to one organisation (see accounts.js)
const ACCOUNTS_FILE = process.env.H5P_ACCOUNTS || '';
if (ACCOUNTS_FILE && !PROTECTED) { console.error('H5P_ACCOUNTS needs protected mode (set H5P_ADMIN_PASSWORD)'); process.exit(1); }
const accounts = ACCOUNTS_FILE ? loadAccounts({ file: ACCOUNTS_FILE, dataPath: H5P_DATA_PATH, secret: ADMIN_PASSWORD, adminUser: ADMIN_USER }) : null;
const ACCOUNT_COOKIE = SECURE_COOKIE ? '__Host-h5p_account' : 'h5p_account';
const accountCookie = (value, seconds) =>
    `${ACCOUNT_COOKIE}=${value}; Path=/; Max-Age=${seconds}; HttpOnly; SameSite=Lax${SECURE_COOKIE ? '; Secure' : ''}`;

function isAdminRequest(req) {
    if (hasSession(req)) return true;
    const [scheme, value] = (req.get('authorization') || '').split(' ');
    if (!value) return false;
    if (/^bearer$/i.test(scheme)) return sameSecret(value, ADMIN_PASSWORD);
    if (!/^basic$/i.test(scheme)) return false;
    const pair = Buffer.from(value, 'base64').toString('utf8');
    const i = pair.indexOf(':');
    return i > 0 && sameSecret(pair.slice(0, i), ADMIN_USER) & sameSecret(pair.slice(i + 1), ADMIN_PASSWORD);
}

// The browser sends cached Basic credentials with requests that other sites start (the Lax session cookie only
// with their top-level page loads), so a write that comes from another site is refused (CSRF).
function fromOtherSite(req) {
    const site = req.get('sec-fetch-site');
    if (site && site !== 'same-origin' && site !== 'none') return true;
    const origin = req.get('origin');
    return !!origin && origin !== PUBLIC_ORIGIN;
}

// Editor tickets (H5P_TOOL_SECRET, shared with an LTI tool such as examples/lti-provider): the tool lets a teacher
// open the editor without the admin login. It signs a ticket "<payload>.<HMAC>" (payload: base64url JSON with scope
// "new" or "edit" + contentId, sub, returnUrl, jti, exp at most 10 minutes ahead); GET /editor/start?ticket=... uses it
// once and sets an editor session cookie that allows only that scope: the editor page, its saves, and the editor's
// own requests (no library installs, no other content, no admin API). After a save the return URL gets
// sig=HMAC("h5p-editor-saved.<jti>.<contentId>"), so the tool knows this server saved that content for that ticket.
const TOOL_SECRET = process.env.H5P_TOOL_SECRET || '';
const EDITOR_COOKIE = SECURE_COOKIE ? '__Host-h5p_editor' : 'h5p_editor';
const EDITOR_SECONDS = 2 * 3600;
const toolMac = (message) => createHmac('sha256', TOOL_SECRET).update(message).digest('base64url');
const editorKey = createHmac('sha256', TOOL_SECRET || 'unused').update('h5p-editor-session-v1').digest();
const usedTickets = new Map();   // jti -> expiry (s): a ticket works once
function signedJson(value, mac) {
    const [payload, sig] = String(value || '').split('.');
    if (!payload || !sig || !sameSecret(sig, mac(payload))) return null;
    try { return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
}
function readTicket(ticket) {
    if (!TOOL_SECRET) return null;
    const t = signedJson(ticket, (p) => toolMac('h5p-editor-ticket.' + p));
    if (!t || typeof t.jti !== 'string' || !Number.isInteger(t.exp) || t.exp <= now() || t.exp > now() + 600) return null;
    if (!['new', 'edit'].includes(t.scope) || (t.scope === 'edit' && !/^[A-Za-z0-9_-]{1,64}$/.test(String(t.contentId)))) return null;
    if (!httpUrlOrNull(t.returnUrl) || usedTickets.has(t.jti)) return null;
    for (const [jti, exp] of usedTickets) if (exp <= now()) usedTickets.delete(jti);
    usedTickets.set(t.jti, t.exp);
    return t;
}
const editorMac = (payload) => createHmac('sha256', editorKey).update(payload).digest('base64url');
function newEditorSession(t) {
    const payload = Buffer.from(JSON.stringify({ scope: t.scope, contentId: t.scope === 'edit' ? String(t.contentId) : null, sub: String(t.sub || 'teacher'),
        jti: t.jti, returnUrl: t.returnUrl, exp: now() + EDITOR_SECONDS, epoch: sessionEpoch })).toString('base64url');
    return `${payload}.${editorMac(payload)}`;
}
function editorSession(req) {
    if (!TOOL_SECRET) return null;
    const e = signedJson(cookieValue(req, EDITOR_COOKIE), editorMac);
    // Logging out of the admin account (or a new password) ends editor sessions too
    return e && e.exp > now() && e.epoch === sessionEpoch ? e : null;
}
// The H5P editor's own ajax actions (no installs, uploads of libraries or hub downloads, which install libraries too)
const EDITOR_AJAX = new Set(['content-type-cache', 'content-hub-metadata-cache', 'libraries', 'translations', 'files', 'filter']);
// What an editor session may request: its own editor page and saves, and what the H5P editor loads
function editorMayUse(e, req) {
    const p = req.path;
    if (p === '/new') return e.scope === 'new';
    if (p.startsWith('/edit/') || p.startsWith('/params/')) return e.scope === 'edit' && p.split('/')[2] === e.contentId && p.split('/').length === 3;
    if (p === '/h5p/ajax') return EDITOR_AJAX.has(req.query.action);
    return req.method === 'GET' && /^\/(h5p\/editor|temp-files|editor-assets)\//.test(p);
}
// The return URL after a save: an editor session goes back to its tool, with the save signed
function savedReturnUrl(req, returnUrl, contentId, title) {
    const target = req.editor ? req.editor.returnUrl : returnUrl;
    if (!target) return null;
    const url = new URL(target);
    url.searchParams.set('contentId', contentId);
    url.searchParams.set('title', title);
    if (req.editor) url.searchParams.set('sig', toolMac(`h5p-editor-saved.${req.editor.jti}.${contentId}`));
    return url.toString();
}

// Where /login sends the browser next: only a path on this server ("/x"; not "//host", "/\host" or a scheme)
const localPathOr = (value, fallback) =>
    (typeof value === 'string' && /^\/(?![/\\])/.test(value) && !/[\x00-\x20\x7f]/.test(value) ? value : fallback);

// The login page: a plain form in English or Dutch (from the browser's languages); `failed`: wrong user or password,
// `wait`: minutes left after too many wrong tries
const LOGIN_TEXT = {
    en: { title: 'Log in', user: 'User name', password: 'Password', submit: 'Log in', failed: 'The user name or password is not right.',
        wait: (m) => `Too many wrong tries. Try again in ${m} minute${m === 1 ? '' : 's'}.`, out: 'You are logged out.' },
    nl: { title: 'Inloggen', user: 'Gebruikersnaam', password: 'Wachtwoord', submit: 'Inloggen', failed: 'De gebruikersnaam of het wachtwoord klopt niet.',
        wait: (m) => `Te vaak een verkeerd wachtwoord. Probeer het over ${m} minuut${m === 1 ? '' : 'en'} opnieuw.`, out: 'Je bent uitgelogd.' },
};
const htmlText = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function loginPage(req, { next = '/', message = '', user = '' } = {}) {
    const lang = UI_LANGUAGE || (req.acceptsLanguages('en', 'nl') === 'nl' ? 'nl' : 'en'), t = LOGIN_TEXT[lang];
    const note = typeof message === 'function' ? message(t) : message ? t[message] : '';
    return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t.title}</title><style>
:root { color-scheme: light dark; --bg: #f6f6f7; --card: #fff; --ink: #222; --muted: #666; --line: #d8d8dc; --accent: #2b2b30; --bad: #b3261e; }
@media (prefers-color-scheme: dark) { :root { --bg: #161618; --card: #222226; --ink: #eee; --muted: #aaa; --line: #3a3a40; --accent: #eee; --bad: #ff8a80; } }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--ink); font: 16px/1.5 system-ui, sans-serif; }
form { width: min(360px, calc(100vw - 32px)); padding: 28px; background: var(--card); border: 1px solid var(--line); border-radius: 14px; box-sizing: border-box; }
h1 { margin: 0 0 18px; font-size: 22px; font-weight: 600; }
label { display: block; margin: 0 0 14px; font-size: 14px; color: var(--muted); }
input { display: block; width: 100%; box-sizing: border-box; margin-top: 4px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 9px; background: transparent; color: var(--ink); font: inherit; }
input:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
button { width: 100%; margin-top: 6px; padding: 10px; border: 0; border-radius: 9px; background: var(--accent); color: var(--bg); font: inherit; font-weight: 600; cursor: pointer; }
.note { margin: -6px 0 16px; font-size: 14px; color: var(--bad); }
.note.out { color: var(--muted); }
</style></head><body>
<form method="post" action="/login">
<h1>${t.title}</h1>
${note ? `<p class="note${message === 'out' ? ' out' : ''}" role="alert">${htmlText(note)}</p>` : ''}
<input type="hidden" name="next" value="${htmlText(next)}">
<label>${t.user}<input name="user" autocomplete="username" required value="${htmlText(user)}"${user ? '' : ' autofocus'}></label>
<label>${t.password}<input name="password" type="password" autocomplete="current-password" required${user ? ' autofocus' : ''}></label>
<button type="submit">${t.submit}</button>
</form></body></html>`;
}

// The tool's ticket becomes an editor session for one scope (only with H5P_TOOL_SECRET)
app.use((req, res, next) => {
    res.on('close', () => {
        for (const f of Object.values(req.files || {}).flat()) if (f?.tempFilePath) fs.unlink(f.tempFilePath).catch(() => {});
    });
    // Lumi's error handler can call res.status(NaN) (e.g. a failed hub download), which throws and ends the process
    const status = res.status.bind(res);
    res.status = (code) => status(Number.isInteger(code) && code >= 100 && code <= 599 ? code : 500);
    next();
});
app.use((req, res, next) => { req.editor = editorSession(req); req.accountSession = accounts ? accounts.read(cookieValue(req, ACCOUNT_COOKIE)) : null; next(); });
app.get('/editor/start', (req, res) => {
    const t = readTicket(req.query.ticket);
    res.set('Cache-Control', 'no-store');
    if (!t) return res.status(403).type('text/plain').send('This editor link is not valid (any more). Open the editor again from your course.');
    const target = t.scope === 'new' ? '/new' : `/edit/${encodeURIComponent(String(t.contentId))}`;
    res.set('Set-Cookie', `${EDITOR_COOKIE}=${newEditorSession(t)}; Path=/; Max-Age=${EDITOR_SECONDS}; HttpOnly; SameSite=Lax${SECURE_COOKIE ? '; Secure' : ''}`)
        .redirect(303, `${target}?returnUrl=${encodeURIComponent(t.returnUrl)}`);
});

if (PROTECTED) {
    const CHALLENGE = 'Basic realm="H5P admin", charset="UTF-8"';
    // Wrong logins per address (login form, Basic and Bearer alike): after LOGIN_TRIES within LOGIN_WINDOW, the
    // address waits until the window ends, whatever it sends
    const LOGIN_TRIES = 5, LOGIN_WINDOW = 15 * 60 * 1000, failures = new Map();
    const waitMinutes = (ip) => {
        const f = failures.get(ip);
        if (!f || Date.now() - f.since > LOGIN_WINDOW) { failures.delete(ip); return 0; }
        return f.count >= LOGIN_TRIES ? Math.ceil((f.since + LOGIN_WINDOW - Date.now()) / 60000) : 0;
    };
    const failed = (ip) => {
        const f = failures.get(ip) || { count: 0, since: Date.now() };
        f.count++; failures.set(ip, f);
        if (failures.size > 10000) failures.delete(failures.keys().next().value);
    };
    const noStore = (res) => res.set({ 'Cache-Control': 'no-store', 'Content-Security-Policy': "frame-ancestors 'none'" });

    app.get('/login', (req, res) => {
        const next = localPathOr(req.query.next, '/');
        if (isAdminRequest(req)) return res.redirect(303, next);
        noStore(res).type('html').send(loginPage(req, { next, message: req.query.out !== undefined ? 'out' : '' }));
    });
    app.post('/login', bodyParser.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
        const next = localPathOr(req.body?.next, '/'), user = String(req.body?.user || ''), password = String(req.body?.password || '');
        noStore(res);
        if (fromOtherSite(req)) return res.status(403).type('text/plain').send('Cross-site request refused');
        const ip = req.ip, wait = waitMinutes(ip);
        if (wait) return res.status(429).type('html').send(loginPage(req, { next, user, message: (t) => t.wait(wait) }));
        if (sameSecret(user, ADMIN_USER) & sameSecret(password, ADMIN_PASSWORD)) {
            failures.delete(ip);
            const cookies = [sessionCookie(newSession(), SESSION_SECONDS)];
            if (accounts) cookies.push(accountCookie('', 0));
            return res.set('Set-Cookie', cookies).redirect(303, next);
        }
        const account = accounts && accounts.login(user, password);
        if (account) {
            failures.delete(ip);
            const [nextPath, nextQuery = ''] = next.split('?');
            const mayGo = next !== '/' && accounts.mayUse(account, { path: nextPath.split('#')[0], method: 'GET', query: Object.fromEntries(new URLSearchParams(nextQuery)) });
            return res.set('Set-Cookie', [accountCookie(accounts.issue(account, SESSION_SECONDS), SESSION_SECONDS), sessionCookie('', 0)])
                .redirect(303, mayGo ? next : account.home);
        }
        failed(ip);
        res.status(401).type('html').send(loginPage(req, { next, user, message: 'failed' }));
    });
    app.post('/logout', (req, res) => {
        if (fromOtherSite(req)) return res.status(403).type('text/plain').send('Cross-site request refused');
        if (isAdminRequest(req)) endAllSessions();
        if (req.accountSession) accounts.logout(req.accountSession);
        noStore(res).set('Set-Cookie', accounts ? [sessionCookie('', 0), accountCookie('', 0)] : sessionCookie('', 0)).redirect(303, '/login?out');
    });

    app.use((req, res, next) => {
        const isRead = req.method === 'GET' || req.method === 'HEAD';
        if (isRead && PUBLIC_PATHS.test(req.path)) {
            req.isAdmin = false;
            return next();
        }
        const sentCredentials = !!req.get('authorization');
        if (sentCredentials && waitMinutes(req.ip)) {
            return res.status(429).set('Retry-After', String(waitMinutes(req.ip) * 60)).type('text/plain').send('Too many wrong logins; try again later');
        }
        if (!isAdminRequest(req) && req.editor && editorMayUse(req.editor, req)) {
            if (!isRead && fromOtherSite(req)) return res.status(403).type('text/plain').send('Cross-site request refused');
            req.isAdmin = false;
            res.set('Content-Security-Policy', "frame-ancestors 'self'");
            return next();
        }
        req.editor = null;   // outside its scope an editor session counts for nothing
        // An account: its own allow-list (accounts.js), never the admin's routes
        if (!isAdminRequest(req) && req.accountSession) {
            const a = req.accountSession;
            if (!accounts.mayUse(a, req)) {
                if (isRead && req.path === '/' && req.get('sec-fetch-mode') === 'navigate') return res.redirect(303, a.home);
                return res.status(403).type('text/plain').send('Not available for this account');
            }
            if (!isRead && fromOtherSite(req)) return res.status(403).type('text/plain').send('Cross-site request refused');
            req.account = { user: a.user, org: a.org, uploads: a.uploads };
            req.isAdmin = false;
            res.set('Content-Security-Policy', "frame-ancestors 'self'");
            return next();
        }
        if (!isAdminRequest(req)) {
            if (sentCredentials) failed(req.ip);
            const mode = req.get('sec-fetch-mode');
            // A browser page load goes to the login page, and comes back here after it
            if (isRead && mode === 'navigate') {
                return res.redirect(303, '/login?next=' + encodeURIComponent(req.originalUrl));
            }
            // Only clients that are not browsers (no Sec-Fetch-Mode) get a Basic challenge: in a browser it would pop
            // up a login dialog (in a public player, on a background request, it would block the page).
            if (!mode) res.set('WWW-Authenticate', CHALLENGE);
            return res.status(401).type('text/plain').send('Login required');
        }
        if (sentCredentials) failures.delete(req.ip);   // a right login clears the address's wrong ones, as on the form
        if (!isRead && !/^bearer/i.test(req.get('authorization') || '') && fromOtherSite(req)) {
            return res.status(403).type('text/plain').send('Cross-site request refused');
        }
        req.isAdmin = true;
        res.set('Content-Security-Policy', "frame-ancestors 'self'");
        next();
    });
}

// Values written into inline <script> blocks: a JS literal that cannot close the script
const jsLiteral = (value, indent) => JSON.stringify(value ?? null, null, indent)
    .replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
// Only http(s) URLs may be used as return/redirect targets
const httpUrlOrNull = (value) => (typeof value === 'string' && /^https?:\/\//i.test(value) ? value : null);

// CORS: open for development; in protected mode only anonymous reads
app.use(cors(PROTECTED ? { origin: '*', methods: ['GET', 'HEAD'] } : {
    origin: true,  // Reflect the request origin
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

// Apply bodyParser conditionally
// Skip bodyParser ONLY for multipart/form-data requests (file uploads)
// Allow it for JSON requests (like POST action=libraries)
app.use((req, res, next) => {
    const contentType = req.get('content-type') || '';
    // Skip bodyParser for multipart/form-data (file uploads)
    if (contentType.includes('multipart/form-data')) {
        return next();
    }
    bodyParser.json({ limit: '500mb' })(req, res, next);
});
app.use((req, res, next) => {
    const contentType = req.get('content-type') || '';
    // Skip bodyParser for multipart/form-data (file uploads)
    if (contentType.includes('multipart/form-data')) {
        return next();
    }
    bodyParser.urlencoded({ extended: true, limit: '500mb' })(req, res, next);
});

// Paths for H5P storage (defined early for static file serving)
const h5pBasePath = H5P_DATA_PATH;

// Serve H5P core, editor, content, libraries and temp files BEFORE other routes
// Extra files for editor widgets (e.g. a media catalogue an editor library reads), served at /editor-assets/.
// Not public: in protected mode they need the admin login, like the editor itself.
if (process.env.H5P_EDITOR_ASSETS) app.use('/editor-assets', express.static(path.resolve(process.env.H5P_EDITOR_ASSETS)));
app.use('/h5p/core', express.static(path.join(h5pBasePath, 'core')));
app.use('/h5p/editor', express.static(path.join(h5pBasePath, 'editor')));
// Uploaded files are served from this origin: a file that a browser would run as a page (html, xml, svg) gets a sandbox
// without same-origin, so its script cannot act as the person who opens it; nothing is sniffed into something else
const ACTIVE_FILE = /\.(html?|xhtml|xml|xsl|svgz?)$/i;
const safeFileHeaders = (res, file) => {
    res.set('X-Content-Type-Options', 'nosniff');
    if (ACTIVE_FILE.test(file)) res.set('Content-Security-Policy', 'sandbox allow-scripts allow-forms allow-popups');
};
app.use('/h5p/content', express.static(path.join(h5pBasePath, 'content'), { setHeaders: safeFileHeaders }));
app.use('/h5p/libraries', express.static(path.join(h5pBasePath, 'libraries')));

// Temp files: H5P stores them in user-specific subdirectories but generates URLs without user prefix
// So we need to search across all user directories
app.use('/temp-files', async (req, res, next) => {
    const requestedPath = req.path; // e.g., /videos/video-abc123.mp4
    // an account sees only its own editor files (Lumi keeps them in temp/<user id>/)
    const tempDir = req.account ? path.join(h5pBasePath, 'temp', createUser(req).id) : path.join(h5pBasePath, 'temp');
    const send = (file) => { safeFileHeaders(res, file); return res.sendFile(file); };
    // only files inside the temp folder: a raw "../" in the path (not removed by express) must not climb out
    const inside = (file) => path.resolve(file).startsWith(path.resolve(tempDir) + path.sep);
    if (requestedPath.split('/').some((seg) => seg === '..' || seg === '.')) return res.status(400).type('text/plain').send('Bad path');

    // First try direct path (in case it's there)
    const directPath = path.join(tempDir, requestedPath);
    try {
        if (!inside(directPath)) throw new Error('outside');
        await fs.access(directPath);
        if ((await fs.stat(directPath)).isFile()) return send(directPath);
    } catch {}

    // Search in user subdirectories
    if (req.account) return next();
    try {
        const entries = await fs.readdir(tempDir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isDirectory()) {
                const userPath = path.join(tempDir, entry.name, requestedPath);
                try {
                    if (!inside(userPath)) throw new Error('outside');
                    await fs.access(userPath);
                    return send(userPath);
                } catch {}
            }
        }
    } catch {}

    next(); // Not found, continue to next handler
});

// Additional H5P paths
const librariesPath = path.join(h5pBasePath, 'libraries');
const contentPath = path.join(h5pBasePath, 'content');
const tempPath = path.join(h5pBasePath, 'temp');
// express-fileupload's raw copies: not under temp/ (which /temp-files serves), and removed after each request
const uploadTmpPath = path.join(h5pBasePath, 'upload-tmp');
const configPath = path.join(h5pBasePath, 'config.json');

// Ensure directories exist
async function ensureDirectories() {
    await fs.mkdir(librariesPath, { recursive: true });
    await fs.mkdir(contentPath, { recursive: true });
    await fs.mkdir(tempPath, { recursive: true });
    await fs.mkdir(uploadTmpPath, { recursive: true });

    // Create default config if not exists
    try {
        await fs.access(configPath);
    } catch {
        const defaultConfig = {
            contentTypeCacheRefreshInterval: 86400000,
            contentUserStateSaveInterval: 5000,
            enableLrsContentTypes: true,
            fetchingDisabled: 0,
            hubRegistrationEndpoint: 'https://api.h5p.org/v1/sites',
            hubContentTypesEndpoint: 'https://api.h5p.org/v1/content-types/',
            sendUsageStatistics: false,
            uuid: crypto.randomUUID(),
            siteType: 'local',
            libraryConfig: {}
        };
        await fs.writeFile(configPath, JSON.stringify(defaultConfig, null, 2));
    }
}

// Create a simple user object (in production, get from session/auth)
function createUser(req) {
    if (req.account) return { id: 'account-' + req.account.user, name: req.account.user, email: '', type: 'local' };
    if (req.editor) {
        const id = 'editor-' + createHash('sha256').update(req.editor.sub).digest('hex').slice(0, 16);
        return { id, name: 'Teacher', email: '', type: 'local' };
    }
    if (PROTECTED) {
        return req.isAdmin
            ? { id: ADMIN_USER, name: 'Admin', email: '', type: 'local' }
            : { id: 'anonymous', name: 'Anonymous', email: '', type: 'local' };
    }
    return {
        id: req.query.userId || req.body?.userId || 'anonymous',
        name: req.query.userName || req.body?.userName || 'Anonymous User',
        email: req.query.userEmail || req.body?.userEmail || 'anonymous@example.com',
        type: 'local'
    };
}

// Optional: let containers (H5P.Column, H5P.QuestionSet, ...) accept extra
// sub-content types. Their semantics.json has a fixed list of allowed libraries,
// and the editor drops anything not on it. H5P_EXTRA_SUBCONTENT points to a JSON
// file such as:
//   { "H5P.Column": ["H5P.DeepZoomPage 0.1"], "H5P.QuestionSet": ["H5P.DeepZoomQuestion 0.1"] }
// Every library field of the named container (any version) gets those options.
async function loadExtraSubcontent() {
    const file = process.env.H5P_EXTRA_SUBCONTENT;
    if (!file) return undefined;
    const extra = JSON.parse(await fs.readFile(file, 'utf8'));
    console.log(`Extra sub-content types from ${file}:`, extra);
    return extra;
}

function addLibraryOptions(fields, extraOptions) {
    return fields.map((field) => {
        const copy = { ...field };
        if (copy.type === 'library' && Array.isArray(copy.options)) {
            copy.options = [...copy.options, ...extraOptions.filter((o) => !copy.options.includes(o))];
        }
        if (Array.isArray(copy.fields)) copy.fields = addLibraryOptions(copy.fields, extraOptions);
        if (copy.field) copy.field = addLibraryOptions([copy.field], extraOptions)[0];
        return copy;
    });
}

function editorOptions(extraSubcontent) {
    if (!extraSubcontent) return undefined;
    return {
        customization: {
            alterLibrarySemantics: (library, semantics) => {
                const extraOptions = extraSubcontent[library.machineName];
                return extraOptions ? addLibraryOptions(semantics, extraOptions) : semantics;
            }
        }
    };
}

// Initialize H5P
let h5pEditor;
let h5pPlayer;

// Simple translation function (returns the key as-is for English)
// Lumi's own texts ("namespace:key", e.g. "metadata-semantics:title") from the translation files it ships;
// English when the language has no file or no such key, the key itself when English has none either
const TRANSLATIONS_DIR = path.join(path.dirname(createRequire(import.meta.url).resolve('@lumieducation/h5p-server')), '..', 'assets', 'translations');
const translationFiles = new Map();
function translationFile(namespace, language) {
    const file = path.join(TRANSLATIONS_DIR, namespace, `${language}.json`);
    if (!translationFiles.has(file)) {
        try { translationFiles.set(file, JSON.parse(readFileSync(file, 'utf8'))); } catch { translationFiles.set(file, null); }
    }
    return translationFiles.get(file);
}
function translationCallback(key, language) {
    const i = key.indexOf(':');
    if (i < 0 || !/^[a-z-]+$/.test(key.slice(0, i))) return key;
    const lookup = (lang) => key.slice(i + 1).split('.').reduce((v, part) => (v && typeof v === 'object' ? v[part] : undefined),
        translationFile(key.slice(0, i), lang));
    const text = lookup(/^[a-z]{2}(-[A-Za-z]+)?$/.test(language || '') ? language : 'en') ?? lookup('en');
    return typeof text === 'string' ? text : key;
}

async function initH5P() {
    await ensureDirectories();

    const config = await new H5P.H5PConfig(
        new H5P.fsImplementations.JsonStorage(configPath)
    ).load();

    // Set base URL for content
    config.baseUrl = H5P_BASE_URL;

    // Configure URLs for core and editor assets (served via express.static)
    config.coreUrl = '/h5p/core';
    config.editorLibraryUrl = '/h5p/editor';

    // Configure AJAX paths to use /h5p prefix (where h5pAjaxExpressRouter is mounted)
    config.ajaxUrl = '/h5p/ajax';
    config.librariesUrl = '/h5p/libraries';
    config.contentUrl = '/h5p/content';
    config.playUrl = '/h5p/play';
    config.downloadUrl = '/h5p/download';
    config.temporaryFilesUrl = '/temp-files';

    // Anonymous public players have no user to store state or results for
    if (PROTECTED) {
        config.contentUserStateSaveInterval = false;
        config.setFinishedEnabled = false;
    }

    // H5P.fs signature:
    // (config, librariesPath, temporaryStoragePath, contentPath,
    //  contentUserDataStorage, contentStorage, translationCallback, urlGenerator, options)
    const urlGenerator = new H5P.UrlGenerator(config, {
        queryParamGenerator: (user) => ({ userId: user.id }),
        protectAjax: false,
        protectContentUserData: false,
        protectSetFinished: false
    });

    // Create content and library storage
    const contentStorage = new H5P.fsImplementations.FileContentStorage(contentPath);
    const libraryStorage = new H5P.fsImplementations.FileLibraryStorage(librariesPath);

    h5pEditor = H5P.fs(
        config,              // 1. config
        librariesPath,       // 2. librariesPath
        tempPath,            // 3. temporaryStoragePath
        contentPath,         // 4. contentPath
        undefined,           // 5. contentUserDataStorage
        undefined,           // 6. contentStorage (use default)
        translationCallback, // 7. translationCallback
        urlGenerator,        // 8. urlGenerator
        editorOptions(await loadExtraSubcontent()) // 9. options
    );

    // Create a proper H5PPlayer instance for playing content
    h5pPlayer = new H5P.H5PPlayer(
        libraryStorage,
        contentStorage,
        config,
        undefined,           // integrationObjectDefaults
        urlGenerator,
        translationCallback
    );

    // Custom renderer that omits the download link (default renderer always shows it).
    // Protected mode: no user in H5PIntegration, so H5P core treats the player as signed out and
    // does not request saved state from /contentUserData (an admin-only route) on every play.
    const playerIntegration = (integration) => (PROTECTED ? { ...integration, user: undefined } : integration);
    h5pPlayer.setRenderer((model) => `<!doctype html>
<html class="h5p-iframe">
<head>
    <meta charset="utf-8">
    ${model.styles.map((style) => `<link rel="stylesheet" href="${style}"/>`).join('\n    ')}
    ${model.scripts.map((script) => `<script src="${script}"></script>`).join('\n    ')}
    <script>
        window.H5PIntegration = ${jsLiteral(playerIntegration(model.integration), 2)};
    </script>
</head>
<body>
    <div class="h5p-content" data-content-id="${model.contentId}"></div>
</body>
</html>`);

    // Lumi's editor page writes H5PIntegration (user name, content id) into a <script>
    // with plain JSON.stringify; swap in the escaped literal
    h5pEditor.setRenderer((model) => lumiEditorRenderer(model)
        .replace(JSON.stringify(model.integration, null, 2), () => jsLiteral(model.integration, 2)));

    console.log('H5P initialized successfully');
}

// ============================================================================
// H5P AJAX Routes (handled by @lumieducation/h5p-express)
// ============================================================================

async function setupRoutes() {
    const { h5pAjaxExpressRouter } = await import('@lumieducation/h5p-express');

    // Middleware to set req.user for H5P router
    app.use((req, res, next) => {
        req.user = createUser(req);
        next();
    });

    // Add request logging for debugging
    if (!PROTECTED) app.use('/h5p/ajax', (req, res, next) => {
        console.log(`[H5P AJAX] ${req.method} ${req.path} action=${req.query.action}`);
        console.log(`  Content-Type: ${req.get('content-type')}`);
        console.log(`  Body present: ${!!req.body}`);
        console.log(`  Body:`, req.body);
        next();
    });

    // Add file upload middleware for H5P AJAX routes
    // The H5P controller expects req.files to be populated by express-fileupload
    app.use('/h5p/ajax', fileUpload({
        limits: { fileSize: 500 * 1024 * 1024 }, // 500MB max file size
        useTempFiles: true,
        tempFileDir: uploadTmpPath
    }));

    // Mount the H5P AJAX router at root level
    // The router uses config URLs (e.g., /h5p/ajax, /h5p/libraries) internally
    // So we mount at '/' to avoid double-prefixing
    app.use(
        '/',
        h5pAjaxExpressRouter(
            h5pEditor,
            path.join(h5pBasePath, 'core'),        // H5P core files
            path.join(h5pBasePath, 'editor'),      // H5P editor files
            undefined,                              // routeOptions (use defaults)
            'en'                                    // languageOverride
        )
    );

}

// Global error handler for H5P routes - must be added after setupRoutes()
async function addErrorHandlers() {
    app.use((err, req, res, next) => {
        if (req.path.startsWith('/h5p')) {
            console.error('=== H5P Error ===');
            console.error('Message:', err.message);
            console.error('Stack:', err.stack);
            console.error('Request:', req.method, req.path);
            console.error('Query:', req.query);
            console.error('Body:', req.body);
            console.error('================');
        }

        // Send error response
        if (!res.headersSent) {
            res.status(err.status || 500).json({
                error: err.message || 'Internal server error'
            });
        }
    });
}

// ============================================================================
// Content Management API
// ============================================================================

// List all content
app.get('/api/content', async (req, res) => {
    try {
        const contentIds = await h5pEditor.contentManager.listContent();
        const contentList = await Promise.all(
            contentIds.map(async (id) => {
                try {
                    const metadata = await h5pEditor.contentManager.getContentMetadata(id, createUser(req));
                    return {
                        id,
                        title: metadata.title || 'Untitled',
                        mainLibrary: metadata.mainLibrary,
                        embedTypes: metadata.embedTypes
                    };
                } catch {
                    return { id, title: 'Unknown', error: true };
                }
            })
        );
        res.json({ content: contentList.filter(c => !c.error) });
    } catch (error) {
        console.error('Error listing content:', error);
        res.json({ content: [] });
    }
});

// Get single content metadata
app.get('/api/content/:contentId', async (req, res) => {
    try {
        const metadata = await h5pEditor.contentManager.getContentMetadata(
            req.params.contentId,
            createUser(req)
        );
        res.json({ id: req.params.contentId, ...metadata });
    } catch (error) {
        res.status(404).json({ error: 'Content not found' });
    }
});

// Delete content
app.delete('/api/content/:contentId', async (req, res) => {
    try {
        await h5pEditor.contentManager.deleteContent(req.params.contentId, createUser(req));
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================================================
// Player Endpoint - Renders H5P content for viewing
// ============================================================================

app.get('/play/:contentId', async (req, res) => {
    try {
        const user = createUser(req);
        const contentId = req.params.contentId;
        // Optional webhook URL for xAPI events (if not provided, only postMessage is used).
        // Not in protected mode: a public link must not send results elsewhere.
        const webhookUrl = PROTECTED ? '' : (httpUrlOrNull(req.query.webhookUrl) || '');

        // h5pPlayer.render() returns complete HTML with the default renderer
        let playerHtml = await h5pPlayer.render(
            contentId,
            user,
            'en',
            {
                showCopyButton: false,
                showDownloadButton: false,
                showFrame: true,
                showH5PIcon: false,
                showLicenseButton: false
            }
        );

        // Inject H5P init and xAPI tracking script before </body>
        const xapiScript = `
    <script>
        // Debug H5P initialization
        console.log('H5P script loaded, checking H5P object...');
        console.log('H5P:', typeof H5P);
        console.log('H5PIntegration:', typeof H5PIntegration);
        console.log('jQuery:', typeof jQuery);

        // H5P auto-initializes on jQuery ready, but let's make sure
        if (typeof jQuery !== 'undefined') {
            jQuery(document).ready(function() {
                console.log('jQuery ready, H5P.init exists:', typeof H5P !== 'undefined' && typeof H5P.init);
                console.log('H5P contents:', H5PIntegration.contents);
                if (typeof H5P !== 'undefined' && H5P.init) {
                    console.log('Calling H5P.init...');
                    H5P.init(document.body);
                }
            });
        }

        // Track xAPI events
        const webhookUrl = ${jsLiteral(webhookUrl)};
        H5P.externalDispatcher.on('xAPI', function(event) {
            const statement = event.data.statement;

            // Only track completion and answered events
            if (statement.verb && (
                statement.verb.id.includes('completed') ||
                statement.verb.id.includes('answered') ||
                statement.verb.id.includes('passed') ||
                statement.verb.id.includes('failed')
            )) {
                // Send to webhook if URL provided
                if (webhookUrl) {
                    fetch(webhookUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            contentId: ${jsLiteral(contentId)},
                            userId: ${jsLiteral(user.id)},
                            statement: statement
                        })
                    }).catch(err => console.error('Failed to send results:', err));
                }

                // Always post to parent window if in iframe
                if (window.parent !== window) {
                    window.parent.postMessage({
                        type: 'h5p-result',
                        contentId: ${jsLiteral(contentId)},
                        userId: ${jsLiteral(user.id)},
                        statement: statement
                    }, '*');
                }
            }
        });
    </script>`;

        // Inject xAPI script before </body>
        playerHtml = playerHtml.replace('</body>', xapiScript + '\n</body>');

        res.send(playerHtml);
    } catch (error) {
        console.error('Error rendering player:', error);
        res.status(500).type('text/plain').send(`Error: ${error.message}`);
    }
});

// ============================================================================
// Editor Endpoints - For creating/editing H5P content
// ============================================================================

// Edit existing content (GET - show editor)
app.get('/edit/:contentId', async (req, res) => {
    try {
        const user = createUser(req);
        const editorHtml = await h5pEditor.render(
            req.params.contentId,
            EDITOR_LANGUAGE,
            user
        );

        res.send(wrapEditorHtml(editorHtml, req.params.contentId, req.editor ? req.editor.returnUrl : req.query.returnUrl));
    } catch (error) {
        console.error('Error rendering editor:', error);
        res.status(500).type('text/plain').send(`Error: ${error.message}`);
    }
});

// Edit existing content (POST - save from built-in form or our JSON handler)
app.post('/edit/:contentId', fileUpload({ useTempFiles: true, tempFileDir: uploadTmpPath }), async (req, res) => {
    try {
        const user = createUser(req);
        const contentId = req.params.contentId;
        // Handle both JSON (from our form handler) and multipart form data
        const library = req.body?.library;
        const parameters = req.body?.params || req.body?.parameters;
        const returnUrl = httpUrlOrNull(req.query.returnUrl);

        if (!library || !parameters) {
            console.log('Missing data. Body:', req.body);
            return res.status(400).type('text/plain').send('Missing library or parameters');
        }

        // The form sends params as: {"params": {...actual content...}, "metadata": {...}}
        const fullParams = typeof parameters === 'string' ? JSON.parse(parameters) : parameters;
        // Extract the actual content parameters and metadata separately
        const contentParams = fullParams.params || fullParams;
        const metadata = fullParams.metadata || { title: 'Untitled' };

        await h5pEditor.saveOrUpdateContentReturnMetaData(
            contentId,
            contentParams,  // Just the content parameters, not the wrapper
            metadata,
            library,
            user
        );

        const redirectUrl = savedReturnUrl(req, returnUrl, contentId, metadata.title) || `/edit/${contentId}`;

        // Always return JSON for the client-side interception to catch
        console.log('Content updated successfully, returning JSON with redirectUrl:', redirectUrl);
        return res.json({ success: true, contentId, redirectUrl });
    } catch (error) {
        console.error('Error saving content:', error);
        res.status(500).type('text/plain').send(`Error: ${error.message}`);
    }
});

// Create new content (GET - show editor)
app.get('/new', async (req, res) => {
    try {
        const user = createUser(req);
        const editorHtml = await h5pEditor.render(
            undefined,  // No content ID = new content
            EDITOR_LANGUAGE,
            user
        );

        res.send(wrapEditorHtml(editorHtml, null, req.editor ? req.editor.returnUrl : req.query.returnUrl));
    } catch (error) {
        console.error('Error rendering editor:', error);
        res.status(500).type('text/plain').send(`Error: ${error.message}`);
    }
});

// Create new content (POST - save from built-in form)
// Use fileUpload middleware since form uses multipart/form-data
app.post('/new', fileUpload({ useTempFiles: true, tempFileDir: uploadTmpPath }), async (req, res) => {
    try {
        const user = createUser(req);
        // Form fields come from req.body when using express-fileupload
        const library = req.body?.library;
        const parameters = req.body?.params || req.body?.parameters;
        const returnUrl = httpUrlOrNull(req.query.returnUrl);

        if (!library || !parameters) {
            console.log('Missing data. Body:', req.body);
            return res.status(400).type('text/plain').send('Missing library or parameters');
        }

        // The form sends params as: {"params": {...actual content...}, "metadata": {...}}
        const fullParams = typeof parameters === 'string' ? JSON.parse(parameters) : parameters;
        // Extract the actual content parameters and metadata separately
        const contentParams = fullParams.params || fullParams;
        const metadata = fullParams.metadata || { title: 'Untitled' };

        const savedId = await h5pEditor.saveOrUpdateContentReturnMetaData(
            undefined,
            contentParams,  // Just the content parameters, not the wrapper
            metadata,
            library,
            user
        );

        // Content an account makes belongs to its organisation (so the account may edit it again)
        if (req.account) accounts.setOrg(String(savedId.id), req.account.org);
        const redirectUrl = savedReturnUrl(req, returnUrl, savedId.id, metadata.title) || `/edit/${savedId.id}`;

        // Always return JSON for the client-side interception to catch
        console.log('Content saved successfully, returning JSON with redirectUrl:', redirectUrl);
        return res.json({ success: true, contentId: savedId.id, redirectUrl });

    } catch (error) {
        console.error('Error saving new content:', error);
        res.status(500).type('text/plain').send(`Error: ${error.message}`);
    }
});

// Save content (called from editor via AJAX)
app.post('/api/save', async (req, res) => {
    try {
        const user = createUser(req);
        const { contentId, library, params, metadata } = req.body;

        const savedId = await h5pEditor.saveOrUpdateContentReturnMetaData(
            contentId || undefined,
            params,
            metadata || { title: 'Untitled' },
            library,
            user
        );

        res.json({
            success: true,
            contentId: savedId.id,
            metadata: savedId.metadata
        });
    } catch (error) {
        console.error('Error saving content:', error);
        res.status(500).json({ error: error.message });
    }
});

// Import an .h5p package: POST /api/import[?contentId=<id>], multipart field "file".
// Installs or updates the package's libraries. With contentId the content gets that id
// and replaces an existing item with the same id (stable public URLs on re-import).
app.post('/api/import', fileUpload({ useTempFiles: true, tempFileDir: uploadTmpPath, limits: { fileSize: 500 * 1024 * 1024 } }), async (req, res) => {
    const file = req.files?.file;
    const contentId = req.query.contentId;
    try {
        if (!file || Array.isArray(file)) return res.status(400).json({ error: 'Send one .h5p file in the field "file"' });
        if (contentId !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(contentId)) {
            return res.status(400).json({ error: 'contentId may only contain letters, digits, "_" and "-"' });
        }
        const result = await h5pEditor.packageImporter.addPackageLibrariesAndContent(file.tempFilePath, createUser(req), contentId);
        res.json({
            success: true,
            contentId: result.id,
            title: result.metadata.title,
            mainLibrary: result.metadata.mainLibrary,
            librariesChanged: result.installedLibraries.filter((l) => l.type !== 'none').length
        });
    } catch (error) {
        console.error('Error importing package:', error);
        res.status(500).json({ error: error.message });
    } finally {
        if (file?.tempFilePath) await fs.rm(file.tempFilePath, { force: true });
    }
});

// Helper function to wrap editor HTML with cancel button and styling
function wrapEditorHtml(editorHtml, contentId, returnUrl) {
    // Add styling and a cancel button (the built-in Create/Save button handles saving)

    const customStyles = `
    <style>
        body { padding: 20px; }
        .h5p-editor-buttons {
            display: flex;
            gap: 10px;
            margin-top: 20px;
        }
        .btn-cancel {
            padding: 10px 20px; font-size: 16px; cursor: pointer;
            border: none; border-radius: 4px;
            background: #ccc; color: #333;
        }
        .btn-cancel:hover { background: #bbb; }
        /* Style the built-in save button */
        #save-h5p {
            padding: 10px 20px !important;
            font-size: 16px !important;
            background: #21759b !important;
            color: white !important;
            border: none !important;
            border-radius: 4px !important;
            cursor: pointer !important;
        }
        #save-h5p:hover { background: #1e6a8d !important; }
        /* Hide the original button location */
        #h5p-content-form > input#save-h5p { display: none; }
    </style>`;

    const cancelScript = `
    <div class="h5p-editor-buttons">
        <button type="button" id="save-h5p-clone" class="button button-primary button-large" style="padding: 10px 20px; font-size: 16px; background: #21759b; color: white; border: none; border-radius: 4px; cursor: pointer;">${contentId ? EDITOR_BUTTONS.save : EDITOR_BUTTONS.create}</button>
        <button type="button" class="btn-cancel" onclick="cancelH5PEdit()">${EDITOR_BUTTONS.cancel}</button>
    </div>
    <script>
        const h5pReturnUrl = ${jsLiteral(httpUrlOrNull(returnUrl))};
        const h5pContentId = ${jsLiteral(contentId || null)};

        function cancelH5PEdit() {
            if (h5pReturnUrl) {
                window.location.href = h5pReturnUrl;
            } else {
                window.history.back();
            }
        }

        // Make cloned save button trigger the original save
        document.getElementById('save-h5p-clone').addEventListener('click', function() {
            document.getElementById('save-h5p').click();
        });

        // Intercept XHR and fetch responses to detect successful saves and redirect
        (function() {
            // Intercept XMLHttpRequest
            const originalXHROpen = XMLHttpRequest.prototype.open;
            const originalXHRSend = XMLHttpRequest.prototype.send;

            XMLHttpRequest.prototype.open = function(method, url) {
                this._url = url;
                this._method = method;
                return originalXHROpen.apply(this, arguments);
            };

            XMLHttpRequest.prototype.send = function() {
                const xhr = this;
                xhr.addEventListener('load', function() {
                    console.log('XHR completed:', xhr._method, xhr._url, 'Status:', xhr.status);
                    try {
                        const response = JSON.parse(xhr.responseText);
                        console.log('XHR response:', response);
                        if (response.success && response.redirectUrl) {
                            console.log('Save successful, redirecting to:', response.redirectUrl);
                            window.location.href = response.redirectUrl;
                        }
                    } catch (e) {
                        // Not JSON, ignore
                    }
                });
                return originalXHRSend.apply(this, arguments);
            };

            // Also intercept fetch in case H5P uses that
            const originalFetch = window.fetch;
            window.fetch = function(url, options) {
                console.log('Fetch:', options?.method || 'GET', url);
                return originalFetch.apply(this, arguments).then(response => {
                    // Clone response so we can read it
                    const clonedResponse = response.clone();
                    clonedResponse.json().then(data => {
                        console.log('Fetch response:', data);
                        if (data.success && data.redirectUrl) {
                            console.log('Save successful via fetch, redirecting to:', data.redirectUrl);
                            window.location.href = data.redirectUrl;
                        }
                    }).catch(() => {});
                    return response;
                });
            };
        })();
    </script>`;

    // Inject styles after <head> and cancel button/script before </body>
    let html = editorHtml;
    html = html.replace('</head>', customStyles + '</head>');
    html = html.replace('</body>', cancelScript + '</body>');

    // Fix cross-origin frame access errors by wrapping parent access in try-catch
    // The H5P library tries to access parent properties which causes cross-origin errors

    // Fix H5PIntegration
    html = html.replace(
        /window\.H5PIntegration\s*=\s*parent\.H5PIntegration\s*\|\|/g,
        'window.H5PIntegration = (function() { try { return parent.H5PIntegration; } catch(e) { return null; } })() ||'
    );

    // Fix H5PEditor references to parent
    html = html.replace(
        /parent\.H5PEditor/g,
        '(function() { try { return parent.H5PEditor; } catch(e) { return window.H5PEditor; } })()'
    );

    // Add a script to ensure H5PEditor is available
    const crossOriginFix = `
    <script>
        // Prevent cross-origin errors when H5P libraries try to access parent
        (function() {
            // Create safe wrapper for parent access
            var safeParent = {};
            try {
                // Try to access parent - this will fail if cross-origin
                if (parent && parent.H5PEditor) {
                    safeParent = parent;
                }
            } catch(e) {
                // Cross-origin error - use window instead
                safeParent = window;
            }

            // Make sure H5PEditor is accessible
            if (window.H5PEditor && !window.H5PEditor.instances) {
                window.H5PEditor.instances = [];
            }
        })();
    </script>`;

    html = html.replace('</head>', crossOriginFix + '</head>');

    // Change button text from "Create" to "Save" when editing existing content
    if (contentId) {
        html = html.replace('value="Create"', 'value="Save"');
    }

    return html;
}

// ============================================================================
// Content Hub / Content Type Selection
// ============================================================================

// Get available content types (for content picker)
app.get('/api/content-types', async (req, res) => {
    try {
        const contentTypes = await h5pEditor.getContentTypeCache(createUser(req));
        res.json({ contentTypes: contentTypes.libraries || [] });
    } catch (error) {
        console.error('Error getting content types:', error);
        res.json({ contentTypes: [] });
    }
});

// ============================================================================
// Health Check
// ============================================================================

app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'h5p-server' });
});

// ============================================================================
// Start Server
// ============================================================================

// Plugins (opt-in): H5P_PLUGINS lists ES modules, comma-separated. Each default-exports
// `async (app, ctx) => {}` and adds its own routes. They load after the kit's routes and
// behind the same protected-mode login: only GET /play and the player's files are public.
async function loadPlugins() {
    const list = (process.env.H5P_PLUGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    for (const file of list) {
        const mod = await import(pathToFileURL(path.resolve(file)).href);
        await mod.default(app, { express, protectedMode: PROTECTED, dataPath: H5P_DATA_PATH, baseUrl: H5P_BASE_URL });
        console.log(`Plugin loaded: ${file}`);
    }
}

async function start() {
    try {
        await initH5P();
        await setupRoutes();
        await loadPlugins();
        await addErrorHandlers();

        app.listen(PORT, () => {
            console.log(`H5P Server running on http://localhost:${PORT}`);
            console.log(`  - Player: http://localhost:${PORT}/play/:contentId`);
            console.log(`  - Editor: http://localhost:${PORT}/edit/:contentId`);
            console.log(`  - New Content: http://localhost:${PORT}/new`);
            console.log(`  - Content API: http://localhost:${PORT}/api/content`);
        });
    } catch (error) {
        console.error('Failed to start H5P server:', error);
        process.exit(1);
    }
}

start();
