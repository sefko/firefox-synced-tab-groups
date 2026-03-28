/**
 * Sidebar UI — flat Firefox-native style.
 * Reads per-device Sync snapshots, shows other devices only.
 * Load actions call tabs.group / tabGroups.update in the worker.
 */

const elRoot      = document.getElementById("root");
const elLoading   = document.getElementById("loading");
const elError     = document.getElementById("banner-error");
const elSearch    = document.getElementById("search-input");
const elTopbar    = document.querySelector(".topbar");
const linkOptions = document.getElementById("link-options");
const btnHeaderSettings = document.getElementById("header-settings-btn");

// ── Scroll Handling ──────────────────────────────────────────

window.addEventListener("scroll", () => {
  if (elTopbar) {
    elTopbar.classList.toggle("scrolled", window.scrollY > 0);
  }
}, { passive: true });

let _lastRes = null;

// ── Persistent State ─────────────────────────────────────────

let _collapsedState = {};

async function loadCollapsedState() {
  try {
    const { collapsedState } = await browser.storage.local.get("collapsedState");
    _collapsedState = collapsedState || {};
  } catch (e) {
    console.error("Failed to load collapsed state:", e);
    _collapsedState = {};
  }
}

async function saveCollapsedState() {
  try {
    await browser.storage.local.set({ collapsedState: _collapsedState });
  } catch (e) {
    console.error("Failed to save collapsed state:", e);
  }
}

function isCollapsed(key, defaultVal) {
  return _collapsedState[key] ?? defaultVal;
}

function setCollapsed(key, val) {
  _collapsedState[key] = val;
  saveCollapsedState();
}

// ── Helpers ──────────────────────────────────────────────────

function showError(msg) {
  elError.textContent = msg;
  elError.classList.remove("hidden");
}
function clearError() {
  elError.textContent = "";
  elError.classList.add("hidden");
}
function setLoading(on) {
  elLoading.classList.toggle("hidden", !on);
}

function esc(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/** Safer alternative to innerHTML */
function setContent(el, htmlString) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlString, "text/html");
  el.replaceChildren(...doc.body.childNodes);
}

function openableUrl(url) {
  if (!url) return "";
  try {
    const u = new URL(url);
    if (u.protocol === "http:" || u.protocol === "https:" || u.protocol === "file:") return u.href;
  } catch { /* ignore */ }
  return "";
}

function formatTime(ts) {
  if (!ts) return "never";
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(ts));
  } catch { return String(ts); }
}

const COLOR_MAP = {
  blue: "#2563eb", cyan: "#06b6d4", grey: "#64748b", green: "#16a34a",
  orange: "#ea580c", pink: "#db2777", purple: "#9333ea", red: "#dc2626", yellow: "#ca8a04",
};

function groupColor(color) {
  const key = String(color || "blue");
  return COLOR_MAP[key] ?? COLOR_MAP.blue;
}

// ── SVG icons ────────────────────────────────────────────────

const CHEVRON_LG = `<svg class="device-chevron" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const CHEVRON_SM = `<svg class="group-chevron" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const MONITOR = `<svg class="device-icon" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <rect x="1" y="2" width="14" height="9" rx="1.5" stroke="currentColor" stroke-width="1.4"/>
  <path d="M5 14h6M8 11v3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
</svg>`;

// ── Tab row ──────────────────────────────────────────────────

function tabRow(t, ctx = {}) {
  const kind = ctx.kind === "ungrouped" ? "ungrouped" : "named";
  const groupTitle = ctx.groupTitle || "Group";
  const groupColor = ctx.groupColor || "blue";

  const titleRaw = t.title || t.url || "";
  const title    = esc(titleRaw);
  const hrefRaw  = openableUrl(t.url);
  const href     = hrefRaw ? esc(hrefRaw) : "";
  const fav      = t.favIconUrl ? esc(t.favIconUrl) : "";

  const icon = fav
    ? `<img class="tab__icon" alt="" src="${fav}" onerror="this.style.display='none'"/>`
    : `<div class="tab__icon" aria-hidden="true"></div>`;
  const dataAttrs = href
    ? `data-role="open-tab" data-url="${href}" data-group-kind="${esc(kind)}"${
        kind === "named"
          ? ` data-group-title="${esc(groupTitle)}" data-group-color="${esc(groupColor)}"`
          : ""
      }`
    : "";
  const containerAttrs = href ? `tabindex="0" role="button" ${dataAttrs}` : "";

  const label = href
    ? `<p class="tab__title"><a class="tab__link" href="${href}" target="_blank" rel="noreferrer noopener">${title}</a></p>`
    : `<p class="tab__title">${title}</p>`;

  return `<div class="tab" ${containerAttrs}>${icon}${label}</div>`;
}

