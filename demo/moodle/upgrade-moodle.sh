#!/usr/bin/env bash
# Upgrades the demo Moodle in place (default 4.5 -> 5.0), the way an admin does: new code, same
# config.php, then Moodle's upgrade script. Nothing changes in the H5P tool. Run e2e.mjs afterwards.
#
#   demo/moodle/upgrade-moodle.sh [image tag, default 5.0]
#
# The bitnami image keeps the Moodle code in its volume, so a new image tag alone does not upgrade
# the code. The old code stays in the container at /bitnami/moodle-<old version>-backup.
set -euo pipefail
cd "$(dirname "$0")"
TAG=${1:-5.0}
IMAGE=bitnamilegacy/moodle:$TAG
CONTAINER=$(docker compose ps -q moodle)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"; docker rm -f moodle-code-$$ >/dev/null 2>&1 || true' EXIT

docker pull -q "$IMAGE" >/dev/null
docker create --name moodle-code-$$ "$IMAGE" >/dev/null
docker cp -q moodle-code-$$:/opt/bitnami/moodle "$WORK/moodle"
docker cp -q "$WORK/moodle" "$CONTAINER":/bitnami/moodle-new

docker exec "$CONTAINER" bash -c '
  set -e; cd /bitnami
  old=$(sed -n "s/^\$release *= *.\([0-9.]*\).*/\1/p" moodle/version.php)
  rm -rf "moodle-$old-backup"; cp -a moodle "moodle-$old-backup"
  find moodle -mindepth 1 -maxdepth 1 ! -name config.php -exec rm -rf {} +
  cp -a moodle-new/. moodle/ && rm -rf moodle-new
  cp "moodle-$old-backup/config.php" moodle/config.php
  chown -R daemon:root moodle'
docker exec -u daemon "$CONTAINER" /opt/bitnami/php/bin/php /opt/bitnami/moodle/admin/cli/upgrade.php --non-interactive | tail -1
docker exec -u daemon "$CONTAINER" /opt/bitnami/php/bin/php /opt/bitnami/moodle/admin/cli/purge_caches.php
