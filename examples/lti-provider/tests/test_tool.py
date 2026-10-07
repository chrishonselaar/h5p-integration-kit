"""
Tool checks without an LMS: tenant isolation, teacher-only pages, editor tickets, scores.

    pip install pytest
    pytest tests                                                     # SQLite (temporary file)
    DATABASE_URL=postgresql+psycopg://user:pw@localhost/db pytest tests   # PostgreSQL

Two platforms (LMSes) each get a teacher launch and a student launch; the launches are put in the
test client's session as if the LMS had launched them.
"""

import base64
import hashlib
import hmac
import json
import os
import sys
import tempfile
from urllib.parse import parse_qs, urlparse

import pytest

if 'DATABASE_URL' not in os.environ:
    os.environ['DATABASE_URL'] = 'sqlite:///' + os.path.join(tempfile.mkdtemp(), 'test.db')
os.environ['H5P_TOOL_SECRET'] = 'test-secret'
os.environ['SECRET_KEY'] = 'test-key'
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import app as tool  # noqa: E402
import store  # noqa: E402

DEEP_LINK = {'https://purl.imsglobal.org/spec/lti/claim/message_type': 'LtiDeepLinkingRequest',
             'https://purl.imsglobal.org/spec/lti-dl/claim/deep_linking_settings': {
                 'deep_link_return_url': 'https://lms.example/return'}}


@pytest.fixture(scope='module')
def world():
    store.metadata.drop_all(store.engine)
    store.init_db()
    a = store.save_platform('https://lms-a.example', 'client-a', 'https://lms-a.example/auth',
                            'https://lms-a.example/token', 'https://lms-a.example/jwks', ['1'])
    b = store.save_platform('https://lms-b.example', 'client-b', 'https://lms-b.example/auth',
                            'https://lms-b.example/token', 'https://lms-b.example/jwks', ['1'])
    launches = {}
    for name, platform, instructor, content in [('teacher_a', a, 1, None), ('student_a', a, 0, 'c-a'),
                                                ('teacher_b', b, 1, None), ('student_b', b, 0, 'c-b')]:
        launch_id = f'lti1p3-launch-{name}'
        store.save_launch(launch_id=launch_id, platform_id=platform, deployment_id='1', user_id=name,
                          resource_link_id=f'rl-{name}', h5p_content_id=content, is_instructor=instructor,
                          ags_claim=None)
        issuer = store.get_platform(platform)['issuer']
        store.DbCache().set(launch_id, {'iss': issuer, 'aud': store.get_platform(platform)['client_id'],
                                        **(DEEP_LINK if instructor else {})})
        launches[name] = launch_id
    store.claim_content('c-a', a, 'Quiz of A', 'teacher_a')
    store.claim_content('c-b', b, 'Quiz of B', 'teacher_b')
    return {'a': a, 'b': b, **launches}


def client_for(*launch_ids):
    client = tool.app.test_client()
    with client.session_transaction() as s:
        s['launches'] = list(launch_ids)
    return client


def test_picker_shows_only_own_content(world):
    page = client_for(world['teacher_a']).get(f"/lti/picker?launch={world['teacher_a']}").get_data(as_text=True)
    assert 'Quiz of A' in page and 'Quiz of B' not in page


def test_picker_without_deep_linking_shows_custom_parameter(world):
    # An LMS without Deep Linking: the teacher pastes h5p_content_id into the custom parameters.
    launch_id = 'lti1p3-launch-teacher_a_plain'
    store.save_launch(launch_id=launch_id, platform_id=world['a'], deployment_id='1', user_id='teacher_a',
                      resource_link_id='rl-plain', h5p_content_id=None, is_instructor=1, ags_claim=None)
    platform = store.get_platform(world['a'])
    store.DbCache().set(launch_id, {'iss': platform['issuer'], 'aud': platform['client_id']})
    page = client_for(launch_id).get(f'/lti/picker?launch={launch_id}').get_data(as_text=True)
    assert 'h5p_content_id=c-a' in page and 'c-b' not in page
    assert 'Use this' not in page


def test_launch_not_in_session_is_refused(world):
    assert client_for(world['teacher_a']).get(f"/lti/picker?launch={world['teacher_b']}").status_code == 403


def test_students_cannot_pick_or_edit(world):
    c = client_for(world['student_a'])
    assert c.get(f"/lti/picker?launch={world['student_a']}").status_code == 403
    assert c.get(f"/lti/editor?launch={world['student_a']}").status_code == 403


def test_edit_other_platforms_content_refused(world):
    c = client_for(world['teacher_a'])
    assert c.get(f"/lti/editor?launch={world['teacher_a']}&content=c-b").status_code == 403
    assert c.get(f"/lti/preview/c-b?launch={world['teacher_a']}").status_code == 403


def test_deep_link_other_platforms_content_refused(world):
    c = client_for(world['teacher_a'])
    response = c.post('/lti/deep-link', data={'launch': world['teacher_a'], 'content_id': 'c-b',
                                              'csrf': tool.sign('picker', world['teacher_a'])})
    assert response.status_code == 403


