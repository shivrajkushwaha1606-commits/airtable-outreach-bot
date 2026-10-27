// Background service worker
chrome.runtime.onInstalled.addListener(() => {
  console.log("Airtable Outreach Bot Extension installed successfully.");
});

const ALLOWED_AIRTABLE_FIELDS = new Set([
  "Name", "Niche", "Status", "Follow Up Status", "Email", "Discord Page",
  "X account", "Instagram", "Yt link", "First DM Date", "Replied",
  "Plateform Got Replied From", "Plateforms I've Reached out"
]);

function sanitizeFields(raw) {
  const safe = {};
  for (const [k, v] of Object.entries(raw || {})) {
    if (k.startsWith("_")) continue;
    if (ALLOWED_AIRTABLE_FIELDS.has(k) && v !== undefined && v !== null) {
      if (typeof v === "boolean") {
        safe[k] = v;
      } else if (Array.isArray(v)) {
        safe[k] = v.filter(item => item !== undefined && item !== null && String(item).trim());
      } else if (String(v).trim()) {
        safe[k] = String(v).trim();
      }
    }
  }
  return safe;
}

// -------------------------------------------------------------
// -------------------------------------------------------------
// YouTube Redirects and Social Extraction Helpers
// -------------------------------------------------------------
function extractYouTubeRedirects(html) {
  const redirects = [];
  if (!html) return redirects;

  const regex = /https?:\/\/www\.youtube\.com\/redirect\?([^\s"\'<>]+)/g;
  let match;
  while ((match = regex.exec(html)) !== null) {
    try {
      const qStr = match[1].replace(/\\u0026/g, '&').replace(/&amp;/g, '&');
      const params = new URLSearchParams(qStr);
      const target = params.get('q');
      const event = params.get('event') || '';
      if (target && !redirects.some(r => r.target === target)) {
        redirects.push({ target, event });
      }
    } catch (e) {}
  }
  return redirects;
}

function extractEmailsFromText(text) {
  if (!text) return null;
  const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
  const matches = text.match(emailRegex);
  if (!matches) return null;
  const filtered = matches.filter(e => {
    const el = e.toLowerCase();
    return !el.endsWith('.png') && !el.endsWith('.jpg') && !el.includes('youtube.com') && !el.includes('google.com');
  });
  return filtered.length > 0 ? filtered[0] : null;
}

async function validateDiscordInvite(code) {
  if (!code) return null;
  try {
    const res = await fetch(`https://discord.com/api/v10/invites/${code}?with_counts=true`, {
      signal: AbortSignal.timeout(3000)
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      active: true,
      url: `https://discord.gg/${code}`,
      title: data.guild?.name || "Official Discord Server"
    };
  } catch (e) {
    return { active: true, url: `https://discord.gg/${code}`, title: "Discord Server" };
  }
}

async function extractSocialsFromHtml(html, foundSocials, creator = {}) {
  if (!html) return;

  // 1. YouTube redirect URLs
  const redirects = extractYouTubeRedirects(html);
  for (const { target } of redirects) {
    if (!foundSocials["X account"] && !creator.twitter) {
      const twM = target.match(/(?:twitter|x)\.com\/([a-zA-Z0-9_]{1,25})/i);
      if (twM && !['home', 'intent', 'share', 'search', 'explore', 'hashtag', 'i', 'privacy', 'tos'].includes(twM[1].toLowerCase())) {
        foundSocials["X account"] = `https://x.com/${twM[1]}`;
      }
    }
    if (!foundSocials["Instagram"] && !creator.instagram) {
      const igM = target.match(/instagram\.com\/([a-zA-Z0-9_\.]{3,30})/i);
      if (igM && !['p', 'reel', 'stories', 'explore', 'direct', 'accounts', 'about'].includes(igM[1].toLowerCase())) {
        foundSocials["Instagram"] = `https://www.instagram.com/${igM[1].replace(/\.$/, '')}/`;
      }
    }
    if (!foundSocials["Discord Page"] && !creator.discord) {
      const discM = target.match(/(?:discord\.gg|discord\.com\/invite)\/([a-zA-Z0-9_\-]+)/i);
      if (discM) {
        const v = await validateDiscordInvite(discM[1]);
        if (v && v.active) {
          foundSocials["Discord Page"] = v.url;
        }
      }
    }
  }

  // 2. Direct Twitter / X links (supports JSON escaped \/ or regular /)
  if (!foundSocials["X account"] && !creator.twitter) {
    const twMatches = html.match(/(?:https?:\\?\/\\?\/|https?:\/\/)(?:www\.)?(?:twitter\.com|x\.com)\\?\/([a-zA-Z0-9_]{1,25})/gi);
    if (twMatches) {
      for (const m of twMatches) {
        const handleMatch = m.match(/(?:twitter\.com|x\.com)\\?\/([a-zA-Z0-9_]{1,25})/i);
        if (handleMatch && !['home', 'intent', 'share', 'search', 'explore', 'hashtag', 'i', 'privacy', 'tos'].includes(handleMatch[1].toLowerCase())) {
          foundSocials["X account"] = `https://x.com/${handleMatch[1]}`;
          break;
        }
      }
    }
  }

  // 3. Direct Instagram links
  if (!foundSocials["Instagram"] && !creator.instagram) {
    const igMatches = html.match(/(?:https?:\\?\/\\?\/|https?:\/\/)(?:www\.)?instagram\.com\\?\/([a-zA-Z0-9_\.]{3,30})/gi);
    if (igMatches) {
      for (const m of igMatches) {
        const handleMatch = m.match(/instagram\.com\\?\/([a-zA-Z0-9_\.]{3,30})/i);
        if (handleMatch) {
          const clean = handleMatch[1].replace(/\.$/, '');
          if (!['p', 'reel', 'stories', 'explore', 'direct', 'accounts', 'about'].includes(clean.toLowerCase())) {
            foundSocials["Instagram"] = `https://www.instagram.com/${clean}/`;
            break;
          }
        }
      }
    }
  }

  // 4. Direct Discord links
  if (!foundSocials["Discord Page"] && !creator.discord) {
    const discMatches = html.match(/(?:https?:\\?\/\\?\/|https?:\/\/)(?:www\.)?(?:discord\.gg|discord\.com\\?\/invite)\\?\/([a-zA-Z0-9_\-]+)/gi);
    if (discMatches) {
      for (const m of discMatches) {
        const codeMatch = m.match(/(?:discord\.gg|invite)\\?\/([a-zA-Z0-9_\-]+)/i);
        if (codeMatch) {
          const v = await validateDiscordInvite(codeMatch[1]);
          if (v && v.active) {
            foundSocials["Discord Page"] = v.url;
            break;
          }
        }
      }
    }
  }

  // 5. Emails
  if (!foundSocials["Email"] && !creator.email) {
    const email = extractEmailsFromText(html);
    if (email) foundSocials["Email"] = email;
  }
}

async function runDeepSocialSearch(creator) {
  const foundSocials = {};
  let channelUrl = creator.youtube;

  // Step 1: If no channel URL, search YouTube by creator name
  if (!channelUrl && creator.name) {
    try {
      const sUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(creator.name + ' channel')}&sp=EgIQAg%253D%253D`;
      const sResp = await fetch(sUrl, { signal: AbortSignal.timeout(4000) });
      const sHtml = await sResp.text();
      const m = sHtml.match(/"canonicalBaseUrl":"(\/@[a-zA-Z0-9_\.-]+)"/);
      if (m) {
        channelUrl = "https://www.youtube.com" + m[1];
        foundSocials["Yt link"] = channelUrl;
      }
    } catch (e) {}
  }

  // Step 2: Channel About page & Banner redirects
  if (channelUrl) {
    const cleanUrl = channelUrl.replace(/\/(about|featured|videos|community|playlists|streams|shorts)\/?$/, '');
    for (const pageUrl of [cleanUrl, cleanUrl + "/about"]) {
      try {
        const resp = await fetch(pageUrl, { signal: AbortSignal.timeout(4000) });
        if (!resp.ok) continue;
        const html = await resp.text();
        await extractSocialsFromHtml(html, foundSocials, creator);
        if (foundSocials["Instagram"] && foundSocials["X account"] && foundSocials["Discord Page"] && foundSocials["Email"]) break;
      } catch (e) {}
    }
  }

  // Step 3: Latest Video Descriptions
  if (channelUrl && (!foundSocials["Instagram"] || !foundSocials["X account"] || !foundSocials["Discord Page"] || !foundSocials["Email"])) {
    try {
      const cleanUrl = channelUrl.replace(/\/(about|featured|videos|community|playlists|streams|shorts)\/?$/, '');
      const vidsResp = await fetch(cleanUrl + "/videos", { signal: AbortSignal.timeout(4000) });
      const vidsHtml = await vidsResp.text();
      const vidMatches = vidsHtml.match(/\/watch\?v=([a-zA-Z0-9_-]{11})/g);
      if (vidMatches && vidMatches.length > 0) {
        const uniqueVids = [...new Set(vidMatches.map(v => v.replace('/watch?v=', '')))].slice(0, 2);
        for (const vidId of uniqueVids) {
          const vUrl = `https://www.youtube.com/watch?v=${vidId}`;
          const vr = await fetch(vUrl, { signal: AbortSignal.timeout(4000) });
          const vHtml = await vr.text();
          await extractSocialsFromHtml(vHtml, foundSocials, creator);
        }
      }
    } catch (e) {}
  }

  return foundSocials;
}

