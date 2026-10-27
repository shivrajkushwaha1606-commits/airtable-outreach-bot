const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Default Airtable configuration
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN || "";
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID || "appnD39Am5fUmSH8l";
const AIRTABLE_TABLE_ID = process.env.AIRTABLE_TABLE_ID || "tblBk24WqNfOcicvB";
const AIRTABLE_VIEW_ID = process.env.AIRTABLE_VIEW_ID || "viwnh8Kj82LhyzykF";

app.use(cors());
app.use(express.json());

// Serve static extension/dashboard assets
app.use(express.static(path.join(__dirname)));

// Config endpoint
app.get('/api/config', (req, res) => {
  res.json({
    airtableToken: AIRTABLE_TOKEN,
    airtableBaseId: AIRTABLE_BASE_ID,
    airtableTableId: AIRTABLE_TABLE_ID,
    airtableViewId: AIRTABLE_VIEW_ID
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// App configuration endpoint
app.get('/api/config', (req, res) => {
  res.json({
    baseId: AIRTABLE_BASE_ID,
    tableId: AIRTABLE_TABLE_ID,
    viewId: AIRTABLE_VIEW_ID,
    hasToken: Boolean(AIRTABLE_TOKEN)
  });
});

// -------------------------------------------------------------------
// Airtable API Proxy (Secures credentials & bypasses CORS)
// -------------------------------------------------------------------
app.get('/api/airtable/records', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '') || AIRTABLE_TOKEN;
    const baseId = req.query.baseId || AIRTABLE_BASE_ID;
    const tableId = req.query.tableId || AIRTABLE_TABLE_ID;
    const viewId = req.query.viewId || AIRTABLE_VIEW_ID;
    const offset = req.query.offset || '';

    let url = `https://api.airtable.com/v0/${baseId}/${tableId}?pageSize=100`;
    if (viewId) url += `&view=${encodeURIComponent(viewId)}`;
    if (offset) url += `&offset=${encodeURIComponent(offset)}`;

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ error: errText });
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/airtable/patch', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '') || AIRTABLE_TOKEN;
    const baseId = req.body.baseId || AIRTABLE_BASE_ID;
    const tableId = req.body.tableId || AIRTABLE_TABLE_ID;
    const recordId = req.body.recordId;
    const fields = req.body.fields || {};

    if (!recordId) {
      return res.status(400).json({ error: 'Missing recordId' });
    }

    // Ensure 'Last Touch Date' is never sent (computed column safeguard)
    delete fields['Last Touch Date'];

    const url = `https://api.airtable.com/v0/${baseId}/${tableId}/${recordId}`;
    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        fields: fields,
        typecast: true
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ error: errText });
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/airtable/create', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '') || AIRTABLE_TOKEN;
    const baseId = req.body.baseId || AIRTABLE_BASE_ID;
    const tableId = req.body.tableId || AIRTABLE_TABLE_ID;
    const fields = req.body.fields || {};

    delete fields['Last Touch Date'];

    const url = `https://api.airtable.com/v0/${baseId}/${tableId}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        fields: fields,
        typecast: true
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ error: errText });
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete Airtable Record endpoint
app.post('/api/airtable/delete', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '') || AIRTABLE_TOKEN;
    const baseId = req.body.baseId || AIRTABLE_BASE_ID;
    const tableId = req.body.tableId || AIRTABLE_TABLE_ID;
    const recordId = req.body.recordId;

    if (!recordId) {
      return res.status(400).json({ error: 'Missing recordId' });
    }

    const url = `https://api.airtable.com/v0/${baseId}/${tableId}/${recordId}`;
    const response = await fetch(url, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ error: errText });
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/airtable/delete', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '') || AIRTABLE_TOKEN;
    const baseId = req.query.baseId || req.body?.baseId || AIRTABLE_BASE_ID;
    const tableId = req.query.tableId || req.body?.tableId || AIRTABLE_TABLE_ID;
    const recordId = req.query.recordId || req.body?.recordId;

    if (!recordId) {
      return res.status(400).json({ error: 'Missing recordId' });
    }

    const url = `https://api.airtable.com/v0/${baseId}/${tableId}/${recordId}`;
    const response = await fetch(url, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ error: errText });
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------------
// YouTube Channel Search & Discovery Endpoint
// -------------------------------------------------------------------
function parseSubscriberCount(text) {
  if (!text) return null;
  const clean = text.replace(/subscribers?/i, '').trim();
  const m = clean.match(/^([\d,.]+)\s*([kmb])?$/i);
  if (!m) return null;
  let val = parseFloat(m[1].replace(/,/g, ''));
  if (isNaN(val)) return null;
  const unit = (m[2] || '').toLowerCase();
  if (unit === 'k') val *= 1000;
  else if (unit === 'm') val *= 1000000;
  else if (unit === 'b') val *= 1000000000;
  return Math.round(val);
}

