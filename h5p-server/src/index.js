/**
 * Modern H5P Server using @lumieducation/h5p-server
 *
 * Provides:
 * - H5P content player (view/play content)
 * - H5P content editor (create/edit content)
 * - Content management API
 * - Score/completion webhooks to Django
 */

import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import fileUpload from 'express-fileupload';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import * as H5P from '@lumieducation/h5p-server';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Configuration from environment
const PORT = process.env.PORT || process.env.H5P_PORT || 3000;
const DJANGO_URL = process.env.DJANGO_URL || 'http://localhost:8000';
const H5P_BASE_URL = process.env.H5P_BASE_URL || `http://localhost:${PORT}`;

// Storage paths (configurable for Docker deployment)
const H5P_DATA_PATH = process.env.H5P_DATA_PATH || path.resolve(__dirname, '../h5p');

// Middleware
app.use(cors({
    origin: [DJANGO_URL, 'http://localhost:8000', 'http://127.0.0.1:8000'],
    credentials: true
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
    return {
        id: req.query.userId || req.body?.userId || 'anonymous',
        name: req.query.userName || req.body?.userName || 'Anonymous User',
        email: req.query.userEmail || req.body?.userEmail || 'anonymous@example.com',
        type: 'local'
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
        undefined            // 9. options
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
    app.use('/h5p/ajax', (req, res, next) => {
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

        // Track xAPI events and send to Django
        H5P.externalDispatcher.on('xAPI', function(event) {
            const statement = event.data.statement;

            // Only track completion and answered events
            if (statement.verb && (
                statement.verb.id.includes('completed') ||
                statement.verb.id.includes('answered') ||
                statement.verb.id.includes('passed') ||
                statement.verb.id.includes('failed')
            )) {
                // Send to Django webhook
                fetch('${DJANGO_URL}/h5p/results/', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contentId: '${contentId}',
                        userId: '${user.id}',
                        statement: statement
                    })
                }).catch(err => console.error('Failed to send results:', err));

                // Also post to parent window if in iframe
                if (window.parent !== window) {
                    window.parent.postMessage({
                        type: 'h5p-result',
                        contentId: '${contentId}',
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
        res.status(500).send(`Error: ${error.message}`);
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
        res.status(500).send(`Error: ${error.message}`);
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
        const returnUrl = req.query.returnUrl;

        if (!library || !parameters) {
            console.log('Missing data. Body:', req.body);
            return res.status(400).send('Missing library or parameters');
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
        res.status(500).send(`Error: ${error.message}`);
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
        res.status(500).send(`Error: ${error.message}`);
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
        const returnUrl = req.query.returnUrl;

        if (!library || !parameters) {
            console.log('Missing data. Body:', req.body);
            return res.status(400).send('Missing library or parameters');
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
        res.status(500).send(`Error: ${error.message}`);
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

// Helper function to wrap editor HTML with cancel button and styling
function wrapEditorHtml(editorHtml, contentId, returnUrl) {
    // Add styling and a cancel button (the built-in Create/Save button handles saving)

    const customStyles = `
    <style>
        body { padding: 20px; }
        .h5p-editor-cancel { margin-top: 20px; }
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
    </style>`;

    const cancelScript = `
    <div class="h5p-editor-cancel">
        <button class="btn-cancel" onclick="cancelH5PEdit()">Cancel</button>
    </div>
    <script>
        const h5pReturnUrl = ${returnUrl ? `'${returnUrl}'` : 'null'};
        const h5pContentId = ${contentId ? `'${contentId}'` : 'null'};

        function cancelH5PEdit() {
            if (h5pReturnUrl) {
                window.location.href = h5pReturnUrl;
            } else {
                window.history.back();
            }
        }

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
