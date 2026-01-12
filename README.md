# H5P Demo - Django + Modern H5P Server

A demonstration of H5P interactive content integration with Django using direct integration (no LTI overhead).

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                 Local Development Machine                    │
│                                                              │
│   ┌──────────────────────────────────────────────────────┐  │
│   │              Django LMS (your app)                    │  │
│   │              python manage.py runserver               │  │
│   │                  localhost:8000                       │  │
│   └──────────────────────┬───────────────────────────────┘  │
│                          │                                   │
│                          │ iframe / API calls                │
│                          ▼                                   │
│   ┌──────────────────────────────────────────────────────┐  │
│   │         H5P Server (@lumieducation/h5p-server)       │  │
│   │              npm start (or Docker)                    │  │
│   │                  localhost:3000                       │  │
│   └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## Quick Start

```bash
# 1. Run setup
chmod +x setup.sh
./setup.sh

# 2. Start H5P server (choose one)
cd h5p-server && npm start     # Option A: Local Node.js
# OR
docker compose up -d           # Option B: Docker

# 3. Start Django (in another terminal)
source .venv/bin/activate
python manage.py runserver
```

Open http://localhost:8000

## Features

- **Course Management**: Create courses and add H5P activities
- **H5P Editor**: Create/edit interactive content directly in the browser
- **H5P Player**: Play H5P content with full interactivity
- **Score Tracking**: Receive and store xAPI results from H5P content
- **Modern H5P**: Uses `@lumieducation/h5p-server` v10.x with all content types

## Configuration

Edit `.env` to customize:

```bash
H5P_SERVER_URL=http://localhost:3000
```

## Development

```bash
# View H5P server logs (if using Docker)
docker compose logs -f h5p-server

# Django admin
http://localhost:8000/admin
Username: admin
Password: admin

# Reset database
rm db.sqlite3
python manage.py migrate
```

## How It Works

1. **Content Creation**: Django embeds H5P editor in an iframe → H5P server handles editing → saves content and returns ID to Django
2. **Content Playback**: Django embeds H5P player in an iframe → user interacts with content
3. **Score Tracking**: H5P player sends xAPI events → H5P server forwards to Django webhook → Django stores grades

## Project Structure

```
h5p-lti-provider/
├── h5p-server/              # Modern H5P server (Node.js)
│   ├── src/index.js         # Express server with H5P
│   ├── package.json
│   └── Dockerfile
├── lms_project/             # Django project config
├── lti_consumer/            # Django app
│   ├── models.py            # Course, H5PActivity, H5PGrade
│   ├── views.py             # Direct H5P integration views
│   └── urls.py
├── templates/               # Django templates
├── docker-compose.yml       # Docker setup for H5P server
├── setup.sh                 # Automated setup script
└── requirements.txt         # Python dependencies
```

## Why Direct Integration (Not LTI)?

- **Simpler**: No OAuth signatures, XML parsing, or protocol complexity
- **Faster**: Direct iframe embedding vs. form POST redirects
- **More Control**: Full access to H5P server code and APIs
- **Modern**: Uses latest H5P library with all 50+ content types

LTI is useful when integrating with third-party LMS platforms. For custom applications where you control both sides, direct integration is simpler and more flexible.

## Based On

- [@lumieducation/h5p-server](https://github.com/Lumieducation/H5P-Nodejs-library) - Modern H5P Node.js library
