const BRIDGE_URL = "http://127.0.0.1:17318";
const CLIENT_NAME = `Pi ${chrome.runtime.id}`;
const POLL_ERROR_BACKOFF_MS = 2000;
// Safety-net fallback only: page.cdp always receives an explicit timeoutMs from pi. Generous so
// legacy/direct bridge users aren't killed mid-script; a stuck command still detaches at this
// cap.
const COMMAND_TIMEOUT_MS = 10 * 60_000;
const ATTACH_TIMEOUT_MS = 3_000;
const INPUT_IDLE_DETACH_MS = 15_000;
const CDP_VERSION = "1.3";
let polling = false;

// =================== pi-chrome automation target ownership ===================
// pi-chrome never hijacks the user's active tab. When a command runs without an explicit target
// (targetId/urlIncludes/titleIncludes), it routes to a dedicated automation target that
// pi-chrome created and owns: a separate Chrome window (fallback: a dedicated tab) so user
// windows are left untouched. Ownership is SESSION-SCOPED, keyed by the calling Pi session's
// `sessionKey` (forwarded on the wire), so concurrent Pi sessions each get their own window.
// State is mirrored to chrome.storage.session so an MV3 service-worker restart re-hydrates
// ownership instead of orphaning the window it already created.
const automationTargets = new Map(); // sessionKey -> { windowId?: number, tabId: number }
const DEFAULT_SESSION_KEY = "__default__";
const AUTOMATION_STORAGE_KEY = "piChromeAutomationTargets";
let automationHydrated = false;

function sessionKeyOf(params) {
  return params && typeof params.sessionKey === "string" && params.sessionKey
    ? params.sessionKey
    : DEFAULT_SESSION_KEY;
}

async function hydrateAutomationTargets() {
  if (automationHydrated) return;
  automationHydrated = true;
  try {
    const stored = await chrome.storage?.session?.get?.(AUTOMATION_STORAGE_KEY);
    const saved = stored && stored[AUTOMATION_STORAGE_KEY];
    if (saved && typeof saved === "object") {
      for (const [key, value] of Object.entries(saved)) {
        if (value && typeof value.tabId === "number") {
          automationTargets.set(key, {
            windowId: typeof value.windowId === "number" ? value.windowId : undefined,
            tabId: value.tabId,
          });
        }
      }
    }
  } catch {
    // Ignore: treat as "no persisted state".
  }
}

async function persistAutomationTargets() {
  try {
    const obj = {};
    for (const [key, value] of automationTargets) {
      obj[key] = { windowId: typeof value.windowId === "number" ? value.windowId : null, tabId: value.tabId };
    }
    await chrome.storage?.session?.set?.({ [AUTOMATION_STORAGE_KEY]: obj });
  } catch {
    // Ignore: persistence is an optimization, not a correctness requirement.
  }
}

// Create a fresh automation target for `sessionKey`: a dedicated background tab in an EXISTING
// window — never a new Chrome window. windowId stays unset so cleanup closes only our tab,
// never the user's window. No tab groups.
async function createAutomationTarget(sessionKey) {
  const tab = await chrome.tabs.create({ url: "about:blank", active: false });
  automationTargets.set(sessionKey, { windowId: undefined, tabId: typeof tab.id === "number" ? tab.id : undefined });
  await persistAutomationTargets();
  return tab;
}

// Return the session's owned automation target if it still exists, else null. Robust to the user
// (or Chrome) having closed it: a stale entry is forgotten so callers can recreate cleanly.
async function resolveOwnedAutomationTarget(sessionKey) {
  await hydrateAutomationTargets();
  const t = automationTargets.get(sessionKey);
  if (!t || typeof t.tabId !== "number") return null;
  const existing = await chrome.tabs.get(t.tabId).catch(() => null);
  if (existing && typeof existing.id === "number") return existing;
  automationTargets.delete(sessionKey);
  await persistAutomationTargets();
  return null;
}

async function getOrCreateAutomationTarget(sessionKey) {
  return (await resolveOwnedAutomationTarget(sessionKey)) || createAutomationTarget(sessionKey);
}

