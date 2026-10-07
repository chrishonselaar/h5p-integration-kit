# H5P LTI 1.3 Tool

Puts H5P content from the kit's H5P server into Moodle, Canvas, Brightspace or any other LMS
with LTI 1.3. Nothing is installed in the LMS: it uses its standard "External tool". So an LMS
upgrade cannot break it, as long as the LMS keeps supporting the LTI standard.

What each person does:

| Who | What they do | LTI feature |
|-----|--------------|-------------|
| LMS admin | Pastes one registration URL; the LMS and the tool exchange keys | Dynamic Registration |
| Teacher | Adds an activity, picks existing H5P content or creates new content in the H5P editor | Deep Linking |
| Student | Opens the activity and plays the content; the score lands in the gradebook | Resource link launch, Assignment and Grade Services (AGS) |

Every connected LMS (a *platform*) is a separate tenant. Its teachers see and edit only the
content made from that platform.

A local Moodle with all of this set up is in [`demo/moodle`](../../demo/moodle/README.md).

## Run it

```bash
pip install -r requirements.txt
python app.py                  # http://localhost:5001
```

On first start the tool creates its RSA key pair (`private.key`, `public.key`) and its database
(SQLite `lti_data.db`). For production, run it with gunicorn behind https:

```bash
gunicorn --preload -w 4 -b 0.0.0.0:5001 app:app
```

### Settings

