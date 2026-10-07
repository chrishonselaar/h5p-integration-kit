#!/usr/bin/env python3
"""
H5P LTI 1.3 Tool
================
Lets an LMS (Moodle, Canvas, Brightspace, ...) use H5P content from the kit's H5P server,
with nothing installed in the LMS but its standard "External tool" (LTI 1.3).

- Dynamic Registration: an LMS admin pastes one URL (/lti/register) and the LMS is connected
- Deep Linking: a teacher adding an activity picks or creates H5P content in the tool
- Launch: students play the content; the score goes to the LMS gradebook (AGS)
- Tenants: every connected LMS (platform) sees and edits only its own content

Run:
    pip install -r requirements.txt
    python app.py

Settings (environment variables, see README.md): APP_URL, H5P_SERVER, H5P_TOOL_SECRET,
H5P_API_TOKEN, DATABASE_URL, SECRET_KEY, LTI_REGISTRATION_KEY, LTI_KEY_DIR, HOST, PORT.
"""

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from datetime import datetime, timezone
from urllib.parse import urlencode, urlparse

import click
import requests
from flask import Flask, abort, jsonify, redirect, render_template, request, session, url_for
from pylti1p3.assignments_grades import AssignmentsGradesService
from pylti1p3.contrib.flask import FlaskCacheDataStorage, FlaskMessageLaunch, FlaskOIDCLogin, FlaskRequest
from pylti1p3.deep_link_resource import DeepLinkResource
from pylti1p3.deployment import Deployment
from pylti1p3.grade import Grade
from pylti1p3.lineitem import LineItem
from pylti1p3.registration import Registration
from pylti1p3.service_connector import ServiceConnector
from pylti1p3.tool_config.abstract import ToolConfAbstract

import store

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

APP_URL = os.environ.get('APP_URL', 'http://localhost:5001').rstrip('/')
# The H5P server as the browser sees it (player iframe, editor window)
H5P_SERVER = os.environ.get('H5P_SERVER', 'http://localhost:3000').rstrip('/')
# Shared with the H5P server (its H5P_TOOL_SECRET). Without it the editor links are unsigned,
# which only works with an H5P server that is not in protected mode (development).
H5P_TOOL_SECRET = os.environ.get('H5P_TOOL_SECRET', '')
# The H5P server's admin password, for server-to-server calls (assign-content command)
H5P_API_TOKEN = os.environ.get('H5P_API_TOKEN', '')
# When set, Dynamic Registration needs ?key=<this> in the registration URL
LTI_REGISTRATION_KEY = os.environ.get('LTI_REGISTRATION_KEY', '')

app = Flask(__name__)
app.secret_key = os.environ.get('SECRET_KEY') or 'change-this-in-production-use-random-key'
# The LMS shows the tool in an iframe on another site, so the session cookie must be sent
# cross-site: SameSite=None, which browsers only accept with Secure (https, or localhost).
app.config.update(SESSION_COOKIE_SAMESITE='None', SESSION_COOKIE_SECURE=True, SESSION_COOKIE_HTTPONLY=True)

AGS_SCORE = 'https://purl.imsglobal.org/spec/lti-ags/scope/score'
AGS_LINEITEM = 'https://purl.imsglobal.org/spec/lti-ags/scope/lineitem'
AGS_RESULT = 'https://purl.imsglobal.org/spec/lti-ags/scope/result.readonly'
CLAIM = 'https://purl.imsglobal.org/spec/lti/claim/'

# ============================================================================
# Keys: one RSA key pair for all platforms (created on first start)
# ============================================================================

KEY_DIR = os.environ.get('LTI_KEY_DIR', BASE_DIR)
PRIVATE_KEY_FILE = os.path.join(KEY_DIR, 'private.key')
PUBLIC_KEY_FILE = os.path.join(KEY_DIR, 'public.key')


