"""
Sample LMS models demonstrating django_h5p plugin usage.

This shows how to integrate H5P content into your own models.
"""

import uuid
from django.db import models
from django_h5p.models import H5PContent


class Course(models.Model):
    """A simple course container (sample LMS model)."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    title = models.CharField(max_length=255)
    description = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return self.title


class Activity(models.Model):
    """
    A course activity that can contain H5P content.

    This demonstrates how to link django_h5p.H5PContent to your own models.
    The H5PContent uses GenericForeignKey, so it can link back to this Activity.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    course = models.ForeignKey(Course, on_delete=models.CASCADE, related_name='activities')
    title = models.CharField(max_length=255)
    order = models.PositiveIntegerField(default=0)

    # Link to H5P content (optional - allows other activity types in future)
    h5p_content = models.OneToOneField(
        H5PContent,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='activity'
    )

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['order', 'created_at']
        verbose_name_plural = 'Activities'

    def __str__(self):
        return f"{self.title} ({self.course.title})"

    @property
    def h5p_server_id(self):
        """Get the H5P server content ID for templates."""
        return self.h5p_content.h5p_content_id if self.h5p_content else None

    def get_grades(self):
        """Get grades for this activity's H5P content."""
        if self.h5p_content:
            return self.h5p_content.grades.all()
        return []
