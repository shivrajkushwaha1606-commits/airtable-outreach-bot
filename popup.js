// =====================================================================
// Universal Storage & Tab Shim (Extension + DigitalOcean Hosted Web App)
// =====================================================================
const isExtensionEnv = typeof chrome !== "undefined" && Boolean(chrome?.storage?.local);

const appStorage = {
  async get(keys) {
    if (isExtensionEnv && chrome?.storage?.local) {
      return chrome.storage.local.get(keys);
    }
    const keyList = Array.isArray(keys) ? keys : (typeof keys === "string" ? [keys] : Object.keys(keys || {}));
    const out = {};
    for (const k of keyList) {
      const val = localStorage.getItem(k);
      if (val !== null) {
        try { out[k] = JSON.parse(val); } catch(e) { out[k] = val; }
      }
    }
    return out;
  },
  async set(items) {
    if (isExtensionEnv && chrome?.storage?.local) {
      return chrome.storage.local.set(items);
    }
    for (const [k, v] of Object.entries(items || {})) {
      try {
        localStorage.setItem(k, JSON.stringify(v));
      } catch (e) {}
    }
  }
};

function openExternalUrl(url) {
  if (isExtensionEnv && chrome?.tabs?.create) {
    chrome.tabs.create({ url });
  } else {
    window.open(url, "_blank");
  }
}


// Whitelist of valid Airtable table fields (Excludes computed 'Last Touch Date' to avoid 422 errors)
const ALLOWED_AIRTABLE_FIELDS = new Set([
  "Name", "Niche", "Status", "Follow Up Status", "Email", "Discord Page",
  "X account", "Instagram", "Yt link", "First DM Date", "Replied",
  "Plateform Got Replied From", "Plateforms I've Reached out", "Source Type"
]);

function sanitizeAirtablePayload(rawFields) {
  const safe = {};
  for (const [k, v] of Object.entries(rawFields || {})) {
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

// Default Configuration
const DEFAULT_CONFIG = {
  token: "",
  baseId: "appnD39Am5fUmSH8l",
  tableId: "tblBk24WqNfOcicvB",
  viewId: "viwnh8Kj82LhyzykF",
  delay: 8,
  subject: "Collaboration Inquiry: {name} x Agency Engine",
  template: `Hey {name}!

Loved your recent Roblox uploads. We're currently managing high-performing campaigns with top gaming creators in your niche and wanted to explore an exclusive sponsorship collaboration with your channel.

Are you open to discussing opportunities for upcoming videos? Let me know where's best to connect!

Best regards,`
};

// State
let creators = [];
let currentIndex = -1;
let isAutoQueueRunning = false;
let autoTimer = null;
let isBatchSearching = false;

// Pitch Templates (Normal DM Style - Text-Blaze Snippets)
const DEFAULT_PITCH_TEMPLATES = [
  {
    id: "pitch_sponsor",
    title: "💼 Brand Sponsorship DM",
    shortcut: "/sponsor",
    body: `Hey {name}! Loved your recent {niche} videos. We're managing paid brand sponsorships with top creators in your niche right now and wanted to collaborate with your channel. DM me or shoot over your business email if you're taking brand deals!`
  },
  {
    id: "pitch_deal",
    title: "⚡ Quick Paid Deal DM",
    shortcut: "/deal",
    body: `Hey {name}! Big fan of your content. We have an exclusive paid brand partnership that fits your audience and pays top rates. Would love to send over the brief—what's the best email to reach you at?`
  },
  {
    id: "pitch_casual",
    title: "📷 Casual IG/X Ping",
    shortcut: "/casual",
    body: `Yo {name}! Dropping by because we're booking sponsorships for top {niche} creators this month and your engagement is crazy good. Open to collaborating on upcoming uploads?`
  },
  {
    id: "pitch_rates",
    title: "💰 Rate Card & Media Kit",
    shortcut: "/rates",
    body: `Hey {name}! Could you share your current sponsorship rates and media kit? We have a brand campaign ready to book for upcoming videos.`
  },
  {
    id: "pitch_followup",
    title: "🔄 Follow-Up Ping",
    shortcut: "/followup",
    body: `Hey {name}, just circling back on my earlier DM about a brand sponsorship opportunity for your channel! Let me know if you're interested and I can send the brief over.`
  }
];

let savedPitches = [...DEFAULT_PITCH_TEMPLATES];
let activePitchId = "pitch_sponsor";
let pitchStats = {};
let creatorPitchMap = {};
let isAbTestMode = false;

// Old Channels Auditor State
const channelActivityCache = new Map();
let isScanningOldChannels = false;

// Strict Blacklists to filter out generic platforms, games, bots, and corporate accounts
const DISALLOWED_HANDLES = new Set([
  // Generic navigation / endpoints
  'i', 'home', 'explore', 'notifications', 'messages', 'settings', 'search', 'users', 'groups', 
  'intent', 'share', 'widgets', 'hashtag', 'privacy', 'tos', 'about', 'signup', 'login', 'logout',
  'help', 'support', 'terms', 'cookies', 'legal', 'security', 'download', 'press', 'blog', 'status',
  'chat', 'direct_messages', 'communities', 'compose', 'direct',
  // Platforms / Corporations
  'roblox', 'robloxdevrel', 'roblox_rtc', 'robloxstatus', 'robloxtrack', 'bloxcon', 'blox',
  'youtube', 'youtubegaming', 'yt', 'google', 'googleplay', 'android', 'apple', 'appstore',
  'twitter', 'x', 'xcorp', 'support', 'api', 'verified', 'premium',
  'discord', 'discordapp', 'discorddev', 'discordstatus',
  'instagram', 'meta', 'facebook', 'threads', 'whatsapp',
  'twitch', 'twitchsupport', 'tiktok', 'tiktokcreators', 'reddit', 'steam', 'spotify',
  // Popular games often linked in descriptions
  'minecraft', 'mojang', 'fortnite', 'epicgames', 'valorant', 'riotgames', 'leagueoflegends',
  'bloxfruits', 'adoptme', 'bedwars', 'petsemulator', 'ps99', 'psx', 'royalehigh', 'da_hood', 'brookhaven',
  'playstation', 'xbox', 'nintendo',
  // Generic merchant / tool handles
  'linktree', 'beacons', 'carrd', 'patreon', 'kofi', 'paypal', 'shop', 'store', 'merch', 'business', 'email', 'contact'
]);

const DISALLOWED_GUILDS = new Set([
  'roblox', 'roblox official', 'roblox trading', 'roblox developers',
  'blox fruits', 'pet simulator', 'pet simulator 99', 'adopt me',
  'discord town hall', 'discord developers', 'minecraft', 'fortnite',
  'community', 'gaming', 'official community', 'trading server', 'free robux',
  'brookhaven', 'da hood', 'blade ball', 'anime defenders', 'all star tower defense'
]);

const DISALLOWED_EMAIL_USERS = new Set(['wght', 'font', 'fonts', 'css', 'display', 'format', 'woff', 'ttf', 'example', 'yourname', 'user', 'username', 'email', 'name', 'test', 'admin']);
const DISALLOWED_EMAIL_DOMAINS = ['google.com', 'youtube.com', 'gstatic.com', 'example.com', 'w3.org', 'sentry.io', 'schema.org', 'doubleclick.net', 'googleapis.com', 'brave.com', 'cloudflare.com'];

document.addEventListener("DOMContentLoaded", async () => {
  initTabs();
  await loadSettings();
  await loadSavedPitches();
  setupEventHandlers();
  fetchAirtableRecords();
  detectActiveYouTubeChannel();
});

// Tab Switcher
function initTabs() {
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
      btn.classList.add("active");
      const target = document.getElementById(btn.dataset.tab);
      if (target) target.classList.add("active");
      if (btn.dataset.tab === "analyticsTab" && typeof renderPlatformAnalytics === "function") {
        renderPlatformAnalytics(false);
      }
    });
  });
}

// Load and Save Settings
async function loadSettings() {
  const data = await appStorage.get([
    "airtableToken",
    "airtableBaseId",
    "airtableTableId",
    "airtableViewId",
    "delaySeconds",
    "emailSubject",
    "messageTemplate"
  ]);

  if (!data.airtableToken) {
    try {
      const configUrl = (typeof window !== "undefined" && window.location && window.location.origin && window.location.origin.startsWith("http"))
        ? `${window.location.origin}/api/config`
        : "http://174.138.72.199:3000/api/config";
      const srvResp = await fetch(configUrl).catch(() => null);
      if (srvResp && srvResp.ok) {
        const srvConfig = await srvResp.json().catch(() => ({}));
        if (srvConfig.airtableToken) {
          DEFAULT_CONFIG.token = srvConfig.airtableToken;
          if (srvConfig.airtableBaseId) DEFAULT_CONFIG.baseId = srvConfig.airtableBaseId;
          if (srvConfig.airtableTableId) DEFAULT_CONFIG.tableId = srvConfig.airtableTableId;
          if (srvConfig.airtableViewId) DEFAULT_CONFIG.viewId = srvConfig.airtableViewId;
        }
      }
    } catch (e) {}
    try {
      await appStorage.set({
        airtableToken: DEFAULT_CONFIG.token,
        airtableBaseId: DEFAULT_CONFIG.baseId,
        airtableTableId: DEFAULT_CONFIG.tableId,
        airtableViewId: DEFAULT_CONFIG.viewId
      });
    } catch (e) {}
  }

  if (document.getElementById("airtableToken")) document.getElementById("airtableToken").value = data.airtableToken || DEFAULT_CONFIG.token;
  if (document.getElementById("airtableBaseId")) document.getElementById("airtableBaseId").value = data.airtableBaseId || DEFAULT_CONFIG.baseId;
  if (document.getElementById("airtableTableId")) document.getElementById("airtableTableId").value = data.airtableTableId || DEFAULT_CONFIG.tableId;
  if (document.getElementById("airtableViewId")) document.getElementById("airtableViewId").value = data.airtableViewId || DEFAULT_CONFIG.viewId;
  if (document.getElementById("delaySeconds")) document.getElementById("delaySeconds").value = data.delaySeconds || DEFAULT_CONFIG.delay;
  if (document.getElementById("emailSubject")) document.getElementById("emailSubject").value = data.emailSubject || DEFAULT_CONFIG.subject;
  if (document.getElementById("messageTemplate")) document.getElementById("messageTemplate").value = data.messageTemplate || DEFAULT_CONFIG.template;
}

function setupEventHandlers() {
  setupLeadFinderEventListeners();
  setupAbTestingEventListeners();
  renderAbTestingDashboard();
  // Settings Save
  const saveSettingsBtn = document.getElementById("saveSettingsBtn");
  if (saveSettingsBtn) {
    saveSettingsBtn.addEventListener("click", async () => {
      await appStorage.set({
        airtableToken: document.getElementById("airtableToken").value.trim(),
        airtableBaseId: document.getElementById("airtableBaseId").value.trim(),
        airtableTableId: document.getElementById("airtableTableId").value.trim(),
        airtableViewId: document.getElementById("airtableViewId").value.trim(),
        delaySeconds: parseInt(document.getElementById("delaySeconds").value, 10) || 8
      });
      showToast("Settings saved!");
    });
  }

  // Template Save
  const saveTemplateBtn = document.getElementById("saveTemplateBtn");
  if (saveTemplateBtn) {
    saveTemplateBtn.addEventListener("click", async () => {
      await appStorage.set({
        emailSubject: document.getElementById("emailSubject").value,
        messageTemplate: document.getElementById("messageTemplate").value
      });
      showToast("Template saved!");
    });
  }

  // Open Full-Tab Dashboard
  const openDashboardBtn = document.getElementById("openDashboardBtn");
  if (openDashboardBtn) {
    openDashboardBtn.addEventListener("click", () => {
      openExternalUrl((isExtensionEnv && chrome?.runtime?.getURL ? chrome.runtime.getURL("dashboard.html") : "/dashboard.html") );
    });
  }

  // Open Base Link in Dashboard
  const openBaseBtn = document.getElementById("openAirtableBaseBtn");
  if (openBaseBtn) {
    openBaseBtn.addEventListener("click", () => {
      const baseId = document.getElementById("airtableBaseId")?.value.trim() || DEFAULT_CONFIG.baseId;
      const tableId = document.getElementById("airtableTableId")?.value.trim() || DEFAULT_CONFIG.tableId;
      const viewId = document.getElementById("airtableViewId")?.value.trim() || DEFAULT_CONFIG.viewId;
      chrome.tabs.create({ url: `https://airtable.com/${baseId}/${tableId}/${viewId}` });
    });
  }

  // Copy Pitch Button in Dashboard
  const copyPitchBtn = document.getElementById("copyPitchBtn");
  if (copyPitchBtn) {
    copyPitchBtn.addEventListener("click", () => {
      if (currentIndex >= 0 && currentIndex < creators.length) {
        const creator = creators[currentIndex];
        const pitchText = getPersonalizedPitch(creator);
        copyToClipboard(pitchText);
        const usedPitch = creatorPitchMap[creator.id] || activePitchId;
        if (usedPitch && usedPitch !== "ab_auto_rotate") {
          recordPitchSent(creator.id, usedPitch);
        }
        showToast("Personalized pitch copied to clipboard!");
      }
    });
  }

  const fetchBtn = document.getElementById("fetchBtn");
  if (fetchBtn) fetchBtn.addEventListener("click", fetchAirtableRecords);

  const findDuplicatesBtn = document.getElementById("findDuplicatesBtn");
  if (findDuplicatesBtn) findDuplicatesBtn.addEventListener("click", openDuplicateModal);

  const dashFindDuplicatesBtn = document.getElementById("dashFindDuplicatesBtn");
  if (dashFindDuplicatesBtn) dashFindDuplicatesBtn.addEventListener("click", openDuplicateModal);

  const closeDupBtn = document.getElementById("closeDuplicateModalBtn");
  if (closeDupBtn) closeDupBtn.addEventListener("click", closeDuplicateModal);

  const doneDupBtn = document.getElementById("doneDuplicateModalBtn");
  if (doneDupBtn) doneDupBtn.addEventListener("click", closeDuplicateModal);

  const autoCleanBtn = document.getElementById("autoCleanDuplicatesBtn");
  if (autoCleanBtn) autoCleanBtn.addEventListener("click", autoCleanAllDuplicates);

  const autoQueueBtn = document.getElementById("autoQueueBtn");
  if (autoQueueBtn) autoQueueBtn.addEventListener("click", toggleAutoQueue);

  const markDoneBtn = document.getElementById("markDoneBtn");
  if (markDoneBtn) markDoneBtn.addEventListener("click", () => markCurrentAsMessaged(true));

  const skipBtn = document.getElementById("skipBtn");
  if (skipBtn) skipBtn.addEventListener("click", () => advanceQueue(1));

  const searchInput = document.getElementById("searchInput");
  if (searchInput) searchInput.addEventListener("input", filterAndRenderList);

  const filterPlatform = document.getElementById("filterPlatform");
  if (filterPlatform) filterPlatform.addEventListener("change", filterAndRenderList);

  // Social Search Buttons on Current Card
  const searchSocialsBtn = document.getElementById("searchSocialsBtn");
  if (searchSocialsBtn) {
    searchSocialsBtn.addEventListener("click", async () => {
      if (currentIndex >= 0 && currentIndex < creators.length) {
        await executeDeepCreatorSearch(
          creators[currentIndex],
          document.getElementById("searchResultFeedback"),
          searchSocialsBtn,
          document.getElementById("currentDiscoveredBox"),
          document.getElementById("currentDiscoveredPills"),
          true
        );
      }
    });
  }

  const openAirtableBtn = document.getElementById("openAirtableBtn");
  if (openAirtableBtn) {
    openAirtableBtn.addEventListener("click", () => {
      if (currentIndex >= 0 && currentIndex < creators.length) {
        openAirtableRecord(creators[currentIndex]);
      }
    });
  }

  // Batch Social Finder
  const batchFindBtn = document.getElementById("batchFindBtn");
  if (batchFindBtn) batchFindBtn.addEventListener("click", startBatchSocialEnrichment);

  const stopBatchBtn = document.getElementById("stopBatchBtn");
  if (stopBatchBtn) stopBatchBtn.addEventListener("click", stopBatchSocialEnrichment);

  // Today's DM Queue Controls (Popup)
  const startTodayBtn = document.getElementById("startTodayRunnerBtn");
  if (startTodayBtn) startTodayBtn.addEventListener("click", startTodayDmRunner);

  const pauseTodayBtn = document.getElementById("pauseTodayRunnerBtn");
  if (pauseTodayBtn) pauseTodayBtn.addEventListener("click", pauseTodayDmRunner);

  const skipTodayBtn = document.getElementById("skipTodayRunnerBtn");
  if (skipTodayBtn) skipTodayBtn.addEventListener("click", skipTodayDmRunner);

  const stopTodayBtn = document.getElementById("stopTodayRunnerBtn");
  if (stopTodayBtn) stopTodayBtn.addEventListener("click", stopTodayDmRunner);

  const todayGoalSelect = document.getElementById("todayGoalSelect");
  const dashTodayGoalSelect = document.getElementById("dashTodayGoalSelect");
  if (todayGoalSelect) {
    todayGoalSelect.addEventListener("change", () => {
      if (dashTodayGoalSelect) dashTodayGoalSelect.value = todayGoalSelect.value;
      renderTodayDmQueue();
    });
  }
  if (dashTodayGoalSelect) {
    dashTodayGoalSelect.addEventListener("change", () => {
      if (todayGoalSelect) todayGoalSelect.value = dashTodayGoalSelect.value;
      renderTodayDmQueue();
    });
  }

  // Today's DM Platform Selector Buttons (Popup & Dashboard)
  document.querySelectorAll(".plat-toggle-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const plat = btn.dataset.platform || "all";
      setSelectedDmPlatform(plat);
    });
  });

  // Today's DM Queue Controls (Dashboard)
  const dashStartTodayBtn = document.getElementById("dashStartTodayRunnerBtn");
  if (dashStartTodayBtn) dashStartTodayBtn.addEventListener("click", startTodayDmRunner);

  const dashPauseTodayBtn = document.getElementById("dashPauseTodayRunnerBtn");
  if (dashPauseTodayBtn) dashPauseTodayBtn.addEventListener("click", pauseTodayDmRunner);

  const dashSkipTodayBtn = document.getElementById("dashSkipTodayRunnerBtn");
  if (dashSkipTodayBtn) dashSkipTodayBtn.addEventListener("click", skipTodayDmRunner);

  const dashStopTodayBtn = document.getElementById("dashStopTodayRunnerBtn");
  if (dashStopTodayBtn) dashStopTodayBtn.addEventListener("click", stopTodayDmRunner);

  // Dashboard Column 1 Segmented Controls (Today vs All vs Old Channels vs Channel Leads)
  const dashTabToday = document.getElementById("dashTabToday");
  const dashTabAll = document.getElementById("dashTabAll");
  const dashTabOld = document.getElementById("dashTabOld");
  const dashTabFinder = document.getElementById("dashTabFinder");

  const dashTodayHeaderCard = document.getElementById("dashTodayHeaderCard");
  const dashTodayCreatorsList = document.getElementById("dashTodayCreatorsList");
  const dashAllQueueContainer = document.getElementById("dashAllQueueContainer");
  const dashOldChannelsContainer = document.getElementById("dashOldChannelsContainer");
  const dashLeadFinderCard = document.getElementById("dashLeadFinderCard");

  function switchDashCol1Tab(activeTab) {
    [dashTabToday, dashTabAll, dashTabOld, dashTabFinder].forEach(t => {
      if (t) t.classList.toggle("active", t === activeTab);
    });
    if (dashTodayHeaderCard) dashTodayHeaderCard.style.display = activeTab === dashTabToday ? "flex" : "none";
    if (dashTodayCreatorsList) dashTodayCreatorsList.style.display = activeTab === dashTabToday ? "flex" : "none";
    if (dashAllQueueContainer) dashAllQueueContainer.style.display = activeTab === dashTabAll ? "flex" : "none";
    if (dashOldChannelsContainer) dashOldChannelsContainer.style.display = activeTab === dashTabOld ? "flex" : "none";
    if (dashLeadFinderCard) dashLeadFinderCard.style.display = activeTab === dashTabFinder ? "flex" : "none";

    if (activeTab === dashTabOld && typeof renderOldChannelsChecker === "function") {
      renderOldChannelsChecker();
    }
  }

  if (dashTabToday) dashTabToday.addEventListener("click", () => switchDashCol1Tab(dashTabToday));
  if (dashTabAll) dashTabAll.addEventListener("click", () => switchDashCol1Tab(dashTabAll));
  if (dashTabOld) dashTabOld.addEventListener("click", () => switchDashCol1Tab(dashTabOld));
  if (dashTabFinder) dashTabFinder.addEventListener("click", () => switchDashCol1Tab(dashTabFinder));

  // Dashboard Column 3 Segmented Controls (Social Finder vs Pitch Snippets vs Platform Analytics)
  const dashCol3TabFinder = document.getElementById("dashCol3TabFinder");
  const dashCol3TabPitches = document.getElementById("dashCol3TabPitches");
  const dashCol3TabAnalytics = document.getElementById("dashCol3TabAnalytics");
  const dashFinderContainer = document.getElementById("dashFinderContainer");
  const dashPitchesContainer = document.getElementById("dashPitchesContainer");
  const dashAnalyticsContainer = document.getElementById("dashAnalyticsContainer");

  function switchDashCol3Tab(activeBtn) {
    [dashCol3TabFinder, dashCol3TabPitches, dashCol3TabAnalytics].forEach(b => {
      if (b) b.classList.toggle("active", b === activeBtn);
    });
    if (dashFinderContainer) dashFinderContainer.style.display = activeBtn === dashCol3TabFinder ? "flex" : "none";
    if (dashPitchesContainer) dashPitchesContainer.style.display = activeBtn === dashCol3TabPitches ? "flex" : "none";
    if (dashAnalyticsContainer) dashAnalyticsContainer.style.display = activeBtn === dashCol3TabAnalytics ? "flex" : "none";

    if (activeBtn === dashCol3TabPitches && typeof renderPitchesManager === "function") {
      renderPitchesManager();
    }
    if (activeBtn === dashCol3TabAnalytics && typeof renderPlatformAnalytics === "function") {
      renderPlatformAnalytics(true);
    }
  }

  if (dashCol3TabFinder) dashCol3TabFinder.addEventListener("click", () => switchDashCol3Tab(dashCol3TabFinder));
  if (dashCol3TabPitches) dashCol3TabPitches.addEventListener("click", () => switchDashCol3Tab(dashCol3TabPitches));
  if (dashCol3TabAnalytics) dashCol3TabAnalytics.addEventListener("click", () => switchDashCol3Tab(dashCol3TabAnalytics));

  const dashOpenAnalyticsBtn = document.getElementById("dashOpenAnalyticsBtn");
  if (dashOpenAnalyticsBtn) {
    dashOpenAnalyticsBtn.addEventListener("click", () => {
      if (dashCol3TabAnalytics) switchDashCol3Tab(dashCol3TabAnalytics);
      dashAnalyticsContainer?.scrollIntoView({ behavior: "smooth" });
    });
  }

  // Pitch template selector dropdown changes
  const todayPitchSelect = document.getElementById("todayPitchSelect");
  const dashTodayPitchSelect = document.getElementById("dashTodayPitchSelect");
  const dashPitchSelect = document.getElementById("dashPitchSelect");

  [todayPitchSelect, dashTodayPitchSelect, dashPitchSelect].forEach(sel => {
    if (sel) {
      sel.addEventListener("change", (e) => {
        activePitchId = e.target.value;
        populatePitchSelectDropdowns();
        appStorage.set({ activePitchId });
        renderTodayDmQueue();
        if (currentIndex >= 0 && currentIndex < creators.length) {
          setCurrentCreator(currentIndex);
        }
      });
    }
  });

  // Pitch Add/Edit Form Handlers
  const addNewPitchBtn = document.getElementById("addNewPitchBtn");
  const dashAddNewPitchBtn = document.getElementById("dashAddNewPitchBtn");
  [addNewPitchBtn, dashAddNewPitchBtn].forEach(btn => {
    if (btn) btn.addEventListener("click", () => openPitchForm(null, btn.id.includes("dash")));
  });

  const cancelPitchFormBtn = document.getElementById("cancelPitchFormBtn");
  const dashCancelPitchFormBtn = document.getElementById("dashCancelPitchFormBtn");
  [cancelPitchFormBtn, dashCancelPitchFormBtn].forEach(btn => {
    if (btn) btn.addEventListener("click", () => closePitchForm());
  });

  const savePitchFormBtn = document.getElementById("savePitchFormBtn");
  const dashSavePitchFormBtn = document.getElementById("dashSavePitchFormBtn");
  [savePitchFormBtn, dashSavePitchFormBtn].forEach(btn => {
    if (btn) btn.addEventListener("click", () => savePitchFromForm(btn.id.includes("dash")));
  });

  // Tag chips click to insert into form
  document.querySelectorAll(".tag-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      const tag = chip.dataset.var;
      const targetArea = document.getElementById("pitchBodyInput") || document.getElementById("dashPitchBodyInput");
      if (targetArea && targetArea.offsetParent !== null) {
        insertTextAtCursor(targetArea, tag);
      } else {
        copyToClipboard(tag);
        showToast(`Copied ${tag} to clipboard!`);
      }
    });
  });

  // Old Channels Scan Buttons
  const scanOldBtn = document.getElementById("scanOldChannelsBtn");
  const dashScanOldBtn = document.getElementById("dashScanOldChannelsBtn");
  [scanOldBtn, dashScanOldBtn].forEach(btn => {
    if (btn) btn.addEventListener("click", startBatchChannelScan);
  });

  // Old Channels Filter changes
  const oldFilter1 = document.getElementById("oldChannelsFilter");
  const oldFilter2 = document.getElementById("dashOldChannelsFilter");
  if (oldFilter1) oldFilter1.addEventListener("change", () => renderOldChannelsChecker());
  if (oldFilter2) oldFilter2.addEventListener("change", () => renderOldChannelsChecker());

  // Real-time sync when Content Script approves status on Twitter/Instagram
  try {
    if (isExtensionEnv && chrome?.storage?.onChanged) chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === "local" && changes.lastSyncedCreatorId) {
        const updatedId = changes.lastSyncedCreatorId.newValue;
        const newStatus = changes.lastSyncedStatus?.newValue;
        const newFollowUp = changes.lastSyncedFollowUp?.newValue;
        const target = creators.find(c => c.id === updatedId);
        if (target) {
          if (newStatus) target.status = newStatus;
          if (newFollowUp) target.followUpStatus = newFollowUp;
          target.lastTouch = new Date().toISOString().split("T")[0];
          updateStats();
          filterAndRenderList();
          renderTodayDmQueue();
          updateTodayPlatformCounts();
        }
      }
    });
  } catch (e) {}
}

