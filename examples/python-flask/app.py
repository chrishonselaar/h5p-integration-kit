#!/usr/bin/env python3
"""
H5P Integration Example - Flask (Single File)
==============================================
A minimal Flask app demonstrating H5P content creation, playback, and scoring.

Requirements:
    pip install flask

Run:
    python app.py

Then open http://localhost:5000 in your browser.
Make sure the H5P server is running at http://localhost:3000
"""

import sqlite3
import json
from datetime import datetime
from flask import Flask, request, redirect, url_for, jsonify, g
from urllib.parse import urlencode

app = Flask(__name__)
app.secret_key = 'change-this-in-production'

# Configuration
H5P_SERVER = 'http://localhost:3000'
APP_URL = 'http://localhost:5000'
DATABASE = 'h5p_data.db'

# ============================================================================
# Database Setup
# ============================================================================

def get_db():
    """Get database connection for current request."""
    if 'db' not in g:
        g.db = sqlite3.connect(DATABASE)
        g.db.row_factory = sqlite3.Row
    return g.db

@app.teardown_appcontext
def close_db(exception):
    """Close database connection at end of request."""
    db = g.pop('db', None)
    if db is not None:
        db.close()

def init_db():
    """Initialize database tables."""
    db = get_db()
    db.execute('''
        CREATE TABLE IF NOT EXISTS h5p_content (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            h5p_id TEXT UNIQUE NOT NULL,
            title TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    db.execute('''
        CREATE TABLE IF NOT EXISTS h5p_grades (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content_id INTEGER REFERENCES h5p_content(id),
            user_id TEXT NOT NULL,
            score REAL,
            max_score REAL,
            completed BOOLEAN DEFAULT FALSE,
            xapi_verb TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    db.commit()

# ============================================================================
# Routes
# ============================================================================

@app.route('/')
def home():
    """Home page - list all H5P content with play/edit links."""
    db = get_db()
    content_list = db.execute('SELECT * FROM h5p_content ORDER BY created_at DESC').fetchall()

    html = '''
    <!DOCTYPE html>
    <html>
    <head>
        <title>H5P Integration - Flask Example</title>
        <style>
            body { font-family: system-ui, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; }
            h1 { color: #333; }
            .content-list { list-style: none; padding: 0; }
            .content-item { padding: 15px; margin: 10px 0; background: #f5f5f5; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; }
            .content-title { font-weight: bold; }
            .actions a { margin-left: 10px; padding: 8px 16px; background: #007bff; color: white; text-decoration: none; border-radius: 4px; }
            .actions a.edit { background: #6c757d; }
            .actions a.grades { background: #28a745; }
            .btn-create { display: inline-block; padding: 12px 24px; background: #28a745; color: white; text-decoration: none; border-radius: 4px; margin-bottom: 20px; }
            .empty { color: #666; font-style: italic; }
        </style>
    </head>
    <body>
        <h1>H5P Content Library</h1>
        <a href="/create" class="btn-create" onclick="openEditor(); return false;">+ Create New Content</a>

        <ul class="content-list">
    '''

    if content_list:
        for item in content_list:
            html += f'''
            <li class="content-item">
                <span class="content-title">{item['title'] or 'Untitled'}</span>
                <span class="actions">
                    <a href="/play/{item['h5p_id']}">Play</a>
                    <a href="/edit/{item['h5p_id']}" class="edit" onclick="openEditor('{item['h5p_id']}'); return false;">Edit</a>
                    <a href="/grades/{item['id']}" class="grades">Grades</a>
                </span>
            </li>
            '''
    else:
        html += '<li class="empty">No content yet. Create your first H5P activity!</li>'

    html += f'''
        </ul>

        <script>
            function openEditor(contentId) {{
                const returnUrl = encodeURIComponent('{APP_URL}/callback');
                const url = contentId
                    ? '{H5P_SERVER}/edit/' + contentId + '?returnUrl=' + returnUrl
                    : '{H5P_SERVER}/new?returnUrl=' + returnUrl;
                window.open(url, 'h5p-editor', 'width=1200,height=800');
            }}

            // Listen for popup close to refresh
            window.addEventListener('focus', function() {{
                // Small delay to allow callback to process
                setTimeout(function() {{ location.reload(); }}, 500);
            }});
        </script>
    </body>
    </html>
    '''
    return html

@app.route('/create')
def create():
    """Redirect to H5P editor for new content."""
    return_url = f'{APP_URL}/callback'
    return redirect(f'{H5P_SERVER}/new?returnUrl={return_url}')

@app.route('/callback')
def callback():
    """Callback from H5P editor after content is saved."""
    content_id = request.args.get('contentId')
    title = request.args.get('title', 'Untitled')

    if content_id:
        db = get_db()
        # Insert or update content
        db.execute('''
            INSERT INTO h5p_content (h5p_id, title) VALUES (?, ?)
            ON CONFLICT(h5p_id) DO UPDATE SET title = excluded.title
        ''', (content_id, title))
        db.commit()

    # Return HTML that closes popup and refreshes parent
    return '''
    <!DOCTYPE html>
    <html>
    <head><title>Saved</title></head>
    <body>
        <p>Content saved! This window will close...</p>
        <script>
            if (window.opener) {
                window.opener.location.reload();
            }
            window.close();
        </script>
    </body>
    </html>
    '''

@app.route('/play/<h5p_id>')
def play(h5p_id):
    """Play H5P content in an iframe."""
    user_id = request.args.get('user', 'demo-user')

    return f'''
    <!DOCTYPE html>
    <html>
    <head>
        <title>Play H5P Content</title>
        <style>
            body {{ font-family: system-ui, sans-serif; margin: 0; padding: 20px; }}
            h1 {{ color: #333; margin-bottom: 10px; }}
            .back {{ margin-bottom: 20px; display: inline-block; }}
            iframe {{ width: 100%; height: 600px; border: 1px solid #ddd; border-radius: 8px; }}
        </style>
    </head>
    <body>
        <a href="/" class="back">&larr; Back to Library</a>
        <h1>H5P Player</h1>
        <iframe src="{H5P_SERVER}/play/{h5p_id}?userId={user_id}"></iframe>
    </body>
    </html>
    '''

@app.route('/edit/<h5p_id>')
def edit(h5p_id):
    """Redirect to H5P editor for existing content."""
    return_url = f'{APP_URL}/callback'
    return redirect(f'{H5P_SERVER}/edit/{h5p_id}?returnUrl={return_url}')

@app.route('/grades/<int:content_db_id>')
def grades(content_db_id):
    """Show grades for a piece of content."""
    db = get_db()
    content = db.execute('SELECT * FROM h5p_content WHERE id = ?', (content_db_id,)).fetchone()
    grades_list = db.execute('''
        SELECT * FROM h5p_grades WHERE content_id = ? ORDER BY created_at DESC
    ''', (content_db_id,)).fetchall()

    html = f'''
    <!DOCTYPE html>
    <html>
    <head>
        <title>Grades - {content['title'] if content else 'Unknown'}</title>
        <style>
            body {{ font-family: system-ui, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; }}
            .back {{ margin-bottom: 20px; display: inline-block; }}
            table {{ width: 100%; border-collapse: collapse; }}
            th, td {{ padding: 12px; text-align: left; border-bottom: 1px solid #ddd; }}
            th {{ background: #f5f5f5; }}
            .empty {{ color: #666; font-style: italic; }}
        </style>
    </head>
    <body>
        <a href="/" class="back">&larr; Back to Library</a>
        <h1>Grades: {content['title'] if content else 'Unknown'}</h1>
    '''

    if grades_list:
        html += '''
        <table>
            <tr><th>User</th><th>Score</th><th>Verb</th><th>Date</th></tr>
        '''
        for grade in grades_list:
            score_pct = (grade['score'] / grade['max_score'] * 100) if grade['max_score'] else 0
            html += f'''
            <tr>
                <td>{grade['user_id']}</td>
                <td>{grade['score']:.1f}/{grade['max_score']:.1f} ({score_pct:.0f}%)</td>
                <td>{grade['xapi_verb'] or '-'}</td>
                <td>{grade['created_at']}</td>
            </tr>
            '''
        html += '</table>'
    else:
        html += '<p class="empty">No grades recorded yet.</p>'

    html += '</body></html>'
    return html

@app.route('/webhook', methods=['POST'])
def webhook():
    """
    Webhook endpoint to receive xAPI scores from H5P server.

    Expected payload:
    {
        "contentId": "123",
        "userId": "user-1",
        "statement": {
            "verb": { "id": "http://adlnet.gov/expapi/verbs/completed" },
            "result": {
                "score": { "raw": 8, "max": 10 },
                "completion": true
            }
        }
    }
    """
    data = request.get_json()
    if not data:
        return jsonify({'error': 'No data provided'}), 400

    content_id = data.get('contentId')
    user_id = data.get('userId', 'anonymous')
    statement = data.get('statement', {})

    # Extract score from xAPI statement
    result = statement.get('result', {})
    score_data = result.get('score', {})
    raw_score = score_data.get('raw', 0)
    max_score = score_data.get('max', 100)
    completed = result.get('completion', False)

    # Extract verb (completed, passed, answered, etc.)
    verb = statement.get('verb', {}).get('id', '').split('/')[-1]

    db = get_db()

    # Find content record
    content = db.execute('SELECT id FROM h5p_content WHERE h5p_id = ?', (content_id,)).fetchone()
    if not content:
        return jsonify({'error': 'Content not found'}), 404

    # Store grade
    db.execute('''
        INSERT INTO h5p_grades (content_id, user_id, score, max_score, completed, xapi_verb)
        VALUES (?, ?, ?, ?, ?, ?)
    ''', (content['id'], user_id, raw_score, max_score, completed, verb))
    db.commit()

    return jsonify({
        'status': 'saved',
        'contentId': content_id,
        'score': raw_score / max_score if max_score else 0
    })

# ============================================================================
# Main
# ============================================================================

if __name__ == '__main__':
    with app.app_context():
        init_db()
    print(f'''
    H5P Flask Example
    =================
    App running at: {APP_URL}
    H5P Server:     {H5P_SERVER}

    Make sure the H5P server is running!
    ''')
    app.run(port=5000, debug=True)
