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
const PORT = process.env.H5P_PORT || 3000;
const DJANGO_URL = process.env.DJANGO_URL || 'http://localhost:8000';
const H5P_BASE_URL = process.env.H5P_BASE_URL || `http://localhost:${PORT}`;

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
const h5pBasePath = path.resolve(__dirname, '../h5p');

// Serve H5P core and editor static files BEFORE other routes
app.use('/h5p/core', express.static(path.join(h5pBasePath, 'core')));
app.use('/h5p/editor', express.static(path.join(h5pBasePath, 'editor')));

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

    // H5P.fs signature:
    // (config, librariesPath, temporaryStoragePath, contentPath,
    //  contentUserDataStorage, contentStorage, translationCallback, urlGenerator, options)
    h5pEditor = H5P.fs(
        config,              // 1. config
        librariesPath,       // 2. librariesPath
        tempPath,            // 3. temporaryStoragePath
        contentPath,         // 4. contentPath
        undefined,           // 5. contentUserDataStorage
        undefined,           // 6. contentStorage (use default)
        translationCallback, // 7. translationCallback
        new H5P.UrlGenerator(config, {
            queryParamGenerator: (user) => ({ userId: user.id }),
            protectAjax: false,
            protectContentUserData: false,
            protectSetFinished: false
        }),                  // 8. urlGenerator
        undefined            // 9. options
    );

    h5pPlayer = h5pEditor;

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

        const playerModel = await h5pPlayer.render(
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

        // Render HTML page with player
        const html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${playerModel.contentId}</title>
    ${playerModel.styles.map(s => `<link rel="stylesheet" href="${s}">`).join('\n    ')}
    ${playerModel.scripts.map(s => `<script src="${s}"></script>`).join('\n    ')}
</head>
<body>
    <div class="h5p-content" data-content-id="${playerModel.contentId}"></div>
    <script>
        ${playerModel.integration}

        // Track xAPI events and send to parent/Django
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
    </script>
</body>
</html>`;

        res.send(html);
    } catch (error) {
        console.error('Error rendering player:', error);
        res.status(500).send(`Error: ${error.message}`);
    }
});

// ============================================================================
// Editor Endpoints - For creating/editing H5P content
// ============================================================================

// Edit existing content
app.get('/edit/:contentId', async (req, res) => {
    try {
        const user = createUser(req);
        // render() returns complete HTML string
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

// Create new content (optionally specify library)
app.get('/new', async (req, res) => {
    try {
        const user = createUser(req);
        // render() returns complete HTML string
        const editorHtml = await h5pEditor.render(
            undefined,  // No content ID = new content
            'en',
            user
        );

        // Wrap the HTML with our save/cancel UI
        res.send(wrapEditorHtml(editorHtml, null, req.query.returnUrl));
    } catch (error) {
        console.error('Error rendering editor:', error);
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

// Helper function to wrap editor HTML with save/cancel buttons
function wrapEditorHtml(editorHtml, contentId, returnUrl) {
    // The H5PEditor.render() returns complete HTML
    // We inject our custom styles and save/cancel script before </body>

    const customStyles = `
    <style>
        .h5p-save-wrapper { padding: 20px; max-width: 1200px; margin: 0 auto; }
        .h5p-editor-actions { margin-top: 20px; display: flex; gap: 10px; }
        .h5p-editor-actions button {
            padding: 10px 20px; font-size: 16px; cursor: pointer;
            border: none; border-radius: 4px;
        }
        .btn-save { background: #21759b; color: white; }
        .btn-save:hover { background: #1e6a8d; }
        .btn-cancel { background: #ccc; }
        .btn-cancel:hover { background: #bbb; }
        .saving { opacity: 0.5; pointer-events: none; }
    </style>`;

    const saveScript = `
    <div class="h5p-editor-actions">
        <button class="btn-save" onclick="saveH5PContent()">Save Content</button>
        <button class="btn-cancel" onclick="cancelH5PEdit()">Cancel</button>
    </div>
    <script>
        const h5pContentId = ${contentId ? `'${contentId}'` : 'null'};
        const h5pReturnUrl = ${returnUrl ? `'${returnUrl}'` : 'null'};

        async function saveH5PContent() {
            const saveBtn = document.querySelector('.btn-save');
            saveBtn.classList.add('saving');
            saveBtn.textContent = 'Saving...';

            try {
                // Check if H5PEditor exists
                if (typeof H5PEditor === 'undefined') {
                    throw new Error('H5PEditor not found');
                }

                // Check if instances array exists and has content
                if (!H5PEditor.instances || H5PEditor.instances.length === 0) {
                    throw new Error('Editor not initialized - no instances found');
                }

                const editor = H5PEditor.instances[0];
                if (!editor) throw new Error('Editor instance is null');

                const params = editor.getParams();
                const library = editor.getLibrary();
                const metadata = { title: params.metadata?.title || 'Untitled', ...params.metadata };

                const response = await fetch('/api/save', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contentId: h5pContentId, library, params, metadata,
                        userId: new URLSearchParams(window.location.search).get('userId') || 'anonymous'
                    })
                });

                const result = await response.json();
                if (result.success) {
                    if (window.parent !== window) {
                        window.parent.postMessage({ type: 'h5p-saved', contentId: result.contentId, metadata: result.metadata }, '*');
                    }
                    if (h5pReturnUrl) {
                        const url = new URL(h5pReturnUrl);
                        url.searchParams.set('contentId', result.contentId);
                        url.searchParams.set('title', metadata.title);
                        window.location.href = url.toString();
                    } else {
                        alert('Content saved!');
                        if (!h5pContentId) window.location.href = '/edit/' + result.contentId + window.location.search;
                    }
                } else throw new Error(result.error || 'Save failed');
            } catch (error) {
                alert('Error saving: ' + error.message);
            } finally {
                saveBtn.classList.remove('saving');
                saveBtn.textContent = 'Save Content';
            }
        }

        function cancelH5PEdit() {
            if (h5pReturnUrl) window.location.href = h5pReturnUrl;
            else if (window.parent !== window) window.parent.postMessage({ type: 'h5p-cancel' }, '*');
            else window.history.back();
        }
    </script>`;

    // Inject styles after <head> and buttons/script before </body>
    let html = editorHtml;
    html = html.replace('</head>', customStyles + '</head>');
    html = html.replace('</body>', saveScript + '</body>');

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
