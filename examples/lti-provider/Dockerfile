# H5P LTI 1.3 tool. See deploy/ for a stack with the H5P server and PostgreSQL.
FROM python:3.12-slim

# Pick up CA fixes released after the base image was built
# (e.g. the removal of the compromised eMudhra roots, 2026-10-20)
RUN apt-get update && apt-get install -y --only-upgrade ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py store.py ./
COPY templates/ templates/
COPY static/ static/

RUN useradd --system --create-home --uid 1001 lti && mkdir -p /keys && chown lti /keys
USER lti

ENV LTI_KEY_DIR=/keys \
    PYTHONUNBUFFERED=1
EXPOSE 5001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:5001/health')"
# --preload: keys and tables are created once, before the workers start
CMD ["gunicorn", "--preload", "--workers", "4", "--bind", "0.0.0.0:5001", "--access-logfile", "-", "app:app"]
