"""Admin configuration for H5P integration app."""

from django.contrib import admin
from .models import Course, H5PActivity, H5PGrade


@admin.register(Course)
class CourseAdmin(admin.ModelAdmin):
    list_display = ['title', 'created_at', 'activity_count']
    search_fields = ['title', 'description']

    def activity_count(self, obj):
        return obj.activities.count()
    activity_count.short_description = 'Activities'


@admin.register(H5PActivity)
class H5PActivityAdmin(admin.ModelAdmin):
    list_display = ['title', 'course', 'h5p_content_id', 'created_at']
    list_filter = ['course']
    search_fields = ['title', 'h5p_content_id']


@admin.register(H5PGrade)
class H5PGradeAdmin(admin.ModelAdmin):
    list_display = ['activity', 'user_id', 'score_percentage', 'completed', 'xapi_verb', 'updated_at']
    list_filter = ['activity__course', 'activity', 'completed', 'xapi_verb']
    search_fields = ['user_id']
    readonly_fields = ['created_at', 'updated_at', 'xapi_statement']
