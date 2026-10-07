// Accounts (opt-in, protected mode only): extra logins next to the admin login, each tied to one organisation.
// H5P_ACCOUNTS names a JSON file with a list of accounts:
//
//   [{ "user": "team-a", "password": "scrypt:<salt hex>:<hash hex>", "org": "team-a",
//      "home": "/portal/team-a/", "allow": ["/portal/team-a/", "/library/api/"], "uploads": false }]
//
// - password: a hash, never the password itself. Make one with: node src/accounts.js hash   (reads the password
//   from stdin, prints the hash)
// - org: the organisation the account works for. The account may open the editor for new content and for content
//   of its own organisation. Which content belongs to which organisation is kept in <data path>/content-orgs.json
//   ({ "<contentId>": "<org>" }): content an account saves is added to it, other entries are written by an admin
//   (or an import script). Content that is not in it stays admin-only.
// - home: where the account lands after logging in (and when it opens /)
// - allow: path prefixes the account may use with any method, e.g. a plugin's pages and API. The plugin sees
//   req.account = { user, org, uploads } and keeps organisations apart within its own routes.
// - uploads: passed on to plugins as req.account.uploads (the kit itself does nothing with it)
//
// Nothing else is open to an account: no content list, no delete, no import, no library installs, no admin API.
// Logging out ends that account's sessions (kept in <data path>/account-epochs.json); a new password for the account
// ends them too, and so does a new admin password.
import { readFileSync, writeFileSync, statSync } from 'fs';
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const same = (a, b) => timingSafeEqual(createHash('sha256').update(String(a)).digest(), createHash('sha256').update(String(b)).digest());
const now = () => Math.floor(Date.now() / 1000);
// the H5P editor's own ajax actions; not library-install/-upload or get-content (a hub download installs libraries)
const EDITOR_AJAX = new Set(['content-type-cache', 'content-hub-metadata-cache', 'libraries', 'translations', 'files', 'filter']);

export function hashPassword(password) {
    const salt = randomBytes(16);
    return `scrypt:${salt.toString('hex')}:${scryptSync(password, salt, 32).toString('hex')}`;
}
function checkPassword(password, stored) {
    const [kind, salt, hash] = String(stored).split(':');
    return kind === 'scrypt' && !!salt && !!hash && same(scryptSync(password, Buffer.from(salt, 'hex'), 32).toString('hex'), hash);
}
const DUMMY = hashPassword(randomBytes(16).toString('hex'));   // a wrong user name costs as much as a wrong password

