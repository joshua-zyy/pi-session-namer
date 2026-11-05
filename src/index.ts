import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const ENTRY_TYPE = "pi-session-namer";
export const DEFAULT_TYPES = ["Feature", "Design", "Fix", "Optimization", "Release", "Exploration", "Documentation", "Research"] as const;
export const DEFAULT_CONFIG = {
  model: "inherit",
  thinkingLevel: "inherit",
  timeZone: "auto",
  checkEveryTurns: 4,
  nameFormat: "{date}｜{type}｜{topic}｜{progress}",
  types: [...DEFAULT_TYPES],
  nameLanguage: "auto",
} as const;
export const PLACEHOLDERS = ["{date}", "{type}", "{topic}", "{progress}"] as const;
export type ThinkingLevel = "inherit" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type Config = {
  model: string;
  thinkingLevel: ThinkingLevel;
  timeZone: string;
  checkEveryTurns: number;
  nameFormat: string;
  types: string[];
  nameLanguage: string;
};
export type NameHistory = { name: string; source: "auto" | "manual"; reason: string; updatedAt: string };
export type NameSegments = { type: string; topic: string; progress?: string };
// 失败原因分开表达，避免把“provider 报错”“模型没吐字”“模型主动放弃”混成同一句提示。
export type ModelFailure = "SKIP" | "EMPTY" | "NO_CONTEXT" | "ERROR";
export type ModelResult = ModelFailure | NameSegments;
export type State = { version: 1; autoName?: string; segments?: NameSegments; manualLock: boolean; date: string; timeZone: string; turnsSinceCheck: number; history: NameHistory[] };
let configWarning: string | undefined;

type Entry = { type?: string; customType?: string; data?: unknown; timestamp?: string; summary?: string; message?: { role?: string; content?: unknown } };
const configPath = () => join(homedir(), ".pi", "agent", "session-namer.json");

export function loadConfig(path = configPath()): Config {
  let raw: Partial<Config> = {};
  try {
    if (!existsSync(path)) {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, { flag: "wx" });
    }
    raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Config>;
  } catch (error) {
    configWarning = `Failed to read configuration; using defaults: ${path}`;
    raw = {};
  }
  const level = ["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(raw.thinkingLevel))
    ? String(raw.thinkingLevel) as ThinkingLevel : DEFAULT_CONFIG.thinkingLevel;
  const turns = typeof raw.checkEveryTurns === "number" && Number.isInteger(raw.checkEveryTurns) && raw.checkEveryTurns >= 0
    ? raw.checkEveryTurns : DEFAULT_CONFIG.checkEveryTurns;
  const nameFormat = typeof raw.nameFormat === "string" && raw.nameFormat.includes("{type}") && raw.nameFormat.includes("{topic}")
    ? raw.nameFormat : DEFAULT_CONFIG.nameFormat;
  const types = Array.isArray(raw.types) && raw.types.length > 0 && raw.types.every((t) => typeof t === "string" && t.trim())
    ? raw.types.map((t) => t.trim()) : [...DEFAULT_CONFIG.types];
  const nameLanguage = typeof raw.nameLanguage === "string" && raw.nameLanguage ? raw.nameLanguage : DEFAULT_CONFIG.nameLanguage;
  return { model: typeof raw.model === "string" && raw.model ? raw.model : DEFAULT_CONFIG.model, thinkingLevel: level, timeZone: typeof raw.timeZone === "string" && raw.timeZone ? raw.timeZone : DEFAULT_CONFIG.timeZone, checkEveryTurns: turns, nameFormat, types, nameLanguage };
}

export function resolveTimeZone(value: string): string {
  if (value === "auto") return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }).format(); return value; } catch { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; }
}

export function formatDate(iso: string, configuredZone: string): string {
  const date = new Date(iso);
  const zone = resolveTimeZone(configuredZone);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, month: "2-digit", day: "2-digit" }).formatToParts(date);
  return `${parts.find((p) => p.type === "month")?.value ?? ""}${parts.find((p) => p.type === "day")?.value ?? ""}`;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((x): x is { type?: string; text?: string } => Boolean(x) && typeof x === "object")
    .filter((x) => x.type === "text" && typeof x.text === "string").map((x) => x.text!).join("\n");
}

