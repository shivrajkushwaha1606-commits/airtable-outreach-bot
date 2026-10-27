# 🚀 Airtable Creator Outreach & Social Enrichment Bot (Brave Extension)

A specialized Chrome/Brave Manifest V3 extension built for **Agency Engine** to automate creator outreach, locate missing social channels, generate personalized pitch templates, and synchronize status with Airtable in real-time.

---

## ✨ Features

### 1. 🔍 Automated Social Media Finder & Enrichment (NEW)
- **Filter Creators Missing Socials**: Filter dropdown with options for `Missing Any Socials`, `Missing Instagram`, `Missing Twitter/X`, `Missing Discord`, `Missing Email`, and `Missing YouTube`.
- **1-Click "Auto-Find Socials" Button**: On any creator card, click **🔍 Auto-Find Socials** to:
  - Search YouTube for the creator's channel if not yet known.
  - Parse the creator's `/about` page to extract official Twitter/X handles, Instagram profiles, Discord invite links, and business emails.
  - Automatically update the record in Airtable via the REST API with instant visual confirmation.
- **Dedicated Social Finder Tab**:
  - Live statistics grid tracking channels missing socials.
  - **⚡ Auto-Find All Missing Socials**: Batch enrichment mode with live progress bar and event logs.
  - **🌐 Web Search**: Direct fallback to search Brave/Google for obscure creators with pre-formatted search queries.

### 2. 🎯 Creator Queue & Targeted Outreach
- **Real-time Airtable Sync**: Automatically loads creators directly from table `tblBk24WqNfOcicvB` in base `appnD39Am5fUmSH8l`.
- **Platform Action Chips**:
  - `𝕏 Open Profile / DM`: Automatically copies the personalized pitch to clipboard and opens the creator's Twitter/X page.
  - `✉ Compose Email`: Opens a pre-filled Gmail compose window with subject line and personalized body pitch.
  - `💬 Open Discord`: Copies pitch and opens the Discord server invite.
  - `📷 Open Instagram`: Copies pitch and opens creator's Instagram profile.
  - `▶ YouTube`: Direct link to view their latest uploads and content.
- **Auto-Queue Runner**: Hands-free sequential outreach with configurable delay between creators.
- **1-Click Status Update**: `✓ Mark Messaged in Airtable` sets the record status to `Messaged` and updates `Last Touch Date`.

---

## 🛠️ Installation / Reload in Brave

1. Open Brave and navigate to `brave://extensions`.
2. Ensure **Developer mode** (top-right toggle) is **ON**.
3. If the extension is already loaded:
   - Click the **🔄 Reload** icon on the **Airtable Creator Outreach Bot** card.
4. If not loaded:
   - Click **Load unpacked** (top-left).
   - Select the directory:
     `C:\Users\shivr.SHIVA\.gemini\antigravity\scratch\airtable-outreach-bot`
