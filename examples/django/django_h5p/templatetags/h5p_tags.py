"""Template tags for embedding H5P content."""

from django import template
from django.conf import settings
from django.utils.safestring import mark_safe

register = template.Library()


@register.simple_tag
def h5p_player_iframe(content, user_id=None, height="600px", width="100%"):
    """
    Embed an H5P player in an iframe.
    
    Usage:
        {% load h5p_tags %}
        {% h5p_player_iframe content user_id="user123" height="400px" %}
    """
    h5p_server_url = getattr(settings, 'H5P_SERVER_URL', 'http://localhost:3000')
    user_param = f"?userId={user_id}" if user_id else ""
    src = f"{h5p_server_url}/play/{content.h5p_content_id}{user_param}"
    
    return mark_safe(
        f'<iframe src="{src}" style="width:{width};height:{height};border:none;" '
        f'allowfullscreen></iframe>'
    )


@register.simple_tag
def h5p_server_url():
    """Return the H5P server URL from settings."""
    return getattr(settings, 'H5P_SERVER_URL', 'http://localhost:3000')