| Variable | Default | What it is |
|----------|---------|------------|
| `APP_URL` | `http://localhost:5001` | The tool's public URL. The LMS stores it at registration, so choose it before you register |
| `H5P_SERVER` | `http://localhost:3000` | The H5P server as the browser sees it (player and editor) |
| `H5P_TOOL_SECRET` | *(unset)* | The same secret as the H5P server's `H5P_TOOL_SECRET`. The tool signs editor tickets with it, so teachers can create and edit content on a protected H5P server. Unset only works with an open (development) H5P server |
| `H5P_API_TOKEN` | *(unset)* | The H5P server's admin password, for the `assign-content` command |
| `H5P_ORG` | *(unset)* | The organisation these LMSes belong to on the H5P server (the H5P server's `H5P_ACCOUNTS` organisations). Sent in editor tickets, so plugins such as a slide library show that organisation's files in the editor |
| `DATABASE_URL` | `sqlite:///lti_data.db` | `postgresql+psycopg://user:password@host/db` for PostgreSQL. Tables are created on start |
| `SECRET_KEY` | *(a fixed development value)* | Signs the session cookie and form tokens. **Set a long random value in production** |
| `LTI_REGISTRATION_KEY` | *(unset)* | When set, the registration URL only works with `?key=<value>`, so only LMSes you gave the key to can connect |
| `LTI_TOOL_NAME` | `H5P (hosted)` | The tool's name in the LMS (activity chooser). Not plain "H5P": Moodle has a core activity with that name |
| `LTI_KEY_DIR` | the tool's folder | Where `private.key` and `public.key` are kept (created there on first start). Back this up: a new key pair means every LMS has to fetch the new public key |
| `HOST`, `PORT` | `127.0.0.1`, `5001` | Where `python app.py` listens |

The H5P server should run in protected mode (`H5P_ADMIN_PASSWORD`) with the same
`H5P_TOOL_SECRET`. Then playing content is public, and editing is only possible with the admin
password or a ticket from this tool.

## Connect an LMS

**With Dynamic Registration** (Moodle 4.1+, Canvas, Brightspace, Sakai): give the LMS admin
`APP_URL/lti/register`, with `?key=…` if you set `LTI_REGISTRATION_KEY`.

- In Moodle: *Site administration → Plugins → Activity modules → External tool → Manage tools*.
  Paste the URL under *Tool URL*, choose *Add LTI Advantage*, then *Activate* the new tool.
- To have teachers find it in the activity chooser, set the tool's *Tool configuration usage*
  to "Show in activity chooser and as a preconfigured tool".

**By hand** (an LMS without Dynamic Registration): register the tool with the values from
`APP_URL/lti/config`, then tell the tool about the LMS:

```bash
flask --app app add-platform --issuer https://lms.example.org --client-id <id> --deployment-id <id> \
  --auth-login-url https://lms.example.org/mod/lti/auth.php \
  --auth-token-url https://lms.example.org/mod/lti/token.php \
  --key-set-url https://lms.example.org/mod/lti/certs.php
```

Platforms in an older `tool_config.json` are imported into the database on start.

## How it works

```
LMS ──(OIDC login, signed launch)──▶ /lti/login, /lti/launch
      teacher, Deep Linking ──▶ picker ──▶ /lti/editor ──(signed ticket)──▶ H5P server editor
                                   ◀── /lti/editor/done (signed by the H5P server) records the owner
                          picker ──"Use this"──▶ signed Deep Linking response ──▶ LMS creates the activity
      student ──▶ player page ──iframe──▶ H5P server /play/<id>
                  player page ◀──postMessage (xAPI result)── H5P player
                  player page ──▶ /lti/score ──AGS──▶ LMS gradebook
```

- **Scores.** The H5P player posts its xAPI results to the tool's player page with `postMessage`.
  The page posts them to `/lti/score`, which only accepts a launch from the same browser session,
  with a token bound to that launch, for the content of that launch. Only the score for the
  whole content counts, not the scores of questions inside a container. Then the tool sends it to
  the activity's line item with AGS. A grade the LMS did not accept stays in the `scores` table:
  `flask --app app retry-grades` sends it again.
- **As with every H5P integration, the score is computed in the browser.** A student who
  manipulates their own browser can report a higher score for themselves (Moodle's own H5P
  plugins have the same limit). They cannot report scores for other students or other
  activities. Don't use H5P scores for high-stakes exams.
- **Tenants.** The `contents` table records which platform owns which content. The picker,
  preview, editor and Deep Linking only show or accept that platform's content. Content that
  belongs to no platform (e.g. imported by the H5P server admin) can be played, and given to a
  platform with `flask --app app assign-content <content_id> <platform_id>`.
- **Sessions.** The LMS shows the tool in an iframe on another site, so the session cookie is
  `SameSite=None; Secure`. That needs https (or `localhost`) in the browser.

## Endpoints

| Endpoint | For |
|----------|-----|
| `/lti/register` | Dynamic Registration (LMS admin) |
| `/lti/login`, `/lti/launch` | OIDC login and launch (the LMS) |
| `/.well-known/jwks.json` | The tool's public key (the LMS checks grade and Deep Linking messages with it) |
| `/lti/picker`, `/lti/deep-link`, `/lti/preview/<id>`, `/lti/editor`, `/lti/editor/done` | Teachers, within a launch |
| `/lti/score` | The player page, within a launch |
| `/lti/config` | Values for registering by hand |
| `/health` | Monitoring |

## Commands

```bash
flask --app app list-platforms
flask --app app add-platform ...           # see above
flask --app app assign-content <content_id> <platform_id>
flask --app app retry-grades               # e.g. from cron every 15 minutes
flask --app app purge --days 400           # delete launches and scores older than 400 days
```

## Personal data

The tool asks the LMS for no names or e-mail addresses: its registration requests only `iss`
and `sub`, the LMS's own pseudonymous user id. Moodle then sends neither, and the tool doesn't
need them. The tool stores that id with each launch and score, plus who created which content.
The LMS remains the place where grades and student identities live. `purge` deletes old launches
and scores, for a retention period agreed with the customer.

## Tests

```bash
pip install pytest
pytest tests                                                         # SQLite
DATABASE_URL=postgresql+psycopg://user:pw@localhost/db pytest tests  # PostgreSQL
```

The tests cover tenant isolation, teacher-only pages, editor tickets and the score endpoint,
with two simulated platforms. The full flow in a real Moodle is `demo/moodle/e2e.mjs`.

## Files

```
app.py            routes, LTI handling, commands
store.py          database (platforms, launches, scores, contents, cache)
templates/        pages for teachers, students and LMS admins
static/tool.css
tests/            pytest
```
