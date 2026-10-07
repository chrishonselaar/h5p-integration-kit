# Hosting the H5P server and LTI tool

This stack runs everything an LMS needs to use H5P through LTI 1.3:

| Service | What it does | Public URL (example) |
|---------|--------------|----------------------|
| `h5p-server` | Stores and plays H5P content; the editor (protected mode) | `https://h5p.example.org` |
| `lti-tool` | Connects LMSes: registration, launches, content picker, grades | `https://lti.example.org` |
| `postgres` | The tool's database: connected LMSes, launches, scores, who owns which content | not public |

## Start

```bash
cd deploy
cp .env.example .env        # fill in both public URLs and the secrets
docker compose up -d --build
docker compose ps           # all three healthy
```

Choose `LTI_PUBLIC_URL` before the first LMS connects. The LMS stores it at registration, so
changing it later means registering again.

Both services listen on `127.0.0.1` only. Put an https reverse proxy in front: one host name per
service, forwarding to `H5P_PORT` and `LTI_PORT`. https is required. The LMS shows the tool in an
iframe, and browsers only send its session cookie cross-site over https. A minimal nginx server
block per host:

```nginx
server {
    listen 443 ssl;
    server_name lti.example.org;              # and h5p.example.org -> H5P_PORT
    ssl_certificate     /etc/letsencrypt/live/lti.example.org/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/lti.example.org/privkey.pem;
    client_max_body_size 500m;                # H5P uploads (video) go to the H5P server
    location / {
        proxy_pass http://127.0.0.1:5001;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

## Connect an LMS

Give the LMS admin `https://lti.example.org/lti/register?key=<LTI_REGISTRATION_KEY>`. See
`examples/lti-provider/README.md` for the Moodle steps and for LMSes without Dynamic Registration.

```bash
docker compose exec lti-tool flask --app app list-platforms
```

## Run regularly

```bash
# Send grades an LMS did not accept (e.g. it was down), every 15 minutes from cron:
docker compose exec -T lti-tool flask --app app retry-grades
# Data retention: delete launches and scores older than the agreed period, daily:
docker compose exec -T lti-tool flask --app app purge --days 400
```

## Back up

| What | Where | Why it matters |
|------|-------|----------------|
| Database | `docker compose exec -T postgres pg_dump -U lti lti > lti.sql` | Without it, connected LMSes and content ownership are lost |
| H5P content and libraries | volume `h5p_data` | All H5P content |
| Tool keys | volume `lti_keys` | A new key pair breaks grade passback until every LMS has fetched the new public key |

## Update

- **Kit code:** `git pull && docker compose up -d --build`. The tool creates new tables itself
  on start. Nothing changes in the LMSes.
- **H5P content types** (libraries): log in to the H5P server as admin (`/login`), open the editor
  (`/new`) and install or update content types from the H5P Hub. Teachers can't install content
  types: an editor ticket doesn't allow it.
- **H5P core and editor files:** they come from `h5p-server/h5p/core` and `h5p-server/h5p/editor`
  in this repository, mounted read-only.

## Limits of this setup

- One H5P server instance: content is stored on the `h5p_data` volume. To run more instances,
  Lumi's H5P server supports MongoDB/S3 storage, which this kit doesn't wire up yet.
- One admin account on the H5P server (shared password). Teachers never need it.
