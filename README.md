# H5P Integration Kit

A comprehensive collection of examples for integrating H5P interactive content into your applications **without** h5p.com, WordPress, Moodle plugins, or Canvas.

## What is H5P?

[H5P](https://h5p.org) is an open-source framework for creating interactive content: quizzes, presentations, videos, games, and more. Traditionally, H5P requires platforms like WordPress, Moodle, or paid h5p.com hosting.

**This project shows you how to self-host H5P** and integrate it with any application using simple HTTP APIs.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Your Application                      │
│    (Flask, FastAPI, PHP, .NET, Django, or any stack)    │
│                                                          │
│  1. Create content → iframe to H5P /new                 │
│  2. Play content   → iframe to H5P /play/{id}           │
│  3. Receive scores → webhook from H5P server            │
└──────────────────────────┬──────────────────────────────┘
                           │ HTTP API
                           ▼
┌─────────────────────────────────────────────────────────┐
│                    H5P Server (Node.js)                  │
│                                                          │
│  - Creates and edits H5P content                        │
│  - Renders H5P player                                   │
│  - Sends xAPI scores via webhook                        │
│  - Stores content in filesystem                         │
└─────────────────────────────────────────────────────────┘
```

## Quick Start

### 1. Start the H5P Server

```bash
cd h5p-server
npm install
npm start
# Server running at http://localhost:3000
```

### 2. Pick an Example

| Example | Language | Best For |
|---------|----------|----------|
| [python-flask](examples/python-flask/) | Python | Simple integration, beginners |
| [python-fastapi](examples/python-fastapi/) | Python | Modern async applications |
| [php](examples/php/) | PHP | WordPress-like environments |
| [dotnet](examples/dotnet/) | C# | Enterprise .NET applications |
| [django](examples/django/) | Python | Full-featured Django apps |
| [lti-provider](examples/lti-provider/) | Python | LMS integration (Moodle, Canvas) |

### 3. Run the Example

```bash
# Flask example
cd examples/python-flask
pip install flask
python app.py

# Open http://localhost:5000
```

## Integration Pattern

All examples follow the same simple pattern:

### Content Creation

```
1. Your app opens popup/iframe to: H5P_SERVER/new?returnUrl=YOUR_CALLBACK
2. User creates content in H5P editor
3. H5P server saves and redirects to: YOUR_CALLBACK?contentId=123
4. Your app stores the contentId in your database
```

### Content Playback

```
1. Your app embeds iframe: H5P_SERVER/play/{contentId}?userId={userId}
2. User interacts with H5P content
3. H5P server sends score to your webhook endpoint
4. Your app stores the grade
```

### Webhook Payload

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

## Examples Overview

### Simple Examples (~150-300 lines each)

| Example | Description | Run Command |
|---------|-------------|-------------|
| **Flask** | Minimal Python web app | `python app.py` |
| **FastAPI** | Async Python with Pydantic | `uvicorn app:app` |
| **PHP** | No-framework PHP | `php -S localhost:5000` |
| **.NET** | ASP.NET Core minimal API | `dotnet run` |

Each simple example demonstrates:
- Content listing, creation, editing
- H5P player embedding
- Score webhook handling
- SQLite storage

### Full Django Example

The [Django example](examples/django/) includes:
- Reusable `django_h5p` plugin
- Sample LMS with courses and activities
- Grade tracking per user
- Template tags for easy embedding

### LTI 1.3 Tool Provider

The [LTI provider](examples/lti-provider/) allows external LMS platforms to:
- Launch H5P content via LTI 1.3
- Return grades to LMS gradebook
- Works with Moodle, Canvas, Blackboard, etc.

## H5P Server API

The Node.js H5P server exposes these endpoints:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/new` | GET | H5P editor for new content |
| `/edit/{id}` | GET | H5P editor for existing content |
| `/play/{id}` | GET | H5P player |
| `/api/content` | GET | List all content |
| `/api/content/{id}` | GET | Get content metadata |
| `/api/content/{id}` | DELETE | Delete content |
| `/health` | GET | Health check |

Query parameters:
- `returnUrl` - Where to redirect after save (for /new, /edit)
- `userId` - User identifier for tracking (for /play)

## Project Structure

```
h5p-integration-kit/
├── h5p-server/                 # Node.js H5P server (shared)
│   ├── src/index.js           # Express app
│   ├── package.json
│   └── Dockerfile
│
├── examples/
│   ├── python-flask/          # ~150 lines Flask app
│   ├── python-fastapi/        # ~200 lines FastAPI app
│   ├── php/                   # ~300 lines vanilla PHP
│   ├── dotnet/                # ~300 lines .NET 8 app
│   ├── django/                # Full Django example
│   │   ├── django_h5p/       # Reusable plugin
│   │   └── sample_lms/       # Demo LMS
│   └── lti-provider/          # LTI 1.3 tool provider
│
├── docker-compose.yml         # Run H5P server with Docker
├── README.md                  # This file
└── LICENSE                    # MIT License
```

## Why Self-Host H5P?

| Feature | h5p.com | WordPress Plugin | This Project |
|---------|---------|------------------|--------------|
| Free to use | Limited | Yes | Yes |
| No vendor lock-in | No | Partial | Yes |
| Custom integration | API only | PHP hooks | Any language |
| Own your data | No | Yes | Yes |
| LTI support | Paid | Plugin | Included |
| Docker support | No | No | Yes |

## Requirements

- **H5P Server**: Node.js 18+ (uses @lumieducation/h5p-server)
- **Examples**: See individual README files

## Docker Support

```bash
# Start H5P server with Docker
docker-compose up -d h5p-server

# Or build and run everything
docker-compose up
```

## Licensing

This project uses a dual-license structure:

| Component | License | Why |
|-----------|---------|-----|
| **H5P Server** (`h5p-server/`) | GPL-3.0 | Uses [@lumieducation/h5p-server](https://github.com/Lumieducation/H5P-Nodejs-library) which is GPL-licensed |
| **Examples** (`examples/`) | MIT | Communicate via HTTP API only, no GPL code incorporated |

The HTTP API boundary between components means you can:
- Run the H5P server as a Docker container (GPL applies to server code)
- Use the examples in proprietary projects (MIT allows this)

## Acknowledgments

This project stands on the shoulders of giants:

- **[H5P](https://h5p.org)** - The incredible open-source framework for creating interactive content
- **[Lumi Education](https://github.com/Lumieducation/H5P-Nodejs-library)** - The excellent Node.js implementation of H5P
- **[Claude Code](https://claude.ai/code)** - AI-assisted development

## Contributing

Contributions welcome! Areas of interest:
- Additional language examples (Ruby, Go, Java)
- LTI 1.1 support
- Deep linking implementation
- More H5P content type examples

## Related Projects

- [@lumieducation/h5p-server](https://github.com/Lumieducation/H5P-Nodejs-library) - The H5P Node.js library we use
- [tunapanda/h5p-standalone](https://github.com/tunapanda/h5p-standalone) - H5P player only (no editor)
- [h5p/h5p-php-library](https://github.com/h5p/h5p-php-library) - Official H5P PHP library

## Support

- [H5P Documentation](https://h5p.org/documentation)
- [H5P Forum](https://h5p.org/forum)

---

Made with care for the education community
