"""
Sample LMS views demonstrating django_h5p plugin usage.

This shows how to integrate H5P content into your own views.
"""

import json
import uuid
from urllib.parse import urlencode

from django.conf import settings
from django.http import JsonResponse
from django.shortcuts import render, redirect, get_object_or_404
from django.views.decorators.http import require_http_methods

from .models import Course, Activity
from django_h5p.models import H5PContent


# =============================================================================
# Course Management Views
# =============================================================================

def course_list(request):
    """List all courses."""
    courses = Course.objects.all()
    return render(request, 'sample_lms/course_list.html', {'courses': courses})


@require_http_methods(["GET", "POST"])
def course_create(request):
    """Create a new course."""
    if request.method == 'POST':
        title = request.POST.get('title', '').strip()
        description = request.POST.get('description', '').strip()
        if title:
            course = Course.objects.create(title=title, description=description)
            return redirect('sample_lms:course_detail', course_id=course.id)
    return render(request, 'sample_lms/course_create.html')


def course_detail(request, course_id):
    """View a course with its activities."""
    course = get_object_or_404(Course, id=course_id)
    activities = course.activities.all()
    return render(request, 'sample_lms/course_detail.html', {
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

    Opens H5P editor in a popup window to avoid cross-origin iframe issues
    while keeping the user on the Django course page.

    This demonstrates creating both an Activity and H5PContent.
    """
    course = get_object_or_404(Course, id=course_id)

    if request.method == 'POST':
        title = request.POST.get('title', '').strip() or 'H5P Activity'
        h5p_content_id = request.POST.get('h5p_content_id', '').strip()

        if h5p_content_id:
            # Create H5PContent from the plugin
            h5p_content = H5PContent.objects.create(
                h5p_content_id=h5p_content_id,
                title=title,
            )
            # Create Activity linked to H5PContent
            Activity.objects.create(
                course=course,
                title=title,
                h5p_content=h5p_content,
            )
            return redirect('sample_lms:course_detail', course_id=course.id)

    # Build return URL - use popup-close endpoint
    return_url = request.build_absolute_uri(f'/course/{course.id}/activity-created-popup/')
    user_id = get_user_id(request)
    params = urlencode({'userId': user_id, 'returnUrl': return_url})
    h5p_editor_url = f"{settings.H5P_SERVER_URL}/new?{params}"

    return render(request, 'sample_lms/activity_add_popup.html', {
        'course': course,
        'h5p_editor_url': h5p_editor_url,
    })


@require_http_methods(["GET"])
def activity_created(request, course_id):
    """Callback after H5P content is created in the editor (non-popup flow)."""
    course = get_object_or_404(Course, id=course_id)

    content_id = request.GET.get('contentId', '').strip()
    title = request.GET.get('title', '').strip() or 'H5P Activity'

    if content_id:
        # Create H5PContent from the plugin
        h5p_content = H5PContent.objects.create(
            h5p_content_id=content_id,
            title=title,
        )
        Activity.objects.create(
            course=course,
            title=title,
            h5p_content=h5p_content,
        )

    return redirect('sample_lms:course_detail', course_id=course.id)


@require_http_methods(["GET"])
def activity_created_popup(request, course_id):
    """Callback after H5P content is created - closes the popup window."""
    course = get_object_or_404(Course, id=course_id)

    content_id = request.GET.get('contentId', '').strip()
    title = request.GET.get('title', '').strip() or 'H5P Activity'

    if content_id:
        # Create H5PContent from the plugin
        h5p_content = H5PContent.objects.create(
            h5p_content_id=content_id,
            title=title,
        )
        Activity.objects.create(
            course=course,
            title=title,
            h5p_content=h5p_content,
        )

    # Return a page that closes the popup
    return render(request, 'sample_lms/popup_close.html', {
        'message': f'Activity "{title}" created successfully!',
    })


def activity_view(request, activity_id):
    """View an activity (for instructors) - shows grades."""
    activity = get_object_or_404(Activity, id=activity_id)
    # Get grades from the plugin's H5PGrade model via H5PContent
    grades = activity.get_grades()[:20]
    return render(request, 'sample_lms/activity_view.html', {
        'activity': activity,
        'grades': grades,
    })


def activity_launch(request, activity_id):
    """Launch/play an H5P activity (for students)."""
    activity = get_object_or_404(Activity, id=activity_id)

    if not activity.h5p_content:
        return render(request, 'sample_lms/activity_no_content.html', {
            'activity': activity,
        })

    return render(request, 'sample_lms/activity_launch.html', {
        'activity': activity,
        'h5p_server_url': settings.H5P_SERVER_URL,
        'user_id': get_user_id(request),
    })


def activity_edit(request, activity_id):
    """Edit an existing H5P activity's content.

    Opens H5P editor in a popup window to avoid cross-origin iframe issues.
    """
    activity = get_object_or_404(Activity, id=activity_id)

    if not activity.h5p_content:
        return redirect('sample_lms:activity_add', course_id=activity.course.id)

    return_url = request.build_absolute_uri(
        f'/activity/{activity.id}/content-updated-popup/'
    )
    user_id = get_user_id(request)
    params = urlencode({'userId': user_id, 'returnUrl': return_url})
    h5p_editor_url = f"{settings.H5P_SERVER_URL}/edit/{activity.h5p_content_id}?{params}"

    return render(request, 'sample_lms/activity_edit_popup.html', {
        'activity': activity,
        'h5p_editor_url': h5p_editor_url,
    })


@require_http_methods(["GET"])
def activity_content_updated(request, activity_id):
    """Callback after H5P content is updated (non-popup flow)."""
    activity = get_object_or_404(Activity, id=activity_id)

    title = request.GET.get('title', '').strip()
    if title:
        activity.title = title
        if activity.h5p_content:
            activity.h5p_content.title = title
            activity.h5p_content.save()
        activity.save()

    return redirect('sample_lms:activity_view', activity_id=activity.id)


@require_http_methods(["GET"])
def activity_content_updated_popup(request, activity_id):
    """Callback after H5P content is updated - closes the popup window."""
    activity = get_object_or_404(Activity, id=activity_id)

    title = request.GET.get('title', '').strip()
    if title:
        activity.title = title
        if activity.h5p_content:
            activity.h5p_content.title = title
            activity.h5p_content.save()
        activity.save()

    return render(request, 'sample_lms/popup_close.html', {
        'message': f'Activity "{activity.title}" updated successfully!',
    })


@require_http_methods(["POST"])
def activity_delete(request, activity_id):
    """Delete an H5P activity."""
    activity = get_object_or_404(Activity, id=activity_id)
    course_id = activity.course.id
    # Delete associated H5PContent when deleting activity
    if activity.h5p_content:
        activity.h5p_content.delete()
    activity.delete()
    return redirect('sample_lms:course_detail', course_id=course_id)


# =============================================================================
# H5P Content Selection (Hub)
# =============================================================================

def content_select(request, course_id):
    """Show H5P content hub for selecting/creating content."""
    course = get_object_or_404(Course, id=course_id)

    return_url = request.build_absolute_uri(f'/course/{course.id}/activity-created/')

    return render(request, 'sample_lms/content_select.html', {
        'course': course,
        'h5p_server_url': settings.H5P_SERVER_URL,
        'return_url': return_url,
        'user_id': get_user_id(request),
    })


# =============================================================================
# H5P Results Webhook
# =============================================================================
# NOTE: The xAPI results webhook is now provided by the django_h5p plugin.
# Include it in your urls.py:
#     path('h5p/', include('django_h5p.urls'))
# This provides the endpoint at /h5p/results/ which stores grades in H5PGrade.


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