export function buildConversationText(entries: Entry[], maxMessages = 12, maxChars = 5000): string {
  // First pass: collect the newest window of message/summary lines.
  const picked: { line: string; size: number }[] = [];
  for (let i = entries.length - 1; i >= 0 && picked.length < maxMessages; i--) {
    const entry = entries[i];
    if (entry.type === "compaction" && entry.summary) {
      const line = `Summary: ${entry.summary.slice(0, 700)}`;
      picked.push({ line, size: line.length });
      continue;
    }
    if (entry.type !== "message") continue;
    const role = entry.message?.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = textOf(entry.message?.content).trim();
    if (!text) continue;
    const toolNames = Array.isArray(entry.message?.content)
      ? entry.message.content.filter((part): part is { type?: string; name?: string } => Boolean(part) && typeof part === "object" && (part as { type?: string }).type === "toolCall").map((part) => part.name).filter(Boolean)
      : [];
    // Keep the full text here; the second pass allocates budgets so the
    // latest evidence (e.g. a completion report) dominates the window.
    const toolSuffix = toolNames.length ? `\nTools: ${toolNames.join(", ")}` : "";
    const line = `${role === "user" ? "User" : "Assistant"}: ${text}${toolSuffix}`;
    picked.push({ line, size: line.length });
  }
  picked.reverse();
  // Newest-first budget allocation: the newest message gets up to 2000 chars
  // (using only what it actually needs), earlier ones up to 700 each, and when
  // the budget runs out the OLDEST messages are dropped so the latest
  // evidence (e.g. a completion report) always survives intact. Separators
  // ("\n\n") are counted against the budget so the final slice never trims
  // the newest message's tail.
  const SEP = 2;
  const total = picked.length;
  const newest = picked[total - 1]?.line.slice(0, 2000) ?? "";
  let budget = maxChars - newest.length;
  const trimmed: string[] = budget > 0 ? [newest] : [newest.slice(0, maxChars)];
  for (let i = total - 2; i >= 0; i--) {
    if (budget <= SEP) break;
    const limit = Math.min(700, budget - SEP);
    const kept = picked[i].line.slice(0, limit);
    trimmed.unshift(kept);
    budget -= kept.length + SEP;
  }
  return trimmed.join("\n\n");
}

export function parseModelSegments(raw: string, wantsProgress: boolean): ModelResult | null {
  let value = raw.trim().replace(/^```\w*\s*/i, "").replace(/```\s*$/i, "").trim();
  value = value.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
  if (!value) return "EMPTY";
  if (/^SKIP$/i.test(value)) return "SKIP";
  const two = value.match(/^([^｜|]{1,24})[｜|](.+)$/);
  if (!two || !two[1].trim()) return null;
  const type = two[1].trim();
  const rest = two[2].trim();
  let topic = rest;
  let progress: string | undefined;
  if (wantsProgress) {
    const progressSplit = rest.match(/^(.+?)[｜|]([^｜|]+)$/);
    if (progressSplit) {
      topic = progressSplit[1].trim().slice(0, 60);
      progress = progressSplit[2].trim().slice(0, 16);
    } else {
      topic = rest.slice(0, 60);
    }
  } else {
    const topicOnly = rest.split(/[｜|]/)[0].trim();
    topic = topicOnly.slice(0, 60);
  }
  if (!topic) return null;
  return { type, topic, progress };
}

export type RefreshArgs = { force: boolean; hint?: string };
export const MAX_HINT_LENGTH = 200;

// 附加要求折成单行并限长，避免换行和粘贴的长文本撑爆提示词结构。
function normalizeHint(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_HINT_LENGTH);
}

