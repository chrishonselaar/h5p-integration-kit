# H5P Server

A ready-to-use H5P content server for integration with external applications.

## What This Server Provides

The `@lumieducation/h5p-server` npm package provides H5P's core functionality (content storage, library management, editor/player rendering), and `@lumieducation/h5p-express` provides AJAX endpoints for the H5P client-side JavaScript. However, as [the Lumi docs note](https://docs.lumi.education/usage/ajax-endpoints):

> **The Express adapter does not include pages to create, edit, view, list or delete content!**

This server wraps those libraries into a **complete HTTP service** with:

### User-Facing Pages

| Endpoint | Description |
|----------|-------------|
| `GET /new` | H5P editor for creating new content |
| `POST /new` | Save new content |
| `GET /edit/:id` | H5P editor for existing content |
| `POST /edit/:id` | Update existing content |
| `GET /play/:id` | H5P player with xAPI tracking |

### Content Management API

| Endpoint | Description |
|----------|-------------|
| `GET /api/content` | List all content with metadata |
| `GET /api/content/:id` | Get single content metadata |
| `DELETE /api/content/:id` | Delete content |
| `GET /api/content-types` | List available H5P content types |
| `POST /api/import[?contentId=<id>]` | Import an `.h5p` package (multipart field `file`): installs or updates its libraries and stores the content. With `contentId` the content gets that id and replaces an existing item with the same id, so a re-import keeps its URL |

### Integration Features

| Feature | Description |
|---------|-------------|
| `returnUrl` param | Redirect back to your app after save with `?contentId=X&title=Y` |
| `webhookUrl` param | POST xAPI scores to your application's webhook endpoint |
| `postMessage` | Send xAPI events to parent window (for iframe embedding) |
| `userId` param | Track which user is interacting with content |

### Production Readiness

- Docker image with health checks
- Non-root user for security
- Volume mounts for data persistence
- CORS configured for cross-origin embedding
- Cross-origin iframe fixes for H5P's parent window access
- Optional protected mode for a server on the internet: public players, login for everything else (see below)

## Quick Start

### Using Node.js

```bash
npm install
npm start
# Server running at http://localhost:3000
```

### Using Docker

```bash
docker build -t h5p-server .
docker run -p 3000:3000 -v ./h5p:/data/h5p h5p-server
```

Or via docker-compose from the project root:

```bash
docker compose up -d h5p-server
```

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `H5P_BASE_URL` | `http://localhost:3000` | Public URL (for asset URLs in rendered HTML) |
| `H5P_DATA_PATH` | `./h5p` | Path to H5P data directory |
| `H5P_ADMIN_PASSWORD` | *(unset)* | Switches on **protected mode** (below). Unset means open mode: no login anywhere, for development only |
| `H5P_ADMIN_USER` | `admin` | User name for the admin login in protected mode |
| `H5P_EXTRA_SUBCONTENT` | *(unset)* | Path to a JSON file that lets containers accept extra content types, e.g. `{"H5P.Column": ["H5P.DeepZoomPage 0.1"], "H5P.QuestionSet": ["H5P.DeepZoomQuestion 0.1"]}`. H5P.Column, H5P.QuestionSet and similar containers only allow the sub-content types listed in their `semantics.json`; the editor removes any other type on save. Unset means stock behaviour |
| `H5P_EDITOR_ASSETS` | *(unset)* | Path to a folder served at `/editor-assets/`, for files that editor widgets read, e.g. a media catalogue. In protected mode it needs the admin login, like the editor. Unset means no such route |
| `H5P_PLUGINS` | *(unset)* | Comma-separated paths of ES modules that add routes. Each default-exports `async (app, ctx) => {}`; `ctx` has `express`, `protectedMode`, `dataPath` and `baseUrl`. They load after the kit's own routes and behind the same login (in protected mode only playing is public). Unset means no plugins |

### Protected mode

Without `H5P_ADMIN_PASSWORD` anyone who can reach the server can create, change and delete content. Set it before you put the server on the internet. Then:

