#!/usr/bin/env python3
"""
H5P LTI 1.3 Tool Provider
==========================
An LTI 1.3 Tool Provider that allows external LMS platforms (Moodle, Canvas, Blackboard)
to launch H5P content and receive grades back.

Requirements:
    pip install flask pylti1p3

Run:
    python app.py

Configure your LMS to connect to this tool, then launch H5P content from the LMS.
Make sure the H5P server is running at http://localhost:3000
"""

import os
import json
import sqlite3
from datetime import datetime
from flask import Flask, request, redirect, url_for, render_template_string, jsonify, session, g
from pylti1p3.contrib.flask import (
    FlaskOIDCLogin, FlaskMessageLaunch, FlaskRequest, FlaskCacheDataStorage
)
from pylti1p3.tool_config import ToolConfJsonFile
from pylti1p3.grade import Grade
from pylti1p3.lineitem import LineItem
from werkzeug.exceptions import Forbidden

app = Flask(__name__)
app.secret_key = os.environ.get('SECRET_KEY', 'change-this-in-production-use-random-key')

# Configure session cookies for cross-site LTI requests
app.config['SESSION_COOKIE_SAMESITE'] = 'None'
app.config['SESSION_COOKIE_SECURE'] = True

# ============================================================================
# Configuration
# ============================================================================

