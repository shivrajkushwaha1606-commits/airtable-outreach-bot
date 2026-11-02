#!/bin/bash
# =====================================================================
# 🔄 1-Command Auto-Updater for DigitalOcean Droplet
# =====================================================================
set -e

cd /opt/airtable-outreach-bot
echo "📥 Pulling latest updates from GitHub..."
git pull origin main

echo "🐳 Rebuilding and reloading container..."
docker compose up -d --build

echo "✅ Successfully updated to latest version!"