// Close only the session's pi-chrome-owned window/tab, and only if it still exists. Never touches
// user tabs/windows or other sessions' targets. Safe to call repeatedly and when nothing exists.
async function cleanupAutomationTarget(sessionKey) {
  await hydrateAutomationTargets();
  const t = automationTargets.get(sessionKey);
  automationTargets.delete(sessionKey);
  await persistAutomationTargets();
  if (!t) return { closedWindowId: null, closedTabId: null };
  const { windowId, tabId } = t;
  if (typeof windowId === "number" && chrome.windows && typeof chrome.windows.remove === "function") {
    const win = await chrome.windows.get(windowId).catch(() => null);
    if (win) {
      await chrome.windows.remove(windowId).catch(() => {});
      return { closedWindowId: windowId, closedTabId: typeof tabId === "number" ? tabId : null };
    }
  }
  if (typeof tabId === "number") {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab) {
      await chrome.tabs.remove(tabId).catch(() => {});
      return { closedWindowId: null, closedTabId: tabId };
    }
  }
  return { closedWindowId: null, closedTabId: null };
}

function withTimeout(promise, ms, label, onTimeout) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(async () => {
        try { await onTimeout?.(); } catch {}
        reject(new Error(`${label} timed out after ${ms}ms`));
      }, ms);
    }),
  ]);
}

// =================== Chrome debugger (CDP) layer ===================
const attachedTabs = new Map(); // tabId -> { detachAt: number, debuggee }
// Tabs with active session-scoped emulation (Emulation.* / Network.emulateNetworkConditions /
// CSS.forcePseudoState). CDP clears these overrides when the debugger detaches (same as closing
// DevTools), so we hold the debugger attached while any override is active.
const emulatedTabs = new Set();
// Tabs with an in-flight CDP command. The idle auto-detach must never fire mid-command, or the
// running command dies with "Detached while handling command".
const busyTabs = new Set();

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Last few attach failures, kept for diagnostics.
const attachDebugLog = [];
function recordAttachEvent(entry) {
  attachDebugLog.push({ ...entry, t: Date.now() });
  if (attachDebugLog.length > 20) attachDebugLog.shift();
}

async function pageDebuggeeForTab(tabId) {
  const targets = await new Promise((resolve) => chrome.debugger.getTargets((t) => resolve(t || []))).catch(() => []);
  // A page target for this tab, excluding protected chrome:// / extension / devtools URLs.
  const target = targets.find((t) => {
    const url = String(t?.url || "");
    return t?.tabId === tabId && t?.type === "page" && !url.startsWith("chrome://") && !url.startsWith("chrome-extension://") && !url.startsWith("devtools://");
  });
  return target?.id ? { targetId: target.id } : { tabId };
}

async function debuggerAttachRaw(tabId, preferredDebuggee) {
  const debuggee = preferredDebuggee || { tabId };
  await withTimeout(
    chrome.debugger.attach(debuggee, CDP_VERSION),
    ATTACH_TIMEOUT_MS,
    `Chrome debugger attach to tab ${tabId}`,
    async () => {
      attachedTabs.delete(tabId);
      try { await chrome.debugger.detach(debuggee); } catch {}
    },
  );
  return debuggee;
}

