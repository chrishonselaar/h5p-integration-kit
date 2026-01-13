"""Admin configuration for django-h5p models."""

from django.contrib import admin
from .models import H5PContent, H5PGrade


@admin.register(H5PContent)
class H5PContentAdmin(admin.ModelAdmin):
    list_display = ['title', 'h5p_content_id', 'created_at', 'updated_at']
    list_filter = ['created_at']
    search_fields = ['title', 'h5p_content_id']
    readonly_fields = ['id', 'created_at', 'updated_at']
    
    fieldsets = (
        (None, {
            'fields': ('title', 'h5p_content_id')
        }),
        ('Linked Object', {
            'fields': ('content_type', 'object_id'),
            'classes': ('collapse',),
        }),
        ('Metadata', {
            'fields': ('id', 'created_at', 'updated_at'),
            'classes': ('collapse',),
        }),
    )


@admin.register(H5PGrade)
class H5PGradeAdmin(admin.ModelAdmin):
    list_display = ['content', 'user_id', 'score_display', 'completed', 'xapi_verb', 'updated_at']
    list_filter = ['completed', 'xapi_verb', 'created_at']
    search_fields = ['user_id', 'content__title']
    readonly_fields = ['id', 'created_at', 'updated_at', 'xapi_statement']
    
    def score_display(self, obj):
        return f"{obj.score_percent:.0f}%"
    score_display.short_description = 'Score'