def ensure_keys():
    if os.path.exists(PRIVATE_KEY_FILE):
        return
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    with open(PRIVATE_KEY_FILE, 'wb') as f:
        f.write(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL,
                                  serialization.NoEncryption()))
    os.chmod(PRIVATE_KEY_FILE, 0o600)
    with open(PUBLIC_KEY_FILE, 'wb') as f:
        f.write(key.public_key().public_bytes(serialization.Encoding.PEM,
                                              serialization.PublicFormat.SubjectPublicKeyInfo))
    print('Created a new key pair: private.key, public.key')


def read_key(path):
    with open(path) as f:
        return f.read()


# ============================================================================
# Platforms (connected LMSes) from the database
# ============================================================================

class ToolConfDb(ToolConfAbstract):
    """pylti1p3 tool configuration backed by the platforms table."""

    def check_iss_has_one_client(self, iss):
        return False

    def check_iss_has_many_clients(self, iss):
        return True

    def _registration(self, platform):
        if not platform:
            return None
        reg = Registration()
        reg.set_issuer(platform['issuer']).set_client_id(platform['client_id']) \
            .set_auth_login_url(platform['auth_login_url']).set_auth_token_url(platform['auth_token_url']) \
            .set_key_set_url(platform['key_set_url']).set_tool_private_key(read_key(PRIVATE_KEY_FILE)) \
            .set_tool_public_key(read_key(PUBLIC_KEY_FILE))
        if platform['auth_audience']:
            reg.set_auth_audience(platform['auth_audience'])
        return reg

    def find_registration_by_issuer(self, iss, *args, **kwargs):
        return self._registration(store.find_platform(iss))

    def find_registration_by_params(self, iss, client_id, *args, **kwargs):
        return self._registration(store.find_platform(iss, client_id))

    def find_deployment(self, iss, deployment_id):
        return self._deployment(store.find_platform(iss), deployment_id)

    def find_deployment_by_params(self, iss, deployment_id, client_id, *args, **kwargs):
        return self._deployment(store.find_platform(iss, client_id), deployment_id)

    @staticmethod
    def _deployment(platform, deployment_id):
        if not platform or deployment_id not in json.loads(platform['deployment_ids']):
            return None
        return Deployment().set_deployment_id(deployment_id)


tool_conf = ToolConfDb()


def launch_storage():
    return FlaskCacheDataStorage(store.DbCache())


def import_tool_config_json():
    """Platforms from the older tool_config.json (e.g. the Saltire test platform) go into the database."""
    path = os.path.join(BASE_DIR, 'tool_config.json')
    if not os.path.exists(path):
        return
    with open(path) as f:
        config = json.load(f)
    for issuer, entries in config.items():
        for entry in entries if isinstance(entries, list) else [entries]:
            store.save_platform(issuer, entry['client_id'], entry['auth_login_url'], entry['auth_token_url'],
                                entry['key_set_url'], entry.get('deployment_ids', []),
                                auth_audience=entry.get('auth_audience'))


# ============================================================================
# Helpers
# ============================================================================

def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode()


def sign(*parts):
    """HMAC with the Flask secret: CSRF tokens for forms and the score endpoint."""
    return hmac.new(app.secret_key.encode(), '|'.join(parts).encode(), hashlib.sha256).hexdigest()


def tool_signature(message):
    """HMAC with the secret shared with the H5P server."""
    return b64url(hmac.new(H5P_TOOL_SECRET.encode(), message.encode(), hashlib.sha256).digest())


def current_launch(launch_id, instructor=False):
    """The launch this browser session started; with instructor=True only for teachers."""
    if not launch_id or launch_id not in session.get('launches', []):
        abort(403, 'This page only works from an activity in your LMS. Open the activity again.')
    launch = store.get_launch(launch_id)
    if not launch:
        abort(403, 'Launch not found. Open the activity again.')
    if instructor and not launch['is_instructor']:
        abort(403, 'Only teachers can do this.')
    return launch