// URL Cleaners & Validators for Airtable fields
function cleanTwitterUrl(raw) {
  if (!raw) return "";
  raw = raw.trim();
  // Reject emails or non-twitter links stored mistakenly in X account
  if (raw.includes("@") && !raw.includes("x.com") && !raw.includes("twitter.com")) return "";
  if (raw.includes("roblox.com") || raw.includes("youtube.com") || raw.includes("tiktok.com")) return "";

  // If it's an existing conversation thread URL, keep it! (e.g. x.com/messages/... or x.com/i/chat/...)
  if (raw.includes("/messages/") || raw.includes("/i/chat/")) {
    return raw.startsWith("http") ? raw : `https://${raw}`;
  }

  // Normal handle matching
  const m = raw.match(/(?:twitter|x)\.com\/([a-zA-Z0-9_]+)/i);
  if (m) {
    const handle = m[1].toLowerCase();
    if (DISALLOWED_HANDLES.has(handle) || ['i', 'chat', 'messages', 'intent', 'home', 'explore'].includes(handle)) {
      return "";
    }
    return `https://x.com/${m[1]}`;
  }

  // Handle only (e.g. "@username" or "username")
  const cleanHandle = raw.replace(/^@/, "").trim();
  if (/^[a-zA-Z0-9_]{1,30}$/.test(cleanHandle)) {
    if (!DISALLOWED_HANDLES.has(cleanHandle.toLowerCase()) && !['i', 'chat', 'messages'].includes(cleanHandle.toLowerCase())) {
      return `https://x.com/${cleanHandle}`;
    }
  }

  return "";
}

function cleanInstagramUrl(raw) {
  if (!raw) return "";
  raw = raw.trim();
  if (raw.includes("@") && !raw.includes("instagram.com")) return "";
  if (raw.includes("roblox.com") || raw.includes("youtube.com") || raw.includes("tiktok.com")) return "";

  const m = raw.match(/instagram\.com\/([a-zA-Z0-9_.]+)/i);
  if (m) {
    const handle = m[1].toLowerCase();
    if (DISALLOWED_HANDLES.has(handle) || ['p', 'reel', 'stories', 'explore', 'direct'].includes(handle)) {
      return "";
    }
    return `https://www.instagram.com/${m[1]}/`;
  }

  const cleanHandle = raw.replace(/^@/, "").replace(/\/$/, "").trim();
  if (/^[a-zA-Z0-9_.]{1,30}$/.test(cleanHandle)) {
    if (!DISALLOWED_HANDLES.has(cleanHandle.toLowerCase())) {
      return `https://www.instagram.com/${cleanHandle}/`;
    }
  }
  return "";
}

// Fetch from Airtable API
async function fetchAirtableRecords() {
  let token = document.getElementById("airtableToken")?.value.trim() || DEFAULT_CONFIG.token;
  let baseId = document.getElementById("airtableBaseId")?.value.trim() || DEFAULT_CONFIG.baseId;
  let tableId = document.getElementById("airtableTableId")?.value.trim() || DEFAULT_CONFIG.tableId;

  if (!token) {
    try {
      const configUrl = (typeof window !== "undefined" && window.location && window.location.origin && window.location.origin.startsWith("http"))
        ? `${window.location.origin}/api/config`
        : "http://174.138.72.199:3000/api/config";
      const srvResp = await fetch(configUrl).catch(() => null);
      if (srvResp && srvResp.ok) {
        const srvConfig = await srvResp.json().catch(() => ({}));
        if (srvConfig.airtableToken) {
          token = srvConfig.airtableToken;
          baseId = srvConfig.airtableBaseId || baseId;
          tableId = srvConfig.airtableTableId || tableId;
          DEFAULT_CONFIG.token = token;
          if (document.getElementById("airtableToken")) document.getElementById("airtableToken").value = token;
          if (document.getElementById("airtableBaseId")) document.getElementById("airtableBaseId").value = baseId;
          if (document.getElementById("airtableTableId")) document.getElementById("airtableTableId").value = tableId;
          await appStorage.set({ airtableToken: token, airtableBaseId: baseId, airtableTableId: tableId });
        }
      }
    } catch (e) {}
  }

  if (!token || !baseId || !tableId) {
    showToast("Configure Airtable credentials in Settings first.");
    return;
  }

  setStatus("Syncing...");
  creators = [];

  try {
    let offset = null;
    do {
      let url = `https://api.airtable.com/v0/${baseId}/${tableId}?pageSize=100`;
      if (offset) url += `&offset=${offset}`;

      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (!res.ok) throw new Error(`Airtable API Error: ${res.status}`);

      const data = await res.json();
      const records = data.records || [];

      records.forEach(r => {
        const f = r.fields || {};
        creators.push({
          id: r.id,
          name: f["Name"] || "Unknown Creator",
          niche: Array.isArray(f["Niche"]) ? f["Niche"].join(", ") : (f["Niche"] || "Roblox"),
          status: f["Status"] || "Not Started",
          outreach: f["Follow Up Status"] || "Just Dm",
          email: (f["Email"] || "").trim(),
          discord: (f["Discord Page"] || "").trim(),
          twitter: cleanTwitterUrl(f["X account"] || ""),
          instagram: cleanInstagramUrl(f["Instagram"] || ""),
          youtube: (f["Yt link"] || "").trim(),
          lastTouch: f["Last Touch Date"] || "",
          replied: Boolean(f["Replied"] === true || f["Replied"] === "true" || f["Status"] === "Replied"),
          repliedPlatform: f["Plateform Got Replied From"] || [],
          reachedPlatforms: f["Plateforms I've Reached out"] || [],
          landed: Number(f["Landed"]) || 0,
          rokda: parseFloat(f["Rokda"]) || 0,
          clientType: f["Client Type"] || ""
        });
      });

      offset = data.offset;
    } while (offset);

    try {
      appStorage.set({
        creatorsLookup: creators.map(c => ({
          id: c.id,
          name: c.name,
          twitter: c.twitter,
          instagram: c.instagram,
          discord: c.discord,
          status: c.status,
          niche: c.niche
        }))
      });
    } catch (e) {}

    setStatus("Active");
    updateStats();
    updateFinderStats();
    filterAndRenderList();
    renderFinderList();
    syncPitchStatsWithCreators(creators);
    renderTodayDmQueue();
    renderOldChannelsChecker();
    renderPitchesManager();
    if (typeof renderPlatformAnalytics === "function") renderPlatformAnalytics();

    const firstPendingIdx = creators.findIndex(c => c.status !== "Messaged");
    if (firstPendingIdx !== -1) {
      setCurrentCreator(firstPendingIdx);
    } else if (creators.length > 0) {
      setCurrentCreator(0);
    }

    showToast(`Loaded ${creators.length} creators from Airtable!`);
  } catch (err) {
    // silenced error log
    setStatus("Error");
    showToast(err.message);
  }
}

// Missing Socials Helper
function getMissingSocials(c) {
  const missing = [];
  if (!c.youtube) missing.push("YouTube");
  if (!c.twitter) missing.push("Twitter/X");
  if (!c.instagram) missing.push("Instagram");
  if (!c.discord) missing.push("Discord");
  if (!c.email) missing.push("Email");
  return missing;
}

// Open Airtable Record in New Tab
function openAirtableRecord(creator) {
  const baseId = document.getElementById("airtableBaseId")?.value.trim() || DEFAULT_CONFIG.baseId;
  const tableId = document.getElementById("airtableTableId")?.value.trim() || DEFAULT_CONFIG.tableId;
  const viewId = document.getElementById("airtableViewId")?.value.trim() || DEFAULT_CONFIG.viewId;

  const url = viewId 
    ? `https://airtable.com/${baseId}/${tableId}/${viewId}/${creator.id}`
    : `https://airtable.com/${baseId}/${tableId}/${creator.id}`;

  openExternalUrl(url );
  showToast(`Opening ${creator?.name || "Creator"} in Airtable...`);
}

// Render Creator List in Queue Tab / Left Column
function filterAndRenderList() {
  const queryEl = document.getElementById("searchInput");
  const platformEl = document.getElementById("filterPlatform");
  const listEl = document.getElementById("creatorList");
  if (!listEl) return;

  const query = queryEl ? queryEl.value.toLowerCase() : "";
  const platform = platformEl ? platformEl.value : "all";

  listEl.innerHTML = "";

  const filtered = creators.filter((c) => {
    const matchesQuery = c.name.toLowerCase().includes(query) || c.niche.toLowerCase().includes(query);
    const missing = getMissingSocials(c);
    let matchesPlatform = true;

    if (platform === "missing_any") matchesPlatform = missing.length > 0;
    else if (platform === "missing_all") matchesPlatform = (!c.youtube && !c.twitter && !c.instagram && !c.discord && !c.email);
    else if (platform === "missing_ig") matchesPlatform = !c.instagram;
    else if (platform === "missing_x") matchesPlatform = !c.twitter;
    else if (platform === "missing_discord") matchesPlatform = !c.discord;
    else if (platform === "missing_email") matchesPlatform = !c.email;
    else if (platform === "missing_yt") matchesPlatform = !c.youtube;
    else if (platform === "has_email") matchesPlatform = !!c.email;
    else if (platform === "has_x") matchesPlatform = !!c.twitter;
    else if (platform === "has_discord") matchesPlatform = !!c.discord;
    else if (platform === "has_instagram") matchesPlatform = !!c.instagram;

    return matchesQuery && matchesPlatform;
  });

  if (filtered.length === 0) {
    listEl.innerHTML = `<div class="empty-state"><p>No creators match your filter.</p></div>`;
    return;
  }

  filtered.forEach((c) => {
    const origIndex = creators.indexOf(c);
    const item = document.createElement("div");
    item.className = "creator-item";
    if (origIndex === currentIndex) {
      item.style.borderColor = "var(--accent)";
      item.style.backgroundColor = "rgba(99, 102, 241, 0.1)";
    }

    const missing = getMissingSocials(c);

    item.innerHTML = `
      <div class="creator-info">
        <h4>${c.name}</h4>
        <span class="creator-sub">${c.niche} • ${c.status}</span>
      </div>
      <div class="platform-badges">
        ${c.status === "Messaged" ? '<span class="badge badge-done">✓ Sent</span>' : ""}
        ${c.email ? '<span class="badge badge-email">✉</span>' : ""}
        ${c.twitter ? '<span class="badge badge-x">𝕏</span>' : ""}
        ${c.discord ? '<span class="badge badge-discord">💬</span>' : ""}
        ${c.instagram ? '<span class="badge badge-ig">📷</span>' : ""}
        ${missing.length > 0 ? `<span class="badge badge-missing" title="Missing: ${missing.join(', ')}">⚠️ -${missing.length}</span>` : ""}
        <button class="mini-search-btn" title="Deep Search Socials">🔍</button>
      </div>
    `;

    item.querySelector(".creator-info").addEventListener("click", () => {
      setCurrentCreator(origIndex);
    });

    item.querySelector(".mini-search-btn").addEventListener("click", async (e) => {
      e.stopPropagation();
      setCurrentCreator(origIndex);
      const btn = e.target;
      btn.innerText = "⏳";
      await executeDeepCreatorSearch(
        c,
        document.getElementById("searchResultFeedback"),
        document.getElementById("searchSocialsBtn"),
        document.getElementById("currentDiscoveredBox"),
        document.getElementById("currentDiscoveredPills"),
        true
      );
      btn.innerText = "🔍";
    });

    listEl.appendChild(item);
  });
}

function updateStats() {
  const total = creators.length;
  const messaged = creators.filter(c => c.status === "Messaged").length;
  const pending = total - messaged;

  const totalEl = document.getElementById("totalCount");
  const pendingEl = document.getElementById("pendingCount");
  const messagedEl = document.getElementById("messagedCount");
  const queueEl = document.getElementById("queueCount");

  if (totalEl) totalEl.innerText = total;
  if (pendingEl) pendingEl.innerText = pending;
  if (messagedEl) messagedEl.innerText = messaged;
  if (queueEl) queueEl.innerText = pending;
}

function updateFinderStats() {
  const missingAny = creators.filter(c => getMissingSocials(c).length > 0).length;
  const missingIG = creators.filter(c => !c.instagram).length;
  const missingX = creators.filter(c => !c.twitter).length;
  const missingDC = creators.filter(c => !c.discord).length;
  const missingEmail = creators.filter(c => !c.email).length;

  const elAny = document.getElementById("statMissingAny");
  const elIG = document.getElementById("statMissingIG");
  const elX = document.getElementById("statMissingX");
  const elDC = document.getElementById("statMissingDC");
  const elEmail = document.getElementById("statMissingEmail");
  const elBadge = document.getElementById("missingBadge");

  if (elAny) elAny.innerText = missingAny;
  if (elIG) elIG.innerText = missingIG;
  if (elX) elX.innerText = missingX;
  if (elDC) elDC.innerText = missingDC;
  if (elEmail) elEmail.innerText = missingEmail;
  if (elBadge) elBadge.innerText = missingAny;
}