// -------------------------------------------------------------
// Message Listener
// -------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "UPDATE_BADGE") {
    const text = msg.count ? String(msg.count) : "";
    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({ color: "#6366f1" });
    sendResponse({ success: true });
    return true;
  }

  if (msg.action === "SHOW_NOTIFICATION") {
    try {
      if (chrome.notifications && chrome.notifications.create) {
        chrome.notifications.create({
          type: "basic",
          iconUrl: "icons/icon128.png",
          title: msg.title || "Outreach Bot Notification",
          message: msg.message || "Task completed successfully.",
          priority: 2
        }, (notificationId) => {
          sendResponse({ success: true, notificationId });
        });
        return true;
      }
    } catch (e) {
      sendResponse({ success: false, error: e.message });
      return true;
    }
  }

  // DEEP SEARCH FOR AIRTABLE RECORD (Injected 1-Click Finder)
  if (msg.action === "DEEP_SEARCH_RECORD") {
    (async () => {
      try {
        const stored = await chrome.storage.local.get(["airtableToken", "airtableBaseId", "airtableTableId"]);
        const token = msg.token || stored.airtableToken || "";
        const baseId = msg.baseId || stored.airtableBaseId || "appnD39Am5fUmSH8l";
        const tableId = msg.tableId || stored.airtableTableId || "tblBk24WqNfOcicvB";
        const recordId = msg.recordId;

        if (!recordId) {
          sendResponse({ success: false, error: "Missing record ID" });
          return;
        }

        // Fetch current record from Airtable to get full fields
        let recName = msg.name || "";
        let recYt = msg.youtube || "";
        let recTw = "";
        let recIg = "";
        let recDisc = "";
        let recEmail = "";

        try {
          const recUrl = `https://api.airtable.com/v0/${baseId}/${tableId}/${recordId}`;
          const recResp = await fetch(recUrl, { headers: { Authorization: `Bearer ${token}` } });
          if (recResp.ok) {
            const recJson = await recResp.json();
            const f = recJson.fields || {};
            if (!recName && f.Name) recName = f.Name;
            if (!recYt && f["Yt link"]) recYt = f["Yt link"];
            recTw = f["X account"] || "";
            recIg = f["Instagram"] || "";
            recDisc = f["Discord Page"] || "";
            recEmail = f["Email"] || "";
          }
        } catch (e) {}

        const creator = {
          id: recordId,
          name: recName,
          youtube: recYt,
          twitter: recTw,
          instagram: recIg,
          discord: recDisc,
          email: recEmail
        };

        const found = await runDeepSocialSearch(creator);
        const foundKeys = Object.keys(found);

        if (foundKeys.length > 0) {
          // Patch Airtable
          const safePatch = sanitizeFields(found);
          const patchUrl = `https://api.airtable.com/v0/${baseId}/${tableId}/${recordId}`;
          await fetch(patchUrl, {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({ fields: safePatch, typecast: true })
          });

          // Trigger notification
          if (chrome.notifications && chrome.notifications.create) {
            const readable = foundKeys.map(k => k === "X account" ? "Twitter/X" : k === "Discord Page" ? "Discord" : k).join(", ");
            chrome.notifications.create({
              type: "basic",
              iconUrl: "icons/icon128.png",
              title: `🎉 Socials Found for ${recName || "Creator"}!`,
              message: `Saved to Airtable: ${readable}`,
              priority: 2
            });
          }

          sendResponse({ success: true, count: foundKeys.length, keys: foundKeys, socials: found });
        } else {
          sendResponse({ success: false, reason: "No new social accounts found on channel or video descriptions." });
        }
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg.action === "DELETE_AIRTABLE_RECORD") {
    (async () => {
      try {
        const stored = await chrome.storage.local.get(["airtableToken", "airtableBaseId", "airtableTableId"]);
        const token = msg.token || stored.airtableToken || "";
        const baseId = msg.baseId || stored.airtableBaseId || "appnD39Am5fUmSH8l";
        const tableId = msg.tableId || stored.airtableTableId || "tblBk24WqNfOcicvB";
        const recordId = msg.recordId;

        if (!recordId) {
          sendResponse({ success: false, error: "Missing record ID" });
          return;
        }

        const url = `https://api.airtable.com/v0/${baseId}/${tableId}/${recordId}`;
        const res = await fetch(url, {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${token}`
          }
        });

        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          sendResponse({ success: false, status: res.status, error: errText });
          return;
        }

        const data = await res.json().catch(() => ({}));
        sendResponse({ success: true, deleted: true, id: recordId, data });
      } catch (err) {
        sendResponse({ success: false, error: err.message || "Failed to delete Airtable record" });
      }
    })();
    return true;
  }

  if (msg.action === "PATCH_AIRTABLE") {
    (async () => {
      try {
        const stored = await chrome.storage.local.get(["airtableToken", "airtableBaseId", "airtableTableId"]);
        const token = msg.token || stored.airtableToken || "";
        const baseId = msg.baseId || stored.airtableBaseId || "appnD39Am5fUmSH8l";
        const tableId = msg.tableId || stored.airtableTableId || "tblBk24WqNfOcicvB";
        const recordId = msg.recordId;

        if (!recordId) {
          sendResponse({ success: false, error: "Missing record ID" });
          return;
        }

        const safeFields = sanitizeFields(msg.fields);
        if (Object.keys(safeFields).length === 0) {
          sendResponse({ success: true, updated: 0 });
          return;
        }

        const url = `https://api.airtable.com/v0/${baseId}/${tableId}/${recordId}`;
        const res = await fetch(url, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            fields: safeFields,
            typecast: true
          })
        });

        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          sendResponse({ success: false, status: res.status, error: errText });
          return;
        }

        const data = await res.json().catch(() => ({}));
        sendResponse({ success: true, data });
      } catch (err) {
        sendResponse({ success: false, error: err.message || "Failed to patch Airtable" });
      }
    })();
    return true;
  }

  // -------------------------------------------------------------
  // CHECK IF YOUTUBE CHANNEL EXISTS IN AIRTABLE
  // -------------------------------------------------------------
  if (msg.action === "CHECK_YOUTUBE_CHANNEL_EXISTS") {
    (async () => {
      try {
        const stored = await chrome.storage.local.get(["airtableToken", "airtableBaseId", "airtableTableId"]);
        const token = msg.token || stored.airtableToken || "";
        const baseId = msg.baseId || stored.airtableBaseId || "appnD39Am5fUmSH8l";
        const tableId = msg.tableId || stored.airtableTableId || "tblBk24WqNfOcicvB";

        const rawUrl = (msg.url || "").trim();
        const handle = (msg.handle || "").replace(/^@/, "").trim().toLowerCase();
        const rawName = (msg.name || "").replace(/\s+/g, " ").trim().toLowerCase();
        const channelId = (msg.channelId || "").trim();

        // Build formula conditions safely
        const conditions = [];

        if (channelId && /^UC[a-zA-Z0-9_-]{22}$/.test(channelId)) {
          conditions.push(`FIND('${channelId}', {Yt link} & '')`);
        }

        if (handle && handle.length >= 2) {
          const safeHandle = handle.replace(/'/g, "\\'");
          conditions.push(`FIND('${safeHandle}', LOWER({Yt link} & ''))`);
        }

        if (rawUrl) {
          const cleanPath = rawUrl
            .replace(/^https?:\/\/(www\.)?youtube\.com/i, "")
            .replace(/\/(featured|videos|shorts|live|streams|playlists|community|channels|about)\/?$/i, "")
            .toLowerCase();
          if (cleanPath && cleanPath.length > 2) {
            const safePath = cleanPath.replace(/'/g, "\\'");
            conditions.push(`FIND('${safePath}', LOWER({Yt link} & ''))`);
          }
        }

        if (rawName && rawName.length >= 3 && !rawName.includes("youtube creator")) {
          const safeName = rawName.replace(/'/g, "\\'");
          conditions.push(`FIND('${safeName}', LOWER({Name} & ''))`);
        }

        if (conditions.length === 0) {
          sendResponse({ exists: false });
          return;
        }

        const formula = conditions.length === 1 ? conditions[0] : `OR(${conditions.join(", ")})`;
        const params = new URLSearchParams({
          filterByFormula: formula,
          maxRecords: "3"
        });

        const url = `https://api.airtable.com/v0/${baseId}/${tableId}?${params.toString()}`;
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` }
        });

        if (!res.ok) {
          sendResponse({ exists: false, error: "Airtable query failed" });
          return;
        }

        const data = await res.json();
        const records = data.records || [];

        if (records.length > 0) {
          const match = records[0];
          const fields = match.fields || {};
          const status = fields["Follow Up Status"] || fields["Status"] || "In Database";
          const recordUrl = `https://airtable.com/${baseId}/${tableId}/${match.id}`;
          sendResponse({
            exists: true,
            id: match.id,
            recordUrl: recordUrl,
            record: {
              id: match.id,
              name: fields["Name"] || "",
              status: status,
              recordUrl: recordUrl,
              youtube: fields["Yt link"] || "",
              email: fields["Email"] || "",
              discord: fields["Discord Page"] || "",
              twitter: fields["X account"] || "",
              instagram: fields["Instagram"] || ""
            }
          });
        } else {
          sendResponse({ exists: false });
        }
      } catch (err) {
        sendResponse({ exists: false, error: err.message });
      }
    })();
    return true;
  }

  // -------------------------------------------------------------
  // ADD YOUTUBE CHANNEL TO AIRTABLE (WITH DEEP SOCIAL ENRICHMENT)
  // -------------------------------------------------------------
  if (msg.action === "ADD_YOUTUBE_CHANNEL_TO_AIRTABLE") {
    (async () => {
      try {
        const stored = await chrome.storage.local.get(["airtableToken", "airtableBaseId", "airtableTableId"]);
        const token = msg.token || stored.airtableToken || "";
        const baseId = msg.baseId || stored.airtableBaseId || "appnD39Am5fUmSH8l";
        const tableId = msg.tableId || stored.airtableTableId || "tblBk24WqNfOcicvB";

        const name = (msg.name || "YouTube Creator").trim();
        const youtube = (msg.youtube || "").trim();
        const niche = msg.niche || "Roblox";

        // Step 1: Deep social search to automatically extract Twitter, Instagram, Discord, and Email
        let foundSocials = {};
        try {
          foundSocials = await runDeepSocialSearch({ name, youtube });
        } catch (e) {
          console.warn("Deep social search warning:", e);
        }

        // Step 2: Prepare Airtable record fields
        const newFields = {
          "Name": name,
          "Yt link": youtube,
          "Niche": Array.isArray(niche) ? niche : [niche],
          "Status": "Pending",
          "Follow Up Status": "Not Started",
          ...foundSocials
        };

        const safeFields = sanitizeFields(newFields);

        // Step 3: Insert into Airtable
        const postUrl = `https://api.airtable.com/v0/${baseId}/${tableId}`;
        const postRes = await fetch(postUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            fields: safeFields,
            typecast: true
          })
        });

        if (!postRes.ok) {
          const errText = await postRes.text().catch(() => "");
          sendResponse({ success: false, status: postRes.status, error: errText });
          return;
        }

        const record = await postRes.json();
        const foundKeys = Object.keys(foundSocials);

        // Step 4: Show desktop notification
        try {
          if (chrome.notifications && chrome.notifications.create) {
            const readable = foundKeys.length > 0 
              ? `Found: ${foundKeys.map(k => k === "X account" ? "Twitter" : k === "Discord Page" ? "Discord" : k).join(", ")}`
              : "Channel saved without extra links";
            chrome.notifications.create({
              type: "basic",
              iconUrl: "icons/icon128.png",
              title: `🎉 Added to Airtable: ${name}`,
              message: readable,
              priority: 2
            });
          }
        } catch (e) {}

        const recId = record?.id || "";
        const recordUrl = recId ? `https://airtable.com/${baseId}/${tableId}/${recId}` : "";

        sendResponse({
          success: true,
          record: record,
          recordId: recId,
          recordUrl: recordUrl,
          foundSocials: foundSocials,
          keys: foundKeys
        });
      } catch (err) {
        sendResponse({ success: false, error: err.message || "Failed to add channel" });
      }
    })();
    return true;
  }

  if (msg.action === "CREATE_AIRTABLE_RECORD") {
    (async () => {
      try {
        const stored = await chrome.storage.local.get(["airtableToken", "airtableBaseId", "airtableTableId"]);
        const token = msg.token || stored.airtableToken || "";
        const baseId = msg.baseId || stored.airtableBaseId || "appnD39Am5fUmSH8l";
        const tableId = msg.tableId || stored.airtableTableId || "tblBk24WqNfOcicvB";

        const safeFields = sanitizeFields(msg.fields);
        const url = `https://api.airtable.com/v0/${baseId}/${tableId}`;
        const res = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            fields: safeFields,
            typecast: true
          })
        });

        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          sendResponse({ success: false, status: res.status, error: errText });
          return;
        }

        const data = await res.json().catch(() => ({}));
        sendResponse({ success: true, record: data });
      } catch (err) {
        sendResponse({ success: false, error: err.message || "Failed to create record in Airtable" });
      }
    })();
    return true;
  }
});
