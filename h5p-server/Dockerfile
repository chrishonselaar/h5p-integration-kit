# H5P Server Dockerfile
# License: GPL-3.0-or-later (due to @lumieducation/h5p-server dependency)
#
# This container provides an H5P content authoring and playback server
# that can be integrated with any LMS via HTTP API.

FROM node:20-alpine

LABEL maintainer="Chris Honselaar"
LABEL description="H5P Content Server for LMS Integration"
LABEL license="GPL-3.0-or-later"

# Pick up CA fixes released after the base image was built
# (e.g. the removal of the compromised eMudhra roots, 2026-10-20)
RUN apk upgrade --no-cache ca-certificates-bundle

# Create app directory
WORKDIR /app

# Install dependencies first (better layer caching)
COPY package*.json ./
RUN npm ci --only=production

# Copy application code
COPY src/ ./src/

# Create directories for H5P data (will be mounted as volumes)
RUN mkdir -p /data/h5p/content /data/h5p/libraries /data/h5p/temp /data/h5p/core /data/h5p/editor

# Environment variables with sensible defaults
ENV NODE_ENV=production
ENV PORT=3000
ENV H5P_BASE_URL=http://localhost:3000
ENV DJANGO_URL=http://host.docker.internal:8000
ENV H5P_DATA_PATH=/data/h5p

# Trust the system CA bundle above instead of Node's built-in root list,
# which only changes with a new Node release
ENV NODE_OPTIONS=--use-openssl-ca
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt

# Expose the server port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Run as non-root user for security
RUN addgroup -g 1001 -S h5p && adduser -u 1001 -S h5p -G h5p
RUN chown -R h5p:h5p /app /data
USER h5p

CMD ["node", "src/index.js"]
