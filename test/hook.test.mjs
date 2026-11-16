// End-to-end: runs the program exactly as Claude Code does, with the event on
// stdin, and checks what it prints and what it leaves on disk.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const PROGRAM = fileURLToPath(new URL("../plugin/scripts/memheal.mjs", import.meta.url));

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memheal-e2e-"));
  const data = path.join(root, "data");
  const project = path.join(root, "project");
  fs.mkdirSync(project, { recursive: true });
  /** @param {string[]} args @param {unknown} [stdin] */
  const run = (args, stdin) =>
    spawnSync(process.execPath, [PROGRAM, ...args], {
      input: stdin === undefined ? "" : typeof stdin === "string" ? stdin : JSON.stringify(stdin),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PLUGIN_DATA: data, CLAUDE_PROJECT_DIR: project },
    });
  const files = () => {
    /** @type {string[]} */
    const out = [];
    const walk = (/** @type {string} */ dir) => {
      for (const e of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
        e.isDirectory() ? walk(path.join(dir, e.name)) : out.push(path.relative(data, path.join(dir, e.name)).split(path.sep).join("/"));
      }
    };
    walk(data);
    return out.sort();
  };
  return { root, data, project, run, files, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const prompt = (text, extra = {}) => ({ session_id: "s1", hook_event_name: "UserPromptSubmit", prompt: text, ...extra });
const failure = (extra = {}) => ({
  session_id: "s1",
  hook_event_name: "PostToolUseFailure",
  tool_name: "Bash",
  tool_input: { command: "npm test" },
  error: "Exit code 1\nError: Cannot find module 'express'",
  ...extra,
});

test("a prompt is recorded silently: nothing is added to the prompt", () => {
  const box = sandbox();
  const result = box.run(["hook"], prompt("add refresh token rotation"));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  const files = box.files();
  assert.equal(files.length, 1);
  assert.match(files[0], /^projects\/[0-9a-f]{16}\/focus\.json$/);
  const stored = JSON.parse(fs.readFileSync(path.join(box.data, files[0]), "utf8"));
  assert.equal(stored.topics.length, 1);
  assert.equal(stored.topics[0].snippets[0], "add refresh token rotation");
  box.done();
});

test("session start shows the recap on startup and after compaction, not on resume or clear", () => {
  const box = sandbox();
  box.run(["hook"], prompt("add refresh token rotation"));
  for (const source of ["startup", "compact"]) {
    const result = box.run(["hook"], { session_id: "s2", hook_event_name: "SessionStart", source });
    assert.equal(result.status, 0);
    const out = JSON.parse(result.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
    assert.match(out.hookSpecificOutput.additionalContext, /refresh/);
    assert.ok(out.hookSpecificOutput.additionalContext.length <= 900);
  }
  for (const source of ["resume", "clear", "fork"]) {
    assert.equal(box.run(["hook"], { session_id: "s2", hook_event_name: "SessionStart", source }).stdout, "", source);
  }
  box.done();
});

test("session start prints nothing when nothing is stored", () => {
  const box = sandbox();
  const result = box.run(["hook"], { session_id: "s1", hook_event_name: "SessionStart", source: "startup" });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.deepEqual(box.files(), []);
  box.done();
});

test("prompts inside a subagent, commands and notices are not recorded", () => {
  const box = sandbox();
  box.run(["hook"], prompt("investigate the flaky payment test", { agent_id: "agent-1" }));
  box.run(["hook"], prompt("/compact"));
  box.run(["hook"], prompt("<task-notification>agent finished</task-notification>"));
  assert.deepEqual(box.files(), []);
  box.done();
});

test("the third identical failure adds a notice; an edit in between resets it", () => {
  const box = sandbox();
  assert.equal(box.run(["hook"], failure()).stdout, "");
  assert.equal(box.run(["hook"], failure()).stdout, "");
  const third = box.run(["hook"], failure());
  const out = JSON.parse(third.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUseFailure");
  assert.match(out.hookSpecificOutput.additionalContext, /failed 3 times/);

  box.run(["hook"], { session_id: "s1", hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: "a.js" } });
  assert.equal(box.run(["hook"], failure()).stdout, "");
  assert.equal(box.run(["hook"], failure()).stdout, "");
  assert.notEqual(box.run(["hook"], failure()).stdout, "");

  const sessionFiles = box.files().filter((f) => f.startsWith("sessions/"));
  assert.deepEqual(sessionFiles, ["sessions/s1.json"]);
  const raw = fs.readFileSync(path.join(box.data, sessionFiles[0]), "utf8");
  assert.doesNotMatch(raw, /npm|express/, "no command or error text on disk");
  box.done();
});

test("a failure that is not counted leaves nothing on disk", () => {
  const box = sandbox();
  box.run(["hook"], failure({ is_interrupt: true }));
  box.run(["hook"], failure({ error: "The user doesn't want to proceed with this tool use." }));
  box.run(["hook"], failure({ error: "Exit code 1" }));
  assert.deepEqual(box.files(), []);
  box.done();
});

test("failures in different sessions are counted apart", () => {
  const box = sandbox();
  box.run(["hook"], failure({ session_id: "a" }));
  box.run(["hook"], failure({ session_id: "a" }));
  assert.equal(box.run(["hook"], failure({ session_id: "b" })).stdout, "");
  box.done();
});

test("a hook never fails: bad input, unknown events and odd session ids all exit 0 silently", () => {
  const box = sandbox();
  for (const input of ["", "not json", "[]", "null", { hook_event_name: "SomethingNew" }, { hook_event_name: "UserPromptSubmit" }]) {
    const result = box.run(["hook"], input);
    assert.equal(result.status, 0, JSON.stringify(input));
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  }
  const odd = box.run(["hook"], failure({ session_id: "../../etc/passwd" }));
  assert.equal(odd.status, 0);
  assert.ok(box.files().every((f) => f.startsWith("sessions/") && !f.includes("..")), box.files().join(", "));
  box.done();
});

test("a damaged state file does not block a prompt and is replaced", () => {
  const box = sandbox();
  box.run(["hook"], prompt("add refresh token rotation"));
  const file = path.join(box.data, box.files()[0]);
  fs.writeFileSync(file, "{ this is not json");
  const result = box.run(["hook"], prompt("the refresh token is not rotated"));
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).topics.length, 1);
  box.done();
});