async function attachDebugger(tabId) {
  if (!chrome.debugger) throw new Error("chrome.debugger API unavailable; reload the extension to grant the new permission");
  if (attachedTabs.has(tabId)) {
    const entry = attachedTabs.get(tabId);
    entry.detachAt = Date.now() + INPUT_IDLE_DETACH_MS;
    return entry;
  }
  // Before each attach, force-detach any stale CDP target this extension owns on the tab.
  // Chrome sometimes keeps a half-dead session around (extension reload mid-attach, etc.) and
  // surfaces it as "Cannot access a chrome-extension://" on the next attach attempt.
  try {
    const targets = await new Promise((resolve) => chrome.debugger.getTargets((t) => resolve(t || [])));
    for (const tgt of targets) {
      if (tgt.tabId === tabId && tgt.attached) {
        recordAttachEvent({ kind: "stale-target-found", tabId, target: { id: tgt.id, type: tgt.type, url: tgt.url, extensionId: tgt.extensionId } });
        try { await chrome.debugger.detach({ tabId }); } catch {}
        await sleep(80);
        break;
      }
    }
  } catch {}
  let attachedDebuggee = null;
  const attemptAttach = async (debuggee) => {
    try {
      attachedDebuggee = await debuggerAttachRaw(tabId, debuggee);
      return null;
    } catch (error) {
      return error;
    }
  };
  const retryPageTargetIfExtensionBlocked = async (err, kind) => {
    if (!/Cannot access a chrome-extension:\/\/ URL of different extension/i.test(String(err?.message || err))) return err;
    const pageDebuggee = await pageDebuggeeForTab(tabId);
    recordAttachEvent({ kind, tabId, debuggee: pageDebuggee });
    return attemptAttach(pageDebuggee);
  };
  let err = await attemptAttach();
  if (err) err = await retryPageTargetIfExtensionBlocked(err, "attach-page-target-retry");
  if (err) {
    const msg = String(err?.message || err);
    const transient = /Cannot access a chrome-extension|Cannot access contents of|No tab with id|Debugger is not attached|Another debugger|Target closed/i.test(msg);
    const tabSnapshot = await chrome.tabs.get(tabId).catch(() => null);
    recordAttachEvent({ kind: "attach-failed", tabId, message: msg, tabUrl: tabSnapshot?.url, transient });
    if (!transient) throw err;
    if (!tabSnapshot || (tabSnapshot.url || "").startsWith("chrome://") || (tabSnapshot.url || "").startsWith("chrome-extension://")) {
      throw new Error(`Chrome can't attach the debugger to this tab (${tabSnapshot?.url ?? "unknown"}). Open a normal http(s) tab and try again.`);
    }
    await sleep(180);
    err = await attemptAttach();
    if (err) err = await retryPageTargetIfExtensionBlocked(err, "attach-page-target-retry2");
    if (err) {
      recordAttachEvent({ kind: "attach-retry-failed", tabId, message: String(err.message || err), tabUrl: tabSnapshot?.url });
      // One more try after a longer settle. Some Chrome builds need ~500ms after a navigation
      // for the target to accept the debugger.
      await sleep(500);
      err = await attemptAttach();
      if (err) err = await retryPageTargetIfExtensionBlocked(err, "attach-page-target-retry3");
      if (err) {
        recordAttachEvent({ kind: "attach-retry2-failed", tabId, message: String(err.message || err), tabUrl: tabSnapshot?.url });
        const meta = await describeInputTarget(tabId);
        throw new Error(`Chrome debugger attach failed for tab ${tabId}: ${String(err.message || err)}\nTarget metadata: ${JSON.stringify(meta).slice(0, 4000)}`);
      }
    }
  }
  recordAttachEvent({ kind: "attached", tabId, debuggee: attachedDebuggee });
  const entry = { detachAt: Date.now() + INPUT_IDLE_DETACH_MS, debuggee: attachedDebuggee || { tabId } };
  attachedTabs.set(tabId, entry);
  return entry;
}

async function describeInputTarget(tabId) {
  const tab = await chrome.tabs.get(Number(tabId)).catch(() => null);
  const active = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []))[0] || null;
  let targets = [];
  try { targets = await new Promise((resolve) => chrome.debugger.getTargets((t) => resolve(t || []))); } catch {}
  return {
    resolvedTab: tab ? { id: tab.id, windowId: tab.windowId, url: tab.url, status: tab.status, title: tab.title, active: tab.active } : null,
    activeTab: active ? { id: active.id, windowId: active.windowId, url: active.url, status: active.status, title: active.title, active: active.active } : null,
    attachedTabs: Array.from(attachedTabs.keys()),
    cdpTargets: targets.map((t) => ({ id: t.id, tabId: t.tabId, type: t.type, url: t.url, attached: t.attached, extensionId: t.extensionId })),
  };
}

async function detachDebugger(tabId) {
  const entry = attachedTabs.get(tabId);
  if (!entry) return;
  attachedTabs.delete(tabId);
  try { await chrome.debugger.detach(entry.debuggee || { tabId }); } catch {}
}

async function detachAll() {
  const ids = Array.from(attachedTabs.keys());
  await Promise.all(ids.map(detachDebugger));
}

