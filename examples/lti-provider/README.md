# H5P LTI 1.3 Tool Provider

An LTI 1.3 Tool Provider that allows external LMS platforms (Moodle, Canvas, Blackboard, etc.) to launch H5P content and receive grades via the Assignment and Grade Services (AGS).

## What is LTI?

**Learning Tools Interoperability (LTI)** is a standard for integrating external tools with Learning Management Systems. LTI 1.3 uses modern OAuth 2.0 / OpenID Connect authentication.

This tool provider allows any LTI 1.3 compliant LMS to:
1. Launch H5P content in an iframe
2. Receive completion scores back to the gradebook

## Features

- **LTI 1.3 Compliant**: Works with Moodle, Canvas, Blackboard, Brightspace, etc.
- **OIDC Authentication**: Secure OAuth 2.0 / OpenID Connect flow
- **Grade Passback**: Sends scores to LMS via Assignment and Grade Services
- **Content Picker**: Select H5P content if not specified in launch

## Quick Start

### Prerequisites

- Python 3.8+
- H5P server running at `http://localhost:3000`
- An LTI 1.3 capable LMS (Moodle, Canvas, etc.)

### Installation

```bash
# From this directory
pip install -r requirements.txt

# Generate RSA keys for LTI signing
openssl genrsa -out private.key 2048
openssl rsa -in private.key -pubout -out public.key

# Configure your LMS details (see Configuration section)
# Edit tool_config.json

# Run the tool provider
python app.py
```

### LTI Endpoints

| Endpoint | Purpose |
|----------|---------|
| `/lti/login` | OIDC Login Initiation URL |
| `/lti/launch` | Target Link URI (Launch URL) |
| `/.well-known/jwks.json` | JSON Web Key Set |
| `/lti/config` | Tool configuration (JSON) |
| `/lti/webhook` | Receives xAPI scores from H5P |

## Testing with Saltire (Quick Test)

