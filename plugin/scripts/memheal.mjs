#!/usr/bin/env node
// memheal entry point.
//
//   node memheal.mjs hook                      called by Claude Code hooks; reads the event on stdin
//   node memheal.mjs status [--data D] [--project P]   print what is stored for this project
//   node memheal.mjs forget [--data D] [--project P]   delete what is stored for this project
//
// It reads and writes only files under its own data directory. It makes no
// network or model calls and starts no other program.

import { ago, dropExpired, label, LIMITS, normalizeState, ranked, recap, record, score } from "./lib/focus.mjs";
import { normalizeLoopState, onEdit, onFailure } from "./lib/loops.mjs";
import { dataDir, focusFile, projectDir, readJson, removeFile, sessionFile, sweepSessions, writeJson } from "./lib/store.mjs";

const SESSION_FILE_MAX_AGE_MS = 48 * 3_600_000;

/** @returns {Promise<string>} */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * @param {string} event
 * @param {string} text
 */
function addContext(event, text) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }));
}

/**
 * Handles one hook event. Returns nothing; anything for the model is printed.
 * @param {Record<string, any>} input  the JSON Claude Code sends on stdin
 * @param {number} now
 */
function handleHook(input, now) {
  const data = dataDir();
  const project = projectDir(undefined, typeof input.cwd === "string" ? input.cwd : undefined);
  const session = typeof input.session_id === "string" ? input.session_id : "unknown";

  switch (input.hook_event_name) {
    case "UserPromptSubmit": {
      // Prompts inside a subagent are the main agent's words, not the user's.
      if (input.agent_id || typeof input.prompt !== "string") return;
      const file = focusFile(data, project);
      const state = normalizeState(readJson(file));
      if (record(state, input.prompt, { now, projectDir: project }).action !== "skip") writeJson(file, state);
      return;
    }
    case "SessionStart": {
      if (input.source !== "startup" && input.source !== "compact") return;
      if (input.source === "startup") sweepSessions(data, SESSION_FILE_MAX_AGE_MS, now);
      const file = focusFile(data, project);
      const state = normalizeState(readJson(file));
      if (dropExpired(state, now)) writeJson(file, state);
      const text = recap(state, now);
      if (text) addContext("SessionStart", text);
      return;
    }
    case "PostToolUseFailure": {
      const file = sessionFile(data, session);
      const state = normalizeLoopState(readJson(file));
      const before = JSON.stringify(state);
      const notice = onFailure(state, input, now);
      if (JSON.stringify(state) !== before) writeJson(file, state);
      if (notice) addContext("PostToolUseFailure", notice);
      return;
    }
    case "PostToolUse": {
      // Registered for file-editing tools only. An edit ends any streak.
      const file = sessionFile(data, session);
      const state = normalizeLoopState(readJson(file));
      if (onEdit(state)) writeJson(file, state);
      return;
    }
    default:
      return;
  }
}

/**
 * @param {string[]} args
 * @param {string} name
 */
function option(args, name) {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

/**
 * @param {string[]} args
 * @param {number} now
 */
function status(args, now) {
  const data = dataDir(option(args, "--data"));
  const project = projectDir(option(args, "--project"));
  const file = focusFile(data, project);
  const state = normalizeState(readJson(file));
  dropExpired(state, now);
  const out = [`memheal status for ${project}`, `stored in ${file}`, ""];
  if (state.topics.length === 0) {
    out.push("Nothing is stored for this project.");
  } else {
    out.push(`${state.topics.length} of at most ${LIMITS.maxTopics} topics, from ${state.prompts} prompts. A topic is deleted ${LIMITS.retentionDays} days after its last prompt.`, "");
    for (const topic of ranked(state, now)) {
      out.push(`${label(state, topic)}  [score ${score(topic, now).toFixed(2)}, ${topic.count} prompts, last ${ago(now - topic.last)}]`);
      for (const s of topic.snippets) out.push(`    "${s}"`);
      if (topic.refs.length) out.push(`    files: ${topic.refs.join(", ")}`);
    }
    out.push("", "What the next session will be shown:", "", recap(state, now));
  }
  out.push("", "The loop breaker keeps only a counter per failing call for the current session; those files are deleted after two days.");
  console.log(out.join("\n"));
}

/** @param {string[]} args */
function forget(args) {
  const data = dataDir(option(args, "--data"));
  const project = projectDir(option(args, "--project"));
  const file = focusFile(data, project);
  console.log(removeFile(file) ? `Deleted ${file}` : `Nothing was stored for ${project}`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "hook") {
    // A hook must never fail or block: whatever goes wrong, exit 0 silently.
    try {
      handleHook(JSON.parse(await readStdin()), Date.now());
    } catch {
      // unreadable input or an unwritable disk: do nothing
    }
    return;
  }
  if (command === "status") return status(args, Date.now());
  if (command === "forget") return forget(args);
  console.log("usage: node memheal.mjs hook | status | forget   (see README.md)");
  process.exitCode = command ? 2 : 0;
}

await main();