// 命令参数：空 → 普通刷新；`force` 前缀或任意文本 → 强制重评，剩余文本作为附加要求。
export function parseRefreshArgs(args: string): RefreshArgs {
  const trimmed = args.trim();
  if (!trimmed) return { force: false };
  const forced = trimmed.match(/^force(?![a-z0-9])[:\s]*([\s\S]*)$/i);
  const hint = normalizeHint(forced ? forced[1] : trimmed);
  return hint ? { force: true, hint } : { force: true };
}

export function renderName(nameFormat: string, parts: { date: string; type: string; topic: string; progress?: string }): string {
  return cleanupName(nameFormat
    .replace(/\{date\}/g, parts.date)
    .replace(/\{type\}/g, parts.type)
    .replace(/\{topic\}/g, parts.topic)
    .replace(/\{progress\}/g, parts.progress ?? ""));
}

function cleanupName(name: string): string {
  return name
    .replace(/(^\s+)|(\s*[｜|]\s*)+$/g, "")
    .replace(/\s*[｜|]\s*([｜|]\s*)+/g, "｜")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function parseModelResult(raw: string, date: string, nameFormat: string = DEFAULT_CONFIG.nameFormat): string | null {
  const segments = parseModelSegments(raw, nameFormat.includes("{progress}"));
  if (segments === null || typeof segments === "string") return segments;
  return renderName(nameFormat, { date, ...segments }) || null;
}

function latestState(ctx: ExtensionContext): State | undefined {
  const entries = ctx.sessionManager.getEntries() as Entry[];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "custom" && entry.customType === ENTRY_TYPE && entry.data && typeof entry.data === "object") return entry.data as State;
  }
  return undefined;
}

function appendState(pi: ExtensionAPI, state: State) { pi.appendEntry(ENTRY_TYPE, state); }

function defaultState(ctx: ExtensionContext, config: Config): State {
  const header = ctx.sessionManager.getHeader();
  const zone = resolveTimeZone(config.timeZone);
  const timestamp = header?.timestamp ?? new Date().toISOString();
  return { version: 1, manualLock: false, date: formatDate(timestamp, zone), timeZone: zone, turnsSinceCheck: 0, history: [] };
}

function modelFor(ctx: ExtensionContext, config: Config): { model: typeof ctx.model; fellBack: boolean } {
  if (config.model !== "inherit") {
    const slash = config.model.indexOf("/");
    if (slash > 0) {
      const configured = ctx.modelRegistry.find(config.model.slice(0, slash), config.model.slice(slash + 1));
      if (configured && ctx.modelRegistry.hasConfiguredAuth(configured)) return { model: configured, fellBack: false };
    }
    return { model: ctx.model && ctx.modelRegistry.hasConfiguredAuth(ctx.model) ? ctx.model : undefined, fellBack: true };
  }
  return { model: ctx.model && ctx.modelRegistry.hasConfiguredAuth(ctx.model) ? ctx.model : undefined, fellBack: false };
}

// 强制重评时不回灌旧的 type/topic，否则模型会顺着旧值照抄，等于白 force。
export function buildContextLine(force: boolean, segments: NameSegments | undefined, currentName: string): string {
  if (force) return `Current name: ${currentName}. The user requested a forced re-evaluation: re-assess the type and topic from the conversation instead of copying the current name.`;
  if (segments) return `Current type and topic (reuse them EXACTLY as written if they still describe the main task): ${segments.type}｜${segments.topic}`;
  return `Current name: ${currentName}`;
}

export function buildReuseRule(force: boolean, wantsProgress: boolean): string {
  if (force) return "- Re-assess the type and topic from scratch. Keep the previous wording only when it is still the most accurate description of the current main task.";
  return wantsProgress
    ? "- If the current name's type and topic still describe the main task, reuse them EXACTLY as written; only the progress may change."
    : "- If the current name's type and topic still describe the main task, output them EXACTLY as written.";
}

export function buildHintRule(hint?: string): string {
  return hint ? `\n- Additional user requirement (highest priority, as long as the output format is respected): ${hint}` : "";
}

