"""
Admin configuration for Sample LMS.

Note: H5PContent and H5PGrade are registered by the django_h5p plugin.
"""

from django.contrib import admin
from .models import Course, Activity


@admin.register(Course)
class CourseAdmin(admin.ModelAdmin):
    list_display = ['title', 'created_at', 'activity_count']
    search_fields = ['title', 'description']

    def activity_count(self, obj):
        return obj.activities.count()
    activity_count.short_description = 'Activities'


@admin.register(Activity)
class ActivityAdmin(admin.ModelAdmin):
    list_display = ['title', 'course', 'h5p_content_id', 'created_at']
    list_filter = ['course']
    search_fields = ['title']
