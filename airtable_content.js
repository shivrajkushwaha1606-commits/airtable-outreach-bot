// Content script for Airtable - 1-Click Creator Social Finder & Record Enrichment
(function () {
  if (typeof chrome === "undefined" || !chrome?.runtime?.id) return;

  let currentRecordId = null;
  let isSearching = false;

  function extractRecordIdFromUrl() {
    const m = window.location.href.match(/\/(rec[a-zA-Z0-9]{14,17})/);
    return m ? m[1] : null;
  }

  function getRecordName() {
    // 1. Try large record title heading in modal
    const headings = Array.from(document.querySelectorAll('h1, h2, [role="heading"], .recordTitle, [data-tutorial-selector-id="recordTitle"]'));
    for (const h of headings) {
      const text = h.innerText?.trim();
      if (text && text.length > 1 && !text.includes("All comments") && !text.includes("Activity")) {
        return text;
      }
    }

    // 2. Try primary cell text
    const cell = document.querySelector('.primaryCell, [data-columnid*="name" i] input, [aria-label="Name" i]');
    if (cell && (cell.value || cell.innerText)) {
      return (cell.value || cell.innerText).trim();
    }

    return "";
  }

  function getYtLink() {
    const links = Array.from(document.querySelectorAll('a[href*="youtube.com"], a[href*="youtu.be"]'));
    for (const a of links) {
      if (a.href) return a.href.trim();
    }

    const inputs = Array.from(document.querySelectorAll('input, [contenteditable]'));
    for (const inp of inputs) {
      const val = inp.value || inp.innerText || "";
      if (val.includes("youtube.com/") || val.includes("youtu.be/")) return val.trim();
    }
    return "";
  }

  function injectSocialFinderButton() {
    const recId = extractRecordIdFromUrl();
    if (!recId) {
      const existing = document.getElementById("airtable-social-finder-widget");
      if (existing) existing.remove();
      currentRecordId = null;
      return;
    }

    if (recId === currentRecordId && document.getElementById("airtable-social-finder-widget")) {
      return;
    }
    currentRecordId = recId;

    let widget = document.getElementById("airtable-social-finder-widget");
    if (!widget) {
      widget = document.createElement("div");
      widget.id = "airtable-social-finder-widget";
      widget.style.cssText = `
        position: fixed;
        top: 14px;
        right: 86px;
        z-index: 9999999;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        display: flex;
        align-items: center;
        gap: 8px;
        animation: fadeIn 0.25s ease-out;
      `;
      document.body.appendChild(widget);
    }

    widget.innerHTML = `
      <button id="airtableFindSocialsBtn" style="
        background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%);
        color: #ffffff;
        border: 1px solid rgba(255, 255, 255, 0.25);
        box-shadow: 0 4px 14px rgba(99, 102, 241, 0.4), 0 1px 3px rgba(0, 0, 0, 0.2);
        border-radius: 8px;
        padding: 7px 13px;
        font-size: 12px;
        font-weight: 700;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
        outline: none;
      ">
        <span id="airtableBtnIcon">🔍</span>
        <span id="airtableBtnText">Deep Find Socials</span>
      </button>
      <div id="airtableSocialResultPill" style="display: none; background: #0f172a; border: 1px solid rgba(255, 255, 255, 0.15); color: #f8fafc; font-size: 11px; padding: 6px 10px; border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); align-items: center; gap: 6px;">
      </div>
    `;

    const btn = widget.querySelector("#airtableFindSocialsBtn");
    const resultPill = widget.querySelector("#airtableSocialResultPill");
    const btnIcon = widget.querySelector("#airtableBtnIcon");
    const btnText = widget.querySelector("#airtableBtnText");

    btn.addEventListener("click", async () => {
      if (isSearching) return;
      isSearching = true;

      btnIcon.innerText = "⏳";
      btnText.innerText = "Deep Searching YouTube & Web...";
      btn.style.opacity = "0.85";
      btn.disabled = true;

      const name = getRecordName();
      const yt = getYtLink();

      try {
        chrome.runtime.sendMessage({
          action: "DEEP_SEARCH_RECORD",
          recordId: recId,
          name: name,
          youtube: yt
        }, (resp) => {
          isSearching = false;
          btn.disabled = false;
          btn.style.opacity = "1";

          if (resp && resp.success) {
            btnIcon.innerText = "✓";
            btnText.innerText = "Socials Enriched!";
            btn.style.background = "linear-gradient(135deg, #10b981 0%, #059669 100%)";
            btn.style.boxShadow = "0 4px 14px rgba(16, 185, 129, 0.4)";

            if (resultPill && resp.keys && resp.keys.length > 0) {
              resultPill.style.display = "flex";
              const readable = resp.keys.map(k => k === "X account" ? "Twitter/X" : k === "Discord Page" ? "Discord" : k).join(", ");
              resultPill.innerHTML = `<span style="color: #34d399; font-weight: 700;">✓ Saved to Airtable:</span> <span>${readable}</span>`;
            }

            setTimeout(() => {
              btnIcon.innerText = "🔍";
              btnText.innerText = "Re-Search Socials";
              btn.style.background = "linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)";
              btn.style.boxShadow = "0 4px 14px rgba(99, 102, 241, 0.4)";
            }, 6000);
          } else {
            btnIcon.innerText = "ℹ️";
            btnText.innerText = "No New Socials Found";
            btn.style.background = "#334155";
            btn.style.boxShadow = "none";

            if (resultPill) {
              resultPill.style.display = "flex";
              resultPill.innerHTML = `<span style="color: #cbd5e1;">${resp?.reason || "No verified social links detected on channel"}</span>`;
            }

            setTimeout(() => {
              btnIcon.innerText = "🔍";
              btnText.innerText = "Deep Find Socials";
              btn.style.background = "linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)";
              btn.style.boxShadow = "0 4px 14px rgba(99, 102, 241, 0.4)";
              if (resultPill) resultPill.style.display = "none";
            }, 5000);
          }
        });
      } catch (e) {
        isSearching = false;
        btn.disabled = false;
        btnIcon.innerText = "🔍";
        btnText.innerText = "Deep Find Socials";
      }
    });
  }

  // Monitor URL changes and DOM mutations
  setInterval(injectSocialFinderButton, 800);
  window.addEventListener("popstate", injectSocialFinderButton);
  const observer = new MutationObserver(injectSocialFinderButton);
  observer.observe(document.body, { childList: true, subtree: true });
})();
