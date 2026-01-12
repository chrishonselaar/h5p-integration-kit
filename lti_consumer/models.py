"""Models for H5P integration."""

from django.db import models
import uuid


class Course(models.Model):
    """A simple course container."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    title = models.CharField(max_length=255)
    description = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return self.title


class H5PActivity(models.Model):
    """An H5P activity linked to the H5P server."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    course = models.ForeignKey(Course, on_delete=models.CASCADE, related_name='activities')
    title = models.CharField(max_length=255)

    # Content reference from H5P server
    h5p_content_id = models.CharField(max_length=255, blank=True, db_index=True)

    # Display order within course
    order = models.PositiveIntegerField(default=0)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['order', 'created_at']
        verbose_name_plural = 'H5P Activities'

    def __str__(self):
        return f"{self.title} ({self.course.title})"


class H5PGrade(models.Model):
    """Stores grades/results received from H5P content via xAPI."""

    activity = models.ForeignKey(H5PActivity, on_delete=models.CASCADE, related_name='grades')
    user_id = models.CharField(max_length=255, db_index=True)
    score = models.DecimalField(max_digits=5, decimal_places=4)  # 0.0000 to 1.0000
    completed = models.BooleanField(default=False)

    # xAPI data
    xapi_verb = models.CharField(max_length=100, blank=True)  # completed, answered, passed, etc.
    xapi_statement = models.JSONField(null=True, blank=True)  # Full xAPI statement

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-updated_at']
        unique_together = ['activity', 'user_id']
        verbose_name = 'H5P Grade'
        verbose_name_plural = 'H5P Grades'

    def __str__(self):
        return f"{self.user_id}: {self.score_percentage} on {self.activity.title}"

    @property
    def score_percentage(self):
        return f"{float(self.score) * 100:.1f}%"
