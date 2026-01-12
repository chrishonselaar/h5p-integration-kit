"""URL configuration for LMS project."""

from django.contrib import admin
from django.urls import path, include

urlpatterns = [
    path('admin/', admin.site.urls),
    path('', include('lti_consumer.urls')),
]