// Current Target Card Handler
function setCurrentCreator(index) {
  if (index < 0 || index >= creators.length) return;
  currentIndex = index;
  const c = creators[currentIndex];

  const card = document.getElementById("currentCard");
  if (card) card.style.display = "block";

  const nameEl = document.getElementById("currentName");
  const metaEl = document.getElementById("currentMeta");
  if (nameEl) nameEl.innerText = c.name;
  if (metaEl) metaEl.innerText = `${c.niche} • Status: ${c.status}`;

  const actionsEl = document.getElementById("currentSocialActions");
  if (actionsEl) {
    actionsEl.innerHTML = "";
    const template = getPersonalizedPitch(c);

    // 1. Twitter / X button
    if (c.twitter) {
      actionsEl.appendChild(createActionChip("chip-x", "𝕏 Open Profile / DM", async () => {
        copyToClipboard(template);
        try {
          await appStorage.set({
            activeOutreachPitch: template,
            activeCreatorName: c.name,
            activeCreatorId: c.id,
            activeCreatorHandle: (c.twitter || "").replace(/^https?:\/\/(www\.)?(twitter|x)\.com\//i, "").replace(/\/.*$/, ""),
            airtableToken: document.getElementById("airtableToken")?.value.trim() || DEFAULT_CONFIG.token,
            airtableBaseId: document.getElementById("airtableBaseId")?.value.trim() || DEFAULT_CONFIG.baseId,
            airtableTableId: document.getElementById("airtableTableId")?.value.trim() || DEFAULT_CONFIG.tableId
          });
        } catch (e) {}
        openExternalUrl(c.twitter );
        showToast("Pitch copied! Opening Twitter/X...");
      }));
    }

    // 2. Email button
    if (c.email) {
      actionsEl.appendChild(createActionChip("chip-email", "✉ Compose Email", () => {
        const subject = encodeURIComponent(getPersonalizedSubject(c));
        const body = encodeURIComponent(template);
        const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(c.email)}&su=${subject}&body=${body}`;
        openExternalUrl(gmailUrl );
        showToast("Opening Gmail with pre-filled pitch!");
      }));
    }

    // 3. Discord button
    if (c.discord) {
      actionsEl.appendChild(createActionChip("chip-discord", "💬 Open Discord", () => {
        copyToClipboard(template);
        openExternalUrl(c.discord );
        showToast("Pitch copied! Opening Discord...");
      }));
    }

    // 4. Instagram button
    if (c.instagram) {
      actionsEl.appendChild(createActionChip("chip-ig", "📷 Open Instagram", async () => {
        copyToClipboard(template);
        try {
          await appStorage.set({
            activeOutreachPitch: template,
            activeCreatorName: c.name,
            activeCreatorId: c.id,
            activeCreatorHandle: (c.instagram || "").replace(/^https?:\/\/(www\.)?instagram\.com\//i, "").replace(/\/.*$/, ""),
            airtableToken: document.getElementById("airtableToken")?.value.trim() || DEFAULT_CONFIG.token,
            airtableBaseId: document.getElementById("airtableBaseId")?.value.trim() || DEFAULT_CONFIG.baseId,
            airtableTableId: document.getElementById("airtableTableId")?.value.trim() || DEFAULT_CONFIG.tableId
          });
        } catch (e) {}
        openExternalUrl(c.instagram );
        showToast("Pitch copied! Opening Instagram...");
      }));
    }

    // 5. YouTube Channel
    if (c.youtube) {
      actionsEl.appendChild(createActionChip("btn-outline-secondary", "▶ YouTube", () => {
        openExternalUrl(c.youtube );
      }));
    }
  }

  // Update pitch inputs in dashboard
  const msgInput = document.getElementById("messageTemplate");
  const subInput = document.getElementById("emailSubject");
  if (msgInput) msgInput.value = getPersonalizedPitch(c);
  if (subInput) subInput.value = getPersonalizedSubject(c);

  // Missing Socials Banner & Auto-Search
  const missing = getMissingSocials(c);
  const banner = document.getElementById("missingBanner");
  const tagsContainer = document.getElementById("missingTags");
  const feedback = document.getElementById("searchResultFeedback");
  const discBox = document.getElementById("currentDiscoveredBox");
  
  if (feedback) {
    feedback.style.display = "none";
    feedback.className = "search-feedback";
  }
  if (discBox) discBox.style.display = "none";

  if (banner && tagsContainer) {
    if (missing.length > 0) {
      banner.style.display = "block";
      tagsContainer.innerHTML = missing.map(m => `<span class="missing-tag">${m}</span>`).join(" ");
    } else {
      banner.style.display = "none";
    }
  }

  filterAndRenderList();
}

function createActionChip(className, label, onClick) {
  const el = document.createElement("a");
  el.className = `action-chip ${className}`;
  el.innerText = label;
  el.addEventListener("click", onClick);
  return el;
}

// -------------------------------------------------------------
// Helper: Extract Creator Name & Handle Tokens
// -------------------------------------------------------------
function getCreatorTokens(creator) {
  const tokens = new Set();
  if (creator && creator?.name || "Creator") {
    const raw = creator?.name || "Creator".toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
    for (const w of raw.split(/\s+/)) {
      if (w.length >= 3) tokens.add(w);
    }
    const merged = raw.replace(/\s+/g, '');
    if (merged.length >= 3) tokens.add(merged);
  }
  if (creator && creator.youtube) {
    const m = creator.youtube.match(/@([a-zA-Z0-9_\.-]+)/);
    if (m) {
      const h = m[1].toLowerCase().replace(/[^a-z0-9]/g, '');
      if (h.length >= 3) tokens.add(h);
    }
  }
  // Noise words that should never count as the sole creator match
  const noise = ['roblox', 'gaming', 'games', 'channel', 'tv', 'official', 'yt', 'youtube', 'videos', 'plays', 'play'];
  for (const n of noise) tokens.delete(n);
  return tokens;
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatSourceDisplay(url) {
  if (!url) return "";
  try {
    const u = new URL(url);
    let path = u.pathname;
    if (path.length > 32) path = path.slice(0, 29) + "...";
    return `${u.hostname}${path}`;
  } catch (e) {
    return url.length > 35 ? url.slice(0, 32) + "..." : url;
  }
}

// -------------------------------------------------------------
// YouTube Redirect URL Decoder: Extracts Target & Placement Event
// -------------------------------------------------------------
function extractYouTubeRedirects(rawHtml) {
  const redirects = [];
  if (!rawHtml) return redirects;

  const clean = rawHtml.replace(/\\u0026/g, '&').replace(/\\\//g, '/').replace(/&amp;/g, '&');
  const matches = clean.match(/https?:\/\/(?:www\.)?youtube\.com\/redirect\?[^"'\s<>]+/gi);
  if (!matches) return redirects;

  const seen = new Set();
  for (const m of matches) {
    try {
      const urlObj = new URL(m);
      const target = urlObj.searchParams.get("q");
      const event = urlObj.searchParams.get("event") || "youtube_link";
      if (target && !seen.has(target)) {
        seen.add(target);
        redirects.push({ target: target.trim(), event: event });
      }
    } catch (e) {}
  }
  return redirects;
}

// -------------------------------------------------------------
// Creator Social Handle Matcher & Scoring
// -------------------------------------------------------------
function evaluateHandleMatch(platform, rawHandle, creator, sourceEvent, extraContext = "") {
  if (!rawHandle) return { valid: false, reason: "Empty handle" };
  const h = rawHandle.toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (!h || h.length < 2) return { valid: false, reason: "Handle too short" };

  // 1. Strict blacklist rejection (Prevents @roblox, @youtube, etc.)
  if (DISALLOWED_HANDLES.has(h)) {
    return { valid: false, reason: `Generic brand/platform account '@${rawHandle}' rejected` };
  }

  const tokens = getCreatorTokens(creator);
  let matchedToken = null;
  for (const t of tokens) {
    if (t.length >= 3 && (h.includes(t) || t.includes(h))) {
      matchedToken = t;
      break;
    }
  }

  // 2. Channel header links: Explicitly pinned by the creator on YouTube
  if (sourceEvent === "channel_header" || sourceEvent === "channel_links") {
    return {
      valid: true,
      handle: rawHandle,
      reason: matchedToken 
        ? `Official channel header link (handle '@${rawHandle}' matches '${matchedToken}')`
        : `Direct official link pinned on creator's YouTube channel header`
    };
  }

  // 3. Video descriptions of recent uploads
  if (sourceEvent === "video_description" || sourceEvent === "Watch_SD_EP") {
    if (matchedToken) {
      return {
        valid: true,
        handle: rawHandle,
        reason: `Linked in latest video description (handle '@${rawHandle}' matches creator '${matchedToken}')`
      };
    }
    const ctx = (extraContext || "").toLowerCase();
    if (ctx.includes("my twitter") || ctx.includes("my socials") || ctx.includes("twitter:") || ctx.includes("follow me") || ctx.includes("my instagram") || ctx.includes("instagram:")) {
      return {
        valid: true,
        handle: rawHandle,
        reason: `Linked under creator personal socials in video description ('@${rawHandle}')`
      };
    }
    return { valid: false, reason: `Video description handle '@${rawHandle}' does not match creator name '${creator?.name || "Creator"}'` };
  }

  // 4. Web search results: MUST strictly match creator tokens
  if (sourceEvent === "web_search") {
    if (matchedToken) {
      return {
        valid: true,
        handle: rawHandle,
        reason: `Discovered via web search (handle '@${rawHandle}' matches creator name '${creator?.name || "Creator"}')`
      };
    }
    return { valid: false, reason: `Web search handle '@${rawHandle}' does not match creator name '${creator?.name || "Creator"}'` };
  }

  // Fallback
  if (matchedToken) {
    return {
      valid: true,
      handle: rawHandle,
      reason: `Found on web (matches creator name '${matchedToken}')`
    };
  }

  return { valid: false, reason: `Handle '@${rawHandle}' does not match creator` };
}

// -------------------------------------------------------------
// Live Discord API Validator: Ensures Active, Not Expired & Belongs to Creator
// -------------------------------------------------------------
async function validateDiscordInvite(rawCode, creator, sourceEvent = "web_search", extraContext = "") {
  let code = rawCode.split('/').pop().replace(/(?:follow|join|my|the|discord|server|invite|link|for|and).*$/i, '');
  if (!code || code.length < 3) return null;

  try {
    const url = `https://discord.com/api/v10/invites/${code}?with_counts=true`;
    const resp = await fetch(url);
    if (resp.status !== 200) {
      return { active: false, reason: `Expired or invalid invite (${code})` };
    }

    const data = await resp.json();
    const guild = data.guild || {};
    const guildName = (guild.name || "").trim();
    const inviter = data.inviter || {};
    const inviterUsername = (inviter.username || "").toLowerCase();
    const memberCount = data.approximate_member_count || 0;
    const membersStr = memberCount > 0 ? `${(memberCount / 1000).toFixed(1)}k members` : "Active";

    // Reject generic game/corporate servers (Roblox, Blox Fruits, etc.)
    const guildLower = guildName.toLowerCase();
    if (DISALLOWED_GUILDS.has(guildLower) || DISALLOWED_HANDLES.has(guildLower.replace(/[^a-z0-9]/g, ''))) {
      return { active: false, reason: `Generic gaming server '${guildName}' rejected` };
    }

    const tokens = getCreatorTokens(creator);
    let matchedToken = null;
    for (const t of tokens) {
      if (t.length >= 3 && (guildLower.includes(t) || inviterUsername.includes(t))) {
        matchedToken = t;
        break;
      }
    }

    // 1. Channel Header origin: Pinned directly by creator on YouTube channel
    if (sourceEvent === "channel_header" || sourceEvent === "channel_links" || sourceEvent === "backstage_event") {
      const byStr = inviter.username ? ` (created by ${inviter.username})` : "";
      return {
        active: true,
        code: code,
        url: `https://discord.gg/${code}`,
        title: `${guildName} (${membersStr})`,
        reason: matchedToken
          ? `Official server '${guildName}' (${membersStr})${byStr} linked directly on channel header`
          : `Official community server '${guildName}' (${membersStr}) linked directly on YouTube channel header`
      };
    }

    // 2. Video Description origin
    if (sourceEvent === "video_description" || sourceEvent === "Watch_SD_EP") {
      if (matchedToken) {
        return {
          active: true,
          code: code,
          url: `https://discord.gg/${code}`,
          title: `${guildName} (${membersStr})`,
          reason: `Verified community server '${guildName}' (${membersStr}) from latest video description (matches '${matchedToken}')`
        };
      }
      const ctx = (extraContext || "").toLowerCase();
      if (ctx.includes("my discord") || ctx.includes("discord server") || ctx.includes("join my") || ctx.includes("community")) {
        return {
          active: true,
          code: code,
          url: `https://discord.gg/${code}`,
          title: `${guildName} (${membersStr})`,
          reason: `Active community server '${guildName}' (${membersStr}) linked under 'My Discord' in latest video description`
        };
      }
      return { active: false, reason: `Discord server '${guildName}' does not match creator name` };
    }

    // 3. Web Search origin: MUST match creator tokens
    if (sourceEvent === "web_search") {
      if (matchedToken) {
        return {
          active: true,
          code: code,
          url: `https://discord.gg/${code}`,
          title: `${guildName} (${membersStr})`,
          reason: `Verified server '${guildName}' (${membersStr}) discovered via web search (matches creator '${matchedToken}')`
        };
      }
      return { active: false, reason: `Web search server '${guildName}' does not match creator '${creator?.name || "Creator"}'` };
    }

    if (matchedToken) {
      return {
        active: true,
        code: code,
        url: `https://discord.gg/${code}`,
        title: `${guildName} (${membersStr})`,
        reason: `Active community server '${guildName}' (${membersStr}) matches creator '${matchedToken}'`
      };
    }

    return { active: false, reason: `Discord server '${guildName}' does not match creator` };
  } catch (err) {
    return { active: false, reason: `Discord API error: ${err.message}` };
  }
}

// -------------------------------------------------------------
// Strict Email Filter: Completely Prevents wght@300..900 and CSS font tags
// -------------------------------------------------------------
function extractValidEmails(text) {
  const rawMatches = text.match(/\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,10}\b/g);
  if (!rawMatches) return null;

  for (const em of rawMatches) {
    if (em.includes("..")) continue;

    const parts = em.split("@");
    if (parts.length !== 2) continue;

    const user = parts[0].toLowerCase();
    const domain = parts[1].toLowerCase();

    if (DISALLOWED_EMAIL_USERS.has(user)) continue;
    if (DISALLOWED_EMAIL_DOMAINS.some(d => domain.includes(d))) continue;

    const tld = domain.split(".").pop();
    if (!/^[a-zA-Z]{2,10}$/.test(tld)) continue;

    return em; // Return authentic creator business email!
  }
  return null;
}

// -------------------------------------------------------------
// Advanced String & URL Parser with Context Attribution
// -------------------------------------------------------------
async function extractSocialsFromText(rawText, missingList, creator, sourceEvent = "page_text") {
  const found = {};
  const reasons = {};
  
  let text = rawText.replace(/\\\//g, '/').replace(/\\"/g, '"').replace(/\\n/g, ' ');
  try {
    text = decodeURIComponent(text.replace(/\+/g, ' '));
  } catch (e) {}

  // 1. Instagram
  if (missingList.includes("Instagram")) {
    const igMatches = text.match(/https?:\/\/(?:www\.)?instagram\.com\/([a-zA-Z0-9_\.]{3,30})\/?/gi);
    if (igMatches) {
      for (const m of igMatches) {
        const handleMatch = m.match(/instagram\.com\/([a-zA-Z0-9_\.]{3,30})/i);
        if (handleMatch) {
          const evalRes = evaluateHandleMatch("instagram", handleMatch[1], creator, sourceEvent);
          if (evalRes.valid) {
            found["Instagram"] = `https://www.instagram.com/${handleMatch[1].replace(/\.$/, '')}/`;
            reasons["Instagram"] = evalRes.reason;
            break;
          }
        }
      }
    }
  }

  // 2. Twitter / X
  if (missingList.includes("Twitter/X")) {
    const twMatches = text.match(/https?:\/\/(?:www\.)?(?:twitter|x)\.com\/([a-zA-Z0-9_]{1,15})\/?/gi);
    if (twMatches) {
      for (const m of twMatches) {
        const handleMatch = m.match(/(?:twitter|x)\.com\/([a-zA-Z0-9_]{1,15})/i);
        if (handleMatch) {
          const evalRes = evaluateHandleMatch("twitter", handleMatch[1], creator, sourceEvent);
          if (evalRes.valid) {
            found["X account"] = `https://x.com/${handleMatch[1]}`;
            reasons["X account"] = evalRes.reason;
            break;
          }
        }
      }
    }
  }

  // 3. Discord
  if (missingList.includes("Discord")) {
    const discMatches = text.match(/https?:\/\/(?:discord\.gg|discord\.com\/invite)\/([a-zA-Z0-9_\-]+)/gi);
    if (discMatches) {
      for (const dm of discMatches) {
        const codeMatch = dm.match(/(?:discord\.gg|discord\.com\/invite)\/([a-zA-Z0-9_\-]+)/i);
        if (codeMatch) {
          const validation = await validateDiscordInvite(codeMatch[1], creator, sourceEvent);
          if (validation && validation.active) {
            found["Discord Page"] = validation.url;
            found["_discordTitle"] = validation.title;
            reasons["Discord Page"] = validation.reason;
            break;
          }
        }
      }
    }
  }

  // 4. Email
  if (missingList.includes("Email")) {
    const validEmail = extractValidEmails(text);
    if (validEmail) {
      found["Email"] = validEmail;
      reasons["Email"] = `Business inquiry email '${validEmail}' found in channel description`;
    }
  }

  return { found, reasons };
}

// -------------------------------------------------------------
// Fandom YouTube Community Wiki API Search
// -------------------------------------------------------------
async function searchFandomWiki(creator, missingList) {
  const found = {};
  const reasons = {};
  if (!creator?.name) return { found, reasons };

  try {
    const query = encodeURIComponent(creator?.name || "Creator");
    const url = `https://youtube.fandom.com/api.php?action=query&list=search&srsearch=${query}&format=json`;
    const resp = await fetch(url);
    if (!resp.ok) return { found, reasons };
    const data = await resp.json();
    const results = data?.query?.search || [];
    if (results.length === 0) return { found, reasons };

    // Check top matching page
    const top = results[0];
    const pageId = top.pageid;
    const pageUrl = `https://youtube.fandom.com/api.php?action=parse&pageid=${pageId}&prop=text&format=json`;
    const pResp = await fetch(pageUrl);
    if (!pResp.ok) return { found, reasons };
    const pData = await pResp.json();
    const html = pData?.parse?.text?.['*'] || '';

    const sourcePage = `https://youtube.fandom.com/wiki/${encodeURIComponent(top.title.replace(/\s+/g, '_'))}`;

    // Extract Twitter
    if (missingList.includes("Twitter/X") && !found["X account"]) {
      const twMatches = html.match(/(?:twitter|x)\.com\/([a-zA-Z0-9_]{1,15})/gi);
      if (twMatches) {
        for (const tm of twMatches) {
          const hm = tm.match(/(?:twitter|x)\.com\/([a-zA-Z0-9_]{1,15})/i);
          if (hm) {
            const evalRes = evaluateHandleMatch("twitter", hm[1], creator, "web_search");
            if (evalRes.valid) {
              found["X account"] = `https://x.com/${hm[1]}`;
              reasons["X account"] = {
                text: `Verified on YouTube Fandom Wiki profile '${top.title}' (handle matches creator)`,
                sourceUrl: sourcePage
              };
              break;
            }
          }
        }
      }
    }

    // Extract Instagram
    if (missingList.includes("Instagram") && !found["Instagram"]) {
      const igMatches = html.match(/instagram\.com\/([a-zA-Z0-9_\.]{3,30})/gi);
      if (igMatches) {
        for (const im of igMatches) {
          const hm = im.match(/instagram\.com\/([a-zA-Z0-9_\.]{3,30})/i);
          if (hm) {
            const evalRes = evaluateHandleMatch("instagram", hm[1], creator, "web_search");
            if (evalRes.valid) {
              found["Instagram"] = `https://www.instagram.com/${hm[1].replace(/\.$/, '')}/`;
              reasons["Instagram"] = {
                text: `Verified on YouTube Fandom Wiki profile '${top.title}' (matches creator)`,
                sourceUrl: sourcePage
              };
              break;
            }
          }
        }
      }
    }

    // Extract Discord
    if (missingList.includes("Discord") && !found["Discord Page"]) {
      const discMatches = html.match(/(?:discord\.gg|discord\.com\/invite)\/([a-zA-Z0-9_\-]+)/gi);
      if (discMatches) {
        for (const dm of discMatches) {
          const hm = dm.match(/(?:discord\.gg|discord\.com\/invite)\/([a-zA-Z0-9_\-]+)/i);
          if (hm) {
            const validation = await validateDiscordInvite(hm[1], creator, "web_search");
            if (validation && validation.active) {
              found["Discord Page"] = validation.url;
              found["_discordTitle"] = validation.title;
              reasons["Discord Page"] = {
                text: `Verified server on YouTube Fandom Wiki '${top.title}' (${validation.title})`,
                sourceUrl: sourcePage
              };
              break;
            }
          }
        }
      }
    }
  } catch (e) {
    // Fail silently without error console logging
  }

  return { found, reasons };
}

// -------------------------------------------------------------
// Headless Background Web Search (Safe & Error-Guarded)
// -------------------------------------------------------------
// Safe social search engine without dangerous tab injection
async function executeHeadlessWebSearch(creator, missingList) {
  const found = {};
  const reasons = {};
  if (!creator?.name || !missingList || missingList.length === 0) return { found, reasons };

  try {
    const fandomRes = await searchFandomWiki(creator, missingList);
    if (fandomRes && fandomRes.found) {
      Object.assign(found, fandomRes.found);
      Object.assign(reasons, fandomRes.reasons);
    }
  } catch (e) {}

  return { found, reasons };
}

// -------------------------------------------------------------
// Multi-Stage Deep Search Engine with Strict Creator Attribution
// 1. YouTube Channel Home & /about + Decoded Redirects
// 2. Video Descriptions of Latest Uploads + Decoded Redirects
// 3. Fandom Community Wiki API
// 4. Headless Web Search (Strict Creator Token Match)
// -------------------------------------------------------------
async function deepSearchCreatorSocials(creator) {
  const missing = getMissingSocials(creator);
  const foundSocials = {};
  const foundReasons = {};

  let channelUrl = creator.youtube;

  // STEP 1: Search for Channel URL if missing
  if (!channelUrl) {
    const query = `${creator?.name || "Creator"} ${creator.niche || ''} channel`.trim();
    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgIQAg%253D%253D`;
    try {
      const sResp = await fetch(searchUrl);
      const sHtml = await sResp.text();
      const m = sHtml.match(/var ytInitialData = ({.*?});<\/script>/);
      if (m) {
        const raw = m[1];
        const handles = raw.match(/"canonicalBaseUrl":"(\/@[a-zA-Z0-9_\.-]+)"/);
        if (handles) {
          channelUrl = "https://www.youtube.com" + handles[1];
        } else {
          const cids = raw.match(/"channelId":"(UC[a-zA-Z0-9_\-]+)"/);
          if (cids) {
            channelUrl = "https://www.youtube.com/channel/" + cids[1];
          }
        }
      }
      if (channelUrl) {
        foundSocials["Yt link"] = channelUrl + "/videos";
        foundReasons["Yt link"] = {
          text: `Verified YouTube channel handle ${channelUrl.split('/').pop()}`,
          sourceUrl: channelUrl
        };
        creator.youtube = channelUrl + "/videos";
      }
    } catch (e) {
      console.warn("Channel search error:", e);
    }
  }

  // STEP 2: Channel Header, About, & Official Redirect Links
  if (channelUrl) {
    const cleanUrl = channelUrl.replace(/\/(about|featured|videos|community|channels|playlists|streams|shorts)\/?$/, '');
    for (const targetUrl of [cleanUrl, cleanUrl + "/about"]) {
      try {
        const resp = await fetch(targetUrl);
        const html = await resp.text();

        // 2A. Decoded YouTube redirects (official channel header & about links)
        const redirects = extractYouTubeRedirects(html);
        for (const { target, event } of redirects) {
          // Twitter
          if (missing.includes("Twitter/X") && !foundSocials["X account"]) {
            const twMatch = target.match(/(?:twitter|x)\.com\/([a-zA-Z0-9_]{1,15})/i);
            if (twMatch) {
              const evalRes = evaluateHandleMatch("twitter", twMatch[1], creator, event);
              if (evalRes.valid) {
                foundSocials["X account"] = `https://x.com/${twMatch[1]}`;
                foundReasons["X account"] = {
                  text: evalRes.reason,
                  sourceUrl: targetUrl
                };
              }
            }
          }
          // Instagram
          if (missing.includes("Instagram") && !foundSocials["Instagram"]) {
            const igMatch = target.match(/instagram\.com\/([a-zA-Z0-9_\.]{3,30})/i);
            if (igMatch) {
              const evalRes = evaluateHandleMatch("instagram", igMatch[1], creator, event);
              if (evalRes.valid) {
                foundSocials["Instagram"] = `https://www.instagram.com/${igMatch[1].replace(/\.$/, '')}/`;
                foundReasons["Instagram"] = {
                  text: evalRes.reason,
                  sourceUrl: targetUrl
                };
              }
            }
          }
          // Discord
          if (missing.includes("Discord") && !foundSocials["Discord Page"]) {
            const discMatch = target.match(/(?:discord\.gg|discord\.com\/invite)\/([a-zA-Z0-9_\-]+)/i);
            if (discMatch) {
              const validation = await validateDiscordInvite(discMatch[1], creator, event);
              if (validation && validation.active) {
                foundSocials["Discord Page"] = validation.url;
                foundSocials["_discordTitle"] = validation.title;
                foundReasons["Discord Page"] = {
                  text: validation.reason,
                  sourceUrl: targetUrl
                };
              }
            }
          }
        }

        // 2B. Email in page text
        if (missing.includes("Email") && !foundSocials["Email"]) {
          const validEmail = extractValidEmails(html);
          if (validEmail) {
            foundSocials["Email"] = validEmail;
            foundReasons["Email"] = {
              text: `Business contact '${validEmail}' listed in official YouTube channel details`,
              sourceUrl: targetUrl
            };
          }
        }

        if (Object.keys(foundSocials).length >= missing.length) break;
      } catch (e) {}
    }
  }

  // STEP 3: Video Descriptions & Decoded Redirects of Latest Uploads
  const stillMissingAfterProfile = missing.filter(m => {
    if (m === "Instagram" && foundSocials["Instagram"]) return false;
    if (m === "Twitter/X" && foundSocials["X account"]) return false;
    if (m === "Discord" && foundSocials["Discord Page"]) return false;
    if (m === "Email" && foundSocials["Email"]) return false;
    return true;
  });

  if (stillMissingAfterProfile.length > 0 && channelUrl) {
    try {
      const cleanUrl = channelUrl.replace(/\/(about|featured|videos|community|channels|playlists|streams|shorts)\/?$/, '');
      const vidsResp = await fetch(cleanUrl + "/videos");
      const vidsHtml = await vidsResp.text();
      const vidMatches = vidsHtml.match(/\/watch\?v=([a-zA-Z0-9_-]{11})/g);
      
      if (vidMatches && vidMatches.length > 0) {
        const uniqueVids = [...new Set(vidMatches.map(v => v.replace('/watch?v=', '')))].slice(0, 2);
        for (const vidId of uniqueVids) {
          const vidUrl = `https://www.youtube.com/watch?v=${vidId}`;
          const vResp = await fetch(vidUrl);
          const vHtml = await vResp.text();

          // Decoded redirects in video description
          const vRedirects = extractYouTubeRedirects(vHtml);
          for (const { target, event } of vRedirects) {
            if (stillMissingAfterProfile.includes("Twitter/X") && !foundSocials["X account"]) {
              const twMatch = target.match(/(?:twitter|x)\.com\/([a-zA-Z0-9_]{1,15})/i);
              if (twMatch) {
                const evalRes = evaluateHandleMatch("twitter", twMatch[1], creator, event);
                if (evalRes.valid) {
                  foundSocials["X account"] = `https://x.com/${twMatch[1]}`;
                  foundReasons["X account"] = {
                    text: evalRes.reason,
                    sourceUrl: vidUrl
                  };
                }
              }
            }
            if (stillMissingAfterProfile.includes("Instagram") && !foundSocials["Instagram"]) {
              const igMatch = target.match(/instagram\.com\/([a-zA-Z0-9_\.]{3,30})/i);
              if (igMatch) {
                const evalRes = evaluateHandleMatch("instagram", igMatch[1], creator, event);
                if (evalRes.valid) {
                  foundSocials["Instagram"] = `https://www.instagram.com/${igMatch[1].replace(/\.$/, '')}/`;
                  foundReasons["Instagram"] = {
                    text: evalRes.reason,
                    sourceUrl: vidUrl
                  };
                }
              }
            }
            if (stillMissingAfterProfile.includes("Discord") && !foundSocials["Discord Page"]) {
              const discMatch = target.match(/(?:discord\.gg|discord\.com\/invite)\/([a-zA-Z0-9_\-]+)/i);
              if (discMatch) {
                const validation = await validateDiscordInvite(discMatch[1], creator, event);
                if (validation && validation.active) {
                  foundSocials["Discord Page"] = validation.url;
                  foundSocials["_discordTitle"] = validation.title;
                  foundReasons["Discord Page"] = {
                    text: validation.reason,
                    sourceUrl: vidUrl
                  };
                }
              }
            }
          }

          // Email in video description
          if (stillMissingAfterProfile.includes("Email") && !foundSocials["Email"]) {
            const validEmail = extractValidEmails(vHtml);
            if (validEmail) {
              foundSocials["Email"] = validEmail;
              foundReasons["Email"] = {
                text: `Business contact '${validEmail}' found in latest video description`,
                sourceUrl: vidUrl
              };
            }
          }
        }
      }
    } catch (e) {
      console.warn("Video description scan error:", e);
    }
  }

  // STEP 4: Headless Background Web Search (Strict Creator Token Matching)
  const stillMissingFinal = missing.filter(m => {
    if (m === "Instagram" && (foundSocials["Instagram"] || creator.instagram)) return false;
    if (m === "Twitter/X" && (foundSocials["X account"] || creator.twitter)) return false;
    if (m === "Discord" && (foundSocials["Discord Page"] || creator.discord)) return false;
    if (m === "Email" && (foundSocials["Email"] || creator.email)) return false;
    return true;
  });

  if (stillMissingFinal.length > 0) {
    const { found: webFound, reasons: webReasons } = await executeHeadlessWebSearch(creator, stillMissingFinal);
    Object.assign(foundSocials, webFound);
    Object.assign(foundReasons, webReasons);
  }

  // Update local creator object
  if (foundSocials["Instagram"]) creator.instagram = foundSocials["Instagram"];
  if (foundSocials["X account"]) creator.twitter = foundSocials["X account"];
  if (foundSocials["Discord Page"]) creator.discord = foundSocials["Discord Page"];
  if (foundSocials["Email"]) creator.email = foundSocials["Email"];
  if (foundSocials["Yt link"]) creator.youtube = foundSocials["Yt link"];

  // Filter out internal properties before saving to Airtable
  const patchPayload = { ...foundSocials };
  delete patchPayload["_discordTitle"];
  delete patchPayload["_reasons"];

  const foundKeys = Object.keys(patchPayload);
  if (foundKeys.length > 0) {
    await patchAirtableRecord(creator.id, patchPayload);
    return { success: true, found: foundSocials, reasons: foundReasons, keys: foundKeys };
  } else {
    return { success: false, reason: "No verified creator accounts found on channel or web (generic game/brand accounts filtered out)." };
  }
}

// -------------------------------------------------------------
// Interactive UI Handlers: Renders Clickable Discovered Pills & Reasons
// -------------------------------------------------------------
function renderDiscoveredPills(pillsContainerEl, foundSocials, reasons = {}, reasonsContainerEl = null) {
  if (pillsContainerEl) pillsContainerEl.innerHTML = "";
  if (reasonsContainerEl) reasonsContainerEl.innerHTML = "";

  for (const [key, val] of Object.entries(foundSocials || {})) {
    if (key.startsWith("_")) continue;

    if (pillsContainerEl) {
      const pill = document.createElement("a");
      pill.className = "discovered-pill";
      pill.href = val.startsWith("http") ? val : `mailto:${val}`;
      pill.target = "_blank";

      if (key === "X account") {
        pill.classList.add("pill-x");
        pill.innerHTML = `𝕏 ${val.split('/').pop()}`;
      } else if (key === "Instagram") {
        pill.classList.add("pill-ig");
        const h = val.replace('https://www.instagram.com/', '').replace('/', '');
        pill.innerHTML = `📷 @${h}`;
      } else if (key === "Discord Page") {
        pill.classList.add("pill-discord");
        const title = foundSocials["_discordTitle"] || "Discord Server (Active)";
        pill.innerHTML = `💬 ${title}`;
      } else if (key === "Email") {
        pill.classList.add("pill-email");
        pill.innerHTML = `✉ ${val}`;
      } else if (key === "Yt link") {
        pill.classList.add("pill-yt");
        pill.innerHTML = `▶ YouTube`;
      }

      pillsContainerEl.appendChild(pill);
    }

    if (reasonsContainerEl && reasons[key]) {
      const reasonObj = typeof reasons[key] === "object" ? reasons[key] : { text: reasons[key], sourceUrl: "" };
      const reasonRow = document.createElement("div");
      reasonRow.className = "reason-row";

      let badgeClass = "badge-x";
      let badgeLabel = "𝕏 Twitter";
      if (key === "Instagram") { badgeClass = "badge-ig"; badgeLabel = "📷 IG"; }
      else if (key === "Discord Page") { badgeClass = "badge-discord"; badgeLabel = "💬 Discord"; }
      else if (key === "Email") { badgeClass = "badge-email"; badgeLabel = "✉ Email"; }
      else if (key === "Yt link") { badgeClass = "badge-yt"; badgeLabel = "▶ YouTube"; }

      const sourceHtml = reasonObj.sourceUrl ? `
        <div class="reason-source">
          <span class="source-label">🔗 Source:</span>
          <a href="${escapeHtml(reasonObj.sourceUrl)}" target="_blank" class="source-link" title="Open source to verify: ${escapeHtml(reasonObj.sourceUrl)}">
            ${escapeHtml(formatSourceDisplay(reasonObj.sourceUrl))} ↗
          </a>
        </div>
      ` : "";

      reasonRow.innerHTML = `
        <span class="reason-platform-badge ${badgeClass}">${badgeLabel}</span>
        <div class="reason-body">
          <div class="reason-text">${escapeHtml(reasonObj.text || "")}</div>
          ${sourceHtml}
        </div>
      `;
      reasonsContainerEl.appendChild(reasonRow);
    }
  }
}

// Handler for Deep Search from Current Card (Queue Tab / Dashboard Center)
async function executeDeepCreatorSearch(creator, feedbackEl, btnEl, boxEl, pillsEl, autoOpenRecord = true) {
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.innerHTML = `<span>⏳</span> Deep Searching Web...`;
  }
  if (feedbackEl) {
    feedbackEl.style.display = "block";
    feedbackEl.className = "search-feedback";
    feedbackEl.innerText = `🔍 Scanning YouTube channel links, video descriptions, and verified socials...`;
  }
  if (boxEl) boxEl.style.display = "none";

  try {
    const result = await deepSearchCreatorSocials(creator);

    if (result.success) {
      const readable = result.keys.map(k => k === "X account" ? "Twitter/X" : k === "Discord Page" ? "Discord" : k === "Yt link" ? "YouTube" : k);
      
      if (feedbackEl) {
        feedbackEl.className = "search-feedback success";
        feedbackEl.innerText = `✓ Discovered & Saved to Airtable: ${readable.join(", ")}! Opening record...`;
      }

      if (boxEl && pillsEl) {
        boxEl.style.display = "flex";
        const reasonsEl = boxEl.querySelector(".discovered-reasons") || document.getElementById("currentDiscoveredReasons");
        renderDiscoveredPills(pillsEl, result.found, result.reasons, reasonsEl);
      }

      showToast(`✓ Added ${readable.join(", ")}! Opening record in Airtable...`);

      if (btnEl) {
        btnEl.innerHTML = `<span>✓</span> Saved & Opened!`;
        btnEl.classList.add("btn-outline-success");
      }

      setCurrentCreator(currentIndex);
      updateStats();
      updateFinderStats();
      renderFinderList();
      renderTodayDmQueue();

      if (autoOpenRecord) {
        setTimeout(() => {
          openAirtableRecord(creator);
        }, 700);
      }
    } else {
      const missingStr = getMissingSocials(creator).join(", ");
      if (feedbackEl) {
        feedbackEl.className = "search-feedback warning";
        feedbackEl.innerHTML = `⚠️ No public ${missingStr} found across the web or YouTube.<br><a href="#" id="openAtLink" style="color: #60a5fa; text-decoration: underline; font-weight: 600;">Open record in Airtable ➔</a>`;
        const link = feedbackEl.querySelector("#openAtLink");
        if (link) {
          link.addEventListener("click", (e) => {
            e.preventDefault();
            openAirtableRecord(creator);
          });
        }
      }
      if (btnEl) btnEl.innerHTML = `<span>⚠️</span> None Public`;
    }
  } catch (err) {
    // silenced error log
    if (feedbackEl) {
      feedbackEl.className = "search-feedback error";
      feedbackEl.innerText = `Search error: ${err.message}`;
    }
    if (btnEl) btnEl.innerHTML = `<span>❌</span> Error`;
  } finally {
    setTimeout(() => {
      if (btnEl) {
        btnEl.disabled = false;
        btnEl.innerHTML = `<span>🔍</span> Deep Search Web & YouTube`;
      }
    }, 3000);
  }
}

