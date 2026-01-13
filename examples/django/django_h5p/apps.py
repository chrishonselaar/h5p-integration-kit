"""Django app configuration for django-h5p."""

from django.apps import AppConfig


class DjangoH5PConfig(AppConfig):
    """Configuration for the django-h5p app."""
    
    name = 'django_h5p'
    verbose_name = 'H5P Content Integration'
    default_auto_field = 'django.db.models.BigAutoField'
