"""
Views for H5P content integration.

Provides views for:
- Receiving xAPI results from H5P server (webhook)
- Launching H5P player
- Opening H5P editor
"""

import json
from decimal import Decimal

from django.conf import settings
from django.http import HttpResponse, JsonResponse
from django.shortcuts import get_object_or_404, render
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods

from .models import H5PContent, H5PGrade


def _add_cors_headers(response):
    """Add CORS headers for H5P server requests."""
    response['Access-Control-Allow-Origin'] = '*'
    response['Access-Control-Allow-Methods'] = 'POST, OPTIONS'
    response['Access-Control-Allow-Headers'] = 'Content-Type'
    return response


@csrf_exempt
@require_http_methods(["POST", "OPTIONS"])
def h5p_results_webhook(request):
    """
    Receive xAPI results from H5P content.
    
    The H5P server sends xAPI statements when users complete activities.
    This webhook receives those statements and stores the grades.
    
    Expected POST body:
    {
        "contentId": "12345",
        "userId": "user-id",
        "statement": { ... xAPI statement ... }
    }
    """
    # Handle CORS preflight
    if request.method == 'OPTIONS':
        return _add_cors_headers(HttpResponse())

    try:
        data = json.loads(request.body.decode('utf-8'))
    except json.JSONDecodeError:
        return _add_cors_headers(JsonResponse({'error': 'Invalid JSON'}, status=400))

    content_id = data.get('contentId')
    user_id = data.get('userId', 'anonymous')
    statement = data.get('statement', {})

    if not content_id:
        return _add_cors_headers(JsonResponse({'error': 'Missing contentId'}, status=400))

    # Find the H5P content by content ID
    try:
        content = H5PContent.objects.get(h5p_content_id=str(content_id))
    except H5PContent.DoesNotExist:
        return _add_cors_headers(JsonResponse({
            'status': 'ignored',
            'reason': 'content_not_found'
        }))

    # Extract score from xAPI statement
    result = statement.get('result', {})
    score_obj = result.get('score', {})

    raw_score = score_obj.get('raw')
    max_score = score_obj.get('max')
    completion = result.get('completion', False)
    success = result.get('success')

    # Calculate normalized score (0.0 to 1.0)
    if raw_score is not None and max_score:
        score = Decimal(str(raw_score)) / Decimal(str(max_score))
    elif raw_score is not None:
        score = Decimal(str(raw_score))
    else:
        score = None

    # Get verb (completed, answered, passed, failed)
    verb_id = statement.get('verb', {}).get('id', '')
    verb = verb_id.split('/')[-1] if '/' in verb_id else verb_id

    # Store or update grade
    if score is not None:
        H5PGrade.objects.update_or_create(
            content=content,
            user_id=user_id,
            defaults={
                'score': min(score, Decimal('1.0')),
                'raw_score': Decimal(str(raw_score)) if raw_score else None,
                'max_score': Decimal(str(max_score)) if max_score else None,
                'completed': completion,
                'success': success,
                'xapi_verb': verb,
                'xapi_statement': statement,
            }
        )

        return _add_cors_headers(JsonResponse({
            'status': 'saved',
            'content_id': str(content.id),
            'score': float(score),
            'verb': verb,
        }))

    return _add_cors_headers(JsonResponse({'status': 'ignored', 'reason': 'no_score'}))


def h5p_player(request, content_id):
    """
    Render the H5P player for a specific content item.
    
    This view can be used directly or embedded in an iframe.
    """
    content = get_object_or_404(H5PContent, id=content_id)
    
    # Get user ID for tracking
    if request.user.is_authenticated:
        user_id = str(request.user.id)
    else:
        if 'h5p_user_id' not in request.session:
            import uuid
            request.session['h5p_user_id'] = f"anon-{uuid.uuid4().hex[:8]}"
        user_id = request.session['h5p_user_id']
    
    h5p_server_url = getattr(settings, 'H5P_SERVER_URL', 'http://localhost:3000')
    player_url = f"{h5p_server_url}/play/{content.h5p_content_id}?userId={user_id}"
    
    return render(request, 'django_h5p/player.html', {
        'content': content,
        'player_url': player_url,
        'h5p_server_url': h5p_server_url,
    })


def h5p_editor(request, content_id=None):
    """
    Open the H5P editor for creating or editing content.
    
    If content_id is provided, edit existing content.
    Otherwise, create new content.
    """
    h5p_server_url = getattr(settings, 'H5P_SERVER_URL', 'http://localhost:3000')
    
    # Get user ID
    if request.user.is_authenticated:
        user_id = str(request.user.id)
    else:
        if 'h5p_user_id' not in request.session:
            import uuid
            request.session['h5p_user_id'] = f"anon-{uuid.uuid4().hex[:8]}"
        user_id = request.session['h5p_user_id']
    
    # Build return URL
    return_url = request.GET.get('return_url', request.build_absolute_uri('/'))
    
    if content_id:
        content = get_object_or_404(H5PContent, id=content_id)
        editor_url = content.get_editor_url(return_url=return_url, user_id=user_id)
        template = 'django_h5p/editor_edit.html'
    else:
        content = None
        from urllib.parse import urlencode
        params = urlencode({'userId': user_id, 'returnUrl': return_url})
        editor_url = f"{h5p_server_url}/new?{params}"
        template = 'django_h5p/editor_new.html'
    
    return render(request, template, {
        'content': content,
        'editor_url': editor_url,
        'h5p_server_url': h5p_server_url,
    })