// ── Empty / diagnostic panel ─────────────────────────────────

function noOtherDevicesPanel(res) {
  const { deviceId, data, diag } = res;
  const devices   = (data && data.devices) || {};
  const ids       = Object.keys(devices);
  const remoteIds = ids.filter(id => id !== deviceId);
  if (remoteIds.length > 0) return null;

  const d = diag || {};
  const writeErr = d.lastSyncWriteError
    ? `<p class="diag-error"><b>Last sync write failed:</b> ${esc(d.lastSyncWriteError)}</p>` : "";
  const readErr = d.storageReadError
    ? `<p class="diag-error"><b>Reading sync storage failed:</b> ${esc(d.storageReadError)}</p>` : "";
  const meta = `<p class="diag-meta">Diagnostics: <code>${d.syncBytes ?? "?"}</code> bytes · <code>${d.syncKeyCount ?? "?"}</code> keys · id <code>${esc(String(d.extensionId || ""))}</code></p>`;

  const onlySelf      = ids.length === 1 && ids[0] === deviceId;
  const nothingStored = ids.length === 0;

  let explanation = "";
  if (nothingStored) {
    explanation = `<p><b>Nothing in <code>storage.sync</code> yet.</b> A snapshot may have exceeded Firefox's per-item limit (~8192 bytes). Reload the sidebar to retry.</p>`;
  } else if (onlySelf) {
    explanation = `<p><b>This device's snapshot is stored</b>, but no other device appears yet.</p>
    <ul class="diag-list">
      <li>Ensure both machines use the same <b>Firefox Account</b> and have <b>Add-ons</b> enabled in Settings → Sync.</li>
      <li>Use <b>Sync now</b>, wait a minute, then reload the sidebar.</li>
      <li>Temporary installs from <code>about:debugging</code> are unreliable for cross-device <code>storage.sync</code>. Use a signed .xpi instead.</li>
    </ul>`;
  } else {
    explanation = `<p>No other devices to list.</p>`;
  }

  return `<div class="empty">${writeErr}${readErr}${explanation}${meta}</div>`;
}

// ── Main render ──────────────────────────────────────────────

