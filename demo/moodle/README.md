# Moodle demo: H5P through LTI 1.3

A local Moodle 4.5 LTS that uses the kit's LTI tool (`examples/lti-provider`). A student
opens an H5P activity in Moodle and plays it, and the score lands in the Moodle
gradebook. Nothing is installed in Moodle except a core "External tool" registration.

## Run it

```bash
# 1. Moodle (first start installs Moodle and takes a few minutes)
cd demo/moodle && docker compose up -d
until curl -sf -o /dev/null http://localhost:8080/login/index.php; do sleep 5; done

# 2. H5P server (port 3000) and LTI tool (port 5001), each in its own terminal
cd h5p-server && npm start
cd examples/lti-provider && python app.py      # needs private.key/public.key, see its README

# 3. Register the tool in Moodle; creates the course, users and one activity.
#    The argument is the H5P content id the activity opens (a multiple-choice question works best).
demo/moodle/setup.sh 1331473450
# Restart the LTI tool afterwards: setup.sh adds Moodle to tool_config.json.
```

| Who | Login | Password |
|-----|-------|----------|
| Site admin | admin | Admin123! |
| Teacher | teacher | Demo123! |
| Student | student | Demo123! |

Open http://localhost:8080, log in as the student, open **H5P via LTI demo → H5P quiz**, and
answer the question. Log in as the teacher and open **Grades**: the score is there.

Automated check (needs Playwright): `node demo/moodle/e2e-launch.mjs` (answer 0) or
`node demo/moodle/e2e-launch.mjs 1`. It exits non-zero if the grade was not sent to Moodle.

## How it is wired

- Moodle is the LTI platform, with issuer `http://localhost:8080`. `setup.sh` runs
  `register-tool.php` inside the container. That registers the tool (LTI 1.3, grade sync
  through AGS) and prints the client id and deployment id, which `setup.sh` writes into
  `examples/lti-provider/tool_config.json`.
- The tool's public key is pasted into Moodle (key type "RSA key"), not given as a keyset URL.
  So Moodle never calls the tool, and Moodle's curl blocklist for `localhost` doesn't get in
  the way. The tool calls Moodle, at `localhost:8080`, for the access token and the score.
- Moodle (`localhost:8080`) and the tool (`localhost:5001`) count as the same site for
  cookies, so the iframe launch works over plain http. A real deployment on two domains needs
  https, because the tool's session cookie is `SameSite=None; Secure`.

## Known quirks

- The `bitnamilegacy/*` images no longer get updates. They are fine for a local demo. For the
  "upgrade Moodle" part of the demo, `MOODLE_TAG=5.0 docker compose up -d` should upgrade the
  existing site. That hasn't been tried yet.
- On this image, the first login in a new browser session fails with "Invalid login". The
  second try works.
- Reset everything: `docker compose down -v`.
