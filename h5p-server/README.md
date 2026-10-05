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
| `H5P_EXTRA_SUBCONTENT` | *(unset)* | Path to a JSON file that lets containers accept extra content types, e.g. `{"H5P.Column": ["H5P.DeepZoomPage 0.1"], "H5P.QuestionSet": ["H5P.DeepZoomQuestion 0.1"]}`. H5P.Column, H5P.QuestionSet and similar containers only allow the sub-content types listed in their `semantics.json`; the editor removes any other type on save. Unset means stock behaviour |

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
