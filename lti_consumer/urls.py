"""URL configuration for H5P integration app."""

from django.urls import path
from . import views

app_name = 'lti_consumer'

urlpatterns = [
    # Course management
    path('', views.course_list, name='course_list'),
    path('course/create/', views.course_create, name='course_create'),
    path('course/<uuid:course_id>/', views.course_detail, name='course_detail'),

    # Activity management
    path('course/<uuid:course_id>/add-activity/', views.activity_add, name='activity_add'),
    path('course/<uuid:course_id>/activity-created/', views.activity_created, name='activity_created'),
    path('course/<uuid:course_id>/select-content/', views.content_select, name='content_select'),

    # Activity views
    path('activity/<uuid:activity_id>/', views.activity_view, name='activity_view'),
    path('activity/<uuid:activity_id>/launch/', views.activity_launch, name='activity_launch'),
    path('activity/<uuid:activity_id>/edit/', views.activity_edit, name='activity_edit'),
    path('activity/<uuid:activity_id>/content-updated/', views.activity_content_updated, name='activity_content_updated'),
    path('activity/<uuid:activity_id>/delete/', views.activity_delete, name='activity_delete'),

    # H5P webhooks and API
    path('h5p/results/', views.h5p_results, name='h5p_results'),
    path('api/content/', views.api_content_list, name='api_content_list'),
]
