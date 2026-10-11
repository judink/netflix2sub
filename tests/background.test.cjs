const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const S = require("../subtitles.js");
function worker(fetcher, overrides = {}) {
  let listener;
  const stored = { apiKey: "secret-test-key", enabled: true, model: "deepseek-flash", updatedAt: 1, ...overrides };
  const context = {
    TogetherSubtitles: S, importScripts() {}, fetch: fetcher, URL, AbortController, setTimeout, clearTimeout,
    chrome: {
      runtime: { id: "unit-test", getURL: path => "chrome-extension://unit-test/" + path, onMessage: { addListener: fn => listener = fn } },
      storage: { local: { setAccessLevel: async () => {}, get: async () => stored }, onChanged: { addListener() {} } }
    }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve("../background.js"), "utf8"), context);
  const sender = { id: "unit-test", url: "https://www.netflix.com/watch/123", tab: { id: 1 } };
  return (message, customSender = sender) => new Promise(resolve => listener(message, customSender, resolve));
}
const translation = (id = 7) => ({ ok: true, json: async () => ({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ translations: [{ id, text: "Привіт" }] }) } }] }) });
const message = { type: "TRANSLATE", requestId: "a", items: [{ id: 7, text: "안녕" }] };
test("API key stays in worker and repeated text uses cache with the current cue id", async () => {
  let calls = 0;
  const send = worker(async (url, options) => {
    calls++;
    assert.equal(url, "https://api.deepseek.com/chat/completions");
    assert.equal(options.headers.Authorization, "Bearer secret-test-key");
    const body = JSON.parse(options.body);
    assert.equal(body.thinking.type, "disabled");
    assert.equal(body.response_format.type, "json_object");
    return translation();
  });
  const settings = await send({ type: "SETTINGS" });
  assert.equal(settings.settings.apiKey, undefined);
  assert.equal(settings.settings.hasKey, true);
  assert.equal((await send(message)).translations[0].id, 7);
  const cached = await send({ ...message, items: [{ id: 9, text: "안녕" }] });
  assert.equal(cached.translations[0].id, 9);
  assert.equal(calls, 1);
});
test("disabled translation and untrusted senders cannot make API calls", async () => {
  const send = worker(() => { throw new Error("must not call API"); }, { enabled: false });
  assert.equal((await send(message)).ok, false);
  assert.equal((await send(message, { id: "other", url: "https://evil.example" })).ok, false);
  assert.equal((await send({ type: "TEST" })).ok, false);
});
test("HTTP errors never expose the remote response body or API key", async () => {
  const send = worker(async () => ({ ok: false, status: 401, text: async () => "secret-test-key" }));
  const result = await send(message);
  assert.equal(result.ok, false);
  assert.match(result.error, /API 키/);
  assert.equal(result.error.includes("secret-test-key"), false);
});
test("incomplete model responses cannot attach translations to the wrong cue", async () => {
  const send = worker(async () => translation(999));
  assert.equal((await send(message)).ok, false);
});
test("oversized requests and duplicate ids are rejected before API calls", async () => {
  const send = worker(() => { throw new Error("must not call API"); });
  assert.equal((await send({ ...message, items: Array.from({ length: 25 }, (_, id) => ({ id, text: "안녕" })) })).ok, false);
  assert.equal((await send({ ...message, items: [{ id: 1, text: "안녕" }, { id: 1, text: "좋아" }] })).ok, false);
});
test("cancellation aborts the current fetch without leaving a blocked queue", async () => {
  let started;
  const waiting = new Promise(resolve => started = resolve);
  let first = true;
  const send = worker(async (_url, { signal }) => {
    if (!first) return translation();
    first = false;
    started();
    return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  });
  const pending = send(message);
  await waiting;
  await send({ type: "CANCEL", requestId: "a" });
  assert.equal((await pending).ok, false);
  assert.equal((await send({ ...message, requestId: "b" })).ok, true);
});
test("two batches in one tab can run concurrently; a third is deferred", async () => {
  const releases = [];
  const send = worker(async (_url, options) => {
    const items = JSON.parse(JSON.parse(options.body).messages[1].content).subtitles;
    await new Promise(resolve => releases.push(resolve));
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ translations: items.map(item => ({ id: item.id, text: "Привіт" })) }) } }] }) };
  });
  const first = send(message);
  const second = send({ ...message, requestId: "b", items: [{ id: 8, text: "다음 대사" }] });
  while (releases.length < 2) await new Promise(resolve => setImmediate(resolve));
  const third = await send({ ...message, requestId: "c" });
  assert.equal(third.retryable, true);
  releases.forEach(resolve => resolve());
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, true);
});
test("a cancel delivered before a job registers prevents that paid request", async () => {
  let calls = 0;
  const send = worker(async () => { calls++; return translation(); });
  const pending = send(message);
  await send({ type: "CANCEL", requestId: "a" });
  assert.equal((await pending).cancelled, true);
  assert.equal(calls, 0);
});