def may_use_content(content_id, platform_id):
    """Content belongs to this platform, or to no platform yet (added by the H5P server admin)."""
    owner = store.content_owner(content_id)
    return owner is None or owner == platform_id


def h5p_origin():
    parsed = urlparse(H5P_SERVER)
    return f'{parsed.scheme}://{parsed.netloc}'


@app.context_processor
def template_globals():
    return {'h5p_server': H5P_SERVER, 'h5p_origin': h5p_origin(), 'app_url': APP_URL}


@app.errorhandler(403)
def forbidden(error):
    return render_template('message.html', title='Not allowed', message=error.description), 403


# ============================================================================
# LTI 1.3: login, launch, keys
# ============================================================================

@app.route('/lti/login', methods=['GET', 'POST'])
def lti_login():
    """OIDC login initiation: the LMS sends the browser here first."""
    flask_request = FlaskRequest()
    target_link_uri = flask_request.get_param('target_link_uri')
    oidc_login = FlaskOIDCLogin(flask_request, tool_conf, launch_data_storage=launch_storage())
    return oidc_login.enable_check_cookies().redirect(target_link_uri)


@app.route('/lti/launch', methods=['POST'])
def lti_launch():
    """The LMS posts the signed launch (id_token) here after the login."""
    message_launch = FlaskMessageLaunch(FlaskRequest(), tool_conf, launch_data_storage=launch_storage())
    data = message_launch.get_launch_data()   # validates the id_token
    launch_id = message_launch.get_launch_id()

    aud = data.get('aud')
    client_id = data.get('azp') or (aud[0] if isinstance(aud, list) else aud)
    platform = store.find_platform(data['iss'], client_id)
    is_instructor = message_launch.check_teacher_access() or message_launch.check_staff_access()
    custom = data.get(CLAIM + 'custom', {}) or {}
    content_id = str(custom.get('h5p_content_id', '')).strip()
    ags_claim = data.get('https://purl.imsglobal.org/spec/lti-ags/claim/endpoint')

    store.save_launch(
        launch_id=launch_id,
        platform_id=platform['id'],
        deployment_id=data.get(CLAIM + 'deployment_id'),
        user_id=data['sub'],
        resource_link_id=(data.get(CLAIM + 'resource_link') or {}).get('id'),
        h5p_content_id=content_id or None,
        is_instructor=int(is_instructor),
        ags_claim=json.dumps(ags_claim) if ags_claim else None,
    )
    session['launches'] = (session.get('launches', []) + [launch_id])[-20:]

    if message_launch.is_deep_link_launch():
        return redirect(url_for('picker', launch=launch_id))
    if not content_id:
        if is_instructor:
            return redirect(url_for('picker', launch=launch_id))
        return render_template('message.html', title='Not ready yet',
                               message='Your teacher has not chosen the H5P content for this activity yet.')
    if not may_use_content(content_id, platform['id']):
        abort(403, 'This content belongs to another organisation.')
    return render_player(launch_id, content_id)


def render_player(launch_id, content_id):
    return render_template('player.html', launch_id=launch_id, content_id=content_id,
                           csrf=sign('score', launch_id))


@app.route('/.well-known/jwks.json')
def jwks():
    """Public key the LMS uses to check the tool's signatures (grade requests, deep link responses)."""
    return jsonify({'keys': [Registration.get_jwk(read_key(PUBLIC_KEY_FILE))]})


# ============================================================================
# Teachers: pick or create content (Deep Linking, or a launch without content)
# ============================================================================

@app.route('/lti/picker')
def picker():
    launch = current_launch(request.args.get('launch'), instructor=True)
    message_launch = FlaskMessageLaunch.from_cache(launch['launch_id'], FlaskRequest(), tool_conf,
                                                   launch_data_storage=launch_storage())
    return render_template('picker.html', launch_id=launch['launch_id'],
                           deep_link=message_launch.is_deep_link_launch(),
                           contents=store.platform_contents(launch['platform_id']),
                           new_id=request.args.get('new'),
                           csrf=sign('picker', launch['launch_id']))


