// Content script for Twitter/X and Instagram - Smart Outreach & DM Conversation Assistant
(function () {
  // Prevent duplicate injection and guard against invalidated extension context
  if (typeof chrome === "undefined" || !chrome?.runtime?.id) return;
  if (document.getElementById("airtable-outreach-helper")) return;

  const isTwitter = window.location.hostname.includes("twitter.com") || window.location.hostname.includes("x.com");
  const isInstagram = window.location.hostname.includes("instagram.com");

  if (!isTwitter && !isInstagram) return;

  // Active state
  let currentPitch = "";
  let creatorName = "";
  let creatorHandle = "";
  let creatorId = "";
  let creatorsLookup = [];
  let isMinimized = false;

  // Conversation intelligence state
  let conversationState = {
    messages: [],
    ourCount: 0,
    creatorCount: 0,
    followUpCount: 0,
    hasResponded: false,
    followUpText: "Not Started",
    suggestedStatus: "Messaged",
    summary: "Scanning conversation...",
    isSynced: false
  };

  // Safely load active creator details & lookup from extension storage
  try {
    chrome.storage.local.get([
      "activeOutreachPitch",
      "activeCreatorName",
      "activeCreatorHandle",
      "activeCreatorId",
      "creatorsLookup"
    ], (data) => {
      if (chrome.runtime?.lastError || !data) return;

      if (data.activeOutreachPitch) currentPitch = data.activeOutreachPitch;
      if (data.activeCreatorName) creatorName = data.activeCreatorName;
      if (data.activeCreatorHandle) creatorHandle = data.activeCreatorHandle;
      if (data.activeCreatorId) creatorId = data.activeCreatorId;
      if (Array.isArray(data.creatorsLookup)) creatorsLookup = data.creatorsLookup;

      // Detect creator from page if not already linked
      matchCreatorFromPage();

      initHelperUI();
      startOutreachAutomation();
      startConversationWatcher();
    });
  } catch (e) {
    return;
  }

  // -------------------------------------------------------------------
  // Creator Identification from URL / DOM
  // -------------------------------------------------------------------
  function matchCreatorFromPage() {
    const pageHandle = extractPageHandle();
    if (pageHandle && !creatorHandle) {
      creatorHandle = pageHandle;
    }

    if (!creatorId && creatorsLookup.length > 0 && pageHandle) {
      const cleanH = pageHandle.toLowerCase().replace(/^@/, "").trim();
      const match = creatorsLookup.find(c => {
        const twH = (c.twitter || "").toLowerCase().replace(/^https?:\/\/(www\.)?(twitter|x)\.com\//i, "").replace(/\/.*$/, "").replace(/^@/, "").trim();
        const igH = (c.instagram || "").toLowerCase().replace(/^https?:\/\/(www\.)?instagram\.com\//i, "").replace(/\/.*$/, "").replace(/^@/, "").trim();
        const n = (c.name || "").toLowerCase().trim();
        return (twH && twH === cleanH) || (igH && igH === cleanH) || (n && n === cleanH);
      });

      if (match) {
        creatorId = match.id;
        if (!creatorName) creatorName = match.name;
      }
    }

    if (!creatorName && creatorHandle) {
      creatorName = creatorHandle.startsWith("@") ? creatorHandle : `@${creatorHandle}`;
    }
  }

  function extractPageHandle() {
    try {
      const pathname = window.location.pathname.replace(/^\//, "");
      const segments = pathname.split("/").filter(Boolean);

      if (isTwitter) {
        // 1. Direct profile URL (e.g. /username)
        if (segments.length > 0 && !["home", "explore", "notifications", "messages", "i", "search"].includes(segments[0])) {
          return segments[0];
        }
        // 2. Profile link in conversation header
        const headerLink = document.querySelector('[data-testid="DMConversationHeader"] a[href^="/"], [data-testid="conversation-header"] a[href^="/"]');
        if (headerLink) {
          const href = (headerLink.getAttribute("href") || "").replace(/^\//, "").split("/")[0].split("?")[0];
          if (href && !["messages", "home", "explore", "notifications", "i", "search"].includes(href)) {
            return href;
          }
        }
        // 3. Text in conversation header
        const headerName = document.querySelector('[data-testid="DMConversationHeader"] [dir="ltr"], [data-testid="conversation-header"]');
        if (headerName && headerName.innerText) {
          const t = headerName.innerText.trim();
          if (t.startsWith("@")) return t.slice(1);
          return t;
        }
      } else if (isInstagram) {
        if (segments.length === 1 && !["direct", "explore", "reels", "stories"].includes(segments[0])) {
          return segments[0];
        }
        const headerEl = document.querySelector('header h2, div[role="main"] header span, header a[role="link"]');
        if (headerEl && headerEl.innerText) {
          return headerEl.innerText.trim();
        }
      }
    } catch (e) {}
    return "";
  }

  // -------------------------------------------------------------------
  // UI Assistant Initialization
  // -------------------------------------------------------------------
  function initHelperUI() {
    if (document.getElementById("airtable-outreach-helper")) return;

    const helper = document.createElement("div");
    helper.id = "airtable-outreach-helper";

    let savedPos = null;
    try {
      const stored = localStorage.getItem("outreach_hud_position");
      if (stored) savedPos = JSON.parse(stored);
    } catch (e) {}

    const topStyle = (savedPos && typeof savedPos.top === "number") ? `top: ${savedPos.top}px;` : `top: 75px;`;
    const leftRightStyle = (savedPos && typeof savedPos.left === "number") ? `left: ${savedPos.left}px; right: auto;` : `right: 20px; left: auto;`;

    helper.style.cssText = `
      position: fixed;
      ${topStyle}
      ${leftRightStyle}
      bottom: auto;
      background: linear-gradient(145deg, #0b0f19 0%, #171b2d 100%);
      border: 1px solid rgba(99, 102, 241, 0.5);
      color: #fff;
      padding: 12px 14px;
      border-radius: 12px;
      box-shadow: 0 16px 40px rgba(0, 0, 0, 0.85), 0 0 0 1px rgba(255, 255, 255, 0.05);
      z-index: 99999999;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 11.5px;
      display: flex;
      flex-direction: column;
      gap: 9px;
      min-width: 290px;
      max-width: 360px;
      cursor: default;
      user-select: none;
      transition: box-shadow 0.2s ease;
    `;

    const platformBadge = isTwitter ? "𝕏 Twitter" : "📷 Instagram";
    const titleText = creatorName ? `Target: ${creatorName}` : "Outreach Bot";

    helper.innerHTML = `
      <!-- Header (Draggable Handle) -->
      <div id="helperHeader" style="display:flex; justify-content:space-between; align-items:center; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 6px; cursor: move;" title="Click & Drag anywhere on screen">
        <span style="font-weight:700; color:#a5b4fc; display:flex; align-items:center; gap:6px;">
          🚀 <span id="helperTargetTitle" title="${escapeHtml(titleText)}">${escapeHtml(titleText.length > 20 ? titleText.slice(0, 18) + '...' : titleText)}</span>
          <span style="font-size:9.5px; background:#334155; color:#cbd5e1; padding:1px 6px; border-radius:4px; font-weight:600;">${platformBadge}</span>
        </span>
        <div style="display:flex; align-items:center; gap:5px;">
          <button id="togglePositionBtn" style="background:transparent; border:none; color:#94a3b8; cursor:pointer; font-size:12px; padding:2px 4px; line-height:1;" title="Toggle Screen Side">⤢</button>
          <button id="toggleMinimizeBtn" style="background:transparent; border:none; color:#94a3b8; cursor:pointer; font-size:13px; padding:2px 4px; line-height:1;" title="Minimize / Expand">➖</button>
          <button id="closeHelperBtn" style="background:transparent; border:none; color:#94a3b8; cursor:pointer; font-size:13px; padding:2px 4px; line-height:1;" title="Dismiss">✕</button>
        </div>
      </div>

      <!-- Main Assistant Content -->
      <div id="helperBodyContent" style="display:flex; flex-direction:column; gap:8px;">
        <!-- Status Notification Message -->
        <div style="font-size: 11px; color: #cbd5e1; line-height: 1.35;" id="helperStatusMsg">
          ⏳ Analyzing DM conversation thread...
        </div>

        <!-- Conversation Intelligence Badge & Counters -->
        <div id="intelCard" style="background: rgba(15, 23, 42, 0.85); border: 1px solid rgba(255,255,255,0.07); border-radius: 8px; padding: 8px; display: flex; flex-direction: column; gap: 6px;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span id="responseStatusBadge" style="font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 4px; background: rgba(245, 158, 11, 0.15); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.3);">
              ⏳ Waiting for Reply
            </span>
            <span id="messageCounters" style="font-size: 10px; color: #94a3b8; font-family: monospace;">
              Sent: 0 | Recv: 0
            </span>
          </div>

          <!-- Summary Box -->
          <div style="display:flex; flex-direction:column; gap:3px;">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <span style="font-size: 9.5px; color: #94a3b8; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">Summary & Intent</span>
              <span id="followUpPill" style="font-size: 9.5px; color: #cbd5e1; font-weight: 600;">Follow-ups: 0</span>
            </div>
            <textarea id="conversationSummaryText" rows="2" style="
              width: 100%; box-sizing: border-box; background: #070b14; border: 1px solid rgba(255,255,255,0.1);
              color: #e2e8f0; font-size: 10.5px; border-radius: 5px; padding: 5px 7px; resize: vertical; line-height: 1.35;
              font-family: inherit; outline: none;
            " placeholder="AI Conversation summary will appear here..."></textarea>
          </div>

          <!-- Status Approval Row -->
          <div style="display:flex; flex-direction:column; gap:4px; margin-top: 2px; padding-top: 6px; border-top: 1px solid rgba(255,255,255,0.06);">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <span style="font-size: 10px; color: #c7d2fe; font-weight: 600;">Update Status to:</span>
              <select id="proposedStatusSelect" style="
                background: #1e293b; color: #fff; border: 1px solid #475569; font-size: 10.5px; font-weight: 600;
                border-radius: 4px; padding: 2px 6px; outline: none; max-width: 160px;
              ">
                <option value="Replied">Replied</option>
                <option value="Came In Discord">Came In Discord</option>
                <option value="Sent Discord username">Sent Discord username</option>
                <option value="Talked About Prices">Talked About Prices</option>
                <option value="Asked Portfolio">Asked Portfolio</option>
                <option value="Sent Trail">Sent Trail</option>
                <option value="Active & Paying">Active & Paying</option>
                <option value="Placed In Content Calendar">Placed In Content Calendar</option>
                <option value="Converted">Converted</option>
                <option value="Messaged">Messaged</option>
                <option value="Did Nothing">Did Nothing</option>
                <option value="Rejected">Rejected</option>
                <option value="Dead">Dead</option>
                <option value="Not a correct Fit">Not a correct Fit</option>
                <option value="Out of Budget">Out of Budget</option>
                <option value="Ghosted">Ghosted</option>
                <option value="__custom__">+ Custom Status...</option>
              </select>
            </div>
            <input type="text" id="customStatusInput" placeholder="Type new status name..." style="
              display: none; width: 100%; box-sizing: border-box; background: #0f172a; border: 1px solid #6366f1;
              color: #fff; font-size: 10.5px; border-radius: 4px; padding: 4px 6px; outline: none;
            ">

            <!-- Approval Action Button -->
            <button id="approveSyncBtn" style="
              background: linear-gradient(135deg, #10b981, #059669); color: #fff; border: none; padding: 6px 10px;
              border-radius: 6px; font-weight: 700; cursor: pointer; font-size: 11px;
              display: flex; align-items: center; justify-content: center; gap: 5px;
              box-shadow: 0 2px 6px rgba(16, 185, 129, 0.35); margin-top: 4px;
            ">✓ Approve & Sync to Airtable</button>
          </div>
        </div>

        <!-- Quick Action Buttons Row -->
        <div id="helperActionsRow" style="display:flex; gap:6px; flex-wrap:wrap;">
          <button id="pastePitchBtn" style="
            flex:1; background:linear-gradient(135deg, #6366f1, #4f46e5); color:#fff; border:none; padding:6px 10px;
            border-radius:6px; font-weight:700; cursor:pointer; font-size:11px;
            display:flex; align-items:center; justify-content:center; gap:4px;
            box-shadow: 0 2px 6px rgba(99, 102, 241, 0.3);
          ">📋 Paste Pitch</button>
          <button id="openDmModalBtn" style="
            background:#1e293b; color:#cbd5e1; border:1px solid #334155; padding:6px 8px;
            border-radius:6px; font-weight:600; cursor:pointer; font-size:10.5px;
            display:flex; align-items:center; gap:3px;
          " title="Open DM conversation modal on profile">✉ DM</button>
          <button id="reScanChatBtn" style="
            background:#1e293b; color:#cbd5e1; border:1px solid #334155; padding:6px 8px;
            border-radius:6px; font-weight:600; cursor:pointer; font-size:10.5px;
            display:flex; align-items:center; gap:3px;
          " title="Re-scan and analyze current chat conversation">🔄 Re-Scan</button>
        </div>
      </div>
    `;

    document.body.appendChild(helper);

    // Event Handlers
    const closeBtn = document.getElementById("closeHelperBtn");
    if (closeBtn) closeBtn.addEventListener("click", () => helper.remove());

    // Draggable HUD Implementation
    const headerEl = helper.querySelector("#helperHeader");
    if (headerEl) {
      let isDragging = false;
      let startX = 0, startY = 0;
      let initialLeft = 0, initialTop = 0;

      headerEl.addEventListener("mousedown", (e) => {
        if (e.target.tagName === "BUTTON") return;
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;

        const rect = helper.getBoundingClientRect();
        initialLeft = rect.left;
        initialTop = rect.top;

        helper.style.right = "auto";
        helper.style.bottom = "auto";
        helper.style.left = `${initialLeft}px`;
        helper.style.top = `${initialTop}px`;
        helper.style.boxShadow = "0 24px 48px rgba(99, 102, 241, 0.4), 0 0 0 1px rgba(99, 102, 241, 0.8)";
        e.preventDefault();
      });

      window.addEventListener("mousemove", (e) => {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;

        const newLeft = Math.max(10, Math.min(window.innerWidth - helper.offsetWidth - 10, initialLeft + dx));
        const newTop = Math.max(10, Math.min(window.innerHeight - helper.offsetHeight - 10, initialTop + dy));

        helper.style.left = `${newLeft}px`;
        helper.style.top = `${newTop}px`;
      });

      window.addEventListener("mouseup", () => {
        if (!isDragging) return;
        isDragging = false;
        helper.style.boxShadow = "0 16px 40px rgba(0, 0, 0, 0.85), 0 0 0 1px rgba(255, 255, 255, 0.05)";

        const rect = helper.getBoundingClientRect();
        try {
          localStorage.setItem("outreach_hud_position", JSON.stringify({ top: Math.round(rect.top), left: Math.round(rect.left) }));
        } catch (e) {}
      });
    }

    // Toggle position button
    const togglePosBtn = document.getElementById("togglePositionBtn");
    if (togglePosBtn) {
      togglePosBtn.addEventListener("click", () => {
        const rect = helper.getBoundingClientRect();
        if (rect.left < window.innerWidth / 2) {
          // Switch to Top-Right
          helper.style.left = "auto";
          helper.style.right = "20px";
          helper.style.top = "75px";
          try { localStorage.removeItem("outreach_hud_position"); } catch (e) {}
        } else {
          // Switch to Top-Left
          helper.style.right = "auto";
          helper.style.left = "20px";
          helper.style.top = "75px";
          try { localStorage.setItem("outreach_hud_position", JSON.stringify({ top: 75, left: 20 })); } catch (e) {}
        }
      });
    }

    const toggleBtn = document.getElementById("toggleMinimizeBtn");
    if (toggleBtn) {
      toggleBtn.addEventListener("click", () => {
        isMinimized = !isMinimized;
        const bodyContent = document.getElementById("helperBodyContent");
        if (bodyContent) bodyContent.style.display = isMinimized ? "none" : "flex";
        toggleBtn.innerText = isMinimized ? "▢" : "➖";
        helper.style.minWidth = isMinimized ? "180px" : "290px";
      });
    }

    const pasteBtn = document.getElementById("pastePitchBtn");
    if (pasteBtn) {
      pasteBtn.addEventListener("mousedown", (e) => e.preventDefault());
      pasteBtn.addEventListener("click", async () => {
        try {
          if (chrome?.runtime?.id) {
            const stored = await chrome.storage.local.get(["activeOutreachPitch"]);
            if (stored?.activeOutreachPitch) currentPitch = stored.activeOutreachPitch;
          }
        } catch (e) {}
        if (currentPitch) {
          try { await navigator.clipboard.writeText(currentPitch); } catch (e) {}
        }
        pasteIntoActiveComposer(currentPitch);
      });
    }

    const dmBtn = document.getElementById("openDmModalBtn");
    if (dmBtn) {
      dmBtn.addEventListener("click", () => {
        triggerDmAction();
      });
    }

    const reScanBtn = document.getElementById("reScanChatBtn");
    if (reScanBtn) {
      reScanBtn.addEventListener("click", () => {
        matchCreatorFromPage();
        updateAssistantCard();
      });
    }

    const statusSelect = document.getElementById("proposedStatusSelect");
    const customInput = document.getElementById("customStatusInput");
    if (statusSelect && customInput) {
      statusSelect.addEventListener("change", () => {
        if (statusSelect.value === "__custom__") {
          customInput.style.display = "block";
          customInput.focus();
        } else {
          customInput.style.display = "none";
        }
      });
    }

    const approveBtn = document.getElementById("approveSyncBtn");
    if (approveBtn) {
      approveBtn.addEventListener("click", () => handleApproveAndSync());
    }
  }

  function setStatus(html, color = "#cbd5e1") {
    const el = document.getElementById("helperStatusMsg");
    if (el) {
      el.style.color = color;
      el.innerHTML = html;
    }
  }

  // -------------------------------------------------------------------
  // DOM Message Scraping & Analysis
  // -------------------------------------------------------------------
  function isIgnoredSystemText(t) {
    if (!t) return true;
    const lower = t.toLowerCase().trim();
    if (/^\d{1,2}:\d{2}\s*(am|pm)?$/i.test(lower)) return true;
    if (/^(today|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i.test(lower)) return true;
    if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d{1,2}(,\s*\d{4})?$/i.test(lower)) return true;
    if (["seen", "delivered", "sent", "active now", "direct messages", "messages", "message request", "pin conversation", "snooze", "delete conversation", "block", "report"].includes(lower)) return true;
    if (lower.startsWith("you accepted the request") || lower.startsWith("accepted request") || lower.startsWith("start a conversation") || lower.startsWith("joined ") || lower.startsWith("followed by") || lower.startsWith("not following each other")) return true;
    return false;
  }

  function cleanMessageText(raw) {
    if (!raw) return "";
    const lines = raw.split("\n").map(l => l.trim()).filter(Boolean);
    while (lines.length > 0 && isIgnoredSystemText(lines[lines.length - 1])) {
      lines.pop();
    }
    while (lines.length > 0 && isIgnoredSystemText(lines[0])) {
      lines.shift();
    }
    return lines.join(" ").replace(/\s+/g, " ").trim();
  }

  function extractConversationMessages() {
    const messages = [];

    try {
      if (isTwitter) {
        // Query all message entries on Twitter/X (both full-screen /messages and DM drawer)
        let entries = Array.from(document.querySelectorAll('[data-testid="messageEntry"]'));

        // Fallback: search within active chat container
        if (entries.length === 0) {
          const composer = document.querySelector('[data-testid="dmComposerTextInput"], [data-testid="dmComposerSendButton"], [role="textbox"]');
          const chatPane = composer ? (composer.closest('section, main, [role="main"], [data-testid="primaryColumn"], div[data-testid="DMDrawer"]') || document.body) : document.body;
          entries = Array.from(chatPane.querySelectorAll('div[data-testid="cellInnerDiv"], div[dir="auto"], span[dir="auto"]')).filter(el => {
            if (el.closest('#airtable-outreach-helper') || el.closest('[data-testid="dmComposerTextInput"]') || el.closest('header')) return false;
            const txt = (el.innerText || "").trim();
            return txt.length >= 1 && !isIgnoredSystemText(txt);
          });
        }

        const seenTexts = new Set();
        const rawEntries = [];

        for (const entry of entries) {
          if (entry.closest('#airtable-outreach-helper')) continue;
          if (entry.closest('[data-testid="dmComposerTextInput"]') || entry.closest('[role="textbox"]')) continue;
          if (entry.closest('[data-testid="DMConversationHeader"]') || entry.closest('header')) continue;
          if (entry.closest('[data-testid="SearchBox_Search_Input"]')) continue;

          // Clone to cleanly extract text without avatars/receipts
          let cleanText = "";
          try {
            const clone = entry.cloneNode(true);
            const toRemove = clone.querySelectorAll(
              '#airtable-outreach-helper, header, [data-testid="DMConversationHeader"], [data-testid="dmComposerTextInput"], [data-testid="SearchBox_Search_Input"], [data-testid="receipt"], [data-testid="UserAvatar"], img'
            );
            toRemove.forEach(el => el.remove());
            cleanText = cleanMessageText(clone.innerText || clone.textContent || "");
          } catch (e) {
            cleanText = cleanMessageText(entry.innerText || entry.textContent || "");
          }

          if (!cleanText || cleanText.length < 1 || isIgnoredSystemText(cleanText) || seenTexts.has(cleanText)) {
            continue;
          }
          seenTexts.add(cleanText);

          const entryRect = entry.getBoundingClientRect();

          // Multi-layer sender classification: 'me' vs 'creator'
          let sender = "creator";

          // 1. Check for incoming creator avatar (outgoing NEVER has an avatar attached)
          const hasAvatar = !!entry.querySelector('[data-testid="UserAvatar"], [data-testid*="Avatar"], img[src*="profile_images"]');
          if (hasAvatar) {
            sender = "creator";
          } else {
            // 2. Outgoing delivery receipts
            const hasReceipt = !!entry.querySelector('[data-testid="receipt"], [aria-label*="Sent" i], [aria-label*="Delivered" i], [aria-label*="Seen" i]');

            // 3. Twitter Blue / Accent background
            let hasAccentBg = false;
            const subEls = [entry, ...Array.from(entry.querySelectorAll('div, span'))];
            for (const s of subEls) {
              const bg = window.getComputedStyle(s).backgroundColor || "";
              if (bg.includes("29, 155, 240") || bg.includes("1d9bf0") || (s.outerHTML && s.outerHTML.includes("1d9bf0"))) {
                hasAccentBg = true;
                break;
              }
            }

            // 4. Horizontal alignment geometry
            let isAlignedRight = false;
            const bubble = entry.querySelector('[dir="auto"], [dir="ltr"]') || entry;
            const bubbleRect = bubble.getBoundingClientRect();
            if (entryRect.width > 0 && bubbleRect.width > 0) {
              const bubbleMidX = bubbleRect.left + bubbleRect.width / 2;
              const entryMidX = entryRect.left + entryRect.width / 2;
              if (bubbleMidX > entryMidX) {
                isAlignedRight = true;
              }
            }

            // 5. Flex alignment
            let flexRight = false;
            let checkEl = entry;
            for (let i = 0; i < 4 && checkEl; i++) {
              const st = window.getComputedStyle(checkEl);
              if (st.alignSelf === "flex-end" || st.justifyContent === "flex-end") {
                flexRight = true;
                break;
              }
              checkEl = checkEl.firstElementChild;
            }

            if (hasReceipt || hasAccentBg || isAlignedRight || flexRight) {
              sender = "me";
            } else {
              sender = "creator";
            }
          }

          rawEntries.push({ sender, text: cleanText, top: entryRect.top });
        }

        // Sort chronologically from top to bottom
        rawEntries.sort((a, b) => a.top - b.top);
        rawEntries.forEach(e => messages.push({ sender: e.sender, text: e.text }));
      } else if (isInstagram) {
        const bubbles = Array.from(document.querySelectorAll('div[role="main"] div[role="row"], div[role="grid"] div[role="row"], div[role="main"] div[dir="auto"]'));
        const container = document.querySelector('div[role="main"] div[role="grid"], div[role="main"]') || document.body;
        const cRect = container.getBoundingClientRect();
        const seenIg = new Set();

        bubbles.forEach(b => {
          if (b.closest('#airtable-outreach-helper') || b.closest('nav') || b.closest('header')) return;
          const cleanText = cleanMessageText(b.innerText || b.textContent || "");
          if (!cleanText || isIgnoredSystemText(cleanText) || cleanText.length > 1000 || seenIg.has(cleanText)) return;
          seenIg.add(cleanText);

          let sender = "creator";
          const style = window.getComputedStyle(b);
          const parentStyle = b.parentElement ? window.getComputedStyle(b.parentElement) : null;

          if (style.alignSelf === "flex-end" || (parentStyle && parentStyle.alignSelf === "flex-end")) {
            sender = "me";
          } else if (cRect.width > 0) {
            const bRect = b.getBoundingClientRect();
            if ((bRect.left + bRect.width / 2) > (cRect.left + cRect.width * 0.52)) {
              sender = "me";
            }
          }

          messages.push({ sender, text: cleanText });
        });
      }
    } catch (e) {}

    return messages;
  }

    function analyzeConversation(messages) {
    const ourMsgs = messages.filter(m => m.sender === "me");
    const creatorMsgs = messages.filter(m => m.sender === "creator");

    const ourCount = ourMsgs.length;
    const creatorCount = creatorMsgs.length;
    const hasResponded = creatorCount > 0;

    let followUpCount = 0;
    let followUpText = "Just Dm";
    let suggestedStatus = "Messaged";
    let summary = "";

    if (hasResponded) {
      followUpText = "Replied";
      const lastCreatorMsg = creatorMsgs[creatorMsgs.length - 1]?.text || "";
      const allCreatorText = creatorMsgs.map(m => m.text).join(" ");

      const emailMatch = allCreatorText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/i);
      const isRates = /(rate|rates|pricing|cost|quote|budget|media kit|deck|charge|fee|how much)/i.test(allCreatorText);
      const isDiscord = /(discord|server|invite|join)/i.test(allCreatorText);
      const isPortfolio = /(portfolio|work|samples|examples)/i.test(allCreatorText);
      const isTrial = /(trial|trail|test edit)/i.test(allCreatorText);
      const isInterested = /(interested|collab|brief|send info|send over|let's do it|sounds good|down to work)/i.test(allCreatorText);
      const isDecline = /(not interested|pass|no thanks|full|busy|stop|unsubscribe|don't message|not taking sponsors|declined)/i.test(allCreatorText);

      if (isDecline) {
        suggestedStatus = "Rejected";
        summary = `Creator declined ("${escapeTextSnippet(lastCreatorMsg, 60)}"). Sent: ${ourCount}, Recv: ${creatorCount}.`;
      } else if (isDiscord) {
        suggestedStatus = "Came In Discord";
        summary = `Creator mentioned Discord / joined server ("${escapeTextSnippet(lastCreatorMsg, 60)}"). Sent: ${ourCount}, Recv: ${creatorCount}.`;
      } else if (isPortfolio) {
        suggestedStatus = "Asked Portfolio";
        summary = `Creator requested portfolio / past work ("${escapeTextSnippet(lastCreatorMsg, 60)}"). Sent: ${ourCount}, Recv: ${creatorCount}.`;
      } else if (isTrial) {
        suggestedStatus = "Sent Trail";
        summary = `Creator discussing trial / test edit ("${escapeTextSnippet(lastCreatorMsg, 60)}"). Sent: ${ourCount}, Recv: ${creatorCount}.`;
      } else if (emailMatch) {
        suggestedStatus = "Talked About Prices";
        summary = `Creator shared business email: ${emailMatch[0]}. Sent: ${ourCount}, Recv: ${creatorCount}.`;
      } else if (isRates) {
        suggestedStatus = "Talked About Prices";
        summary = `Creator asked for rates / pricing / budget ("${escapeTextSnippet(lastCreatorMsg, 60)}"). Sent: ${ourCount}, Recv: ${creatorCount}.`;
      } else if (isInterested) {
        suggestedStatus = "Replied";
        summary = `Creator expressed interest in collaboration ("${escapeTextSnippet(lastCreatorMsg, 60)}"). Sent: ${ourCount}, Recv: ${creatorCount}.`;
      } else {
        suggestedStatus = "Replied";
        summary = `Creator replied: "${escapeTextSnippet(lastCreatorMsg, 70)}". Sent: ${ourCount}, Recv: ${creatorCount}.`;
      }
    } else {
      if (ourCount === 0) {
        followUpCount = 0;
        followUpText = "Not Started";
        suggestedStatus = "Messaged";
        summary = "DM opened. No pitch or messages sent yet.";
      } else if (ourCount === 1) {
        followUpCount = 0;
        followUpText = "Just Dm";
        suggestedStatus = "Messaged";
        summary = "Initial pitch sent. Awaiting creator's reply.";
      } else if (ourCount === 2) {
        followUpCount = 1;
        followUpText = "1st Time Follow Up";
        suggestedStatus = "Messaged";
        summary = "Initial pitch + 1 follow-up sent. Awaiting reply.";
      } else {
        followUpCount = ourCount - 1;
        followUpText = `${followUpCount}th Time Follow Up`;
        suggestedStatus = "Messaged";
        summary = `Initial pitch + ${followUpCount} follow-ups sent. No reply yet.`;
      }
    }

    return {
      messages,
      ourCount,
      creatorCount,
      followUpCount,
      hasResponded,
      followUpText,
      suggestedStatus,
      summary
    };
  }

  function escapeTextSnippet(str, max = 60) {
    if (!str) return "";
    const clean = str.replace(/\s+/g, " ").trim();
    return clean.length > max ? clean.slice(0, max - 3) + "..." : clean;
  }

  function updateAssistantCard() {
    const messages = extractConversationMessages();
    const analyzed = analyzeConversation(messages);
    conversationState = { ...conversationState, ...analyzed };

    // Update UI elements
    const badge = document.getElementById("responseStatusBadge");
    if (badge) {
      if (analyzed.hasResponded) {
        badge.innerHTML = "🟢 Creator Responded!";
        badge.style.background = "rgba(16, 185, 129, 0.15)";
        badge.style.color = "#34d399";
        badge.style.borderColor = "rgba(16, 185, 129, 0.4)";
      } else {
        badge.innerHTML = "⏳ Awaiting Reply";
        badge.style.background = "rgba(245, 158, 11, 0.15)";
        badge.style.color = "#fbbf24";
        badge.style.borderColor = "rgba(245, 158, 11, 0.4)";
      }
    }

    const counters = document.getElementById("messageCounters");
    if (counters) {
      counters.innerText = `Sent: ${analyzed.ourCount} | Recv: ${analyzed.creatorCount}`;
    }

    const followUpPill = document.getElementById("followUpPill");
    if (followUpPill) {
      followUpPill.innerText = `Follow-ups: ${analyzed.followUpCount}`;
    }

    const summaryBox = document.getElementById("conversationSummaryText");
    if (summaryBox && !summaryBox.matches(":focus")) {
      summaryBox.value = analyzed.summary;
    }

    const select = document.getElementById("proposedStatusSelect");
    if (select && !conversationState.isSynced) {
      const matchOpt = Array.from(select.options).find(o => o.value.toLowerCase() === analyzed.suggestedStatus.toLowerCase());
      if (matchOpt) {
        select.value = matchOpt.value;
      }
    }

    const titleEl = document.getElementById("helperTargetTitle");
    if (titleEl && creatorName) {
      const t = `Target: ${creatorName}`;
      titleEl.innerText = t.length > 20 ? t.slice(0, 18) + "..." : t;
      titleEl.title = t;
    }

    if (analyzed.ourCount > 0 || analyzed.creatorCount > 0) {
      setStatus(`Analyzed ${messages.length} messages. Ready to approve.`);
    }
  }

  // -------------------------------------------------------------------
  // Approval Workflow & Airtable Sync
  // -------------------------------------------------------------------
  async function handleApproveAndSync() {
    const approveBtn = document.getElementById("approveSyncBtn");
    const statusSelect = document.getElementById("proposedStatusSelect");
    const customInput = document.getElementById("customStatusInput");
    const summaryBox = document.getElementById("conversationSummaryText");

    let finalStatus = statusSelect ? statusSelect.value : conversationState.suggestedStatus;
    if (finalStatus === "__custom__") {
      finalStatus = customInput?.value.trim() || "In Discussion";
    }

    if (!creatorId) {
      try {
        const bgData = await new Promise(res => {
          chrome.storage.local.get(["creatorsLookup", "activeCreatorId", "activeCreatorName"], res);
        });
        if (bgData?.activeCreatorId) creatorId = bgData.activeCreatorId;
        if (Array.isArray(bgData?.creatorsLookup)) creatorsLookup = bgData.creatorsLookup;
      } catch (e) {}
      matchCreatorFromPage();
    }

    if (!creatorId) {
      setStatus("⚠️ Please select creator in the extension popup first to link Airtable ID.", "#fbbf24");
      return;
    }

    if (approveBtn) {
      approveBtn.disabled = true;
      approveBtn.innerText = "⏳ Syncing to Airtable...";
      approveBtn.style.opacity = "0.7";
    }

    const patchPayload = {
      "Status": finalStatus,
      "Follow Up Status": conversationState.followUpText
    };

    if (conversationState.hasResponded) {
      patchPayload["Replied"] = true;
      patchPayload["Plateform Got Replied From"] = [isTwitter ? "Twitter (x)" : "Instagram"];
    }

    try {
      // Send message to background service worker (Bypasses page CSP completely!)
      chrome.runtime.sendMessage({
        action: "PATCH_AIRTABLE",
        recordId: creatorId,
        fields: patchPayload
      }, async (response) => {
        if (response && response.success) {
          conversationState.isSynced = true;
          setStatus(`✓ Synced to Airtable! Status: <b>${escapeHtml(finalStatus)}</b>`, "#34d399");

          if (approveBtn) {
            approveBtn.disabled = false;
            approveBtn.innerText = "✓ Synced & Approved!";
            approveBtn.style.background = "linear-gradient(135deg, #059669, #047857)";
            approveBtn.style.opacity = "1";
          }

          // Update storage so popup and dashboard instantly exclude / reflect this status
          try {
            await chrome.storage.local.set({
              lastSyncedCreatorId: creatorId,
              lastSyncedStatus: finalStatus,
              lastSyncedFollowUp: conversationState.followUpText
            });
          } catch (e) {}
        } else {
          setStatus(`⚠️ Sync failed: ${response?.error || 'Airtable error'}`, "#fbbf24");
          if (approveBtn) {
            approveBtn.disabled = false;
            approveBtn.innerText = "⚠️ Retry Sync";
            approveBtn.style.opacity = "1";
          }
        }
      });
    } catch (err) {
      setStatus("⚠️ Extension context reloaded. Please refresh the page.", "#fbbf24");
      if (approveBtn) {
        approveBtn.disabled = false;
        approveBtn.innerText = "⚠️ Retry Sync";
      }
    }
  }

  // -------------------------------------------------------------------
  // DOM Observer for Dynamic Conversation Loading
  // -------------------------------------------------------------------
  function startConversationWatcher() {
    let scanTimeout = null;

    const debouncedScan = () => {
      clearTimeout(scanTimeout);
      scanTimeout = setTimeout(() => {
        matchCreatorFromPage();
        updateAssistantCard();
      }, 700);
    };

    // Run initial scan after page settles
    setTimeout(debouncedScan, 800);
    setTimeout(debouncedScan, 2000);
    setTimeout(debouncedScan, 4000);
    // Heartbeat scan every 3 seconds to auto-update on new incoming/outgoing messages
    setInterval(debouncedScan, 3000);

    // Watch for new messages or scroll updates
    const observer = new MutationObserver((mutations) => {
      let shouldScan = false;
      for (const m of mutations) {
        if (m.addedNodes.length > 0 || m.type === "childList") {
          shouldScan = true;
          break;
        }
      }
      if (shouldScan) debouncedScan();
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  // -------------------------------------------------------------------
  // Composer & Pitch Injection
  // -------------------------------------------------------------------
  function getProfileMessageButton() {
    if (isTwitter) {
      // 1. Direct Twitter testid
      const b1 = document.querySelector('[data-testid="sendDMFromProfile"]');
      if (b1 && !b1.closest('nav') && !b1.closest('[data-testid="AppTabBar_DirectMessage_Link"]')) {
        return b1;
      }

      // 2. Direct message compose links
      const b2 = document.querySelector('a[href^="/messages/compose"], a[href*="/messages/"]');
      if (b2 && !b2.closest('nav') && !b2.closest('[data-testid="AppTabBar_DirectMessage_Link"]')) {
        return b2;
      }

      // 3. User profile header button area
      const headerScope = document.querySelectorAll(
        '[data-testid="primaryColumn"] [data-testid="UserProfileHeader_Items"] *,' +
        '[data-testid="primaryColumn"] [data-testid="placementTracking"] *,' +
        '[data-testid="primaryColumn"] div[data-testid="UserName"] ~ div *'
      );
      for (const el of headerScope) {
        if (el.closest('nav') || el.closest('[data-testid="AppTabBar_DirectMessage_Link"]')) continue;
        const aria = (el.getAttribute("aria-label") || "").toLowerCase();
        if (aria.includes("direct message") || aria.includes("message")) {
          return el;
        }
      }

      // 4. Any button with envelope icon SVG in profile header
      const headerButtons = document.querySelectorAll('[data-testid="primaryColumn"] button, [data-testid="primaryColumn"] div[role="button"], [data-testid="primaryColumn"] a[role="link"]');
      for (const btn of headerButtons) {
        if (btn.closest('nav') || btn.closest('[data-testid="AppTabBar_DirectMessage_Link"]')) continue;
        const aria = (btn.getAttribute("aria-label") || "").toLowerCase();
        if (aria.includes("follow") || aria.includes("more") || aria.includes("notify") || aria.includes("search")) continue;

        const svg = btn.querySelector("svg");
        if (svg) {
          const path = svg.querySelector("path");
          const d = path ? path.getAttribute("d") : "";
          if (d && (d.startsWith("M1.998") || d.startsWith("M2.25") || d.startsWith("M3 ") || d.includes("19.5h-15") || d.includes("M20 "))) {
            return btn;
          }
        }
      }
      return null;
    } else if (isInstagram) {
      const candidates = Array.from(document.querySelectorAll("header button, header div[role='button'], section main header button, a[href*='/direct/t/']"));
      return candidates.find(b => {
        const txt = (b.innerText || "").trim().toLowerCase();
        return txt === "message" || (b.getAttribute("href") && b.getAttribute("href").includes("/direct/t/"));
      }) || null;
    }
    return null;
  }

  function getDmComposerInput() {
    if (isTwitter) {
      const candidates = [
        '[data-testid="dmComposerTextInput"] [contenteditable="true"]',
        '[data-testid="dmComposerTextInput"] [role="textbox"]',
        '[data-testid="dmComposerTextInput"] div.public-DraftEditor-content',
        '[data-testid="dmComposerTextInput"] div[data-lexical-editor="true"]',
        '[data-testid="dmComposerTextInput"]',
        '[data-testid="DMDrawer"] [contenteditable="true"]',
        '[data-testid="DMDrawer"] [role="textbox"]',
        '[aria-label="Direct message conversation"] [contenteditable="true"]',
        '[aria-label="Direct message conversation"] [role="textbox"]',
        '[data-testid="conversation"] [contenteditable="true"]',
        '[data-testid="conversation"] [role="textbox"]',
        'div[role="textbox"][contenteditable="true"]',
        'div[contenteditable="true"][data-lexical-editor="true"]',
        'div.public-DraftEditor-content[contenteditable="true"]'
      ];

      for (const sel of candidates) {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          if (el.closest('header') || el.closest('nav') || el.closest('[data-testid="SearchBox_Search_Input"]')) continue;
          if (el.offsetParent !== null || el.getClientRects().length > 0) return el;
        }
      }

      if (document.activeElement && document.activeElement !== document.body && document.activeElement.isContentEditable) {
        return document.activeElement;
      }
    } else if (isInstagram) {
      const candidates = [
        'div[aria-label="Message"][contenteditable="true"]',
        'div[role="textbox"][contenteditable="true"]',
        'div[contenteditable="true"][data-lexical-editor="true"]',
        'div[role="main"] textarea',
        'textarea[placeholder*="Message" i]',
        'textarea'
      ];
      for (const sel of candidates) {
        const el = document.querySelector(sel);
        if (el && (el.offsetParent !== null || el.getClientRects().length > 0)) return el;
      }
    }
    return null;
  }

  async function pasteIntoActiveComposer(text) {
    if (!text) {
      try {
        if (chrome?.runtime?.id) {
          const stored = await chrome.storage.local.get(["activeOutreachPitch"]);
          if (stored?.activeOutreachPitch) text = stored.activeOutreachPitch;
        }
      } catch (e) {}
    }

    if (!text) {
      setStatus("⚠️ No pitch set. Select a template in extension popup.", "#fbbf24");
      return false;
    }

    // Always copy to clipboard as 100% reliable guarantee
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {}

    let composer = getDmComposerInput();
    if (!composer) {
      if (document.activeElement && document.activeElement !== document.body && document.activeElement.isContentEditable) {
        composer = document.activeElement;
      }
    }

    if (!composer) {
      setStatus("👉 Click inside the message box, then click <b>📋 Paste Pitch</b> (or press Ctrl+V)!", "#fbbf24");
      return false;
    }

    try {
      composer.focus();

      // 1. Position caret at the end
      try {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(composer);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      } catch (e) {}

      // 2. Synthetic ClipboardEvent (Crucial for Twitter's Draft.js / Lexical editor)
      let pastedViaClipboardEvent = false;
      try {
        const dt = new DataTransfer();
        dt.setData("text/plain", text);
        const pasteEvt = new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: dt
        });
        pastedViaClipboardEvent = composer.dispatchEvent(pasteEvt);
      } catch (e) {}

      // 3. Document execCommand
      let execDone = false;
      try {
        execDone = document.execCommand("insertText", false, text);
      } catch (e) {}

      // 4. Direct DOM fallback if still empty
      const cur = (composer.innerText || composer.textContent || "").trim();
      if (!cur || (!execDone && !pastedViaClipboardEvent)) {
        if (composer.tagName === "TEXTAREA" || composer.tagName === "INPUT") {
          composer.value = text;
        } else {
          try {
            composer.innerHTML = "";
            const lines = text.split("\n");
            lines.forEach((line, i) => {
              if (i > 0) composer.appendChild(document.createElement("br"));
              if (line) composer.appendChild(document.createTextNode(line));
            });
          } catch (e) {
            composer.innerText = text;
          }
        }
      }

      // 5. Dispatch synthetic React & Lexical state events
      try {
        composer.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertFromPaste", data: text }));
        composer.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: text }));
        composer.dispatchEvent(new Event("change", { bubbles: true }));
      } catch (e) {}

      // 6. Trigger a key event so Twitter's Send button enables
      try {
        composer.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: " ", code: "Space" }));
        composer.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: " ", code: "Space" }));
      } catch (e) {}

      setStatus("✓ <b>Pitch pasted into chat!</b> Press Enter to send (or Ctrl+V).", "#34d399");
      return true;
    } catch (err) {
      setStatus("📋 Pitch copied! Press Ctrl+V inside the message box.", "#fbbf24");
      return false;
    }
  }

  function pollForComposerAndPaste(text, maxSeconds = 10) {
    let elapsed = 0;
    const interval = setInterval(() => {
      elapsed += 0.4;
      const composer = getDmComposerInput();
      if (composer) {
        clearInterval(interval);
        setTimeout(() => pasteIntoActiveComposer(text), 300);
        return;
      }
      if (elapsed >= maxSeconds) {
        clearInterval(interval);
        setStatus("DM opened! Click inside message box & click <b>📋 Paste Pitch</b>.", "#fbbf24");
      }
    }, 400);
  }

  function triggerDmAction() {
    const composer = getDmComposerInput();
    if (composer) {
      pasteIntoActiveComposer(currentPitch);
      return;
    }

    const dmBtn = getProfileMessageButton();
    if (dmBtn) {
      setStatus("Opening Direct Message modal...");
      dmBtn.click();
      pollForComposerAndPaste(currentPitch);
    } else {
      handleDmsClosedOnProfile();
    }
  }

  function startOutreachAutomation() {
    const initialComposer = getDmComposerInput();
    if (initialComposer) {
      setStatus("Found DM chat box! Pasting pitch...");
      setTimeout(() => pasteIntoActiveComposer(currentPitch), 600);
      return;
    }

    const isThreadUrl = window.location.pathname.startsWith("/messages") || window.location.pathname.startsWith("/i/chat") || window.location.pathname.includes("/direct/t/");
    if (isThreadUrl) {
      setStatus("Loading conversation thread...");
      pollForComposerAndPaste(currentPitch, 12);
      return;
    }

    setStatus("Locating Message button on creator profile...");
    let attempts = 0;
    const autoInterval = setInterval(() => {
      attempts++;
      const dmBtn = getProfileMessageButton();
      if (dmBtn) {
        clearInterval(autoInterval);
        setStatus("Found Message button! Opening DM...");
        dmBtn.click();
        pollForComposerAndPaste(currentPitch);
        return;
      }

      const composer = getDmComposerInput();
      if (composer) {
        clearInterval(autoInterval);
        pasteIntoActiveComposer(currentPitch);
        return;
      }

      if (attempts >= 10) {
        clearInterval(autoInterval);
        handleDmsClosedOnProfile();
      }
    }, 500);
  }

  function handleDmsClosedOnProfile() {
    const pageHandle = extractPageHandle();
    const handleText = pageHandle ? `@${pageHandle}` : "this creator";

    let match = null;
    if (pageHandle && creatorsLookup.length > 0) {
      const cleanH = pageHandle.toLowerCase().replace(/^@/, '').trim();
      match = creatorsLookup.find(c => {
        const tw = (c.twitter || "").toLowerCase().replace(/^https?:\/\/(www\.)?(twitter|x)\.com\//i, '').replace(/\/.*$/, '').replace(/^@/, '').trim();
        const ig = (c.instagram || "").toLowerCase().replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/\/.*$/, '').replace(/^@/, '').trim();
        return tw === cleanH || ig === cleanH || (c.name || '').toLowerCase().trim() === cleanH;
      });
    }

    setStatus(`⚠️ DMs appear closed on ${escapeHtml(handleText)}'s profile. Reach out via:`, "#fbbf24");

    const row = document.getElementById("helperActionsRow");
    if (row) {
      // 1. Tweet mention button
      if (pageHandle && !document.getElementById("tweetMentionBtn")) {
        const tweetBtn = document.createElement("button");
        tweetBtn.id = "tweetMentionBtn";
        tweetBtn.style.cssText = `
          background: #1d9bf0; color: #fff; border: none; padding: 5px 8px;
          border-radius: 5px; font-weight: 600; cursor: pointer; font-size: 10.5px;
          display: inline-flex; align-items: center; gap: 3px;
        `;
        tweetBtn.innerHTML = `📢 Tweet @${escapeHtml(pageHandle)}`;
        tweetBtn.title = `Send public mention tweet to @${pageHandle}`;
        tweetBtn.addEventListener("click", () => {
          const shortPitch = (currentPitch.split("\n\n")[0] || currentPitch).slice(0, 100);
          const text = `@${pageHandle} ${shortPitch}`;
          window.open(`https://x.com/intent/tweet?text=${encodeURIComponent(text)}`, "_blank");
        });
        row.appendChild(tweetBtn);
      }

      // 2. Instagram alternative
      if (match?.instagram && !document.getElementById("altIgBtn")) {
        const igBtn = document.createElement("button");
        igBtn.id = "altIgBtn";
        igBtn.style.cssText = `
          background: #e1306c; color: #fff; border: none; padding: 5px 8px;
          border-radius: 5px; font-weight: 600; cursor: pointer; font-size: 10.5px;
          display: inline-flex; align-items: center; gap: 3px;
        `;
        igBtn.innerHTML = `📷 Open IG`;
        igBtn.title = `Open Instagram for ${match.name}`;
        igBtn.addEventListener("click", () => {
          window.open(match.instagram, "_blank");
        });
        row.appendChild(igBtn);
      }

      // 3. Discord alternative
      if (match?.discord && !document.getElementById("altDiscBtn")) {
        const discBtn = document.createElement("button");
        discBtn.id = "altDiscBtn";
        discBtn.style.cssText = `
          background: #5865f2; color: #fff; border: none; padding: 5px 8px;
          border-radius: 5px; font-weight: 600; cursor: pointer; font-size: 10.5px;
          display: inline-flex; align-items: center; gap: 3px;
        `;
        discBtn.innerHTML = `💬 Discord`;
        discBtn.title = `Open Discord server for ${match.name}`;
        discBtn.addEventListener("click", () => {
          window.open(match.discord, "_blank");
        });
        row.appendChild(discBtn);
      }
    }
  }

  function escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
})();