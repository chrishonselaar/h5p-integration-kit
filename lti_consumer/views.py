"""Views for H5P integration (direct integration, no LTI)."""

import json
import uuid
from decimal import Decimal

from django.conf import settings
from django.http import HttpResponse, JsonResponse
from django.shortcuts import render, redirect, get_object_or_404
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods

from .models import Course, H5PActivity, H5PGrade


# =============================================================================
# Course Management Views
# =============================================================================

def course_list(request):
    """List all courses."""
    courses = Course.objects.all()
    return render(request, 'lti_consumer/course_list.html', {'courses': courses})


@require_http_methods(["GET", "POST"])
def course_create(request):
    """Create a new course."""
    if request.method == 'POST':
        title = request.POST.get('title', '').strip()
        description = request.POST.get('description', '').strip()
        if title:
            course = Course.objects.create(title=title, description=description)
            return redirect('lti_consumer:course_detail', course_id=course.id)
    return render(request, 'lti_consumer/course_create.html')


def course_detail(request, course_id):
    """View a course with its activities."""
    course = get_object_or_404(Course, id=course_id)
    activities = course.activities.all()
    return render(request, 'lti_consumer/course_detail.html', {
        'course': course,
        'activities': activities,
        'h5p_server_url': settings.H5P_SERVER_URL,
    })


# =============================================================================
# Activity Management Views
# =============================================================================

@require_http_methods(["GET", "POST"])
def activity_add(request, course_id):
    """Add a new H5P activity to a course.

    GET: Shows the H5P editor in an iframe for content creation
    POST: Receives the content ID after creation and saves the activity
    """
    course = get_object_or_404(Course, id=course_id)

    if request.method == 'POST':
        title = request.POST.get('title', '').strip() or 'H5P Activity'
        h5p_content_id = request.POST.get('h5p_content_id', '').strip()

        if h5p_content_id:
            activity = H5PActivity.objects.create(
                course=course,
                title=title,
                h5p_content_id=h5p_content_id,
            )
            return redirect('lti_consumer:course_detail', course_id=course.id)

    # Build return URL for the H5P editor
    return_url = request.build_absolute_uri(f'/course/{course.id}/activity-created/')

    return render(request, 'lti_consumer/activity_add.html', {
        'course': course,
        'h5p_server_url': settings.H5P_SERVER_URL,
        'return_url': return_url,
        'user_id': get_user_id(request),
    })


@require_http_methods(["GET"])
def activity_created(request, course_id):
    """Callback after H5P content is created in the editor."""
    course = get_object_or_404(Course, id=course_id)

    content_id = request.GET.get('contentId', '').strip()
    title = request.GET.get('title', '').strip() or 'H5P Activity'

    if content_id:
        H5PActivity.objects.create(
            course=course,
            title=title,
            h5p_content_id=content_id,
        )

    return redirect('lti_consumer:course_detail', course_id=course.id)


def activity_view(request, activity_id):
    """View an activity (for instructors) - shows grades."""
    activity = get_object_or_404(H5PActivity, id=activity_id)
    grades = activity.grades.all()[:20]
    return render(request, 'lti_consumer/activity_view.html', {
        'activity': activity,
        'grades': grades,
    })


def activity_launch(request, activity_id):
    """Launch/play an H5P activity (for students)."""
    activity = get_object_or_404(H5PActivity, id=activity_id)

    if not activity.h5p_content_id:
        return render(request, 'lti_consumer/activity_no_content.html', {
            'activity': activity,
        })

    return render(request, 'lti_consumer/activity_launch.html', {
        'activity': activity,
        'h5p_server_url': settings.H5P_SERVER_URL,
        'user_id': get_user_id(request),
    })


def activity_edit(request, activity_id):
    """Edit an existing H5P activity's content."""
    activity = get_object_or_404(H5PActivity, id=activity_id)

    if not activity.h5p_content_id:
        return redirect('lti_consumer:activity_add', course_id=activity.course.id)

    return_url = request.build_absolute_uri(
        f'/activity/{activity.id}/content-updated/'
    )

    return render(request, 'lti_consumer/activity_edit.html', {
        'activity': activity,
        'h5p_server_url': settings.H5P_SERVER_URL,
        'return_url': return_url,
        'user_id': get_user_id(request),
    })


@require_http_methods(["GET"])
def activity_content_updated(request, activity_id):
    """Callback after H5P content is updated."""
    activity = get_object_or_404(H5PActivity, id=activity_id)

    title = request.GET.get('title', '').strip()
    if title:
        activity.title = title
        activity.save()

    return redirect('lti_consumer:activity_view', activity_id=activity.id)


@require_http_methods(["POST"])
def activity_delete(request, activity_id):
    """Delete an H5P activity."""
    activity = get_object_or_404(H5PActivity, id=activity_id)
    course_id = activity.course.id
    activity.delete()
    return redirect('lti_consumer:course_detail', course_id=course_id)


# =============================================================================
# H5P Content Selection (Hub)
# =============================================================================

def content_select(request, course_id):
    """Show H5P content hub for selecting/creating content."""
    course = get_object_or_404(Course, id=course_id)

    return_url = request.build_absolute_uri(f'/course/{course.id}/activity-created/')

    return render(request, 'lti_consumer/content_select.html', {
        'course': course,
        'h5p_server_url': settings.H5P_SERVER_URL,
        'return_url': return_url,
        'user_id': get_user_id(request),
    })


# =============================================================================
# H5P Results Webhook (receives scores from H5P server)
# =============================================================================

@csrf_exempt
@require_http_methods(["POST"])
def h5p_results(request):
    """Receive results/scores from H5P content via xAPI webhook.

    The H5P server sends xAPI statements when users complete activities.
    """
    try:
        data = json.loads(request.body.decode('utf-8'))
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    content_id = data.get('contentId')
    user_id = data.get('userId', 'anonymous')
    statement = data.get('statement', {})

    if not content_id:
        return JsonResponse({'error': 'Missing contentId'}, status=400)

    # Find the activity by H5P content ID
    try:
        activity = H5PActivity.objects.get(h5p_content_id=content_id)
    except H5PActivity.DoesNotExist:
        # Activity not tracked in Django - that's OK
        return JsonResponse({'status': 'ignored', 'reason': 'activity_not_found'})

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
            activity=activity,
            user_id=user_id,
            defaults={
                'score': min(score, Decimal('1.0')),  # Cap at 1.0
                'completed': completion,
                'xapi_verb': verb,
                'xapi_statement': statement,
            }
        )

        return JsonResponse({
            'status': 'saved',
            'activity_id': str(activity.id),
            'score': float(score),
            'verb': verb,
        })

    return JsonResponse({'status': 'ignored', 'reason': 'no_score'})


# =============================================================================
# API Endpoints (for AJAX calls from templates)
# =============================================================================

def api_content_list(request):
    """Get list of H5P content from the H5P server."""
    import urllib.request
    import urllib.error

    try:
        url = f"{settings.H5P_SERVER_URL}/api/content"
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=5) as response:
            data = json.loads(response.read().decode('utf-8'))
            return JsonResponse(data)
    except (urllib.error.URLError, TimeoutError) as e:
        return JsonResponse({'error': str(e), 'content': []})


# =============================================================================
# Helper Functions
# =============================================================================

def get_user_id(request):
    """Get user ID from request (session, auth, or anonymous)."""
    if request.user.is_authenticated:
        return str(request.user.id)
    # For demo purposes, use session-based ID
    if 'demo_user_id' not in request.session:
        request.session['demo_user_id'] = f"demo-{uuid.uuid4().hex[:8]}"
    return request.session['demo_user_id']
