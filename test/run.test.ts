import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sessionNamer from "../src/index.js";

// The factory reads ~/.pi/agent/session-namer.json when it runs, so point HOME at
// a scratch directory: these tests exercise the retry budget, not the user's config.
const home = mkdtempSync(join(tmpdir(), "session-namer-run-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
test.after(() => rmSync(home, { recursive: true, force: true }));

type Reply = "OK" | "SKIP" | "EMPTY" | "ERROR";

const MESSAGE_ENTRY = [{ type: "message", message: { role: "user", content: [{ type: "text", text: "fix the OAuth callback bug" }] } }];
const REPLIES: Record<Reply, unknown> = {
  OK: { content: [{ type: "text", text: "Fix｜OAuth callback bug" }], stopReason: "stop" },
  SKIP: { content: [{ type: "text", text: "SKIP" }], stopReason: "stop" },
  EMPTY: { content: [], stopReason: "stop" },
  ERROR: { content: [], stopReason: "error", errorMessage: "429 too many requests" },
};

/** Drive the real `agent_settled` handler against a stubbed extension context. */
function createHarness() {
  let sessionName: string | undefined;
  let branch: unknown[] = MESSAGE_ENTRY;
  let reply: Reply = "OK";
  const handled = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
  const model = { provider: "probe", id: "probe", api: "openai-completions", reasoning: false };
  const ctx = {
    hasUI: false,
    ui: { notify: () => {} },
    sessionManager: {
      getBranch: () => branch,
      getEntries: () => [],
      getHeader: () => ({ timestamp: "2026-03-10T00:00:00.000Z" }),
      getSessionFile: () => join(home, "session.jsonl"),
    },
    model,
    modelRegistry: {
      find: () => model,
      hasConfiguredAuth: () => true,
      complete: async () => REPLIES[reply],
    },
    thinkingLevel: "off",
  };
  sessionNamer({
    on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => handled.set(event, handler),
    registerCommand: () => {},
    appendEntry: () => {},
    getSessionName: () => sessionName,
    setSessionName: (name: string) => { sessionName = name; },
  } as never);

  return {
    async settle(withContext: boolean) {
      branch = withContext ? MESSAGE_ENTRY : [];
      await handled.get("agent_settled")!({}, ctx);
    },
    setReply(next: Reply) { reply = next; },
    name: () => sessionName,
  };
}

test("keeps naming after empty-context checks instead of spending the retry budget", async () => {
  const harness = createHarness();
  for (let run = 0; run < 3; run++) await harness.settle(false);
  assert.equal(harness.name(), undefined);

  await harness.settle(true);

  assert.equal(harness.name(), "0310｜Fix｜OAuth callback bug");
});

test("a SKIP answer does not consume the retry budget", async () => {
  const harness = createHarness();
  harness.setReply("SKIP");
  for (let run = 0; run < 3; run++) await harness.settle(true);
  harness.setReply("OK");

  await harness.settle(true);

  assert.equal(harness.name(), "0310｜Fix｜OAuth callback bug");
});

test("three real model failures stop automatic naming until a manual refresh", async () => {
  const harness = createHarness();
  harness.setReply("EMPTY");
  for (let run = 0; run < 3; run++) await harness.settle(true);
  harness.setReply("OK");

  await harness.settle(true);

  assert.equal(harness.name(), undefined, "a broken model must not be retried forever");
});