function render(res, query = "") {
  _lastRes = res;
  const { deviceId, data } = res;
  const devices   = (data && data.devices) || {};
  const ids       = Object.keys(devices);
  
  // Preliminary sorting to ensure the current device is prioritized
  const sortedIds = ids.sort((a, b) => {
    if (a === deviceId) return -1;
    if (b === deviceId) return 1;
    return (devices[b]?.lastSync ?? 0) - (devices[a]?.lastSync ?? 0);
  });

  if (sortedIds.length === 0) {
    const panel = noOtherDevicesPanel(res);
    if (panel) setContent(elRoot, panel);
    if (res.diag?.lastSyncWriteError) showError(res.diag.lastSyncWriteError);
    else clearError();
    return;
  }

  clearError();

  const q    = query.trim().toLowerCase();
  const html = [];
  
  // Identify potential duplicates of the local device to hide them
  const localDevice = devices[deviceId];
  const hiddenIds = new Set();
  if (localDevice) {
    for (const id of sortedIds) {
      if (id === deviceId) continue;
      const d = devices[id];
      // If a remote device has the same name and identical tabs, it's likely a split identity
      if (d && d.deviceName === localDevice.deviceName) {
        // Simple comparison: same group count and tab count
        const localTabs = (localDevice.groups || []).reduce((n, g) => n + (g.tabs?.length || 0), 0) + (localDevice.ungroupedTabs?.length || 0);
        const dTabs = (d.groups || []).reduce((n, g) => n + (g.tabs?.length || 0), 0) + (d.ungroupedTabs?.length || 0);
        if (localTabs === dTabs && localTabs > 0) {
           // We'll hide it if it's an exact match of the local device
           hiddenIds.add(id);
        }
      }
    }
  }

  for (const devId of sortedIds) {
    if (hiddenIds.has(devId)) continue;
    const d         = devices[devId] || {};
    const name      = d.deviceName || "Unknown device";
    const groups    = Array.isArray(d.groups)       ? d.groups       : [];
    const ungrouped = Array.isArray(d.ungroupedTabs) ? d.ungroupedTabs : [];
    const isCurrentDevice = (devId === deviceId);

    // Build a filtered view — keep original indices so load actions stay correct.
    // Each entry: { origIdx, group, filteredTabs }
    const filteredGroups = groups
      .map((g, origIdx) => ({
        origIdx,
        group: g,
        filteredTabs: q
          ? (g.tabs || []).filter(t => (t.title || t.url || "").toLowerCase().includes(q))
          : (g.tabs || []),
      }))
      .filter(({ filteredTabs }) => !q || filteredTabs.length > 0);

    const filteredUngrouped = q
      ? ungrouped.filter(t => (t.title || t.url || "").toLowerCase().includes(q))
      : ungrouped;

    if (q && filteredGroups.length === 0 && filteredUngrouped.length === 0) continue;

    const totalTabs = filteredGroups.reduce((n, { filteredTabs }) => n + filteredTabs.length, 0)
                    + filteredUngrouped.length;

    const deviceKey = `device:${devId}`;
    const deviceIsCollapsed = isCollapsed(deviceKey, isCurrentDevice);
    const deviceCollapsedAttr = deviceIsCollapsed ? " data-collapsed" : "";
    html.push(`<section class="device" data-device-id="${esc(devId)}"${deviceCollapsedAttr}>`);

    // ── Device header ──────────────────────────────────────
    // Order: chevron | monitor icon | name | [Load all btn] | pill count
    html.push(`<div class="device__head" data-role="device-toggle" title="Last sync: ${esc(formatTime(d.lastSync))}">`);
    html.push(CHEVRON_LG);
    html.push(MONITOR);
    html.push(`<span class="device__name">${esc(name)}${isCurrentDevice ? " (this device)" : ""}</span>`);
    html.push(`<button type="button" class="btn-load" data-role="load-device" data-device-id="${esc(devId)}">Load all</button>`);
    html.push(`<span class="pill-count">${totalTabs}</span>`);
    html.push(`</div>`);

    // ── Device body ────────────────────────────────────────
    const bodyStyle = deviceIsCollapsed ? ' style="display:none"' : "";
    html.push(`<div class="device__body"${bodyStyle}>`);

    // Named groups — use origIdx for the load action
    for (const { origIdx, group: g, filteredTabs } of filteredGroups) {
      const gTitle = g.title || "Group";
      const hex    = groupColor(g.color);
      const groupKey = `group:${devId}:${gTitle}`;
      const groupIsCollapsed = isCollapsed(groupKey, isCurrentDevice);
      const groupCollapsedAttr = groupIsCollapsed ? " data-collapsed" : "";

      html.push(`<div class="group"${groupCollapsedAttr}>`);
      // Order: chevron | swatch | name | [Load btn] | pill count
      html.push(`<div class="group-label" data-role="group-toggle" data-group-title="${esc(gTitle)}">`);
      html.push(CHEVRON_SM);
      html.push(`<span class="swatch" style="background:${hex}"></span>`);
      html.push(`<span class="group-label__text">${esc(gTitle)}</span>`);
      html.push(`<button type="button" class="btn-load" data-role="load-group" data-device-id="${esc(devId)}" data-group-index="${origIdx}">Load</button>`);
      html.push(`<span class="pill-count">${filteredTabs.length}</span>`);
      html.push(`</div>`);
      html.push(`<div class="group-body">`);
      for (const t of filteredTabs) html.push(tabRow(t, { kind: "named", groupTitle: g.title, groupColor: g.color }));
      html.push(`</div>`);
      html.push(`</div>`);
    }

    // Ungrouped
    if (!q || filteredUngrouped.length > 0) {
      const gTitle = "Ungrouped";
      const groupKey = `group:${devId}:${gTitle}`;
      const groupIsCollapsed = isCollapsed(groupKey, isCurrentDevice);
      const groupCollapsedAttr = groupIsCollapsed ? " data-collapsed" : "";

      html.push(`<div class="group"${groupCollapsedAttr}>`);
      html.push(`<div class="group-label" data-role="group-toggle" data-group-title="${esc(gTitle)}">`);
      html.push(CHEVRON_SM);
      html.push(`<span class="swatch" style="background:#94a3b8"></span>`);
      html.push(`<span class="group-label__text">Ungrouped</span>`);
      html.push(`<button type="button" class="btn-load" data-role="load-ungrouped" data-device-id="${esc(devId)}">Load</button>`);
      html.push(`<span class="pill-count">${filteredUngrouped.length}</span>`);
      html.push(`</div>`);
      html.push(`<div class="group-body">`);
      for (const t of filteredUngrouped) html.push(tabRow(t, { kind: "ungrouped" }));
      html.push(`</div>`);
      html.push(`</div>`);
    }

    html.push(`</div>`); // .device__body
    html.push(`</section>`);
  }

  setContent(elRoot, html.join(""));
  attachListeners(devices);
}

