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
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { createHash, timingSafeEqual } from 'crypto';
import * as H5P from '@lumieducation/h5p-server';
import { createRequire } from 'module';

// Lumi's own editor page template (wrapped below so its inline JSON is escaped)
const lumiEditorRenderer = createRequire(import.meta.url)('@lumieducation/h5p-server/build/src/renderers/default.js').default;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Configuration from environment
const PORT = process.env.PORT || process.env.H5P_PORT || 3000;
const H5P_BASE_URL = process.env.H5P_BASE_URL || `http://localhost:${PORT}`;

// Storage paths (configurable for Docker deployment)
const H5P_DATA_PATH = process.env.H5P_DATA_PATH || path.resolve(__dirname, '../h5p');

// Protected mode (opt-in, for a server on the internet): set H5P_ADMIN_PASSWORD.
// Then only playing is public (GET /play/:id and the static files it loads);
// everything else (editor, save, delete, import, content list, H5P ajax) needs the
// admin login: HTTP Basic (user H5P_ADMIN_USER, default "admin") or
// "Authorization: Bearer <H5P_ADMIN_PASSWORD>". Players are anonymous and keep no
// user state. Without the variable the server behaves as before (open, for development).
const ADMIN_USER = process.env.H5P_ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.H5P_ADMIN_PASSWORD || '';
const PROTECTED = ADMIN_PASSWORD !== '';
const PUBLIC_ORIGIN = new URL(H5P_BASE_URL).origin;
const PUBLIC_PATHS = /^\/(health$|play\/[^/]+$|h5p\/(core|libraries|content)\/)/;

const sameSecret = (a, b) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

function isAdminRequest(req) {
    const [scheme, value] = (req.get('authorization') || '').split(' ');
    if (!value) return false;
    if (/^bearer$/i.test(scheme)) return sameSecret(value, ADMIN_PASSWORD);
    if (!/^basic$/i.test(scheme)) return false;
    const pair = Buffer.from(value, 'base64').toString('utf8');
    const i = pair.indexOf(':');
    return i > 0 && sameSecret(pair.slice(0, i), ADMIN_USER) & sameSecret(pair.slice(i + 1), ADMIN_PASSWORD);
}

// The browser sends cached Basic credentials with requests that other sites start,
// so a write that comes from another site is refused (CSRF).
function fromOtherSite(req) {
    const site = req.get('sec-fetch-site');
    if (site && site !== 'same-origin' && site !== 'none') return true;
    const origin = req.get('origin');
    return !!origin && origin !== PUBLIC_ORIGIN;
}

// Where /login sends the browser next: only a path on this server ("/x"; not "//host", "/\host" or a scheme)
const localPathOr = (value, fallback) =>
    (typeof value === 'string' && /^\/(?![/\\])/.test(value) && !/[\x00-\x20\x7f]/.test(value) ? value : fallback);