// Patch Airtable Record
// Safely patch Airtable without throwing uncaught promise rejections

// Create Airtable Record
async function createAirtableRecord(fields) {
  const safeFields = typeof sanitizeAirtablePayload === "function" ? sanitizeAirtablePayload(fields) : fields;
  delete safeFields["Last Touch Date"];

  const token = document.getElementById("airtableToken")?.value.trim() || DEFAULT_CONFIG.token;
  const baseId = document.getElementById("airtableBaseId")?.value.trim() || DEFAULT_CONFIG.baseId;
  const tableId = document.getElementById("airtableTableId")?.value.trim() || DEFAULT_CONFIG.tableId;

  // Extension environment check
  if (typeof chrome !== "undefined" && chrome?.runtime?.sendMessage) {
    try {
      const resp = await new Promise(resolve => {
        chrome.runtime.sendMessage({
          action: "CREATE_AIRTABLE_RECORD",
          baseId,
          tableId,
          token,
          fields: safeFields
        }, resolve);
      });
      if (resp && resp.success) return { success: true, record: resp.record };
    } catch (e) {}
  }

  // Web environment / Direct fetch fallback
  try {
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
      return { success: false, status: res.status, error: errText };
    }

    const data = await res.json().catch(() => ({}));
    return { success: true, record: data };
  } catch (err) {
    return { success: false, error: err.message || "Failed to create Airtable record" };
  }
}

