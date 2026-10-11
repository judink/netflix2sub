// Shared timing, parsing and translation validation. No API keys or page code here.
(function (root) {
  "use strict";
  function time(value, rates = {}) {
    const fps = rates.frameRate || 30;
    const ticks = rates.tickRate || 10000000;
    const text = String(value || "").trim();
    const offset = text.match(/^(\d+(?:\.\d+)?)(h|m|s|ms|f|t)$/);
    if (offset) return Number(offset[1]) * ({ h: 3600, m: 60, s: 1, ms: 0.001, f: 1 / fps, t: 1 / ticks })[offset[2]];
    const clock = text.match(/^(?:(\d+):)?(\d{2}):(\d{2})(?:[.,](\d+)|:(\d+)(?:\.(\d+))?)?$/);
    if (!clock) return NaN;
    return Number(clock[1] || 0) * 3600 + Number(clock[2]) * 60 + Number(clock[3]) +
      (clock[4] ? Number("0." + clock[4]) : 0) + (clock[5] ? (Number(clock[5]) + Number("0." + (clock[6] || "0"))) / fps : 0);
  }
  const clean = text => String(text).replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").trim();
  function finalize(cues, language) {
    const valid = cues.filter(c => Number.isFinite(c.start) && Number.isFinite(c.end) && c.start >= 0 && c.end > c.start && c.text);
    valid.sort((a, b) => a.start - b.start || a.end - b.end);
    // Multiple TTML paragraphs at the same timestamp are one multiline cue.
    const merged = [];
    for (const cue of valid) {
      const last = merged.at(-1);
      if (last && last.start === cue.start && last.end === cue.end) last.text += "\n" + cue.text;
      else merged.push({ ...cue });
    }
    return { language: language || "", cues: merged.map((cue, i) => ({ ...cue, id: i })) };
  }
  function parseVtt(raw) {
    const cues = [];
    for (const block of raw.replace(/^\uFEFF/, "").replace(/\r/g, "").split(/\n\s*\n/)) {
      const lines = block.split("\n");
      if (/^(NOTE|STYLE|REGION)(?:\s|$)/.test(lines[0])) continue;
      const index = lines.findIndex(line => line.includes("-->"));
      if (index < 0) continue;
      const match = lines[index].match(/^(\S+)\s+-->\s+(\S+)/);
      if (!match) continue;
      const text = clean(lines.slice(index + 1).join("\n").replace(/<[^>]*>/g, "")
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&"));
      cues.push({ start: time(match[1]), end: time(match[2]), text });
    }
    return finalize(cues, raw.match(/^Language:\s*(.+)$/m)?.[1]?.trim());
  }
  function parseTtml(raw, Parser = root.DOMParser) {
    if (!Parser) throw new Error("XML 파서를 사용할 수 없습니다.");
    const document = new Parser().parseFromString(raw, "application/xml");
    if (document.getElementsByTagName("parsererror").length) throw new Error("자막 XML 형식이 올바르지 않습니다.");
    const tt = document.documentElement;
    if (tt.localName !== "tt") throw new Error("TTML 자막이 아닙니다.");
    const attribute = (element, name) => Array.from(element.attributes || []).find(a => a.localName === name)?.value;
    const rates = { frameRate: Number(attribute(tt, "frameRate")) || 30, tickRate: Number(attribute(tt, "tickRate")) || 10000000 };
    const multiplier = attribute(tt, "frameRateMultiplier")?.trim().split(/\s+/).map(Number);
    if (multiplier?.length === 2 && multiplier[1]) rates.frameRate *= multiplier[0] / multiplier[1];
    function textOf(node) {
      if (node.nodeType === 3 || node.nodeType === 4) return node.nodeValue;
      if (node.localName === "br") return "\n";
      // Ruby annotations should not be read a second time.
      if (attribute(node, "ruby") === "text") return "";
      return Array.from(node.childNodes || []).map(textOf).join("");
    }
    const cues = [];
    function walk(element, parentStart = 0, parentEnd = Infinity) {
      const begin = attribute(element, "begin");
      const end = attribute(element, "end");
      const duration = attribute(element, "dur");
      const start = parentStart + (begin ? time(begin, rates) : 0);
      const finish = Math.min(parentEnd, end ? parentStart + time(end, rates) : duration ? start + time(duration, rates) : Infinity);
      if (element.localName === "p") cues.push({ start, end: finish, text: clean(textOf(element)) });
      else for (const child of Array.from(element.children || element.childNodes || [])) if (child.nodeType === 1) walk(child, start, finish);
    }
    walk(tt);
    return finalize(cues, tt.getAttribute("xml:lang") || attribute(tt, "lang"));
  }
  function parse(raw, Parser) {
    if (typeof raw !== "string" || raw.length > 4 * 1024 * 1024) throw new Error("자막 파일이 너무 큽니다.");
    const track = /^\s*\uFEFF?WEBVTT\b/.test(raw) ? parseVtt(raw.trimStart()) : parseTtml(raw, Parser);
    if (!track.cues.length) throw new Error("읽을 수 있는 자막 문장이 없습니다.");
    if (track.cues.length > 15000) throw new Error("자막 문장이 너무 많습니다.");
    return track;
  }
  function isKorean(track) {
    if (track.language) return /^ko(?:-|$)/i.test(track.language);
    const sample = track.cues.slice(0, 80).map(c => c.text).join("");
    const letters = sample.match(/\p{L}/gu)?.length || 0;
    return letters > 0 && (sample.match(/[가-힣]/g)?.length || 0) / letters > 0.35;
  }
  function active(cues, seconds) {
    // Binary search finds the last started cue; scan backward for overlapping cues.
    let lo = 0, hi = cues.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (cues[mid].start <= seconds) lo = mid + 1; else hi = mid; }
    const result = [];
    for (let i = lo - 1; i >= 0; i--) {
      if (cues[i].end > seconds) result.push(cues[i]);
    }
    return result.reverse();
  }
  function nextBatch(cues, translations, seconds, size = 24, reserved = new Set()) {
    const missing = cues.filter(c => !translations.has(c.id) && !reserved.has(c.id));
    const ahead = missing.filter(c => c.end > seconds);
    const result = [];
    let characters = 0;
    for (const cue of ahead.length ? ahead : missing) {
      if (result.length >= size || characters + cue.text.length > 16000) break;
      result.push(cue); characters += cue.text.length;
    }
    return result;
  }
  function validateTranslation(content, items) {
    let parsed;
    try { parsed = JSON.parse(content); } catch { throw new Error("번역 응답이 JSON 형식이 아닙니다. 다시 시도해 주세요."); }
    if (!Array.isArray(parsed.translations) || parsed.translations.length !== items.length) throw new Error("번역 문장 수가 맞지 않습니다. 다시 시도해 주세요.");
    const expected = new Set(items.map(i => i.id)), found = new Set();
    for (const item of parsed.translations) {
      if (!item || !expected.has(item.id) || found.has(item.id) || typeof item.text !== "string" || !item.text.trim() || item.text.length > 6000) throw new Error("번역 문장 번호 또는 내용이 올바르지 않습니다.");
      found.add(item.id);
    }
    return parsed.translations.map(item => ({ id: item.id, text: item.text.trim() }));
  }
  const api = { time, clean, parse, parseVtt, parseTtml, isKorean, active, nextBatch, validateTranslation };
  root.TogetherSubtitles = api;
  if (typeof module !== "undefined") module.exports = api;
})(globalThis);
