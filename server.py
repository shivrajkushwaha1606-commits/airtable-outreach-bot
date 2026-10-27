#!/usr/bin/env python3
"""
Airtable Outreach Bot - Standalone Web Server
Runs anywhere (DigitalOcean Droplet, App Platform, Mac, Linux, Windows) with Python 3.
Zero external dependencies required (uses built-in standard library).
"""

import http.server
import socketserver
import json
import os
import sys
import re
import urllib.request
import urllib.parse
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor
import zipfile
import io

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

PORT = int(os.environ.get("PORT", 3000))
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

def load_dotenv():
    env_file = os.path.join(BASE_DIR, ".env")
    if os.path.exists(env_file):
        try:
            with open(env_file, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith("#") and "=" in line:
                        k, v = line.split("=", 1)
                        os.environ.setdefault(k.strip(), v.strip())
        except Exception:
            pass

load_dotenv()

AIRTABLE_TOKEN = os.environ.get("AIRTABLE_TOKEN", "")
AIRTABLE_BASE_ID = os.environ.get("AIRTABLE_BASE_ID", "appnD39Am5fUmSH8l")
AIRTABLE_TABLE_ID = os.environ.get("AIRTABLE_TABLE_ID", "tblBk24WqNfOcicvB")
AIRTABLE_VIEW_ID = os.environ.get("AIRTABLE_VIEW_ID", "viwnh8Kj82LhyzykF")

def parse_subs(text):
    if not text: return None
    clean = re.sub(r'subscribers?', '', str(text), flags=re.IGNORECASE).strip()
    m = re.match(r'^([\d,.]+)\s*([kmb])?$', clean, re.IGNORECASE)
    if not m: return None
    try:
        val = float(m.group(1).replace(',', ''))
        unit = (m.group(2) or '').lower()
        if unit == 'k': val *= 1000
        elif unit == 'm': val *= 1000000
        elif unit == 'b': val *= 1000000000
        return int(val)
    except:
        return None

def generate_search_queries(q):
    clean = q.strip()
    w = clean.lower()
    queries = [clean]
    if 'roblox' in w:
        queries.extend([
            f"{clean} Brookhaven", f"{clean} Blox Fruits", f"{clean} Bedwars",
            f"{clean} Blade Ball", f"{clean} Adopt Me", f"{clean} Murder Mystery",
            f"{clean} Doors", f"{clean} Tower Defense", f"{clean} Arsenal",
            f"{clean} Dress To Impress", f"{clean} Da Hood", f"{clean} Tycoon",
            f"{clean} Simulator", f"{clean} Obby", f"{clean} gameplay",
            f"{clean} roleplay", f"{clean} horror", f"{clean} scary",
            f"{clean} challenges", f"{clean} animation", f"{clean} funny moments"
        ])
    elif 'minecraft' in w:
        queries.extend([
            f"{clean} survival", f"{clean} hardcore", f"{clean} smp",
            f"{clean} modded", f"{clean} bedwars", f"{clean} speedrun",
            f"{clean} build", f"{clean} redstone", f"{clean} challenges",
            f"{clean} roleplay", f"{clean} server", f"{clean} 100 days"
        ])
    elif 'fortnite' in w:
        queries.extend([
            f"{clean} battle royale", f"{clean} ranked", f"{clean} montage",
            f"{clean} creative", f"{clean} tournament", f"{clean} zero build",
            f"{clean} gameplay", f"{clean} funny"
        ])
    else:
        queries.extend([
            f"{clean} channel", f"{clean} videos", f"{clean} creator",
            f"{clean} daily", f"{clean} tips", f"{clean} podcast",
            f"{clean} review", f"{clean} tutorial", f"{clean} guide",
            f"{clean} breakdown", f"{clean} highlights", f"{clean} live"
        ])
    return queries

def fetch_search_candidates(query, max_subs=2000000, min_subs=0):
    url = f"https://www.youtube.com/results?search_query={urllib.parse.quote(query)}&sp=EgIQAg%253D%253D"
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'})
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            html = resp.read().decode('utf-8', errors='ignore')
    except Exception:
        return []
        
    m = re.search(r'ytInitialData\s*=\s*({.+?});</script>', html)
    if not m:
        return []
    
    try:
        data = json.loads(m.group(1))
    except Exception:
        return []
    
    def find_renderers(obj):
        if isinstance(obj, dict):
            if 'channelRenderer' in obj:
                yield obj['channelRenderer']
            for v in obj.values():
                yield from find_renderers(v)
        elif isinstance(obj, list):
            for item in obj:
                yield from find_renderers(item)

    candidates = []
    for cr in find_renderers(data):
        title = cr.get('title', {}).get('simpleText') or (cr.get('title', {}).get('runs', [{}])[0].get('text') if cr.get('title', {}).get('runs') else '')
        ch_id = cr.get('channelId')
        base_url = cr.get('navigationEndpoint', {}).get('browseEndpoint', {}).get('canonicalBaseUrl', '')
        
        sub_str = cr.get('videoCountText', {}).get('simpleText') or cr.get('subscriberCountText', {}).get('simpleText') or ''
        vid_str = cr.get('subscriberCountText', {}).get('simpleText') or ''
        
        if 'subscriber' not in sub_str.lower() and 'subscriber' in vid_str.lower():
            sub_str, vid_str = vid_str, sub_str
            
        subs = parse_subs(sub_str)
        
        thumbs = cr.get('thumbnail', {}).get('thumbnails', [{}])
        avatar = thumbs[-1].get('url', '') if thumbs else ''
        if avatar.startswith('//'):
            avatar = 'https:' + avatar
            
        handle = base_url.replace('/@', '@') if base_url else (f"@{ch_id}" if ch_id else "")

        if max_subs is not None and subs is not None and subs > max_subs:
            continue
        if min_subs is not None and subs is not None and subs < min_subs:
            continue
            
        candidates.append({
            'channelId': ch_id,
            'name': title,
            'handle': handle,
            'url': f"https://www.youtube.com{base_url}" if base_url else f"https://www.youtube.com/channel/{ch_id}",
            'avatar': avatar,
            'subscribers': subs,
            'subscribersText': sub_str or "Hidden subs",
            'videoCountText': vid_str
        })
    return candidates

def get_channel_country(ch_id):
    if not ch_id: return None
    try:
        url = f"https://www.youtube.com/channel/{ch_id}/about"
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'})
        with urllib.request.urlopen(req, timeout=2.5) as resp:
            html = resp.read().decode('utf-8', errors='ignore')
        m = re.search(r'"country"\s*:\s*"([^"]+)"', html)
        if m:
            return m.group(1)
    except Exception:
        pass
    return None

def is_valid_english_creator(channel_name, handle, titles, descriptions, country=None):
    text_corpus = f"{channel_name} {handle} " + " ".join(titles) + " " + " ".join(descriptions)
    text_lower = text_corpus.lower()

    # 1. Country blocklist for strictly non-English regions
    if country:
        c_lower = country.lower().strip()
        blocked_countries = [
            'india', 'pakistan', 'bangladesh', 'nepal', 'sri lanka',
            'mexico', 'brazil', 'spain', 'argentina', 'colombia', 'chile', 'peru', 'venezuela',
            'russia', 'ukraine', 'belarus', 'indonesia', 'philippines', 'vietnam',
            'thailand', 'turkey', 'japan', 'korea', 'taiwan', 'france', 'germany', 'italy'
        ]
        if any(bc in c_lower for bc in blocked_countries):
            return False, f"Non-English Country: {country}"

    # 2. Non-Latin scripts check (Devanagari, Cyrillic, Arabic, Asian)
    if re.search(r'[\u0900-\u097F]', text_corpus):
        return False, "Devanagari script detected"
    if re.search(r'[\u0400-\u04FF]', text_corpus):
        return False, "Cyrillic script detected"
    if re.search(r'[\u0600-\u06FF]', text_corpus):
        return False, "Arabic/Urdu script detected"
    if re.search(r'[\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]', text_corpus):
        return False, "Asian script detected"

    # 3. Hindi / Indian keywords and creator names (blocks Sujal, Carry Mini, etc.)
    hindi_keywords = [
        r'\bbhai\b', r'\bkya\b', r'\bkaise\b', r'\baaj\b', r'\bmaine\b', r'\bhumne\b',
        r'\bmera\b', r'\bmeri\b', r'\bmere\b', r'\bdost\b', r'\bdoston\b', r'\bdekho\b',
        r'\bkaha\b', r'\byeh\b', r'\bwoh\b', r'\bkar diya\b', r'\bkar payenge\b',
        r'\bchupaye\b', r'\bchupaya\b', r'\broblox hindi\b', r'\bhindi gaming\b',
        r'\bcarrydepie\b', r'\bsujal\b', r'\bchhotu\b', r'\bbhaiya\b', r'\baap dekhoge\b',
        r'\bhindi\b', r'\bindia\b', r'\bdesi\b'
    ]
    for hk in hindi_keywords:
        if re.search(hk, text_lower):
            return False, f"Hindi/Indian keyword: {hk}"

    # 4. Spanish / Portuguese accents and common gaming phrases (blocks Michi, etc.)
    if re.search(r'[ñ¡¿áéíóú]', text_lower):
        return False, "Spanish/Portuguese accented characters detected"

    spanish_words = [
        r'\ben vivo\b', r'\bjugando\b', r'\bescondidas\b', r'\bsobrevivir\b', r'\bactualizaci[oó]n\b',
        r'\bpartida\b', r'\btodos\b', r'\bvamos por\b', r'\bsuscr[ií]bete\b', r'\bjuego\b',
        r'\bamigos\b', r'\bcapitulo\b', r'\bmuerte\b', r'\bgana\b', r'\bnunca\b',
        r'\bde terror\b', r'\bel ultimo\b', r'\bcon mis\b', r'\bpara ganar\b', r'\bno me lo creo\b',
        r'\bjogando\b', r'\bn[aã]o\b', r'\bmuito\b', r'\bvoc[eê]\b'
    ]
    for sw in spanish_words:
        if re.search(sw, text_lower):
            return False, f"Spanish/Portuguese phrase: {sw}"

    # 5. Automated Repetitive Live Stream Spam (blocks Hima Roblox style spam)
    if titles:
        cleaned_titles = [re.sub(r'[^a-z0-9]', '', t.lower()) for t in titles if len(t.strip()) > 0]
        if len(cleaned_titles) >= 3:
            unique_ratio = len(set(cleaned_titles)) / float(len(cleaned_titles))
            if unique_ratio < 0.5:
                return False, f"Automated repetitive titles ({unique_ratio:.2f} unique ratio)"
        live_stream_count = sum(1 for t in titles if 'live playing' in t.lower() or 'live stream' in t.lower() or '#robloxlive' in t.lower())
        if live_stream_count >= 2:
            return False, f"Automated repetitive live streams ({live_stream_count} streams)"

    return True, "Valid English Channel"

def audit_channel_rss(c, max_last_upload_days=30, min_freq_per_week=0, min_views=0, content_type="long_form", language="en"):
    ch_id = c.get('channelId')
    if not ch_id:
        return None
    rss_url = f"https://www.youtube.com/feeds/videos.xml?channel_id={ch_id}"
    now = datetime.now(timezone.utc)
    try:
        r_req = urllib.request.Request(rss_url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(r_req, timeout=3.5) as r_resp:
            xml_text = r_resp.read().decode('utf-8')
        
        root = ET.fromstring(xml_text)
        ns = {'atom': 'http://www.w3.org/2005/Atom'}
        entries = root.findall('atom:entry', ns)
        
        if not entries:
            return None
            
        videos = []
        titles = []
        descriptions = []
        for entry in entries:
            v_title = entry.find('atom:title', ns).text or ''
            link_el = entry.find('atom:link', ns)
            v_link = link_el.attrib.get('href', '') if link_el is not None else ''
            pub_str = entry.find('atom:published', ns).text
            pub_dt = datetime.fromisoformat(pub_str)
            days_ago = (now - pub_dt).total_seconds() / 86400.0
            st = entry.find('.//{http://search.yahoo.com/mrss/}statistics')
            v_views = int(st.attrib.get('views', 0)) if st is not None else 0
            desc_el = entry.find('.//{http://search.yahoo.com/mrss/}description')
            v_desc = (desc_el.text or '') if desc_el is not None else ''

            titles.append(v_title)
            if v_desc: descriptions.append(v_desc[:120])

            is_short = ('/shorts/' in v_link) or ('#shorts' in v_title.lower()) or ('#short' in v_title.lower())
            videos.append({
                'title': v_title,
                'link': v_link,
                'days_ago': days_ago,
                'date': pub_str,
                'views': v_views,
                'is_short': is_short
            })

        # Strict English / Spam filtering
        if language == "en":
            country = get_channel_country(ch_id)
            c['country'] = country or ""
            is_valid, reason = is_valid_english_creator(
                c.get('name', ''),
                c.get('handle', ''),
                titles,
                descriptions,
                country=country
            )
            if not is_valid:
                return None

        shorts = [v for v in videos if v['is_short']]
        long_forms = [v for v in videos if not v['is_short']]
        shorts_count = len(shorts)
        long_count = len(long_forms)

        # Content Type filtering
        if content_type == 'long_form':
            # Strictly filter out channels that only upload Shorts!
            if long_count == 0:
                return None
            target_videos = long_forms
        elif content_type == 'shorts_only':
            if shorts_count == 0:
                return None
            target_videos = shorts
        else:
            target_videos = videos

        if not target_videos:
            return None

        latest_vid = target_videos[0]
        last_days = round(latest_vid['days_ago'], 1)
        
        # Explicit max last upload days filter (respecting user choice)
        if max_last_upload_days and last_days > max_last_upload_days:
            return None

        in_30 = len([v for v in target_videos if v['days_ago'] <= 30])

        # Calculate frequency
        if in_30 >= 3:
            recent_in_30 = [v for v in target_videos if v['days_ago'] <= 30]
            span_days = max(recent_in_30[-1]['days_ago'], 3.5)
            freq_per_week = round(len(recent_in_30) / (span_days / 7.0), 1)
        else:
            freq_per_week = round(in_30 / 4.2, 1)

        # Calculate average views on target videos
        views_list = [v['views'] for v in target_videos if v.get('views') and v['views'] > 0]
        avg_views = round(sum(views_list) / len(views_list)) if views_list else 0

        # Filter by min_views if requested
        if min_views and avg_views < min_views:
            return None

        # Format view text
        if avg_views >= 1000000:
            views_text = f"~{avg_views/1000000:.1f}M views".replace(".0M", "M")
        elif avg_views >= 1000:
            views_text = f"~{avg_views/1000:.1f}K views".replace(".0K", "K")
        elif avg_views > 0:
            views_text = f"~{avg_views} views"
        else:
            views_text = ""

        content_format = 'long_form' if (long_count > 0 and shorts_count == 0) else ('mixed' if (long_count > 0 and shorts_count > 0) else 'shorts_only')

        c['lastUploadDaysAgo'] = last_days
        c['lastUploadText'] = f"{int(last_days)}d ago" if last_days >= 1 else "Today"
        c['latestVideoTitle'] = latest_vid['title']
        c['frequencyPerWeek'] = freq_per_week
        c['frequencyText'] = f"~{freq_per_week} vids/wk"
        c['avgViews'] = avg_views
        c['avgViewsText'] = views_text
        c['longFormCount'] = long_count
        c['shortsCount'] = shorts_count
        c['contentFormat'] = content_format

        is_exact = (min_freq_per_week == 0 or freq_per_week >= min_freq_per_week)
        return (is_exact, c)
    except Exception:
        return None

def search_youtube_channels(query, max_subs=2000000, min_subs=0, max_last_upload_days=30, min_freq_per_week=0, min_views=0, limit=15, content_type="long_form", language="en"):
    queries = generate_search_queries(query)
    results = []
    near_matches = []
    seen_ids = set()

    # Search queries in parallel batches of 4
    batch_size = 4
    for i in range(0, len(queries), batch_size):
        if len(results) >= limit:
            break
        query_batch = queries[i:i + batch_size]
        
        batch_candidates = []
        with ThreadPoolExecutor(max_workers=batch_size) as q_ex:
            q_futures = [q_ex.submit(fetch_search_candidates, q, max_subs=max_subs, min_subs=min_subs) for q in query_batch]
            for q_f in q_futures:
                try:
                    cands = q_f.result()
                    for c in cands:
                        ch_id = c.get('channelId')
                        if ch_id and ch_id not in seen_ids:
                            seen_ids.add(ch_id)
                            batch_candidates.append(c)
                except Exception:
                    pass

        if not batch_candidates:
            continue

        with ThreadPoolExecutor(max_workers=10) as r_ex:
            r_futures = [
                r_ex.submit(
                    audit_channel_rss,
                    c,
                    max_last_upload_days=max_last_upload_days,
                    min_freq_per_week=min_freq_per_week,
                    min_views=min_views,
                    content_type=content_type,
                    language=language
                )
                for c in batch_candidates
            ]
            for r_f in r_futures:
                try:
                    res = r_f.result()
                    if res:
                        is_exact, ch = res
                        if is_exact:
                            results.append(ch)
                            if len(results) >= limit:
                                break
                        elif min_freq_per_week and ch.get('frequencyPerWeek', 0) >= (min_freq_per_week * 0.5):
                            near_matches.append(ch)
                except Exception:
                    pass

    # Guaranteed fulfillment: if exact frequency matches are fewer than limit, backfill with top active near-matches
    if len(results) < limit and near_matches:
        near_matches.sort(key=lambda x: x.get('frequencyPerWeek', 0), reverse=True)
        res_ids = set(r['channelId'] for r in results)
        for nm in near_matches:
            if nm['channelId'] not in res_ids:
                results.append(nm)
                res_ids.add(nm['channelId'])
                if len(results) >= limit:
                    break

    return results

class OutreachHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE_DIR, **kwargs)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        # 1. Health check
        if path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"status": "healthy", "service": "airtable-outreach-bot"}).encode("utf-8"))
            return

        # 1.1 Config sync
        if path == "/api/config":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({
                "airtableToken": AIRTABLE_TOKEN,
                "airtableBaseId": AIRTABLE_BASE_ID,
                "airtableTableId": AIRTABLE_TABLE_ID,
                "airtableViewId": AIRTABLE_VIEW_ID
            }).encode("utf-8"))
            return

        # 1b. 1-Click Droplet Install Script
        if path == "/install.sh":
            host = self.headers.get("Host", "760de761a94902.lhr.life")
            proto = "https" if "lhr.life" in host or "https" in self.headers.get("X-Forwarded-Proto", "") else "http"
            base_url = f"{proto}://{host}"
            script = f"""#!/bin/bash
set -e
echo "=========================================================="
echo "🚀 Installing Airtable Outreach Bot & Dashboard on Droplet"
echo "=========================================================="

apt-get update -y > /dev/null 2>&1 || true
apt-get install -y curl unzip python3 ufw > /dev/null 2>&1 || true

ufw allow 22/tcp > /dev/null 2>&1 || true
ufw allow 80/tcp > /dev/null 2>&1 || true
ufw allow 3000/tcp > /dev/null 2>&1 || true
ufw --force enable > /dev/null 2>&1 || true

APP_DIR="/opt/airtable-outreach-bot"
mkdir -p "$APP_DIR"
cd "$APP_DIR"

echo "📥 Downloading project bundle..."
curl -fsSL "{base_url}/download-extension" -o bot.zip
unzip -o bot.zip -d "$APP_DIR"
rm -f bot.zip

cat << 'EOF' > /etc/systemd/system/outreach.service
[Unit]
Description=Airtable Outreach Web Dashboard
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/airtable-outreach-bot
ExecStart=/usr/bin/python3 /opt/airtable-outreach-bot/server.py
Restart=always
RestartSec=3
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable outreach
systemctl restart outreach

sleep 1
SERVER_IP=$(curl -s ifconfig.me || curl -s icanhazip.com || hostname -I | awk '{{print $1}}')

echo ""
echo "=========================================================="
echo "🎉 DEPLOYMENT COMPLETE & ONLINE!"
echo ""
echo "🌐 Your Permanent Dashboard URL:"
echo "   http://${{SERVER_IP}}:3000"
echo ""
echo "🍏 Download Mac Extension (.zip):"
echo "   http://${{SERVER_IP}}:3000/download-extension"
echo "=========================================================="
"""
            self.send_response(200)
            self.send_header("Content-Type", "text/x-shellscript")
            self.end_headers()
            self.wfile.write(script.encode("utf-8"))
            return

        # 2. Config endpoint
        if path == "/api/config":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            cfg = {
                "baseId": AIRTABLE_BASE_ID,
                "tableId": AIRTABLE_TABLE_ID,
                "viewId": AIRTABLE_VIEW_ID,
                "hasToken": bool(AIRTABLE_TOKEN)
            }
            self.wfile.write(json.dumps(cfg).encode("utf-8"))
            return

        # 3. Root URL -> dashboard.html
        if path in ("/", ""):
            self.path = "/dashboard.html"
            return super().do_GET()

        # 4. /popup -> popup.html
        if path == "/popup":
            self.path = "/popup.html"
            return super().do_GET()

        # 5. Airtable records proxy
        if path == "/api/airtable/records":
            base_id = query.get("baseId", [AIRTABLE_BASE_ID])[0]
            table_id = query.get("tableId", [AIRTABLE_TABLE_ID])[0]
            view_id = query.get("viewId", [AIRTABLE_VIEW_ID])[0]
            offset = query.get("offset", [""])[0]

            url = f"https://api.airtable.com/v0/{base_id}/{table_id}?pageSize=100"
            if view_id:
                url += f"&view={urllib.parse.quote(view_id)}"
            if offset:
                url += f"&offset={urllib.parse.quote(offset)}"

            auth_header = self.headers.get("Authorization", f"Bearer {AIRTABLE_TOKEN}")
            req = urllib.request.Request(url, headers={"Authorization": auth_header, "Content-Type": "application/json"})
            try:
                with urllib.request.urlopen(req) as resp:
                    data = resp.read()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    self.wfile.write(data)
            except urllib.error.HTTPError as e:
                err_data = e.read()
                self.send_response(e.code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(err_data)
            except Exception as e:
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode("utf-8"))
            return

        # 6. YouTube RSS Proxy
        if path == "/api/youtube-rss":
            channel_id = query.get("channel_id", [""])[0]
            if not channel_id:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b"Missing channel_id")
                return

            rss_url = f"https://www.youtube.com/feeds/videos.xml?channel_id={urllib.parse.quote(channel_id)}"
            req = urllib.request.Request(rss_url, headers={"User-Agent": "Mozilla/5.0"})
            try:
                with urllib.request.urlopen(req) as resp:
                    xml_data = resp.read()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/xml")
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    self.wfile.write(xml_data)
            except Exception as e:
                self.send_response(500)
                self.end_headers()
                self.wfile.write(str(e).encode("utf-8"))
            return

        # 6b. YouTube Channel Search with Criteria Filter
        if path == "/api/youtube/search-channels":
            q = query.get("q", [""])[0]
            if not q:
                self.send_response(400)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps({"error": "Missing 'q' query parameter"}).encode("utf-8"))
                return
                
            max_subs = int(query.get("max_subs", [2000000])[0]) if query.get("max_subs", [""])[0] else 2000000
            min_subs = int(query.get("min_subs", [0])[0]) if query.get("min_subs", [""])[0] else 0
            max_days = int(query.get("max_days", [30])[0]) if query.get("max_days", [""])[0] else None
            min_freq = float(query.get("min_freq", [0])[0]) if query.get("min_freq", [""])[0] else 0
            min_views = int(query.get("min_views", [0])[0]) if query.get("min_views", [""])[0] else 0
            limit = int(query.get("limit", [15])[0]) if query.get("limit", [""])[0] else 15
            content_type = query.get("content_type", ["long_form"])[0] or "long_form"
            language = query.get("language", ["en"])[0] or "en"
            
            leads = search_youtube_channels(
                query=q,
                max_subs=max_subs,
                min_subs=min_subs,
                max_last_upload_days=max_days,
                min_freq_per_week=min_freq,
                min_views=min_views,
                limit=limit,
                content_type=content_type,
                language=language
            )
            
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"success": True, "count": len(leads), "channels": leads}).encode("utf-8"))
            return

        # 7. Download Mac Extension ZIP
        if path == "/download-extension":
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
                files_to_zip = [
                    "manifest.json", "popup.html", "popup.css", "popup.js",
                    "dashboard.html", "dashboard.css", "content.js",
                    "airtable_content.js", "youtube_content.js", "background.js", "README.md", "server.js", "server.py",
                    "package.json", "Dockerfile", "docker-compose.yml",
                    "deploy-droplet.sh"
                ]
                for fn in files_to_zip:
                    fp = os.path.join(BASE_DIR, fn)
                    if os.path.exists(fp):
                        z.write(fp, arcname=fn)
                
                icons_dir = os.path.join(BASE_DIR, "icons")
                if os.path.exists(icons_dir):
                    for ifn in os.listdir(icons_dir):
                        ifp = os.path.join(icons_dir, ifn)
                        if os.path.isfile(ifp):
                            z.write(ifp, arcname=f"icons/{ifn}")

            zip_bytes = buf.getvalue()
            self.send_response(200)
            self.send_header("Content-Type", "application/zip")
            self.send_header("Content-Disposition", 'attachment; filename="airtable-outreach-bot.zip"')
            self.send_header("Content-Length", str(len(zip_bytes)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(zip_bytes)
            return

        # Static files fallback
        return super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)

        if parsed.path == "/api/airtable/create":
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length).decode("utf-8")
            try:
                payload = json.loads(body)
                base_id = payload.get("baseId", AIRTABLE_BASE_ID)
                table_id = payload.get("tableId", AIRTABLE_TABLE_ID)
                fields = payload.get("fields", {})

                # Safeguard against computed fields
                fields.pop("Last Touch Date", None)

                url = f"https://api.airtable.com/v0/{base_id}/{table_id}"
                auth_header = self.headers.get("Authorization", f"Bearer {AIRTABLE_TOKEN}")

                p_data = json.dumps({"fields": fields, "typecast": True}).encode("utf-8")
                req = urllib.request.Request(url, data=p_data, method="POST", headers={
                    "Authorization": auth_header,
                    "Content-Type": "application/json"
                })

                with urllib.request.urlopen(req) as resp:
                    res_data = resp.read()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    self.wfile.write(res_data)
            except urllib.error.HTTPError as e:
                err_data = e.read()
                self.send_response(e.code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(err_data)
            except Exception as e:
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode("utf-8"))
            return

        if parsed.path == "/api/airtable/delete":
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length).decode("utf-8")
            try:
                payload = json.loads(body)
                rec_id = payload.get("recordId")
                base_id = payload.get("baseId", AIRTABLE_BASE_ID)
                table_id = payload.get("tableId", AIRTABLE_TABLE_ID)

                if not rec_id:
                    self.send_response(400)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    self.wfile.write(json.dumps({"error": "Missing recordId"}).encode("utf-8"))
                    return

                url = f"https://api.airtable.com/v0/{base_id}/{table_id}/{rec_id}"
                auth_header = self.headers.get("Authorization", f"Bearer {AIRTABLE_TOKEN}")
                req = urllib.request.Request(url, method="DELETE", headers={
                    "Authorization": auth_header,
                    "Content-Type": "application/json"
                })

                with urllib.request.urlopen(req) as resp:
                    res_data = resp.read()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    self.wfile.write(res_data)
            except urllib.error.HTTPError as e:
                err_data = e.read()
                self.send_response(e.code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(err_data)
            except Exception as e:
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode("utf-8"))
            return

        self.send_response(404)
        self.end_headers()

    def do_PATCH(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/airtable/patch":
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length).decode("utf-8")
            try:
                payload = json.loads(body)
                rec_id = payload.get("recordId")
                base_id = payload.get("baseId", AIRTABLE_BASE_ID)
                table_id = payload.get("tableId", AIRTABLE_TABLE_ID)
                fields = payload.get("fields", {})

                # Ensure 'Last Touch Date' is never sent
                fields.pop("Last Touch Date", None)

                url = f"https://api.airtable.com/v0/{base_id}/{table_id}/{rec_id}"
                auth_header = self.headers.get("Authorization", f"Bearer {AIRTABLE_TOKEN}")

                p_data = json.dumps({"fields": fields, "typecast": True}).encode("utf-8")
                req = urllib.request.Request(url, data=p_data, method="PATCH", headers={
                    "Authorization": auth_header,
                    "Content-Type": "application/json"
                })

                with urllib.request.urlopen(req) as resp:
                    res_data = resp.read()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    self.wfile.write(res_data)
            except urllib.error.HTTPError as e:
                err_data = e.read()
                self.send_response(e.code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(err_data)
            except Exception as e:
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode("utf-8"))
            return

        self.send_response(404)
        self.end_headers()

    def do_DELETE(self):
        parsed = urllib.parse.urlparse(self.path)
        parts = parsed.path.strip("/").split("/")
        rec_id = None
        if len(parts) >= 4 and parts[0] == "api" and parts[1] == "airtable" and parts[2] == "records":
            rec_id = parts[3]
        
        base_id = AIRTABLE_BASE_ID
        table_id = AIRTABLE_TABLE_ID
        if not rec_id:
            query = urllib.parse.parse_qs(parsed.query)
            rec_id = query.get("recordId", [None])[0]

        if not rec_id:
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Missing recordId"}).encode("utf-8"))
            return

        url = f"https://api.airtable.com/v0/{base_id}/{table_id}/{rec_id}"
        auth_header = self.headers.get("Authorization", f"Bearer {AIRTABLE_TOKEN}")
        try:
            req = urllib.request.Request(url, method="DELETE", headers={
                "Authorization": auth_header,
                "Content-Type": "application/json"
            })
            with urllib.request.urlopen(req) as resp:
                res_data = resp.read()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(res_data)
        except urllib.error.HTTPError as e:
            err_data = e.read()
            self.send_response(e.code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(err_data)
        except Exception as e:
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode("utf-8"))

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.end_headers()

if __name__ == "__main__":
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("0.0.0.0", PORT), OutreachHandler) as httpd:
        print(f"====================================================")
        print(f"🚀 Airtable Outreach Web Server active on port {PORT}")
        print(f"   Dashboard: http://localhost:{PORT}")
        print(f"   Download Mac Extension: http://localhost:{PORT}/download-extension")
        print(f"====================================================")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down server.")