[Saltire](https://saltire.lti.app/) is a free LTI testing platform - no signup required. It's the fastest way to test your LTI tool provider.

### Step 1: Start Your Servers

```bash
# Terminal 1: H5P Server
cd h5p-server && npm start

# Terminal 2: LTI Provider
cd examples/lti-provider && python app.py
```

### Step 2: Expose Your Local Server (Required)

Saltire needs to reach your local server. Use Cloudflare Tunnel (recommended) or similar:

```bash
# Install cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
cloudflared tunnel --url http://localhost:5001
```

Copy the HTTPS URL (e.g., `https://something-random.trycloudflare.com`)

> **Note**: Avoid ngrok free tier - its interstitial warning page breaks iframes and LTI launches.

### Step 3: Configure Saltire Platform

1. Go to https://saltire.lti.app/platform
2. Click **"Security Model"** in the left sidebar
3. In the **Security Model** section at the top, set:

| Saltire Field | Your Tool Value |
|---------------|-----------------|
| Message URL | `https://YOUR-TUNNEL-URL/lti/launch` |

4. Expand **"Tool Details"** section below and enter:

| Saltire Field | Your Tool Value |
|---------------|-----------------|
| Initiate login URL | `https://YOUR-TUNNEL-URL/lti/login` |
| Redirection URI(s) | `https://YOUR-TUNNEL-URL/lti/launch` |
| Public keyset URL | `https://YOUR-TUNNEL-URL/.well-known/jwks.json` |

5. Click **"Fetch"** next to Public keyset URL to load your tool's public key
6. Click **"Save"**

### Step 4: Configure Your Tool

Copy values from Saltire's **"Platform Details"** section into `tool_config.json`:

| Saltire Field | tool_config.json Key |
|---------------|---------------------|
| Platform/Issuer ID | (use as the top-level key) |
| Client ID | `client_id` |
| Deployment ID | `deployment_ids` (as array) |
| Authentication request URL | `auth_login_url` |
| Access Token service URL | `auth_token_url` |
| Public keyset URL | `key_set_url` |

Example `tool_config.json`:

```json
{
  "https://saltire.lti.app/platform": [{
    "default": true,
    "client_id": "saltire.lti.app",
    "deployment_ids": ["YOUR_DEPLOYMENT_ID"],
    "auth_login_url": "https://saltire.lti.app/platform/auth",
    "auth_token_url": "https://saltire.lti.app/platform/token/YOUR_TOKEN_ID",
    "key_set_url": "https://saltire.lti.app/platform/jwks/YOUR_JWKS_ID",
    "private_key_file": "private.key",
    "public_key_file": "public.key"
  }]
}
```

**Important**: Restart the tool after changing config: `python app.py`

### Step 5: Test the Launch

1. In Saltire, click **"Connect"** button (top right)
2. Select **"Perform launch"**
3. You should see the H5P content picker
4. Select content and interact with it
5. Grades should pass back to Saltire after completing H5P activities

### Troubleshooting Saltire

- **"Invalid redirect"**: Make sure tunnel URL matches exactly in both configs
- **"JWT validation failed"**: Restart app.py after changing tool_config.json
- **Tunnel URL changed**: Cloudflared URLs change on restart - update both configs

---

## Configuration

### 1. Generate RSA Keys

```bash
# Generate private key
openssl genrsa -out private.key 2048

# Extract public key
openssl rsa -in private.key -pubout -out public.key
```

### 2. Configure tool_config.json

Create `tool_config.json` with your LMS platform details:

```json
{
  "https://your-lms.edu": [{
    "default": true,
    "client_id": "client-id-from-lms",
    "deployment_ids": ["deployment-id-from-lms"],
    "auth_login_url": "https://your-lms.edu/mod/lti/auth.php",
    "auth_token_url": "https://your-lms.edu/mod/lti/token.php",
    "key_set_url": "https://your-lms.edu/mod/lti/certs.php",
    "private_key_file": "private.key",
    "public_key_file": "public.key"
  }]
}
```

### 3. Register Tool in Your LMS

#### Moodle

1. Go to Site Administration > Plugins > External tool > Manage tools
2. Click "configure a tool manually"
3. Enter:
   - Tool URL: `http://your-domain:5001/lti/launch`
   - LTI version: LTI 1.3
   - Public key type: Keyset URL
   - Public keyset: `http://your-domain:5001/.well-known/jwks.json`
   - Initiate login URL: `http://your-domain:5001/lti/login`
   - Redirection URI(s): `http://your-domain:5001/lti/launch`

#### Canvas

1. Go to Admin > Developer Keys > + Developer Key > + LTI Key
2. Configure with the same endpoints

## LTI Launch Flow

```
1. User clicks H5P activity in LMS
2. LMS redirects to /lti/login (OIDC initiation)
3. Tool provider redirects to LMS auth endpoint
4. User authenticates with LMS
5. LMS POST to /lti/launch with JWT
6. Tool validates JWT and extracts user/content info
7. H5P player shown in iframe
8. User completes activity
9. H5P sends score to /lti/webhook
10. Tool sends grade to LMS via AGS
```

## Custom Parameters

Pass the H5P content ID in the LTI launch custom parameters:

```
h5p_content_id=your-content-id
```

If not provided, users will see a content picker to choose content.

## Grade Passback

Grades are sent to the LMS using LTI Assignment and Grade Services (AGS):

1. H5P player sends xAPI completion event
2. Tool receives via `/lti/webhook`
3. Tool stores grade and sends to LMS AGS endpoint
4. Grade appears in LMS gradebook

## Files

```
examples/lti-provider/
├── app.py              # Flask LTI tool provider
├── requirements.txt    # Python dependencies
├── tool_config.json    # LMS configuration (create this)
├── private.key         # RSA private key (generate this)
├── public.key          # RSA public key (generate this)
├── lti_data.db         # SQLite database (auto-created)
└── README.md           # This file
```

## Environment Variables

```bash
SECRET_KEY=your-secret-key          # Flask session secret
H5P_SERVER=http://localhost:3000    # H5P server URL
APP_URL=http://localhost:5001       # This tool's URL
```

## Security Notes

- **Production**: Use HTTPS for all endpoints
- **Keys**: Keep `private.key` secret, never commit to git
- **Sessions**: Use Redis or database-backed sessions in production
- **Validation**: The tool validates all LTI messages using JWT signatures

## Troubleshooting

### "Invalid launch"
- Check that `tool_config.json` has correct LMS details
- Verify client_id and deployment_ids match LMS configuration

### "JWKS validation failed"
- Regenerate RSA keys
- Ensure public key is correctly registered in LMS

### "No grade passback"
- Verify LMS has AGS enabled for the tool
- Check that tool has score scope in LMS configuration

## LMS-Specific Notes

### Moodle
- Requires Moodle 3.7+ for LTI 1.3
- Enable "Accept grades from the tool" in tool settings

### Canvas
- Enable "Privacy: Send User Data" if needed
- Configure scopes in Developer Key settings

### Blackboard
- Use Blackboard Learn REST API for additional features
- Configure placement to enable deep linking
