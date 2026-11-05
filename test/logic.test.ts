import test from "node:test";
import assert from "node:assert/strict";
import { buildContextLine, buildConversationText, buildHintRule, buildOutputRule, buildReuseRule, formatDate, MAX_ERROR_LENGTH, missMessage, parseModelResult, parseModelSegments, parseRefreshArgs, resolveTimeZone, responseError } from "../src/index.js";

test("formats dates in the requested timezone", () => {
  assert.equal(formatDate("2026-03-11T00:30:00.000Z", "America/Los_Angeles"), "0310");
  assert.equal(formatDate("2026-03-11T00:30:00.000Z", "Asia/Shanghai"), "0311");
});

test("buildConversationText emphasizes the newest message", () => {
  const long = "x".repeat(1200);
  const entries = [
    { type: "message", message: { role: "user", content: "old question" } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: long }] } },
  ];
  const text = buildConversationText(entries as never);
  assert.ok(text.includes("old question"));
  // The newest (last) message keeps more than the old 700-char cap.
  assert.ok(text.length > 700 + "old question".length);
  assert.ok(text.split("x").length - 1 > 700);
});

test("buildConversationText keeps the newest message intact under budget pressure", () => {
  // 12 long messages: the first 11 fill the budget, so the oldest must be
  // dropped while the newest (with a completion report) stays intact.
  const filler = "y".repeat(700);
  const entries = [] as { type: string; message: { role: string; content: unknown } }[];
  for (let i = 0; i < 11; i++) {
    entries.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: filler }] } });
  }
  const report = "重启后验证正常：系统状态正常，蓝屏事件为 0，任务完成。";
  entries.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: report }] } });
  const text = buildConversationText(entries as never, 12, 5000);
  // The completion report survives untouched.
  assert.ok(text.includes(report));
  // Budget: 5000 - report(~40) = ~4960; each earlier message capped at 700 → about 7 kept.
  const yCount = text.split("y").length - 1;
  assert.ok(yCount <= 7 * 700);
  // And the oldest messages were dropped, not the newest.
  assert.ok(text.trimEnd().endsWith(report));
});

test("buildConversationText selects the newest message window", () => {
  const entries = [
    { type: "message", message: { role: "user", content: "OLDEST_SENTINEL" } },
    ...Array.from({ length: 13 }, (_, index) => ({
      type: "message",
      message: { role: "assistant", content: `middle-${index}` },
    })),
    { type: "message", message: { role: "assistant", content: "NEWEST_SENTINEL" } },
  ];

  const text = buildConversationText(entries as never, 12, 50_000);

  assert.ok(!text.includes("OLDEST_SENTINEL"));
  assert.ok(text.includes("NEWEST_SENTINEL"));
  assert.ok(text.trimEnd().endsWith("NEWEST_SENTINEL"));
});

test("falls back for an invalid timezone", () => {
  assert.doesNotThrow(() => resolveTimeZone("Not/AZone"));
});

test("parses model control responses", () => {
  assert.equal(parseModelResult("SKIP", "0310"), "SKIP");
  // 空输出是“模型没吐字”，不是“上下文不足”。
  assert.equal(parseModelResult("", "0310"), "EMPTY");
  assert.equal(parseModelResult("  \n\t ", "0310"), "EMPTY");
  assert.equal(parseModelResult("KEEP", "0310"), null);
  assert.equal(parseModelResult("修复｜OAuth 回调错误", "0310"), "0310｜修复｜OAuth 回调错误");
  assert.equal(parseModelResult("Research｜GitHub skills discovery｜published 0.1.1", "0310"), "0310｜Research｜GitHub skills discovery｜published 0.1.1");
  assert.equal(parseModelResult("Research｜GitHub skills discovery", "0310"), "0310｜Research｜GitHub skills discovery");
  assert.equal(parseModelResult("Research｜GitHub skills discovery｜this progress text is way longer than sixteen chars", "0310"), "0310｜Research｜GitHub skills discovery｜this progress te");
  assert.equal(parseModelResult("随便猜一个", "0310"), null);
});

test("renders custom name formats", () => {
  assert.equal(parseModelResult("Fix｜OAuth callback errors｜testing", "0310", "{type}: {topic} ({progress})"), "Fix: OAuth callback errors (testing)");
  assert.equal(parseModelResult("修复｜回调错误｜待审查", "0310", "{date}｜{type}｜{topic}"), "0310｜修复｜回调错误");
  assert.equal(parseModelResult("Fix｜Login bug", "0310", "{date}｜{type}｜{topic}"), "0310｜Fix｜Login bug");
});