if (PROTECTED) {
    const CHALLENGE = 'Basic realm="H5P admin", charset="UTF-8"';
    app.use((req, res, next) => {
        const isRead = req.method === 'GET' || req.method === 'HEAD';
        if (isRead && PUBLIC_PATHS.test(req.path)) {
            req.isAdmin = false;
            return next();
        }
        if (!isAdminRequest(req)) {
            const mode = req.get('sec-fetch-mode');
            if (isRead && req.path === '/login') {
                return res.status(401).set('WWW-Authenticate', CHALLENGE).type('text/html')
                    .send('<!doctype html><title>Login required</title><p>Login required. Reload this page to log in.</p>');
            }
            // A browser reuses Basic credentials only below the folder of the URL that asked for them
            // (/edit/ for /edit/x), so the editor's own requests under /h5p/ would go without them.
            // Page loads therefore log in at /login: at the root, the login covers the whole server.
            if (isRead && mode === 'navigate') {
                return res.redirect(303, '/login?next=' + encodeURIComponent(req.originalUrl));
            }
            // Ask for the login only from non-browser clients (and other page loads). On a background
            // request a challenge would pop up a login dialog in a public player and block the page.
            if (!mode || mode === 'navigate') res.set('WWW-Authenticate', CHALLENGE);
            return res.status(401).type('text/plain').send('Login required');
        }
        if (!isRead && /^basic/i.test(req.get('authorization')) && fromOtherSite(req)) {
            return res.status(403).type('text/plain').send('Cross-site request refused');
        }
        req.isAdmin = true;
        res.set('Content-Security-Policy', "frame-ancestors 'self'");
        next();
    });
    // Logged in (the middleware above asks for the login): back to the page that was asked for
    app.get('/login', (req, res) => res.redirect(303, localPathOr(req.query.next, '/')));
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
app.use('/h5p/core', express.static(path.join(h5pBasePath, 'core')));
app.use('/h5p/editor', express.static(path.join(h5pBasePath, 'editor')));
app.use('/h5p/content', express.static(path.join(h5pBasePath, 'content')));
app.use('/h5p/libraries', express.static(path.join(h5pBasePath, 'libraries')));

// Temp files: H5P stores them in user-specific subdirectories but generates URLs without user prefix
// So we need to search across all user directories
app.use('/temp-files', async (req, res, next) => {
    const requestedPath = req.path; // e.g., /videos/video-abc123.mp4
    const tempDir = path.join(h5pBasePath, 'temp');

    // First try direct path (in case it's there)
    const directPath = path.join(tempDir, requestedPath);
    try {
        await fs.access(directPath);
        return res.sendFile(directPath);
    } catch {}

    // Search in user subdirectories
    try {
        const entries = await fs.readdir(tempDir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isDirectory()) {
                const userPath = path.join(tempDir, entry.name, requestedPath);
                try {
                    await fs.access(userPath);
                    return res.sendFile(userPath);
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
const configPath = path.join(h5pBasePath, 'config.json');

// Ensure directories exist
async function ensureDirectories() {
    await fs.mkdir(librariesPath, { recursive: true });
    await fs.mkdir(contentPath, { recursive: true });
    await fs.mkdir(tempPath, { recursive: true });

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
function translationCallback(key, language) {
    // For a real app, you'd load translations from files
    // For now, just return the key
    return key;
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
        tempFileDir: tempPath
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
            'en',
            user
        );

        res.send(wrapEditorHtml(editorHtml, req.params.contentId, req.query.returnUrl));
    } catch (error) {
        console.error('Error rendering editor:', error);
        res.status(500).type('text/plain').send(`Error: ${error.message}`);
    }
});

// Edit existing content (POST - save from built-in form or our JSON handler)
app.post('/edit/:contentId', fileUpload({ useTempFiles: true, tempFileDir: tempPath }), async (req, res) => {
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

        // Build redirect URL
        let redirectUrl = `/edit/${contentId}`;
        if (returnUrl) {
            const url = new URL(returnUrl);
            url.searchParams.set('contentId', contentId);
            url.searchParams.set('title', metadata.title);
            redirectUrl = url.toString();
        }

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
            'en',
            user
        );

        res.send(wrapEditorHtml(editorHtml, null, req.query.returnUrl));
    } catch (error) {
        console.error('Error rendering editor:', error);
        res.status(500).type('text/plain').send(`Error: ${error.message}`);
    }
});

// Create new content (POST - save from built-in form)
// Use fileUpload middleware since form uses multipart/form-data
app.post('/new', fileUpload({ useTempFiles: true, tempFileDir: tempPath }), async (req, res) => {
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

        // Build redirect URL
        let redirectUrl = `/edit/${savedId.id}`;
        if (returnUrl) {
            const url = new URL(returnUrl);
            url.searchParams.set('contentId', savedId.id);
            url.searchParams.set('title', metadata.title);
            redirectUrl = url.toString();
        }

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
app.post('/api/import', fileUpload({ useTempFiles: true, tempFileDir: tempPath, limits: { fileSize: 500 * 1024 * 1024 } }), async (req, res) => {
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
        <button type="button" id="save-h5p-clone" class="button button-primary button-large" style="padding: 10px 20px; font-size: 16px; background: #21759b; color: white; border: none; border-radius: 4px; cursor: pointer;">${contentId ? 'Save' : 'Create'}</button>
        <button type="button" class="btn-cancel" onclick="cancelH5PEdit()">Cancel</button>
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

async function start() {
    try {
        await initH5P();
        await setupRoutes();
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
