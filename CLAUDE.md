# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This demonstrates H5P interactive content integration with Django using direct integration (no LTI). It consists of two components:

1. **Django LMS** (port 8000) - Course management, activity tracking, grade storage
2. **H5P Server** (port 3000) - Modern Node.js server using `@lumieducation/h5p-server` v10.x

**Note**: We use **nvm (Node Version Manager)** for Node.js, NOT Docker. Node.js v24.11.0 is installed via nvm at `/home/chris/.nvm/versions/node/v24.11.0/`.

## Commands

### Initial Setup
```bash
chmod +x setup.sh && ./setup.sh
```

### Development
```bash
# Start H5P server
# Note: Uses nvm for Node.js - PATH must include /home/chris/.nvm/versions/node/v24.11.0/bin
export PATH="/home/chris/.nvm/versions/node/v24.11.0/bin:$PATH"
cd h5p-server && npm start

# Start Django
source .venv/bin/activate
python manage.py runserver
```

### Django Management
```bash
python manage.py migrate
python manage.py makemigrations
python manage.py createsuperuser
```

### Restarting Servers (Claude Code Workflow)
**IMPORTANT**: When restarting the H5P server or any long-running process, ALWAYS use `run_in_background: true` in the Bash tool. Server processes never terminate, so blocking on them causes indefinite hangs.

```bash
# Correct approach - restart and move on immediately
lsof -ti:3000 | xargs -r kill -9
cd h5p-server && export PATH="/home/chris/.nvm/versions/node/v24.11.0/bin:$PATH" && npm start
# (use run_in_background: true)
```

Never wait for server output - the process runs indefinitely. Use background execution and check logs if needed via `/tmp/claude/.../tasks/{id}.output`.

## Architecture

```
Django (localhost:8000)
    │
    ├── /activity/{id}/launch/ → embeds iframe to H5P player
    ├── /activity/{id}/edit/   → embeds iframe to H5P editor
    └── /h5p/results/          → webhook receiving xAPI scores
              │
              ▼
H5P Server (localhost:3000)
    ├── /play/:contentId       → renders H5P player
    ├── /edit/:contentId       → renders H5P editor
    ├── /new                   → renders editor for new content
    ├── /api/content           → content listing API
    └── /api/save              → content save API
```

### Flow: Content Creation
1. User clicks "Add Activity" in Django
2. Django renders page with iframe pointing to H5P `/new`
3. User creates content in H5P editor
4. H5P server saves content, redirects to Django callback with contentId
5. Django creates H5PActivity record with the contentId

### Flow: Content Playback
1. User clicks "Play" on activity
2. Django renders page with iframe pointing to H5P `/play/:contentId`
3. User interacts with H5P content
4. H5P player sends xAPI events to H5P server
5. H5P server forwards results to Django `/h5p/results/` webhook
6. Django stores grade in H5PGrade model

## Key Files

### Django
- `lti_consumer/views.py` - All view functions (activity CRUD, H5P webhooks)
- `lti_consumer/models.py` - Course, H5PActivity, H5PGrade models
- `lti_consumer/urls.py` - URL routing
- `lms_project/settings.py` - `H5P_SERVER_URL` config

### H5P Server (Node.js)
- `h5p-server/src/index.js` - Express app with all H5P endpoints
- `h5p-server/package.json` - Uses `@lumieducation/h5p-server` v10.x

### Templates
- `templates/lti_consumer/activity_launch.html` - Player iframe
- `templates/lti_consumer/activity_add.html` - Editor iframe for new content
- `templates/lti_consumer/activity_edit.html` - Editor iframe for existing content

## Important Implementation Details

### Score Webhook
The H5P server sends xAPI statements to `/h5p/results/` when users complete activities:
```json
{
  "contentId": "abc123",
  "userId": "demo-user",
  "statement": { /* xAPI statement */ }
}
```

Django extracts score from `statement.result.score` and stores in H5PGrade.

### User Identification
Demo uses session-based user IDs (`get_user_id()` in views.py). For production, integrate with Django auth.

### H5P Content Storage
H5P server stores content in `h5p-server/h5p/content/`. When using Docker, this is a named volume.

## Environment Variables

```bash
H5P_SERVER_URL=http://localhost:3000
DJANGO_SECRET_KEY=<secret>
DJANGO_DEBUG=True
DJANGO_ALLOWED_HOSTS=localhost,127.0.0.1
```

## Access Points
- Django UI: http://localhost:8000
- Django Admin: http://localhost:8000/admin (admin/admin)
- H5P Server: http://localhost:3000
- H5P Health: http://localhost:3000/health
