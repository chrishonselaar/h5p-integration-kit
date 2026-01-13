# H5P Integration - Django Example

A full-featured Django application demonstrating H5P integration with a reusable plugin, sample LMS, and grade tracking.

## Features

- **Reusable django_h5p Plugin**: Can be copied to any Django project
- **Sample LMS**: Courses with H5P activities
- **Grade Tracking**: Per-user score storage via xAPI
- **Template Tags**: Easy H5P embedding
- **GenericForeignKey**: Link H5P content to any model

## Quick Start

### Prerequisites

- Python 3.8+
- H5P server running at `http://localhost:3000`

### Installation

```bash
# From this directory
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install django

# Initialize database
python manage.py migrate

# Create admin user (optional)
python manage.py createsuperuser

# Run server
python manage.py runserver
```

### Usage

1. Open http://localhost:8000
2. Create a course
3. Add activities (opens H5P editor)
4. Play activities and view grades

## Project Structure

```
examples/django/
├── django_h5p/           # Reusable H5P plugin
│   ├── models.py        # H5PContent, H5PGrade
│   ├── views.py         # Webhook, player, editor
│   ├── urls.py          # URL routing
│   └── templatetags/    # h5p_tags for embedding
│
├── sample_lms/           # Demo LMS application
│   ├── models.py        # Course, Activity
│   ├── views.py         # CRUD views
│   └── templates/       # HTML templates
│
├── lms_project/          # Django settings
│   ├── settings.py      # Configuration
│   └── urls.py          # Root URL config
│
├── templates/            # Shared templates
├── static/               # Static files
├── manage.py            # Django CLI
└── requirements.txt     # Dependencies
```

## Using the django_h5p Plugin

### 1. Copy to Your Project

```bash
cp -r django_h5p /path/to/your/project/
```

### 2. Add to INSTALLED_APPS

```python
# settings.py
INSTALLED_APPS = [
    # ...
    'django.contrib.contenttypes',  # Required
    'django_h5p',
]

H5P_SERVER_URL = 'http://localhost:3000'
```

### 3. Include URLs

```python
# urls.py
urlpatterns = [
    path('h5p/', include('django_h5p.urls')),
]
```

### 4. Run Migrations

```bash
python manage.py migrate django_h5p
```

## Models

### H5PContent

```python
from django_h5p.models import H5PContent

# Create standalone content
content = H5PContent.objects.create(
    h5p_content_id='12345',
    title='My Quiz'
)

# Link to any model via GenericForeignKey
from django.contrib.contenttypes.models import ContentType

content = H5PContent.objects.create(
    h5p_content_id='12345',
    title='Lesson Quiz',
    content_type=ContentType.objects.get_for_model(YourModel),
    object_id=str(your_instance.pk)
)
```

### H5PGrade

```python
from django_h5p.models import H5PGrade

# Get grades for content
grades = content.grades.all()

# Get specific user's grade
grade = H5PGrade.objects.get(content=content, user_id='user123')
print(f"Score: {grade.score_percent}%")
```

## Template Tags

```django
{% load h5p_tags %}

<!-- Embed player -->
{% h5p_player_iframe content user_id=request.user.id height="500px" %}

<!-- Or use URL directly -->
<iframe src="{{ content.get_player_url }}" height="500" width="100%"></iframe>
```

## Webhook

The H5P server sends xAPI scores to `/h5p/results/`:

```json
{
  "contentId": "abc123",
  "userId": "user-1",
  "statement": {
    "verb": { "id": "http://adlnet.gov/expapi/verbs/completed" },
    "result": {
      "score": { "raw": 8, "max": 10 },
      "completion": true
    }
  }
}
```

## Configuration

```python
# settings.py
H5P_SERVER_URL = 'http://localhost:3000'
```

## License

The `django_h5p` plugin is MIT licensed - use it freely in any project.
