# H5P Integration - FastAPI Example

A minimal single-file FastAPI application demonstrating H5P content creation, playback, and score tracking with async/await and Pydantic validation.

## Features

- **Async/Await**: Non-blocking database operations with aiosqlite
- **Pydantic Models**: Type-safe request validation for webhooks
- **Content Management**: Create and edit H5P content via popup editor
- **Content Playback**: Embedded iframe player
- **Score Tracking**: Webhook receives xAPI scores from H5P server

## Quick Start

### Prerequisites

- Python 3.8+
- H5P server running at `http://localhost:3000`

### Installation

```bash
# From this directory
pip install fastapi uvicorn aiosqlite

# Run the app
uvicorn app:app --reload --port 5000

# Or directly
python app.py
```

### Usage

1. Open http://localhost:5000
2. Click "Create New Content" to open the H5P editor
3. Create your interactive content and save
4. Click "Play" to interact with the content
5. Check "Grades" to see recorded scores

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Home page with content list |
| `/create` | GET | Opens H5P editor for new content |
| `/callback` | GET | Receives contentId from H5P editor |
| `/play/{id}` | GET | Plays H5P content in iframe |
| `/edit/{id}` | GET | Opens H5P editor for existing content |
| `/grades/{id}` | GET | Shows grades for content |
| `/webhook` | POST | Receives xAPI scores from H5P server |
| `/docs` | GET | Auto-generated OpenAPI documentation |

## Webhook Payload (Pydantic Model)

```python
class WebhookPayload(BaseModel):
    contentId: str
    userId: str = "anonymous"
    statement: Optional[XAPIStatement] = None

class XAPIStatement(BaseModel):
    verb: Optional[XAPIVerb] = None
    result: Optional[XAPIResult] = None

class XAPIResult(BaseModel):
    score: Optional[XAPIScore] = None
    completion: bool = False
    success: bool = False

class XAPIScore(BaseModel):
    raw: float = 0
    max: float = 100
```

## Why FastAPI over Flask?

| Feature | Flask | FastAPI |
|---------|-------|---------|
| Async support | Manual | Native |
| Type validation | Manual | Pydantic |
| API docs | Manual | Auto-generated |
| Performance | Good | Better (ASGI) |

Both examples work identically; choose based on your preferences.

## Configuration

Edit the constants at the top of `app.py`:

```python
H5P_SERVER = 'http://localhost:3000'  # H5P server URL
APP_URL = 'http://localhost:5000'     # This app's URL
DATABASE = 'h5p_data.db'              # SQLite database file
```

## Files

- `app.py` - Complete FastAPI application (~250 lines)
- `h5p_data.db` - SQLite database (created automatically)

## Production Deployment

```bash
# Install production server
pip install gunicorn

# Run with multiple workers
gunicorn app:app -w 4 -k uvicorn.workers.UvicornWorker -b 0.0.0.0:5000
```
