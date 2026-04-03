# SURFAI Deploy Guide

## Quick Start (first time)

SSH into the Timeweb server as root and run:

```bash
# Clone and run setup
git clone https://github.com/emaykro/surfai.git /tmp/surfai-setup
bash /tmp/surfai-setup/deploy/setup-server.sh
rm -rf /tmp/surfai-setup
```

The script will:
- Install Node.js 20 and PostgreSQL (if missing)
- Create a `surfai` system user
- Create a separate `surfai` database with a random password
- Clone the repo to `/opt/surfai`
- Generate `.env`, install deps, build SDK, run migrations
- Install and start the systemd service on port 3100
- Configure Nginx (separate server block from htracker.ru)
- Run a smoke test

## After setup

### 1. Verify

```bash
bash /opt/surfai/deploy/verify.sh
```

### 2. DNS

Point these DNS records to the server IP (in Timeweb panel or DNS provider):

| Type | Name | Value |
|------|------|-------|
| A | surfai.ru | YOUR_SERVER_IP |
| A | api.surfai.ru | YOUR_SERVER_IP |

### 3. TLS (Let's Encrypt)

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d surfai.ru -d api.surfai.ru
```

### 4. Dashboard protection (optional)

```bash
sudo apt install apache2-utils
sudo htpasswd -c /etc/nginx/.htpasswd-surfai admin
```

Then uncomment the `auth_basic` lines in `/etc/nginx/sites-available/surfai.conf` and reload:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

## Updating (after git push)

```bash
sudo bash /opt/surfai/deploy/update.sh
```

Or manually:

```bash
cd /opt/surfai
sudo -u surfai git pull origin main
sudo -u surfai npm install --omit=dev
sudo -u surfai npm run build
sudo -u surfai npm run migrate
sudo systemctl restart surfai
```

## SDK Integration

Add this snippet to any site you want to track. The SDK script should be loaded from your SURFAI server.

```html
<script type="module">
  import { SurfaiTracker } from 'https://surfai.ru/dist/tracker.js';

  const surfai = new SurfaiTracker({
    endpoint: 'https://surfai.ru/api/events',
    // Optional: auto-fire goals on URL match
    // pageGoals: [
    //   { goalId: 'thank-you', urlPattern: '/thank-you', matchType: 'contains' }
    // ],
    // Optional: capture GA4 dataLayer events as goals
    // dataLayerCapture: true,
    // dataLayerMappings: [
    //   { event: 'purchase', goalId: 'purchase' },
    //   { event: 'generate_lead', goalId: 'lead' }
    // ]
  });
  surfai.start();

  // Manual goal tracking:
  // surfai.goal('signup', { plan: 'pro' });
</script>
```

Important: add `https://YOUR-TRACKED-SITE.com` to `CORS_ORIGIN` in `/opt/surfai/.env` (comma-separated), then restart:

```bash
# Edit .env
sudo -u surfai nano /opt/surfai/.env
# CORS_ORIGIN=https://surfai.ru,https://api.surfai.ru,https://your-tracked-site.com

sudo systemctl restart surfai
```

## Training ML Baseline

After collecting real data (aim for at least 200-500 sessions with some conversions):

```bash
cd /opt/surfai

# Install Python deps (once)
pip3 install -r ml/requirements.txt

# Train on real data
python3 -m ml train

# Evaluate
python3 -m ml evaluate --model ml/artifacts/latest_model.cbm
```

## Useful Commands

```bash
# Service status
systemctl status surfai

# Live logs
journalctl -u surfai -f

# Restart
sudo systemctl restart surfai

# Check port
ss -tlnp | grep 3100

# Nginx test + reload
sudo nginx -t && sudo systemctl reload nginx

# Database shell
sudo -u surfai psql -d surfai
```

## Architecture on VPS

```
                    ┌─────────────────────────────────────────┐
                    │            Timeweb VPS                    │
Internet            │                                          │
  │                 │   Nginx (port 80/443)                    │
  │                 │     ├─ htracker.ru  → :XXXX (existing)   │
  ├─────────────────┤     └─ surfai.ru    → :3100 (new)        │
  │                 │                                          │
                    │   PostgreSQL                              │
                    │     ├─ htracker DB  (existing)            │
                    │     └─ surfai DB    (new, separate user)  │
                    └─────────────────────────────────────────┘
```