@app.route('/lti/deep-link', methods=['POST'])
def deep_link_select():
    """Send the chosen content back to the LMS, which creates the activity with it."""
    launch = current_launch(request.form.get('launch'), instructor=True)
    if not hmac.compare_digest(request.form.get('csrf', ''), sign('picker', launch['launch_id'])):
        abort(403, 'The form expired. Reload the page.')
    content_id = request.form['content_id']
    owned = {c['content_id']: c for c in store.platform_contents(launch['platform_id'])}
    if content_id not in owned:
        abort(403, 'This content does not belong to your organisation.')
    title = owned[content_id]['title'] or 'H5P'

    message_launch = FlaskMessageLaunch.from_cache(launch['launch_id'], FlaskRequest(), tool_conf,
                                                   launch_data_storage=launch_storage())
    if not message_launch.is_deep_link_launch():
        abort(400, 'This launch was not a content selection.')
    resource = DeepLinkResource() \
        .set_url(f'{APP_URL}/lti/launch') \
        .set_title(title) \
        .set_custom_params({'h5p_content_id': content_id}) \
        .set_lineitem(LineItem().set_score_maximum(100).set_label(title).set_tag('h5p'))
    return message_launch.get_deep_link().output_response_form([resource])


@app.route('/lti/preview/<content_id>')
def preview(content_id):
    """A teacher plays content before choosing it (scores are not sent)."""
    launch = current_launch(request.args.get('launch'), instructor=True)
    if not may_use_content(content_id, launch['platform_id']):
        abort(403, 'This content belongs to another organisation.')
    return render_template('player.html', launch_id=launch['launch_id'], content_id=content_id,
                           csrf='', preview=True)


@app.route('/lti/editor')
def open_editor():
    """Open the H5P editor (new content, or content of this platform) with a signed, short-lived ticket."""
    launch = current_launch(request.args.get('launch'), instructor=True)
    content_id = request.args.get('content')
    if content_id and store.content_owner(content_id) != launch['platform_id']:
        abort(403, 'You can only edit content of your own organisation.')

    jti = secrets.token_urlsafe(16)
    store.DbCache().set(f'ticket:{jti}', {'launch_id': launch['launch_id'], 'content_id': content_id}, 7200)
    return_url = f'{APP_URL}/lti/editor/done?' + urlencode({'launch': launch['launch_id'], 'ticket': jti})
    if not H5P_TOOL_SECRET:
        target = f'/edit/{content_id}' if content_id else '/new'
        return redirect(f'{H5P_SERVER}{target}?' + urlencode({'returnUrl': return_url}))

    payload = b64url(json.dumps({
        'scope': 'edit' if content_id else 'new', 'contentId': content_id, 'sub': launch['user_id'],
        'returnUrl': return_url, 'jti': jti, 'exp': int(time.time()) + 300,
    }, separators=(',', ':')).encode())
    ticket = f'{payload}.{tool_signature("h5p-editor-ticket." + payload)}'
    return redirect(f'{H5P_SERVER}/editor/start?' + urlencode({'ticket': ticket}))


@app.route('/lti/editor/done')
def editor_done():
    """The H5P server sends the editor window here after saving: record that this platform owns the content."""
    launch = current_launch(request.args.get('launch'), instructor=True)
    jti = request.args.get('ticket', '')
    ticket = store.DbCache().get(f'ticket:{jti}')
    content_id = request.args.get('contentId', '')
    title = request.args.get('title') or 'Untitled'
    if not ticket or ticket['launch_id'] != launch['launch_id']:
        abort(403, 'The editor link expired. Open the editor again.')
    if not content_id:   # cancelled
        return render_template('editor_done.html', content_id='')
    if H5P_TOOL_SECRET and not hmac.compare_digest(
            request.args.get('sig', ''), tool_signature(f'h5p-editor-saved.{jti}.{content_id}')):
        abort(403, 'The H5P server did not confirm this save.')
    if ticket['content_id'] and ticket['content_id'] != content_id:
        abort(403, 'Saved content does not match the ticket.')
    if not store.claim_content(content_id, launch['platform_id'], title, launch['user_id']):
        abort(403, 'This content belongs to another organisation.')
    return render_template('editor_done.html', content_id=content_id)


