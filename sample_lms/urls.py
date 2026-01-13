"""
URL configuration for the sample LMS app.

This demonstrates how to use django_h5p in your own project.
"""

from django.urls import path, include
from . import views

app_name = 'sample_lms'

urlpatterns = [
    # Course management
    path('', views.course_list, name='course_list'),
    path('course/create/', views.course_create, name='course_create'),
    path('course/<uuid:course_id>/', views.course_detail, name='course_detail'),

    # Activity management
    path('course/<uuid:course_id>/add-activity/', views.activity_add, name='activity_add'),
    path('course/<uuid:course_id>/activity-created/', views.activity_created, name='activity_created'),
    path('course/<uuid:course_id>/activity-created-popup/', views.activity_created_popup, name='activity_created_popup'),
    path('course/<uuid:course_id>/select-content/', views.content_select, name='content_select'),

    # Activity views
    path('activity/<uuid:activity_id>/', views.activity_view, name='activity_view'),
    path('activity/<uuid:activity_id>/launch/', views.activity_launch, name='activity_launch'),
    path('activity/<uuid:activity_id>/edit/', views.activity_edit, name='activity_edit'),
    path('activity/<uuid:activity_id>/content-updated/', views.activity_content_updated, name='activity_content_updated'),
    path('activity/<uuid:activity_id>/content-updated-popup/', views.activity_content_updated_popup, name='activity_content_updated_popup'),
    path('activity/<uuid:activity_id>/delete/', views.activity_delete, name='activity_delete'),

    # Include django_h5p plugin URLs (provides /h5p/results/ webhook)
    path('h5p/', include('django_h5p.urls')),

    # Sample LMS API
    path('api/content/', views.api_content_list, name='api_content_list'),
]