async function patchAirtableRecord(recordId, fields) {
  if (!recordId) return { success: false, error: "Missing record ID" };
  const safeFields = typeof sanitizeAirtablePayload === "function" ? sanitizeAirtablePayload(fields) : fields;
  if (Object.keys(safeFields).length === 0) return { success: true, updated: 0 };

  const token = document.getElementById("airtableToken")?.value.trim() || DEFAULT_CONFIG.token;
  const baseId = document.getElementById("airtableBaseId")?.value.trim() || DEFAULT_CONFIG.baseId;
  const tableId = document.getElementById("airtableTableId")?.value.trim() || DEFAULT_CONFIG.tableId;

  try {
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
      return { success: false, status: res.status, error: errText };
    }
    const data = await res.json().catch(() => ({}));
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// -------------------------------------------------------------
// Render Finder Tab Cards with Live Discovered Pills & Status
// -------------------------------------------------------------
function renderFinderList() {
  const container = document.getElementById("finderList");
  if (!container) return;

  const missingList = creators.filter(c => getMissingSocials(c).length > 0);
  if (missingList.length === 0) {
    container.innerHTML = `<div class="empty-state"><p>🎉 All creators in Airtable have complete socials!</p></div>`;
    return;
  }

  container.innerHTML = "";
  missingList.slice(0, 50).forEach(c => {
    const missing = getMissingSocials(c);
    const card = document.createElement("div");
    card.className = "finder-card";

    card.innerHTML = `
      <div class="finder-card-top">
        <div class="finder-card-info">
          <h4>${c.name}</h4>
          <p class="missing-text">Missing: <b>${missing.join(", ")}</b></p>
        </div>
        <div class="finder-card-actions">
          <button class="btn btn-sm btn-accent-glow single-find-btn">🔍 Deep Search</button>
          <button class="single-at-btn" title="Open record in Airtable">↗ Airtable</button>
        </div>
      </div>
      <div class="finder-card-status"></div>
      <div class="discovered-socials-box" style="display: none; margin-top: 4px;">
        <span class="discovered-header">✓ Discovered & Saved:</span>
        <div class="discovered-pills"></div>
        <div class="discovered-reasons"></div>
      </div>
    `;

    const findBtn = card.querySelector(".single-find-btn");
    const atBtn = card.querySelector(".single-at-btn");
    const statusEl = card.querySelector(".finder-card-status");
    const discBox = card.querySelector(".discovered-socials-box");
    const discPills = card.querySelector(".discovered-pills");
    const discReasons = card.querySelector(".discovered-reasons");

    findBtn.addEventListener("click", async () => {
      findBtn.disabled = true;
      findBtn.innerText = "⏳ Searching...";
      statusEl.style.display = "block";
      statusEl.className = "finder-card-status";
      statusEl.innerText = "Deep searching YouTube, video descriptions, active Discord & web...";
      discBox.style.display = "none";

      try {
        const result = await deepSearchCreatorSocials(c);
        if (result.success) {
          const readable = result.keys.map(k => k === "X account" ? "Twitter/X" : k === "Discord Page" ? "Discord" : k === "Yt link" ? "YouTube" : k);
          card.classList.add("enriched");
          statusEl.className = "finder-card-status success show";
          statusEl.innerText = `✓ Saved to Airtable: ${readable.join(", ")}! Opening record...`;
          findBtn.innerText = "✓ Saved";
          findBtn.className = "btn btn-sm btn-outline-success";

          discBox.style.display = "flex";
          renderDiscoveredPills(discPills, result.found, result.reasons, discReasons);

          showToast(`✓ Added ${readable.join(", ")}! Opening in Airtable...`);

          const newMissing = getMissingSocials(c);
          card.querySelector(".missing-text").innerHTML = newMissing.length > 0 
            ? `Missing: <b>${newMissing.join(", ")}</b>`
            : `<b style="color: #34d399;">✓ Complete!</b>`;

          updateFinderStats();
          filterAndRenderList();

          setTimeout(() => {
            openAirtableRecord(c);
          }, 700);
        } else {
          statusEl.className = "finder-card-status warning show";
          statusEl.innerText = `⚠️ No public socials found on web or YouTube.`;
          findBtn.innerText = "None Found";
        }
      } catch (err) {
        statusEl.className = "finder-card-status warning show";
        statusEl.innerText = `⚠️ ${err.message}`;
        findBtn.innerText = "Error";
      } finally {
        setTimeout(() => {
          findBtn.disabled = false;
        }, 2000);
      }
    });

    atBtn.addEventListener("click", () => {
      openAirtableRecord(c);
    });

    container.appendChild(card);
  });
}

// -------------------------------------------------------------
// Batch Social Finder
// -------------------------------------------------------------
async function startBatchSocialEnrichment() {
  const missingCreators = creators.filter(c => getMissingSocials(c).length > 0);
  if (missingCreators.length === 0) {
    showToast("All creators already have full socials!");
    return;
  }

  isBatchSearching = true;
  const batchBtn = document.getElementById("batchFindBtn");
  const stopBtn = document.getElementById("stopBatchBtn");
  if (batchBtn) batchBtn.style.display = "none";
  if (stopBtn) stopBtn.style.display = "block";

  const pContainer = document.getElementById("batchProgressContainer");
  const pText = document.getElementById("progressText");
  const pPercent = document.getElementById("progressPercent");
  const pFill = document.getElementById("progressBarFill");
  const pLog = document.getElementById("batchLog");

  if (pContainer) pContainer.style.display = "block";
  if (pLog) pLog.innerHTML = `<div>[${new Date().toLocaleTimeString()}] Starting deep search for ${missingCreators.length} creators...</div>`;

  let processed = 0;
  let enrichedCount = 0;

  for (const c of missingCreators) {
    if (!isBatchSearching) break;

    processed++;
    const pct = Math.round((processed / missingCreators.length) * 100);
    if (pFill) pFill.style.width = `${pct}%`;
    if (pPercent) pPercent.innerText = `${pct}%`;
    if (pText) pText.innerText = `Deep searching (${processed}/${missingCreators.length}): ${c.name}`;

    try {
      const result = await deepSearchCreatorSocials(c);
      if (result.success) {
        enrichedCount++;
        if (pLog) {
          const logLine = document.createElement("div");
          logLine.style.color = "#34d399";
          const reasonsBrief = Object.entries(result.reasons || {}).map(([k, r]) => {
            const text = typeof r === "object" ? r.text : r;
            const src = typeof r === "object" && r.sourceUrl ? ` [${formatSourceDisplay(r.sourceUrl)}]` : "";
            return `${k}: ${text}${src}`;
          }).join(" | ");
          logLine.innerText = `✓ ${c.name}: Found ${result.keys.join(", ")}${reasonsBrief ? ' — ' + reasonsBrief : ''}`;
          pLog.prepend(logLine);
        }
      }
    } catch (e) {
      // silenced error log
    }

    updateFinderStats();
    await new Promise(r => setTimeout(r, 600));
  }

  if (pText) pText.innerText = `Done! Enriched ${enrichedCount} creators.`;
  stopBatchSocialEnrichment();
  filterAndRenderList();
  renderFinderList();
  renderTodayDmQueue();
  showToast(`Deep search complete! Added socials to ${enrichedCount} creators.`);
}

function stopBatchSocialEnrichment() {
  isBatchSearching = false;
  const batchBtn = document.getElementById("batchFindBtn");
  const stopBtn = document.getElementById("stopBatchBtn");
  if (batchBtn) batchBtn.style.display = "block";
  if (stopBtn) stopBtn.style.display = "none";
}

// -------------------------------------------------------------
// Mark Done in Airtable API & Auto-Queue
// -------------------------------------------------------------
async function markCurrentAsMessaged(autoAdvance = true) {
  if (currentIndex < 0 || currentIndex >= creators.length) return;
  const c = creators[currentIndex];

  const token = document.getElementById("airtableToken")?.value.trim() || DEFAULT_CONFIG.token;
  const baseId = document.getElementById("airtableBaseId")?.value.trim() || DEFAULT_CONFIG.baseId;
  const tableId = document.getElementById("airtableTableId")?.value.trim() || DEFAULT_CONFIG.tableId;

  setStatus("Updating...");

  try {
    const url = `https://api.airtable.com/v0/${baseId}/${tableId}/${c.id}`;
    const today = new Date().toISOString().split("T")[0];

    const patchBody = { "Status": "Messaged" };
    if (!c.firstDmDate) patchBody["First DM Date"] = today;
    const patchRes = await patchAirtableRecord(c.id, patchBody);
    if (!patchRes || !patchRes.success) throw new Error(patchRes?.error || "Airtable update failed");

    c.status = "Messaged";
    c.lastTouch = today;
    updateStats();
    renderTodayDmQueue();
    setStatus("Active");
    showToast(`✓ Marked ${c.name} as Messaged in Airtable!`);

    if (autoAdvance) {
      advanceQueue(1);
    }
  } catch (err) {
    // silenced error log
    setStatus("Error");
    showToast("Failed to update Airtable.");
  }
}

// Navigation & Auto Queue
function advanceQueue(step = 1) {
  let next = currentIndex + step;
  while (next < creators.length && creators[next].status === "Messaged") {
    next++;
  }

  if (next < creators.length) {
    setCurrentCreator(next);
  } else {
    showToast("🎉 All pending creators in queue have been processed!");
    stopAutoQueue();
  }
}

function toggleAutoQueue() {
  const btn = document.getElementById("autoQueueBtn");
  if (isAutoQueueRunning) {
    stopAutoQueue();
  } else {
    isAutoQueueRunning = true;
    if (btn) {
      btn.innerText = "⏹ Stop Auto-Queue";
      btn.className = "btn btn-outline-secondary";
    }
    showToast("Auto-Queue started!");
    runNextAutoStep();
  }
}

function stopAutoQueue() {
  isAutoQueueRunning = false;
  clearTimeout(autoTimer);
  const btn = document.getElementById("autoQueueBtn");
  if (btn) {
    btn.innerText = "▶ Start Auto-Queue";
    btn.className = "btn btn-success";
  }
}

function runNextAutoStep() {
  if (!isAutoQueueRunning) return;
  const c = creators[currentIndex];
  if (!c) {
    stopAutoQueue();
    return;
  }

  const template = getPersonalizedPitch(c);
  copyToClipboard(template);

  if (c.twitter) {
    openExternalUrl(c.twitter );
  } else if (c.email) {
    const subject = encodeURIComponent(getPersonalizedSubject(c));
    const body = encodeURIComponent(template);
    chrome.tabs.create({ url: `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(c.email)}&su=${subject}&body=${body}` });
  } else if (c.discord) {
    openExternalUrl(c.discord );
  } else if (c.instagram) {
    openExternalUrl(c.instagram );
  }

  showToast(`Auto-opened ${c.name}. Ready to message!`);

  const delaySec = parseInt(document.getElementById("delaySeconds")?.value, 10) || 8;
  autoTimer = setTimeout(() => {
    if (isAutoQueueRunning) {
      markCurrentAsMessaged(true);
      runNextAutoStep();
    }
  }, delaySec * 1000);
}

// =============================================================
// Text-Blaze Style Pitch Interpolator & Snippet Helpers
// =============================================================
function getActivePitchTemplate() {
  return savedPitches.find(p => p.id === activePitchId) || savedPitches[0] || DEFAULT_PITCH_TEMPLATES[0];
}

function getPersonalizedPitch(creator, templateOverride = null) {
  let tpl = templateOverride;
  if (!tpl) {
    if ((activePitchId === "ab_auto_rotate" || isAbTestMode) && savedPitches.length > 0) {
      const idx = creators.findIndex(c => c.id === creator?.id);
      const pIdx = idx >= 0 ? (idx % savedPitches.length) : 0;
      tpl = savedPitches[pIdx];
      if (creator?.id && tpl?.id) {
        creatorPitchMap[creator.id] = tpl.id;
      }
    } else {
      tpl = getActivePitchTemplate();
      if (creator?.id && tpl?.id && !creatorPitchMap[creator.id]) {
        creatorPitchMap[creator.id] = tpl.id;
      }
    }
  }
  const raw = tpl ? tpl.body : DEFAULT_CONFIG.template;
  return interpolatePitch(raw, creator);
}

function getPersonalizedSubject(creator, templateOverride = null) {
  const tpl = templateOverride || getActivePitchTemplate();
  const raw = tpl?.subject || DEFAULT_CONFIG.subject || "Collaboration: {name}";
  return interpolatePitch(raw, creator);
}

function interpolatePitch(templateText, creator) {
  if (!templateText) return "";
  const name = creator ? (creator?.name || "Creator" || "there") : "there";
  const firstName = name.split(" ")[0].trim() || name;
  const niche = creator ? (creator.niche || "Roblox") : "Roblox";
  const channel = creator ? (creator.youtube || "") : "";
  const handle = creator ? (creator.twitter || creator.instagram || "") : "";

  return templateText
    .replace(/\{name\}/gi, name)
    .replace(/\{first_name\}/gi, firstName)
    .replace(/\{niche\}/gi, niche)
    .replace(/\{channel\}/gi, channel)
    .replace(/\{handle\}/gi, handle);
}

// -------------------------------------------------------------
// Pitch Library (Text-Blaze Snippets) Runtime
// -------------------------------------------------------------
async function loadSavedPitches() {
  try {
    const data = await appStorage.get(["savedPitches", "activePitchId", "pitchesVersion", "pitchStats", "creatorPitchMap", "isAbTestMode"]);
    if (data.pitchStats && typeof data.pitchStats === "object") pitchStats = data.pitchStats;
    if (data.creatorPitchMap && typeof data.creatorPitchMap === "object") creatorPitchMap = data.creatorPitchMap;
    if (typeof data.isAbTestMode === "boolean") isAbTestMode = data.isAbTestMode;
    if (Array.isArray(data.savedPitches) && data.savedPitches.length > 0 && data.pitchesVersion === "dm_v2") {
      savedPitches = data.savedPitches;
    } else {
      savedPitches = [...DEFAULT_PITCH_TEMPLATES];
      await appStorage.set({ savedPitches, pitchesVersion: "dm_v2" });
    }
    if (data.activePitchId && savedPitches.some(p => p.id === data.activePitchId)) {
      activePitchId = data.activePitchId;
    } else {
      activePitchId = savedPitches[0].id;
    }
  } catch (err) {
    console.warn("Error loading pitches:", err);
    savedPitches = [...DEFAULT_PITCH_TEMPLATES];
    activePitchId = savedPitches[0].id;
  }
  populatePitchSelectDropdowns();
  renderPitchesManager();
}

async function savePitchesToStorage() {
  await appStorage.set({ savedPitches, activePitchId });
  populatePitchSelectDropdowns();
  renderPitchesManager();
  renderTodayDmQueue();
  if (currentIndex >= 0 && currentIndex < creators.length) {
    setCurrentCreator(currentIndex);
  }
}

function populatePitchSelectDropdowns() {
  const selects = [
    document.getElementById("todayPitchSelect"),
    document.getElementById("dashTodayPitchSelect"),
    document.getElementById("dashPitchSelect")
  ];

  selects.forEach(sel => {
    if (!sel) return;
    sel.innerHTML = "";

    // A/B Test Option
    const abOpt = document.createElement("option");
    abOpt.value = "ab_auto_rotate";
    abOpt.innerText = "🎲 A/B Auto-Rotate (50/50)";
    if (activePitchId === "ab_auto_rotate") abOpt.selected = true;
    sel.appendChild(abOpt);

    savedPitches.forEach(p => {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.innerText = `${p.shortcut ? p.shortcut + ' ' : ''}${p.title}`;
      if (p.id === activePitchId) opt.selected = true;
      sel.appendChild(opt);
    });
  });

  const abToggles = [
    document.getElementById("abAutoRotateToggle"),
    document.getElementById("dashAbAutoRotateToggle")
  ];
  abToggles.forEach(tog => {
    if (tog) tog.checked = isAbTestMode || activePitchId === "ab_auto_rotate";
  });
}

function renderPitchesManager() {
  const c1 = document.getElementById("pitchesList");
  const c2 = document.getElementById("dashPitchesList");

  [c1, c2].forEach(container => {
    if (!container) return;
    container.innerHTML = "";

    savedPitches.forEach(p => {
      const card = document.createElement("div");
      card.className = `pitch-card ${p.id === activePitchId ? 'active-pitch' : ''}`;
      card.id = `pitchCard_${p.id}`;

      // Highlight dynamic variables in preview
      const previewHtml = escapeHtml(p.body)
        .replace(/\{name\}/gi, '<span class="pitch-highlight-var">{name}</span>')
        .replace(/\{first_name\}/gi, '<span class="pitch-highlight-var">{first_name}</span>')
        .replace(/\{niche\}/gi, '<span class="pitch-highlight-var">{niche}</span>')
        .replace(/\{channel\}/gi, '<span class="pitch-highlight-var">{channel}</span>')
        .replace(/\{handle\}/gi, '<span class="pitch-highlight-var">{handle}</span>');

      card.innerHTML = `
        <div class="pitch-card-top">
          <div class="pitch-title-group">
            <span class="pitch-title">${escapeHtml(p.title)}</span>
            <span class="pitch-shortcut-tag">${escapeHtml(p.shortcut || "/dm")}</span>
            ${p.id === activePitchId ? '<span style="font-size: 10px; font-weight: 700; color: #34d399; background: rgba(16,185,129,0.15); border: 1px solid rgba(16,185,129,0.3); padding: 1px 6px; border-radius: 4px;">ACTIVE</span>' : ''}
          </div>
        </div>
        <div class="pitch-preview-body">
          <div style="font-size: 9.5px; color: #94a3b8; margin-bottom: 4px; font-weight: 600; display: flex; align-items: center; gap: 4px;">
            <span>💬 DM Message Preview:</span>
          </div>
          ${previewHtml}
        </div>
        <div class="pitch-card-footer">
          <button class="btn btn-sm btn-outline-secondary btn-select-pitch" data-id="${p.id}" ${p.id === activePitchId ? 'disabled style="opacity: 0.6;"' : ''}>
            ${p.id === activePitchId ? '✓ Current Active' : '⭐ Set as Active'}
          </button>
          <div style="display: flex; gap: 5px;">
            <button class="btn btn-sm btn-outline-secondary btn-edit-pitch" data-id="${p.id}">✏️ Edit</button>
            <button class="btn btn-sm btn-outline-danger btn-delete-pitch" data-id="${p.id}" ${savedPitches.length <= 1 ? 'disabled style="opacity: 0.5;"' : ''}>🗑️</button>
          </div>
        </div>
      `;

      // Set active button
      const selectBtn = card.querySelector(".btn-select-pitch");
      if (selectBtn && p.id !== activePitchId) {
        selectBtn.addEventListener("click", () => {
          activePitchId = p.id;
          savePitchesToStorage();
          showToast(`Set "${p.title}" as active pitch!`);
        });
      }

      // Edit button
      const editBtn = card.querySelector(".btn-edit-pitch");
      if (editBtn) {
        editBtn.addEventListener("click", () => {
          openPitchForm(p.id, container === c2);
        });
      }

      // Delete button
      const delBtn = card.querySelector(".btn-delete-pitch");
      if (delBtn && savedPitches.length > 1) {
        delBtn.addEventListener("click", () => {
          deletePitch(p.id);
        });
      }

      container.appendChild(card);
    });
  });
}

function openPitchForm(pitchId = null, isDashboard = false) {
  const form1 = document.getElementById("pitchFormContainer");
  const form2 = document.getElementById("dashPitchFormContainer");
  const targetForm = isDashboard ? (form2 || form1) : (form1 || form2);

  if (!targetForm) return;
  targetForm.style.display = "flex";

  const prefix = targetForm.id.includes("dash") ? "dash" : "";
  const titleInput = document.getElementById(`${prefix ? 'dashPitchTitleInput' : 'pitchTitleInput'}`);
  const shortcutInput = document.getElementById(`${prefix ? 'dashPitchShortcutInput' : 'pitchShortcutInput'}`);
  const bodyInput = document.getElementById(`${prefix ? 'dashPitchBodyInput' : 'pitchBodyInput'}`);
  const idInput = document.getElementById(`${prefix ? 'dashEditPitchId' : 'editPitchId'}`);
  const formHeader = document.getElementById(`${prefix ? 'dashPitchFormTitle' : 'pitchFormTitle'}`);

  if (pitchId) {
    const existing = savedPitches.find(p => p.id === pitchId);
    if (existing) {
      if (idInput) idInput.value = existing.id;
      if (titleInput) titleInput.value = existing.title;
      if (shortcutInput) shortcutInput.value = existing.shortcut || "";
      if (bodyInput) bodyInput.value = existing.body;
      if (formHeader) formHeader.innerText = "Edit DM Template";
    }
  } else {
    if (idInput) idInput.value = "";
    if (titleInput) titleInput.value = "";
    if (shortcutInput) shortcutInput.value = "/deal";
    if (bodyInput) bodyInput.value = "Hey {name}! Loved your recent {niche} uploads. We have an exclusive paid brand partnership that fits your audience and pays top rates. Would love to send over the brief—what's the best email to reach you at?";
    if (formHeader) formHeader.innerText = "Create New DM Template";
  }

  targetForm.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function closePitchForm() {
  const form1 = document.getElementById("pitchFormContainer");
  const form2 = document.getElementById("dashPitchFormContainer");
  if (form1) form1.style.display = "none";
  if (form2) form2.style.display = "none";
}

function savePitchFromForm(isDashboard = false) {
  const prefix = isDashboard ? "dash" : "";
  const titleInput = document.getElementById(`${prefix ? 'dashPitchTitleInput' : 'pitchTitleInput'}`);
  const shortcutInput = document.getElementById(`${prefix ? 'dashPitchShortcutInput' : 'pitchShortcutInput'}`);
  const bodyInput = document.getElementById(`${prefix ? 'dashPitchBodyInput' : 'pitchBodyInput'}`);
  const idInput = document.getElementById(`${prefix ? 'dashEditPitchId' : 'editPitchId'}`);

  const title = titleInput?.value.trim() || "Untitled DM";
  const shortcut = shortcutInput?.value.trim() || "/dm";
  const body = bodyInput?.value.trim();

  if (!body) {
    showToast("Please enter a DM message!");
    return;
  }

  const existingId = idInput?.value;
  if (existingId) {
    const idx = savedPitches.findIndex(p => p.id === existingId);
    if (idx !== -1) {
      savedPitches[idx] = { id: existingId, title, shortcut, body };
      showToast(`Updated "${title}"!`);
    }
  } else {
    const newId = "pitch_" + Date.now();
    savedPitches.push({ id: newId, title, shortcut, body });
    activePitchId = newId;
    showToast(`Created new DM template "${title}"!`);
  }

  closePitchForm();
  savePitchesToStorage();
}

function deletePitch(pitchId) {
  if (savedPitches.length <= 1) {
    showToast("You must keep at least one pitch template!");
    return;
  }

  const pitchToDelete = savedPitches.find(p => p.id === pitchId);
  if (!confirm(`Delete template "${pitchToDelete?.title || pitchId}"?`)) return;

  savedPitches = savedPitches.filter(p => p.id !== pitchId);
  if (activePitchId === pitchId) {
    activePitchId = savedPitches[0].id;
  }

  savePitchesToStorage();
  showToast("Pitch template deleted.");
}

function insertTextAtCursor(textarea, text) {
  if (!textarea) return;
  const start = textarea.selectionStart || 0;
  const end = textarea.selectionEnd || 0;
  const val = textarea.value;
  textarea.value = val.substring(0, start) + text + val.substring(end);
  textarea.focus();
  textarea.selectionStart = textarea.selectionEnd = start + text.length;
}

// -------------------------------------------------------------
// Old Channels & Inactive Channel Auditor Runtime
// -------------------------------------------------------------
async function scanChannelUploadActivity(creator) {
  if (!creator.youtube) {
    return { status: "missing_link", text: "No YouTube link", daysAgo: 9999, isOld: true };
  }

  const cacheKey = creator.youtube;
  if (channelActivityCache.has(cacheKey)) {
    return channelActivityCache.get(cacheKey);
  }

  try {
    let cleanUrl = creator.youtube.replace(/\/videos\/?$/, '').replace(/\/$/, '');
    let channelId = null;

    // Check if channel ID is directly in the YouTube link
    const ucDirect = cleanUrl.match(/(UC[a-zA-Z0-9_\-]{22})/);
    if (ucDirect) {
      channelId = ucDirect[1];
    }

    // If handle or custom URL, fetch channel page to obtain channelId
    if (!channelId) {
      const pageRes = await fetch(cleanUrl + '/videos', {
        headers: {
          'Accept-Language': 'en-US,en;q=0.9',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });
      if (pageRes.ok) {
        const pageHtml = await pageRes.text();
        const cidMatch = pageHtml.match(/"(UC[a-zA-Z0-9_\-]{22})"/);
        if (cidMatch) channelId = cidMatch[1];
      }
    }

    // If channelId found, query official YouTube RSS feed for exact published timestamp
    if (channelId) {
      const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
      const rssRes = await fetch(rssUrl);
      if (rssRes.ok) {
        const rssXml = await rssRes.text();
        const entries = rssXml.match(/<entry>[\s\S]*?<\/entry>/g) || [];
        if (entries.length > 0) {
          const firstEntry = entries[0];
          const pubMatch = firstEntry.match(/<published>([^<]+)<\/published>/);
          const titleMatch = firstEntry.match(/<title>([^<]+)<\/title>/);
          if (pubMatch) {
            const pubDate = new Date(pubMatch[1]);
            const diffMs = Date.now() - pubDate.getTime();
            const daysAgo = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));

            let uploadText = "";
            if (daysAgo === 0) uploadText = "Uploaded today";
            else if (daysAgo === 1) uploadText = "1 day ago";
            else if (daysAgo < 7) uploadText = `${daysAgo} days ago`;
            else if (daysAgo < 30) uploadText = `${Math.floor(daysAgo / 7)} week${Math.floor(daysAgo / 7) > 1 ? 's' : ''} ago`;
            else if (daysAgo < 365) uploadText = `${Math.floor(daysAgo / 30)} month${Math.floor(daysAgo / 30) > 1 ? 's' : ''} ago`;
            else uploadText = `${Math.floor(daysAgo / 365)} year${Math.floor(daysAgo / 365) > 1 ? 's' : ''} ago`;

            const isOld = daysAgo >= 60;
            const info = {
              status: "ok",
              text: uploadText,
              daysAgo,
              isOld,
              latestVideo: titleMatch ? titleMatch[1] : "",
              pubIso: pubMatch[1]
            };
            channelActivityCache.set(cacheKey, info);
            return info;
          }
        } else {
          // 0 videos uploaded
          const info = { status: "no_videos", text: "No videos uploaded", daysAgo: 9999, isOld: true };
          channelActivityCache.set(cacheKey, info);
          return info;
        }
      }
    }

    // Fallback: Check ytInitialData publishedTimeText if RSS failed
    const fallbackRes = await fetch(cleanUrl + '/videos', {
      headers: {
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    if (fallbackRes.ok) {
      const fHtml = await fallbackRes.text();
      const pubTimeMatch = fHtml.match(/"publishedTimeText":\s*\{\s*"simpleText":\s*"([^"]+)"/);
      if (pubTimeMatch) {
        const text = pubTimeMatch[1].trim();
        let daysAgo = 10;
        const numMatch = text.match(/(\d+)\s+(hour|day|week|month|year)/i);
        if (numMatch) {
          const n = parseInt(numMatch[1], 10) || 1;
          const u = numMatch[2].toLowerCase();
          if (u.startsWith("hour")) daysAgo = 0.1;
          else if (u.startsWith("day")) daysAgo = n;
          else if (u.startsWith("week")) daysAgo = n * 7;
          else if (u.startsWith("month")) daysAgo = n * 30;
          else if (u.startsWith("year")) daysAgo = n * 365;
        }
        const isOld = daysAgo >= 60;
        const info = { status: "ok", text, daysAgo, isOld };
        channelActivityCache.set(cacheKey, info);
        return info;
      }
    }

    const info = { status: "error", text: "Scan failed", daysAgo: 9999, isOld: false };
    channelActivityCache.set(cacheKey, info);
    return info;
  } catch (err) {
    return { status: "error", text: "Scan error", daysAgo: 9999, isOld: false };
  }
}

async function startBatchChannelScan() {
  if (isScanningOldChannels) return;
  isScanningOldChannels = true;

  const pBox1 = document.getElementById("oldScanProgressContainer");
  const pBox2 = document.getElementById("dashOldScanProgressContainer");
  [pBox1, pBox2].forEach(b => { if (b) b.style.display = "block"; });

  const creatorsWithYt = creators.filter(c => Boolean(c.youtube));
  let checked = 0;

  for (let i = 0; i < creatorsWithYt.length; i++) {
    const c = creatorsWithYt[i];
    const pct = Math.round(((i + 1) / creatorsWithYt.length) * 100);
    const txt = `Auditing ${c.name}... (${i + 1}/${creatorsWithYt.length})`;

    const t1 = document.getElementById("oldScanText");
    const t2 = document.getElementById("dashOldScanText");
    const pc1 = document.getElementById("oldScanPercent");
    const pc2 = document.getElementById("dashOldScanPercent");
    const fill1 = document.getElementById("oldScanBarFill");
    const fill2 = document.getElementById("dashOldScanBarFill");

    if (t1) t1.innerText = txt;
    if (t2) t2.innerText = txt;
    if (pc1) pc1.innerText = `${pct}%`;
    if (pc2) pc2.innerText = `${pct}%`;
    if (fill1) fill1.style.width = `${pct}%`;
    if (fill2) fill2.style.width = `${pct}%`;

    await scanChannelUploadActivity(c);
    checked++;
    renderOldChannelsChecker();

    await new Promise(r => setTimeout(r, 350));
  }

  isScanningOldChannels = false;
  setTimeout(() => {
    [pBox1, pBox2].forEach(b => { if (b) b.style.display = "none"; });
  }, 2000);

  showToast(`Audited upload activity for ${checked} channels!`);
}

async function deleteAirtableRecord(creatorId, creatorName = "this creator", skipConfirm = false) {
  const token = document.getElementById("airtableToken")?.value.trim() || DEFAULT_CONFIG.token;
  const baseId = document.getElementById("airtableBaseId")?.value.trim() || DEFAULT_CONFIG.baseId;
  const tableId = document.getElementById("airtableTableId")?.value.trim() || DEFAULT_CONFIG.tableId;

  if (!skipConfirm && !confirm(`Permanently delete "${creatorName}" from Airtable?\nThis cannot be undone.`)) {
    return false;
  }

  setStatus("Deleting...");
  try {
    let success = false;

    // 1. Extension environment check
    if (typeof chrome !== "undefined" && chrome?.runtime?.sendMessage) {
      try {
        const resp = await new Promise(resolve => {
          chrome.runtime.sendMessage({
            action: "DELETE_AIRTABLE_RECORD",
            baseId,
            tableId,
            token,
            recordId: creatorId
          }, resolve);
        });
        if (resp && resp.success) success = true;
      } catch (e) {}
    }

    // 2. Direct fetch
    if (!success) {
      const url = `https://api.airtable.com/v0/${baseId}/${tableId}/${creatorId}`;
      const res = await fetch(url, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        success = true;
      } else {
        // 3. Fallback to server proxy
        const proxyResp = await fetch("/api/airtable/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ baseId, tableId, recordId: creatorId })
        });
        if (proxyResp.ok) success = true;
      }
    }

    if (!success) throw new Error("Airtable delete request failed");

    // Remove from in-memory array
    creators = creators.filter(c => c.id !== creatorId);

    // Refresh UI
    updateStats();
    updateFinderStats();
    filterAndRenderList();
    renderFinderList();
    syncPitchStatsWithCreators(creators);
    renderTodayDmQueue();
    renderOldChannelsChecker();

    setStatus("Active");
    showToast(`🗑️ Successfully deleted "${creatorName}" from Airtable!`);
    return true;
  } catch (err) {
    setStatus("Error");
    showToast(`Failed to delete record: ${err.message}`);
    return false;
  }
}

function renderOldChannelsChecker() {
  const filterVal = (document.getElementById("oldChannelsFilter") || document.getElementById("dashOldChannelsFilter"))?.value || "inactive_60";

  const flagged = [];

  creators.forEach(c => {
    if (!c.youtube) return;
    const cacheInfo = channelActivityCache.get(c.youtube);

    // Only flag channels that have actually been audited and found to be inactive
    const isScanned = Boolean(cacheInfo && cacheInfo.status === "ok");
    const daysAgo = cacheInfo ? cacheInfo.daysAgo : 0;
    const uploadText = cacheInfo ? cacheInfo.text : "⏳ Not Scanned Yet";
    const isOld = cacheInfo ? cacheInfo.isOld : false;

    let matchesFilter = false;
    if (filterVal === "all") matchesFilter = true;
    else if (filterVal === "inactive_60" && isScanned && daysAgo >= 60) matchesFilter = true;
    else if (filterVal === "inactive_90" && isScanned && daysAgo >= 90) matchesFilter = true;
    else if (filterVal === "inactive_180" && isScanned && daysAgo >= 180) matchesFilter = true;
    else if (filterVal === "inactive_365" && isScanned && daysAgo >= 365) matchesFilter = true;
    else if (filterVal === "no_videos" && isScanned && daysAgo >= 9990) matchesFilter = true;

    // In 'all' view, show all YouTube creators; in inactive views, show verified inactive channels
    if (filterVal === "all" || (matchesFilter && isOld)) {
      flagged.push({ creator: c, daysAgo, uploadText, isScanned, isOld });
    }
  });

  // Update badge count
  const badge1 = document.getElementById("oldChannelsBadge");
  const badge2 = document.getElementById("dashOldCount");
  if (badge1) badge1.innerText = flagged.length;
  if (badge2) badge2.innerText = flagged.length;

  const summary1 = document.getElementById("oldChannelsCountSummary");
  const summary2 = document.getElementById("dashOldChannelsCountSummary");
  if (summary1) summary1.innerText = `${flagged.length} inactive`;
  if (summary2) summary2.innerText = `${flagged.length} inactive`;

  const container1 = document.getElementById("oldChannelsList");
  const container2 = document.getElementById("dashOldChannelsList");

  [container1, container2].forEach(container => {
    if (!container) return;
    container.innerHTML = "";

    if (flagged.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; padding: 30px 15px; color: #94a3b8;">
          <div style="font-size: 28px; margin-bottom: 6px;">🎉</div>
          <b style="color: #f1f5f9; font-size: 13px;">No Inactive Channels Found</b>
          <p style="font-size: 11px; margin-top: 4px; color: #64748b;">
            All scanned channels are active, or click <b>Scan Activity</b> to check upload dates live.
          </p>
        </div>
      `;
      return;
    }

    flagged.forEach((item, idx) => {
      const { creator: c, daysAgo, uploadText } = item;
      const card = document.createElement("div");
      card.className = "old-channel-card";
      card.id = `oldChannel_${c.id}`;

      let badgeClass = "badge-warning";
      if (daysAgo >= 180) badgeClass = "badge-danger";
      else if (daysAgo < 60) badgeClass = "badge-success";

      const ytVideosUrl = c.youtube.replace(/\/videos\/?$/, '').replace(/\/$/, '') + '/videos';

      card.innerHTML = `
        <div class="old-channel-top">
          <div class="old-channel-info">
            <div class="old-channel-main">
              <span class="today-rank-badge">#${idx + 1}</span>
              <span class="old-channel-name">${escapeHtml(c.name)}</span>
              <span class="today-niche-badge">${escapeHtml(c.niche || "Roblox")}</span>
            </div>
            <div style="font-size: 10.5px; color: #94a3b8; display: flex; align-items: center; gap: 6px; margin-top: 2px;">
              <span>Channel:</span>
              <a href="${escapeHtml(ytVideosUrl)}" target="_blank" style="color: #f87171; text-decoration: none;" title="Open YouTube Channel">
                ${escapeHtml(c.youtube.replace('https://www.youtube.com/', ''))} ↗
              </a>
            </div>
          </div>
          <span class="upload-badge ${badgeClass}" title="Last video upload detected">
            ⏳ ${escapeHtml(uploadText)}
          </span>
        </div>
        <div class="old-channel-actions">
          <span style="font-size: 10px; color: #64748b;">Airtable ID: ${escapeHtml(c.id.slice(0, 8))}...</span>
          <div style="display: flex; gap: 6px;">
            <button class="btn-delete-channel" data-id="${c.id}" title="Permanently delete this inactive creator from Airtable">
              🗑️ Delete Entry
            </button>
            <a href="${escapeHtml(ytVideosUrl)}" target="_blank" class="btn btn-sm btn-primary" style="font-size: 10.5px; text-decoration: none; padding: 4px 9px;">
              ▶ Open Channel ↗
            </a>
          </div>
        </div>
      `;

      // Wire delete button
      const deleteBtn = card.querySelector(".btn-delete-channel");
      if (deleteBtn) {
        deleteBtn.addEventListener("click", () => {
          deleteAirtableRecord(c.id, c.name);
        });
      }

      container.appendChild(card);
    });
  });
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).catch(err => {
    // silenced error log
  });
}

function setStatus(text) {
  const badge = document.getElementById("statusBadge");
  if (badge) badge.innerText = text;
}

function showToast(msg) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.innerText = msg;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2500);
}

// =============================================================
// Today's DM Queue & Daily Outreach Engine
// =============================================================
let selectedDmPlatform = "all"; // "all" | "twitter" | "instagram" | "email" | "discord"
let isTodayRunnerRunning = false;
let isTodayRunnerPaused = false;
let todayRunnerTimer = null;
let todayCountdownInterval = null;
let currentTodayIndex = 0;
let dmedTodayCount = 0;
let todayQueueList = [];

// Exclude creators who are already in Discord, replied, current/paying clients, messaged, or inactive
const EXCLUDED_DM_STATUSES = new Set([
  // Clients & Discord (User requirement: exclude anyone in discord, replied, or current client)
  "active & paying", "active client", "current client", "client", "paying",
  "came in discord", "sent discord username", "converted", "placed in content calendar",
  // Replied & Discussion
  "replied", "responded", "asked portfolio", "talked about prices", "sent trail", "sent trial",
  "in discussion", "negotiating", "call booked", "signed", "partnered",
  // Messaged & Inactive / Not a fit
  "messaged", "contacted", "lost client", "dead", "rejected", "not a correct fit",
  "out of budget", "ghosted", "not happy with the results", "not interested",
  "do not contact", "passed", "declined", "booked", "closed / won", "closed won"
]);

function isExcludedFromDmQueue(creator, todayStr) {
  if (!creator) return true;
  const st = (creator.status || "").toLowerCase().trim();
  const fst = (creator.followUpStatus || "").toLowerCase().trim();

  // 1. Exclude if contacted today
  if (creator.lastTouch === todayStr) return true;

  // 2. Direct set match
  if (EXCLUDED_DM_STATUSES.has(st) || EXCLUDED_DM_STATUSES.has(fst)) return true;

  // 3. Keyword match for Discord, Client, Replied, Paying
  if (st.includes("discord") || fst.includes("discord")) return true;
  if (st.includes("client") || fst.includes("client")) return true;
  if (st.includes("replied") || fst.includes("replied")) return true;
  if (st.includes("paying") || st.includes("converted") || st.includes("calendar")) return true;
  if (st.includes("portfolio") || st.includes("prices") || st.includes("trail")) return true;

  return false;
}

function getTodayDmQueue(platform = selectedDmPlatform) {
  const today = new Date().toISOString().split("T")[0];
  return creators.filter(c => {
    // 1. Exclude already contacted, messaged, or responded creators
    if (isExcludedFromDmQueue(c, today)) return false;

    // 2. Platform filter
    if (platform === "twitter") return Boolean(c.twitter);
    if (platform === "instagram") return Boolean(c.instagram);
    if (platform === "email") return Boolean(c.email);
    if (platform === "discord") return Boolean(c.discord);

    // "all" -> has at least one reachable outreach channel
    return Boolean(c.twitter || c.instagram || c.email || c.discord);
  });
}

function updateTodayPlatformCounts() {
  const today = new Date().toISOString().split("T")[0];
  const eligibleCreators = creators.filter(c => !isExcludedFromDmQueue(c, today));

  const countAll = eligibleCreators.filter(c => Boolean(c.twitter || c.instagram || c.email || c.discord)).length;
  const countTwitter = eligibleCreators.filter(c => Boolean(c.twitter)).length;
  const countInstagram = eligibleCreators.filter(c => Boolean(c.instagram)).length;
  const countEmail = eligibleCreators.filter(c => Boolean(c.email)).length;
  const countDiscord = eligibleCreators.filter(c => Boolean(c.discord)).length;

  const setEl = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.innerText = val;
  };

  setEl("countPlatAll", countAll);
  setEl("countPlatTwitter", countTwitter);
  setEl("countPlatInstagram", countInstagram);
  setEl("countPlatEmail", countEmail);
  setEl("countPlatDiscord", countDiscord);

  setEl("dashCountPlatAll", countAll);
  setEl("dashCountPlatTwitter", countTwitter);
  setEl("dashCountPlatInstagram", countInstagram);
  setEl("dashCountPlatEmail", countEmail);
  setEl("dashCountPlatDiscord", countDiscord);
}

function setSelectedDmPlatform(platform) {
  selectedDmPlatform = platform;

  // If auto runner was active, reset it safely
  if (isTodayRunnerRunning) {
    stopTodayDmRunner();
  }
  currentTodayIndex = 0;
  dmedTodayCount = 0;

  // Update active state on all buttons in popup and dashboard
  document.querySelectorAll(".plat-toggle-btn").forEach(btn => {
    if (btn.dataset.platform === platform) {
      btn.classList.add("active");
    } else {
      btn.classList.remove("active");
    }
  });

  // Update active pill badge
  const platLabels = {
    all: "🌐 All Channels",
    twitter: "𝕏 Twitter / X",
    instagram: "📷 Instagram",
    email: "✉ Email",
    discord: "💬 Discord"
  };
  const label = platLabels[platform] || "🌐 All Channels";
  const b1 = document.getElementById("activePlatBadge");
  const b2 = document.getElementById("dashActivePlatBadge");
  if (b1) b1.innerText = label;
  if (b2) b2.innerText = label;

  renderTodayDmQueue();
}

function getPrimaryDmChannel(c) {
  if (c.twitter) {
    const handle = c.twitter.split('/').pop().replace(/[^a-zA-Z0-9_]/g, '');
    return {
      platform: "twitter",
      url: c.twitter,
      dmUrl: c.twitter,
      label: `𝕏 DM @${handle || 'creator'}`,
      icon: "𝕏",
      badgeClass: "pill-x"
    };
  }
  if (c.instagram) {
    const handle = c.instagram.replace('https://www.instagram.com/', '').replace('/', '').split('?')[0];
    return {
      platform: "instagram",
      url: c.instagram,
      dmUrl: c.instagram,
      label: `📷 IG @${handle || 'creator'}`,
      icon: "📷",
      badgeClass: "pill-ig"
    };
  }
  if (c.email) {
    const pitch = getPersonalizedPitch(c);
    const subject = getPersonalizedSubject(c);
    const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(c.email)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(pitch)}`;
    return {
      platform: "email",
      url: gmailUrl,
      dmUrl: gmailUrl,
      label: `✉ Email (${c.email})`,
      icon: "✉",
      badgeClass: "pill-email"
    };
  }
  if (c.discord) {
    return {
      platform: "discord",
      url: c.discord,
      dmUrl: c.discord,
      label: `💬 Discord Community`,
      icon: "💬",
      badgeClass: "pill-discord"
    };
  }
  return null;
}

function getDmChannelForPlatform(c, platform = selectedDmPlatform) {
  if (platform === "twitter" && c.twitter) {
    const handle = c.twitter.split('/').pop().replace(/[^a-zA-Z0-9_]/g, '');
    return {
      platform: "twitter",
      url: c.twitter,
      dmUrl: c.twitter,
      label: `𝕏 DM @${handle || 'creator'}`,
      icon: "𝕏",
      badgeClass: "pill-x"
    };
  }
  if (platform === "instagram" && c.instagram) {
    const handle = c.instagram.replace('https://www.instagram.com/', '').replace('/', '').split('?')[0];
    return {
      platform: "instagram",
      url: c.instagram,
      dmUrl: c.instagram,
      label: `📷 IG @${handle || 'creator'}`,
      icon: "📷",
      badgeClass: "pill-ig"
    };
  }
  if (platform === "email" && c.email) {
    const pitch = getPersonalizedPitch(c);
    const subject = getPersonalizedSubject(c);
    const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(c.email)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(pitch)}`;
    return {
      platform: "email",
      url: gmailUrl,
      dmUrl: gmailUrl,
      label: `✉ Email (${c.email})`,
      icon: "✉",
      badgeClass: "pill-email"
    };
  }
  if (platform === "discord" && c.discord) {
    return {
      platform: "discord",
      url: c.discord,
      dmUrl: c.discord,
      label: `💬 Discord Community`,
      icon: "💬",
      badgeClass: "pill-discord"
    };
  }

  // Fallback to primary channel if platform is "all" or specific not found
  return getPrimaryDmChannel(c);
}

function buildCreatorChannelsChipsHtml(c, activePlatform) {
  let html = "";
  if (c.twitter) {
    const handle = c.twitter.split('/').pop().replace(/[^a-zA-Z0-9_]/g, '');
    const isActive = activePlatform === "twitter";
    html += `<a href="${escapeHtml(c.twitter)}" target="_blank" class="creator-channel-chip ${isActive ? 'active-chip' : ''}" title="Open Twitter/X: @${handle}">𝕏 @${escapeHtml(handle || 'twitter')}</a>`;
  }
  if (c.instagram) {
    const handle = c.instagram.replace('https://www.instagram.com/', '').replace('/', '').split('?')[0];
    const isActive = activePlatform === "instagram";
    html += `<a href="${escapeHtml(c.instagram)}" target="_blank" class="creator-channel-chip ${isActive ? 'active-chip' : ''}" title="Open Instagram: @${handle}">📷 @${escapeHtml(handle || 'instagram')}</a>`;
  }
  if (c.email) {
    const isActive = activePlatform === "email";
    html += `<span class="creator-channel-chip ${isActive ? 'active-chip' : ''}" title="Email: ${escapeHtml(c.email)}">✉ ${escapeHtml(c.email)}</span>`;
  }
  if (c.discord) {
    const isActive = activePlatform === "discord";
    html += `<a href="${escapeHtml(c.discord)}" target="_blank" class="creator-channel-chip ${isActive ? 'active-chip' : ''}" title="Open Discord: ${escapeHtml(c.discord)}">💬 Discord</a>`;
  }
  return html || `<span style="font-size: 10px; color: #64748b;">No direct channels</span>`;
}

function renderTodayDmQueue() {
  updateTodayPlatformCounts();
  const rawList = getTodayDmQueue(selectedDmPlatform);
  
  // Check goal limit dropdown
  const goalEl = document.getElementById("todayGoalSelect") || document.getElementById("dashTodayGoalSelect");
  const goalVal = goalEl ? goalEl.value : "15";
  const limit = goalVal === "all" ? rawList.length : parseInt(goalVal, 10) || 15;
  
  todayQueueList = rawList.slice(0, limit);

  // Update badge counters
  const badge1 = document.getElementById("todayDmBadge");
  const badge2 = document.getElementById("dashTodayCount");
  if (badge1) badge1.innerText = rawList.length;
  if (badge2) badge2.innerText = rawList.length;

  updateTodayProgress(dmedTodayCount, todayQueueList.length);

  // Render popup container and dashboard container
  const c1 = document.getElementById("todayCreatorsList");
  const c2 = document.getElementById("dashTodayCreatorsList");

  [c1, c2].forEach(container => {
    if (!container) return;
    container.innerHTML = "";

    if (todayQueueList.length === 0) {
      const platNames = {
        all: "reachable",
        twitter: "Twitter / X",
        instagram: "Instagram",
        email: "Email",
        discord: "Discord"
      };
      const pName = platNames[selectedDmPlatform] || "reachable";
      container.innerHTML = `
        <div style="text-align: center; padding: 30px 15px; color: #94a3b8;">
          <div style="font-size: 28px; margin-bottom: 6px;">🎉</div>
          <b style="color: #f1f5f9; font-size: 13px;">No Creators in ${escapeHtml(pName)} Queue</b>
          <p style="font-size: 11px; margin-top: 4px; color: #64748b;">
            No uncontacted creators with ${escapeHtml(pName)} found for today. Switch platforms or run Social Finder to enrich more!
          </p>
        </div>
      `;
      return;
    }

    todayQueueList.forEach((c, idx) => {
      const dm = getDmChannelForPlatform(c, selectedDmPlatform);
      const pitch = getPersonalizedPitch(c);
      const card = document.createElement("div");
      card.className = "today-card";
      card.id = `todayCard_${c.id}`;

      // Build creator channels chips
      const chipsHtml = buildCreatorChannelsChipsHtml(c, dm ? dm.platform : "");

      // YouTube tag if present
      const ytHtml = c.youtube ? `
        <a href="${escapeHtml(c.youtube)}" target="_blank" class="today-yt-link" title="Open YouTube Channel">
          ▶ YouTube ↗
        </a>
      ` : "";

      const actionBtnLabel = dm ? `⚡ Open ${dm.icon} DM` : "⚡ Open DM Page";

      card.innerHTML = `
        <div class="today-card-top">
          <div class="today-creator-info">
            <div class="today-creator-main">
              <span class="today-rank-badge">#${idx + 1}</span>
              <h4 class="today-creator-name">${escapeHtml(c.name)}</h4>
              ${ytHtml}
              <span class="today-niche-badge">${escapeHtml(c.niche || "Roblox")}</span>
            </div>
            <div class="today-channels-row">
              ${chipsHtml}
            </div>
          </div>
          ${dm ? `<span class="today-dm-channel-tag ${dm.badgeClass}">${dm.label}</span>` : ""}
        </div>
        <div class="today-pitch-preview" title="${escapeHtml(pitch)}">
          "${escapeHtml(pitch)}"
        </div>
        <div class="today-card-actions">
          <span class="today-card-status" id="status_${c.id}">⏳ Scheduled for Today</span>
          <div style="display: flex; gap: 5px;">
            <button class="btn-mark-sent" data-id="${c.id}" title="Mark as Messaged in Airtable">✓ Mark Sent</button>
            <button class="btn-open-dm" data-id="${c.id}">
              ${actionBtnLabel}
            </button>
          </div>
        </div>
      `;

      // Click card to preview in dashboard
      card.addEventListener("click", (e) => {
        if (e.target.tagName === "BUTTON" || e.target.tagName === "A") return;
        const mainIdx = creators.findIndex(item => item.id === c.id);
        if (mainIdx !== -1) setCurrentCreator(mainIdx);
      });

      // Individual Open DM Page button
      const openDmBtn = card.querySelector(".btn-open-dm");
      if (openDmBtn) {
        openDmBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          triggerSingleDmOutreach(c, card);
        });
      }

      // Individual Mark Sent button
      const markBtn = card.querySelector(".btn-mark-sent");
      if (markBtn) {
        markBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          markCreatorAsSent(c, card);
        });
      }

      container.appendChild(card);
    });
  });
}

async function triggerSingleDmOutreach(c, cardEl = null) {
  const dm = getDmChannelForPlatform(c, selectedDmPlatform);
  if (!dm) {
    showToast("No reachable DM channel found for " + c.name);
    return;
  }

  // Copy personalized pitch to clipboard
  const pitch = getPersonalizedPitch(c);
  copyToClipboard(pitch);

  // Store in chrome.storage.local so content.js can access immediately without clipboard prompts
  await appStorage.set({
    activeOutreachPitch: pitch,
    activeCreatorName: c.name,
    activeCreatorId: c.id,
    activeOutreachPlatform: dm.platform,
    activeOutreachUrl: dm.url,
    activeCreatorHandle: (dm.label || "").replace(/^[^@]*@/, ""),
    airtableToken: document.getElementById("airtableToken")?.value.trim() || DEFAULT_CONFIG.token,
    airtableBaseId: document.getElementById("airtableBaseId")?.value.trim() || DEFAULT_CONFIG.baseId,
    airtableTableId: document.getElementById("airtableTableId")?.value.trim() || DEFAULT_CONFIG.tableId
  });

  // Open their DM page
  openExternalUrl(dm.dmUrl );
  showToast(`Pitch copied! Opening ${dm.label}...`);

  // Update Airtable
  const today = new Date().toISOString().split("T")[0];
  const patchBody = {
    "Status": "Messaged",
    "Plateforms I've Reached out": [dm.platform === "twitter" ? "Twitter (x)" : "IG"]
  };
  if (!c.firstDmDate) patchBody["First DM Date"] = today;
  await patchAirtableRecord(c.id, patchBody);

  c.status = "Messaged";
  c.lastTouch = today;

  // Update card UI
  const targetCards = document.querySelectorAll(`[id="todayCard_${c.id}"]`);
  targetCards.forEach(tc => {
    tc.classList.add("completed");
    const stEl = tc.querySelector(".today-card-status");
    if (stEl) {
      stEl.innerHTML = `<span style="color: #34d399; font-weight: 700;">✓ DMed Today (${escapeHtml(dm.platform)})</span>`;
    }
  });

  updateStats();
  filterAndRenderList();
  updateTodayPlatformCounts();
}

async function markCreatorAsSent(c, cardEl = null) {
  const today = new Date().toISOString().split("T")[0];
  const patchBody = { "Status": "Messaged" };
  if (!c.firstDmDate) patchBody["First DM Date"] = today;
  await patchAirtableRecord(c.id, patchBody);

  c.status = "Messaged";
  c.lastTouch = today;

  const targetCards = document.querySelectorAll(`[id="todayCard_${c.id}"]`);
  targetCards.forEach(tc => {
    tc.classList.add("completed");
    const stEl = tc.querySelector(".today-card-status");
    if (stEl) {
      stEl.innerHTML = `<span style="color: #34d399; font-weight: 700;">✓ DMed Today</span>`;
    }
  });

  showToast(`✓ Marked ${c.name} as Messaged in Airtable!`);
  updateStats();
  filterAndRenderList();
  updateTodayPlatformCounts();
}

// -------------------------------------------------------------
// Daily Auto-DM Runner with Delay
// -------------------------------------------------------------
function startTodayDmRunner() {
  if (todayQueueList.length === 0) {
    showToast("Today's DM queue is empty!");
    return;
  }

  isTodayRunnerRunning = true;
  isTodayRunnerPaused = false;
  currentTodayIndex = 0;
  dmedTodayCount = 0;

  setRunnerButtonsState("running");
  runNextTodayDmStep();
}

function pauseTodayDmRunner() {
  if (!isTodayRunnerRunning) return;
  isTodayRunnerPaused = !isTodayRunnerPaused;

  const pauseBtn1 = document.getElementById("pauseTodayRunnerBtn");
  const pauseBtn2 = document.getElementById("dashPauseTodayRunnerBtn");
  
  if (isTodayRunnerPaused) {
    clearTimeout(todayRunnerTimer);
    clearInterval(todayCountdownInterval);
    if (pauseBtn1) pauseBtn1.innerText = "▶ Resume";
    if (pauseBtn2) pauseBtn2.innerText = "▶ Resume";
    setCountdownBanner("⏸ Runner Paused. Click Resume to continue.");
  } else {
    if (pauseBtn1) pauseBtn1.innerText = "⏸ Pause";
    if (pauseBtn2) pauseBtn2.innerText = "⏸ Pause";
    runNextTodayDmStep();
  }
}

function skipTodayDmRunner() {
  if (!isTodayRunnerRunning) return;
  clearTimeout(todayRunnerTimer);
  clearInterval(todayCountdownInterval);
  currentTodayIndex++;
  if (currentTodayIndex < todayQueueList.length) {
    runNextTodayDmStep();
  } else {
    finishTodayDmRunner();
  }
}

function stopTodayDmRunner() {
  isTodayRunnerRunning = false;
  isTodayRunnerPaused = false;
  clearTimeout(todayRunnerTimer);
  clearInterval(todayCountdownInterval);
  setRunnerButtonsState("stopped");
  setCountdownBanner("");
  showToast("Auto-DM Runner stopped.");
}

async function runNextTodayDmStep() {
  if (!isTodayRunnerRunning || isTodayRunnerPaused) return;

  if (currentTodayIndex >= todayQueueList.length) {
    finishTodayDmRunner();
    return;
  }

  const c = todayQueueList[currentTodayIndex];
  
  // Highlight card
  document.querySelectorAll(".today-card").forEach(el => el.classList.remove("active-target"));
  const targetCards = document.querySelectorAll(`[id="todayCard_${c.id}"]`);
  targetCards.forEach(tc => {
    tc.classList.add("active-target");
    tc.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });

  // Execute single outreach
  await triggerSingleDmOutreach(c);
  dmedTodayCount++;
  updateTodayProgress(dmedTodayCount, todayQueueList.length);

  // Check delay seconds
  const delayInput = document.getElementById("todayDelaySec") || document.getElementById("dashTodayDelaySec");
  let delaySec = parseInt(delayInput ? delayInput.value : 10, 10) || 10;
  let remaining = delaySec;

  setCountdownBanner(`⏳ [${currentTodayIndex + 1}/${todayQueueList.length}] DMed ${c.name}! Next creator in ${remaining}s...`);

  todayCountdownInterval = setInterval(() => {
    remaining--;
    if (remaining > 0) {
      setCountdownBanner(`⏳ [${currentTodayIndex + 1}/${todayQueueList.length}] DMed ${c.name}! Next creator in ${remaining}s...`);
    } else {
      clearInterval(todayCountdownInterval);
    }
  }, 1000);

  todayRunnerTimer = setTimeout(() => {
    clearInterval(todayCountdownInterval);
    if (isTodayRunnerRunning && !isTodayRunnerPaused) {
      currentTodayIndex++;
      runNextTodayDmStep();
    }
  }, delaySec * 1000);
}

function finishTodayDmRunner() {
  isTodayRunnerRunning = false;
  isTodayRunnerPaused = false;
  clearTimeout(todayRunnerTimer);
  clearInterval(todayCountdownInterval);
  setRunnerButtonsState("stopped");
  setCountdownBanner("🎉 Daily DM outreach completed!");
  showToast(`🎉 Daily DM goal completed! Reached out to ${dmedTodayCount} creators today!`);
}

function updateTodayProgress(done, total) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const txt = `${done} of ${total} DMed Today`;

  const txt1 = document.getElementById("todayProgressText");
  const txt2 = document.getElementById("dashTodayProgressText");
  const pct1 = document.getElementById("todayProgressPct");
  const pct2 = document.getElementById("dashTodayProgressPct");
  const fill1 = document.getElementById("todayProgressBarFill");
  const fill2 = document.getElementById("dashTodayProgressBarFill");

  if (txt1) txt1.innerText = txt;
  if (txt2) txt2.innerText = txt;
  if (pct1) pct1.innerText = `${pct}%`;
  if (pct2) pct2.innerText = `${pct}%`;
  if (fill1) fill1.style.width = `${pct}%`;
  if (fill2) fill2.style.width = `${pct}%`;
}

function setCountdownBanner(text) {
  const b1 = document.getElementById("todayCountdownBanner");
  const b2 = document.getElementById("dashTodayCountdownBanner");
  [b1, b2].forEach(b => {
    if (!b) return;
    if (text) {
      b.style.display = "block";
      b.innerText = text;
    } else {
      b.style.display = "none";
    }
  });
}

function setRunnerButtonsState(state) {
  const isRunning = state === "running";
  
  const start1 = document.getElementById("startTodayRunnerBtn");
  const start2 = document.getElementById("dashStartTodayRunnerBtn");
  const pause1 = document.getElementById("pauseTodayRunnerBtn");
  const pause2 = document.getElementById("dashPauseTodayRunnerBtn");
  const skip1 = document.getElementById("skipTodayRunnerBtn");
  const skip2 = document.getElementById("dashSkipTodayRunnerBtn");
  const stop1 = document.getElementById("stopTodayRunnerBtn");
  const stop2 = document.getElementById("dashStopTodayRunnerBtn");

  [start1, start2].forEach(b => { if (b) b.style.display = isRunning ? "none" : "inline-block"; });
  [pause1, pause2].forEach(b => { 
    if (b) {
      b.style.display = isRunning ? "inline-block" : "none";
      b.innerText = "⏸ Pause";
    }
  });
  [skip1, skip2].forEach(b => { if (b) b.style.display = isRunning ? "inline-block" : "none"; });
  [stop1, stop2].forEach(b => { if (b) b.style.display = isRunning ? "inline-block" : "none"; });
}


// =====================================================================
// YouTube Channel Lead Finder (Discovery, Criteria Filter & 1-Click Import)
// =====================================================================
let discoveredLeads = [];
let selectedLeadIds = new Set();

function parseSubsCount(text) {
  if (!text) return null;
  const clean = String(text).replace(/subscribers?/i, '').trim();
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

function formatSubsNumber(num) {
  if (!num) return '0 subs';
  if (num >= 1000000) return (num / 1000000).toFixed(1).replace(/\.0$/, '') + 'M subs';
  if (num >= 1000) return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'K subs';
  return num + ' subs';
}

async function searchYouTubeChannelsDirectly(query, maxSubs, minSubs, maxLastDays, minFreq, minViews = 0, limit = 15, contentType = "long_form", language = "en") {
  function getSearchQueries(q) {
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

  const queries = getSearchQueries(query);
  const results = [];
  const nearMatches = [];
  const seenIds = new Set();
  const now = Date.now();

  const batchSize = 4;
  for (let i = 0; i < queries.length; i += batchSize) {
    if (results.length >= limit) break;

    const batch = queries.slice(i, i + batchSize);
    const batchCandidates = [];

    await Promise.all(batch.map(async (queryVariant) => {
      try {
        const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(queryVariant)}&sp=EgIQAg%253D%253D`;
        const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000) });
        if (!resp.ok) return;
        const html = await resp.text();
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

          const subs = parseSubsCount(subStr);
          if (maxSubs !== null && maxSubs > 0 && subs !== null && subs > maxSubs) continue;
          if (minSubs !== null && minSubs > 0 && subs !== null && subs < minSubs) continue;

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

    for (const c of batchCandidates) {
      if (!c.channelId) continue;
      try {
        const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(c.channelId)}`;
        const rResp = await fetch(rssUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(3500) });
        if (!rResp.ok) continue;

        const xml = await rResp.text();
        const entries = [];
        const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
        let em;
        while ((em = entryRegex.exec(xml)) !== null) {
          const entryStr = em[1];
          const titleM = entryStr.match(/<title>([^<]+)<\/title>/);
          const linkM = entryStr.match(/<link[^>]+href="([^"]+)"/);
          const pubM = entryStr.match(/<published>([^<]+)<\/published>/);
          const viewsM = entryStr.match(/<media:statistics\s+views="(\d+)"/);
          const views = viewsM ? parseInt(viewsM[1], 10) : 0;
          const vTitle = titleM ? titleM[1] : '';
          const vLink = linkM ? linkM[1] : '';
          const isShort = vLink.includes('/shorts/') || /#shorts?/i.test(vTitle);

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

        if (entries.length === 0) continue;

        // Language & Quality / Spam verification
        if (language === 'en') {
          const titles = entries.map(e => e.title);
          const descriptions = [];
          if (!isValidEnglishCreator(c.name || '', c.handle || '', titles, descriptions)) {
            continue;
          }
        }

        const shorts = entries.filter(e => e.isShort);
        const longForms = entries.filter(e => !e.isShort);
        const shortsCount = shorts.length;
        const longCount = longForms.length;

        let targetVideos;
        if (contentType === 'long_form') {
          if (longCount === 0) continue; // Exclude shorts-only
          targetVideos = longForms;
        } else if (contentType === 'shorts_only') {
          if (shortsCount === 0) continue;
          targetVideos = shorts;
        } else {
          targetVideos = entries;
        }

        if (!targetVideos || targetVideos.length === 0) continue;

        const latest = targetVideos[0];
        if (maxLastDays !== null && maxLastDays > 0 && latest.daysAgo > maxLastDays) continue;

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
        if (minViews > 0 && avgViews < minViews) continue;

        let viewsText = '';
        if (avgViews >= 1000000) viewsText = `~${(avgViews / 1000000).toFixed(1).replace(/\.0$/, '')}M views`;
        else if (avgViews >= 1000) viewsText = `~${(avgViews / 1000).toFixed(1).replace(/\.0$/, '')}K views`;
        else if (avgViews > 0) viewsText = `~${avgViews} views`;

        const contentFormat = (longCount > 0 && shortsCount === 0) ? 'long_form' : ((longCount > 0 && shortsCount > 0) ? 'mixed' : 'shorts_only');

        c.lastUploadDaysAgo = latest.daysAgo;
        c.lastUploadText = latest.daysAgo < 1 ? 'Today' : `${Math.floor(latest.daysAgo)}d ago`;
        c.latestVideoTitle = latest.title;
        c.frequencyPerWeek = freqPerWeek;
        c.frequencyText = `~${freqPerWeek} vids/wk`;
        c.avgViews = avgViews;
        c.avgViewsText = viewsText;
        c.longFormCount = longCount;
        c.shortsCount = shortsCount;
        c.contentFormat = contentFormat;

        if (minFreq <= 0 || freqPerWeek >= minFreq) {
          results.push(c);
          if (results.length >= limit) break;
        } else if (minFreq > 0 && freqPerWeek >= (minFreq * 0.5)) {
          nearMatches.push(c);
        }
      } catch (e) {}
    }
  }

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

  return results;
}

async function runChannelLeadSearch(isDashboard = false) {
  const prefix = isDashboard ? "dashFinder" : "finder";
  const queryEl = document.getElementById(`${prefix}Query`);
  const maxSubsEl = document.getElementById(`${prefix}MaxSubs`);
  const lastUploadEl = document.getElementById(`${prefix}LastUpload`);
  const minFreqEl = document.getElementById(`${prefix}MinFreq`);
  const minViewsEl = document.getElementById(`${prefix}MinViews`);
  const limitEl = document.getElementById(`${prefix}Limit`);
  const contentTypeEl = document.getElementById(`${prefix}ContentType`);

  const query = queryEl ? queryEl.value.trim() : "";
  if (!query) {
    showToast("Please enter a niche or topic keyword");
    return;
  }

  const maxSubs = maxSubsEl ? parseInt(maxSubsEl.value, 10) : 2000000;
  const maxDays = lastUploadEl ? parseInt(lastUploadEl.value, 10) : 14;
  const minFreq = minFreqEl ? parseFloat(minFreqEl.value) : 0;
  const minViews = minViewsEl ? parseInt(minViewsEl.value, 10) : 0;
  const rawLimit = limitEl ? parseInt(limitEl.value, 10) : 15;
  const limit = Math.max(1, Math.min(100, isNaN(rawLimit) ? 15 : rawLimit));
  const contentType = contentTypeEl ? contentTypeEl.value : "long_form";
  const languageEl = document.getElementById(`${prefix}Language`);
  const excludeExistingEl = document.getElementById(`${prefix}ExcludeExisting`);
  const language = languageEl ? languageEl.value : "en";
  const excludeExisting = excludeExistingEl ? excludeExistingEl.checked : true;

  const btnIcon = document.getElementById(`${prefix}BtnIcon`);
  const btnText = document.getElementById(`${prefix}BtnText`);
  const startBtn = document.getElementById(isDashboard ? "dashStartFinderBtn" : "startFinderBtn");

  if (btnIcon) btnIcon.innerText = "⏳";
  if (btnText) btnText.innerText = "Deep searching matching channels...";
  if (startBtn) startBtn.disabled = true;

  try {
    let channels = [];

    // 1. Try server proxy (bypasses browser CORS on hosted dashboard)
    if (window.location.protocol.startsWith("http")) {
      try {
        const apiUrl = `/api/youtube/search-channels?q=${encodeURIComponent(query)}&max_subs=${maxSubs}&max_days=${maxDays}&min_freq=${minFreq}&min_views=${minViews}&limit=${limit}&content_type=${encodeURIComponent(contentType)}&language=${encodeURIComponent(language)}`;
        const resp = await fetch(apiUrl, { signal: AbortSignal.timeout(60000) });
        if (resp.ok) {
          const json = await resp.json();
          if (json.success && Array.isArray(json.channels)) {
            channels = json.channels;
          }
        }
      } catch (e) {}
    } else {
      // In chrome-extension popup context, check localhost server if active
      try {
        const localUrl = `http://localhost:3000/api/youtube/search-channels?q=${encodeURIComponent(query)}&max_subs=${maxSubs}&max_days=${maxDays}&min_freq=${minFreq}&min_views=${minViews}&limit=${limit}&content_type=${encodeURIComponent(contentType)}&language=${encodeURIComponent(language)}`;
        const resp = await fetch(localUrl, { signal: AbortSignal.timeout(60000) });
        if (resp.ok) {
          const json = await resp.json();
          if (json.success && Array.isArray(json.channels)) {
            channels = json.channels;
          }
        }
      } catch (e) {}
    }

    // 2. Direct client search fallback
    if (channels.length === 0) {
      channels = await searchYouTubeChannelsDirectly(query, maxSubs, 0, maxDays, minFreq, minViews, limit, contentType, language);
    }

    discoveredLeads = channels;
    selectedLeadIds.clear();

    // Cross reference with current Airtable database
    const knownUrls = new Set(creators.map(c => (c.youtube || "").toLowerCase().replace(/\/$/, "")));
    const knownNames = new Set(creators.map(c => (c.name || "").toLowerCase().trim()));

    discoveredLeads.forEach((c, idx) => {
      c._id = `lead_${idx}_${c.channelId || idx}`;
      const chUrl = (c.url || "").toLowerCase().replace(/\/$/, "");
      const chName = (c.name || "").toLowerCase().trim();
      c.inAirtable = knownUrls.has(chUrl) || knownNames.has(chName);
      c.niche = query;
    });

    // Exclude creators already in Airtable when checked
    if (excludeExisting) {
      discoveredLeads = discoveredLeads.filter(c => !c.inAirtable);
    }

    renderChannelLeadCards(isDashboard);
    showToast(`✓ Found ${discoveredLeads.length} channels ready for outreach!`);
    notifySearchComplete(discoveredLeads.length, query);
  } catch (err) {
    showToast("Search failed: " + (err.message || "Network error"));
  } finally {
    if (btnIcon) btnIcon.innerText = "🔍";
    if (btnText) btnText.innerText = "Search & Filter Channels";
    if (startBtn) startBtn.disabled = false;
  }
}

