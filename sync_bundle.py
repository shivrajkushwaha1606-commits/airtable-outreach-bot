import sys
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

import os
import shutil
import zipfile

src = r"C:\Users\shivr.SHIVA\.gemini\antigravity\scratch\airtable-outreach-bot"
brave_dst = r"C:\Users\shivr.SHIVA\AppData\Local\BraveSoftware\Brave-Browser\User Data\Default\UnpackedExtensions\airtable-outreach-bot_14912_1218612043"
zip_dst = r"C:\Users\shivr.SHIVA\Downloads\airtable-outreach-bot.zip"

files_to_sync = [
    "manifest.json",
    "background.js",
    "content.js",
    "airtable_content.js",
    "youtube_content.js",
    "popup.html",
    "popup.css",
    "popup.js",
    "dashboard.html",
    "dashboard.css",
    "server.py",
    "server.js",
    "README.md",
    "package.json",
    "Dockerfile",
    "docker-compose.yml",
    "deploy-droplet.sh"
]

print("1. Syncing to Brave Unpacked directory...")
if os.path.exists(brave_dst):
    for f in files_to_sync:
        sp = os.path.join(src, f)
        dp = os.path.join(brave_dst, f)
        if os.path.exists(sp):
            shutil.copy2(sp, dp)
    
    # Sync icons
    src_icons = os.path.join(src, "icons")
    dst_icons = os.path.join(brave_dst, "icons")
    if os.path.exists(src_icons):
        os.makedirs(dst_icons, exist_ok=True)
        for icon in os.listdir(src_icons):
            shutil.copy2(os.path.join(src_icons, icon), os.path.join(dst_icons, icon))
    print("SUCCESS: Copied all files to Brave Unpacked directory!")
else:
    print("Brave destination not found:", brave_dst)

print("2. Packaging ZIP to Downloads...")
with zipfile.ZipFile(zip_dst, "w", zipfile.ZIP_DEFLATED) as z:
    for f in files_to_sync:
        sp = os.path.join(src, f)
        if os.path.exists(sp):
            z.write(sp, arcname=f)
    src_icons = os.path.join(src, "icons")
    if os.path.exists(src_icons):
        for icon in os.listdir(src_icons):
            z.write(os.path.join(src_icons, icon), arcname=f"icons/{icon}")

print(f"SUCCESS: Created {zip_dst} ({os.path.getsize(zip_dst)} bytes)")