if (chrome.debugger && chrome.debugger.onDetach) {
  chrome.debugger.onDetach.addListener(({ tabId }, reason) => {
    if (tabId !== undefined) {
      attachedTabs.delete(tabId);
      emulatedTabs.delete(tabId);
      busyTabs.delete(tabId);
    }
    if (reason === "canceled_by_user") {
      console.warn(`[pi-chrome] debugger canceled by user on tab ${tabId}; Chrome will reattach on next call`);
    }
  });
}

setInterval(() => {
  const now = Date.now();
  for (const [tabId, entry] of attachedTabs) {
    // Never auto-detach a tab with active emulation (CDP clears the override on detach) or an
    // in-flight CDP command (it would die with "Detached while handling command").
    if (entry.detachAt && entry.detachAt < now && !emulatedTabs.has(tabId) && !busyTabs.has(tabId)) {
      void detachDebugger(tabId);
    }
  }
}, 5000);

// Hold/release the debugger for session-scoped emulation overrides.
function holdEmulation(tabId, hold) {
  if (hold) {
    emulatedTabs.add(tabId);
  } else {
    emulatedTabs.delete(tabId);
    const entry = attachedTabs.get(tabId);
    if (entry) entry.detachAt = Date.now() + INPUT_IDLE_DETACH_MS;
  }
}

// No per-command timeout here: legit CDP commands (a long Runtime.evaluate with awaitPromise,
// page waits) can run for minutes. The command-level timeout in handleCommand bounds the whole
// dispatch and detaches on expiry, so a hung debugger still recovers — just not mid-command.
function cdpRaw(tabId, method, params) {
  const debuggee = attachedTabs.get(tabId)?.debuggee || { tabId };
  busyTabs.add(tabId);
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(debuggee, method, params || {}, (result) => {
      if (chrome.runtime.lastError) reject(new Error(`${method}: ${chrome.runtime.lastError.message}`));
      else resolve(result);
    });
  }).finally(() => {
    busyTabs.delete(tabId);
    // Refresh the idle-detach clock: activity just happened, so detach 15 s after it ends.
    const entry = attachedTabs.get(tabId);
    if (entry) entry.detachAt = Date.now() + INPUT_IDLE_DETACH_MS;
  });
}

// Find foreign chrome-extension CDP targets anchored to the tab. Password managers, autofill
// helpers, and other input-attached extensions create type:"other" CDP targets whose URL is
// chrome-extension://<otherId>/... When that target is in focus, CDP refuses input events with
// "Cannot access a chrome-extension:// URL of different extension".
async function findForeignExtensionTargets() {
  try {
    const targets = await new Promise((resolve) => chrome.debugger.getTargets((t) => resolve(t || [])));
    return targets.filter((t) => {
      const url = String(t.url || "");
      if (!url.startsWith("chrome-extension://")) return false;
      if (t.extensionId === chrome.runtime.id) return false;
      return true;
    });
  } catch {
    return [];
  }
}