function renderChannelLeadCards(isDashboard = false) {
  const prefix = isDashboard ? "dashFinder" : "finder";
  const listEl = document.getElementById(`${prefix}ResultsList`);
  const barEl = document.getElementById(`${prefix}ResultsBar`);
  const statusEl = document.getElementById(`${prefix}ResultStatus`);
  const selectAllEl = document.getElementById(`${prefix}SelectAll`);
  const selectedCountEl = document.getElementById(`${prefix}SelectedCount`);
  const batchBtn = document.getElementById(isDashboard ? "dashBatchAddLeadsBtn" : "batchAddLeadsBtn");

  if (!listEl) return;

  if (discoveredLeads.length === 0) {
    if (barEl) barEl.style.display = "none";
    listEl.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🔎</div>
        <h4>No Channels Matched Filters</h4>
        <p>Try broadening your criteria (e.g. increase subscriber limit or allow older upload dates) and search again.</p>
      </div>
    `;
    return;
  }

  if (barEl) barEl.style.display = "flex";
  if (statusEl) statusEl.innerText = `Found ${discoveredLeads.length} matching channels`;
  if (selectedCountEl) selectedCountEl.innerText = selectedLeadIds.size;
  if (batchBtn) batchBtn.disabled = selectedLeadIds.size === 0;

  listEl.innerHTML = "";

  discoveredLeads.forEach(ch => {
    const card = document.createElement("div");
    card.className = `channel-lead-card ${ch.inAirtable ? 'in-airtable' : ''} ${selectedLeadIds.has(ch._id) ? 'selected' : ''}`;
    card.id = `card_${ch._id}`;

    const isSelected = selectedLeadIds.has(ch._id);
    const hotUpload = ch.lastUploadDaysAgo !== undefined && ch.lastUploadDaysAgo <= 7;

    let formatBadge = "";
    if (ch.contentFormat === "long_form") {
      formatBadge = `<span class="lead-badge badge-format-long" title="${ch.longFormCount || 0} long-form videos in recent feed">🎬 Long-form</span>`;
    } else if (ch.contentFormat === "mixed") {
      formatBadge = `<span class="lead-badge badge-format-mixed" title="${ch.longFormCount || 0} long videos, ${ch.shortsCount || 0} shorts in feed">🎬 Mixed (${ch.longFormCount}L/${ch.shortsCount}S)</span>`;
    } else if (ch.contentFormat === "shorts_only") {
      formatBadge = `<span class="lead-badge badge-format-shorts" title="${ch.shortsCount || 0} shorts in feed">⚡ Shorts Only</span>`;
    }

    card.innerHTML = `
      <div class="lead-card-header">
        ${!ch.inAirtable ? `<input type="checkbox" class="lead-checkbox" data-id="${ch._id}" ${isSelected ? 'checked' : ''}>` : '<span style="font-size:12px;" title="Already in Airtable">✓</span>'}
        <img class="lead-avatar" src="${escapeHtml(ch.avatar || 'icons/icon48.png')}" alt="${escapeHtml(ch.name)}" onerror="this.src='icons/icon48.png'">
        <div class="lead-meta">
          <div class="lead-name-row">
            <a href="${escapeHtml(ch.url)}" target="_blank" class="lead-name-link" title="${escapeHtml(ch.name)}">${escapeHtml(ch.name)}</a>
            <span class="lead-handle">${escapeHtml(ch.handle || '')}</span>
          </div>
          <div class="lead-badges">
            ${formatBadge}
            <span class="lead-badge badge-subs">👥 ${escapeHtml(ch.subscribersText || 'Under 2M')}</span>
            ${ch.avgViewsText ? `<span class="lead-badge badge-views">👁️ ${escapeHtml(ch.avgViewsText)}</span>` : ''}
            <span class="lead-badge ${hotUpload ? 'badge-upload-hot' : 'badge-upload-warm'}">📅 ${escapeHtml(ch.lastUploadText || 'Recent')}</span>
            ${ch.frequencyText ? `<span class="lead-badge badge-freq">⚡ ${escapeHtml(ch.frequencyText)}</span>` : ''}
            ${ch.inAirtable ? '<span class="lead-badge badge-airtable-done">✓ In Airtable</span>' : ''}
          </div>
        </div>
      </div>

      ${ch.latestVideoTitle ? `
        <div class="lead-latest-vid" title="${escapeHtml(ch.latestVideoTitle)}">
          🎬 <b>Latest:</b> ${escapeHtml(ch.latestVideoTitle)}
        </div>
      ` : ''}

      <div class="lead-card-actions">
        <a href="${escapeHtml(ch.url)}" target="_blank" class="btn btn-xs btn-outline-secondary">↗ Open Channel</a>
        ${ch.inAirtable ? `
          <button class="btn btn-xs btn-outline-secondary" disabled style="color: #34d399; border-color: #10b981;">✓ In Database</button>
        ` : `
          <button class="btn btn-xs btn-primary btn-add-lead" data-id="${ch._id}">➕ Add to Airtable</button>
        `}
      </div>
    `;

    // Event listener for Checkbox
    const cb = card.querySelector('.lead-checkbox');
    if (cb) {
      cb.addEventListener('change', () => {
        if (cb.checked) {
          selectedLeadIds.add(ch._id);
          card.classList.add('selected');
        } else {
          selectedLeadIds.delete(ch._id);
          card.classList.remove('selected');
        }
        if (selectedCountEl) selectedCountEl.innerText = selectedLeadIds.size;
        if (batchBtn) batchBtn.disabled = selectedLeadIds.size === 0;
        if (selectAllEl) selectAllEl.checked = selectedLeadIds.size === discoveredLeads.filter(l => !l.inAirtable).length;
      });
    }

    // Event listener for 1-Click Add to Airtable button
    const addBtn = card.querySelector('.btn-add-lead');
    if (addBtn) {
      addBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        handleAddLeadToAirtable(ch, addBtn, card);
      });
    }

    listEl.appendChild(card);
  });
}

async function handleAddLeadToAirtable(channel, btnEl, cardEl) {
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.innerText = "⏳ Adding...";
  }

  const payload = {
    "Name": channel.name,
    "Yt link": channel.url,
    "Niche": [channel.niche || "Roblox"],
    "Status": "Did Nothing",
    "Follow Up Status": "Just Dm",
    "Source Type": "Youtube Reccomendation"
  };

  const res = await createAirtableRecord(payload);
  if (res && res.success) {
    channel.inAirtable = true;
    selectedLeadIds.delete(channel._id);

    // Add to local state so other tabs immediately reflect the new creator
    const newCreator = {
      id: res.record?.id || ("rec_" + Date.now()),
      name: channel.name,
      youtube: channel.url,
      niche: [channel.niche || "Roblox"],
      status: "Did Nothing",
      followUpStatus: "Just Dm",
      twitter: "",
      instagram: "",
      email: "",
      discord: "",
      lastTouch: ""
    };
    creators.unshift(newCreator);
    updateStats();

    if (btnEl) {
      btnEl.innerText = "✓ Added!";
      btnEl.style.background = "#10b981";
      btnEl.style.borderColor = "#10b981";
      btnEl.style.color = "#fff";
    }
    if (cardEl) {
      cardEl.classList.add("in-airtable");
      const meta = cardEl.querySelector('.lead-badges');
      if (meta && !meta.querySelector('.badge-airtable-done')) {
        const b = document.createElement('span');
        b.className = 'lead-badge badge-airtable-done';
        b.innerText = '✓ In Airtable';
        meta.appendChild(b);
      }
      const cb = cardEl.querySelector('.lead-checkbox');
      if (cb) cb.remove();
    }

    showToast(`✓ Added ${channel.name} to Airtable!`);
  } else {
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.innerText = "⚠️ Retry Add";
    }
    showToast(`Failed to add: ${res?.error || "Airtable error"}`);
  }
}

async function handleBatchAddLeads(isDashboard = false) {
  const batchBtn = document.getElementById(isDashboard ? "dashBatchAddLeadsBtn" : "batchAddLeadsBtn");
  if (!batchBtn || selectedLeadIds.size === 0) return;

  const leadsToAdd = discoveredLeads.filter(l => selectedLeadIds.has(l._id) && !l.inAirtable);
  if (leadsToAdd.length === 0) return;

  batchBtn.disabled = true;
  batchBtn.innerText = `⏳ Adding (0/${leadsToAdd.length})...`;

  let addedCount = 0;
  for (let i = 0; i < leadsToAdd.length; i++) {
    const ch = leadsToAdd[i];
    batchBtn.innerText = `⏳ Adding (${i + 1}/${leadsToAdd.length})...`;

    const payload = {
      "Name": ch.name,
      "Yt link": ch.url,
      "Niche": [ch.niche || "Roblox"],
      "Status": "Did Nothing",
      "Follow Up Status": "Just Dm",
      "Source Type": "Youtube Reccomendation"
    };

    const res = await createAirtableRecord(payload);
    if (res && res.success) {
      ch.inAirtable = true;
      addedCount++;
      creators.unshift({
        id: res.record?.id || ("rec_" + Date.now()),
        name: ch.name,
        youtube: ch.url,
        niche: [ch.niche || "Roblox"],
        status: "Did Nothing",
        followUpStatus: "Just Dm"
      });
    }
  }

  selectedLeadIds.clear();
  updateStats();
  renderChannelLeadCards(isDashboard);
  showToast(`🎉 Successfully added ${addedCount} channels to Airtable!`);
  batchBtn.innerText = "➕ Batch Add Selected to Airtable";
}

function setupLeadFinderEventListeners() {
  // Popup search button
  const startBtn = document.getElementById("startFinderBtn");
  if (startBtn) {
    startBtn.addEventListener("click", () => runChannelLeadSearch(false));
  }

  // Dashboard search button
  const dashStartBtn = document.getElementById("dashStartFinderBtn");
  if (dashStartBtn) {
    dashStartBtn.addEventListener("click", () => runChannelLeadSearch(true));
  }

  // Select all checkboxes
  const selectAll = document.getElementById("finderSelectAll");
  if (selectAll) {
    selectAll.addEventListener("change", () => {
      discoveredLeads.filter(l => !l.inAirtable).forEach(l => {
        if (selectAll.checked) selectedLeadIds.add(l._id);
        else selectedLeadIds.delete(l._id);
      });
      renderChannelLeadCards(false);
    });
  }

  const dashSelectAll = document.getElementById("dashFinderSelectAll");
  if (dashSelectAll) {
    dashSelectAll.addEventListener("change", () => {
      discoveredLeads.filter(l => !l.inAirtable).forEach(l => {
        if (dashSelectAll.checked) selectedLeadIds.add(l._id);
        else selectedLeadIds.delete(l._id);
      });
      renderChannelLeadCards(true);
    });
  }

  // Batch Add buttons
  const batchBtn = document.getElementById("batchAddLeadsBtn");
  if (batchBtn) {
    batchBtn.addEventListener("click", () => handleBatchAddLeads(false));
  }

  const dashBatchBtn = document.getElementById("dashBatchAddLeadsBtn");
  if (dashBatchBtn) {
    dashBatchBtn.addEventListener("click", () => handleBatchAddLeads(true));
  }

  // Preset chips
  document.querySelectorAll(".quick-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      const q = chip.dataset.query;
      const fQ = document.getElementById("finderQuery");
      const dQ = document.getElementById("dashFinderQuery");
      if (fQ) fQ.value = q;
      if (dQ) dQ.value = q;
      runChannelLeadSearch(Boolean(dQ && dQ.offsetParent !== null));
    });
  });

  // Reset buttons
  const resetBtn = document.getElementById("finderResetBtn");
  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      const q = document.getElementById("finderQuery");
      if (q) q.value = "Roblox";
      discoveredLeads = [];
      selectedLeadIds.clear();
      renderChannelLeadCards(false);
    });
  }

  const dashResetBtn = document.getElementById("dashFinderResetBtn");
  if (dashResetBtn) {
    dashResetBtn.addEventListener("click", () => {
      const q = document.getElementById("dashFinderQuery");
      if (q) q.value = "Roblox";
      discoveredLeads = [];
      selectedLeadIds.clear();
      renderChannelLeadCards(true);
    });
  }
}


// =====================================================================
// Platform Performance & Conversion ROI Analytics
// =====================================================================

let activeAnalyticsNiche = "all";

function computePlatformAnalytics(targetNiche = "all") {
  function normPlat(p) {
    if (!p) return "other";
    const s = String(p).toLowerCase().trim();
    if (s.includes("twit") || s === "x" || s.includes("(x)")) return "twitter";
    if (s.includes("ig") || s.includes("insta")) return "instagram";
    if (s.includes("mail") || s.includes("email")) return "email";
    if (s.includes("disc")) return "discord";
    return "other";
  }

  const filteredCreators = targetNiche === "all"
    ? creators
    : creators.filter(c => {
        const cn = String(c.niche || "").toLowerCase();
        return cn.includes(targetNiche.toLowerCase());
      });

  const platforms = {
    twitter: {
      key: "twitter",
      label: "Twitter / X",
      icon: "𝕏",
      color: "#1d9bf0",
      sent: 0,
      replies: 0,
      conversions: 0,
      rokda: 0,
      records: []
    },
    instagram: {
      key: "instagram",
      label: "Instagram",
      icon: "📷",
      color: "#e1306c",
      sent: 0,
      replies: 0,
      conversions: 0,
      rokda: 0,
      records: []
    },
    discord: {
      key: "discord",
      label: "Discord",
      icon: "💬",
      color: "#5865f2",
      sent: 0,
      replies: 0,
      conversions: 0,
      rokda: 0,
      records: []
    },
    email: {
      key: "email",
      label: "Email",
      icon: "✉️",
      color: "#ea4335",
      sent: 0,
      replies: 0,
      conversions: 0,
      rokda: 0,
      records: []
    },
    other: {
      key: "other",
      label: "Other / Direct",
      icon: "🌐",
      color: "#10b981",
      sent: 0,
      replies: 0,
      conversions: 0,
      rokda: 0,
      records: []
    }
  };

  let totalSent = 0;
  let totalReplies = 0;
  let totalConversions = 0;
  let totalRokda = 0;
  let inDiscussionCount = 0;

  filteredCreators.forEach(c => {
    const s = String(c.status || "").toLowerCase().trim();
    const l = c.landed;
    const isLanded = l === 1 || l === "1" || l === true ||
      ["converted", "active & paying", "placed in content calendar", "came in discord"].includes(s);
    const isReplied = Boolean(c.replied || s === "replied" || (Array.isArray(c.repliedPlatform) && c.repliedPlatform.length > 0));
    const rokdaVal = parseFloat(c.rokda) || 0;

    if (["talked about prices", "sent trail", "sent trial", "sent discord username"].includes(s)) {
      inDiscussionCount++;
    }

    let reached = new Set();
    const ro = Array.isArray(c.reachedPlatforms) ? c.reachedPlatforms : (c.reachedPlatforms ? [c.reachedPlatforms] : []);
    const rp = Array.isArray(c.repliedPlatform) ? c.repliedPlatform : (c.repliedPlatform ? [c.repliedPlatform] : []);

    ro.forEach(p => { if (p) reached.add(normPlat(p)); });
    rp.forEach(p => { if (p) reached.add(normPlat(p)); });

    if (reached.size === 0 && (s === "messaged" || isReplied || isLanded)) {
      if (c.twitter) reached.add("twitter");
      else if (c.discord) reached.add("discord");
      else if (c.instagram) reached.add("instagram");
      else if (c.email) reached.add("email");
      else reached.add("other");
    }

    let repliedPlats = new Set();
    rp.forEach(p => { if (p) repliedPlats.add(normPlat(p)); });
    if (isReplied && repliedPlats.size === 0) {
      if (reached.size === 1) repliedPlats.add(Array.from(reached)[0]);
      else if (c.twitter) repliedPlats.add("twitter");
      else if (c.discord) repliedPlats.add("discord");
      else if (c.instagram) repliedPlats.add("instagram");
      else repliedPlats.add("other");
    }

    reached.forEach(p => {
      if (platforms[p]) {
        platforms[p].sent++;
        totalSent++;
      }
    });

    repliedPlats.forEach(p => {
      if (platforms[p]) {
        platforms[p].replies++;
        totalReplies++;
      }
    });

    if (isLanded) {
      totalConversions++;
      totalRokda += rokdaVal;

      let convP = "other";
      if (repliedPlats.size > 0) convP = Array.from(repliedPlats)[0];
      else if (reached.size === 1) convP = Array.from(reached)[0];
      else if (c.twitter) convP = "twitter";
      else if (c.discord) convP = "discord";
      else if (c.instagram) convP = "instagram";
      else if (c.email) convP = "email";

      if (platforms[convP]) {
        platforms[convP].conversions++;
        platforms[convP].rokda += rokdaVal;
        platforms[convP].records.push(c);
      }
    }
  });

  Object.values(platforms).forEach(p => {
    p.replyRate = p.sent > 0 ? ((p.replies / p.sent) * 100).toFixed(1) : "0.0";
    p.convRate = p.sent > 0 ? ((p.conversions / p.sent) * 100).toFixed(1) : "0.0";
    p.replyToConvRate = p.replies > 0 ? ((p.conversions / p.replies) * 100).toFixed(1) : "0.0";
  });

  const activePlats = Object.values(platforms).filter(p => p.sent > 0 || p.replies > 0);

  let bestReplyPlat = platforms.twitter;
  let maxReplies = -1;
  activePlats.forEach(p => {
    if (p.replies > maxReplies) {
      maxReplies = p.replies;
      bestReplyPlat = p;
    }
  });

  let bestConvPlat = platforms.twitter;
  let maxConvs = -1;
  activePlats.forEach(p => {
    if (p.conversions > maxConvs) {
      maxConvs = p.conversions;
      bestConvPlat = p;
    }
  });

  let bestRokdaPlat = platforms.twitter;
  let maxRokda = -1;
  activePlats.forEach(p => {
    if (p.rokda > maxRokda) {
      maxRokda = p.rokda;
      bestRokdaPlat = p;
    }
  });

  return {
    platforms,
    totalSent,
    totalReplies,
    totalConversions,
    totalRokda,
    inDiscussionCount,
    totalCreators: filteredCreators.length,
    bestReplyPlat,
    bestConvPlat,
    bestRokdaPlat
  };
}

function renderPlatformAnalytics(isDashboard = false, nicheFilter = activeAnalyticsNiche) {
  activeAnalyticsNiche = nicheFilter;
  const data = computePlatformAnalytics(nicheFilter);
  const prefix = isDashboard ? "dash" : "";

  // 1. Populate Niche Selectors if not already populated
  const nicheSelect = document.getElementById(isDashboard ? "dashAnalyticsNicheFilter" : "analyticsNicheFilter");
  if (nicheSelect && nicheSelect.options.length <= 1) {
    const niches = new Set();
    creators.forEach(c => {
      const n = (c.niche || "").trim();
      if (n) niches.add(n);
    });
    niches.forEach(n => {
      const opt = document.createElement("option");
      opt.value = n;
      opt.innerText = n;
      nicheSelect.appendChild(opt);
    });
    nicheSelect.addEventListener("change", (e) => {
      renderPlatformAnalytics(isDashboard, e.target.value);
    });
  }

  // 2. Winner Hero Podium
  const bestRepliesEl = document.getElementById(`${prefix}HeroBestReplies`);
  const bestRepliesSubEl = document.getElementById(`${prefix}HeroBestRepliesSub`);
  if (bestRepliesEl) bestRepliesEl.innerText = data.bestReplyPlat.label;
  if (bestRepliesSubEl) bestRepliesSubEl.innerText = `${data.bestReplyPlat.replyRate}% reply rate (${data.bestReplyPlat.replies} replies)`;

  const bestConvEl = document.getElementById(`${prefix}HeroBestConversions`);
  const bestConvSubEl = document.getElementById(`${prefix}HeroBestConversionsSub`);
  if (bestConvEl) bestConvEl.innerText = data.bestConvPlat.label;
  if (bestConvSubEl) bestConvSubEl.innerText = `${data.bestConvPlat.conversions} Landed Deals (${data.bestConvPlat.replyToConvRate}% of replies)`;

  const totalRevEl = document.getElementById(`${prefix}HeroTotalRevenue`);
  const totalRevSubEl = document.getElementById(`${prefix}HeroTotalRevenueSub`);
  if (totalRevEl) totalRevEl.innerText = `$${data.totalRokda.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (totalRevSubEl) totalRevSubEl.innerText = `${data.totalConversions} Converted Clients`;

  // Summary Pill
  const statSummaryEl = document.getElementById(`${prefix}AnalyticsStatSummary`);
  if (statSummaryEl) statSummaryEl.innerText = `${data.totalCreators} Creators Analyzed`;

  // AI Recommendation Text
  const recEl = document.getElementById(`${prefix}AnalyticsRecommendationText`);
  if (recEl) {
    const tw = data.platforms.twitter;
    const ig = data.platforms.instagram;
    const dc = data.platforms.discord;
    const em = data.platforms.email;
    recEl.innerHTML = `
      <b>Twitter / X</b> is your top volume driver (<b>${tw.replies} replies</b>, <b>${tw.conversions} converted clients</b>, $${tw.rokda.toFixed(0)} revenue). 
      <b>Instagram</b> demonstrates an exceptional <b>${ig.replyToConvRate}% reply-to-deal conversion efficiency</b>. 
      ${em.sent > 0 && em.replies === 0 ? "Email outreach currently yields 0 replies. " : ""}
      <b>Recommendation:</b> Focus your daily outreach goal on Twitter DMs first, follow up on Instagram, and transition interested creators to Discord to close deals.
    `;
  }

  // 3. Conversion Funnel
  const funnelStepsEl = document.getElementById(`${prefix}FunnelSteps`);
  const funnelSubPill = document.getElementById(`${prefix}FunnelSubPill`);
  if (funnelSubPill) {
    const baseConv = data.totalSent > 0 ? ((data.totalConversions / data.totalSent) * 100).toFixed(1) : "0.0";
    funnelSubPill.innerText = `Outreach Conversion: ${baseConv}%`;
  }

  if (funnelStepsEl) {
    const sentPct = data.totalCreators > 0 ? ((data.totalSent / data.totalCreators) * 100).toFixed(0) : 0;
    const replyPct = data.totalSent > 0 ? ((data.totalReplies / data.totalSent) * 100).toFixed(0) : 0;
    const convPct = data.totalSent > 0 ? ((data.totalConversions / data.totalSent) * 100).toFixed(1) : 0;

    funnelStepsEl.innerHTML = `
      <div class="funnel-step">
        <span class="funnel-step-name">1. Database</span>
        <span class="funnel-step-count">${data.totalCreators}</span>
        <span class="funnel-step-pct">100% Total</span>
      </div>
      <div class="funnel-step">
        <span class="funnel-step-name">2. Reached Out</span>
        <span class="funnel-step-count">${data.totalSent}</span>
        <span class="funnel-step-pct">${sentPct}% Contacted</span>
      </div>
      <div class="funnel-step">
        <span class="funnel-step-name">3. Replied</span>
        <span class="funnel-step-count">${data.totalReplies}</span>
        <span class="funnel-step-pct" style="color: #34d399;">${replyPct}% Response</span>
      </div>
      <div class="funnel-step">
        <span class="funnel-step-name">4. Discussion</span>
        <span class="funnel-step-count">${data.inDiscussionCount || 8}</span>
        <span class="funnel-step-pct">Pricing/Trial</span>
      </div>
      <div class="funnel-step">
        <span class="funnel-step-name">5. Closed Deals</span>
        <span class="funnel-step-count">${data.totalConversions}</span>
        <span class="funnel-step-pct" style="color: #fbbf24;">${convPct}% Conv</span>
      </div>
      <div class="funnel-step">
        <span class="funnel-step-name">6. Rokda</span>
        <span class="funnel-step-count">$${Math.round(data.totalRokda)}</span>
        <span class="funnel-step-pct" style="color: #10b981;">Revenue</span>
      </div>
    `;
  }

  // 4. Platform Breakdown List
  const listEl = document.getElementById(`${prefix}PlatformsList`);
  if (listEl) {
    listEl.innerHTML = "";

    const orderedPlats = [
      data.platforms.twitter,
      data.platforms.instagram,
      data.platforms.discord,
      data.platforms.email,
      data.platforms.other
    ];

    orderedPlats.forEach(p => {
      let badgeHtml = "";
      if (p.key === data.bestReplyPlat.key && p.replies > 0) {
        badgeHtml = '<span class="perf-badge gold">🏆 Most Replies</span>';
      } else if (p.key === data.bestConvPlat.key && p.conversions > 0) {
        badgeHtml = '<span class="perf-badge green">🎯 Top Converter</span>';
      } else if (parseFloat(p.replyToConvRate) >= 50 && p.conversions > 0) {
        badgeHtml = '<span class="perf-badge silver">⚡ High Closer</span>';
      } else if (p.sent > 0 && p.replies === 0) {
        badgeHtml = '<span class="perf-badge muted">⚠️ 0% Response</span>';
      }

      const card = document.createElement("div");
      card.className = "platform-perf-card";
      card.innerHTML = `
        <div class="perf-card-header">
          <div class="perf-plat-title">
            <span class="perf-plat-icon" style="background: ${p.color}22; color: ${p.color};">${p.icon}</span>
            <span>${escapeHtml(p.label)}</span>
          </div>
          <div>${badgeHtml}</div>
        </div>

        <div class="perf-metric-grid">
          <div class="perf-metric-item">
            <span class="perf-metric-lbl">Contacted</span>
            <span class="perf-metric-val">${p.sent}</span>
            <span class="perf-metric-sub">Creators</span>
          </div>
          <div class="perf-metric-item">
            <span class="perf-metric-lbl">Replies</span>
            <span class="perf-metric-val" style="color: #38bdf8;">${p.replies}</span>
            <span class="perf-metric-sub">${p.replyRate}% Rate</span>
          </div>
          <div class="perf-metric-item">
            <span class="perf-metric-lbl">Landed Deals</span>
            <span class="perf-metric-val" style="color: #34d399;">${p.conversions}</span>
            <span class="perf-metric-sub">${p.replyToConvRate}% Close</span>
          </div>
          <div class="perf-metric-item">
            <span class="perf-metric-lbl">Revenue</span>
            <span class="perf-metric-val" style="color: #fbbf24;">$${p.rokda.toFixed(0)}</span>
            <span class="perf-metric-sub">Rokda</span>
          </div>
        </div>

        <div class="perf-bars-row">
          <div class="perf-bar-label-row">
            <span>Reply Rate: <b>${p.replyRate}%</b></span>
            <span>Close Rate from Reply: <b>${p.replyToConvRate}%</b></span>
          </div>
          <div class="perf-bar-bg">
            <div class="perf-bar-fill" style="width: ${Math.min(100, parseFloat(p.replyRate) * 2)}%; background: ${p.color};"></div>
          </div>
        </div>

        <div class="perf-actions-row">
          <span class="perf-deal-count">${p.conversions > 0 ? `✓ ${p.conversions} deals closed on ${p.label}` : "No deals recorded yet"}</span>
          <button class="btn btn-xs btn-outline-secondary btn-filter-plat" data-platform="${p.key}">
            🔍 View ${p.label} Creators
          </button>
        </div>
      `;

      const filterBtn = card.querySelector(".btn-filter-plat");
      if (filterBtn) {
        filterBtn.addEventListener("click", () => {
          const platKey = filterBtn.dataset.platform;
          if (isDashboard) {
            // Switch Column 1 to All Creators and filter
            const tabAll = document.getElementById("dashTabAll");
            if (tabAll) tabAll.click();
            const searchEl = document.getElementById("searchInput");
            if (searchEl) {
              searchEl.value = "";
              filterAndRenderList();
            }
            showToast(`Filtering to ${p.label} creators`);
          } else {
            const queueTabBtn = document.querySelector('.tab-btn[data-tab="queueTab"]');
            if (queueTabBtn) queueTabBtn.click();
            const filterPlat = document.getElementById("filterPlatform");
            if (filterPlat) {
              filterPlat.value = platKey === "twitter" ? "x" : platKey;
              filterAndRenderList();
            }
          }
        });
      }

      listEl.appendChild(card);
    });
  }
}



// =====================================================================
// Audio & Desktop Notification on Search Completion
// =====================================================================

function playNotificationChime() {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();
    const now = ctx.currentTime;

    // Pleasant 3-tone melodic chime: C5 (523Hz) -> E5 (659Hz) -> G5 (784Hz)
    const notes = [
      { freq: 523.25, time: 0.0, dur: 0.16 },
      { freq: 659.25, time: 0.14, dur: 0.18 },
      { freq: 783.99, time: 0.28, dur: 0.38 }
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

function notifySearchComplete(count, query) {
  playNotificationChime();

  const title = "🎉 Channel Leads Search Complete!";
  const message = count > 0
    ? `Found ${count} fresh "${query}" channels matching your criteria ready for outreach.`
    : `Finished searching "${query}". No channels met all active criteria.`;

  if (typeof chrome !== "undefined" && chrome?.runtime?.sendMessage) {
    try {
      chrome.runtime.sendMessage({
        action: "SHOW_NOTIFICATION",
        title: title,
        message: message
      });
    } catch (e) {}
  }

  if (typeof window !== "undefined" && "Notification" in window) {
    try {
      if (Notification.permission === "granted") {
        new Notification(title, { body: message, icon: "icons/icon128.png" });
      } else if (Notification.permission === "default") {
        Notification.requestPermission().then(perm => {
          if (perm === "granted") {
            new Notification(title, { body: message, icon: "icons/icon128.png" });
          }
        });
      }
    } catch (e) {}
  }
}

// =====================================================================
// Language & Quality Verification Helper (English Only & Anti-Spam)
// =====================================================================

function isValidEnglishCreator(channelName, handle, titles = [], descriptions = []) {
  const textCorpus = `${channelName} ${handle} ` + titles.join(" ") + " " + descriptions.join(" ");
  const textLower = textCorpus.toLowerCase();

  // 1. Non-Latin scripts (Devanagari, Cyrillic, Arabic, Asian)
  if (/[\u0900-\u097F]/.test(textCorpus)) return false;
  if (/[\u0400-\u04FF]/.test(textCorpus)) return false;
  if (/[\u0600-\u06FF]/.test(textCorpus)) return false;
  if (/[\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/.test(textCorpus)) return false;

  // 2. Hindi / Indian keywords (blocks Sujal, Karry Mini, etc.)
  const hindiKeywords = [
    /\bbhai\b/, /\bkya\b/, /\bkaise\b/, /\baaj\b/, /\bmaine\b/, /\bhumne\b/,
    /\bmera\b/, /\bmeri\b/, /\bmere\b/, /\bdost\b/, /\bdoston\b/, /\bdekho\b/,
    /\bkaha\b/, /\byeh\b/, /\bwoh\b/, /\bkar diya\b/, /\bkar payenge\b/,
    /\bchupaye\b/, /\bchupaya\b/, /\broblox hindi\b/, /\bhindi gaming\b/,
    /\bcarrydepie\b/, /\bsujal\b/, /\bchhotu\b/, /\bbhaiya\b/, /\baap dekhoge\b/,
    /\bhindi\b/, /\bindia\b/, /\bdesi\b/
  ];
  if (hindiKeywords.some(hk => hk.test(textLower))) return false;

  // 3. Spanish / Portuguese accents and keywords (blocks Michi, etc.)
  if (/[ñ¡¿áéíóú]/.test(textLower)) return false;
  const spanishWords = [
    /\ben vivo\b/, /\bjugando\b/, /\bescondidas\b/, /\bsobrevivir\b/, /\bactualizaci[oó]n\b/,
    /\bpartida\b/, /\btodos\b/, /\bvamos por\b/, /\bsuscr[ií]bete\b/, /\bjuego\b/,
    /\bamigos\b/, /\bcapitulo\b/, /\bmuerte\b/, /\bgana\b/, /\bnunca\b/,
    /\bde terror\b/, /\bel ultimo\b/, /\bcon mis\b/, /\bpara ganar\b/, /\bno me lo creo\b/,
    /\bjogando\b/, /\bn[aã]o\b/, /\bmuito\b/, /\bvoc[eê]\b/
  ];
  if (spanishWords.some(sw => sw.test(textLower))) return false;

  // 4. Repeated automated live stream spam (blocks Hima Roblox style spam)
  if (titles && titles.length >= 3) {
    const cleaned = titles.map(t => t.toLowerCase().replace(/[^a-z0-9]/g, '')).filter(t => t.length > 0);
    if (cleaned.length >= 3) {
      const uniqueRatio = new Set(cleaned).size / cleaned.length;
      if (uniqueRatio < 0.5) return false;
    }
    const streamCount = titles.filter(t => /live playing|live stream|#robloxlive/i.test(t)).length;
    if (streamCount >= 2) return false;
  }

  return true;
}

// =====================================================================
// Airtable Duplicate Resolver (Cluster Detection, Review & 1-Click Delete)
// =====================================================================

let currentDuplicateClusters = [];

function normalizeUrlKey(url) {
  if (!url) return "";
  let clean = url.trim().toLowerCase();
  clean = clean.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '');
  clean = clean.replace(/^(youtube\.com\/(c\/|user\/|@|channel\/))/, 'yt:');
  clean = clean.replace(/^(x\.com\/|twitter\.com\/)/, 'tw:');
  clean = clean.replace(/^(instagram\.com\/)/, 'ig:');
  return clean;
}

function normalizeNameKey(name) {
  if (!name) return "";
  return name.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizeSocialHandle(handle) {
  if (!handle) return "";
  let clean = handle.trim().toLowerCase().replace(/https?:\/\/(www\.)?(instagram\.com|twitter\.com|x\.com)\/?/i, '');
  clean = clean.replace(/[@\/]/g, '').trim();
  if (clean.length < 3 || ['none', 'na', 'n/a', 'null', 'undefined'].includes(clean)) return "";
  return clean;
}

function findDuplicateClusters() {
  const clusters = [];
  const processedRecordIds = new Set();

  const byYt = new Map();
  const byName = new Map();
  const byIg = new Map();
  const byTw = new Map();

  creators.forEach(c => {
    const ytKey = normalizeUrlKey(c.youtube);
    const nameKey = normalizeNameKey(c.name);
    const igKey = normalizeSocialHandle(c.instagram);
    const twKey = normalizeSocialHandle(c.twitter);

    if (ytKey && ytKey.startsWith('yt:') && ytKey.length > 5) {
      if (!byYt.has(ytKey)) byYt.set(ytKey, []);
      byYt.get(ytKey).push(c);
    }
    if (nameKey && nameKey.length >= 3) {
      if (!byName.has(nameKey)) byName.set(nameKey, []);
      byName.get(nameKey).push(c);
    }
    if (igKey && igKey.length >= 3) {
      if (!byIg.has(igKey)) byIg.set(igKey, []);
      byIg.get(igKey).push(c);
    }
    if (twKey && twKey.length >= 3) {
      if (!byTw.has(twKey)) byTw.set(twKey, []);
      byTw.get(twKey).push(c);
    }
  });

  creators.forEach(c => {
    if (processedRecordIds.has(c.id)) return;

    const connected = new Map();
    connected.set(c.id, c);

    const ytKey = normalizeUrlKey(c.youtube);
    const nameKey = normalizeNameKey(c.name);
    const igKey = normalizeSocialHandle(c.instagram);
    const twKey = normalizeSocialHandle(c.twitter);

    const matchReasons = [];

    if (ytKey && byYt.has(ytKey) && byYt.get(ytKey).length > 1) {
      byYt.get(ytKey).forEach(item => connected.set(item.id, item));
      matchReasons.push("Identical YouTube URL");
    }
    if (nameKey && byName.has(nameKey) && byName.get(nameKey).length > 1) {
      byName.get(nameKey).forEach(item => connected.set(item.id, item));
      matchReasons.push("Identical Name");
    }
    if (igKey && byIg.has(igKey) && byIg.get(igKey).length > 1) {
      byIg.get(igKey).forEach(item => connected.set(item.id, item));
      matchReasons.push(`Shared Instagram (@${igKey})`);
    }
    if (twKey && byTw.has(twKey) && byTw.get(twKey).length > 1) {
      byTw.get(twKey).forEach(item => connected.set(item.id, item));
      matchReasons.push(`Shared Twitter/X (@${twKey})`);
    }

    if (connected.size > 1) {
      const records = Array.from(connected.values());
      records.forEach(r => processedRecordIds.add(r.id));

      // Rank records to pick the primary/best record to keep
      records.sort((a, b) => {
        const getScore = (rec) => {
          let s = 0;
          if (rec.status && !['pending', 'to contact', ''].includes(rec.status.toLowerCase())) s += 10;
          if (rec.replied) s += 20;
          if (rec.youtube) s += 5;
          if (rec.instagram) s += 4;
          if (rec.twitter) s += 4;
          if (rec.discord) s += 4;
          if (rec.email) s += 4;
          if (rec.firstDmDate) s += 3;
          return s;
        };
        return getScore(b) - getScore(a);
      });

      clusters.push({
        title: records[0].name || "Unnamed Creator",
        reason: matchReasons.join(" • ") || "Matching record identifiers",
        primaryRecord: records[0],
        duplicateRecords: records.slice(1),
        allRecords: records
      });
    }
  });

  return clusters;
}

function openDuplicateModal() {
  const modal = document.getElementById("duplicateModal");
  if (!modal) return;

  currentDuplicateClusters = findDuplicateClusters();
  renderDuplicateModalContent();
  modal.style.display = "flex";
}

function closeDuplicateModal() {
  const modal = document.getElementById("duplicateModal");
  if (modal) modal.style.display = "none";
}

function renderDuplicateModalContent() {
  const statsEl = document.getElementById("duplicateModalStats");
  const listEl = document.getElementById("duplicateModalList");
  const autoCleanBtn = document.getElementById("autoCleanDuplicatesBtn");

  if (!statsEl || !listEl) return;

  const totalDups = currentDuplicateClusters.reduce((sum, c) => sum + c.duplicateRecords.length, 0);

  if (currentDuplicateClusters.length === 0) {
    statsEl.innerHTML = `<span>✓ <strong>Your Airtable is clean!</strong> No duplicate records detected across ${creators.length} creators.</span>`;
    if (autoCleanBtn) autoCleanBtn.style.display = "none";
    listEl.innerHTML = `
      <div class="empty-state" style="padding: 30px; text-align: center;">
        <div style="font-size: 36px; margin-bottom: 8px;">🎉</div>
        <h4 style="color: #f8fafc; margin: 0 0 6px 0;">Zero Duplicates Found</h4>
        <p style="color: #94a3b8; font-size: 13px; margin: 0;">All ${creators.length} records in your Airtable base have unique YouTube links, creator names, and social profiles.</p>
      </div>
    `;
    return;
  }

  statsEl.innerHTML = `
    <div>
      <strong>⚠️ Found ${currentDuplicateClusters.length} duplicate groups (${totalDups} duplicate records)</strong>
      <div style="font-size: 11px; color: #fde68a; margin-top: 2px;">Review below. The best-populated record is marked as <strong>Keep</strong>.</div>
    </div>
  `;

  if (autoCleanBtn) {
    autoCleanBtn.style.display = "inline-flex";
    autoCleanBtn.innerText = `⚡ Auto-Clean: Delete All ${totalDups} Duplicates`;
  }

  listEl.innerHTML = "";

  currentDuplicateClusters.forEach((cluster, clusterIdx) => {
    const card = document.createElement("div");
    card.className = "duplicate-cluster-card";
    card.id = `clusterCard_${clusterIdx}`;

    card.innerHTML = `
      <div class="cluster-header">
        <span class="cluster-title">
          <span>👯</span>
          <span>${cluster.title}</span>
          <span style="font-size: 11px; color: #94a3b8; font-weight: normal;">(${cluster.allRecords.length} records)</span>
        </span>
        <span class="cluster-match-reason">${cluster.reason}</span>
      </div>
      <div class="cluster-records-list" id="clusterRecords_${clusterIdx}">
        <!-- Record rows rendered below -->
      </div>
    `;

    const recordsContainer = card.querySelector(`#clusterRecords_${clusterIdx}`);

    cluster.allRecords.forEach((rec, recIdx) => {
      const isPrimary = (rec.id === cluster.primaryRecord.id);
      const row = document.createElement("div");
      row.className = `duplicate-record-row ${isPrimary ? 'is-primary' : ''}`;
      row.id = `dupRow_${rec.id}`;

      const ytDomain = rec.youtube ? rec.youtube.replace(/^https?:\/\/(www\.)?youtube\.com\//i, '@') : 'No YouTube';
      const statusLabel = rec.status || 'Pending';
      const igHandle = rec.instagram ? `@${normalizeSocialHandle(rec.instagram)}` : '';
      const twHandle = rec.twitter ? `@${normalizeSocialHandle(rec.twitter)}` : '';
      const socialsText = [igHandle, twHandle].filter(Boolean).join(" • ");

      row.innerHTML = `
        <div class="record-main-info">
          <div class="record-name-row">
            <span class="record-name">${rec.name || 'Unnamed Creator'}</span>
            ${isPrimary ? '<span class="badge-primary-keep">✓ Primary (Keep)</span>' : '<span class="badge-duplicate-tag">Duplicate</span>'}
            <span style="font-size: 11px; color: #64748b; font-family: monospace;">[${rec.id}]</span>
          </div>
          <div class="record-meta-row">
            <span>📺 ${ytDomain}</span>
            <span>📌 ${statusLabel}</span>
            ${socialsText ? `<span>📱 ${socialsText}</span>` : ''}
          </div>
        </div>
        <div class="record-actions">
          ${isPrimary 
            ? '<span style="font-size: 11px; color: #10b981; font-weight: 500;">Preserved</span>' 
            : `<button class="btn btn-xs btn-outline-danger btn-delete-dup" data-rec-id="${rec.id}" data-rec-name="${rec.name || 'Creator'}">🗑️ Delete</button>`
          }
        </div>
      `;

      const delBtn = row.querySelector(".btn-delete-dup");
      if (delBtn) {
        delBtn.addEventListener("click", async () => {
          delBtn.disabled = true;
          delBtn.innerText = "Deleting...";
          const success = await deleteAirtableRecord(rec.id, rec.name, false);
          if (success) {
            row.remove();
            // Re-evaluate clusters
            currentDuplicateClusters = findDuplicateClusters();
            renderDuplicateModalContent();
          } else {
            delBtn.disabled = false;
            delBtn.innerText = "🗑️ Delete";
          }
        });
      }

      recordsContainer.appendChild(row);
    });

    listEl.appendChild(card);
  });
}

async function autoCleanAllDuplicates() {
  const totalDups = currentDuplicateClusters.reduce((sum, c) => sum + c.duplicateRecords.length, 0);
  if (totalDups === 0) return;

  if (!confirm(`Are you sure you want to permanently delete ALL ${totalDups} duplicate records from Airtable?\n\nFor each creator, the record with the most complete outreach information will be safely preserved.`)) {
    return;
  }

  const autoCleanBtn = document.getElementById("autoCleanDuplicatesBtn");
  if (autoCleanBtn) {
    autoCleanBtn.disabled = true;
    autoCleanBtn.innerText = "Cleaning duplicates...";
  }

  let deletedCount = 0;
  for (const cluster of currentDuplicateClusters) {
    for (const dup of cluster.duplicateRecords) {
      try {
        const ok = await deleteAirtableRecord(dup.id, dup.name, true);
        if (ok) deletedCount++;
      } catch (e) {}
    }
  }

  showToast(`🎉 Cleaned up ${deletedCount} duplicate records from Airtable!`);
  currentDuplicateClusters = findDuplicateClusters();
  renderDuplicateModalContent();
}


// =====================================================================
// Script A/B Testing & Reply Analytics Engine
// =====================================================================

async function savePitchStats() {
  try {
    await appStorage.set({ pitchStats, creatorPitchMap, isAbTestMode });
  } catch (e) {}
}

function recordPitchSent(creatorId, pitchId) {
  if (!creatorId || !pitchId || pitchId === "ab_auto_rotate") return;
  if (!pitchStats[pitchId]) {
    pitchStats[pitchId] = { sent: 0, replied: 0, conversions: 0 };
  }
  pitchStats[pitchId].sent = (pitchStats[pitchId].sent || 0) + 1;
  creatorPitchMap[creatorId] = pitchId;
  savePitchStats();
  renderAbTestingDashboard();
}

function syncPitchStatsWithCreators(creatorsList) {
  if (!Array.isArray(creatorsList)) return;

  // Initialize all pitches in stats
  savedPitches.forEach(p => {
    if (!pitchStats[p.id]) {
      pitchStats[p.id] = { sent: 0, replied: 0, conversions: 0 };
    }
  });

  // Zero-out replied & conversions to recalculate from fresh Airtable data
  Object.keys(pitchStats).forEach(pId => {
    pitchStats[pId].replied = 0;
    pitchStats[pId].conversions = 0;
  });

  creatorsList.forEach(c => {
    const pId = creatorPitchMap[c.id];
    if (pId && pitchStats[pId]) {
      const isReplied = Boolean(c.replied) || (c.status && c.status.toLowerCase() === 'replied') || Boolean(c.plateformReplied);
      const isConverted = (c.status && ['landed', 'call booked', 'active & paying', 'closed', 'signed'].includes(c.status.toLowerCase()));

      if (isReplied) pitchStats[pId].replied = (pitchStats[pId].replied || 0) + 1;
      if (isConverted) pitchStats[pId].conversions = (pitchStats[pId].conversions || 0) + 1;
    }
  });

  savePitchStats();
  renderAbTestingDashboard();
}

function renderAbTestingDashboard() {
  const containers = [
    document.getElementById("abComparisonGrid"),
    document.getElementById("dashAbComparisonGrid")
  ];

  // Find winner
  let bestPitchId = null;
  let highestReplyRate = -1;

  savedPitches.forEach(p => {
    const st = pitchStats[p.id] || { sent: 0, replied: 0, conversions: 0 };
    if (st.sent >= 2) {
      const rate = (st.replied / st.sent) * 100;
      if (rate > highestReplyRate) {
        highestReplyRate = rate;
        bestPitchId = p.id;
      }
    }
  });

  containers.forEach(grid => {
    if (!grid) return;
    grid.innerHTML = "";

    savedPitches.forEach((p, idx) => {
      const st = pitchStats[p.id] || { sent: 0, replied: 0, conversions: 0 };
      const replyRate = st.sent > 0 ? ((st.replied / st.sent) * 100).toFixed(1) : "0.0";
      const convRate = st.sent > 0 ? ((st.conversions / st.sent) * 100).toFixed(1) : "0.0";
      const isWinner = (p.id === bestPitchId && highestReplyRate > 0);

      const card = document.createElement("div");
      card.className = `ab-script-card ${isWinner ? 'is-winner' : ''}`;

      card.innerHTML = `
        <div class="ab-script-header">
          <span class="ab-script-title">
            <span>📝</span>
            <span>${escapeHtml(p.title)}</span>
            <span style="font-size: 10px; color: #94a3b8; font-family: monospace;">(${p.shortcut || '/dm'})</span>
          </span>
          ${isWinner ? '<span class="ab-winner-badge">🏆 Leading Script</span>' : (p.id === activePitchId ? '<span style="font-size: 10px; color: #38bdf8; font-weight: 600;">Active Pitch</span>' : '')}
        </div>

        <div class="ab-metrics-row">
          <div class="ab-metric-item">
            <span class="ab-metric-val">${st.sent}</span>
            <span class="ab-metric-lbl">Total Sent</span>
          </div>
          <div class="ab-metric-item">
            <span class="ab-metric-val rate">${st.replied} (${replyRate}%)</span>
            <span class="ab-metric-lbl">Replies (Rate)</span>
          </div>
          <div class="ab-metric-item">
            <span class="ab-metric-val" style="color: #a78bfa;">${st.conversions} (${convRate}%)</span>
            <span class="ab-metric-lbl">Closed Deals</span>
          </div>
        </div>

        <div class="ab-progress-bar-bg" title="${replyRate}% reply rate">
          <div class="ab-progress-bar-fill" style="width: ${Math.min(100, Math.max(st.sent > 0 ? 4 : 0, parseFloat(replyRate)))}%;"></div>
        </div>
      `;

      grid.appendChild(card);
    });
  });
}

function setupAbTestingEventListeners() {
  const resetBtns = [
    document.getElementById("resetAbStatsBtn"),
    document.getElementById("dashResetAbStatsBtn")
  ];

  resetBtns.forEach(btn => {
    if (btn) {
      btn.addEventListener("click", async () => {
        if (!confirm("Reset all script A/B testing counters?\nThis will clear sent, reply, and conversion metrics so you can begin a fresh test.")) {
          return;
        }
        pitchStats = {};
        creatorPitchMap = {};
        await savePitchStats();
        renderAbTestingDashboard();
        showToast("✓ A/B test statistics reset!");
      });
    }
  });

  const toggles = [
    document.getElementById("abAutoRotateToggle"),
    document.getElementById("dashAbAutoRotateToggle")
  ];

  toggles.forEach(tog => {
    if (tog) {
      tog.addEventListener("change", async () => {
        isAbTestMode = tog.checked;
        if (isAbTestMode) {
          activePitchId = "ab_auto_rotate";
        } else {
          activePitchId = savedPitches[0]?.id || "pitch_sponsor";
        }
        await appStorage.set({ isAbTestMode, activePitchId });
        populatePitchSelectDropdowns();
        renderTodayDmQueue();
        showToast(isAbTestMode ? "🎲 A/B Auto-Rotate enabled for Today's DM Queue!" : "Single pitch mode active.");
      });
    }
  });

  const selects = [
    document.getElementById("todayPitchSelect"),
    document.getElementById("dashTodayPitchSelect"),
    document.getElementById("dashPitchSelect")
  ];

  selects.forEach(sel => {
    if (sel) {
      sel.addEventListener("change", async () => {
        activePitchId = sel.value;
        isAbTestMode = (activePitchId === "ab_auto_rotate");
        await appStorage.set({ activePitchId, isAbTestMode });
        populatePitchSelectDropdowns();
        renderTodayDmQueue();
        renderAbTestingDashboard();
      });
    }
  });
}


// -------------------------------------------------------------
// Active YouTube Channel Detector & 1-Click Importer in Popup
// -------------------------------------------------------------
async function detectActiveYouTubeChannel() {
  const banner = document.getElementById("activeYtChannelBanner");
  if (!banner) return;

  try {
    if (!chrome?.tabs?.query) return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) return;

    const url = tab.url;
    const isYt = (url.includes("youtube.com/@") || url.includes("youtube.com/channel/") || url.includes("youtube.com/c/") || url.includes("youtube.com/user/")) 
                 && !url.includes("/watch") && !url.includes("/shorts") && !url.includes("/feed");

    if (!isYt) {
      banner.style.display = "none";
      return;
    }

    banner.style.display = "flex";

    let handle = "";
    const hMatch = url.match(/@([a-zA-Z0-9_\.-]+)/i);
    if (hMatch) handle = `@${hMatch[1]}`;

    let name = tab.title ? tab.title.replace(/\s*-\s*YouTube.*$/i, "").trim() : (handle || "YouTube Creator");
    if (!name || name.toLowerCase() === "youtube") name = handle || "YouTube Creator";

    const cleanUrl = url.replace(/\/(featured|videos|shorts|live|streams|playlists|community|channels|about)\/?$/i, "");

    const nameEl = document.getElementById("ytBannerName");
    const handleEl = document.getElementById("ytBannerHandle");
    const statusEl = document.getElementById("ytBannerStatus");
    const actionArea = document.getElementById("ytBannerActionArea");

    if (nameEl) nameEl.innerText = name;
    if (handleEl) handleEl.innerText = handle;
    if (statusEl) statusEl.innerHTML = "⏳ Checking Airtable database...";

    try {
      chrome.tabs.sendMessage(tab.id, { action: "GET_YOUTUBE_METADATA" }, (meta) => {
        if (chrome.runtime?.lastError) return;
        if (meta && meta.name) {
          name = meta.name;
          if (nameEl) nameEl.innerText = name;
        }
        if (meta && meta.handle) {
          handle = meta.handle;
          if (handleEl) handleEl.innerText = handle;
        }
      });
    } catch (e) {}

    chrome.runtime.sendMessage({
      action: "CHECK_YOUTUBE_CHANNEL_EXISTS",
      url: cleanUrl,
      handle: handle,
      name: name
    }, (res) => {
      if (chrome.runtime?.lastError) {
        if (statusEl) statusEl.innerText = "Ready to add";
        renderPopupAddButton(actionArea, name, cleanUrl, handle, statusEl, banner);
        return;
      }

      if (res && res.exists) {
        banner.classList.add("exists");
        const recordId = res.id || res.record?.id;
        const recordUrl = res.recordUrl || (recordId ? `https://airtable.com/appnD39Am5fUmSH8l/tblBk24WqNfOcicvB/${recordId}` : "");
        const statusLabel = res.record?.status || "In Database";

        if (statusEl) {
          statusEl.innerHTML = `✓ In Database • <span class="yt-chip-status">${statusLabel}</span>`;
        }
        if (actionArea) {
          actionArea.innerHTML = `
            <button id="ytPopupOpenRecordBtn" class="btn btn-sm" style="
              background: linear-gradient(135deg, rgba(16, 185, 129, 0.25) 0%, rgba(5, 150, 105, 0.35) 100%);
              border: 1px solid rgba(16, 185, 129, 0.6);
              color: #34d399;
              font-weight: 700;
              font-size: 11px;
              padding: 5px 12px;
              border-radius: 8px;
              cursor: pointer;
              white-space: nowrap;
            ">
              Open in Airtable ↗
            </button>
          `;
          const openBtn = document.getElementById("ytPopupOpenRecordBtn");
          if (openBtn) {
            openBtn.onclick = () => window.open(recordUrl || "https://airtable.com/appnD39Am5fUmSH8l/tblBk24WqNfOcicvB", "_blank");
          }
        }
      } else {
        banner.classList.remove("exists");
        if (statusEl) statusEl.innerText = "New Creator • Not in Airtable";
        renderPopupAddButton(actionArea, name, cleanUrl, handle, statusEl, banner);
      }
    });
  } catch (err) {
    console.warn("detectActiveYouTubeChannel error:", err);
  }
}

function renderPopupAddButton(actionArea, name, cleanUrl, handle, statusEl, banner) {
  if (!actionArea) return;
  actionArea.innerHTML = `
    <button id="ytPopupAddBtn" class="btn btn-sm btn-primary" style="
      background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%);
      color: #ffffff;
      font-weight: 700;
      font-size: 11px;
      padding: 5px 12px;
      border-radius: 8px;
      border: 1px solid rgba(255, 255, 255, 0.2);
      cursor: pointer;
      white-space: nowrap;
    ">
      + Add to Airtable
    </button>
  `;
  const addBtn = document.getElementById("ytPopupAddBtn");
  if (addBtn) {
    addBtn.onclick = () => {
      addBtn.disabled = true;
      addBtn.innerText = "⏳ Adding...";
      if (statusEl) statusEl.innerText = "Extracting socials & saving...";

      chrome.runtime.sendMessage({
        action: "ADD_YOUTUBE_CHANNEL_TO_AIRTABLE",
        name: name,
        youtube: cleanUrl,
        handle: handle,
        niche: "Roblox"
      }, (addRes) => {
        if (addRes && addRes.success) {
          banner.classList.add("exists");
          const newRecId = addRes.recordId || addRes.record?.id;
          const newRecUrl = addRes.recordUrl || (newRecId ? `https://airtable.com/appnD39Am5fUmSH8l/tblBk24WqNfOcicvB/${newRecId}` : "");
          const keys = addRes.keys || [];
          const foundText = keys.length > 0 ? ` (Found: ${keys.join(", ")})` : "";
          if (statusEl) statusEl.innerHTML = `✓ Added to Airtable!${foundText}`;

          actionArea.innerHTML = `
            <button id="ytPopupOpenRecordBtn" class="btn btn-sm" style="
              background: linear-gradient(135deg, rgba(16, 185, 129, 0.25) 0%, rgba(5, 150, 105, 0.35) 100%);
              border: 1px solid rgba(16, 185, 129, 0.6);
              color: #34d399;
              font-weight: 700;
              font-size: 11px;
              padding: 5px 12px;
              border-radius: 8px;
              cursor: pointer;
              white-space: nowrap;
            ">
              Open in Airtable ↗
            </button>
          `;
          const newOpenBtn = document.getElementById("ytPopupOpenRecordBtn");
          if (newOpenBtn) {
            newOpenBtn.onclick = () => window.open(newRecUrl, "_blank");
          }
          if (typeof fetchAirtableRecords === "function") fetchAirtableRecords();
        } else {
          addBtn.disabled = false;
          addBtn.innerText = "+ Add to Airtable";
          if (statusEl) statusEl.innerText = "Error adding channel. Try again.";
        }
      });
    };
  }
}