// 手动刷新是用户明确下令，模型不该再回 SKIP；证据不足也要给最可能的主线任务。
export function buildOutputRule(manual: boolean, wantsProgress: boolean): string {
  const shape = wantsProgress ? '"Type｜Topic｜Progress"' : '"Type｜Topic"';
  return manual
    ? `- Output ${shape}. The user explicitly requested a refresh: always name the most likely main task, even if the evidence is thin. Never output SKIP.`
    : `- Output ${shape}; output SKIP only if there is no clear task.`;
}

export const MAX_ERROR_LENGTH = 300;

// provider 报错时 complete() 不抛异常，而是返回 stopReason=error 的空消息（例如 401、429、
// content_filter）。先把它识别出来，否则会被当成“模型没返回文本”。
export function responseError(response: { stopReason?: string; errorMessage?: string }): string | undefined {
  if (response.stopReason !== "error" && response.stopReason !== "aborted") return undefined;
  const detail = (response.errorMessage ?? "").replace(/\s+/g, " ").trim();
  return (detail || `the provider stopped with "${response.stopReason}"`).slice(0, MAX_ERROR_LENGTH);
}

// 手动刷新落空时按原因给不同提示，避免所有失败都显示“上下文不足”。
export function missMessage(result: ModelResult | null, errorMessage?: string): string {
  if (result === "NO_CONTEXT") return "There is no conversation content to analyze yet.";
  if (result === "ERROR") return `The naming request failed: ${errorMessage || "the provider returned an error without details"}.`;
  if (result === "EMPTY") return "The naming model returned no text. Try again, or add an instruction: /session-name-refresh <requirement>.";
  if (result === "SKIP") return "The naming model did not pick a main task. Add an instruction: /session-name-refresh <requirement>.";
  return "No valid session name was generated.";
}

type RunOptions = { force?: boolean; hint?: string; manual?: boolean };

function promptFor(state: State, contextLine: string, conversation: string, config: Config, options: RunOptions = {}): string {
  const wantsProgress = config.nameFormat.includes("{progress}");
  const languageRule = config.nameLanguage === "auto"
    ? "Use the primary language of the conversation for the type, topic, and progress."
    : `Write the type, topic, and progress in this language: ${config.nameLanguage}.`;
  const outputRule = buildOutputRule(Boolean(options.manual), wantsProgress);
  const reuseRule = buildReuseRule(Boolean(options.force), wantsProgress);
  const progressRules = wantsProgress
    ? `\n- Progress states the latest status of the main task (e.g. "published 0.1.1", "fix verified", "待审查"), at most 16 characters. Anchor it to the latest evidence near the END of the conversation; never report an earlier phase when a later milestone has already been reached.`
    : "";
  return `You are Pi's session naming assistant. Describe what this session is working on and its latest state.\n\nOutput rules:\n${outputRule}\n${reuseRule}\n- Type must be one of: ${config.types.join(", ")}, or an equivalent label in the naming language.\n- Topic is concise and specific, suitable for a sidebar.\n${languageRule}\n- No project name, file paths, dates, explanations, quotes, or Markdown.${progressRules}\n- The program will apply the date and the name format: ${config.nameFormat}.${buildHintRule(options.hint)}\n\n${contextLine}\n\n<conversation>\n${conversation}\n</conversation>`;
}

function thinkingOptions(model: { api: string; reasoning: boolean; thinkingLevelMap?: Partial<Record<string, string | null>> }, level: ThinkingLevel): Record<string, unknown> {
  if (!model.reasoning || level === "inherit" || level === "off") return {};
  const levels: ThinkingLevel[] = ["max", "xhigh", "high", "medium", "low", "minimal"];
  const start = Math.max(0, levels.indexOf(level));
  let mapped: string | undefined;
  for (let index = start; index < levels.length; index++) {
    const candidate = levels[index];
    const value = model.thinkingLevelMap?.[candidate];
    if (value !== null) { mapped = value ?? candidate; break; }
  }
  if (!mapped) return {};
  if (model.api === "anthropic-messages") return { thinkingEnabled: true, effort: mapped };
  if (["openai-completions", "openai-responses", "azure-openai-responses", "openai-codex-responses"].includes(model.api)) return { reasoningEffort: mapped };
  return {};
}

