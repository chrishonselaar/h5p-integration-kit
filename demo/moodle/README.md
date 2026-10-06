# Moodle demo: H5P through LTI 1.3

A local Moodle 4.5 LTS connected to the kit's LTI tool (`examples/lti-provider`) and H5P server.
It shows the whole flow, with nothing installed in Moodle except a core "External tool":

1. **Admin** connects the tool by its registration URL (LTI Dynamic Registration).
2. **Teacher** adds an activity, clicks *Select content*, creates H5P content in the editor and
   chooses it (LTI Deep Linking).
3. **Student** opens the activity and answers. The score appears in the Moodle gradebook (AGS).

## Run it

```bash
# 1. Moodle (the first start installs Moodle and takes a few minutes)
cd demo/moodle && docker compose up -d
until curl -sf -o /dev/null http://localhost:8080/login/index.php; do sleep 5; done
cd ../..

# 2. H5P server (protected mode) and LTI tool, each in its own terminal, with the demo settings
set -a; . demo/moodle/demo.env; set +a; cd h5p-server && npm start
set -a; . demo/moodle/demo.env; set +a; cd examples/lti-provider && python app.py

# 3. Register the tool in Moodle (Dynamic Registration), add a course, teacher and student
demo/moodle/setup.sh
```

| Who | Login | Password |
|-----|-------|----------|
| Site admin | admin | Admin123! |
| Teacher | teacher | Demo123! |
| Student | student | Demo123! |

Automated run of steps 2 and 3, with Playwright: `node demo/moodle/e2e.mjs` (the student picks
the right answer) or `node demo/moodle/e2e.mjs wrong`. It exits non-zero if the
grade does not reach Moodle.

## Registering by hand instead of `setup.sh`

`setup.sh` does what an admin does in the browser. To show that part live, skip the
registration in `setup.sh` (or reset Moodle) and in Moodle go to *Site administration → Plugins →
Activity modules → External tool → Manage tools*. Paste `http://localhost:5001/lti/register` under
*Tool URL*, then click *Add LTI Advantage* and *Activate*. Set *Tool configuration usage* to "Show
in activity chooser" so teachers see it when they add an activity.

## How it is wired

- Moodle is the LTI platform, with issuer `http://localhost:8080`. The tool runs on your machine
  at `localhost:5001` and the H5P server at `localhost:3000`.
- Moodle calls the tool to fetch its public key. Inside the Moodle container, `localhost` is the
  container itself, so the `tool-forward` sidecar forwards `localhost:5001` there to the tool on
  your machine. That is why the tool listens on all interfaces in the demo (`HOST=0.0.0.0` in
  `demo.env`). `setup.sh` also clears Moodle's blocklist for local addresses
  (`curlsecurityblockedhosts`), which a real site does not need.
- Moodle (`localhost:8080`) and the tool (`localhost:5001`) count as the same site for cookies, so
  the iframe launch works over plain http. A real deployment on two domains needs https, because
  the tool's session cookie is `SameSite=None; Secure`.
- `demo.env` holds demo-only secrets. Make your own for anything else.

## Known quirks

- The `bitnamilegacy/*` images no longer get updates. They are fine for a local demo. For the
  "upgrade Moodle" part of the demo, `MOODLE_TAG=5.0 docker compose up -d` should upgrade the
  existing site. That hasn't been tried yet.
- On this image, the first login in a new browser session fails with "Invalid login". The
  second try works.
- Reset everything: `docker compose down -v`, and delete `examples/lti-provider/lti_data.db`.