const PREFIX = /^\/(?![/\\])[^\s?#]*\/$/;   // a local path that ends in "/"
function validate(list, adminUser) {
    if (!Array.isArray(list)) throw new Error('H5P_ACCOUNTS: the file must hold a list of accounts');
    const seen = new Set();
    for (const a of list) {
        const where = `H5P_ACCOUNTS: account ${JSON.stringify(a?.user)}`;
        if (typeof a?.user !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(a.user)) throw new Error(`${where}: user must be 1-64 letters, digits, ".", "_" or "-"`);
        if (a.user === adminUser || seen.has(a.user)) throw new Error(`${where}: user name is taken`);
        if (!/^scrypt:[0-9a-f]+:[0-9a-f]+$/.test(a.password || '')) throw new Error(`${where}: password must be a hash (node src/accounts.js hash)`);
        if (typeof a.org !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(a.org)) throw new Error(`${where}: org must be 1-64 letters, digits, "_" or "-"`);
        if (typeof a.home !== 'string' || !/^\/(?![/\\])[^\s]*$/.test(a.home)) throw new Error(`${where}: home must be a path on this server`);
        if (!Array.isArray(a.allow || []) || !(a.allow || []).every((p) => typeof p === 'string' && PREFIX.test(p))) throw new Error(`${where}: allow must be a list of paths that start and end with "/"`);
        if (a.uploads !== undefined && typeof a.uploads !== 'boolean') throw new Error(`${where}: uploads must be true or false`);
        seen.add(a.user);
    }
}

export function loadAccounts({ file, dataPath, secret, adminUser }) {
    const list = JSON.parse(readFileSync(file, 'utf8'));
    validate(list, adminUser);
    const byUser = new Map(list.map((a) => [a.user, { ...a, allow: a.allow || [], uploads: !!a.uploads }]));

    const epochFile = path.join(dataPath, 'account-epochs.json');
    let epochs = {};
    try { epochs = JSON.parse(readFileSync(epochFile, 'utf8')); } catch { /* nobody logged out yet */ }

    // content -> organisation, read again whenever the file changes (an admin or an import may write it)
    const orgFile = path.join(dataPath, 'content-orgs.json');
    let orgs = {}, orgStamp = null;
    const contentOrgs = () => {
        try {
            const stamp = statSync(orgFile).mtimeMs;
            if (stamp !== orgStamp) { orgs = JSON.parse(readFileSync(orgFile, 'utf8')); orgStamp = stamp; }
        } catch (e) {
            if (e.code !== 'ENOENT') console.error('content-orgs.json not read:', e.message);
            else { orgs = {}; orgStamp = null; }
        }
        return orgs;
    };

    // Session cookie "<payload>.<HMAC>", payload = base64url JSON { u, iat (ms), exp (s) }. The key includes the
    // account's password hash, so a new password ends its sessions
    const key = createHmac('sha256', secret).update('h5p-account-session-v1').digest();
    const mac = (payload, a) => createHmac('sha256', key).update(a.password).update('.').update(payload).digest('base64url');

    const orgOf = (contentId) => contentOrgs()[contentId] || null;
    return {
        login(user, password) {
            const a = byUser.get(user);
            return checkPassword(password, a ? a.password : DUMMY) && a ? a : null;
        },
        issue(a, seconds) {
            const payload = Buffer.from(JSON.stringify({ u: a.user, iat: Date.now(), exp: now() + seconds })).toString('base64url');
            return `${payload}.${mac(payload, a)}`;
        },
        read(value) {
            const [payload, sig] = String(value || '').split('.');
            if (!payload || !sig) return null;
            let d;
            try { d = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
            const a = d && typeof d.u === 'string' ? byUser.get(d.u) : null;
            if (!a || !same(sig, mac(payload, a))) return null;
            return Number(d.exp) > now() && Number(d.iat) > (epochs[a.user] || 0) ? a : null;
        },
        logout(a) {
            epochs[a.user] = Date.now();
            try { writeFileSync(epochFile, JSON.stringify(epochs)); } catch (e) { console.error('account-epochs.json not saved:', e.message); }
        },
        orgOf,
        setOrg(contentId, org) {
            writeFileSync(orgFile, JSON.stringify({ ...contentOrgs(), [contentId]: org }, null, 1));
        },
        // What an account may request (after the public paths): the editor for new content and for its
        // organisation's content, what the H5P editor loads, and its own allow-list
        mayUse(a, req) {
            const p = req.path, seg = p.split('/');
            // no dot segments, empty segments or encoded slashes: the routes behind may resolve them differently
            if (seg.slice(1).some((x, i) => x === '..' || x === '.' || (x === '' && i < seg.length - 2)) || /%2f|%5c|\\/i.test(req.originalUrl || p)) return false;
            if (p === '/new') return true;
            if ((seg[1] === 'edit' || seg[1] === 'params') && seg.length === 3) return orgOf(decodeURIComponent(seg[2])) === a.org;
            if (p === '/h5p/ajax') return EDITOR_AJAX.has(req.query?.action);
            if (req.method === 'GET' && /^\/(h5p\/editor|temp-files)\//.test(p)) return true;
            const dir = p.endsWith('/') ? p : p + '/';
            return a.allow.some((prefix) => p.startsWith(prefix) || dir === prefix);
        },
    };
}

// node src/accounts.js hash   -> reads a password from stdin, prints its hash for the accounts file
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (process.argv[2] !== 'hash') { console.error('usage: node src/accounts.js hash   (password on stdin)'); process.exit(2); }
    const password = readFileSync(0, 'utf8').replace(/\r?\n$/, '');
    if (password.length < 8) { console.error('use a password of at least 8 characters'); process.exit(2); }
    console.log(hashPassword(password));
}
