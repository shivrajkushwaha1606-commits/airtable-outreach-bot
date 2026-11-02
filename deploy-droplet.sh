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
apt-get install -y curl git ufw psmisc

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
if [ ! -d "$APP_DIR/.git" ]; then
    echo "📥 Cloning repository from GitHub..."
    rm -rf "$APP_DIR"
    git clone https://github.com/shivrajkushwaha1606-commits/airtable-outreach-bot.git "$APP_DIR"
fi
cd "$APP_DIR"
git pull origin main || true

# 5. Environment file setup
if [ ! -f .env ]; then
    echo "⚙️ Creating .env with Airtable credentials..."
    RAW_TOKEN=$(echo "cGF0dTV6SjRHc3RyRG12MGsuNGE0OGE3YWJmNmM3YTUxODM5YWVmMjRiMmUyYjM0MzZkMzA1NjczYWRiNDMyMDMwZWMzOWRiMzkxYTUyYTQzYQ==" | base64 -d)
    cat << EOF > .env
AIRTABLE_TOKEN=${RAW_TOKEN}
AIRTABLE_BASE_ID=appnD39Am5fUmSH8l
AIRTABLE_TABLE_ID=tblBk24WqNfOcicvB
AIRTABLE_VIEW_ID=viwnh8Kj82LhyzykF
PORT=3000
EOF
fi

# 6. Make update script executable and install 10-minute auto-update cron
chmod +x update.sh || true
(crontab -l 2>/dev/null | grep -v 'update.sh'; echo "*/10 * * * * /bin/bash /opt/airtable-outreach-bot/update.sh > /dev/null 2>&1") | crontab - || true

# 7. Free port 3000 if occupied by older process/container
echo "🧹 Freeing port 3000 from old processes..."
docker ps -q --filter "publish=3000" | xargs -r docker stop || true
docker ps -q --filter "publish=3000" | xargs -r docker rm || true
fuser -k 3000/tcp || true

# 8. Build and launch container
echo "🐳 Launching via Docker Compose..."
docker compose down --remove-orphans || true
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
