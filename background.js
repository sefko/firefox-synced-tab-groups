/**
 * Tab Groups Sync — background service worker (Manifest V3)
 *
 * Sync strategy:
 * - Each device writes ONLY its own key in browser.storage.sync (Firefox Sync), e.g.
 *   `tgs_v2_<deviceUuid>`. Firefox merges independent sync keys per extension; a single
 *   shared JSON blob would frequently see last-write-wins and one machine would wipe the
 *   others’ nested `devices` map.
 * - Snapshots are compacted to stay under Firefox’s per-item limit (~8192 bytes); larger
 *   payloads caused storage.sync.set to fail so nothing was stored and other PCs saw nothing.
 * - One-time migration: legacy blob key `syncedTabGroups_v1` is split into per-device keys
 *   then removed.
 * - Each snapshot describes ONLY the last-focused non-private "normal" window the user
 *   interacted with (see captureWindowSnapshot). Tab/tab-group events reschedule a
 *   debounced write so we do not hammer Sync quotas.
 * - tabGroups.* and tabs.* (groupId) are Firefox 138+ APIs; we still guard calls so the
 *   worker fails softly if APIs are missing.
 */

/** Legacy: one object { devices: { ... } } — causes cross-device overwrites; migrated away. */
const LEGACY_SYNC_BLOB_KEY = "syncedTabGroups_v1";
/** Per-device snapshot: value shape { deviceName, lastSync, groups, ungroupedTabs }. */
const DEVICE_SNAPSHOT_KEY_PREFIX = "tgs_v2_";

const LOCAL_DEVICE_ID_KEY = "deviceId";
const LOCAL_DEVICE_NAME_KEY = "deviceDisplayName";

/** Firefox exposes WINDOW_ID_NONE; fall back to -1 if missing. */
const WIN_NONE =
  browser.windows && typeof browser.windows.WINDOW_ID_NONE === "number" ? browser.windows.WINDOW_ID_NONE : -1;

/** Debounce window -> timer id */
const debounceTimers = new Map();
const DEBOUNCE_MS = 450;

/** Serialize concurrent Sync writes */
let syncWriteChain = Promise.resolve();

/** Cache the device ID promise to avoid concurrent generation/re-claim races */
let deviceIdPromise = null;

/** Store the last known system dark mode preference reported by the sidebar */
let lastKnownSystemIsDark = false;

/**
 * Firefox sync quota: max ~8192 bytes per key including key name + JSON value (see MDN storage.sync).
 * Large favicon URLs (e.g. data:…) often made the whole entry exceed the limit — set() then rejects
 * and nothing appears in sync, so other devices never see this machine.
 */
const SYNC_MAX_ITEM_BYTES = 7800;

/** Last sync write outcome (for sidebar diagnostics). */
let lastSyncWriteError = null;
let lastSyncWriteOkAt = null;