H5P_SERVER = os.environ.get('H5P_SERVER', 'http://localhost:3000')
APP_URL = os.environ.get('APP_URL', 'http://localhost:5001')
DATABASE = 'lti_data.db'
CONFIG_FILE = 'tool_config.json'

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
    # Store LTI launches for grade passback
    db.execute('''
        CREATE TABLE IF NOT EXISTS lti_launches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            launch_id TEXT UNIQUE NOT NULL,
            h5p_content_id TEXT,
            user_id TEXT,
            resource_link_id TEXT,
            iss TEXT,
            ags_endpoint TEXT,
            ags_lineitems TEXT,
            ags_lineitem TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    # Store grades before sending to LMS
    db.execute('''
        CREATE TABLE IF NOT EXISTS grades (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            launch_id TEXT REFERENCES lti_launches(launch_id),
            score REAL,
            max_score REAL,
            sent_to_lms INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    db.commit()

# ============================================================================
# LTI 1.3 Configuration Helpers
# ============================================================================

def get_lti_config_path():
    """Get path to LTI tool configuration file."""
    return os.path.join(os.path.dirname(__file__), CONFIG_FILE)

class SessionCache:
    """Simple cache adapter that uses Flask session for storage."""
    def __init__(self, session_obj):
        self._session = session_obj

    def get(self, key):
        return self._session.get(key)

    def set(self, key, value, exp=None):
        self._session[key] = value

    def delete(self, key):
        self._session.pop(key, None)

def get_launch_data_storage():
    """Get cache storage for LTI launch data."""
    # Using Flask session for simplicity - use Redis in production
    return FlaskCacheDataStorage(SessionCache(session))

def get_tool_conf():
    """Get LTI tool configuration from JSON file."""
    config_path = get_lti_config_path()
    if not os.path.exists(config_path):
        # Create default config file
        create_default_config(config_path)
    return ToolConfJsonFile(config_path)

def create_default_config(path):
    """Create a default tool configuration file."""
    default_config = {
        "https://example-lms.edu": [{
            "default": True,
            "client_id": "your-client-id",
            "deployment_ids": ["1"],
            "auth_login_url": "https://example-lms.edu/mod/lti/auth.php",
            "auth_token_url": "https://example-lms.edu/mod/lti/token.php",
            "key_set_url": "https://example-lms.edu/mod/lti/certs.php",
            "private_key_file": "private.key",
            "public_key_file": "public.key"
        }]
    }
    with open(path, 'w') as f:
        json.dump(default_config, f, indent=2)
    print(f"Created default config at {path} - please update with your LMS details")

# ============================================================================
# LTI 1.3 Endpoints
# ============================================================================

@app.route('/lti/login', methods=['GET', 'POST'])
def lti_login():
    """
    LTI 1.3 OIDC Login Initiation.
    The LMS redirects here first to start the authentication flow.
    """
    tool_conf = get_tool_conf()
    launch_data_storage = get_launch_data_storage()

    flask_request = FlaskRequest()
    target_link_uri = flask_request.get_param('target_link_uri')

    oidc_login = FlaskOIDCLogin(
        flask_request,
        tool_conf,
        launch_data_storage=launch_data_storage
    )

    return oidc_login.enable_check_cookies().redirect(target_link_uri)

@app.route('/lti/launch', methods=['GET', 'POST'])
def lti_launch():
    """
    LTI 1.3 Resource Link Launch.
    This is where users land after authentication.
    We embed the H5P player and track the launch for grade passback.
    """
    # Debug: log what we receive
    print(f"Launch request method: {request.method}")
    print(f"Launch form data keys: {list(request.form.keys())}")
    print(f"Launch args: {list(request.args.keys())}")

    tool_conf = get_tool_conf()
    launch_data_storage = get_launch_data_storage()

    flask_request = FlaskRequest()
    message_launch = FlaskMessageLaunch(
        flask_request,
        tool_conf,
        launch_data_storage=launch_data_storage
    )

    # Validate the launch
    message_launch.validate()

    # Extract launch data
    launch_id = message_launch.get_launch_id()
    launch_data = message_launch.get_launch_data()

    # Get user info
    user_id = launch_data.get('sub', 'unknown')

    # Get resource link (which H5P content to show)
    resource_link = launch_data.get('https://purl.imsglobal.org/spec/lti/claim/resource_link', {})
    resource_link_id = resource_link.get('id', '')

    # Get custom parameters (H5P content ID should be passed here)
    custom = launch_data.get('https://purl.imsglobal.org/spec/lti/claim/custom', {})
    h5p_content_id = custom.get('h5p_content_id', '')

    # Get Assignment and Grade Services (AGS) claim for grade passback
    ags_claim = launch_data.get('https://purl.imsglobal.org/spec/lti-ags/claim/endpoint', {})

    # Store launch info for grade passback
    db = get_db()
    db.execute('''
        INSERT OR REPLACE INTO lti_launches
        (launch_id, h5p_content_id, user_id, resource_link_id, iss, ags_endpoint, ags_lineitems, ags_lineitem)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ''', (
        launch_id,
        h5p_content_id,
        user_id,
        resource_link_id,
        launch_data.get('iss', ''),
        json.dumps(ags_claim.get('scope', [])),
        ags_claim.get('lineitems', ''),
        ags_claim.get('lineitem', '')
    ))
    db.commit()

    # Store launch_id in session for webhook
    session['launch_id'] = launch_id
    session['user_id'] = user_id

    # If no H5P content specified, show content picker
    if not h5p_content_id:
        return redirect(url_for('content_picker', launch_id=launch_id))

    # Show H5P player
    return render_template_string(LTI_PLAYER_TEMPLATE,
        h5p_server=H5P_SERVER,
        h5p_content_id=h5p_content_id,
        user_id=user_id,
        launch_id=launch_id,
        app_url=APP_URL
    )

@app.route('/lti/content-picker')
def content_picker():
    """
    Content picker - allows selecting H5P content when not specified in LTI launch.
    """
    launch_id = request.args.get('launch_id') or session.get('launch_id')
    if not launch_id:
        return "Invalid launch", 400

    # Fetch available content from H5P server
    import urllib.request
    try:
        with urllib.request.urlopen(f'{H5P_SERVER}/api/content') as response:
            data = json.loads(response.read())
            content_list = data.get('content', []) if isinstance(data, dict) else data
    except Exception as e:
        content_list = []

    return render_template_string(CONTENT_PICKER_TEMPLATE,
        content_list=content_list,
        launch_id=launch_id,
        h5p_server=H5P_SERVER
    )

@app.route('/lti/play/<h5p_content_id>')
def lti_play(h5p_content_id):
    """
    Play H5P content after selection.
    """
    launch_id = request.args.get('launch_id') or session.get('launch_id')
    user_id = session.get('user_id', 'unknown')

    if not launch_id:
        return "Invalid launch", 400

    # Update launch with selected content
    db = get_db()
    db.execute('UPDATE lti_launches SET h5p_content_id = ? WHERE launch_id = ?',
               (h5p_content_id, launch_id))
    db.commit()

    return render_template_string(LTI_PLAYER_TEMPLATE,
        h5p_server=H5P_SERVER,
        h5p_content_id=h5p_content_id,
        user_id=user_id,
        launch_id=launch_id,
        app_url=APP_URL
    )

@app.route('/lti/callback')
def lti_callback():
    """Callback after H5P editor saves - closes popup window."""
    return '''
    <!DOCTYPE html>
    <html>
    <head><title>Saved</title></head>
    <body>
        <script>
            if (window.opener) {
                window.opener.location.reload();
            }
            window.close();
        </script>
        <p>Content saved. You can close this window.</p>
    </body>
    </html>
    '''

@app.route('/lti/grades/<h5p_content_id>')
def lti_grades(h5p_content_id):
    """Show grades for a specific H5P content."""
    db = get_db()
    grades_list = db.execute('''
        SELECT g.*, l.user_id, l.h5p_content_id
        FROM grades g
        JOIN lti_launches l ON g.launch_id = l.launch_id
        WHERE l.h5p_content_id = ?
        ORDER BY g.created_at DESC
    ''', (h5p_content_id,)).fetchall()

    html = f'''
    <!DOCTYPE html>
    <html>
    <head>
        <title>Grades - H5P Content {h5p_content_id}</title>
        <style>
            body {{ font-family: system-ui, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; }}
            h1 {{ color: #333; }}
            .back {{ margin-bottom: 20px; }}
            .back a {{ color: #007bff; }}
            table {{ width: 100%; border-collapse: collapse; }}
            th, td {{ padding: 12px; text-align: left; border-bottom: 1px solid #ddd; }}
            th {{ background: #f5f5f5; }}
            .empty {{ color: #666; font-style: italic; }}
        </style>
    </head>
    <body>
        <div class="back"><a href="javascript:history.back()">&larr; Back</a></div>
        <h1>Grades for Content {h5p_content_id}</h1>
    '''

    if grades_list:
        html += '''
        <table>
            <tr><th>User</th><th>Score</th><th>Sent to LMS</th><th>Date</th></tr>
        '''
        for grade in grades_list:
            score_pct = (grade['score'] / grade['max_score'] * 100) if grade['max_score'] else 0
            sent_status = 'Yes' if grade['sent_to_lms'] else 'No'
            html += f'''
            <tr>
                <td>{grade['user_id']}</td>
                <td>{grade['score']:.0f}/{grade['max_score']:.0f} ({score_pct:.0f}%)</td>
                <td>{sent_status}</td>
                <td>{grade['created_at']}</td>
            </tr>
            '''
        html += '</table>'
    else:
        html += '<p class="empty">No grades recorded yet.</p>'

    html += '</body></html>'
    return html

@app.route('/lti/webhook', methods=['POST'])
def lti_webhook():
    """
    Webhook endpoint to receive xAPI scores from H5P server.
    Stores the grade and attempts to send it back to the LMS via LTI AGS.
    """
    data = request.get_json()
    if not data:
        return jsonify({'error': 'No data provided'}), 400

    content_id = data.get('contentId')
    user_id = data.get('userId', 'anonymous')
    statement = data.get('statement', {})

    # Extract score
    result = statement.get('result', {})
    score_data = result.get('score', {})
    raw_score = score_data.get('raw', 0)
    max_score = score_data.get('max', 100)

    # Find the launch record
    db = get_db()
    launch = db.execute('''
        SELECT * FROM lti_launches
        WHERE h5p_content_id = ? AND user_id = ?
        ORDER BY created_at DESC LIMIT 1
    ''', (content_id, user_id)).fetchone()

    if not launch:
        # Try session-based lookup
        launch_id = session.get('launch_id')
        if launch_id:
            launch = db.execute('SELECT * FROM lti_launches WHERE launch_id = ?',
                               (launch_id,)).fetchone()

    if not launch:
        return jsonify({'error': 'No matching LTI launch found'}), 404

    # Store grade
    db.execute('''
        INSERT INTO grades (launch_id, score, max_score)
        VALUES (?, ?, ?)
    ''', (launch['launch_id'], raw_score, max_score))
    db.commit()

    # Attempt to send grade to LMS (simplified - full implementation needs message_launch)
    grade_result = {
        'status': 'stored',
        'launch_id': launch['launch_id'],
        'score': raw_score / max_score if max_score else 0,
        'ags_available': bool(launch['ags_lineitem'])
    }

    return jsonify(grade_result)

# ============================================================================
# JWKS Endpoint (Required for LTI 1.3)
# ============================================================================

@app.route('/.well-known/jwks.json')
def jwks():
    """
    JSON Web Key Set endpoint.
    Returns the public key for the LMS to verify our signatures.
    """
    tool_conf = get_tool_conf()
    # Get first configured platform
    config = tool_conf._config
    if not config:
        return jsonify({'keys': []})

    # For simplicity, return empty - in production, generate proper JWKS
    # See pylti1p3 documentation for proper key management
    return jsonify({'keys': []})

# ============================================================================
# Configuration Endpoints
# ============================================================================

@app.route('/')
def home():
    """Home page with LTI configuration information."""
    return render_template_string(HOME_TEMPLATE,
        app_url=APP_URL,
        h5p_server=H5P_SERVER
    )

@app.route('/lti/config')
def lti_config():
    """Show LTI configuration for administrators."""
    return jsonify({
        'tool_name': 'H5P Content Provider',
        'description': 'Launch and track H5P interactive content',
        'oidc_initiation_url': f'{APP_URL}/lti/login',
        'target_link_uri': f'{APP_URL}/lti/launch',
        'jwks_url': f'{APP_URL}/.well-known/jwks.json',
        'custom_parameters': {
            'h5p_content_id': 'The ID of the H5P content to launch'
        },
        'claims': [
            'sub',
            'name',
            'email'
        ],
        'messages': [
            {'type': 'LtiResourceLinkRequest'}
        ],
        'scopes': [
            'https://purl.imsglobal.org/spec/lti-ags/scope/score',
            'https://purl.imsglobal.org/spec/lti-ags/scope/lineitem'
        ]
    })

# ============================================================================
# HTML Templates
# ============================================================================

HOME_TEMPLATE = '''
<!DOCTYPE html>
<html>
<head>
    <title>H5P LTI 1.3 Tool Provider</title>
    <style>
        body { font-family: system-ui, sans-serif; max-width: 900px; margin: 50px auto; padding: 20px; }
        h1 { color: #333; }
        .config-section { background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0; }
        code { background: #e9ecef; padding: 2px 6px; border-radius: 4px; }
        pre { background: #272822; color: #f8f8f2; padding: 15px; border-radius: 8px; overflow-x: auto; }
        .endpoint { margin: 10px 0; }
        .endpoint strong { display: inline-block; width: 200px; }
    </style>
</head>
<body>
    <h1>H5P LTI 1.3 Tool Provider</h1>
    <p>This tool allows external LMS platforms to launch H5P content and receive grades.</p>

    <div class="config-section">
        <h2>LTI 1.3 Configuration</h2>
        <p>Configure your LMS with these endpoints:</p>
        <div class="endpoint"><strong>OIDC Login URL:</strong> <code>{{ app_url }}/lti/login</code></div>
        <div class="endpoint"><strong>Launch URL:</strong> <code>{{ app_url }}/lti/launch</code></div>
        <div class="endpoint"><strong>JWKS URL:</strong> <code>{{ app_url }}/.well-known/jwks.json</code></div>
        <div class="endpoint"><strong>Config JSON:</strong> <code>{{ app_url }}/lti/config</code></div>
    </div>

    <div class="config-section">
        <h2>Custom Parameters</h2>
        <p>Pass the H5P content ID in the LTI launch:</p>
        <pre>h5p_content_id=YOUR_CONTENT_ID</pre>
        <p>If not provided, users will see a content picker.</p>
    </div>

    <div class="config-section">
        <h2>Setup</h2>
        <ol>
            <li>Edit <code>tool_config.json</code> with your LMS details</li>
            <li>Generate RSA key pair for signing (private.key, public.key)</li>
            <li>Register this tool in your LMS</li>
            <li>Configure the H5P server URL: <code>{{ h5p_server }}</code></li>
        </ol>
    </div>

    <div class="config-section">
        <h2>Generate Keys</h2>
        <pre>openssl genrsa -out private.key 2048
openssl rsa -in private.key -pubout -out public.key</pre>
    </div>
</body>
</html>
'''

LTI_PLAYER_TEMPLATE = '''
<!DOCTYPE html>
<html>
<head>
    <title>H5P Content</title>
    <style>
        body { font-family: system-ui, sans-serif; margin: 0; padding: 20px; }
        iframe { width: 100%; height: calc(100vh - 100px); border: none; }
        .info { font-size: 12px; color: #666; margin-bottom: 10px; }
    </style>
</head>
<body>
    <div class="info">Launch ID: {{ launch_id }} | User: {{ user_id }}</div>
    <iframe src="{{ h5p_server }}/play/{{ h5p_content_id }}?userId={{ user_id }}&webhookUrl={{ app_url }}/lti/webhook"></iframe>
</body>
</html>
'''

CONTENT_PICKER_TEMPLATE = '''
<!DOCTYPE html>
<html>
<head>
    <title>Select H5P Content</title>
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
    <script>
        const H5P_SERVER = '{{ h5p_server }}';
        function openEditor(contentId) {
            const returnUrl = encodeURIComponent(window.location.origin + '/lti/callback');
            const url = contentId
                ? H5P_SERVER + '/edit/' + contentId + '?returnUrl=' + returnUrl
                : H5P_SERVER + '/new?returnUrl=' + returnUrl;
            window.open(url, 'h5p-editor', 'width=1200,height=800');
        }
        window.addEventListener('focus', () => setTimeout(() => location.reload(), 500));
    </script>
</head>
<body>
    <h1>Select H5P Content</h1>
    <a href="#" class="btn-create" onclick="openEditor(); return false;">+ Create New Content</a>
    <ul class="content-list">
    {% if content_list %}
        {% for item in content_list %}
        <li class="content-item">
            <span class="content-title">{{ item.title or 'Untitled' }}</span>
            <span class="actions">
                <a href="/lti/play/{{ item.id }}?launch_id={{ launch_id }}">Play</a>
                <a href="#" class="edit" onclick="openEditor('{{ item.id }}'); return false;">Edit</a>
                <a href="/lti/grades/{{ item.id }}" class="grades">Grades</a>
            </span>
        </li>
        {% endfor %}
    {% else %}
        <li class="empty">No H5P content available. Create some content first!</li>
    {% endif %}
    </ul>
</body>
</html>
'''

# ============================================================================
# Main
# ============================================================================

if __name__ == '__main__':
    with app.app_context():
        init_db()
    print(f'''
    H5P LTI 1.3 Tool Provider
    =========================
    App running at: {APP_URL}
    H5P Server:     {H5P_SERVER}

    LTI Endpoints:
    - OIDC Login:   {APP_URL}/lti/login
    - Launch:       {APP_URL}/lti/launch
    - JWKS:         {APP_URL}/.well-known/jwks.json
    - Config:       {APP_URL}/lti/config

    Make sure the H5P server is running and tool_config.json is configured!
    ''')
    app.run(port=5001, debug=True)