// ── Event listeners ──────────────────────────────────────────
// Use data-role (not data-action) so toggle and load never share the same attribute.

function attachListeners(devices) {

  // Toggle device collapse — fires on the head div, but ignores clicks on the button
  elRoot.querySelectorAll('[data-role="device-toggle"]').forEach(head => {
    head.addEventListener("click", ev => {
      // If the click landed on or inside the load button, ignore — let the button handle it
      if (ev.target.closest("[data-role='load-device']")) return;
      const section = head.closest(".device");
      const devId   = section.getAttribute("data-device-id");
      const body    = section.querySelector(".device__body");
      const nowCollapsed = section.toggleAttribute("data-collapsed");
      if (body) body.style.display = nowCollapsed ? "none" : "";
      
      if (devId) {
        setCollapsed(`device:${devId}`, nowCollapsed);
      }
    });
  });

  // Toggle group collapse
  elRoot.querySelectorAll('[data-role="group-toggle"]').forEach(label => {
    label.addEventListener("click", ev => {
      if (ev.target.closest(".btn-load")) return;
      const group = label.closest(".group");
      const section = label.closest(".device");
      const devId = section?.getAttribute("data-device-id");
      const gTitle = label.getAttribute("data-group-title");
      
      const nowCollapsed = group.toggleAttribute("data-collapsed");
      
      if (devId && gTitle) {
        setCollapsed(`group:${devId}:${gTitle}`, nowCollapsed);
      }
    });
  });

  // Load all tabs for a device
  elRoot.querySelectorAll('[data-role="load-device"]').forEach(btn => {
    btn.addEventListener("click", async ev => {
      ev.stopPropagation();
      const devId   = btn.getAttribute("data-device-id");
      const payload = devices[devId];
      if (!payload) return;
      btn.disabled = true;
      setLoading(true); clearError();
      try {
        const resp = await browser.runtime.sendMessage({ type: "LOAD_DEVICE", devicePayload: payload });
        if (!resp?.ok) throw new Error(resp?.error || "Load failed");
      } catch (e) { showError(e?.message ?? String(e)); }
      finally { btn.disabled = false; setLoading(false); }
    });
  });

  // Load a single named group — uses origIdx stored in data-group-index
  elRoot.querySelectorAll('[data-role="load-group"]').forEach(btn => {
    btn.addEventListener("click", async ev => {
      ev.stopPropagation();
      const devId = btn.getAttribute("data-device-id");
      const idx   = Number(btn.getAttribute("data-group-index"));
      const group = devices[devId]?.groups?.[idx];
      if (!group) { showError(`Group not found (index ${idx})`); return; }
      btn.disabled = true;
      setLoading(true); clearError();
      try {
        const resp = await browser.runtime.sendMessage({ type: "LOAD_GROUP", group });
        if (!resp?.ok) throw new Error(resp?.error || "Load failed");
      } catch (e) { showError(e?.message ?? String(e)); }
      finally { btn.disabled = false; setLoading(false); }
    });
  });

  // Load ungrouped tabs
  elRoot.querySelectorAll('[data-role="load-ungrouped"]').forEach(btn => {
    btn.addEventListener("click", async ev => {
      ev.stopPropagation();
      const devId   = btn.getAttribute("data-device-id");
      const payload = devices[devId];
      if (!payload?.ungroupedTabs) return;
      btn.disabled = true;
      setLoading(true); clearError();
      try {
        const resp = await browser.runtime.sendMessage({ type: "LOAD_UNGROUPED", ungroupedTabs: payload.ungroupedTabs });
        if (!resp?.ok) throw new Error(resp?.error || "Load failed");
      } catch (e) { showError(e?.message ?? String(e)); }
      finally { btn.disabled = false; setLoading(false); }
    });
  });

  // Open a single tab URL into the correct group (activate existing tabs; otherwise create then group).
  elRoot.querySelectorAll('.tab[data-role="open-tab"]').forEach(tabRowEl => {
    const open = async () => {
      const url = tabRowEl.getAttribute("data-url");
      const groupKind = tabRowEl.getAttribute("data-group-kind");
      const groupTitle = tabRowEl.getAttribute("data-group-title");
      const groupColor = tabRowEl.getAttribute("data-group-color");

      if (!url) return;

      setLoading(true); clearError();
      try {
        const resp = await browser.runtime.sendMessage({
          type: "OPEN_TAB",
          url,
          groupKind,
          groupTitle,
          groupColor,
        });
        if (!resp?.ok) throw new Error(resp?.error || "Open tab failed");
      } catch (e) {
        showError(e?.message ?? String(e));
      } finally {
        setLoading(false);
      }
    };

    tabRowEl.addEventListener("click", async ev => {
      ev.preventDefault();
      ev.stopPropagation();
      await open();
    });

    tabRowEl.addEventListener("keydown", async ev => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      ev.preventDefault();
      ev.stopPropagation();
      await open();
    });
  });
}