def test_deep_link_needs_csrf(world):
    c = client_for(world['teacher_a'])
    response = c.post('/lti/deep-link', data={'launch': world['teacher_a'], 'content_id': 'c-a', 'csrf': 'x'})
    assert response.status_code == 403


def editor_ticket(world, content=None):
    c = client_for(world['teacher_a'])
    url = f"/lti/editor?launch={world['teacher_a']}" + (f'&content={content}' if content else '')
    location = c.get(url).headers['Location']
    ticket = parse_qs(urlparse(location).query)['ticket'][0]
    payload, sig = ticket.split('.')
    expected = base64.urlsafe_b64encode(hmac.new(b'test-secret', f'h5p-editor-ticket.{payload}'.encode(),
                                                 hashlib.sha256).digest()).rstrip(b'=').decode()
    return c, json.loads(base64.urlsafe_b64decode(payload + '=' * (-len(payload) % 4))), sig == expected


def test_editor_ticket_is_signed_and_scoped(world):
    _, new, valid = editor_ticket(world)
    assert valid and new['scope'] == 'new' and new['contentId'] is None
    _, edit, valid = editor_ticket(world, 'c-a')
    assert valid and edit['scope'] == 'edit' and edit['contentId'] == 'c-a'


def test_editor_ticket_carries_the_organisation_when_set(world, monkeypatch):
    _, plain, _ = editor_ticket(world)
    assert 'org' not in plain
    monkeypatch.setattr(tool, 'H5P_ORG', 'team-a')
    _, with_org, valid = editor_ticket(world)
    assert valid and with_org['org'] == 'team-a'


def test_editor_done_needs_h5p_server_signature(world):
    c, ticket, _ = editor_ticket(world)
    done = f"/lti/editor/done?launch={world['teacher_a']}&ticket={ticket['jti']}&contentId=c-new&title=New"
    assert c.get(done + '&sig=forged').status_code == 403
    sig = tool.tool_signature(f"h5p-editor-saved.{ticket['jti']}.c-new")
    assert c.get(done + f'&sig={sig}').status_code == 200
    assert store.content_owner('c-new') == world['a']


def test_editor_done_cannot_claim_other_platforms_content(world):
    c, ticket, _ = editor_ticket(world)
    sig = tool.tool_signature(f"h5p-editor-saved.{ticket['jti']}.c-b")
    done = f"/lti/editor/done?launch={world['teacher_a']}&ticket={ticket['jti']}&contentId=c-b&title=Mine&sig={sig}"
    assert c.get(done).status_code == 403
    assert store.content_owner('c-b') == world['b']


def score(client, launch_id, content_id, raw=1, maximum=1, token=None, parent=False):
    statement = {'result': {'score': {'raw': raw, 'max': maximum}}}
    if parent:
        statement['context'] = {'contextActivities': {'parent': [{'id': 'x'}]}}
    return client.post('/lti/score', json={'launch_id': launch_id, 'contentId': content_id, 'statement': statement},
                       headers={'X-CSRF-Token': token if token is not None else tool.sign('score', launch_id)})


def test_score_is_stored_for_own_launch(world):
    response = score(client_for(world['student_a']), world['student_a'], 'c-a')
    assert response.status_code == 200 and response.get_json()['status'] == 'stored'


def test_score_for_another_session_refused(world):
    assert score(client_for(world['student_a']), world['student_b'], 'c-b').status_code == 403


def test_score_needs_token(world):
    assert score(client_for(world['student_a']), world['student_a'], 'c-a', token='x').status_code == 403


def test_score_ignores_other_content_and_sub_questions(world):
    c = client_for(world['student_a'])
    assert score(c, world['student_a'], 'c-b').get_json()['status'] == 'ignored'
    assert score(c, world['student_a'], 'c-a', parent=True).get_json()['status'] == 'ignored'
    assert score(c, world['student_a'], 'c-a', raw=5, maximum=1).status_code == 400


def test_jwks_has_the_public_key(world):
    keys = tool.app.test_client().get('/.well-known/jwks.json').get_json()['keys']
    assert len(keys) == 1 and keys[0]['kty'] == 'RSA'


def test_registration_key_required_when_set(world, monkeypatch):
    monkeypatch.setattr(tool, 'LTI_REGISTRATION_KEY', 'secret-key')
    c = tool.app.test_client()
    assert c.get('/lti/register?openid_configuration=https://x.example/c').status_code == 403
    assert c.get('/lti/register?key=secret-key').status_code == 200


def test_purge_keeps_recent_launches(world):
    before = store.get_launch(world['student_a'])
    assert store.purge_older_than(1) == (0, 0)
    assert store.get_launch(world['student_a']) == before
    deleted_launches, _ = store.purge_older_than(-1)   # everything is "older" than tomorrow
    assert deleted_launches >= 4 and store.get_launch(world['student_a']) is None
