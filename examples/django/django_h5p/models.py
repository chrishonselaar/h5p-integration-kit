"""
Models for H5P content integration.

This module provides models for storing H5P content references and grades.
H5PContent can be linked to any model in your project using GenericForeignKey,
making it easy to add H5P support to existing content models.
"""

import uuid
from decimal import Decimal

from django.conf import settings
from django.contrib.contenttypes.fields import GenericForeignKey
from django.contrib.contenttypes.models import ContentType
from django.db import models


class H5PContent(models.Model):
    """
    Reference to an H5P content item stored on the H5P server.
    
    This model stores the H5P content ID and can be linked to any model
    in your project using the GenericForeignKey. This allows you to add
    H5P content to lessons, courses, or any other model.
    
    Example usage:
        # Link H5P content to a LessonItem
        h5p = H5PContent.objects.create(
            h5p_content_id='12345',
            title='My Quiz',
            content_type=ContentType.objects.get_for_model(LessonItem),
            object_id=lesson_item.pk
        )
        
        # Or create standalone H5P content without linking
        h5p = H5PContent.objects.create(
            h5p_content_id='12345',
            title='Standalone Quiz'
        )
    """
    
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    
    # H5P server content reference
    h5p_content_id = models.CharField(
        max_length=100,
        db_index=True,
        help_text="Content ID from the H5P server"
    )
    title = models.CharField(max_length=255, blank=True)
    
    # Optional: Link to any model in your project
    content_type = models.ForeignKey(
        ContentType,
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        help_text="The model type this H5P content is attached to"
    )
    object_id = models.CharField(
        max_length=255,
        null=True,
        blank=True,
        help_text="The ID of the object this H5P content is attached to"
    )
    parent_object = GenericForeignKey('content_type', 'object_id')
    
    # Metadata
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    
    class Meta:
        verbose_name = 'H5P Content'
        verbose_name_plural = 'H5P Content'
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['content_type', 'object_id']),
        ]
    
    def __str__(self):
        return self.title or f"H5P Content {self.h5p_content_id}"
    
    def get_player_url(self):
        """Get the URL to play this H5P content."""
        base_url = getattr(settings, 'H5P_SERVER_URL', 'http://localhost:3000')
        return f"{base_url}/play/{self.h5p_content_id}"
    
    def get_editor_url(self, return_url=None, user_id=None):
        """Get the URL to edit this H5P content."""
        from urllib.parse import urlencode
        base_url = getattr(settings, 'H5P_SERVER_URL', 'http://localhost:3000')
        params = {}
        if return_url:
            params['returnUrl'] = return_url
        if user_id:
            params['userId'] = user_id
        query = f"?{urlencode(params)}" if params else ""
        return f"{base_url}/edit/{self.h5p_content_id}{query}"


class H5PGrade(models.Model):
    """
    Stores grades/scores from H5P content interactions.
    
    When a user completes an H5P activity, the score is sent to Django
    via the xAPI webhook and stored here.
    """
    
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    
    # Link to H5P content
    content = models.ForeignKey(
        H5PContent,
        on_delete=models.CASCADE,
        related_name='grades'
    )
    
    # User identification (flexible - can be Django user ID or external ID)
    user_id = models.CharField(
        max_length=255,
        db_index=True,
        help_text="User identifier (Django user ID or external)"
    )
    
    # Score data
    score = models.DecimalField(
        max_digits=5,
        decimal_places=4,
        help_text="Normalized score (0.0 to 1.0)"
    )
    raw_score = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        null=True,
        blank=True,
        help_text="Raw score from H5P"
    )
    max_score = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        null=True,
        blank=True,
        help_text="Maximum possible score"
    )
    
    # Completion status
    completed = models.BooleanField(default=False)
    success = models.BooleanField(null=True, blank=True)
    
    # xAPI data
    xapi_verb = models.CharField(max_length=100, blank=True)
    xapi_statement = models.JSONField(null=True, blank=True)
    
    # Timestamps
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    
    class Meta:
        verbose_name = 'H5P Grade'
        verbose_name_plural = 'H5P Grades'
        ordering = ['-updated_at']
        unique_together = ['content', 'user_id']
    
    def __str__(self):
        return f"{self.user_id}: {self.score:.0%} on {self.content}"
    
    @property
    def score_percent(self):
        """Return score as percentage (0-100)."""
        return float(self.score * 100)