function extractForeignExtId(targets) {
  for (const t of targets) {
    if (t.extensionId && t.extensionId !== chrome.runtime.id) return t.extensionId;
    const m = String(t.url || "").match(/chrome-extension:\/\/([a-p]+)\//);
    if (m && m[1] !== chrome.runtime.id) return m[1];
  }
  return null;
}

async function dismissOverlayViaEscape(tabId) {
  // Esc routes through key dispatcher (target-by-focus), not by mouse coordinates, so it
  // works even when a foreign chrome-extension popup is intercepting pointer events.
  try {
    await cdpRaw(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await cdpRaw(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await sleep(120);
  } catch {}
}

// Wraps cdpRaw with one auto-recover on detached/closed sessions:
// chrome.debugger.attach can stay cached in attachedTabs even after Chrome killed the session
// (tab nav, devtools opened/closed, etc). Recover by detaching the stale entry and re-attaching,
// then retry the command once. Also recovers from foreign-extension input overlays via Esc.
async function cdp(tabId, method, params) {
  try {
    return await cdpRaw(tabId, method, params);
  } catch (error) {
    const msg = String(error?.message || error);
    const isStale = /Debugger is not attached|Detached while|Target closed|No tab with id/i.test(msg);
    const isForeignExtBlock = /Cannot access a chrome-extension:\/\/ URL of different extension/i.test(msg);
    if (isForeignExtBlock && /Input\./.test(method)) {
      const before = await findForeignExtensionTargets();
      recordAttachEvent({ kind: "foreign-ext-detected", tabId, method, foreignExtId: extractForeignExtId(before), targetCount: before.length });
      await dismissOverlayViaEscape(tabId);
      try {
        return await cdpRaw(tabId, method, params);
      } catch (retryErr) {
        const retryMsg = String(retryErr?.message || retryErr);
        if (/Cannot access a chrome-extension:\/\/ URL of different extension/i.test(retryMsg)) {
          const after = await findForeignExtensionTargets();
          const id = extractForeignExtId(after) || extractForeignExtId(before) || "unknown";
          throw new Error(
            `Another Chrome extension (${id}) has an input overlay on this page (e.g. a password manager / autofill popup). \n` +
            `pi-chrome tried to dismiss it with Escape but it reappeared. Disable that extension on this page, close its popup, or focus the field via Tab instead of clicking.`,
          );
        }
        throw retryErr;
      }
    }
    if (!isStale) throw error;
    attachedTabs.delete(tabId);
    await attachDebugger(tabId).catch(() => undefined);
    return cdpRaw(tabId, method, params);
  }
}

// =================== Target resolution ===================
// Resolve which tab a command runs on. Without an explicit target we use this session's dedicated
// automation target (created on first use) — never the user's active tab. Protected chrome://
// pages are always rejected.
async function getTabByParams(params) {
  const tabs = await chrome.tabs.query({});
  let tab;
  if (params.targetId !== undefined) {
    const id = Number(params.targetId);
    tab = await chrome.tabs.get(id).catch(() => null);
    if (!tab?.id) {
      // Chrome tab ids are not stable across reloads/navigations; a long session can hold a
      // stale id. Surface the current tabs so the caller can re-target instead of guessing.
      const listed = tabs
        .filter((candidate) => candidate.id !== undefined)
        .slice(0, 20)
        .map((candidate) => `  ${candidate.id}${candidate.active ? " *" : ""}\t${(candidate.title || "(untitled)").slice(0, 60)}\t${candidate.url || ""}`)
        .join("\n");
      throw new Error(
        `No Chrome tab with id ${id} (it was likely closed or replaced). ` +
        `Re-target with cdp --target-id, or pass --url-includes/--title-includes instead.\n` +
        `Current tabs:\n${listed || "  (none)"}`,
      );
    }
  } else if (params.urlIncludes) {
    tab = tabs.find((candidate) => (candidate.url || "").includes(params.urlIncludes));
  } else if (params.titleIncludes) {
    tab = tabs.find((candidate) => (candidate.title || "").includes(params.titleIncludes));
  } else {
    const sessionKey = sessionKeyOf(params);
    tab = await getOrCreateAutomationTarget(sessionKey);
    if (!tab) {
      throw new Error(
        "No target tab specified and this Pi session has no automation tab yet. " +
        "Pass targetId/urlIncludes/titleIncludes, or run a cdp command that creates one.",
      );
    }
  }
  if (!tab?.id) throw new Error("No matching Chrome tab found");
  const url = tab.url || "";
  if (url.startsWith("chrome://") || url.startsWith("chrome-extension://") || url.startsWith("devtools://")) {
    // Our own automation target stuck on a protected URL (e.g. chrome://newtab) cannot be
    // debugger-attached at all. Repair it by pointing it at about:blank via the tabs API.
    // User tabs on protected URLs are never touched — they keep failing fast.
    const isOurs = tab.id === automationTargets.get(sessionKeyOf(params))?.tabId;
    if (isOurs) {
      await chrome.tabs.update(tab.id, { url: "about:blank" });
      await sleep(150);
      return { id: tab.id, url: "about:blank", title: "" };
    }
    throw new Error(`Chrome blocks extension automation on protected URL: tab=${tab.id} url=${url}`);
  }
  return tab;
}

// Run one CDP method against the tab resolved from `params`, or a tabs-API translation for the
// two browser-level Target.* methods extensions can't send to a page debuggee. Shared by the
// single-method and batch (params.commands) paths.
async function runCdpMethod(params, method, cdpParams) {
  if (method === "Target.createTarget") {
    const url = typeof cdpParams.url === "string" && cdpParams.url ? cdpParams.url : "about:blank";
    const tab = await chrome.tabs.create({ url, active: cdpParams.background !== true });
    return { result: { targetId: String(tab.id) } };
  }
  if (method === "Target.getTargets") {
    const [tabs, targets] = await Promise.all([
      chrome.tabs.query({}),
      new Promise((resolve) => chrome.debugger.getTargets((t) => resolve(t || []))).catch(() => []),
    ]);
    const attached = new Set(targets.filter((t) => t.attached).map((t) => t.tabId));
    return {
      result: {
        targetInfos: tabs
          .filter((tab) => tab.id !== undefined)
          .map((tab) => ({
            targetId: String(tab.id),
            type: "page",
            title: tab.title || "",
            url: tab.url || "",
            attached: attached.has(tab.id),
            tabId: tab.id,
            windowId: tab.windowId,
            active: tab.active,
          })),
      },
    };
  }
  if (method === "Target.closeTarget") {
    const tab = await getTabByParams(params);
    await chrome.tabs.remove(tab.id);
    return { result: { closedTabId: tab.id, url: tab.url, title: tab.title } };
  }
  const tab = await getTabByParams(params);
  // Always focus the tab pi-chrome is working on so the user can watch the automation live.
  await chrome.tabs.update(tab.id, { active: true });
  await attachDebugger(tab.id);
  const result = await cdp(tab.id, method, cdpParams);
  // Session-scoped overrides die on detach (like closing DevTools), so hold the debugger
  // while an emulation override is active and release it on the matching clear.
  const holds =
    /^Emulation\.set/.test(method) ||
    /^Network\.emulateNetworkConditions$/.test(method) ||
    /^CSS\.forcePseudoState$/.test(method);
  const releases =
    /^Emulation\.clear/.test(method) ||
    (method === "Network.emulateNetworkConditions" && cdpParams.offline === false && cdpParams.downloadThroughput === -1) ||
    (method === "CSS.forcePseudoState" && Array.isArray(cdpParams.forcedPseudoClasses) && cdpParams.forcedPseudoClasses.length === 0);
  if (holds) holdEmulation(tab.id, true);
  else if (releases) holdEmulation(tab.id, false);
  return { result };
}

// =================== Commands ===================
async function dispatch(action, params) {
  switch (action) {
    case "tab.version":
      return {
        extensionId: chrome.runtime.id,
        extensionVersion: chrome.runtime.getManifest().version,
        bridgeUrl: BRIDGE_URL,
        userAgent: navigator.userAgent,
      };
    case "page.cdp": {
      // Script mode: params.commands = array of {method, params?, save?} and/or
      // {target:{urlIncludes|titleIncludes|targetId}} entries. {target} switches the working tab
      // for subsequent commands (like `cd` in bash); default is the session automation tab.
      // Runs sequentially, stops at the first CDP error (bash `&&` semantics).
      const script = Array.isArray(params.commands) && params.commands.length > 0 ? params.commands : null;
      if (script) {
        const results = [];
        let targetParams = {};
        for (const cmd of script) {
          if (cmd && typeof cmd === "object" && !Array.isArray(cmd) && cmd.target && typeof cmd.target === "object" && !Array.isArray(cmd.target)) {
            targetParams = { ...targetParams, ...cmd.target };
            results.push({ target: cmd.target });
            continue;
          }
          const method = String(cmd?.method ?? "");
          if (!/^[A-Za-z]+\.[A-Za-z]+$/.test(method)) {
            results.push({ method, error: "invalid method" });
            break;
          }
          const cdpParams = cmd.params && typeof cmd.params === "object" && !Array.isArray(cmd.params) ? cmd.params : {};
          try {
            const out = await runCdpMethod(targetParams, method, cdpParams);
            results.push({ method, result: out.result });
          } catch (error) {
            results.push({ method, error: error?.message ?? String(error) });
            break;
          }
        }
        return { method: "cdp.batch", results };
      }
      // Legacy single-method path (direct bridge use): top-level method/cdpParams/target fields.
      const method = String(params.method ?? "");
      if (!/^[A-Za-z]+\.[A-Za-z]+$/.test(method)) throw new Error("cdp requires --method <Domain.method> (e.g. Emulation.setDeviceMetricsOverride)");
      const cdpParams = params.cdpParams && typeof params.cdpParams === "object" && !Array.isArray(params.cdpParams) ? params.cdpParams : {};
      const out = await runCdpMethod(params, method, cdpParams);
      return { method, result: out.result };
    }
    case "tab.close": {
      // Explicit opt-in added on user request: close a specific tab (by targetId/urlIncludes/
      // titleIncludes) via the chrome.tabs API. Only ever closes the one resolved tab.
      const tab = await getTabByParams(params);
      await chrome.tabs.remove(tab.id);
      return { closedTabId: tab.id, url: tab.url, title: tab.title };
    }
    case "extension.reload":
      // Restart the companion extension service worker. Equivalent to the reload button at
      // chrome://extensions; used to pick up connector changes without restarting Chrome.
      setTimeout(() => chrome.runtime.reload(), 50);
      return { reloading: true, extensionId: chrome.runtime.id };
    case "automation.status": {
      await hydrateAutomationTargets();
      const t = automationTargets.get(sessionKeyOf(params));
      return { windowId: t?.windowId ?? null, tabId: t?.tabId ?? null };
    }
    case "automation.cleanup":
      // Close only THIS session's pi-chrome-owned window/tab. Never touches user tabs/windows or
      // another Pi session's target.
      return cleanupAutomationTarget(sessionKeyOf(params));
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

// =================== Bridge polling ===================
function armKeepaliveAlarm() {
  chrome.alarms.create("pi-bridge-keepalive", { periodInMinutes: 0.5 });
}

chrome.runtime.onInstalled.addListener(() => {
  armKeepaliveAlarm();
  void pollLoop();
});

chrome.runtime.onStartup.addListener(() => {
  armKeepaliveAlarm();
  void pollLoop();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "pi-bridge-keepalive") void pollLoop();
});

chrome.action.onClicked.addListener(() => {
  armKeepaliveAlarm();
  void pollLoop();
});

armKeepaliveAlarm();

setInterval(() => {
  void pollLoop();
}, 1000);

async function pollLoop() {
  if (polling) return;
  polling = true;
  try {
    while (true) {
      const response = await fetch(`${BRIDGE_URL}/next?name=${encodeURIComponent(CLIENT_NAME)}`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`bridge /next HTTP ${response.status}`);
      const expected = response.headers.get("x-pi-chrome-version");
      const ours = chrome.runtime.getManifest().version;
      if (expected && expected !== ours && isVersionOlder(ours, expected)) {
        console.warn(`[pi-chrome] extension v${ours} behind pi-chrome v${expected}; reloading extension`);
        try { chrome.runtime.reload(); } catch {}
        return;
      }
      const payload = await response.json();
      if (payload.type === "command") await handleCommand(payload.command);
    }
  } catch (error) {
    await sleep(POLL_ERROR_BACKOFF_MS);
  } finally {
    polling = false;
  }
}

async function handleCommand(command) {
  try {
    // Long-running CDP commands (scroll-and-collect, page waits) legitimately take minutes; the
    // pi side forwards its own timeout, so a short internal cap can't kill them. Fall back to
    // COMMAND_TIMEOUT_MS only for actions that don't carry a timeout (e.g. automation.cleanup).
    const timeoutMs =
      typeof command.params?.timeoutMs === "number" && command.params.timeoutMs > 0
        ? command.params.timeoutMs
        : COMMAND_TIMEOUT_MS;
    const result = await withTimeout(
      dispatch(command.action, command.params ?? {}),
      timeoutMs,
      command.action || "Chrome command",
      () => detachAll(),
    );
    await postResult({ id: command.id, ok: true, result });
  } catch (error) {
    await postResult({ id: command.id, ok: false, error: error?.message ?? String(error) });
  }
}

async function postResult(result) {
  await fetch(`${BRIDGE_URL}/result`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(result),
  });
}

function isVersionOlder(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x < y) return true;
    if (x > y) return false;
  }
  return false;
}
