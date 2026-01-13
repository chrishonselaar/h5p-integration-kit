# H5P Django Integration

A complete solution for integrating [H5P](https://h5p.org) interactive content into Django applications.

This project provides:
- **H5P Server** (Docker): A containerized Node.js server for H5P content authoring and playback
- **Django Plugin** (`django-h5p`): A reusable Django app for seamless H5P integration

## Features

- Create and edit H5P interactive content (quizzes, presentations, videos, etc.)
- Embed H5P content in any Django model using GenericForeignKey
- Automatic grade/score collection via xAPI webhooks
- Popup-based editor to avoid cross-origin iframe issues
- Production-ready Docker deployment

## Quick Start

### 1. Start the H5P Server

```bash
# Using Docker Compose
docker-compose up -d

# Or build and run manually
cd h5p-server
docker build -t h5p-server .
docker run -p 3000:3000 -v h5p_data:/data/h5p h5p-server
```

### 2. Install the Django Plugin

```bash
# Copy django_h5p to your project or install via pip (when published)
pip install django-h5p  # Coming soon

# Or copy the django_h5p directory to your project
cp -r django_h5p /path/to/your/project/
```

### 3. Configure Django

```python
# settings.py
INSTALLED_APPS = [
    # ...
    'django.contrib.contenttypes',  # Required for GenericForeignKey
    'django_h5p',
]

H5P_SERVER_URL = 'http://localhost:3000'  # Your H5P server URL
```

```python
# urls.py
urlpatterns = [
    # ...
    path('h5p/', include('django_h5p.urls')),
]
```

### 4. Run Migrations

```bash
python manage.py migrate django_h5p
```

## Usage

### Creating H5P Content

```python
from django_h5p.models import H5PContent

# Create standalone H5P content
content = H5PContent.objects.create(
    h5p_content_id='12345',  # ID from H5P server
    title='My Interactive Quiz'
)

# Or link to any model in your project
from django.contrib.contenttypes.models import ContentType

content = H5PContent.objects.create(
    h5p_content_id='12345',
    title='Lesson Quiz',
    content_type=ContentType.objects.get_for_model(YourLessonModel),
    object_id=str(lesson.pk)
)
```

### Embedding in Templates

```django
{% load h5p_tags %}

<!-- Embed H5P player -->
{% h5p_player_iframe content user_id=request.user.id height="500px" %}

<!-- Or use the player URL directly -->
<iframe src="{{ content.get_player_url }}" height="500" width="100%"></iframe>
```

### Retrieving Grades

```python
from django_h5p.models import H5PGrade

# Get all grades for a content item
grades = content.grades.all()

# Get a specific user's grade
grade = H5PGrade.objects.get(content=content, user_id=str(user.id))
print(f"Score: {grade.score_percent}%")
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Your Django Project                       │
│  ┌─────────────────────────────────────────────────────┐    │
│  │                   django-h5p                         │    │
│  │  • H5PContent model (links to any model)            │    │
│  │  • H5PGrade model (stores scores)                   │    │
│  │  • Views (player, editor, webhook)                  │    │
│  │  • Template tags for embedding                      │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────┬───────────────────────────────────────┘
                      │ HTTP API
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                 H5P Server (Docker)                          │
│  • /play/:contentId  - Render H5P player                    │
│  • /edit/:contentId  - Render H5P editor                    │
│  • /new              - Create new content                    │
│  • xAPI webhook      - Send scores to Django                │
│                                                              │
│  Storage: /data/h5p (Docker volume)                         │
│  • /content   - H5P content packages                        │
│  • /libraries - H5P content type libraries                  │
└─────────────────────────────────────────────────────────────┘
```

## Configuration

### Environment Variables (H5P Server)

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `H5P_BASE_URL` | `http://localhost:3000` | Public URL of H5P server |
| `DJANGO_URL` | `http://localhost:8000` | Django server URL (for CORS) |
| `H5P_DATA_PATH` | `/data/h5p` | Path to H5P data directory |

### Django Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `H5P_SERVER_URL` | `http://localhost:3000` | URL to your H5P server |

## Development

### Running Locally (Without Docker)

```bash
# H5P Server
cd h5p-server
npm install
npm start

# Django
python manage.py runserver
```

### Running Tests

```bash
# Django tests
python manage.py test django_h5p

# H5P server (if tests are added)
cd h5p-server && npm test
```

## Licensing

This project uses a dual-license structure:

| Component | License | Why |
|-----------|---------|-----|
| **H5P Server** (`h5p-server/`) | GPL-3.0 | Uses [@lumieducation/h5p-server](https://github.com/Lumieducation/H5P-Nodejs-library) which is GPL-licensed |
| **Django Plugin** (`django_h5p/`) | MIT | Communicates via HTTP API only, no GPL code incorporated |

The HTTP API boundary between components means you can:
- Run the H5P server as a Docker container (GPL applies to server code)
- Use the Django plugin in proprietary projects (MIT allows this)

## Acknowledgments

This project stands on the shoulders of giants. We are deeply grateful to:

### Core Technologies

- **[H5P](https://h5p.org)** - The incredible open-source framework for creating interactive content. H5P has revolutionized how educational content is created and shared.

- **[Lumi Education / @lumieducation/h5p-server](https://github.com/Lumieducation/H5P-Nodejs-library)** - The excellent Node.js implementation of H5P that powers our server. Their work made this integration possible.

- **[Django](https://www.djangoproject.com)** - The web framework for perfectionists with deadlines. Django's robust ecosystem and community continue to inspire.

### Development

- **[Claude Code](https://claude.ai/code)** - This project was developed with significant assistance from Anthropic's Claude Code AI assistant. Claude helped with architecture decisions, code implementation, debugging, and documentation. We believe in transparency about AI-assisted development.

### Open Source Community

Special thanks to all contributors to the open-source projects we depend on:
- Node.js and npm ecosystem
- Express.js
- Python and pip ecosystem
- Docker

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Support

- **Issues**: [GitHub Issues](https://github.com/chrishonselaar/django-h5p/issues)
- **H5P Documentation**: [h5p.org/documentation](https://h5p.org/documentation)
- **Django Documentation**: [docs.djangoproject.com](https://docs.djangoproject.com)

---

Made with ❤️ for the education community