export type GenerateOutcome = { result: ModelResult | null; errorMessage?: string };

async function generate(pi: ExtensionAPI, ctx: ExtensionContext, config: Config, state: State, options: RunOptions = {}): Promise<GenerateOutcome> {
  const selection = modelFor(ctx, config);
  const model = selection.model;
  if (!model) return { result: null };
  const conversation = buildConversationText(ctx.sessionManager.getBranch() as Entry[]);
  if (!conversation) return { result: "NO_CONTEXT" };
  const configuredLevel = config.thinkingLevel === "inherit" ? (ctx.thinkingLevel ?? "off") : config.thinkingLevel;
  const requestOptions = { sessionId: uuidv7(), cacheRetention: "none" as const, ...thinkingOptions(model, configuredLevel) };
  const contextLine = buildContextLine(Boolean(options.force), state.segments, pi.getSessionName() ?? state.autoName ?? "(unnamed)");
  const response = await ctx.modelRegistry.complete(model, { messages: [{ role: "user", content: [{ type: "text", text: promptFor(state, contextLine, conversation, config, options) }], timestamp: Date.now() }] }, requestOptions as never);
  const failure = responseError(response);
  if (failure) return { result: "ERROR", errorMessage: failure };
  const text = response.content.filter((part): part is { type: "text"; text: string } => part.type === "text").map((part) => part.text).join("\n");
  return { result: parseModelSegments(text, config.nameFormat.includes("{progress}")) };
}

