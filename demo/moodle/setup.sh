#!/usr/bin/env bash
# Connects examples/lti-provider to the demo Moodle the way a Moodle admin would, with LTI
# Dynamic Registration, and adds a course with a teacher and a student. Safe to run again.
#
#   demo/moodle/setup.sh
#
# Needs: the tool running at $TOOL_URL (default http://localhost:5001), listening on all
# interfaces (HOST=0.0.0.0) so Moodle can fetch its keys; see README.md.
set -euo pipefail
cd "$(dirname "$0")"
TOOL_URL=${TOOL_URL:-http://localhost:5001}
CONTAINER=$(docker compose ps -q moodle)
moodle() { docker exec -u daemon "$CONTAINER" /opt/bitnami/php/bin/php /tmp/moodle-setup.php "$@" 2>&1 | grep -v sendmail; }

docker cp moodle-setup.php "$CONTAINER":/tmp/moodle-setup.php >/dev/null
COURSE=$(moodle site | tail -1)

if docker exec -u daemon "$CONTAINER" /opt/bitnami/php/bin/php -r 'define("CLI_SCRIPT",1); require "/opt/bitnami/moodle/config.php"; exit($DB->record_exists("lti_types", ["name" => "H5P"]) ? 0 : 1);'; then
  echo "Tool already registered."
else
  # The admin pastes $TOOL_URL/lti/register under Manage tools and clicks "Add LTI Advantage";
  # Moodle then opens this URL (with a registration token) and the tool registers itself.
  REG_URL=$(moodle registration-url "$TOOL_URL/lti/register" | tail -1)
  curl -sf -o /dev/null "$REG_URL" || { echo "Registration failed: is the tool running at $TOOL_URL?"; exit 1; }
  echo "Tool registered by Dynamic Registration."
fi
moodle activate

echo
echo "Moodle:  http://localhost:8080   (admin / Admin123!, teacher / Demo123!, student / Demo123!)"
echo "Course:  $COURSE"
