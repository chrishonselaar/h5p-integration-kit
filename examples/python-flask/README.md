# H5P Integration - Flask Example

A minimal single-file Flask application demonstrating H5P content creation, playback, and score tracking.

## Features

- **Content Management**: Create and edit H5P content via popup editor
- **Content Playback**: Embedded iframe player
- **Score Tracking**: Webhook receives xAPI scores from H5P server
- **SQLite Storage**: Simple file-based database

## Quick Start

### Prerequisites

- Python 3.8+
- H5P server running at `http://localhost:3000`

### Installation

```bash
# From this directory
pip install flask

# Run the app
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
| `/play/<id>` | GET | Plays H5P content in iframe |
| `/edit/<id>` | GET | Opens H5P editor for existing content |
| `/grades/<id>` | GET | Shows grades for content |
| `/webhook` | POST | Receives xAPI scores from H5P server |

## How It Works

### Content Creation Flow

```
1. User clicks "Create New Content"
2. Popup opens to H5P Server: /new?returnUrl=http://localhost:5000/callback
3. User creates content in H5P editor
4. H5P server saves content, redirects to callback with contentId
5. Flask stores contentId in SQLite, popup closes
6. Parent page refreshes to show new content
```

### Score Tracking Flow

```
1. User plays content at /play/<id>
2. Iframe loads H5P player from H5P server
3. User completes activity
4. H5P server sends xAPI statement to /webhook
5. Flask extracts score and stores in SQLite
```

## Webhook Payload

The H5P server sends xAPI statements to `/webhook`:

```json
{
  "contentId": "abc123",
  "userId": "demo-user",
  "statement": {
    "verb": {
      "id": "http://adlnet.gov/expapi/verbs/completed"
    },
    "result": {
      "score": { "raw": 8, "max": 10 },
      "completion": true,
      "success": true
    }
  }
}
```

## Configuration

Edit the constants at the top of `app.py`:

```python
H5P_SERVER = 'http://localhost:3000'  # H5P server URL
APP_URL = 'http://localhost:5000'     # This app's URL
DATABASE = 'h5p_data.db'              # SQLite database file
```

## Database Schema

```sql
-- Content records
CREATE TABLE h5p_content (
    id INTEGER PRIMARY KEY,
    h5p_id TEXT UNIQUE NOT NULL,     -- ID from H5P server
    title TEXT,
    created_at TIMESTAMP
);

-- Grade records
CREATE TABLE h5p_grades (
    id INTEGER PRIMARY KEY,
    content_id INTEGER REFERENCES h5p_content(id),
    user_id TEXT NOT NULL,
    score REAL,
    max_score REAL,
    completed BOOLEAN,
    xapi_verb TEXT,                   -- e.g., "completed", "passed"
    created_at TIMESTAMP
);
```

## Files

- `app.py` - Complete Flask application (~250 lines)
- `h5p_data.db` - SQLite database (created automatically)

## Customization

### Add Authentication

Replace the hardcoded `demo-user` with your auth system:

```python
@app.route('/play/<h5p_id>')
def play(h5p_id):
    user_id = current_user.id  # From your auth system
    # ...
```

### Add HTTPS for Production

Use a reverse proxy (nginx) or gunicorn with SSL certificates.

### Persist H5P Content IDs

The `h5p_id` field stores the ID from the H5P server. You can link this to your own content models (courses, lessons, etc.).