- **Public, no login:** playing content. Only `GET`/`HEAD` on `/play/:id`, the static files a player loads (`/h5p/core/…`, `/h5p/libraries/…`, `/h5p/content/…`) and `/health`.
- **Everything else needs the admin login:** the editor, saving, deleting, importing, the content list and H5P's AJAX routes. Log in with HTTP Basic (user `H5P_ADMIN_USER`, password `H5P_ADMIN_PASSWORD`) or send `Authorization: Bearer <password>` from a script.
  - A browser gets the login dialog only on a page load. Opening an admin page (e.g. `/edit/<id>`) without being logged in sends the browser to `/login?next=…`, which asks for the login and then returns to that page. Logging in at this root-level URL makes the browser use the login for the whole server, including the editor's own requests under `/h5p/`. You can also open `/login` directly.
  - Background requests get a plain 401, so a public player never shows a login dialog. Scripts and `curl` get a 401 with a Basic challenge, as before.
  - A write that carries Basic credentials but comes from another site (`Origin` / `Sec-Fetch-Site`) is refused with 403, so other sites cannot use a logged-in admin's browser.
  - Admin pages cannot be framed by other sites (`frame-ancestors 'self'`).
- **Players are anonymous:** no user is passed to H5P, nothing is saved per user (no resume state, no `setFinished`), and `userId`/`webhookUrl` query parameters are ignored. Results still go to the parent page by `postMessage`.
- **CORS** allows anonymous `GET` from any origin.

Embed a protected server's content with H5P's resizer, which sizes the iframe to the content:

```html
<iframe src="https://h5p.example.org/play/<id>" width="100%" height="600" frameborder="0"
        allowfullscreen="allowfullscreen" allow="fullscreen" title="…"></iframe>
<script src="https://h5p.example.org/h5p/core/js/h5p-resizer.js" charset="UTF-8"></script>
```

Import content with a fixed id (for example from a converter), so its public URL stays the same on every re-import:

```bash
curl -H "Authorization: Bearer $H5P_ADMIN_PASSWORD" -F file=@item.h5p "https://h5p.example.org/api/import?contentId=80222"
```

Tests: `node test/protected-mode.mjs <baseUrl> <password> <package.h5p>` against a protected server, and `node test/escaping.mjs <baseUrl> <contentId>` against an open one.

## Integration Pattern

### Creating Content

```
1. Open popup/iframe to: http://localhost:3000/new?returnUrl=http://yourapp/callback
2. User creates content in H5P editor
3. User clicks Save
4. Server redirects to: http://yourapp/callback?contentId=abc123&title=My%20Quiz
5. Your app stores the contentId
```

### Playing Content

```
1. Embed iframe: http://localhost:3000/play/abc123?userId=user1&webhookUrl=http://yourapp/webhook
2. User interacts with content
3. On completion, server POSTs to your webhook:
   {
     "contentId": "abc123",
     "userId": "user1",
     "statement": { /* xAPI statement */ }
   }
4. Also sends postMessage to parent window (if embedded in iframe)
```

### xAPI Events

The player tracks these xAPI verbs:
- `completed` - User finished the content
- `answered` - User answered a question
- `passed` - User passed (score above threshold)
- `failed` - User failed (score below threshold)

Webhook payload example:

```json
{
  "contentId": "abc123",
  "userId": "demo-user",
  "statement": {
    "verb": { "id": "http://adlnet.gov/expapi/verbs/completed" },
    "result": {
      "score": { "raw": 8, "max": 10 },
      "completion": true
    }
  }
}
```

## Directory Structure

```
h5p-server/
├── src/
│   └── index.js          # Express server (~750 lines)
├── h5p/                   # H5P data directory
│   ├── core/             # H5P player core files
│   ├── editor/           # H5P editor core files
│   ├── libraries/        # Downloaded content type libraries
│   ├── content/          # Saved content
│   └── temp/             # Temporary upload files
├── package.json
├── Dockerfile
└── README.md
```

## License

GPL-3.0-or-later (due to @lumieducation/h5p-server dependency)

See the main project README for licensing details on the example applications.
