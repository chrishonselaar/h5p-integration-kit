# H5P Integration - PHP Example

A minimal single-file PHP script demonstrating H5P content creation, playback, and score tracking. No framework required - just vanilla PHP with PDO/SQLite.

## Features

- **Zero Dependencies**: Uses only PHP built-ins
- **Simple Routing**: Query parameter based (`?action=play&id=123`)
- **SQLite via PDO**: File-based database
- **Complete H5P Integration**: Create, edit, play, and track scores

## Quick Start

### Prerequisites

- PHP 7.4+ with PDO SQLite extension (usually built-in)
- H5P server running at `http://localhost:3000`

### Installation

```bash
# No installation needed! Just run the built-in server:
cd examples/php
php -S localhost:5000
```

### Usage

1. Open http://localhost:5000
2. Click "Create New Content" to open the H5P editor
3. Create your interactive content and save
4. Click "Play" to interact with the content
5. Check "Grades" to see recorded scores

## URL Routing

| URL | Description |
|-----|-------------|
| `/?action=home` (or just `/`) | Home page with content list |
| `/?action=create` | Opens H5P editor for new content |
| `/?action=callback&contentId=...` | Receives contentId from H5P editor |
| `/?action=play&id={h5p_id}` | Plays H5P content in iframe |
| `/?action=edit&id={h5p_id}` | Opens H5P editor for existing content |
| `/?action=grades&id={db_id}` | Shows grades for content |
| `/?action=webhook` (POST) | Receives xAPI scores from H5P server |

## Configuration

Edit the constants at the top of `index.php`:

```php
define('H5P_SERVER', 'http://localhost:3000');  // H5P server URL
define('APP_URL', 'http://localhost:5000');     // This app's URL
define('DATABASE', __DIR__ . '/h5p_data.db');  // SQLite database file
```

## Webhook Payload

The H5P server sends xAPI statements to `/?action=webhook` via POST:

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
      "completion": true
    }
  }
}
```

## Files

- `index.php` - Complete PHP application (~300 lines)
- `h5p_data.db` - SQLite database (created automatically)

## Code Structure

```php
// Configuration
define('H5P_SERVER', '...');

// Database (PDO/SQLite)
function getDb(): PDO { ... }

// Routing (simple switch on $_GET['action'])
switch ($action) {
    case 'home': showHome(); break;
    case 'play': showPlayer($id); break;
    // ...
}

// Route handlers
function showHome() { ... }
function showPlayer($id) { ... }
function handleWebhook() { ... }
```

## Production Deployment

### Apache (.htaccess)

```apache
RewriteEngine On
RewriteCond %{REQUEST_FILENAME} !-f
RewriteRule ^(.*)$ index.php [QSA,L]
```

### Nginx

```nginx
location / {
    try_files $uri /index.php$is_args$args;
}

location ~ \.php$ {
    fastcgi_pass php-fpm:9000;
    fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
    include fastcgi_params;
}
```

## Why PHP?

- Most common web language (WordPress, Moodle, etc.)
- Zero dependencies - works on any PHP hosting
- Easy to understand for beginners
- Quick to modify and extend
