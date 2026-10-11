const { test } = require("node:test");
const assert = require("node:assert/strict");
const S = require("../subtitles.js");

test("VTT clocks and Netflix TTML tick clocks remain in seconds", () => {
  assert.equal(S.time("01:02:03.250"), 3723.25);
  assert.equal(S.time("02:03,250"), 123.25);
  assert.equal(S.time("20000000t"), 2);
  assert.equal(S.time("90f", { frameRate: 30 }), 3);
  assert.equal(S.time("00:00:01:15", { frameRate: 30 }), 1.5);
  assert.equal(S.time("500ms"), 0.5);
  assert.ok(Number.isNaN(S.time("bad")));
});
test("VTT preserves multiline dialogue, decodes text, skips notes and invalid timing", () => {
  const track = S.parse("\uFEFFWEBVTT\nLanguage: ko\n\nNOTE ignored\n\n1\n00:01.000 --> 00:03.000 align:middle\n<c>안녕 &amp; 반가워</c>\n- 같이 보자\n\n00:04.000 --> 00:06.000\n좋아!\n\n00:08.000 --> 00:07.000\n잘못된 시간\n");
  assert.equal(track.language, "ko");
  assert.equal(track.cues.length, 2);
  assert.equal(track.cues[0].text, "안녕 & 반가워\n- 같이 보자");
  assert.ok(S.isKorean(track));
  assert.deepEqual(S.active(track.cues, 3), []);
  assert.equal(S.active(track.cues, 4)[0].text, "좋아!");
});
test("seek scheduling prioritizes untranslated cues at the playhead, then earlier gaps", () => {
  const cues = Array.from({ length: 50 }, (_, id) => ({ id, start: id * 2, end: id * 2 + 1, text: "문장" }));
  const done = new Map([[30, "переклад"]]);
  assert.deepEqual(S.nextBatch(cues, done, 60, 3).map(c => c.id), [31, 32, 33]);
  assert.deepEqual(S.nextBatch(cues, done, 1000, 3).map(c => c.id), [0, 1, 2]);
  assert.deepEqual(S.active(cues, 1.5), []);
  assert.equal(S.active(cues, 60)[0].id, 30);
});
test("parallel lookahead avoids reserved ids and respects the API text budget", () => {
  const cues = Array.from({ length: 40 }, (_, id) => ({ id, start: id * 2, end: id * 2 + 1, text: "문장" }));
  const first = S.nextBatch(cues, new Map(), 0, 4);
  const second = S.nextBatch(cues, new Map(), 0, 24, new Set(first.map(cue => cue.id)));
  assert.equal(first.length, 4);
  assert.equal(second.length, 24);
  assert.equal(second[0].id, 4);
  const large = cues.map(cue => ({ ...cue, text: "가".repeat(2000) }));
  assert.equal(S.nextBatch(large, new Map(), 0).length, 8);
});
test("overlapping cues and backwards seeks preserve both speakers", () => {
  const cues = [{ id: 0, start: 1, end: 10 }, { id: 1, start: 3, end: 4 }];
  assert.deepEqual(S.active(cues, 3.5).map(c => c.id), [0, 1]);
  assert.deepEqual(S.active(cues, 5).map(c => c.id), [0]);
  assert.deepEqual(S.active(cues, 1).map(c => c.id), [0]);
});
test("wrong-language tracks are rejected, unlabeled Hangul is recognized", () => {
  assert.equal(S.isKorean({ language: "uk", cues: [{ text: "안녕하세요" }] }), false);
  assert.equal(S.isKorean({ language: "ko-KR", cues: [] }), true);
  assert.equal(S.isKorean({ language: "", cues: [{ text: "같이 영화를 보자" }] }), true);
  assert.equal(S.isKorean({ language: "", cues: [{ text: "Hello there" }] }), false);
});
test("translation ids must match exactly even when a model reorders them", () => {
  const items = [{ id: 2, text: "안녕" }, { id: 5, text: "좋아" }];
  assert.equal(S.validateTranslation('{"translations":[{"id":5,"text":"Так"},{"id":2,"text":"Привіт"}]}', items).length, 2);
  for (const content of ["not json", '{"translations":[]}', '{"translations":[{"id":2,"text":"Так"},{"id":2,"text":"Так"}]}', '{"translations":[{"id":2,"text":"Так"},{"id":8,"text":"Так"}]}', '{"translations":[{"id":2,"text":"Так"},{"id":5,"text":""}]}']) {
    assert.throws(() => S.validateTranslation(content, items));
  }
});
