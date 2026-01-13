"""URL patterns for django-h5p."""

from django.urls import path
from . import views

app_name = 'django_h5p'

urlpatterns = [
    # xAPI webhook (receives scores from H5P server)
    path('results/', views.h5p_results_webhook, name='results_webhook'),
    
    # Player view
    path('play/<uuid:content_id>/', views.h5p_player, name='player'),
    
    # Editor views
    path('edit/<uuid:content_id>/', views.h5p_editor, name='editor_edit'),
    path('new/', views.h5p_editor, name='editor_new'),
]