# ============================================================================
# Scores: the player page posts the H5P result here; the tool sends it to the LMS
# ============================================================================

@app.route('/lti/score', methods=['POST'])
def lti_score():
    data = request.get_json(silent=True) or {}
    launch = current_launch(data.get('launch_id'))
    if not hmac.compare_digest(request.headers.get('X-CSRF-Token', ''), sign('score', launch['launch_id'])):
        abort(403, 'Bad token')
    if data.get('contentId') != launch['h5p_content_id']:
        return jsonify({'status': 'ignored', 'reason': 'other content'})

    statement = data.get('statement') or {}
    # Questions inside a container (Question Set, Course Presentation...) send their own
    # statements; only the statement about the whole content is the grade.
    if (statement.get('context') or {}).get('contextActivities', {}).get('parent'):
        return jsonify({'status': 'ignored', 'reason': 'sub-content statement'})
    score = (statement.get('result') or {}).get('score') or {}
    try:
        raw, maximum = float(score['raw']), float(score['max'])
    except (KeyError, TypeError, ValueError):
        return jsonify({'status': 'ignored', 'reason': 'no score'})
    if maximum <= 0 or not 0 <= raw <= maximum:
        return jsonify({'status': 'ignored', 'reason': 'score out of range'}), 400

    grade_id = store.add_grade(launch['launch_id'], raw, maximum)
    result = {'status': 'stored', 'score': raw / maximum, 'sent_to_lms': False}
    try:
        result['sent_to_lms'] = send_grade_to_lms(launch, raw, maximum)
        store.mark_grade(grade_id, result['sent_to_lms'])
    except Exception as e:   # keep the grade; `flask --app app retry-grades` sends it later
        app.logger.warning('AGS grade passback failed for launch %s: %s', launch['launch_id'], e)
        store.mark_grade(grade_id, False, str(e))
        result['error'] = 'The LMS did not accept the grade; it will be retried.'
    return jsonify(result)