function generateSearchQueries(q) {
  const clean = q.trim();
  const w = clean.toLowerCase();
  const queries = [clean];
  if (w.includes('roblox')) {
    queries.push(
      `${clean} Brookhaven`, `${clean} Blox Fruits`, `${clean} Bedwars`,
      `${clean} Blade Ball`, `${clean} Adopt Me`, `${clean} Murder Mystery`,
      `${clean} Doors`, `${clean} Tower Defense`, `${clean} Arsenal`,
      `${clean} Dress To Impress`, `${clean} Da Hood`, `${clean} Tycoon`,
      `${clean} Simulator`, `${clean} Obby`, `${clean} gameplay`,
      `${clean} roleplay`, `${clean} horror`, `${clean} scary`,
      `${clean} challenges`, `${clean} animation`, `${clean} funny moments`
    );
  } else if (w.includes('minecraft')) {
    queries.push(
      `${clean} survival`, `${clean} hardcore`, `${clean} smp`,
      `${clean} modded`, `${clean} bedwars`, `${clean} speedrun`,
      `${clean} build`, `${clean} redstone`, `${clean} challenges`,
      `${clean} roleplay`, `${clean} server`, `${clean} 100 days`
    );
  } else if (w.includes('fortnite')) {
    queries.push(
      `${clean} battle royale`, `${clean} ranked`, `${clean} montage`,
      `${clean} creative`, `${clean} tournament`, `${clean} zero build`,
      `${clean} gameplay`, `${clean} funny`
    );
  } else {
    queries.push(
      `${clean} channel`, `${clean} videos`, `${clean} creator`,
      `${clean} daily`, `${clean} tips`, `${clean} podcast`,
      `${clean} review`, `${clean} tutorial`, `${clean} guide`,
      `${clean} breakdown`, `${clean} highlights`, `${clean} live`
    );
  }
  return queries;
}

async function getChannelCountry(chId) {
  if (!chId) return null;
  try {
    const url = `https://www.youtube.com/channel/${chId}/about`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(2500)
    });
    if (!resp.ok) return null;
    const html = await resp.text();
    const match = html.match(/"country"\s*:\s*"([^"]+)"/);
    return match ? match[1] : null;
  } catch (e) {
    return null;
  }
}

