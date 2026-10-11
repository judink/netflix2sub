// Read copies of subtitle responses; never change Netflix's requests or responses.
(() => {
  "use strict";
  const CHANNEL = "together-subtitles/v1";
  const MAX_BYTES = 4 * 1024 * 1024;
  const saved = new Map();
  const resources = new Map();
  const manifests = new Map();
  const selected = new Map();
  const recovering = new Map();
  let enabled = false;
  const watchId = () => location.pathname.match(/^\/watch\/(\d+)/)?.[1] || "";
  const originalParse = JSON.parse;
  const originalFetch = window.fetch;
  function resourceUrl(input) {
    try {
      const url = new URL(input, location.href);
      return url.protocol === "https:" && /(^|\.)nflxvideo\.net$|(^|\.)netflix\.com$/.test(url.hostname) ? url.href : "";
    } catch { return ""; }
  }
  function observeManifest(data) {
    const result = data?.result || data;
    if (!result || !Array.isArray(result.timedtexttracks) || !/^\d+$/.test(String(result.movieId || ""))) return;
    const id = String(result.movieId);
    const candidates = [];
    for (const track of result.timedtexttracks.slice(0, 200)) {
      if (!track || track.isNoneTrack || typeof track.language !== "string" || !/^ko(?:-|$)/i.test(track.language) || track.isForcedNarrative) continue;
      const trackId = [track.language, track.id || track.trackId || track.rawTrackType || "subtitles", track.trackVariant || ""].join(":");
      for (const [format, downloadable] of Object.entries(track.ttDownloadables || {})) {
        if (!/imsc|dfxp|vtt|simple/i.test(format) || !downloadable) continue;
        const urls = downloadable.downloadUrls ? Object.values(downloadable.downloadUrls) : (downloadable.urls || []).map(entry => entry.url);
        for (const raw of urls.slice(0, 6)) {
          if (typeof raw !== "string") continue;
          const url = resourceUrl(raw);
          if (!url) continue;
          const descriptor = { watchId: id, language: track.language, trackId, url, rank: (track.rawTrackType === "closedcaptions" ? 10 : 0) + (/vtt/i.test(format) ? 0 : 1) };
          resources.set(url, descriptor); candidates.push(descriptor);
        }
      }
    }
    if (!candidates.length) return;
    candidates.sort((a, b) => a.rank - b.rank);
    manifests.set(id, candidates);
    while (manifests.size > 4) manifests.delete(manifests.keys().next().value);
    while (resources.size > 200) resources.delete(resources.keys().next().value);
    void recoverCurrent();
  }
  // Decrypted manifests often pass through JSON.parse rather than a plain JSON fetch.
  JSON.parse = function (...args) {
    const result = Reflect.apply(originalParse, this, args);
    try { observeManifest(result); } catch { /* Preserve the original parser result. */ }
    return result;
  };
  function descriptor(url, id) { return resources.get(resourceUrl(url)) || { watchId: id, url: resourceUrl(url), language: "", trackId: "" }; }
  function isCandidate(input) {
    try {
      const url = new URL(input, location.href);
      return Boolean(resourceUrl(input)) &&
        (url.pathname === "/" || /\.(vtt|ttml|dfxp|xml)(?:$|\/)/i.test(url.pathname) || /timedtext|subtitle/i.test(url.pathname));
    } catch { return false; }
  }
  function publish(text, request) {
    const item = descriptor(request.url, request.watchId);
    const id = item.watchId;
    if (!id || typeof text !== "string" || text.length > MAX_BYTES) return;
    if (!/^\s*(?:\uFEFF)?(?:WEBVTT\b|<\?xml\b|<(?:\w+:)?tt\b)/i.test(text)) return;
    // XML declarations alone are not sufficient: reject unrelated XML responses.
    if (!/^\s*\uFEFF?WEBVTT\b/.test(text) && !/<(?:\w+:)?tt[\s>]/i.test(text)) return;
    const language = item.language || text.match(/xml:lang=["']([^"']+)["']/i)?.[1] || text.match(/^Language:\s*(.+)$/m)?.[1]?.trim() || "";
    if (language && !/^ko(?:-|$)/i.test(language)) return;
    const trackId = item.trackId || language || "ko";
    const key = id + ":" + text;
    saved.set(key, { channel: CHANNEL, type: "track", watchId: id, text, language, trackId });
    if (/^ko(?:-|$)/i.test(language) || !language && /[가-힣]/.test(text)) selected.set(id, trackId);
    while (saved.size > 12) saved.delete(saved.keys().next().value);
    while (selected.size > 4) selected.delete(selected.keys().next().value);
    if (id === watchId()) window.postMessage(saved.get(key), location.origin);
  }
  async function readCopy(response, request, json = false) {
    const reader = response.clone().body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let bytes = 0, text = "", finished = false;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) { finished = true; text += decoder.decode(); break; }
        bytes += part.value.byteLength;
        if (bytes > MAX_BYTES) return;
        text += decoder.decode(part.value, { stream: true });
        // CDN URLs can also serve media. Stop reading binary copies promptly.
        if (text.length >= 64 && !(json ? /^\s*[{[]/.test(text) : /^\s*\uFEFF?(?:WEBVTT\b|<\?xml\b|<(?:\w+:)?tt\b)/i.test(text))) return;
      }
      if (json) { try { observeManifest(originalParse(text)); } catch {} }
      else publish(text, request);
    } finally {
      if (!finished) void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  function replay() {
    const id = watchId(), trackId = selected.get(id);
    for (const item of saved.values()) if (item.watchId === id && (!trackId || item.trackId === trackId)) window.postMessage(item, location.origin);
  }
  async function recoverCurrent() {
    const id = watchId();
    if (!enabled || !id) return;
    if (Array.from(saved.values()).some(item => item.watchId === id && (selected.get(id) === item.trackId))) return;
    const candidate = manifests.get(id)?.[0];
    if (!candidate || recovering.has(id)) return;
    // At most one bounded recovery fetch per episode at a time, with retry backoff.
    const token = { until: Date.now() + 10000 };
    recovering.set(id, token);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await originalFetch.call(window, candidate.url, { signal: controller.signal });
      if (response.ok) await readCopy(response, candidate);
    } catch { /* Passive response capture remains available if recovery fails. */ }
    finally {
      clearTimeout(timeout);
      setTimeout(() => { if (recovering.get(id) === token) recovering.delete(id); }, Math.max(0, token.until - Date.now()));
    }
  }
  function isManifest(url) { return Boolean(resourceUrl(url)) && /manifest|playapi/i.test(url); }
  window.fetch = function (...args) {
    const url = args[0] instanceof Request ? args[0].url : String(args[0]);
    const request = descriptor(url, watchId());
    const pending = Reflect.apply(originalFetch, this, args);
    if (isManifest(url) || request.watchId && (isCandidate(url) || resources.has(resourceUrl(url)))) pending.then(response => {
      if (!response.ok) return;
      const length = Number(response.headers.get("content-length"));
      const type = response.headers.get("content-type") || "";
      if (length > MAX_BYTES || /^(?:video|audio)\//i.test(type) || response.headers.has("content-range")) return;
      // Only consume the clone, leaving the player's stream untouched.
      void readCopy(response, request, isManifest(url)).catch(() => {});
    }).catch(() => {});
    return pending;
  };
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const requests = new WeakMap();
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    requests.set(this, { ...descriptor(String(url), watchId()), candidate: isCandidate(String(url)) || resources.has(resourceUrl(String(url))), json: isManifest(String(url)) });
    return Reflect.apply(originalOpen, this, [method, url, ...rest]);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    const request = requests.get(this);
    if (request?.json || request?.candidate && request.watchId) this.addEventListener("load", async () => {
      try {
        if (this.status < 200 || this.status >= 300) return;
        let text;
        if (this.responseType === "blob") {
          if (this.response.size <= MAX_BYTES) text = await this.response.text();
        } else if (this.responseType === "arraybuffer") {
          if (this.response.byteLength <= MAX_BYTES) text = new TextDecoder().decode(this.response);
        } else if (this.responseType === "json" && request.json) { observeManifest(this.response); return; }
        else if (!this.responseType || this.responseType === "text") text = this.responseText;
        if (typeof text !== "string" || text.length > MAX_BYTES) return;
        if (request.json) { try { observeManifest(originalParse(text)); } catch {} }
        else publish(text, request);
      } catch { /* The player still receives its original response. */ }
    }, { once: true });
    return Reflect.apply(originalSend, this, args);
  };
  window.addEventListener("message", event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.channel !== CHANNEL || event.data.type !== "ready") return;
    enabled = event.data.enabled === true;
    replay(); void recoverCurrent();
  });
  for (const name of ["pushState", "replaceState"]) {
    const original = history[name];
    history[name] = function (...args) {
      const result = Reflect.apply(original, this, args);
      window.postMessage({ channel: CHANNEL, type: "navigation" }, location.origin);
      replay(); void recoverCurrent();
      return result;
    };
  }
  window.addEventListener("popstate", () => { replay(); void recoverCurrent(); });
})();
