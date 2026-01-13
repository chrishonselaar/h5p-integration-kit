# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**H5P Integration Kit** - A comprehensive collection of examples for integrating H5P interactive content into applications without h5p.com, WordPress, or built-in LMS plugins.

### Components

1. **H5P Server** (port 3000) - Node.js server using `@lumieducation/h5p-server` v10.x
2. **Simple Examples** - Single-file integrations in Flask, FastAPI, PHP, .NET
3. **Django Example** - Full Django app with reusable `django_h5p` plugin
4. **LTI Provider** - LTI 1.3 tool provider for LMS integration

**Note**: We use **nvm (Node Version Manager)** for Node.js. Node.js v24.11.0 is installed via nvm at `/home/chris/.nvm/versions/node/v24.11.0/`.

## Project Structure

```
h5p-integration-kit/
├── h5p-server/                 # Shared Node.js H5P server
├── examples/
│   ├── python-flask/          # Single-file Flask example
│   ├── python-fastapi/        # Single-file FastAPI example
│   ├── php/                   # Single-file PHP example
│   ├── dotnet/                # Single-file .NET 8 example
│   ├── django/                # Full Django example
│   │   ├── django_h5p/       # Reusable plugin
│   │   ├── sample_lms/       # Demo LMS app
│   │   └── lms_project/      # Django settings
│   └── lti-provider/          # LTI 1.3 tool provider
└── docker-compose.yml
```

## Commands

### Start H5P Server

```bash
export PATH="/home/chris/.nvm/versions/node/v24.11.0/bin:$PATH"
cd h5p-server && npm start
```

### Run Examples

```bash
# Flask
cd examples/python-flask && pip install flask && python app.py

# FastAPI
cd examples/python-fastapi && pip install fastapi uvicorn aiosqlite && uvicorn app:app --port 5000

# PHP
cd examples/php && php -S localhost:5000

# .NET
cd examples/dotnet && dotnet run

# Django
cd examples/django && source .venv/bin/activate && python manage.py runserver

# LTI Provider
cd examples/lti-provider && pip install -r requirements.txt && python app.py
```

### Restarting Servers (Claude Code Workflow)

**IMPORTANT**: When restarting servers, ALWAYS use `run_in_background: true`. Server processes never terminate.

```bash
# Kill and restart H5P server
lsof -ti:3000 | xargs -r kill -9
cd h5p-server && export PATH="/home/chris/.nvm/versions/node/v24.11.0/bin:$PATH" && npm start
# (use run_in_background: true)
```

## Architecture

All examples follow the same pattern:

```
Your App (Flask/FastAPI/PHP/.NET/Django)
    │
    ├── /create           → opens popup to H5P /new
    ├── /callback         → receives contentId after save
    ├── /play/<id>        → embeds iframe to H5P /play/<id>
    └── /webhook          → receives xAPI scores
              │
              ▼
H5P Server (localhost:3000)
    ├── /new              → H5P editor for new content
    ├── /edit/:id         → H5P editor for existing content
    ├── /play/:id         → H5P player
    ├── /api/content      → content listing API
    └── /health           → health check
```

## H5P Server API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/new` | GET | Editor for new content |
| `/edit/{id}` | GET | Editor for existing content |
| `/play/{id}` | GET | Player for content |
| `/api/content` | GET | List all content |
| `/api/content/{id}` | DELETE | Delete content |
| `/health` | GET | Health check |

Query parameters:
- `returnUrl` - Callback URL after save (for /new, /edit)
- `userId` - User ID for tracking (for /play)

## Webhook Payload

All examples receive xAPI scores at their `/webhook` endpoint:

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

## Key Files by Example

### Flask (examples/python-flask/)
- `app.py` - Complete Flask application (~250 lines)

### FastAPI (examples/python-fastapi/)
- `app.py` - Complete FastAPI application (~250 lines)

### PHP (examples/php/)
- `index.php` - Complete PHP application (~300 lines)

### .NET (examples/dotnet/)
- `Program.cs` - Complete .NET 8 application (~300 lines)
- `H5PExample.csproj` - Project file

### Django (examples/django/)
- `django_h5p/models.py` - H5PContent, H5PGrade models
- `django_h5p/views.py` - xAPI webhook, player, editor views
- `sample_lms/views.py` - Activity CRUD views
- `sample_lms/models.py` - Course, Activity models

### LTI Provider (examples/lti-provider/)
- `app.py` - LTI 1.3 tool provider (~400 lines)
- `tool_config.json` - LMS configuration (create this)
- `private.key`, `public.key` - RSA keys (generate these)

## Access Points

- H5P Server: http://localhost:3000
- Flask Example: http://localhost:5000
- FastAPI Example: http://localhost:5000
- PHP Example: http://localhost:5000
- .NET Example: http://localhost:5000
- Django Example: http://localhost:8000
- LTI Provider: http://localhost:5001

## Environment Variables

### H5P Server
```bash
PORT=3000
H5P_BASE_URL=http://localhost:3000
H5P_DATA_PATH=/data/h5p
```

### Examples
Most examples use constants at the top of the file:
```python
H5P_SERVER = 'http://localhost:3000'
APP_URL = 'http://localhost:5000'
DATABASE = 'h5p_data.db'
```

## Testing Examples

Each example can be tested with the same flow:

1. Start H5P server: `cd h5p-server && npm start`
2. Start example: `python app.py` (or equivalent)
3. Open browser to example URL
4. Click "Create New Content"
5. Create H5P content in editor
6. Save - popup closes, content appears in list
7. Click "Play" to interact with content
8. Check "Grades" to see scores