function isValidEnglishCreator(channelName, handle, titles, descriptions, country = null) {
  const textCorpus = `${channelName} ${handle} ` + titles.join(" ") + " " + descriptions.join(" ");
  const textLower = textCorpus.toLowerCase();

  // 1. Country blocklist for non-English countries
  if (country) {
    const cLower = country.toLowerCase().trim();
    const blocked = [
      'india', 'pakistan', 'bangladesh', 'nepal', 'sri lanka',
      'mexico', 'brazil', 'spain', 'argentina', 'colombia', 'chile', 'peru', 'venezuela',
      'russia', 'ukraine', 'belarus', 'indonesia', 'philippines', 'vietnam',
      'thailand', 'turkey', 'japan', 'korea', 'taiwan', 'france', 'germany', 'italy'
    ];
    if (blocked.some(b => cLower.includes(b))) return false;
  }

  // 2. Non-Latin scripts check
  if (/[\u0900-\u097F]/.test(textCorpus)) return false; // Devanagari
  if (/[\u0400-\u04FF]/.test(textCorpus)) return false; // Cyrillic
  if (/[\u0600-\u06FF]/.test(textCorpus)) return false; // Arabic
  if (/[\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/.test(textCorpus)) return false; // Asian

  // 3. Hindi / Indian keywords
  const hindiKeywords = [
    /\bbhai\b/, /\bkya\b/, /\bkaise\b/, /\baaj\b/, /\bmaine\b/, /\bhumne\b/,
    /\bmera\b/, /\bmeri\b/, /\bmere\b/, /\bdost\b/, /\bdoston\b/, /\bdekho\b/,
    /\bkaha\b/, /\byeh\b/, /\bwoh\b/, /\bkar diya\b/, /\bkar payenge\b/,
    /\bchupaye\b/, /\bchupaya\b/, /\broblox hindi\b/, /\bhindi gaming\b/,
    /\bcarrydepie\b/, /\bsujal\b/, /\bchhotu\b/, /\bbhaiya\b/, /\baap dekhoge\b/,
    /\bhindi\b/, /\bindia\b/, /\bdesi\b/
  ];
  if (hindiKeywords.some(hk => hk.test(textLower))) return false;

  // 4. Spanish / Portuguese accents and phrases
  if (/[ñ¡¿áéíóú]/.test(textLower)) return false;
  const spanishWords = [
    /\ben vivo\b/, /\bjugando\b/, /\bescondidas\b/, /\bsobrevivir\b/, /\bactualizaci[oó]n\b/,
    /\bpartida\b/, /\btodos\b/, /\bvamos por\b/, /\bsuscr[ií]bete\b/, /\bjuego\b/,
    /\bamigos\b/, /\bcapitulo\b/, /\bmuerte\b/, /\bgana\b/, /\bnunca\b/,
    /\bde terror\b/, /\bel ultimo\b/, /\bcon mis\b/, /\bpara ganar\b/, /\bno me lo creo\b/,
    /\bjogando\b/, /\bn[aã]o\b/, /\bmuito\b/, /\bvoc[eê]\b/
  ];
  if (spanishWords.some(sw => sw.test(textLower))) return false;

  // 5. Automated repetitive live stream spam (e.g. Hima Roblox)
  if (titles && titles.length >= 3) {
    const cleaned = titles.map(t => t.toLowerCase().replace(/[^a-z0-9]/g, '')).filter(t => t.length > 0);
    const uniqueRatio = new Set(cleaned).size / cleaned.length;
    if (uniqueRatio < 0.5) return false;
    const streamCount = titles.filter(t => /live playing|live stream|#robloxlive/i.test(t)).length;
    if (streamCount >= 2) return false;
  }

  return true;
}

async function auditCandidateChannelRss(c, maxDays, minFreq, minViews, contentType, now, language = "en") {
  if (!c.channelId) return null;
  try {
    const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(c.channelId)}`;
    const rssResp = await fetch(rssUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(3500)
    });

    if (!rssResp.ok) return null;
    const xml = await rssResp.text();

    const entries = [];
    const titles = [];
    const descriptions = [];
    const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
    let em;
    while ((em = entryRegex.exec(xml)) !== null) {
      const entryStr = em[1];
      const titleM = entryStr.match(/<title>([^<]+)<\/title>/);
      const linkM = entryStr.match(/<link[^>]+href="([^"]+)"/);
      const pubM = entryStr.match(/<published>([^<]+)<\/published>/);
      const viewsM = entryStr.match(/<media:statistics\s+views="(\d+)"/);
      const descM = entryStr.match(/<media:description>([\s\S]*?)<\/media:description>/);

      const vTitle = titleM ? titleM[1] : '';
      const vLink = linkM ? linkM[1] : '';
      const vDesc = descM ? descM[1] : '';
      const views = viewsM ? parseInt(viewsM[1], 10) : 0;
      const isShort = vLink.includes('/shorts/') || /#shorts?/i.test(vTitle);

      titles.push(vTitle);
      if (vDesc) descriptions.push(vDesc.slice(0, 120));

      if (pubM) {
        const pubDate = new Date(pubM[1]).getTime();
        const daysAgo = Math.max(0, (now - pubDate) / 86400000);
        entries.push({
          title: vTitle,
          link: vLink,
          daysAgo: parseFloat(daysAgo.toFixed(1)),
          dateStr: pubM[1],
          views: views,
          isShort: isShort
        });
      }
    }

    if (entries.length === 0) return null;

    // Strict English / Spam filtering
    if (language === 'en') {
      const country = await getChannelCountry(c.channelId);
      c.country = country || "";
      if (!isValidEnglishCreator(c.name || '', c.handle || '', titles, descriptions, country)) {
        return null;
      }
    }

    const shorts = entries.filter(e => e.isShort);
    const longForms = entries.filter(e => !e.isShort);
    const shortsCount = shorts.length;
    const longCount = longForms.length;

    let targetVideos;
    if (contentType === 'long_form') {
      if (longCount === 0) return null; // Exclude shorts-only
      targetVideos = longForms;
    } else if (contentType === 'shorts_only') {
      if (shortsCount === 0) return null;
      targetVideos = shorts;
    } else {
      targetVideos = entries;
    }

    if (!targetVideos || targetVideos.length === 0) return null;

    const latest = targetVideos[0];
    if (maxDays !== null && maxDays > 0 && latest.daysAgo > maxDays) return null;

    const in30Days = targetVideos.filter(e => e.daysAgo <= 30).length;

    let freqPerWeek;
    if (in30Days >= 3) {
      const recentIn30 = targetVideos.filter(e => e.daysAgo <= 30);
      const spanDays = Math.max(recentIn30[recentIn30.length - 1].daysAgo, 3.5);
      freqPerWeek = parseFloat((recentIn30.length / (spanDays / 7.0)).toFixed(1));
    } else {
      freqPerWeek = parseFloat((in30Days / 4.2).toFixed(1));
    }

    const viewsList = targetVideos.filter(e => e.views && e.views > 0).map(e => e.views);
    const avgViews = viewsList.length > 0 ? Math.round(viewsList.reduce((a, b) => a + b, 0) / viewsList.length) : 0;
    if (minViews > 0 && avgViews < minViews) return null;

    let viewsText = '';
    if (avgViews >= 1000000) viewsText = `~${(avgViews / 1000000).toFixed(1).replace(/\.0$/, '')}M views`;
    else if (avgViews >= 1000) viewsText = `~${(avgViews / 1000).toFixed(1).replace(/\.0$/, '')}K views`;
    else if (avgViews > 0) viewsText = `~${avgViews} views`;

    const contentFormat = (longCount > 0 && shortsCount === 0) ? 'long_form' : ((longCount > 0 && shortsCount > 0) ? 'mixed' : 'shorts_only');

    const chObj = {
      ...c,
      lastUploadDaysAgo: latest.daysAgo,
      lastUploadText: latest.daysAgo < 1 ? 'Today' : `${Math.floor(latest.daysAgo)}d ago`,
      latestVideoTitle: latest.title,
      frequencyPerWeek: freqPerWeek,
      frequencyText: `~${freqPerWeek} vids/wk`,
      avgViews: avgViews,
      avgViewsText: viewsText,
      longFormCount: longCount,
      shortsCount: shortsCount,
      contentFormat: contentFormat
    };

    const isExact = (minFreq <= 0 || freqPerWeek >= minFreq);
    return { isExact, channel: chObj };
  } catch (err) {
    return null;
  }
}

app.get('/api/youtube/search-channels', async (req, res) => {
  try {
    const q = req.query.q;
    if (!q) {
      return res.status(400).json({ error: "Missing 'q' query parameter" });
    }

    const maxSubs = req.query.max_subs ? parseInt(req.query.max_subs, 10) : 2000000;
    const minSubs = req.query.min_subs ? parseInt(req.query.min_subs, 10) : 0;
    const maxDays = req.query.max_days ? parseInt(req.query.max_days, 10) : null;
    const minFreq = req.query.min_freq ? parseFloat(req.query.min_freq) : 0;
    const minViews = req.query.min_views ? parseInt(req.query.min_views, 10) : 0;
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 15;
    const contentType = req.query.content_type || 'long_form';
    const language = req.query.language || 'en';

    const queries = generateSearchQueries(q);
    const results = [];
    const nearMatches = [];
    const seenIds = new Set();
    const now = Date.now();

    // Query in parallel batches of 4
    const batchSize = 4;
    for (let i = 0; i < queries.length; i += batchSize) {
      if (results.length >= limit) break;

      const batch = queries.slice(i, i + batchSize);
      const batchCandidates = [];

      await Promise.all(batch.map(async (queryVariant) => {
        try {
          const ytSearchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(queryVariant)}&sp=EgIQAg%253D%253D`;
          const searchResp = await fetch(ytSearchUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            signal: AbortSignal.timeout(5000)
          });
          if (!searchResp.ok) return;
          const html = await searchResp.text();
          const match = html.match(/ytInitialData\s*=\s*({.+?});<\/script>/);
          if (!match) return;

          const data = JSON.parse(match[1]);
          const channelRenderers = [];
          function traverse(obj) {
            if (!obj) return;
            if (typeof obj === 'object') {
              if (obj.channelRenderer) channelRenderers.push(obj.channelRenderer);
              for (const k of Object.keys(obj)) traverse(obj[k]);
            }
          }
          traverse(data);

          for (const cr of channelRenderers) {
            const chId = cr.channelId || '';
            if (!chId || seenIds.has(chId)) continue;
            seenIds.add(chId);

            const title = cr.title?.simpleText || (cr.title?.runs?.[0]?.text || '');
            const baseUrl = cr.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl || '';

            let subStr = cr.videoCountText?.simpleText || cr.subscriberCountText?.simpleText || '';
            let vidStr = cr.subscriberCountText?.simpleText || '';

            if (!subStr.toLowerCase().includes('subscriber') && vidStr.toLowerCase().includes('subscriber')) {
              const tmp = subStr; subStr = vidStr; vidStr = tmp;
            }

            const subs = parseSubscriberCount(subStr);
            if (maxSubs !== null && subs !== null && subs > maxSubs) continue;
            if (minSubs !== null && subs !== null && subs < minSubs) continue;

            const thumbs = cr.thumbnail?.thumbnails || [];
            let avatar = thumbs.length > 0 ? thumbs[thumbs.length - 1].url : '';
            if (avatar.startsWith('//')) avatar = 'https:' + avatar;

            const handle = baseUrl ? baseUrl.replace(/^\/@/, '@') : (chId ? `@${chId}` : '');

            batchCandidates.push({
              channelId: chId,
              name: title,
              handle: handle,
              url: baseUrl ? `https://www.youtube.com${baseUrl}` : `https://www.youtube.com/channel/${chId}`,
              avatar: avatar,
              subscribers: subs,
              subscribersText: subStr || 'Hidden subs',
              videoCountText: vidStr || ''
            });
          }
        } catch (e) {}
      }));

      if (batchCandidates.length === 0) continue;

      const chunkSize = 10;
      for (let j = 0; j < batchCandidates.length; j += chunkSize) {
        const chunk = batchCandidates.slice(j, j + chunkSize);
        const chunkResults = await Promise.all(
          chunk.map(c => auditCandidateChannelRss(c, maxDays, minFreq, minViews, contentType, now, language))
        );
        for (const item of chunkResults) {
          if (item && item.channel) {
            if (item.isExact) {
              results.push(item.channel);
              if (results.length >= limit) break;
            } else if (minFreq > 0 && item.channel.frequencyPerWeek >= (minFreq * 0.5)) {
              nearMatches.push(item.channel);
            }
          }
        }
        if (results.length >= limit) break;
      }
    }

    // Guaranteed lead count fulfillment
    if (results.length < limit && nearMatches.length > 0) {
      nearMatches.sort((a, b) => (b.frequencyPerWeek || 0) - (a.frequencyPerWeek || 0));
      const rIds = new Set(results.map(r => r.channelId));
      for (const nm of nearMatches) {
        if (!rIds.has(nm.channelId)) {
          results.push(nm);
          rIds.add(nm.channelId);
          if (results.length >= limit) break;
        }
      }
    }

    res.json({ success: true, count: results.length, channels: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------------
// YouTube RSS Proxy (Bypasses browser CORS for Old Channel Auditor)
// -------------------------------------------------------------------
app.get('/api/youtube-rss', async (req, res) => {
  try {
    const channelId = req.query.channel_id;
    if (!channelId) {
      return res.status(400).send("Missing channel_id");
    }

    const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
    const response = await fetch(rssUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    if (!response.ok) {
      return res.status(response.status).send("Failed to fetch RSS");
    }

    const xml = await response.text();
    res.set('Content-Type', 'application/xml');
    res.send(xml);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// -------------------------------------------------------------------
// Download Chrome/Brave Extension as .ZIP
// -------------------------------------------------------------------
app.get('/download-extension', (req, res) => {
  const archive = archiver('zip', { zlib: { level: 9 } });

  res.attachment('airtable-outreach-bot.zip');
  archive.pipe(res);

  const filesToInclude = [
    'manifest.json', 'popup.html', 'popup.css', 'popup.js',
    'dashboard.html', 'dashboard.css', 'content.js',
    'airtable_content.js', 'youtube_content.js', 'background.js', 'README.md', 'server.js', 'server.py',
    'package.json', 'Dockerfile', 'docker-compose.yml',
    'deploy-droplet.sh'
  ];

  filesToInclude.forEach(file => {
    const filePath = path.join(__dirname, file);
    if (fs.existsSync(filePath)) {
      archive.file(filePath, { name: file });
    }
  });

  const iconsDir = path.join(__dirname, 'icons');
  if (fs.existsSync(iconsDir)) {
    archive.directory(iconsDir, 'icons');
  }

  archive.finalize();
});

// Root URL serves dashboard.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// /popup serves popup.html
app.get('/popup', (req, res) => {
  res.sendFile(path.join(__dirname, 'popup.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`====================================================`);
  console.log(`🚀 Outreach Web Server online at http://localhost:${PORT}`);
  console.log(`   Dashboard: http://localhost:${PORT}`);
  console.log(`   Download Mac Extension: http://localhost:${PORT}/download-extension`);
  console.log(`====================================================`);
});
