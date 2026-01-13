"""
Default settings for django-h5p.

Add these to your Django settings.py:

    H5P_SERVER_URL = 'http://localhost:3000'  # URL to your H5P server
"""

from django.conf import settings

# H5P Server URL
H5P_SERVER_URL = getattr(settings, 'H5P_SERVER_URL', 'http://localhost:3000')
