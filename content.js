(() => {
  "use strict";
  const S = TogetherSubtitles;
  const CHANNEL = "together-subtitles/v1";
  let config = { enabled: false, hasKey: false, fontSize: 28, top: 4, updatedAt: 0 };
  let currentId = watchId();
  let track = null;
  let translations = new Map();
  let generation = 0;
  const pending = new Map();
  let failure = "";
  let retryAt = 0;
  let host, line, info;
  let boundVideo;
  let trackIdentity = "";
  let cueKeys = new Set();
  let nextCueId = 0;
  let lastRecovery = 0;
  function watchId() { return location.pathname.match(/^\/watch\/(\d+)/)?.[1] || ""; }
  async function send(message) {
    try { return await chrome.runtime.sendMessage(message); }
    catch { return { ok: false, error: "확장 프로그램이 다시 로드되었습니다. 넷플릭스 페이지를 새로고침해 주세요." }; }
  }
  function invalidate() {
    generation++;
    for (const requestId of pending.keys()) void send({ type: "CANCEL", requestId });
    pending.clear();
    failure = "";
    retryAt = 0;
  }
  function reset() {
    invalidate(); track = null; translations = new Map(); trackIdentity = "";
    cueKeys = new Set(); nextCueId = 0; lastRecovery = 0;
    if (line) line.textContent = "";
    if (host) host.hidden = true;
  }
  function recover() {
    lastRecovery = Date.now();
    window.postMessage({ channel: CHANNEL, type: "ready", enabled: config.enabled && config.hasKey }, location.origin);
  }
  function checkNavigation() {
    const id = watchId();
    if (id === currentId) return;
    reset(); currentId = id; recover();
  }
  function mount() {
    const video = document.querySelector("video");
    if (video && video !== boundVideo) {
      boundVideo?.removeEventListener("seeking", onSeek);
      boundVideo = video;
      video.addEventListener("seeking", onSeek);
    }
    const container = document.fullscreenElement || video?.closest(".watch-video") || video?.parentElement;
    if (!container) return null;
    if (!host) {
      host = document.createElement("div");
      host.id = "together-uk-subtitles";
      Object.assign(host.style, { position: "fixed", inset: "0", pointerEvents: "none", zIndex: "2147483646" });
      const shadow = host.attachShadow({ mode: "closed" });
      const style = document.createElement("style");
      style.textContent = `:host([hidden]){display:none!important}.stage{position:absolute;inset:0;display:flex;align-items:flex-start;justify-content:center;padding:0 5%;box-sizing:border-box}.line{text-align:center;white-space:pre-line;line-height:1.3;font-family:Arial,"Segoe UI",sans-serif;font-weight:600;color:#ffe89c;text-shadow:0 2px 3px #000,2px 0 3px #000,-2px 0 3px #000;max-width:90%;background:transparent;padding:4px 12px;overflow-wrap:anywhere}.line:empty{display:none}.info{position:absolute;bottom:24px;right:24px;color:#fff;background:rgba(0,0,0,.72);padding:8px 12px;border-radius:8px;font:13px/1.5 Arial,sans-serif;max-width:350px}.info:empty{display:none}`;
      const stage = document.createElement("div"); stage.className = "stage";
      line = document.createElement("div"); line.className = "line"; stage.append(line);
      info = document.createElement("div"); info.className = "info";
      shadow.append(style, stage, info);
    }
    if (host.parentElement !== container) container.append(host);
    // Restrict the overlay to the video's rectangle, including letterboxing.
    const rect = video?.getBoundingClientRect();
    if (rect) Object.assign(host.style, { inset: "auto", left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    line.style.fontSize = `${config.fontSize}px`;
    line.style.marginTop = `${Math.max(0, Math.min(25, Number(config.top) || 0)) * (rect?.height || innerHeight) / 100}px`;
    return video;
  }
  function onSeek() { checkNavigation(); invalidate(); render(); pump(); }
  function render() {
    if (!currentId || !config.enabled) { if (host) host.hidden = true; return; }
    const video = mount();
    if (!video) return;
    host.hidden = false;
    let text = "";
    if (track && config.hasKey) {
      const cues = S.active(track.cues, video.currentTime);
      // A source cue is never displayed with a different cue's translation.
      text = cues.map(c => translations.get(c.id) || "").filter(Boolean).join("\n");
    }
    if (line.textContent !== text) line.textContent = text;
    const status = !config.hasKey ? "함께 자막: 확장 설정에 API 키를 입력해 주세요." : failure ? `함께 자막: ${failure}` : !track ? "한국어 자막 파일 대기 중 · 한국어 자막을 켜 주세요. 감지되지 않으면 자막을 껐다 켜거나 새로고침해 주세요." : "";
    if (info.textContent !== status) info.textContent = status;
  }
  function pump() {
    if (!currentId || !track || !config.enabled || !config.hasKey || failure || Date.now() < retryAt) return;
    const video = document.querySelector("video");
    if (!video) return;
    // Two lanes: a small urgent batch can finish before a larger lookahead batch.
    while (pending.size < 2) {
      const reserved = new Set(Array.from(pending.values()).flatMap(job => job.ids));
      const nearest = S.nextBatch(track.cues, translations, video.currentTime, 1, reserved)[0];
      if (!nearest) break;
      const urgent = !Array.from(pending.values()).some(job => job.urgent) && nearest.end > video.currentTime && (nearest.start < video.currentTime + 12 || !translations.size && !pending.size);
      const batch = S.nextBatch(track.cues, translations, video.currentTime, urgent ? 4 : 24, reserved);
      if (!batch.length) break;
      const id = crypto.randomUUID();
      pending.set(id, { ids: batch.map(c => c.id), urgent });
      void translateBatch(batch, id, generation);
    }
  }
  async function translateBatch(batch, id, epoch) {
    try {
      const result = await send({ type: "TRANSLATE", requestId: id, items: batch.map(c => ({ id: c.id, text: c.text })) });
      if (epoch !== generation) return;
      if (!result?.ok) {
        if (result?.retryable || result?.cancelled) { retryAt = Date.now() + (result.retryAfter || 250); return; }
        invalidate(); failure = result?.error || "번역에 실패했습니다."; return;
      }
      const allowed = new Set(batch.map(c => c.id));
      for (const item of result.translations) if (allowed.has(item.id)) translations.set(item.id, item.text);
    } finally {
      pending.delete(id);
      // URL may have changed while a translation was in flight.
      checkNavigation(); render(); pump();
    }
  }
  async function refreshSettings() {
    const result = await send({ type: "SETTINGS" });
    if (!result?.ok) return;
    const next = result.settings;
    if (next.updatedAt !== config.updatedAt || next.enabled !== config.enabled) {
      invalidate();
      if (next.model !== config.model || next.updatedAt !== config.updatedAt) translations.clear();
    }
    config = next;
    recover(); checkNavigation(); render(); pump();
  }
  window.addEventListener("message", event => {
    const data = event.data;
    if (event.source !== window || event.origin !== location.origin || data?.channel !== CHANNEL || data.type !== "track" || typeof data.text !== "string") return;
    const id = watchId();
    if (!id || data.watchId !== id) return;
    checkNavigation();
    try {
      const candidate = S.parse(data.text);
      if (!candidate.language && typeof data.language === "string") candidate.language = data.language;
      if (!S.isKorean(candidate)) return;
      const identity = data.trackId || candidate.language || "ko";
      if (!track || identity !== trackIdentity) {
        invalidate(); translations = new Map(); cueKeys = new Set(); nextCueId = 0;
        trackIdentity = identity; track = { language: candidate.language, cues: [] };
      }
      let added = false;
      for (const cue of candidate.cues) {
        const key = JSON.stringify([cue.start, cue.end, cue.text]);
        if (cueKeys.has(key) || track.cues.length >= 15000) continue;
        cueKeys.add(key); track.cues.push({ ...cue, id: nextCueId++ }); added = true;
      }
      if (!added) return;
      track.cues.sort((a, b) => a.start - b.start || a.end - b.end);
      render(); pump();
    } catch { /* Ignore non-text or unsupported tracks without disrupting playback. */ }
  });
  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (message.type === "STATUS") {
      checkNavigation();
      reply({ ok: true, watchId: currentId, captured: Boolean(track), total: track?.cues.length || 0, translated: translations.size, busy: pending.size > 0, error: failure });
    } else if (message.type === "REFRESH") { void refreshSettings().then(() => reply({ ok: true })); return true; }
    else if (message.type === "RETRY") { failure = ""; retryAt = 0; recover(); pump(); reply({ ok: true }); }
  });
  document.addEventListener("fullscreenchange", render);
  window.addEventListener("message", event => {
    if (event.source === window && event.origin === location.origin && event.data?.channel === CHANNEL && event.data.type === "navigation") {
      checkNavigation(); render(); pump();
    }
  });
  window.addEventListener("popstate", () => { checkNavigation(); render(); pump(); });
  // Video elements can be replaced between episodes. Polling also handles SPA navigation.
  setInterval(() => {
    checkNavigation();
    if (currentId && !track && config.enabled && Date.now() - lastRecovery > 1000) recover();
    render(); pump();
  }, 100);
  setInterval(() => { void refreshSettings(); }, 2000);
  void refreshSettings();
  recover();
})();
