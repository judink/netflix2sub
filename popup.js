"use strict";
const $ = id => document.getElementById(id);
let tabId;
const fields = ["enabled", "apiKey", "model", "fontSize", "top"];
const ready = (async () => {
  const result = await chrome.runtime.sendMessage({ type: "SETTINGS" });
  if (!result?.ok) throw new Error(result?.error || "설정을 불러오지 못했습니다.");
  const stored = await chrome.storage.local.get(fields);
  const settings = { ...result.settings, ...stored };
  for (const id of fields) if (id === "enabled") $(id).checked = Boolean(settings[id]); else $(id).value = settings[id] ?? "";
  values();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url?.startsWith("https://www.netflix.com/")) tabId = tab.id;
})();
function values() { $("fontValue").value = $("fontSize").value + "px"; $("topValue").value = $("top").value + "%"; }
$("fontSize").addEventListener("input", values); $("top").addEventListener("input", values);
$("reveal").addEventListener("click", () => { const show = $("apiKey").type === "password"; $("apiKey").type = show ? "text" : "password"; $("reveal").textContent = show ? "숨기기" : "보기"; });
async function tabMessage(message) {
  if (!tabId) return null;
  try { return await chrome.tabs.sendMessage(tabId, message); } catch { return null; }
}
async function save() {
  await ready;
  const previous = await chrome.storage.local.get(["apiKey", "model", "updatedAt"]);
  const apiKey = $("apiKey").value.trim();
  const model = $("model").value;
  const changed = previous.apiKey !== apiKey || previous.model !== model;
  const config = { enabled: $("enabled").checked, apiKey, model, fontSize: Number($("fontSize").value), top: Number($("top").value), updatedAt: changed ? Date.now() : (previous.updatedAt || 0) };
  if (config.enabled && !config.apiKey) throw new Error("번역을 켜려면 API 키를 입력해 주세요.");
  await chrome.storage.local.set(config);
  await tabMessage({ type: "REFRESH" });
}
$("settings").addEventListener("submit", async event => {
  event.preventDefault();
  try { await save(); $("feedback").textContent = "저장했습니다. 넷플릭스에서 한국어 자막을 켜 주세요."; }
  catch (error) { $("feedback").textContent = error.message; }
});
$("enabled").addEventListener("change", async () => {
  try { await save(); $("feedback").textContent = $("enabled").checked ? "번역을 켰습니다. 자막을 순차적으로 미리 번역합니다." : "번역을 껐습니다."; }
  catch (error) { $("enabled").checked = false; $("feedback").textContent = error.message; }
});
$("test").addEventListener("click", async () => {
  $("test").disabled = true;
  $("feedback").textContent = "짧은 문장으로 연결을 테스트합니다…";
  try {
    await save();
    const result = await chrome.runtime.sendMessage({ type: "TEST", requestId: crypto.randomUUID() });
    if (!result?.ok) throw new Error(result?.error || "연결 테스트에 실패했습니다.");
    $("feedback").textContent = "연결 성공 · " + result.translations[0].text;
  } catch (error) { $("feedback").textContent = error.message; }
  finally { $("test").disabled = false; }
});
$("retry").addEventListener("click", async () => {
  await tabMessage({ type: "RETRY" }); await updateStatus();
});
async function updateStatus() {
  await ready;
  const state = await tabMessage({ type: "STATUS" });
  if (!state) { $("status").textContent = tabId ? "넷플릭스 페이지를 새로고침해 주세요." : "넷플릭스 재생 탭에서 열어 주세요."; return; }
  $("status").textContent = !state.watchId ? "영화나 에피소드를 재생해 주세요." : state.error || (!state.captured ? "한국어 자막 파일을 기다리는 중입니다." : `${state.translated} / ${state.total}문장 번역${state.busy ? " · 번역 중" : ""}`);
  $("progress").max = state.total || 1; $("progress").value = state.translated;
}
ready.then(updateStatus).catch(error => { $("feedback").textContent = error.message; });
setInterval(() => { void updateStatus().catch(() => {}); }, 1000);