test("parses model segments for diff-based change detection", () => {
  const a = parseModelSegments("Fix｜OAuth callback errors｜published 0.1.1", true);
  const b = parseModelSegments("Fix｜OAuth callback errors｜published 0.2.0", true);
  const c = parseModelSegments("Research｜GitHub skills discovery", true);
  assert.deepEqual(a, { type: "Fix", topic: "OAuth callback errors", progress: "published 0.1.1" });
  assert.deepEqual(b, { type: "Fix", topic: "OAuth callback errors", progress: "published 0.2.0" });
  assert.deepEqual(c, { type: "Research", topic: "GitHub skills discovery", progress: undefined });
  if (typeof a === "object" && typeof b === "object" && typeof c === "object") {
    assert.equal(a.type !== c.type || a.topic !== c.topic, true);
    assert.equal(a.type === b.type && a.topic === b.topic && a.progress !== b.progress, true);
  }
  assert.equal(parseModelSegments("SKIP", true), "SKIP");
  assert.equal(parseModelSegments("", true), "EMPTY");
  assert.equal(parseModelSegments("随便猜一个", true), null);
});

test("manual refresh tells the model to always produce a name", () => {
  const manual = buildOutputRule(true, true);
  assert.ok(manual.includes("Never output SKIP"));
  assert.ok(manual.includes('"Type｜Topic｜Progress"'));
  const automatic = buildOutputRule(false, false);
  assert.ok(automatic.includes("SKIP only if there is no clear task"));
  assert.ok(automatic.includes('"Type｜Topic"'));
});

test("explains each miss reason instead of blaming context", () => {
  assert.match(missMessage("NO_CONTEXT"), /no conversation content/i);
  assert.match(missMessage("EMPTY"), /returned no text/i);
  assert.match(missMessage("SKIP"), /add an instruction/i);
  assert.match(missMessage("ERROR", "Provider finish_reason: content_filter"), /content_filter/);
  assert.match(missMessage("ERROR"), /failed/i);
  assert.match(missMessage(null), /No valid session name/);
});

test("surfaces provider errors instead of calling them an empty response", () => {
  assert.equal(responseError({ stopReason: "stop" }), undefined);
  assert.equal(responseError({ stopReason: "error", errorMessage: " 429 too many requests \n" }), "429 too many requests");
  assert.match(responseError({ stopReason: "error" }) ?? "", /error/);
  assert.match(responseError({ stopReason: "aborted" }) ?? "", /aborted/);
  const long = "x".repeat(MAX_ERROR_LENGTH + 50);
  assert.equal(responseError({ stopReason: "error", errorMessage: long })?.length, MAX_ERROR_LENGTH);
});

test("parses refresh command arguments", () => {
  assert.deepEqual(parseRefreshArgs(""), { force: false });
  assert.deepEqual(parseRefreshArgs("   "), { force: false });
  assert.deepEqual(parseRefreshArgs("force"), { force: true });
  assert.deepEqual(parseRefreshArgs("FORCE"), { force: true });
  assert.deepEqual(parseRefreshArgs("force:"), { force: true });
  assert.deepEqual(parseRefreshArgs("force 类型用中文"), { force: true, hint: "类型用中文" });
  assert.deepEqual(parseRefreshArgs("force: 用英文"), { force: true, hint: "用英文" });
  // 任意其他文本也强制重评，并作为附加要求注入。
  assert.deepEqual(parseRefreshArgs("主题别用文件名"), { force: true, hint: "主题别用文件名" });
  // "forces" 不是关键字，整段文本作为要求。
  assert.deepEqual(parseRefreshArgs("forces x"), { force: true, hint: "forces x" });
  assert.deepEqual(parseRefreshArgs("force\n  类型  用\n中文"), { force: true, hint: "类型 用 中文" });
  assert.equal(parseRefreshArgs(`force ${"x".repeat(300)}`).hint?.length, 200);
});

test("builds a force context line without feeding back the old segments", () => {
  const segments = { type: "Fix", topic: "OAuth callback errors", progress: "testing" };
  const forced = buildContextLine(true, segments, "0310｜Fix｜OAuth callback errors｜testing");
  assert.ok(forced.includes("forced re-evaluation"));
  assert.ok(!forced.includes("reuse them EXACTLY"));
  const reused = buildContextLine(false, segments, "ignored");
  assert.ok(reused.includes("reuse them EXACTLY"));
  assert.ok(reused.includes("Fix｜OAuth callback errors"));
  assert.ok(buildContextLine(false, undefined, "0310｜Fix｜OAuth callback errors").startsWith("Current name:"));
});

test("builds the reuse and hint rules", () => {
  assert.ok(buildReuseRule(true, true).includes("from scratch"));
  assert.ok(buildReuseRule(true, false).includes("from scratch"));
  assert.ok(buildReuseRule(false, true).includes("only the progress may change"));
  assert.ok(buildReuseRule(false, false).includes("output them EXACTLY as written"));
  assert.equal(buildHintRule(), "");
  assert.ok(buildHintRule("类型用中文").includes("highest priority"));
  assert.ok(buildHintRule("类型用中文").includes("类型用中文"));
});
