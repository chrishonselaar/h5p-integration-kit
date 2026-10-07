#!/usr/bin/env bash
# Full check against a fresh Moodle, from nothing: start Moodle in Docker, start the H5P server
# (protected) and the LTI tool with empty data, register the tool by Dynamic Registration, then run
# e2e.mjs twice (right and wrong answer). Used by .github/workflows/moodle.yml; also runs locally.
#
#   demo/moodle/ci.sh [moodle image tag, default 4.5]
#
# Needs: Docker, Node with h5p-server's npm packages installed, Python with the tool's requirements
# (PYTHON, default python3), Playwright for Node (npm i playwright; npx playwright install chromium).
# Ports 8080, 3000 and 5001 must be free (stop the demo first: docker compose -p moodle stop).
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(cd ../.. && pwd)
TAG=${1:-4.5}
PYTHON=${PYTHON:-python3}
PROJECT=h5pkit-ci
WORK=$(mktemp -d)
PIDS=()

cleanup() {
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  MOODLE_TAG=$TAG docker compose -p $PROJECT down -v >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

for port in 8080 3000 5001; do
  if (exec 3<>/dev/tcp/127.0.0.1/$port) 2>/dev/null; then echo "Port $port is in use"; exit 1; fi
done

echo "== Moodle $TAG"
MOODLE_TAG=$TAG docker compose -p $PROJECT up -d --quiet-pull
for i in $(seq 1 120); do curl -sf -o /dev/null http://localhost:8080/login/index.php && break; sleep 5; done
curl -sf -o /dev/null http://localhost:8080/login/index.php || { echo "Moodle did not start"; exit 1; }

echo "== H5P server and LTI tool (empty data)"
set -a; . ./demo.env; set +a
mkdir -p "$WORK/h5p" "$WORK/tool"
cp -r "$ROOT/h5p-server/h5p/core" "$ROOT/h5p-server/h5p/editor" "$WORK/h5p/"
export H5P_DATA_PATH=$WORK/h5p DATABASE_URL=sqlite:///$WORK/tool/lti.db LTI_KEY_DIR=$WORK/tool
(cd "$ROOT/h5p-server" && exec node src/index.js) > "$WORK/h5p.log" 2>&1 & PIDS+=($!)
(cd "$ROOT/examples/lti-provider" && exec "$PYTHON" app.py) > "$WORK/tool.log" 2>&1 & PIDS+=($!)
for i in $(seq 1 60); do curl -sf -o /dev/null localhost:3000/health && curl -sf -o /dev/null localhost:5001/health && break; sleep 1; done

# Install the Multiple Choice content type (the admin's job), then remove the sample content
imported=$(curl -sf -H "Authorization: Bearer $H5P_ADMIN_PASSWORD" -F file=@fixtures/multiple-choice.h5p localhost:3000/api/import)
sample=$("$PYTHON" -c 'import json,sys; print(json.load(sys.stdin)["contentId"])' <<< "$imported")
curl -sf -o /dev/null -X DELETE -H "Authorization: Bearer $H5P_ADMIN_PASSWORD" "localhost:3000/api/content/$sample"

echo "== Register the tool in Moodle"
COMPOSE_PROJECT_NAME=$PROJECT ./setup.sh

echo "== Teacher and student, right answer"
status=0
node e2e.mjs right || status=1
echo "== Teacher and student, wrong answer"
node e2e.mjs wrong || status=1

if [ $status -ne 0 ]; then
  echo "== tool log"; tail -50 "$WORK/tool.log"
  echo "== H5P server log"; tail -50 "$WORK/h5p.log"
fi
exit $status
