#!/bin/bash
# =====================================================================
# 🚀 1-Click DigitalOcean Droplet Deploy Script for Airtable Outreach Bot
# =====================================================================
set -e

echo "========================================================"
echo "  Deploying Airtable Outreach Dashboard on DigitalOcean  "
echo "========================================================"

# 1. Update OS packages
apt-get update -y
apt-get install -y curl git ufw

# 2. Install Docker if missing
if ! command -v docker &> /dev/null; then
    echo "📦 Installing Docker..."
    curl -fsSL https://get.docker.com -o get-docker.sh
    sh get-docker.sh
    rm -f get-docker.sh
fi

# 3. Configure firewall
ufw allow 22/tcp || true
ufw allow 80/tcp || true
ufw allow 3000/tcp || true
ufw --force enable || true

# 4. App directory setup
APP_DIR="/opt/airtable-outreach-bot"
mkdir -p "$APP_DIR"
cd "$APP_DIR"

# 5. Environment file check
if [ ! -f .env ] && [ -f .env.example ]; then
    echo "⚙️ Creating default .env from .env.example..."
    cp .env.example .env
fi

# 6. Make update script executable and install 10-minute auto-update cron
chmod +x update.sh || true
(crontab -l 2>/dev/null | grep -v 'update.sh'; echo "*/10 * * * * /bin/bash /opt/airtable-outreach-bot/update.sh > /dev/null 2>&1") | crontab - || true

# 7. Build and launch container
echo "🐳 Launching via Docker Compose..."
docker compose down || true
docker compose up -d --build

SERVER_IP=$(curl -s ifconfig.me || curl -s icanhazip.com || hostname -I | awk '{print $1}')

echo ""
echo "========================================================"
echo "✅ DEPLOYMENT COMPLETE!"
echo ""
echo "🌐 Your Dashboard URL:"
echo "   http://${SERVER_IP}:3000"
echo ""
echo "🍏 Download Mac Extension directly from:"
echo "   http://${SERVER_IP}:3000/download-extension"
echo "========================================================"
