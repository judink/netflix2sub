// Run with: node tests/browser.cjs <path-to-playwright-module> [browser-executable]
// Synthetic playback only: this never logs in to Netflix or calls DeepSeek.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require(process.argv[2] || "playwright");
const root = path.join(__dirname, "..");
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" xml:lang="ko" ttp:tickRate="10000000">
<body><div><p begin="10000000t" end="30000000t"><span>안녕 &amp; 반가워.</span><br/>같이 보자.</p>
<p begin="40000000t" end="60000000t">좋아!</p></div></body></tt>`;
(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.argv[3] ? { executablePath: process.argv[3] } : { channel: "msedge" }) });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    const subtitleDownloads = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
      const url = route.request().url();
      if (url.includes("nflxvideo.net")) {
        subtitleDownloads.push(url);
        let body = xml;
        if (url.includes("episode=456")) body = xml.replace("안녕 &amp; 반가워.", "다음 화를 시작하자.");
        if (url.includes("episode=789")) body = xml.replace("안녕 &amp; 반가워.", "세 번째 이야기를 시작하자.");
        if (url.includes("episode=900")) body = `<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml" xml:lang="ko"><body><div>${Array.from({ length: 40 }, (_, id) => `<p begin="${id * 2}s" end="${id * 2 + 1.8}s">빠른 번역 ${id}</p>`).join("")}</div></body></tt>`;
        if (url.includes("episode=901")) body = xml.replace("안녕 &amp; 반가워.", "새로운 이야기야.");
        return route.fulfill({ status: 200, contentType: "application/ttml+xml", body });
      }
      return route.fulfill({ status: 200, contentType: "text/html", body: '<!doctype html><html><body style="margin:0;background:#16171d;color:white"><div class="watch-video" style="position:relative;width:1280px;height:720px;background:linear-gradient(130deg,#182d40,#0b1018)"><video style="width:100%;height:100%"></video><div style="position:absolute;bottom:165px;width:100%;text-align:center;font:30px Arial">안녕 &amp; 반가워.<br>같이 보자.</div></div></body></html>' });
    });
    await page.addInitScript(() => {
      window.testConfig = { enabled: false, hasKey: true, model: "deepseek-flash", fontSize: 28, top: 4, updatedAt: 0 };
      window.testTime = 1.5;
      window.testRequests = 0;
      window.testBatches = [];
      window.testInFlight = 0;
      window.testMaxInFlight = 0;
      window.testDelay = 50;
      window.testListeners = [];
      window.chrome = { runtime: {
        async sendMessage(message) {
          if (message.type === "SETTINGS") return { ok: true, settings: { ...window.testConfig } };
          if (message.type === "CANCEL") return { ok: true };
          if (message.type === "TRANSLATE") {
            window.testRequests++;
            window.testBatches.push({ path: location.pathname, ids: message.items.map(item => item.id) });
            window.testInFlight++;
            window.testMaxInFlight = Math.max(window.testMaxInFlight, window.testInFlight);
            await new Promise(resolve => setTimeout(resolve, message.items.length > 4 ? 700 : window.testDelay));
            window.testInFlight--;
            return { ok: true, translations: message.items.map(item => ({ id: item.id, text: item.text.includes("다음 화") ? "Почнімо наступну серію." : item.text.includes("세 번째") ? "Третя історія." : item.text.includes("빠른") ? "Швидкий переклад " + item.id : item.text.includes("새로운") ? "Нова історія." : item.text.includes("안녕") ? "Привіт!\nДивімося разом." : "Гаразд!" })) };
          }
        },
        onMessage: { addListener(listener) { window.testListeners.push(listener); } }
      } };
      const original = Element.prototype.attachShadow;
      Element.prototype.attachShadow = function () { return original.call(this, { mode: "open" }); };
      Object.defineProperty(HTMLMediaElement.prototype, "currentTime", { get() { return window.testTime; } });
    });
    await page.addInitScript({ path: path.join(root, "capture.js") });
    await page.addInitScript({ path: path.join(root, "subtitles.js") });
    await page.addInitScript({ path: path.join(root, "content.js") });
    await page.goto("https://www.netflix.com/watch/123");
    // Native DOMParser verifies TTML, inherited timing, entities and line breaks.
    const parsed = await page.evaluate(raw => TogetherSubtitles.parse(raw), xml);
    assert.equal(parsed.language, "ko");
    assert.equal(parsed.cues[0].start, 1);
    assert.equal(parsed.cues[0].end, 3);
    assert.equal(parsed.cues[0].text, "안녕 & 반가워.\n같이 보자.");
    const nested = await page.evaluate(() => TogetherSubtitles.parse('<tt xmlns="http://www.w3.org/ns/ttml" xml:lang="ko"><body begin="2s" end="20s"><div begin="1s"><p begin="1s" dur="2s">안녕</p><p begin="1s" dur="2s">친구</p></div></body></tt>'));
    assert.equal(nested.cues.length, 1);
    assert.equal(nested.cues[0].start, 4);
    assert.equal(nested.cues[0].end, 6);
    assert.equal(nested.cues[0].text, "안녕\n친구");
    await page.evaluate(async () => { await fetch("https://example.nflxvideo.net/?track=korean"); });
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => window.testRequests), 0, "capture alone must not make paid requests");
    await page.evaluate(() => {
      window.testConfig.enabled = true;
      for (const listener of window.testListeners) listener({ type: "REFRESH" }, {}, () => {});
    });
    await page.waitForFunction(() => document.querySelector("#together-uk-subtitles")?.shadowRoot.querySelector(".line")?.textContent.includes("Привіт"));
    const top = await page.evaluate(() => document.querySelector("#together-uk-subtitles").shadowRoot.querySelector(".line").getBoundingClientRect().top);
    assert.ok(top >= 25 && top < 40, `subtitle should be near the top, got y=${top}`);
    await page.evaluate(() => { window.testTime = 3.5; });
    await page.waitForFunction(() => document.querySelector("#together-uk-subtitles").shadowRoot.querySelector(".line").textContent === "");
    await page.evaluate(() => { window.testTime = 4.5; document.querySelector("video").dispatchEvent(new Event("seeking")); });
    await page.waitForFunction(() => document.querySelector("#together-uk-subtitles").shadowRoot.querySelector(".line").textContent === "Гаразд!");
    // The XHR interceptor must handle arraybuffer responses without touching the player data.
    const xhrText = await page.evaluate(() => new Promise(resolve => {
      const request = new XMLHttpRequest();
      request.open("GET", "https://example.nflxvideo.net/?track=korean-xhr");
      request.responseType = "arraybuffer";
      request.addEventListener("load", () => resolve(new TextDecoder().decode(request.response)));
      request.send();
    }));
    assert.equal(xhrText, xml);
    const requestsBeforePrefetch = await page.evaluate(() => window.testRequests);
    // Netflix can preload the next episode while the previous watch URL is still active.
    await page.evaluate(() => {
      JSON.parse(JSON.stringify({ result: { movieId: 456, timedtexttracks: [{ language: "ko", rawTrackType: "subtitles", ttDownloadables: { "webvtt-lssdh-ios8": { downloadUrls: { cdn: "https://example.nflxvideo.net/?episode=456" } } } }] } }));
    });
    await page.evaluate(async () => { await fetch("https://example.nflxvideo.net/?episode=456"); });
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => window.testRequests), requestsBeforePrefetch, "next episode must not be translated under the old episode id");
    assert.equal(await page.evaluate(() => document.querySelector("#together-uk-subtitles").shadowRoot.querySelector(".line").textContent), "Гаразд!");
    const beforeSwitch = subtitleDownloads.length;
    await page.evaluate(() => { window.testTime = 1.5; history.pushState({}, "", "/watch/456"); });
    await page.waitForFunction(() => document.querySelector("#together-uk-subtitles").shadowRoot.querySelector(".line").textContent.includes("Почнімо"));
    assert.equal(subtitleDownloads.length, beforeSwitch, "prefetched track should be reused without another download");
    // A manifest-only next episode must recover its Korean file automatically.
    await page.evaluate(() => {
      JSON.parse(JSON.stringify({ result: { movieId: 789, timedtexttracks: [{ language: "ko", rawTrackType: "subtitles", ttDownloadables: { "imsc1.1": { urls: [{ url: "https://example.nflxvideo.net/?episode=789" }] } } }] } }));
      history.replaceState({}, "", "/watch/789");
    });
    await page.waitForFunction(() => document.querySelector("#together-uk-subtitles").shadowRoot.querySelector(".line").textContent.includes("Третя"));
    assert.ok(subtitleDownloads.some(url => url.includes("episode=789")));
    // Verify urgent output is visible while a larger lookahead batch is still running.
    await page.evaluate(async () => { window.testTime = 0.5; history.pushState({}, "", "/watch/900"); await fetch("https://example.nflxvideo.net/?episode=900"); });
    await page.waitForFunction(() => document.querySelector("#together-uk-subtitles").shadowRoot.querySelector(".line").textContent.includes("Швидкий"));
    const lanes = await page.evaluate(() => ({ batches: window.testBatches.filter(item => item.path === "/watch/900"), inFlight: window.testInFlight, max: window.testMaxInFlight }));
    assert.equal(lanes.batches[0].ids.length, 4);
    assert.equal(lanes.batches[1].ids.length, 24);
    assert.equal(lanes.batches[0].ids.some(id => lanes.batches[1].ids.includes(id)), false);
    assert.ok(lanes.inFlight > 0, "urgent text should render before lookahead completes");
    assert.equal(lanes.max, 2);
    // Simulate late old replies despite cancellation: none may enter the new episode.
    await page.evaluate(async () => { window.testTime = 1.5; history.pushState({}, "", "/watch/901"); await fetch("https://example.nflxvideo.net/?episode=901"); });
    await page.waitForFunction(() => document.querySelector("#together-uk-subtitles").shadowRoot.querySelector(".line").textContent.includes("Нова"));
    await page.waitForTimeout(800);
    assert.equal(await page.evaluate(() => document.querySelector("#together-uk-subtitles").shadowRoot.querySelector(".line").textContent.includes("Нова")), true);
    await page.evaluate(() => { history.pushState({}, "", "/watch/999"); });
    await page.waitForFunction(() => document.querySelector("#together-uk-subtitles").shadowRoot.querySelector(".line").textContent === "");
    assert.equal(errors.length, 0, errors.join("\n"));
    console.log("PASS: TTML parsing, fetch/XHR capture, opt-in, top placement, seek, next-episode prefetch replay, manifest recovery, parallel urgent/lookahead translation, stale-reply isolation.");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