function truncateStr(s, max) {
  const t = String(s || "");
  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 1))}…`;
}

function normalizeColor(color) {
  const allowed = new Set(["blue", "cyan", "grey", "green", "orange", "pink", "purple", "red", "yellow"]);
  return allowed.has(color) ? color : "blue";
}

function safeFaviconForSync(url) {
  if (!url || typeof url !== "string") return undefined;
  if (url.startsWith("data:") || url.length > 512) return undefined;
  try {
    const u = new URL(url);
    if (u.protocol === "http:" || u.protocol === "https:") return truncateStr(url, 512);
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Shrink payload: no giant data URLs, bounded strings — must fit under SYNC_MAX_ITEM_BYTES.
 */
function compactSnapshotForSync(snapshot) {
  const out = {
    lastSync: snapshot.lastSync,
    deviceName: truncateStr(snapshot.deviceName || "", 120),
    groups: [],
    ungroupedTabs: [],
  };
  for (const g of snapshot.groups || []) {
    const gOut = {
      groupId: String(g.groupId || ""),
      title: truncateStr(g.title || "Group", 120),
      color: normalizeColor(g.color || "blue"),
      tabs: [],
    };
    for (const t of g.tabs || []) {
      const fav = safeFaviconForSync(t.favIconUrl);
      const tabOut = {
        url: truncateStr(t.url || "", 2048),
        title: truncateStr(t.title || "", 220),
      };
      if (fav) tabOut.favIconUrl = fav;
      gOut.tabs.push(tabOut);
    }
    out.groups.push(gOut);
  }
  for (const t of snapshot.ungroupedTabs || []) {
    const fav = safeFaviconForSync(t.favIconUrl);
    const tabOut = {
      url: truncateStr(t.url || "", 2048),
      title: truncateStr(t.title || "", 220),
    };
    if (fav) tabOut.favIconUrl = fav;
    out.ungroupedTabs.push(tabOut);
  }
  return out;
}

function estimateSyncItemBytes(deviceId, snapshot) {
  const key = `${DEVICE_SNAPSHOT_KEY_PREFIX}${deviceId}`;
  try {
    return new Blob([JSON.stringify({ [key]: snapshot })]).size;
  } catch {
    return Infinity;
  }
}

function trimOneTabEntry(snap) {
  if (snap.ungroupedTabs && snap.ungroupedTabs.length > 0) {
    snap.ungroupedTabs.pop();
    return true;
  }
  const groups = snap.groups || [];
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i];
    if (g.tabs && g.tabs.length > 0) {
      g.tabs.pop();
      if (g.tabs.length === 0) groups.splice(i, 1);
      return true;
    }
    groups.splice(i, 1);
  }
  return false;
}

function trimSnapshotToFit(deviceId, snapshot) {
  let s = compactSnapshotForSync(snapshot);
  let guard = 0;
  while (estimateSyncItemBytes(deviceId, s) > SYNC_MAX_ITEM_BYTES && guard++ < 2000) {
    if (!trimOneTabEntry(s)) break;
  }
  return s;
}

function getTabGroupsNone() {
  if (browser.tabGroups && typeof browser.tabGroups.TAB_GROUP_ID_NONE === "number") {
    return browser.tabGroups.TAB_GROUP_ID_NONE;
  }
  return -1;
}

function isUsableUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" || u.protocol === "file:";
  } catch {
    return false;
  }
}

/**
 * Helper to compare two snapshots by tab URLs. Returns 0..1.
 */
function calculateSnapshotSimilarity(s1, s2) {
  const getUrls = (snap) => {
    const urls = [];
    if (snap.groups) {
      for (const g of snap.groups) {
        if (g.tabs) {
          for (const t of g.tabs) if (t.url) urls.push(t.url);
        }
      }
    }
    if (snap.ungroupedTabs) {
      for (const t of snap.ungroupedTabs) if (t.url) urls.push(t.url);
    }
    return urls;
  };

  const u1 = getUrls(s1);
  const u2 = getUrls(s2);
  if (u1.length === 0 && u2.length === 0) return 1.0;
  if (u1.length === 0 || u2.length === 0) return 0.0;

  const set1 = new Set(u1);
  const set2 = new Set(u2);
  let intersect = 0;
  for (const u of set1) {
    if (set2.has(u)) intersect++;
  }
  return intersect / Math.max(set1.size, set2.size);
}

/**
 * Ensure a stable random device id (service workers have no localStorage — use storage.local).
 * If no local id exists, try to re-claim an existing one from storage.sync by matching
 * device name and current window contents.
 */
async function ensureDeviceId() {
  if (deviceIdPromise) return deviceIdPromise;
  deviceIdPromise = (async () => {
    const { [LOCAL_DEVICE_ID_KEY]: existing } = await browser.storage.local.get(LOCAL_DEVICE_ID_KEY);
    if (existing) return existing;

    // No local ID. Let's see if we can re-claim one from Sync.
    // On a fresh install/re-install, storage.sync might take a moment to pull data from the server.
    // We try twice with a small delay if the first attempt finds nothing.
    let devices = [];
    const name = await getDeviceDisplayName();

    for (let attempt = 0; attempt < 2; attempt++) {
      const allSync = await browser.storage.sync.get(null);
      devices = [];
      for (const [k, v] of Object.entries(allSync)) {
        if (k.startsWith(DEVICE_SNAPSHOT_KEY_PREFIX)) {
          const id = k.slice(DEVICE_SNAPSHOT_KEY_PREFIX.length);
          if (id && v && typeof v === "object") {
            devices.push({ id, snapshot: v });
          }
        }
      }

      if (devices.length > 0) {
        const win = await getLastFocusedNormalWindow().catch(() => null);
        if (win && !win.incognito) {
          const currentSnap = await captureWindowSnapshot(win.id).catch(() => null);
          if (currentSnap) {
            let bestId = null;
            let bestScore = 0;
            for (const d of devices) {
              const score = calculateSnapshotSimilarity(currentSnap, d.snapshot);
              if (score > bestScore) {
                bestScore = score;
                bestId = d.id;
              }
            }
            // High confidence match by tabs (even if name changed)
            if (bestId && bestScore > 0.8) {
              await browser.storage.local.set({ [LOCAL_DEVICE_ID_KEY]: bestId });
              return bestId;
            }
          }
        }

        // No strong tab match. Fall back to matching by device name if name is custom.
        const { [LOCAL_DEVICE_NAME_KEY]: customName } = await browser.storage.local.get(LOCAL_DEVICE_NAME_KEY);
        if (customName && customName.trim()) {
          const nameMatches = devices.filter((d) => d.snapshot.deviceName === name);
          if (nameMatches.length === 1) {
            const bestId = nameMatches[0].id;
            await browser.storage.local.set({ [LOCAL_DEVICE_ID_KEY]: bestId });
            return bestId;
          }
        }
        
        // If we found devices but none matched, don't wait for more (Sync is probably up to date)
        break;
      }

      if (attempt === 0) {
        // Wait 1.5s for Sync to potentially pull data on first run
        await new Promise(r => setTimeout(r, 1500));
      }
    }

    const id = crypto.randomUUID();
    await browser.storage.local.set({ [LOCAL_DEVICE_ID_KEY]: id });
    return id;
  })();
  return deviceIdPromise;
}

/**
 * Human-readable label: optional override from options, else "Firefox on Windows" style.
 */
async function getDeviceDisplayName() {
  const { [LOCAL_DEVICE_NAME_KEY]: custom } = await browser.storage.local.get(LOCAL_DEVICE_NAME_KEY);
  if (custom && String(custom).trim()) return String(custom).trim();

  const [browserInfo, platformInfo] = await Promise.all([
    browser.runtime.getBrowserInfo(),
    browser.runtime.getPlatformInfo(),
  ]);

  const osMap = {
    win: "Windows",
    mac: "macOS",
    linux: "Linux",
    android: "Android",
    openbsd: "OpenBSD",
    cros: "Chrome OS",
  };
  const osLabel = osMap[platformInfo.os] || platformInfo.os;
  return `${browserInfo.name} on ${osLabel}`;
}

/**
 * If an old install stored everyone in one blob, split into per-device keys once so Sync
 * can merge machines without clobbering.
 */
async function migrateLegacyIfNeededOnce() {
  const bag = await browser.storage.sync.get(LEGACY_SYNC_BLOB_KEY);
  const legacy = bag[LEGACY_SYNC_BLOB_KEY];
  if (!legacy || typeof legacy !== "object" || !legacy.devices || typeof legacy.devices !== "object") {
    return;
  }
  const toSet = {};
  for (const [did, snap] of Object.entries(legacy.devices)) {
    if (did && snap && typeof snap === "object") {
      toSet[`${DEVICE_SNAPSHOT_KEY_PREFIX}${did}`] = snap;
    }
  }
  if (Object.keys(toSet).length > 0) {
    await browser.storage.sync.set(toSet);
  }
  await browser.storage.sync.remove(LEGACY_SYNC_BLOB_KEY);
}

async function readSyncPayload() {
  await migrateLegacyIfNeededOnce();
  const all = await browser.storage.sync.get(null);
  const devices = {};
  for (const [k, v] of Object.entries(all)) {
    if (!k.startsWith(DEVICE_SNAPSHOT_KEY_PREFIX)) continue;
    const id = k.slice(DEVICE_SNAPSHOT_KEY_PREFIX.length);
    if (id && v && typeof v === "object") devices[id] = v;
  }
  // If migration hasn’t run on another synced client yet, still surface legacy devices.
  // But avoid duplicates if the same data already exists under a new key.
  const legacy = all[LEGACY_SYNC_BLOB_KEY];
  if (legacy && legacy.devices && typeof legacy.devices === "object") {
    for (const [id, snap] of Object.entries(legacy.devices)) {
      if (!(id in devices) && snap && typeof snap === "object") {
        // Check if this legacy device is already present with a different ID
        const isDuplicate = Object.values(devices).some(d => 
          d.deviceName === snap.deviceName && 
          calculateSnapshotSimilarity(d, snap) > 0.95
        );
        if (!isDuplicate) {
          devices[id] = snap;
        }
      }
    }
  }
  return { devices };
}

async function writeDeviceSnapshot(deviceId, snapshot) {
  syncWriteChain = syncWriteChain.then(async () => {
    try {
      await migrateLegacyIfNeededOnce();
      const key = `${DEVICE_SNAPSHOT_KEY_PREFIX}${deviceId}`;
      const compact = trimSnapshotToFit(deviceId, snapshot);
      await browser.storage.sync.set({ [key]: compact });
      lastSyncWriteError = null;
      lastSyncWriteOkAt = Date.now();
    } catch (err) {
      lastSyncWriteError = err && err.message ? err.message : String(err);
      console.error("[TabGroupsSync] sync write failed", err);
    }
  });
  return syncWriteChain;
}

async function collectDiagnostics() {
  const deviceId = await ensureDeviceId();
  const deviceName = await getDeviceDisplayName();
  let syncBytes = null;
  let syncKeyCount = 0;
  let storageReadError = null;
  try {
    syncBytes = await browser.storage.sync.getBytesInUse(null);
    const all = await browser.storage.sync.get(null);
    syncKeyCount = Object.keys(all).length;
  } catch (e) {
    storageReadError = e && e.message ? e.message : String(e);
  }
  return {
    extensionId: browser.runtime.id,
    thisDeviceId: deviceId,
    deviceName,
    syncBytes,
    syncKeyCount,
    storageReadError,
    lastSyncWriteError,
    lastSyncWriteOkAt,
  };
}

/**
 * Build a serializable snapshot for one normal window: tab groups + ungrouped tabs.
 * Uses tabs.query({ windowId }) and tabGroups.get per group id.
 */
async function captureWindowSnapshot(windowId) {
  const win = await browser.windows.get(windowId, { populate: false });
  if (win.incognito) return null;

  const tabs = await browser.tabs.query({ windowId });
  const noneId = getTabGroupsNone();

  /** @type {Map<number, any[]>} */
  const byGroup = new Map();
  /** @type {any[]} */
  const ungrouped = [];

  for (const tab of tabs) {
    const url = tab.url || tab.pendingUrl;
    if (!isUsableUrl(url)) continue;

    const gid = tab.groupId;
    if (gid === undefined || gid === noneId) {
      ungrouped.push(tab);
    } else {
      if (!byGroup.has(gid)) byGroup.set(gid, []);
      byGroup.get(gid).push(tab);
    }
  }

  for (const arr of byGroup.values()) {
    arr.sort((a, b) => a.index - b.index);
  }
  ungrouped.sort((a, b) => a.index - b.index);

  const groups = [];

  for (const [groupId, groupTabs] of byGroup.entries()) {
    let title = "Group";
    let color = "blue";
    try {
      if (browser.tabGroups && browser.tabGroups.get) {
        const meta = await browser.tabGroups.get(groupId);
        title = meta.title || title;
        color = normalizeColor(meta.color || color);
      }
    } catch {
      // Group may have been removed between query and get — skip empty groups later
    }
    const minIndex = Math.min(...groupTabs.map((t) => t.index));
    groups.push({
      groupId: String(groupId),
      title,
      color,
      minIndex,
      tabs: groupTabs.map((t) => ({
        url: t.url || t.pendingUrl,
        title: t.title || (t.url || ""),
        favIconUrl: t.favIconUrl,
      })),
    });
  }

  groups.sort((a, b) => a.minIndex - b.minIndex);
  for (const g of groups) delete g.minIndex;

  const snapshot = {
    lastSync: Date.now(),
    groups: groups.filter((g) => g.tabs.length > 0),
    ungroupedTabs: ungrouped.map((t) => ({
      url: t.url || t.pendingUrl,
      title: t.title || (t.url || ""),
      favIconUrl: t.favIconUrl,
    })),
  };

  return snapshot;
}

async function syncWindowNow(windowId) {
  if (!windowId || windowId === WIN_NONE) return;

  const win = await browser.windows.get(windowId, { populate: false }).catch(() => null);
  if (!win || win.incognito) return;

  const deviceId = await ensureDeviceId();
  const deviceName = await getDeviceDisplayName();
  const snap = await captureWindowSnapshot(windowId);
  if (!snap) return;

  await writeDeviceSnapshot(deviceId, {
    ...snap,
    deviceName,
  });
}

function scheduleSyncForWindow(windowId) {
  if (!windowId || windowId === WIN_NONE) return;

  const prev = debounceTimers.get(windowId);
  if (prev) clearTimeout(prev);

  const t = setTimeout(() => {
    debounceTimers.delete(windowId);
    syncWindowNow(windowId).catch((err) => console.error("[TabGroupsSync] sync failed", err));
  }, DEBOUNCE_MS);

  debounceTimers.set(windowId, t);
}

/**
 * Immediately snapshot the last-focused normal window (used by Refresh and startup).
 * Event-driven updates use scheduleSyncForWindow to avoid exceeding storage.sync write limits.
 */
async function getLastFocusedNormalWindow() {
  try {
    return await browser.windows.getLastFocused({ windowTypes: ["normal"] });
  } catch {
    // Some builds may not accept windowTypes — fall back to the generic API.
    return await browser.windows.getLastFocused();
  }
}

async function syncLastFocusedImmediate() {
  try {
    const w = await getLastFocusedNormalWindow();
    if (!w || w.incognito) return;
    await syncWindowNow(w.id);
  } catch (e) {
    console.warn("[TabGroupsSync] getLastFocused failed", e);
  }
}

async function assertNotPrivateCurrentWindow() {
  const w = await browser.windows.getCurrent();
  if (w.incognito) {
    throw new Error("Cannot restore synced tabs into a private window.");
  }
}

function normalizeGroupTitle(title) {
  return String(title || "")
    .trim()
    .toLowerCase();
}

async function getCurrentWindowStateForLoad() {
  const w = await browser.windows.getCurrent();
  const tabs = await browser.tabs.query({ windowId: w.id });
  const existingUrls = new Set();
  const groupIdToTitle = new Map();
  const titleToGroupId = new Map();
  const noneId = getTabGroupsNone();
  const groupIds = new Set();

  for (const tab of tabs) {
    if (isUsableUrl(tab.url)) existingUrls.add(tab.url);
    if (tab.groupId !== undefined && tab.groupId !== noneId) groupIds.add(tab.groupId);
  }

  for (const gid of groupIds) {
    try {
      const meta = await browser.tabGroups.get(gid);
      const t = meta && meta.title ? meta.title : "Group";
      groupIdToTitle.set(gid, t);
      const key = normalizeGroupTitle(t);
      if (key && !titleToGroupId.has(key)) titleToGroupId.set(key, gid);
    } catch {
      // ignore race where group disappears during lookup
    }
  }

  return { existingUrls, titleToGroupId };
}

/**
 * Open tabs for one logical group, then call tabs.group + tabGroups.update to match Firefox APIs
 * (group creation is via tabs.group; title/color via tabGroups.update).
 */
async function loadGroupIntoCurrentWindow(group) {
  if (!browser.tabs || !browser.tabs.group) {
    throw new Error("tabs.group is not available in this Firefox build.");
  }

  await assertNotPrivateCurrentWindow();

  const state = await getCurrentWindowStateForLoad();
  const desiredTitle = group.title || "Group";
  const existingGroupId = state.titleToGroupId.get(normalizeGroupTitle(desiredTitle));

  const tabIds = [];
  for (const entry of group.tabs || []) {
    if (!isUsableUrl(entry.url)) continue;
    // If a group with the same title exists locally, only add tabs that aren't already open.
    if (existingGroupId !== undefined && state.existingUrls.has(entry.url)) continue;
    const created = await browser.tabs.create({ url: entry.url, active: false });
    state.existingUrls.add(entry.url);
    tabIds.push(created.id);
  }
  if (tabIds.length === 0) return;

  const gid =
    existingGroupId !== undefined
      ? await browser.tabs.group({ groupId: existingGroupId, tabIds })
      : await browser.tabs.group({ tabIds });
  if (existingGroupId === undefined && browser.tabGroups && browser.tabGroups.update) {
    await browser.tabGroups.update(gid, {
      title: desiredTitle,
      color: normalizeColor(group.color || "blue"),
    });
  }
}

async function loadUngroupedIntoCurrentWindow(ungroupedTabs) {
  await assertNotPrivateCurrentWindow();
  for (const t of ungroupedTabs || []) {
    if (!isUsableUrl(t.url)) continue;
    await browser.tabs.create({ url: t.url, active: false });
  }
}

/**
 * Activate (or create+group) a single tab URL inside the desired group.
 *
 * Behavior:
 * - If a matching URL already exists anywhere, reuse it (no new tab).
 * - For named groups: ensure the matching tab ends up inside the group (by group title),
 *   then activate it.
 * - For ungrouped: activate the matching tab; otherwise create a new ungrouped tab.
 */
async function openTabIntoCurrentWindow({ url, groupKind, groupTitle, groupColor }) {
  await assertNotPrivateCurrentWindow();

  if (!isUsableUrl(url)) {
    throw new Error("Unsupported or missing URL.");
  }

  const w = await browser.windows.getCurrent();
  const windowId = w.id;

  const allTabs = await browser.tabs.query({ windowId });
  const desiredUrl = String(url);
  const existingTab =
    allTabs.find((t) => (t.url && t.url === desiredUrl) || (t.pendingUrl && t.pendingUrl === desiredUrl)) ||
    null;

  // Ungrouped: just activate (or create ungrouped).
  if (groupKind !== "named") {
    if (existingTab) {
      await browser.tabs.update(existingTab.id, { active: true });
      return;
    }
    await browser.tabs.create({ windowId, url: desiredUrl, active: true });
    return;
  }

  if (!browser.tabs || !browser.tabs.group) {
    throw new Error("tabs.group is not available in this Firefox build.");
  }

  const state = await getCurrentWindowStateForLoad();
  const desiredTitle = groupTitle || "Group";
  const existingGroupId = state.titleToGroupId.get(normalizeGroupTitle(desiredTitle));
  const desiredColor = normalizeColor(groupColor || "blue");

  // Named groups: reuse existing tab (if any) and ensure it is in the right group.
  if (existingTab) {
    if (existingGroupId !== undefined) {
      if (existingTab.groupId !== existingGroupId) {
        await browser.tabs.group({ groupId: existingGroupId, tabIds: [existingTab.id] });
      }
    } else {
      const gid = await browser.tabs.group({ tabIds: [existingTab.id] });
      if (browser.tabGroups && browser.tabGroups.update) {
        await browser.tabGroups.update(gid, { title: desiredTitle, color: desiredColor });
      }
    }

    await browser.tabs.update(existingTab.id, { active: true });
    return;
  }

  // No existing match: create a new tab and group it.
  const created = await browser.tabs.create({ windowId, url: desiredUrl, active: false });

  if (existingGroupId !== undefined) {
    await browser.tabs.group({ groupId: existingGroupId, tabIds: [created.id] });
  } else {
    const gid = await browser.tabs.group({ tabIds: [created.id] });
    if (browser.tabGroups && browser.tabGroups.update) {
      await browser.tabGroups.update(gid, { title: desiredTitle, color: desiredColor });
    }
  }

  await browser.tabs.update(created.id, { active: true });
}

async function loadDeviceIntoCurrentWindow(devicePayload) {
  const groups = devicePayload.groups || [];
  const ungrouped = devicePayload.ungroupedTabs || [];
  if (groups.length === 0 && ungrouped.length === 0) return;

  // If there are no grouped tabs, loadGroupIntoCurrentWindow won't run — still block private windows.
  if (groups.length === 0) {
    await assertNotPrivateCurrentWindow();
  }

  for (const g of groups) {
    await loadGroupIntoCurrentWindow(g);
  }

  await loadUngroupedIntoCurrentWindow(ungrouped);
}

// --- Event wiring: any tab/group change or window focus reschedules sync for the relevant window ---

async function updateThemeIcons(updateInfo) {
  try {
    const theme = (updateInfo && updateInfo.theme) || (await browser.theme.getCurrent());
    const colors = theme?.colors || {};

    // 1. Determine toolbar icon (browser.action)
    // Preference: use toolbar_text luminance if available, else toolbar/frame background
    let toolbarIsDark = false;
    if (colors.toolbar_text) {
      toolbarIsDark = !isDarkColor(colors.toolbar_text); // If text is light, background is dark
    } else if (colors.toolbar || colors.frame || colors.accent_color) {
      toolbarIsDark = isDarkColor(colors.toolbar || colors.frame || colors.accent_color);
    } else {
      // Default / Auto theme with no colors reported — use system preference
      toolbarIsDark = lastKnownSystemIsDark;
    }

    // 2. Determine sidebar icon (browser.sidebarAction)
    // Preference: use sidebar_text luminance if available, else sidebar background
    let sidebarIsDark = false;
    if (colors.sidebar_text) {
      sidebarIsDark = !isDarkColor(colors.sidebar_text); // If text is light, background is dark
    } else if (colors.sidebar) {
      sidebarIsDark = isDarkColor(colors.sidebar);
    } else {
      sidebarIsDark = toolbarIsDark; // Fallback to toolbar setting
    }

    const toolbarSuffix = toolbarIsDark ? "dark" : "light";
    const sidebarSuffix = sidebarIsDark ? "dark" : "light";

    const toolbarIcons = {
      16: `icons/icon-${toolbarSuffix}-16.svg`,
      32: `icons/icon-${toolbarSuffix}-32.svg`,
      48: `icons/icon-${toolbarSuffix}-48.svg`
    };

    const sidebarIcons = {
      16: `icons/icon-${sidebarSuffix}-16.svg`,
      32: `icons/icon-${sidebarSuffix}-32.svg`,
      48: `icons/icon-${sidebarSuffix}-48.svg`
    };

    await Promise.all([
      browser.action.setIcon({ path: toolbarIcons }),
      browser.sidebarAction.setIcon({ path: sidebarIcons })
    ].map(p => p.catch(err => console.warn("[TabGroupsSync] setIcon failed", err))));
    
  } catch (e) {
    console.warn("[TabGroupsSync] Failed to update theme icons", e);
  }
}

/**
 * Simple heuristic to determine if a color is "dark".
 * Accepts hex strings like "#ffffff" or "#000", and rgb(r, g, b).
 */
function isDarkColor(color) {
  if (!color) return false;
  let r, g, b;

  if (typeof color === "string") {
    if (color.startsWith("#")) {
      const hex = color.slice(1);
      if (hex.length === 3) {
        r = parseInt(hex[0] + hex[0], 16);
        g = parseInt(hex[1] + hex[1], 16);
        b = parseInt(hex[2] + hex[2], 16);
      } else if (hex.length === 6) {
        r = parseInt(hex.slice(0, 2), 16);
        g = parseInt(hex.slice(2, 4), 16);
        b = parseInt(hex.slice(4, 6), 16);
      }
    } else if (color.startsWith("rgb")) {
      const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (match) {
        r = parseInt(match[1], 10);
        g = parseInt(match[2], 10);
        b = parseInt(match[3], 10);
      }
    }
  } else if (Array.isArray(color) && color.length >= 3) {
    // Some older Firefox versions might return [r, g, b]
    [r, g, b] = color;
  }

  if (r === undefined) return false;
  // standard relative luminance formula
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luma < 128;
}

if (browser.theme && browser.theme.onUpdated) {
  browser.theme.onUpdated.addListener(updateThemeIcons);
}

function syncSoon(windowId) {
  scheduleSyncForWindow(windowId);
}

function syncImmediately(windowId) {
  if (!windowId || windowId === WIN_NONE) return;
  syncWindowNow(windowId).catch((err) => console.error("[TabGroupsSync] immediate sync failed", err));
}

browser.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === WIN_NONE) return;
  browser.windows
    .get(windowId)
    .then((w) => {
      if (w && !w.incognito) syncSoon(windowId);
    })
    .catch(() => {});
});

browser.tabs.onActivated.addListener((activeInfo) => {
  syncSoon(activeInfo.windowId);
});

browser.tabs.onCreated.addListener((tab) => {
  if (tab.windowId) syncImmediately(tab.windowId);
});

browser.tabs.onUpdated.addListener((_id, _changeInfo, tab) => {
  if (tab.windowId) syncSoon(tab.windowId);
});

browser.tabs.onRemoved.addListener((_tabId, removeInfo) => {
  if (removeInfo.windowId) syncImmediately(removeInfo.windowId);
});

browser.tabs.onMoved.addListener((_id, moveInfo) => {
  syncSoon(moveInfo.windowId);
});

if (browser.tabGroups) {
  browser.tabGroups.onCreated.addListener((group) => {
    if (group && group.windowId) syncImmediately(group.windowId);
  });
  browser.tabGroups.onUpdated.addListener((group) => {
    if (group && group.windowId) syncSoon(group.windowId);
  });
  browser.tabGroups.onMoved.addListener((group) => {
    if (group && group.windowId) syncSoon(group.windowId);
  });
  browser.tabGroups.onRemoved.addListener((group) => {
    if (group && group.windowId) syncImmediately(group.windowId);
  });
}

browser.runtime.onInstalled.addListener(() => {
  syncLastFocusedImmediate();
  updateThemeIcons();
});

browser.runtime.onStartup.addListener(() => {
  syncLastFocusedImmediate();
  updateThemeIcons();
});

// Toolbar icon opens the sidebar (no popup).
browser.action.onClicked.addListener(() => {
  browser.sidebarAction.open().catch(() => {});
});

browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return undefined;

  if (message.type === "SYSTEM_THEME_REPORT") {
    lastKnownSystemIsDark = !!message.isDark;
    updateThemeIcons();
    return;
  }

  if (message.type === "GET_STATE") {
    (async () => {
      const deviceId = await ensureDeviceId();
      const deviceName = await getDeviceDisplayName();
      const data = await readSyncPayload();
      const diag = await collectDiagnostics();
      sendResponse({ ok: true, deviceId, deviceName, data, diag });
    })().catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
    return true;
  }

  if (message.type === "SYNC_NOW") {
    (async () => {
      await syncLastFocusedImmediate();
      const deviceId = await ensureDeviceId();
      const deviceName = await getDeviceDisplayName();
      const data = await readSyncPayload();
      const diag = await collectDiagnostics();
      sendResponse({ ok: true, deviceId, deviceName, data, diag });
    })().catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
    return true;
  }

  if (message.type === "LOAD_DEVICE") {
    const { devicePayload } = message;
    (async () => {
      await loadDeviceIntoCurrentWindow(devicePayload);
      sendResponse({ ok: true });
    })().catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
    return true;
  }

  if (message.type === "LOAD_GROUP") {
    const { group } = message;
    (async () => {
      await loadGroupIntoCurrentWindow(group);
      sendResponse({ ok: true });
    })().catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
    return true;
  }

  if (message.type === "LOAD_UNGROUPED") {
    const { ungroupedTabs } = message;
    (async () => {
      await loadUngroupedIntoCurrentWindow(ungroupedTabs);
      sendResponse({ ok: true });
    })().catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
    return true;
  }

  if (message.type === "OPEN_TAB") {
    const { url, groupKind, groupTitle, groupColor } = message;
    (async () => {
      await openTabIntoCurrentWindow({ url, groupKind, groupTitle, groupColor });
      sendResponse({ ok: true });
    })().catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
    return true;
  }

  return undefined;
});

// Run theme icon sync on script load
updateThemeIcons();