// ── Search ───────────────────────────────────────────────────

let _searchTimer = null;
elSearch.addEventListener("input", () => {
  clearTimeout(_searchTimer);
  _searchTimer = setTimeout(() => {
    if (_lastRes) render(_lastRes, elSearch.value);
  }, 120);
});

// ── Boot & live sync ─────────────────────────────────────────

async function requestState(kind) {
  const msg = kind === "refresh" ? { type: "SYNC_NOW" } : { type: "GET_STATE" };
  const res = await browser.runtime.sendMessage(msg);
  if (!res?.ok) throw new Error(res?.error || "Unknown error");
  return res;
}

async function boot() {
  setLoading(true); clearError();
  try {
    await loadCollapsedState();
    render(await requestState("get"));
  } catch (e) { showError(e?.message ?? String(e)); }
  finally { setLoading(false); }
}

linkOptions.addEventListener("click", ev => {
  ev.preventDefault();
  browser.runtime.openOptionsPage();
});

if (btnHeaderSettings) {
  btnHeaderSettings.addEventListener("click", ev => {
    ev.preventDefault();
    browser.runtime.openOptionsPage();
  });
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local") {
    if (changes.useThemeColors) {
      syncAllThemeColors();
    }
    if (changes.collapsedState) {
      _collapsedState = changes.collapsedState.newValue || {};
      if (_lastRes) render(_lastRes, elSearch.value);
    }
    return;
  }
  if (area !== "sync") return;
  if (!Object.keys(changes).some(k => k.startsWith("tgs_v2_") || k === "syncedTabGroups_v1")) return;
  requestState("get")
    .then(res => render(res, elSearch.value))
    .catch(e => showError(e?.message ?? String(e)));
});

/**
 * Automatically maps specific Firefox theme colors to CSS variables.
 * Only loads a small set of variables used by the UI to reduce footprint.
 */
async function syncAllThemeColors() {
  try {
    const { useThemeColors } = await browser.storage.local.get("useThemeColors");
    const root = document.documentElement;
    
    // Explicitly map only the colors we use in CSS
    const mapping = {
      'sidebar': '--theme-sidebar',
      'sidebar_text': '--theme-sidebar-text',
      'accent_color': '--theme-accent-color',
      'toolbar': '--theme-toolbar',
      'toolbar_text': '--theme-toolbar-text',
      'frame': '--theme-frame'
    };

    if (useThemeColors === false) {
      // Clear theme variables to use defaults
      Object.values(mapping).forEach(varName => {
        root.style.removeProperty(varName);
      });
      return;
    }

    const theme = await browser.theme.getCurrent();
    if (theme && theme.colors) {
      Object.entries(mapping).forEach(([key, varName]) => {
        const value = theme.colors[key];
        if (value) {
          root.style.setProperty(varName, value);
        }
      });
    }
  } catch (err) {
    console.error("Error syncing theme:", err);
  }
}

// Run on load
syncAllThemeColors();

// Report system dark mode to background (helps for "Auto" theme detection)
function reportSystemTheme() {
  const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  browser.runtime.sendMessage({ type: "SYSTEM_THEME_REPORT", isDark }).catch(() => {});
}
reportSystemTheme();
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', reportSystemTheme);

// Update live if the user switches themes
browser.theme.onUpdated.addListener(syncAllThemeColors);

boot();
