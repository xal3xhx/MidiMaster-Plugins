// Debug log — visible in the Connection tab for diagnosing connection issues.
const debugLog = [];
const MAX_LOG_LINES = 80;
let debugLogEl = null;

function logDebug(...args) {
  const line = `[${new Date().toLocaleTimeString()}] ${args.map((a) => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ")}`;
  debugLog.push(line);
  if (debugLog.length > MAX_LOG_LINES) debugLog.shift();
  if (debugLogEl) {
    debugLogEl.textContent = debugLog.join("\n");
    debugLogEl.scrollTop = debugLogEl.scrollHeight;
  }
  console.log("[home_assistant]", ...args);
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const RECONNECT_DELAY_MS = 5000;
const RECONNECT_MAX_DELAY_MS = 30000;
const WRITE_COALESCE_MS = 75;

const ui = {
  statusText: null,
  statusDot: null,
  connectBtn: null,
  autoConnectInput: null,
  urlInput: null,
  tokenInput: null,
  invalidateBindingsUI: null,
};

const lastStatus = { connected: false, connecting: false, detail: "Not connected" };

function setStatus(connected, detail = "", opts = null) {
  const connecting = opts?.connecting ?? false;
  const disconnectedByUser = opts?.disconnectedByUser ?? false;

  lastStatus.connected = Boolean(connected);
  lastStatus.connecting = connecting;
  lastStatus.detail = detail || "";

  if (ui.statusText) {
    ui.statusText.textContent = connected ? (detail || "Connected") : (detail || "Not connected");
  }
  if (ui.statusDot) {
    ui.statusDot.classList.toggle("connected", Boolean(connected));
    ui.statusDot.classList.toggle("error", !connected && !connecting && !disconnectedByUser);
  }
  if (ui.connectBtn) {
    if (connecting) {
      ui.connectBtn.disabled = true;
      ui.connectBtn.classList.add("disabled");
      ui.connectBtn.classList.remove("danger");
      ui.connectBtn.textContent = "Connecting...";
    } else {
      ui.connectBtn.disabled = false;
      ui.connectBtn.classList.remove("disabled");
      ui.connectBtn.classList.toggle("danger", Boolean(connected));
      ui.connectBtn.textContent = connected ? "Disconnect" : "Connect";
    }
  }
  try { ui.invalidateBindingsUI?.(); } catch { /* ignore */ }
}

export async function activate(ctx) {
  let iconDataUrl = null;
  try {
    iconDataUrl = await ctx.assets?.readDataUrl?.("icon.svg", "image/svg+xml");
  } catch { iconDataUrl = null; }

  ui.invalidateBindingsUI = ctx.app?.invalidateBindingsUI;

  // ── State ──
  let haUrl = "";
  let haToken = "";
  let autoConnect = true;
  let connected = false;
  let connecting = false;
  let disconnectedByUser = false;

  let ws = null;
  let msgId = 1;
  let authenticated = false;

  // entity_id -> { state, brightness, friendly_name }
  const entityState = new Map();
  // entity_id -> area name
  const entityAreas = new Map();
  // area_id -> area name
  const areaMap = new Map();

  let bindings = [];
  const lastLocalWriteAt = new Map();
  const pendingWrites = new Map();
  const pendingRequests = new Map();

  // ── Helpers ──
  function nextMsgId() {
    msgId += 1;
    if (msgId > 1000000) msgId = 1;
    return msgId;
  }

  function normalizeTarget(rawTarget) {
    const t = rawTarget?.Integration || rawTarget?.integration || rawTarget;
    if (!t || t.integration_id !== "home_assistant") return null;
    const data = t.data || {};
    const entityId = String(data.entity_id || "");
    if (!entityId) return null;
    return {
      kind: String(t.kind || "light"),
      entity_id: entityId,
      name: String(data.name || data.friendly_name || entityId),
    };
  }

  function buildWsUrl(baseUrl) {
    let url = String(baseUrl || "").trim().replace(/\/+$/, "");
    if (url.startsWith("ws://") || url.startsWith("wss://")) {
      if (!url.endsWith("/api/websocket")) url += "/api/websocket";
      return url;
    }
    if (url.startsWith("https://")) {
      url = "wss://" + url.slice(8);
    } else if (url.startsWith("http://")) {
      url = "ws://" + url.slice(7);
    } else {
      url = "ws://" + url;
    }
    return url + "/api/websocket";
  }

  // ── WebSocket messaging ──
  function sendWs(payload) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch (err) {
      logDebug("ws send error", err);
    }
  }

  function request(payload, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return reject(new Error("WebSocket not open"));
      }
      const id = nextMsgId();
      const msg = { ...payload, id };
      const timer = setTimeout(() => {
        pendingRequests.delete(id);
        reject(new Error("HA request timed out"));
      }, timeoutMs);
      pendingRequests.set(id, { resolve, reject, timer });
      sendWs(msg);
    });
  }

  function handleMessage(data) {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    // Auth flow
    if (msg.type === "auth_required") {
      logDebug("auth_required received, sending token");
      sendWs({ type: "auth", access_token: haToken });
      return;
    }
    if (msg.type === "auth_ok") {
      logDebug("auth_ok — authenticated");
      authenticated = true;
      onAuthenticated();
      return;
    }
    if (msg.type === "auth_invalid") {
      logDebug("auth_invalid:", msg.message);
      markDisconnected("Auth failed: " + (msg.message || "invalid token"));
      return;
    }

    // Response to a request
    if (msg.id && pendingRequests.has(msg.id)) {
      const p = pendingRequests.get(msg.id);
      pendingRequests.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.success === false) {
        p.reject(new Error(msg.error?.message || "HA request failed"));
      } else {
        p.resolve(msg.result);
      }
      return;
    }

    // State changed event
    if (msg.type === "event" && msg.event?.event_type === "state_changed") {
      const newState = msg.event.data?.new_state;
      if (newState && String(newState.entity_id || "").startsWith("light.")) {
        applyEntityState(newState);
        syncFeedbackForEntity(newState.entity_id, { silent: false });
      }
      return;
    }
  }

  function applyEntityState(stateObj) {
    const entityId = String(stateObj.entity_id || "");
    if (!entityId) return;
    const attrs = stateObj.attributes || {};
    const isOn = stateObj.state === "on";
    const brightness = Number(attrs.brightness);
    entityState.set(entityId, {
      state: stateObj.state,
      on: isOn,
      brightness: Number.isFinite(brightness) ? brightness : (isOn ? 255 : 0),
      friendly_name: String(attrs.friendly_name || entityId),
      supported_color_modes: attrs.supported_color_modes || [],
    });
  }

  async function onAuthenticated() {
    connected = true;
    connecting = false;
    disconnectedByUser = false;
    setStatus(true, "Connected");

    try {
      const states = await request({ type: "get_states" });
      if (Array.isArray(states)) {
        for (const s of states) {
          if (String(s.entity_id || "").startsWith("light.")) {
            applyEntityState(s);
          }
        }
      }
      logDebug(entityState.size, "light entities loaded");
    } catch (err) {
      logDebug("get_states failed", err);
    }

    try {
      const areas = await request({ type: "config/area_registry/list" });
      areaMap.clear();
      if (Array.isArray(areas)) {
        for (const a of areas) areaMap.set(a.area_id, a.name || a.area_id);
      }
      const entities = await request({ type: "config/entity_registry/list" });
      entityAreas.clear();
      if (Array.isArray(entities)) {
        for (const e of entities) {
          if (e.area_id && String(e.entity_id || "").startsWith("light.")) {
            entityAreas.set(e.entity_id, areaMap.get(e.area_id) || e.area_id);
          }
        }
      }
      const devices = await request({ type: "config/device_registry/list" });
      if (Array.isArray(devices) && Array.isArray(entities)) {
        const deviceAreaMap = new Map();
        for (const d of devices) {
          if (d.area_id) deviceAreaMap.set(d.id, d.area_id);
        }
        for (const e of entities) {
          if (!entityAreas.has(e.entity_id) && e.device_id && deviceAreaMap.has(e.device_id)) {
            const areaName = areaMap.get(deviceAreaMap.get(e.device_id)) || deviceAreaMap.get(e.device_id);
            if (String(e.entity_id || "").startsWith("light.")) {
              entityAreas.set(e.entity_id, areaName);
            }
          }
        }
      }
    } catch (err) {
      logDebug("area fetch failed (non-fatal)", err);
    }

    try {
      await request({ type: "subscribe_events", event_type: "state_changed" });
      logDebug("subscribed to state_changed events");
    } catch (err) {
      logDebug("subscribe failed", err);
    }

    try { ctx.app?.invalidateBindingsUI?.(); } catch { /* ignore */ }
    await syncAllFeedback({ silent: true });
  }

  // ── Connection management ──
  async function connectOnce() {
    if (connecting || connected) return false;

    const url = String(haUrl || "").trim();
    const token = String(haToken || "").trim();
    if (!url || !token) {
      setStatus(false, "Set URL and token first", { disconnectedByUser });
      return false;
    }

    const wsUrl = buildWsUrl(url);
    logDebug("connecting to", wsUrl);

    connecting = true;
    authenticated = false;
    setStatus(false, `Connecting...`, { connecting: true, disconnectedByUser });

    ws = new WebSocket(wsUrl);

    ws.onmessage = (ev) => {
      handleMessage(ev.data);
    };

    ws.onclose = (ev) => {
      logDebug("ws closed, code:", ev.code, "reason:", ev.reason || "(none)");
      const wasConnected = connected;
      connected = false;
      connecting = false;
      authenticated = false;
      ws = null;
      clearAllPending();
      if (wasConnected) {
        setStatus(false, "Connection lost", { disconnectedByUser });
      } else if (!disconnectedByUser) {
        setStatus(false, "Connection closed", { disconnectedByUser });
      }
    };

    ws.onerror = (ev) => {
      logDebug("ws error event", ev?.message || ev?.type || "(no details — browser hides WS errors for security)");
      // onclose will fire after this, so don't double-handle
    };

    // Wait for the socket to open or fail
    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Connection timed out")), 10000);
        ws.addEventListener("open", () => { clearTimeout(timeout); resolve(); }, { once: true });
        ws.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("WebSocket connection failed")); }, { once: true });
      });
      logDebug("ws opened successfully, waiting for auth_required...");
      return true;
    } catch (err) {
      logDebug("connect failed:", err.message);
      connecting = false;
      setStatus(false, `Failed: ${err.message}`, { disconnectedByUser });
      return false;
    }
  }

  function clearAllPending() {
    for (const [id, p] of pendingRequests) {
      clearTimeout(p.timer);
      p.reject(new Error("Connection closed"));
    }
    pendingRequests.clear();
  }

  function markDisconnected(detail = "Disconnected") {
    connected = false;
    connecting = false;
    authenticated = false;
    if (ws) {
      try { ws.close(); } catch { /* ignore */ }
      ws = null;
    }
    clearAllPending();
    setStatus(false, detail, { disconnectedByUser });
  }

  function disconnect() {
    disconnectedByUser = true;
    markDisconnected("Disconnected");
  }

  // ── Feedback sync ──
  async function syncFeedbackForEntity(entityId, opts = null) {
    const silent = opts?.silent ?? true;
    const entry = entityState.get(entityId);
    if (!entry) return;

    const now = Date.now();
    for (const b of bindings) {
      const t = normalizeTarget(b?.target);
      if (!t || t.entity_id !== entityId) continue;

      const lastWrite = lastLocalWriteAt.get(entityId) || 0;
      if (lastWrite > 0 && (now - lastWrite) < 1200) continue;

      const bindingId = String(b?.id || "");
      if (!bindingId) continue;

      try {
        const action = b?.action || "Volume";
        if (action === "ToggleMute") {
          await ctx.feedback.set(bindingId, entry.on ? 1.0 : 0.0, "ToggleMute", { silent });
        } else {
          const vol = clamp01((Number(entry.brightness) || 0) / 255);
          await ctx.feedback.set(bindingId, vol, "Volume", { silent });
        }
      } catch { /* ignore */ }
    }
  }

  async function syncAllFeedback(opts = null) {
    const silent = opts?.silent ?? true;
    for (const b of bindings) {
      const t = normalizeTarget(b?.target);
      if (!t) continue;
      const entry = entityState.get(t.entity_id);
      if (!entry) continue;
      const bindingId = String(b?.id || "");
      if (!bindingId) continue;
      try {
        const action = b?.action || "Volume";
        if (action === "ToggleMute") {
          await ctx.feedback.set(bindingId, entry.on ? 1.0 : 0.0, "ToggleMute", { silent });
        } else {
          const vol = clamp01((Number(entry.brightness) || 0) / 255);
          await ctx.feedback.set(bindingId, vol, "Volume", { silent });
        }
      } catch { /* ignore */ }
    }
  }

  // ── Light control via HA service calls ──
  async function callService(domain, service, data) {
    return request({
      type: "call_service",
      domain,
      service,
      service_data: data,
    });
  }

  function queueBrightnessWrite(entityId, value) {
    const nextValue = clamp01(value);
    const existing = pendingWrites.get(entityId);
    if (existing?.timer) {
      existing.value = nextValue;
      pendingWrites.set(entityId, existing);
      return;
    }

    const entry = { entityId, value: nextValue, timer: null };
    entry.timer = setTimeout(async () => {
      const latest = pendingWrites.get(entityId);
      pendingWrites.delete(entityId);
      if (!latest || !connected) { logDebug("write skipped, latest:", !!latest, "connected:", connected); return; }
      const brightness = Math.max(1, Math.min(255, Math.round(latest.value * 255)));
      logDebug("sending brightness", latest.entityId, "bri:", brightness);
      try {
        const result = await callService("light", "turn_on", {
          entity_id: latest.entityId,
          brightness,
        });
        logDebug("brightness write result:", JSON.stringify(result));
      } catch (err) {
        logDebug("brightness write failed", err?.message || err);
      }
    }, WRITE_COALESCE_MS);
    pendingWrites.set(entityId, entry);
  }

  // ── Profile persistence ──
  function applyProfileSettings(settings) {
    const s = (settings && typeof settings === "object") ? settings : {};
    haUrl = String(s.ha_url || "").trim();
    haToken = String(s.ha_token || "").trim();
    autoConnect = ("auto_connect" in s) ? Boolean(s.auto_connect) : true;

    if (ui.urlInput) ui.urlInput.value = haUrl;
    if (ui.tokenInput) ui.tokenInput.value = haToken ? "\u2022".repeat(20) : "";
    if (ui.autoConnectInput) ui.autoConnectInput.checked = autoConnect;
  }

  async function persistProfilePatch(patch) {
    const current = ctx.profile?.get?.() || {};
    const next = { ...current, ...patch };
    applyProfileSettings(next);
    await ctx.profile?.set?.(next);
  }

  // ── Bindings tracking ──
  function setBindings(next) {
    bindings = Array.isArray(next) ? next : [];
  }

  // ── Init ──
  try {
    applyProfileSettings(ctx.profile?.get?.());
    ctx.profile?.onChanged?.((ev) => {
      const wasConnected = connected;
      applyProfileSettings(ev?.settings || ev);
      if (wasConnected) {
        markDisconnected();
        if (autoConnect) connectOnce();
      }
    });
  } catch { /* ignore */ }

  setBindings(ctx.bindings?.getAll?.() || []);
  ctx.bindings?.onChanged?.((next) => setBindings(next));

  // ── Auto-reconnect loop with backoff ──
  let reconnectDelay = RECONNECT_DELAY_MS;
  (async () => {
    while (true) {
      if (!connected && !connecting && !disconnectedByUser && autoConnect && haUrl && haToken) {
        const ok = await connectOnce();
        if (!ok) {
          reconnectDelay = Math.min(reconnectDelay * 1.5, RECONNECT_MAX_DELAY_MS);
        } else {
          reconnectDelay = RECONNECT_DELAY_MS;
        }
      }
      await sleep(reconnectDelay);
    }
  })();

  // ── Register integration ──
  ctx.registerIntegration({
    id: "home_assistant",
    name: "Home Assistant",
    icon_data: iconDataUrl,
    buttonActions: [
      { label: "Toggle On/Off", value: "ToggleMute" },
    ],

    describeTarget: (target) => {
      const t = normalizeTarget(target);
      if (!t) {
        return { label: "Home Assistant", icon_data: iconDataUrl, ghost: !connected };
      }
      const entry = entityState.get(t.entity_id);
      const label = entry?.friendly_name || t.name || t.entity_id;
      return { label: String(label), icon_data: iconDataUrl, ghost: !connected };
    },

    getTargetOptions: async () => {
      if (!connected) {
        return [
          { label: "Home Assistant is not connected", kind: "placeholder", ghost: true },
          { label: "Connect in Connections tab", kind: "placeholder", ghost: true },
        ];
      }

      const byArea = new Map();
      const noArea = [];

      for (const [entityId, state] of entityState) {
        const entry = {
          label: state.friendly_name || entityId,
          icon_data: iconDataUrl,
          target: {
            Integration: {
              integration_id: "home_assistant",
              kind: "light",
              data: {
                entity_id: entityId,
                name: state.friendly_name || entityId,
              },
            },
          },
        };

        const areaName = entityAreas.get(entityId);
        if (areaName) {
          if (!byArea.has(areaName)) byArea.set(areaName, []);
          byArea.get(areaName).push(entry);
        } else {
          noArea.push(entry);
        }
      }

      const opts = [];
      const sortedAreas = Array.from(byArea.keys()).sort();
      for (const area of sortedAreas) {
        const entries = byArea.get(area);
        entries.sort((a, b) => a.label.localeCompare(b.label));
        opts.push({ kind: "divider", label: area });
        opts.push(...entries);
      }

      if (noArea.length > 0) {
        noArea.sort((a, b) => a.label.localeCompare(b.label));
        if (sortedAreas.length > 0) {
          opts.push({ kind: "divider", label: "Other Lights" });
        }
        opts.push(...noArea);
      }

      if (opts.length === 0) {
        opts.push({ label: "No lights found", kind: "placeholder", ghost: true });
      }

      return opts;
    },

    onBindingTriggered: async (payload) => {
      logDebug("onBindingTriggered", JSON.stringify(payload));
      const t = normalizeTarget(payload?.target);
      if (!t) { logDebug("target normalize failed, raw:", JSON.stringify(payload?.target)); return; }
      if (!connected) { logDebug("ignoring trigger — not connected"); return; }

      const bindingId = String(payload?.binding_id || "");
      const action = String(payload?.action || "Volume");
      const value = clamp01(payload?.value);

      try {
        if (action === "ToggleMute") {
          // Flip current state — check what HA thinks the light is doing
          const current = entityState.get(t.entity_id) || { on: false, brightness: 0, friendly_name: t.name };
          const on = !current.on; // toggle
          logDebug("toggle", t.entity_id, "was:", current.on, "-> now:", on);
          entityState.set(t.entity_id, { ...current, on, state: on ? "on" : "off" });
          lastLocalWriteAt.set(t.entity_id, Date.now());

          if (bindingId) {
            await ctx.feedback.set(bindingId, on ? 1.0 : 0.0, "ToggleMute");
          }

          callService("light", on ? "turn_on" : "turn_off", {
            entity_id: t.entity_id,
          }).then((result) => {
            logDebug("toggle result:", JSON.stringify(result));
          }).catch((err) => {
            logDebug("toggle failed", err);
          });
          return;
        }

        // Volume -> brightness
        const current = entityState.get(t.entity_id) || { on: true, friendly_name: t.name };
        const brightness = Math.max(1, Math.min(255, Math.round(value * 255)));
        entityState.set(t.entity_id, { ...current, on: true, state: "on", brightness });
        lastLocalWriteAt.set(t.entity_id, Date.now());

        if (bindingId) {
          await ctx.feedback.set(bindingId, value, "Volume");
        }

        logDebug("queued brightness write", t.entity_id, "value:", value);
        queueBrightnessWrite(t.entity_id, value);
      } catch (err) {
        logDebug("binding trigger failed", err);
      }
    },
  });

  // ── Connection tab UI ──
  ctx.connections?.registerTab?.({
    id: "home_assistant",
    name: "Home Assistant",
    icon_data: iconDataUrl,
    order: 40,
    mount: (container) => {
      const hasToken = Boolean(String(haToken || "").trim());
      const tokenDisplay = hasToken ? "\u2022".repeat(20) : "";

      container.innerHTML = `
        <div class="connection-item-header">
          <div class="connection-info">
            <img src="${iconDataUrl || ""}" alt="Home Assistant" class="connection-icon" />
            <span class="connection-name">Home Assistant</span>
          </div>
          <div class="connection-status">
            <span class="connection-status-dot ${connected ? "connected" : ""}" data-role="dot"></span>
            <span data-role="text">${lastStatus.detail || (connected ? "Connected" : "Not connected")}</span>
          </div>
        </div>
        <div class="connection-content-wrapper" style="flex-direction:column;gap:12px;">
          <div class="connection-description">
            <p>Control your Home Assistant lights with MIDI. Enter your HA instance URL and a <a href="https://developers.home-assistant.io/docs/auth_api/#long-lived-access-token" target="_blank" style="color:#18BCF2;">long-lived access token</a>.</p>
          </div>
          <div class="connection-row">
            <label for="ha-url-input">Home Assistant URL</label>
            <input data-role="url" id="ha-url-input" type="text" placeholder="http://homeassistant.local:8123" value="${haUrl}" style="max-width:360px;" />
          </div>
          <div class="connection-row">
            <label for="ha-token-input">Access Token</label>
            <div style="display:flex;gap:6px;align-items:center;max-width:360px;">
              <input data-role="token" id="ha-token-input" type="password" placeholder="Long-lived access token" value="${tokenDisplay}" style="flex:1;" />
              <button type="button" data-role="save-token" style="white-space:nowrap;">Save</button>
            </div>
          </div>
        </div>
        <div class="connection-footer">
          <button type="button" class="connection-button ${connected ? "danger" : ""}" data-role="connect">${connected ? "Disconnect" : (connecting ? "Connecting..." : "Connect")}</button>
          <div class="connection-row checkbox-row">
            <input type="checkbox" data-role="auto" id="ha-auto-connect" ${autoConnect ? "checked" : ""} />
            <label for="ha-auto-connect">Auto connect</label>
          </div>
        </div>
        <details style="margin-top:8px;">
          <summary style="cursor:pointer;font-size:11px;color:#5e7091;user-select:none;">Debug Log</summary>
          <pre data-role="debug-log" style="font-size:10px;max-height:180px;overflow:auto;background:#0d1117;color:#c9d1d9;padding:6px 8px;border-radius:4px;margin-top:4px;white-space:pre-wrap;word-break:break-all;"></pre>
        </details>
      `;

      ui.statusDot = container.querySelector('[data-role="dot"]');
      ui.statusText = container.querySelector('[data-role="text"]');
      ui.connectBtn = container.querySelector('[data-role="connect"]');
      ui.urlInput = container.querySelector('[data-role="url"]');
      ui.tokenInput = container.querySelector('[data-role="token"]');
      ui.autoConnectInput = container.querySelector('[data-role="auto"]');

      // Wire up debug log panel
      debugLogEl = container.querySelector('[data-role="debug-log"]');
      if (debugLogEl && debugLog.length > 0) {
        debugLogEl.textContent = debugLog.join("\n");
        debugLogEl.scrollTop = debugLogEl.scrollHeight;
      }

      const saveTokenBtn = container.querySelector('[data-role="save-token"]');

      setStatus(connected, lastStatus.detail, { connecting, disconnectedByUser });

      ui.urlInput?.addEventListener("change", async () => {
        const newUrl = String(ui.urlInput.value || "").trim();
        await persistProfilePatch({ ha_url: newUrl });
      });

      saveTokenBtn?.addEventListener("click", async () => {
        const raw = String(ui.tokenInput?.value || "").trim();
        if (raw && !raw.match(/^\u2022+$/)) {
          await persistProfilePatch({ ha_token: raw });
          if (ui.tokenInput) ui.tokenInput.value = "\u2022".repeat(20);
          saveTokenBtn.textContent = "Saved!";
          setTimeout(() => { saveTokenBtn.textContent = "Save"; }, 1500);
        }
      });

      ui.autoConnectInput?.addEventListener("change", async () => {
        autoConnect = Boolean(ui.autoConnectInput.checked);
        const cur = ctx.profile?.get?.() || {};
        await ctx.profile?.set?.({ ...cur, auto_connect: autoConnect });
      });

      ui.connectBtn?.addEventListener("click", async () => {
        if (connecting) return;
        if (connected) {
          disconnect();
          return;
        }

        const urlVal = String(ui.urlInput?.value || "").trim();
        const tokenVal = String(ui.tokenInput?.value || "").trim();

        if (urlVal && urlVal !== haUrl) {
          await persistProfilePatch({ ha_url: urlVal });
        }
        if (tokenVal && !tokenVal.match(/^\u2022+$/) && tokenVal !== haToken) {
          await persistProfilePatch({ ha_token: tokenVal });
          if (ui.tokenInput) ui.tokenInput.value = "\u2022".repeat(20);
        }

        if (!haUrl || !haToken) {
          setStatus(false, "Enter URL and token first", { disconnectedByUser });
          return;
        }

        disconnectedByUser = false;
        reconnectDelay = RECONNECT_DELAY_MS;
        connectOnce();
      });
    },
    unmount: () => {
      ui.statusDot = null;
      ui.statusText = null;
      ui.connectBtn = null;
      ui.urlInput = null;
      ui.tokenInput = null;
      ui.autoConnectInput = null;
      debugLogEl = null;
    },
  });

  // Auto connect on load
  if (autoConnect && haUrl && haToken) {
    connectOnce();
  }
}
