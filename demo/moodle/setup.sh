#!/usr/bin/env bash
# Registers examples/lti-provider in the demo Moodle and adds the Moodle platform to
# examples/lti-provider/tool_config.json. Safe to run again.
#
#   demo/moodle/setup.sh [h5p_content_id]
set -euo pipefail
cd "$(dirname "$0")"
TOOL_DIR=../../examples/lti-provider
TOOL_URL=${TOOL_URL:-http://localhost:5001}
CONTENT_ID=${1:-1331473450}
CONTAINER=$(docker compose ps -q moodle)

docker cp register-tool.php "$CONTAINER":/tmp/register-tool.php
docker cp "$TOOL_DIR/public.key" "$CONTAINER":/tmp/tool-public.key
OUT=$(docker exec -u daemon "$CONTAINER" /opt/bitnami/php/bin/php /tmp/register-tool.php \
      "$TOOL_URL" /tmp/tool-public.key "$CONTENT_ID" | tail -1)
echo "$OUT"

python3 - "$TOOL_DIR/tool_config.json" "$OUT" <<'PY'
import json, sys
path, out = sys.argv[1], json.loads(sys.argv[2])
conf = json.load(open(path))
conf[out['issuer']] = [{
    'default': True,
    'client_id': out['client_id'],
    'deployment_ids': [out['deployment_id']],
    'auth_login_url': out['auth_login_url'],
    'auth_token_url': out['auth_token_url'],
    'key_set_url': out['key_set_url'],
    'private_key_file': 'private.key',
    'public_key_file': 'public.key',
}]
json.dump(conf, open(path, 'w'), indent=2)
print(f"tool_config.json: added {out['issuer']}")
print(f"Course: {out['course_url']}  (teacher / Demo123!, student / Demo123!)")
PY
