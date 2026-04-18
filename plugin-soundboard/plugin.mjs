// MIDIMaster Soundboard Plugin (API v1)
//
// Plays audio files mapped to MIDI buttons. Supports multiple sounds per pad
// with next/prev cycling. Audio data stored in IndexedDB, metadata in profile.
//
// OSD is owned entirely by the plugin via ctx.osd.* (requires MIDIMaster
// with the plugin OSD control API). Integration targets skip the default
// OSD emit, so the plugin renders its own text cards here.

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function isOsdWindow() {
  try {
    return new URLSearchParams(window.location.search).get("osd") === "1";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// IndexedDB Storage Layer
// ---------------------------------------------------------------------------

const DB_NAME = "midimaster-soundboard";
const STORE_NAME = "audio-files";
const DB_VERSION = 1;

let _dbInstance = null;

function openDB() {
  if (_dbInstance) return Promise.resolve(_dbInstance);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => {
      _dbInstance = req.result;
      resolve(_dbInstance);
    };
    req.onerror = () => reject(req.error);
  });
}

async function storeAudio(soundId, arrayBuffer, mimeType, fileName) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.put({ data: arrayBuffer, mimeType, fileName }, soundId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadAudio(soundId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(soundId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function deleteAudio(soundId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.delete(soundId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------------------------------------------------------------------------
// Audio Playback Engine (Web Audio API)
// ---------------------------------------------------------------------------

let audioContext = null;
const decodedBufferCache = new Map();
let currentOutputDeviceId = "";

function ensureAudioContext() {
  if (audioContext && audioContext.state !== "closed") {
    if (audioContext.state === "suspended") {
      audioContext.resume().catch(() => {});
    }
    return audioContext;
  }
  const opts = {};
  if (currentOutputDeviceId) {
    opts.sinkId = currentOutputDeviceId;
  }
  try {
    audioContext = new AudioContext(opts);
  } catch {
    try {
      audioContext = new AudioContext();
    } catch {
      audioContext = null;
    }
  }
  return audioContext;
}

// Chromium requires a user gesture to resume a suspended AudioContext.
// Tab mount and preview clicks satisfy that — call this from those paths
// so MIDI-triggered plays (not gestures) can run afterwards.
async function primeAudioFromGesture() {
  try {
    const ctx = ensureAudioContext();
    if (!ctx) return;
    if (ctx.state === "suspended") {
      await ctx.resume();
    }
  } catch {}
}

async function playSound(soundId) {
  const ctx = ensureAudioContext();
  if (!ctx) return;
  if (ctx.state === "suspended") {
    try { await ctx.resume(); } catch { return; }
  }

  let buffer = decodedBufferCache.get(soundId);
  if (!buffer) {
    const record = await loadAudio(soundId);
    if (!record || !record.data) return;
    const copy = record.data.slice(0);
    buffer = await ctx.decodeAudioData(copy);
    decodedBufferCache.set(soundId, buffer);
  }

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.start(0);
}

function updateOutputDevice(deviceId) {
  currentOutputDeviceId = deviceId || "";
  decodedBufferCache.clear();
  if (audioContext && audioContext.state !== "closed") {
    if (typeof audioContext.setSinkId === "function" && currentOutputDeviceId) {
      audioContext.setSinkId(currentOutputDeviceId).catch(() => {
        try { audioContext.close(); } catch {}
        audioContext = null;
      });
    } else {
      try { audioContext.close(); } catch {}
      audioContext = null;
    }
  }
}

function clearBufferCache(soundId) {
  if (soundId) {
    decodedBufferCache.delete(soundId);
  } else {
    decodedBufferCache.clear();
  }
}

// ---------------------------------------------------------------------------
// Settings Helpers
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS = {
  output_device_id: "",
  pads: [],
  next_pad_num: 1,
};

function getSettings(ctx) {
  const raw = ctx.profile?.get?.();
  if (!raw || typeof raw !== "object") return { ...DEFAULT_SETTINGS };
  return {
    output_device_id: raw.output_device_id || "",
    pads: Array.isArray(raw.pads) ? raw.pads : [],
    next_pad_num: typeof raw.next_pad_num === "number" ? raw.next_pad_num : 1,
  };
}

async function saveSettings(ctx, settings) {
  await ctx.profile?.set?.(settings);
  try { ctx.app?.invalidateBindingsUI?.(); } catch {}
}

function findPad(settings, padId) {
  return settings.pads.find((p) => p.id === padId) || null;
}

function getPadCurrentSound(pad) {
  if (!pad || !Array.isArray(pad.sounds) || pad.sounds.length === 0) return null;
  const idx = Math.max(0, Math.min(pad.current_index || 0, pad.sounds.length - 1));
  return pad.sounds[idx] || null;
}

function generateId() {
  try {
    return crypto.randomUUID().slice(0, 8);
  } catch {
    return String(Date.now()) + String(Math.random()).slice(2, 8);
  }
}

// ---------------------------------------------------------------------------
// Main Activation
// ---------------------------------------------------------------------------

export async function activate(ctx) {
  let iconDataUrl = null;
  try {
    iconDataUrl = await ctx.assets?.readDataUrl?.("icon.svg", "image/svg+xml");
  } catch {
    iconDataUrl = null;
  }

  // Cache-bust describeTarget label since data.label is part of the OSD key.
  // We want one reused card per pad+action, so we put the dynamic bits into
  // a field the key-builder strips.
  let settings = getSettings(ctx);

  function describeTargetImpl(target) {
    // Re-read settings each call so cycling updates are visible immediately.
    settings = getSettings(ctx);

    const t = target?.Integration || target?.integration;
    const data = t?.data || {};

    const icon = (typeof data.icon_data === "string" && data.icon_data.trim())
      ? data.icon_data
      : (iconDataUrl || null);

    const padId = data.pad_id;
    const sbAction = data.sb_action || "play";
    const pad = findPad(settings, padId);
    const padName = pad ? pad.name : (data.label || "Soundboard");

    const sound = pad ? getPadCurrentSound(pad) : null;
    let label = sound ? `${padName}: ${sound.name}` : padName;
    if (sbAction === "next") label += " \u25B6";
    if (sbAction === "prev") label += " \u25C0";
    return { label: String(label), icon_data: icon, ghost: false };
  }

  // -------------------------------------------------------------------------
  // OSD window: only needs describeTarget so ctx.osd cards can render labels.
  // -------------------------------------------------------------------------
  if (isOsdWindow()) {
    ctx.registerIntegration({
      id: "soundboard",
      describeTarget: describeTargetImpl,
      getTargetOptions: () => [],
      onBindingTriggered: async () => {},
    });
    return;
  }

  currentOutputDeviceId = settings.output_device_id || "";

  // Feature detection: new OSD API added in MIDIMaster with plugin OSD control.
  const hasOsdApi = !!(ctx.osd && typeof ctx.osd.showVolume === "function");

  // Cross-binding refresh: after cycling, peer play-bindings need their
  // controller feedback + card label redrawn.
  let currentBindings = [];
  try { currentBindings = ctx.bindings?.getAll?.() || []; } catch {}
  ctx.bindings?.onChanged?.((next) => {
    currentBindings = Array.isArray(next) ? next : [];
  });

  function findBindingsForPad(padId, sbAction) {
    return currentBindings.filter((b) => {
      const t = b?.target?.Integration || b?.target?.integration;
      if (!t || t.integration_id !== "soundboard") return false;
      if (t.data?.pad_id !== padId) return false;
      if (sbAction && t.data?.sb_action !== sbAction) return false;
      return true;
    });
  }

  ctx.profile?.onChanged?.(() => {
    settings = getSettings(ctx);
    currentOutputDeviceId = settings.output_device_id || "";
    clearBufferCache();
    renderTabIfMounted();
  });

  // -------------------------------------------------------------------------
  // OSD helpers
  // -------------------------------------------------------------------------
  function padTarget(padId, sbAction) {
    return {
      Integration: {
        integration_id: "soundboard",
        kind: "pad",
        data: { pad_id: padId, sb_action: sbAction },
      },
    };
  }

  async function flashOsd(padId, sbAction, pad, opts = {}) {
    if (!hasOsdApi) return;
    const target = padTarget(padId, sbAction);
    const count = (pad?.sounds || []).length;
    const hasMany = count > 1;
    const idx = Math.max(0, Math.min(pad?.current_index || 0, Math.max(0, count - 1)));
    const value = hasMany ? (idx + 1) / count : 1.0;

    // OSD window does not load plugins, so describeTarget never runs there.
    // Inject resolved label/icon into data.* (key-builder strips these), so
    // the OSD-side fallback in resolveOsdTarget uses them for display.
    const desc = describeTargetImpl(target);
    target.Integration.data.label = desc.label;
    if (desc.icon_data) target.Integration.data.icon_data = desc.icon_data;

    // Hide bar + value for all soundboard actions — label alone carries
    // the state (pad name + current sound name + cycle arrow).
    const showBar = opts.showBar ?? false;
    const showValue = opts.showValue ?? false;

    try {
      await ctx.osd.showVolume(target, value, { showBar, showValue });
    } catch {}
  }

  // -------------------------------------------------------------------------
  // Integration Registration
  // -------------------------------------------------------------------------
  ctx.registerIntegration({
    id: "soundboard",
    name: "Soundboard",
    icon_data: iconDataUrl,

    describeTarget: describeTargetImpl,

    getTargetOptions: async (ctx2) => {
      const nav = ctx2 && typeof ctx2 === "object" ? ctx2.nav : null;

      if (nav && nav.screen === "pad" && nav.pad_id) {
        const padId = String(nav.pad_id);
        const pad = findPad(settings, padId);
        const soundCount = pad ? (pad.sounds || []).length : 0;

        const opts = [];

        opts.push({
          label: "Play Sound",
          icon_data: iconDataUrl,
          target: padTarget(padId, "play"),
          buttonActions: [{ label: "Play Sound", value: "Volume" }],
        });

        if (soundCount > 1) {
          opts.push({
            label: "Next Sound",
            icon_data: iconDataUrl,
            target: padTarget(padId, "next"),
            buttonActions: [{ label: "Next Sound", value: "Volume" }],
          });

          opts.push({
            label: "Previous Sound",
            icon_data: iconDataUrl,
            target: padTarget(padId, "prev"),
            buttonActions: [{ label: "Previous Sound", value: "Volume" }],
          });
        }

        if (soundCount === 0) {
          opts.push({ label: "No sounds added yet. Add sounds in the Soundboard tab.", kind: "placeholder", ghost: true });
        }

        return opts;
      }

      if (settings.pads.length === 0) {
        return [{ label: "Create pads in the Soundboard settings tab.", kind: "placeholder", ghost: true }];
      }

      return settings.pads.map((pad) => ({
        label: pad.name || pad.id,
        icon_data: iconDataUrl,
        nav: { screen: "pad", pad_id: pad.id },
      }));
    },

    onBindingTriggered: async (payload) => {
      const bindingId = payload?.binding_id;
      const value = payload?.value;
      const target = payload?.target || {};
      const data = target.data || {};

      if (clamp01(value) <= 0.0) return; // Ignore button release

      const padId = data.pad_id;
      const sbAction = data.sb_action || "play";
      const pad = findPad(settings, padId);
      if (!pad || !Array.isArray(pad.sounds) || pad.sounds.length === 0) return;

      const soundCount = pad.sounds.length;

      if (sbAction === "play") {
        const sound = getPadCurrentSound(pad);
        if (!sound) return;
        playSound(sound.id).catch((e) => console.error("[soundboard] playSound error:", e));

        await flashOsd(padId, "play", pad);

        const feedbackVal = soundCount > 1 ? (pad.current_index + 1) / soundCount : 1.0;
        if (bindingId) {
          await ctx.feedback.set(bindingId, feedbackVal, "Volume", { silent: true });
        }
        return;
      }

      if (sbAction === "next" || sbAction === "prev") {
        const currentIdx = Math.max(0, Math.min(pad.current_index || 0, soundCount - 1));
        const newIdx = sbAction === "next"
          ? (currentIdx + 1) % soundCount
          : (currentIdx - 1 + soundCount) % soundCount;
        pad.current_index = newIdx;
        await saveSettings(ctx, settings);

        await flashOsd(padId, sbAction, pad);

        const feedbackVal = soundCount > 1 ? (newIdx + 1) / soundCount : 1.0;
        if (bindingId) {
          await ctx.feedback.set(bindingId, feedbackVal, "Volume", { silent: true });
        }

        // Peer play-bindings: update their controller LED/slider and refresh
        // their OSD label (since current sound changed).
        const playBindings = findBindingsForPad(padId, "play");
        for (const pb of playBindings) {
          try {
            await ctx.feedback.set(pb.id, feedbackVal, "Volume", { silent: true });
          } catch {}
        }
        return;
      }
    },
  });

  // -------------------------------------------------------------------------
  // Connections Tab UI
  // -------------------------------------------------------------------------
  let tabContainer = null;
  let tabMounted = false;

  function renderTabIfMounted() {
    if (tabMounted && tabContainer) {
      renderTab(tabContainer);
    }
  }

  function renderTab(container) {
    settings = getSettings(ctx);

    container.innerHTML = `
      <style>
        .sb-pads-list { display: flex; flex-direction: column; gap: 12px; margin-top: 8px; }
        .sb-pad { border: 1px solid var(--border, #333); border-radius: 6px; padding: 10px; }
        .sb-pad-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
        .sb-pad-header input { flex: 1; background: var(--input-bg, #1a1a2e); border: 1px solid var(--border, #333);
          color: var(--text, #e0e0e0); padding: 4px 8px; border-radius: 4px; font-size: 13px; }
        .sb-pad-delete { background: none; border: none; color: var(--text-muted, #888); cursor: pointer;
          font-size: 16px; padding: 2px 6px; border-radius: 4px; }
        .sb-pad-delete:hover { color: var(--danger, #e74c3c); background: var(--hover-bg, rgba(255,255,255,0.05)); }
        .sb-sound-list { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }
        .sb-sound-row { display: flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 4px;
          background: var(--input-bg, #1a1a2e); }
        .sb-sound-name { flex: 1; font-size: 13px; color: var(--text, #e0e0e0); overflow: hidden;
          text-overflow: ellipsis; white-space: nowrap; }
        .sb-sound-current { font-weight: 600; }
        .sb-sound-btn { background: none; border: none; color: var(--text-muted, #888); cursor: pointer;
          font-size: 14px; padding: 2px 4px; border-radius: 3px; }
        .sb-sound-btn:hover { color: var(--text, #e0e0e0); background: var(--hover-bg, rgba(255,255,255,0.05)); }
        .sb-add-sound { font-size: 12px; padding: 4px 10px; }
        .sb-add-pad { margin-top: 4px; }
        .sb-output-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
        .sb-output-row label { font-size: 13px; color: var(--text-muted, #888); white-space: nowrap; }
        .sb-output-row select { max-width: 260px; background: var(--input-bg, #1a1a2e); border: 1px solid var(--border, #333);
          color: var(--text, #e0e0e0); padding: 4px 8px; border-radius: 4px; font-size: 13px; }
        .sb-empty { color: var(--text-muted, #888); font-size: 12px; font-style: italic; padding: 4px 8px; }
      </style>
      <div class="connection-item-header">
        <div class="connection-info">
          <img src="${iconDataUrl || ""}" alt="" class="connection-icon" />
          <span class="connection-name">Soundboard</span>
        </div>
        <div class="connection-status">
          <span class="connection-status-dot connected"></span>
          <span>Ready</span>
        </div>
      </div>
      <div class="connection-content-wrapper">
        <div class="connection-grid" style="width: 100%;">
          <div class="sb-output-row">
            <label>Output Device</label>
            <select data-role="output-device"><option value="">System Default</option></select>
          </div>
          <div class="sb-pads-list" data-role="pads-list"></div>
        </div>
      </div>
      <div class="connection-footer">
        <button type="button" class="connection-button sb-add-pad" data-role="add-pad">+ Add Pad</button>
      </div>
    `;

    const outputSelect = container.querySelector('[data-role="output-device"]');
    const padsList = container.querySelector('[data-role="pads-list"]');
    const addPadBtn = container.querySelector('[data-role="add-pad"]');

    // Tab mount is a user gesture — prime AudioContext so MIDI-triggered
    // plays (not gestures from WebView2's POV) can run afterwards.
    primeAudioFromGesture();

    populateOutputDevices(outputSelect);
    renderPads(padsList);

    addPadBtn.addEventListener("click", async () => {
      const padId = "pad-" + generateId();
      const padName = "Pad " + settings.next_pad_num;
      settings.pads.push({ id: padId, name: padName, sounds: [], current_index: 0 });
      settings.next_pad_num = (settings.next_pad_num || 1) + 1;
      await saveSettings(ctx, settings);
      renderPads(padsList);
    });
  }

  async function enumerateOutputs() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter((d) => d.kind === "audiooutput" && d.deviceId);
    } catch {
      return [];
    }
  }

  // Chromium hides deviceId + label on enumerateDevices() until the page
  // has held a media permission. Request a short-lived mic stream, drop
  // it immediately, then re-enumerate to get real IDs and labels.
  async function unlockDeviceInfo() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const t of stream.getTracks()) t.stop();
      return true;
    } catch {
      return false;
    }
  }

  function fillSelect(selectEl, outputs) {
    const existing = selectEl.querySelectorAll("option:not([value=''])");
    existing.forEach((o) => o.remove());
    for (const dev of outputs) {
      const opt = document.createElement("option");
      opt.value = dev.deviceId;
      opt.textContent = dev.label || `Output (${dev.deviceId.slice(0, 8)})`;
      selectEl.appendChild(opt);
    }
    selectEl.value = settings.output_device_id || "";
  }

  async function populateOutputDevices(selectEl) {
    let outputs = await enumerateOutputs();

    // If labels are hidden, grant media permission once so device info
    // becomes visible, then re-enumerate.
    if (outputs.length === 0 || outputs.every((d) => !d.label)) {
      await unlockDeviceInfo();
      outputs = await enumerateOutputs();
    }

    fillSelect(selectEl, outputs);

    selectEl.addEventListener("change", async () => {
      settings.output_device_id = selectEl.value;
      updateOutputDevice(selectEl.value);
      await saveSettings(ctx, settings);
    });
  }

  function renderPads(container) {
    container.innerHTML = "";

    if (settings.pads.length === 0) {
      container.innerHTML = '<div class="sb-empty">No pads yet. Click "+ Add Pad" to get started.</div>';
      return;
    }

    for (const pad of settings.pads) {
      const padEl = document.createElement("div");
      padEl.className = "sb-pad";
      padEl.innerHTML = `
        <div class="sb-pad-header">
          <input type="text" value="${escapeHtml(pad.name)}" data-role="pad-name" />
          <button class="sb-pad-delete" data-role="delete-pad" title="Delete pad">&times;</button>
        </div>
        <div class="sb-sound-list" data-role="sound-list"></div>
        <button type="button" class="connection-button sb-add-sound" data-role="add-sound">+ Add Sound</button>
      `;

      const nameInput = padEl.querySelector('[data-role="pad-name"]');
      const deletePadBtn = padEl.querySelector('[data-role="delete-pad"]');
      const soundListEl = padEl.querySelector('[data-role="sound-list"]');
      const addSoundBtn = padEl.querySelector('[data-role="add-sound"]');

      nameInput.addEventListener("change", async () => {
        pad.name = nameInput.value.trim() || pad.name;
        await saveSettings(ctx, settings);
      });

      deletePadBtn.addEventListener("click", async () => {
        for (const snd of pad.sounds) {
          deleteAudio(snd.id).catch(() => {});
          clearBufferCache(snd.id);
        }
        settings.pads = settings.pads.filter((p) => p.id !== pad.id);
        await saveSettings(ctx, settings);
        padEl.remove();
        if (settings.pads.length === 0) {
          container.innerHTML = '<div class="sb-empty">No pads yet. Click "+ Add Pad" to get started.</div>';
        }
      });

      renderSounds(soundListEl, pad);

      addSoundBtn.addEventListener("click", () => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".mp3,.ogg,.wav,.m4a,.flac,.webm,audio/*";
        input.style.display = "none";
        document.body.appendChild(input);

        input.addEventListener("change", async () => {
          const file = input.files?.[0];
          document.body.removeChild(input);
          if (!file) return;

          if (file.size > 10 * 1024 * 1024) {
            console.error("[soundboard] File too large:", file.name, file.size);
            return;
          }

          try {
            const arrayBuffer = await file.arrayBuffer();
            const soundId = "snd-" + generateId();
            const name = file.name.replace(/\.[^/.]+$/, "");

            await storeAudio(soundId, arrayBuffer, file.type, file.name);
            pad.sounds.push({ id: soundId, name });
            if (pad.sounds.length === 1) pad.current_index = 0;
            await saveSettings(ctx, settings);
            renderSounds(soundListEl, pad);
          } catch (e) {
            console.error("[soundboard] Failed to add sound:", e);
          }
        });

        input.click();
      });

      container.appendChild(padEl);
    }
  }

  function renderSounds(container, pad) {
    container.innerHTML = "";

    if (!pad.sounds || pad.sounds.length === 0) {
      container.innerHTML = '<div class="sb-empty">No sounds. Click "+ Add Sound" to add audio files.</div>';
      return;
    }

    const currentIdx = Math.max(0, Math.min(pad.current_index || 0, pad.sounds.length - 1));

    pad.sounds.forEach((sound, idx) => {
      const row = document.createElement("div");
      row.className = "sb-sound-row";

      const isCurrent = idx === currentIdx;
      row.innerHTML = `
        <span class="sb-sound-name ${isCurrent ? "sb-sound-current" : ""}">${isCurrent ? "\u25B6 " : ""}${escapeHtml(sound.name)}</span>
        <button class="sb-sound-btn" data-role="preview" title="Preview">\u25B6</button>
        <button class="sb-sound-btn" data-role="remove" title="Remove">&times;</button>
      `;

      row.querySelector('[data-role="preview"]').addEventListener("click", () => {
        playSound(sound.id).catch((e) => console.error("[soundboard] preview error:", e));
      });

      row.querySelector('[data-role="remove"]').addEventListener("click", async () => {
        deleteAudio(sound.id).catch(() => {});
        clearBufferCache(sound.id);
        pad.sounds = pad.sounds.filter((s) => s.id !== sound.id);
        if (pad.sounds.length === 0) {
          pad.current_index = 0;
        } else if (pad.current_index >= pad.sounds.length) {
          pad.current_index = pad.sounds.length - 1;
        }
        await saveSettings(ctx, settings);
        renderSounds(container, pad);
      });

      container.appendChild(row);
    });
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  ctx.connections?.registerTab?.({
    id: "soundboard",
    name: "Soundboard",
    icon_data: iconDataUrl,
    order: 70,
    mount: (container) => {
      tabContainer = container;
      tabMounted = true;
      renderTab(container);
    },
    unmount: () => {
      tabMounted = false;
      tabContainer = null;
    },
  });
}