test("status prints what is stored and forget deletes it", () => {
  const box = sandbox();
  box.run(["hook"], prompt("add refresh token rotation"));
  const args = ["--data", box.data, "--project", box.project];
  const status = box.run(["status", ...args]);
  assert.equal(status.status, 0);
  assert.match(status.stdout, /1 of at most 24 topics/);
  assert.match(status.stdout, /"add refresh token rotation"/);
  assert.match(status.stdout, /focus\.json/);

  assert.match(box.run(["forget", ...args]).stdout, /^Deleted /);
  assert.deepEqual(box.files(), []);
  assert.match(box.run(["forget", ...args]).stdout, /^Nothing was stored/);
  assert.match(box.run(["status", ...args]).stdout, /Nothing is stored for this project/);
  box.done();
});

test("an unfilled ${...} placeholder from a skill falls back to the environment", () => {
  const box = sandbox();
  box.run(["hook"], prompt("add refresh token rotation"));
  const status = box.run(["status", "--data", "${CLAUDE_PLUGIN_DATA}", "--project", "${CLAUDE_PROJECT_DIR}"]);
  assert.match(status.stdout, /1 of at most 24 topics/);
  box.done();
});

test("old session files are swept at startup, recent ones are kept", () => {
  const box = sandbox();
  box.run(["hook"], failure({ session_id: "old" }));
  box.run(["hook"], failure({ session_id: "recent" }));
  const old = path.join(box.data, "sessions", "old.json");
  const threeDaysAgo = new Date(Date.now() - 72 * 3_600_000);
  fs.utimesSync(old, threeDaysAgo, threeDaysAgo);
  box.run(["hook"], { session_id: "s9", hook_event_name: "SessionStart", source: "startup" });
  assert.deepEqual(box.files(), ["sessions/recent.json"]);
  box.done();
});