def send_grade_to_lms(launch, raw_score, max_score):
    """
    Send a score to the LMS gradebook with LTI Assignment and Grade Services (AGS).
    Returns False when the launch has no AGS endpoint (e.g. the activity takes no grades).
    """
    ags_claim = json.loads(launch['ags_claim']) if launch['ags_claim'] else None
    if not ags_claim or AGS_SCORE not in ags_claim.get('scope', []):
        return False
    platform = store.get_platform(launch['platform_id'])
    registration = tool_conf.find_registration_by_params(platform['issuer'], platform['client_id'])
    ags = AssignmentsGradesService(ServiceConnector(registration), ags_claim)

    grade = Grade()
    grade.set_score_given(raw_score) \
        .set_score_maximum(max_score) \
        .set_timestamp(datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S+00:00')) \
        .set_activity_progress('Completed') \
        .set_grading_progress('FullyGraded') \
        .set_user_id(launch['user_id'])

    # The LMS sends the activity's own line item when the activity takes grades; otherwise
    # find or create one for this resource link.
    lineitem = None
    if not ags_claim.get('lineitem'):
        lineitem = LineItem().set_tag('h5p').set_score_maximum(100).set_label('H5P') \
            .set_resource_link_id(launch['resource_link_id'])
    ags.put_grade(grade, lineitem)
    return True


# ============================================================================
# LTI Dynamic Registration: the LMS admin pastes APP_URL/lti/register
# ============================================================================

@app.route('/lti/register')
def lti_register():
    """
    LTI Dynamic Registration (Moodle 4.1+, Canvas, Brightspace...). The LMS opens this URL with
    openid_configuration and registration_token; the tool registers itself and the LMS gets a
    client_id. Moodle then lists the tool as pending until the admin activates it.
    """
    if LTI_REGISTRATION_KEY and not hmac.compare_digest(request.args.get('key', ''), LTI_REGISTRATION_KEY):
        abort(403, 'This registration link is not valid. Ask the tool provider for a new one.')
    config_url = request.args.get('openid_configuration', '')
    token = request.args.get('registration_token', '')
    if not config_url.startswith(('https://', 'http://')):
        return render_template('message.html', title='Registration URL',
                               message=f'Give this URL to your LMS as the tool registration URL: {APP_URL}/lti/register')

    platform_config = requests.get(config_url, timeout=15).json()
    issuer = platform_config['issuer']
    # The configuration must come from the issuer itself (LTI Dynamic Registration, section 3.5.1)
    if not config_url.startswith(issuer.rstrip('/') + '/') and config_url != issuer:
        abort(400, 'The platform configuration does not match its issuer.')

    tool_registration = {
        'application_type': 'web',
        'response_types': ['id_token'],
        'grant_types': ['implicit', 'client_credentials'],
        'initiate_login_uri': f'{APP_URL}/lti/login',
        'redirect_uris': [f'{APP_URL}/lti/launch'],
        'client_name': 'H5P',
        'jwks_uri': f'{APP_URL}/.well-known/jwks.json',
        'token_endpoint_auth_method': 'private_key_jwt',
        'scope': ' '.join([AGS_SCORE, AGS_LINEITEM, AGS_RESULT]),
        'https://purl.imsglobal.org/spec/lti-tool-configuration': {
            'domain': urlparse(APP_URL).netloc,
            'target_link_uri': f'{APP_URL}/lti/launch',
            'description': 'Interactive H5P content, hosted outside the LMS',
            # Only the LMS's own pseudonymous user id: the tool needs no names or e-mail addresses
            'claims': ['iss', 'sub'],
            'messages': [
                {'type': 'LtiResourceLinkRequest', 'target_link_uri': f'{APP_URL}/lti/launch'},
                {'type': 'LtiDeepLinkingRequest', 'target_link_uri': f'{APP_URL}/lti/launch',
                 'label': 'H5P', 'placements': ['ContentArea']},
            ],
        },
    }
    headers = {'Authorization': f'Bearer {token}'} if token else {}
    response = requests.post(platform_config['registration_endpoint'], json=tool_registration,
                             headers=headers, timeout=15)
    if response.status_code >= 400:
        app.logger.warning('Registration refused by %s: %s', issuer, response.text[:500])
        return render_template('message.html', title='Registration failed',
                               message=f'The LMS refused the registration ({response.status_code}).'), 502
    registered = response.json()
    tool_config = registered.get('https://purl.imsglobal.org/spec/lti-tool-configuration', {})
    deployment_id = tool_config.get('deployment_id')
    store.save_platform(
        issuer, registered['client_id'],
        auth_login_url=platform_config['authorization_endpoint'],
        auth_token_url=platform_config['token_endpoint'],
        key_set_url=platform_config['jwks_uri'],
        deployment_ids=[deployment_id] if deployment_id else [],
        name=(platform_config.get('https://purl.imsglobal.org/spec/lti-platform-configuration') or {})
        .get('product_family_code'),
        auth_audience=platform_config.get('authorization_server'),
    )
    return render_template('registered.html', issuer=issuer)


# ============================================================================
# Information pages
# ============================================================================

@app.route('/')
def home():
    return render_template('home.html', registration_url=f'{APP_URL}/lti/register',
                           needs_key=bool(LTI_REGISTRATION_KEY))


@app.route('/lti/config')
def lti_config():
    """Values for registering the tool by hand (when the LMS has no Dynamic Registration)."""
    return jsonify({
        'tool_name': 'H5P',
        'registration_url': f'{APP_URL}/lti/register',
        'oidc_initiation_url': f'{APP_URL}/lti/login',
        'target_link_uri': f'{APP_URL}/lti/launch',
        'redirect_uris': [f'{APP_URL}/lti/launch'],
        'jwks_url': f'{APP_URL}/.well-known/jwks.json',
        'deep_linking_url': f'{APP_URL}/lti/launch',
        'custom_parameters': {'h5p_content_id': 'The H5P content to launch (set by Deep Linking)'},
        'scopes': [AGS_SCORE, AGS_LINEITEM, AGS_RESULT],
    })


@app.route('/health')
def health():
    return jsonify({'status': 'ok'})


# ============================================================================
# Command line (flask --app app <command>)
# ============================================================================

@app.cli.command('list-platforms')
def list_platforms_command():
    """Show the connected LMSes."""
    for p in store.list_platforms():
        click.echo(f"{p['id']}: {p['issuer']}  client_id={p['client_id']}  deployments={p['deployment_ids']}")


@app.cli.command('add-platform')
@click.option('--issuer', required=True)
@click.option('--client-id', required=True)
@click.option('--deployment-id', required=True, multiple=True)
@click.option('--auth-login-url', required=True)
@click.option('--auth-token-url', required=True)
@click.option('--key-set-url', required=True)
def add_platform_command(issuer, client_id, deployment_id, auth_login_url, auth_token_url, key_set_url):
    """Connect an LMS by hand (when it has no Dynamic Registration)."""
    platform_id = store.save_platform(issuer, client_id, auth_login_url, auth_token_url, key_set_url, deployment_id)
    click.echo(f'Platform {platform_id} saved.')


@app.cli.command('assign-content')
@click.argument('content_id')
@click.argument('platform_id', type=int)
def assign_content_command(content_id, platform_id):
    """Give existing H5P content (e.g. imported by the admin) to a platform."""
    headers = {'Authorization': f'Bearer {H5P_API_TOKEN}'} if H5P_API_TOKEN else {}
    response = requests.get(f'{H5P_SERVER}/api/content/{content_id}', headers=headers, timeout=15)
    response.raise_for_status()
    if not store.claim_content(content_id, platform_id, response.json().get('title'), 'admin'):
        raise click.ClickException('That content belongs to another platform.')
    click.echo(f'Content {content_id} now belongs to platform {platform_id}.')


@app.cli.command('purge')
@click.option('--days', default=400, show_default=True, help='Keep launches and scores this many days.')
def purge_command(days):
    """Delete launches and scores older than --days (data retention)."""
    launches_deleted, scores_deleted = store.purge_older_than(days)
    click.echo(f'Deleted {launches_deleted} launches and {scores_deleted} scores older than {days} days.')


@app.cli.command('retry-grades')
def retry_grades_command():
    """Send grades the LMS did not accept earlier."""
    for row in store.unsent_grades():
        try:
            sent = send_grade_to_lms(row, row['score'], row['max_score'])
            store.mark_grade(row['id'], sent)
            click.echo(f"grade {row['id']}: {'sent' if sent else 'no grade service'}")
        except Exception as e:
            store.mark_grade(row['id'], False, str(e))
            click.echo(f"grade {row['id']}: failed: {e}")


ensure_keys()
store.init_db()
import_tool_config_json()
# With gunicorn --preload this ran before the workers fork; each worker opens its own connections
store.engine.dispose()

if __name__ == '__main__':
    print(f'''
    H5P LTI 1.3 Tool at {APP_URL}  (H5P server: {H5P_SERVER})
    Registration URL for the LMS admin: {APP_URL}/lti/register
    Database: {store.engine.url.render_as_string(hide_password=True)}
    ''')
    app.run(host=os.environ.get('HOST', '127.0.0.1'), port=int(os.environ.get('PORT', 5001)),
            debug=os.environ.get('FLASK_DEBUG') == '1')