export default function sessionNamer(pi: ExtensionAPI) {
  const config = loadConfig();
  let state: State | undefined;
  let running = false;
  let compactPending = false;
  let internalNameChange = false;
  let attempts = 0;
  let turns = 0;

  const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") => { if (ctx.hasUI) ctx.ui.notify(message, level); };
  const ensureState = (ctx: ExtensionContext) => { state ??= latestState(ctx) ?? defaultState(ctx, config); return state; };
  const persist = (next: State) => { state = next; appendState(pi, next); };

  const run = async (ctx: ExtensionContext, reason: string, manual = false, options: RunOptions = {}) => {
    const current = ensureState(ctx);
    if (!manual && !ctx.sessionManager.getSessionFile()) return;
    if (config.model !== "inherit") {
      const selection = modelFor(ctx, config);
      if (selection.fellBack && selection.model) notify(ctx, `Configured naming model is unavailable; falling back to the primary agent: ${ctx.model?.provider ?? "unknown"}/${ctx.model?.id ?? "unknown"}`, "warning");
    }
    if (running || current.manualLock || (!manual && attempts >= 3)) {
      if (manual && current.manualLock) notify(ctx, "The session name is locked. Run /session-name-unlock first.", "warning");
      return;
    }
    running = true;
    if (!manual) attempts++;
    try {
      const outcome = await generate(pi, ctx, config, current, { ...options, manual });
      const result = outcome.result;
      const next = { ...current, turnsSinceCheck: 0, history: [...current.history] };
      if (result && typeof result !== "string") {
        const prev = current.segments;
        const taskChanged = !prev || prev.type !== result.type || prev.topic !== result.topic;
        const progressChanged = prev?.progress !== result.progress;
        const rendered = renderName(config.nameFormat, { date: current.date, ...result });
        if (!rendered) { persist(next); if (manual) notify(ctx, "No valid session name was generated.", "warning"); return; }
        attempts = 0;
        turns = 0;
        if (rendered === pi.getSessionName()) {
          next.segments = result;
          persist(next);
          if (manual) notify(ctx, "The current session name is still accurate; no changes made.");
          return;
        }
        internalNameChange = true;
        pi.setSessionName(rendered);
        next.autoName = rendered;
        next.segments = result;
        next.history.push({ name: rendered, source: "auto", reason, updatedAt: new Date().toISOString() });
        next.history = next.history.slice(-5);
        persist(next);
        if (manual || !current.autoName) notify(ctx, `Session name updated: ${rendered}`);
        else if (!taskChanged && progressChanged) { /* silent progress update */ }
      } else {
        if (result === "SKIP") attempts = 0;
        turns = 0;
        persist(next);
        if (manual) notify(ctx, missMessage(result, outcome.errorMessage), "warning");
      }
    } catch (error) { if (manual) notify(ctx, `Session naming failed: ${error instanceof Error ? error.message : String(error)}`, "error"); }
    finally { running = false; }
  };

  pi.on("session_start", (_event, ctx) => {
    state = latestState(ctx);
    turns = state?.turnsSinceCheck ?? 0;
    if (configWarning) {
      notify(ctx, configWarning, "warning");
      configWarning = undefined;
    }
    const currentName = pi.getSessionName();
    if (state && currentName && state.autoName && currentName !== state.autoName && !state.manualLock) {
      const history: NameHistory[] = [...state.history, { name: currentName, source: "manual", reason: "manual", updatedAt: new Date().toISOString() }];
      persist({ ...state, manualLock: true, history: history.slice(-5) });
    }
  });
  pi.on("session_compact", () => { compactPending = true; });
  pi.on("session_info_changed", (event, ctx) => {
    if (internalNameChange) { internalNameChange = false; return; }
    const current = ensureState(ctx);
    if (event.name && event.name !== current.autoName) {
      const history: NameHistory[] = [...current.history, { name: event.name, source: "manual", reason: "manual", updatedAt: new Date().toISOString() }];
      persist({ ...current, manualLock: true, history: history.slice(-5) });
    }
  });
  pi.on("agent_settled", async (_event, ctx) => {
    const current = ensureState(ctx);
    if (current.manualLock) return;
    turns++;
    const isCompact = compactPending;
    if (isCompact || !current.autoName || (config.checkEveryTurns > 0 && turns >= config.checkEveryTurns)) {
      compactPending = false;
      await run(ctx, isCompact ? "compact" : current.autoName ? "periodic" : "initial");
    } else persist({ ...current, turnsSinceCheck: turns });
  });

  pi.registerCommand("session-name-refresh", {
    description: "Refresh the session name (usage: /session-name-refresh [force] [instruction])",
    getArgumentCompletions: (prefix) => {
      const value = prefix.trimStart().toLowerCase();
      if (value !== "" && !"force ".startsWith(value)) return null;
      return [{ value: "force ", label: "force", description: "Re-evaluate type and topic instead of reusing them" }];
    },
    handler: async (args, ctx) => {
      const { force, hint } = parseRefreshArgs(args);
      notify(ctx, force ? "Forcing a re-evaluation of the session name…" : "Analyzing the current session to refresh its name…", "info");
      await run(ctx, "refresh", true, { force, hint });
    }
  });
  pi.registerCommand("session-name-lock", { description: "Lock the current session name", handler: async (_args, ctx) => {
    const current = ensureState(ctx);
    if (!pi.getSessionName()) return notify(ctx, "There is no session name to lock.", "warning");
    persist({ ...current, manualLock: true });
    notify(ctx, "Session name locked.", "info");
  } });
  pi.registerCommand("session-name-unlock", { description: "Unlock automatic session naming", handler: async (_args, ctx) => {
    const current = ensureState(ctx);
    if (!current.manualLock) return notify(ctx, "The session name is not locked.", "info");
    persist({ ...current, manualLock: false });
    notify(ctx, "Session name unlocked. Run /session-name-refresh when you want to update it.", "info");
  } });
  pi.registerCommand("session-name-status", { description: "Show the session naming status", handler: async (_args, ctx) => { const current = ensureState(ctx); const next = config.checkEveryTurns === 0 ? "disabled" : `in ${Math.max(0, config.checkEveryTurns - turns)} settled run(s)`; notify(ctx, `Current name: ${pi.getSessionName() ?? "(unnamed)"}\nStatus: ${current.manualLock ? "locked" : "automatic"}\nNext check: ${next}`, "info"); } });
}
