// Content script for YouTube - 1-Click Creator Import & In-Airtable Record Opener
(function () {
  if (typeof chrome === "undefined" || !chrome?.runtime?.id) return;

  const channelCache = new Map(); // cleanKey -> { exists, recordId, recordUrl, status, name }
  let isCheckingChannel = false;
  let isAddingChannel = false;
  let lastCheckedKey = "";
  let debounceTimer = null;

  function isChannelPage() {
    const path = window.location.pathname;
    if (path.startsWith("/watch") || path.startsWith("/shorts") || path.startsWith("/feed") || path.startsWith("/gaming")) {
      return false;
    }
    return path.startsWith("/@") || path.startsWith("/channel/") || path.startsWith("/c/") || path.startsWith("/user/");
  }

  function getCleanChannelUrl() {
    const origin = "https://www.youtube.com";
    const path = window.location.pathname;
    const m = path.match(/^(\/@[a-zA-Z0-9_\.-]+|\/channel\/[a-zA-Z0-9_\-]+|\/c\/[^\/]+|\/user\/[^\/]+)/i);
    return m ? origin + m[1] : origin + path.split("/")[1];
  }

  function getChannelHandle() {
    const path = window.location.pathname;
    const m = path.match(/^\/@([a-zA-Z0-9_\.-]+)/i);
    if (m) return `@${m[1]}`;

    const handleEl = document.querySelector('yt-page-header-renderer #channel-tagline, #channel-handle, yt-page-header-view-model #channel-tagline');
    if (handleEl && handleEl.innerText.trim()) {
      return handleEl.innerText.trim();
    }
    return "";
  }

  function getChannelId() {
    const metaId = document.querySelector('meta[itemprop="identifier"], meta[itemprop="channelId"]');
    if (metaId && metaId.content && /^UC[a-zA-Z0-9_-]{22}$/.test(metaId.content)) {
      return metaId.content;
    }
    const ogUrl = document.querySelector('meta[property="og:url"], link[rel="canonical"]');
    if (ogUrl) {
      const href = ogUrl.content || ogUrl.href || "";
      const m = href.match(/\/channel\/(UC[a-zA-Z0-9_-]{22})/i);
      if (m) return m[1];
    }
    const pathMatch = window.location.pathname.match(/\/channel\/(UC[a-zA-Z0-9_-]{22})/i);
    if (pathMatch) return pathMatch[1];
    return "";
  }

  function getChannelName() {
    const h1 = document.querySelector('yt-page-header-renderer h1, yt-page-header-view-model h1, yt-dynamic-sizing-formatted-string.ytd-page-header-renderer, ytd-channel-name #text, #channel-name #text');
    if (h1 && h1.innerText && h1.innerText.trim()) {
      return h1.innerText.trim();
    }
    const ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle && ogTitle.content && ogTitle.content.trim()) {
      return ogTitle.content.trim();
    }
    const docTitle = document.title.replace(/\s*-\s*YouTube.*$/i, '').trim();
    if (docTitle && !docTitle.toLowerCase().includes("youtube")) {
      return docTitle;
    }
    return getChannelHandle() || "YouTube Creator";
  }

  function getSubscribersText() {
    const subEl = document.querySelector('yt-page-header-renderer #additional-info-badges, yt-page-header-renderer #subscribers, #subscriber-count, yt-page-header-view-model #subscribers');
    return subEl ? subEl.innerText.trim() : "";
  }

  function detectNiche() {
    const name = getChannelName();
    const desc = document.querySelector('meta[name="description"]')?.content || "";
    const corpus = (name + " " + desc + " " + (document.body?.innerText?.slice(0, 3000) || "")).toLowerCase();
    if (corpus.includes("roblox")) return "Roblox";
    if (corpus.includes("minecraft")) return "Minecraft";
    if (corpus.includes("fortnite")) return "Fortnite";
    if (corpus.includes("valorant")) return "Valorant";
    if (corpus.includes("gta") || corpus.includes("grand theft auto")) return "GTA";
    if (corpus.includes("pokemon")) return "Pokemon";
    if (corpus.includes("tech") || corpus.includes("gadgets") || corpus.includes("review")) return "Tech Reviews";
    return "Roblox";
  }

  function playChime() {
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;
      const ctx = new AudioContextClass();
      const now = ctx.currentTime;
      const notes = [
        { freq: 523.25, time: 0.0, dur: 0.15 },
        { freq: 659.25, time: 0.12, dur: 0.18 },
        { freq: 783.99, time: 0.25, dur: 0.35 }
      ];
      notes.forEach(n => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(n.freq, now + n.time);
        gain.gain.setValueAtTime(0.001, now + n.time);
        gain.gain.exponentialRampToValueAtTime(0.2, now + n.time + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + n.time + n.dur);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + n.time);
        osc.stop(now + n.time + n.dur);
      });
    } catch (e) {}
  }

  function findSubscribeButtonContainer() {
    // 1. Direct tag/class search for YouTube subscribe button
    const direct = document.querySelector(
      '#subscribe-button ytd-subscribe-button-renderer, #subscribe-button, yt-subscribe-button-view-model, ytd-subscribe-button-renderer'
    );
    if (direct && direct.offsetHeight > 0) return direct;

    // 2. Search for button with text "Subscribe" or "Subscribed" in channel header
    const header = document.querySelector('yt-page-header-renderer, yt-page-header-view-model, #channel-header, ytd-c4-tabbed-header-renderer, #inner-header-container');
    if (header) {
      const buttons = header.querySelectorAll('button, [role="button"]');
      for (const btn of buttons) {
        const txt = (btn.innerText || btn.getAttribute('aria-label') || '').toLowerCase();
        if (txt.includes('subscribe')) {
          return btn.closest('yt-subscribe-button-view-model') || 
                 btn.closest('#subscribe-button') || 
                 btn.closest('ytd-button-renderer') || 
                 btn.parentElement;
        }
      }
    }

    // 3. Fallback header button row
    return document.querySelector('#page-header-buttons, yt-flexible-actions-view-model, #channel-header #buttons');
  }

  async function checkIfExists(channelUrl, handle, name, channelId) {
    return new Promise(resolve => {
      try {
        if (!chrome?.runtime?.id) {
          resolve({ exists: false });
          return;
        }
        chrome.runtime.sendMessage({
          action: "CHECK_YOUTUBE_CHANNEL_EXISTS",
          url: channelUrl,
          handle: handle,
          name: name,
          channelId: channelId
        }, (res) => {
          if (chrome.runtime?.lastError) resolve({ exists: false });
          else resolve(res || { exists: false });
        });
      } catch (e) {
        resolve({ exists: false });
      }
    });
  }

  async function updateChannelState() {
    if (!isChannelPage()) {
      cleanupElements();
      lastCheckedKey = "";
      return;
    }

    const channelUrl = getCleanChannelUrl();
    const handle = getChannelHandle();
    const name = getChannelName();
    const channelId = getChannelId();
    const channelKey = `${channelUrl}|${handle}|${name}|${channelId}`;

    let statusData = channelCache.get(channelKey);

    if (!statusData) {
      if (isCheckingChannel) return;
      isCheckingChannel = true;
      try {
        const res = await checkIfExists(channelUrl, handle, name, channelId);
        statusData = {
          exists: Boolean(res && res.exists),
          recordId: res?.id || res?.record?.id || "",
          recordUrl: res?.recordUrl || (res?.id ? `https://airtable.com/appnD39Am5fUmSH8l/tblBk24WqNfOcicvB/${res.id}` : ""),
          status: res?.record?.status || "In Database",
          name: res?.record?.name || name
        };
        channelCache.set(channelKey, statusData);
      } catch (err) {
        statusData = { exists: false };
      } finally {
        isCheckingChannel = false;
      }
    }

    renderAllButtons(statusData, channelUrl, handle, name, channelId, channelKey);
  }

  function cleanupElements() {
    const pill = document.getElementById("airtable-yt-pill");
    if (pill) pill.remove();
    const headerBtn = document.getElementById("airtable-yt-header-btn");
    if (headerBtn) headerBtn.remove();
  }

  function renderAllButtons(statusData, channelUrl, handle, name, channelId, channelKey) {
    // 1. Inject or update Floating Pill (Top-right of screen)
    let pill = document.getElementById("airtable-yt-pill");
    if (!pill) {
      pill = document.createElement("div");
      pill.id = "airtable-yt-pill";
      pill.style.cssText = `
        position: fixed;
        top: 72px;
        right: 24px;
        z-index: 2147483647;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        display: flex;
        align-items: center;
        gap: 8px;
        transition: opacity 0.2s ease;
      `;
      document.body.appendChild(pill);
    }
    renderButtonMarkup(pill, statusData, channelUrl, handle, name, channelId, channelKey, "pill");

    // 2. Inject or update Native Button beside YouTube's Subscribe button
    const subContainer = findSubscribeButtonContainer();
    if (subContainer && subContainer.parentNode) {
      let headerBtn = document.getElementById("airtable-yt-header-btn");
      if (!headerBtn) {
        headerBtn = document.createElement("div");
        headerBtn.id = "airtable-yt-header-btn";
        headerBtn.style.cssText = `
          display: inline-flex;
          align-items: center;
          margin-left: 10px;
          vertical-align: middle;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        `;
        if (subContainer.nextSibling) {
          subContainer.parentNode.insertBefore(headerBtn, subContainer.nextSibling);
        } else {
          subContainer.parentNode.appendChild(headerBtn);
        }
      }
      renderButtonMarkup(headerBtn, statusData, channelUrl, handle, name, channelId, channelKey, "header");
    }
  }

  function renderButtonMarkup(container, statusData, channelUrl, handle, name, channelId, channelKey, context) {
    const { exists, recordUrl, status } = statusData;

    if (exists) {
      // -----------------------------------------------------------
      // ALREADY EXISTS STATE: Clickable "In Database • Open Record ↗"
      // -----------------------------------------------------------
      const statusLabel = status || "In Database";
      container.innerHTML = `
        <button class="airtable-yt-open-btn" style="
          background: linear-gradient(135deg, rgba(16, 185, 129, 0.16) 0%, rgba(5, 150, 105, 0.28) 100%);
          border: 1px solid rgba(16, 185, 129, 0.6);
          color: #34d399;
          box-shadow: 0 4px 14px rgba(16, 185, 129, 0.2);
          border-radius: 20px;
          padding: 6px 14px;
          font-size: 12px;
          font-weight: 700;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
          outline: none;
          backdrop-filter: blur(8px);
        " title="Channel is already in Airtable! Click to open this record.">
          <span style="font-size: 13px;">✓</span>
          <span>In Database</span>
          <span style="
            background: rgba(16, 185, 129, 0.3);
            color: #ffffff;
            font-size: 10px;
            padding: 2px 7px;
            border-radius: 10px;
            font-weight: 600;
          ">${statusLabel}</span>
          <span style="
            background: rgba(255, 255, 255, 0.18);
            color: #ffffff;
            font-size: 11px;
            padding: 2px 8px;
            border-radius: 10px;
            margin-left: 2px;
            display: inline-flex;
            align-items: center;
            gap: 2px;
          ">Open Record ↗</span>
        </button>
      `;

      const btn = container.querySelector(".airtable-yt-open-btn");
      if (btn) {
        btn.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          const targetUrl = recordUrl || "https://airtable.com/appnD39Am5fUmSH8l/tblBk24WqNfOcicvB";
          window.open(targetUrl, "_blank");
        };
        btn.onmouseover = () => {
          btn.style.transform = "translateY(-1px)";
          btn.style.borderColor = "#34d399";
        };
        btn.onmouseout = () => {
          btn.style.transform = "none";
          btn.style.borderColor = "rgba(16, 185, 129, 0.6)";
        };
      }
    } else {
      // -----------------------------------------------------------
      // NOT IN DATABASE: "+ Add to Airtable"
      // -----------------------------------------------------------
      container.innerHTML = `
        <button class="airtable-yt-add-btn" style="
          background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%);
          color: #ffffff;
          border: 1px solid rgba(255, 255, 255, 0.25);
          box-shadow: 0 4px 14px rgba(99, 102, 241, 0.45);
          border-radius: 20px;
          padding: 6px 14px;
          font-size: 12px;
          font-weight: 700;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
          outline: none;
        " title="Add this YouTube channel and auto-discover socials into Airtable">
          <span class="btn-icon">🚀</span>
          <span class="btn-label">+ Add to Airtable</span>
        </button>
      `;

      const btn = container.querySelector(".airtable-yt-add-btn");
      if (btn) {
        btn.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          handleAddChannel(channelUrl, handle, name, channelId, channelKey);
        };
        btn.onmouseover = () => {
          btn.style.transform = "translateY(-1px)";
          btn.style.boxShadow = "0 6px 18px rgba(99, 102, 241, 0.6)";
        };
        btn.onmouseout = () => {
          btn.style.transform = "none";
          btn.style.boxShadow = "0 4px 14px rgba(99, 102, 241, 0.45)";
        };
      }
    }
  }

  async function handleAddChannel(channelUrl, handle, name, channelId, channelKey) {
    if (isAddingChannel) return;
    isAddingChannel = true;

    // Set loading state on all buttons
    const allAddBtns = document.querySelectorAll(".airtable-yt-add-btn");
    allAddBtns.forEach(b => {
      const icon = b.querySelector(".btn-icon");
      const label = b.querySelector(".btn-label");
      if (icon) icon.innerText = "⏳";
      if (label) label.innerText = "Finding Socials & Adding...";
      b.style.opacity = "0.85";
      b.disabled = true;
    });

    const subs = getSubscribersText();
    const niche = detectNiche();

    try {
      chrome.runtime.sendMessage({
        action: "ADD_YOUTUBE_CHANNEL_TO_AIRTABLE",
        name: name,
        youtube: channelUrl,
        handle: handle,
        channelId: channelId,
        subscribers: subs,
        niche: niche
      }, (resp) => {
        isAddingChannel = false;
        allAddBtns.forEach(b => {
          b.disabled = false;
          b.style.opacity = "1";
        });

        if (resp && resp.success) {
          playChime();

          const recordId = resp.recordId || resp.record?.id || "";
          const recordUrl = resp.recordUrl || (recordId ? `https://airtable.com/appnD39Am5fUmSH8l/tblBk24WqNfOcicvB/${recordId}` : "");

          const newStatus = {
            exists: true,
            recordId: recordId,
            recordUrl: recordUrl,
            status: "Pending",
            name: name
          };

          channelCache.set(channelKey, newStatus);
          renderAllButtons(newStatus, channelUrl, handle, name, channelId, channelKey);
        } else {
          allAddBtns.forEach(b => {
            const icon = b.querySelector(".btn-icon");
            const label = b.querySelector(".btn-label");
            if (icon) icon.innerText = "⚠️";
            if (label) label.innerText = "Error Adding";
            setTimeout(() => {
              if (icon) icon.innerText = "🚀";
              if (label) label.innerText = "+ Add to Airtable";
            }, 3000);
          });
        }
      });
    } catch (err) {
      isAddingChannel = false;
      allAddBtns.forEach(b => {
        b.disabled = false;
        b.style.opacity = "1";
        const icon = b.querySelector(".btn-icon");
        const label = b.querySelector(".btn-label");
        if (icon) icon.innerText = "🚀";
        if (label) label.innerText = "+ Add to Airtable";
      });
    }
  }

  function scheduleUpdate() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(updateChannelState, 300);
  }

  // Handle requests from popup for current channel metadata
  chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
    if (req.action === "GET_YOUTUBE_METADATA") {
      sendResponse({
        name: getChannelName(),
        handle: getChannelHandle(),
        url: getCleanChannelUrl(),
        channelId: getChannelId(),
        subscribers: getSubscribersText(),
        niche: detectNiche()
      });
      return true;
    }
  });

  // SPA navigation listeners
  window.addEventListener("yt-navigate-finish", scheduleUpdate);
  window.addEventListener("popstate", scheduleUpdate);

  // Periodic check (every 1 second) to handle dynamically mounted YouTube elements
  setInterval(updateChannelState, 1000);

  // MutationObserver with self-mutation filtering
  const observer = new MutationObserver((mutations) => {
    let shouldUpdate = false;
    for (const m of mutations) {
      if (m.target?.id === "airtable-yt-pill" || m.target?.id === "airtable-yt-header-btn") continue;
      if (m.target?.closest?.("#airtable-yt-pill, #airtable-yt-header-btn")) continue;
      shouldUpdate = true;
      break;
    }
    if (shouldUpdate) {
      scheduleUpdate();
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // Initial immediate run
  scheduleUpdate();
})();
