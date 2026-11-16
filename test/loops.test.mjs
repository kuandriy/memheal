import assert from "node:assert/strict";
import { test } from "node:test";
import { callKey, emptyLoopState, errorSignature, keyErrorLines, LOOP, normalizeCommand, normalizeLoopState, onEdit, onFailure } from "../plugin/scripts/lib/loops.mjs";

const fail = (overrides = {}) => ({
  tool_name: "Bash",
  tool_input: { command: "npm test" },
  error: "Exit code 1\nError: Cannot find module 'express'",
  ...overrides,
});

test("normalizeCommand keeps what was attempted and drops the noise", () => {
  assert.equal(normalizeCommand("cd x && npm test 2>&1 | tail -5"), "npm test");
  assert.equal(normalizeCommand("cd /repo; FOO=1 go test ./... > out.txt"), "FOO=1 go test ./...");
  assert.equal(normalizeCommand("Set-Location C:\\wa; npm   run build"), "npm run build");
  assert.equal(normalizeCommand("make build || echo failed"), "make build || echo failed");
});

test("normalizeCommand agrees with repeat-miner's own test cases", () => {
  // From repeat-miner/main_test.go, TestNormCmdAndHead.
  assert.equal(normalizeCommand("cd /repo && npm test 2>&1 | tail -5"), "npm test");
  assert.equal(normalizeCommand("FOO=1 go build ./... 2>/dev/null"), "FOO=1 go build ./...");
  assert.equal(normalizeCommand("cd a; make x && make y"), "make x && make y");
});

test("callKey picks the identifying part of each tool's input", () => {
  assert.equal(callKey("Bash", { command: "cd a && pytest tests/ | head" }), "pytest tests/");
  assert.equal(callKey("PowerShell", { command: "cd a; pytest" }), "pytest");
  assert.equal(callKey("Read", { file_path: "/repo/config.yaml" }), "/repo/config.yaml");
  assert.equal(callKey("Grep", { pattern: "TODO", path: "src" }), "src");
});

test("keyErrorLines skips empty lines, tags and a bare exit code", () => {
  assert.deepEqual(keyErrorLines("Exit code 1\n\nError: Cannot find module 'express'"), ["Error: Cannot find module 'express'"]);
  assert.deepEqual(keyErrorLines("<tool_use_error>File does not exist.</tool_use_error>"), ["File does not exist."]);
  assert.deepEqual(keyErrorLines("Exit code 1"), []);
});

test("errorSignature is stable across paths, ids and numbers", () => {
  assert.equal(
    errorSignature("FAIL /home/a/proj/src/x.test.ts:42 after 1873ms (commit 9f8e7d6c5b)"),
    errorSignature("FAIL C:\\work\\proj\\src\\x.test.ts:7 after 22ms (commit 0a1b2c3d4e)"),
  );
  assert.notEqual(errorSignature("cannot find module express"), errorSignature("cannot find module lodash"));
});

test("the third identical failure produces a notice, then every second one after", () => {
  const state = emptyLoopState();
  const notices = [];
  for (let i = 1; i <= 7; i++) notices.push(onFailure(state, fail(), i));
  assert.deepEqual(notices.map((n) => n !== ""), [false, false, true, false, true, false, true]);
  assert.match(notices[2], /this same Bash call has now failed 3 times/);
  assert.match(notices[2], /Cannot find module 'express'/);
  assert.match(notices[2], /no Edit or Write call in between/);
  assert.match(notices[4], /failed 5 times/);
});

test("the same command with noise around it is the same call", () => {
  const state = emptyLoopState();
  onFailure(state, fail({ tool_input: { command: "npm test" } }), 1);
  onFailure(state, fail({ tool_input: { command: "cd app && npm test 2>&1" } }), 2);
  assert.notEqual(onFailure(state, fail({ tool_input: { command: "npm test | tail -20" } }), 3), "");
});

test("a different command or a different error is a different streak", () => {
  const state = emptyLoopState();
  onFailure(state, fail(), 1);
  onFailure(state, fail(), 2);
  assert.equal(onFailure(state, fail({ tool_input: { command: "npm run lint" } }), 3), "");
  assert.equal(onFailure(state, fail({ error: "Exit code 1\nTypeError: x is not a function" }), 4), "");
  assert.notEqual(onFailure(state, fail(), 5), "");
});

test("an edit between failures resets the count: rerunning after a change is normal work", () => {
  const state = emptyLoopState();
  onFailure(state, fail(), 1);
  onFailure(state, fail(), 2);
  assert.equal(onEdit(state), true);
  assert.equal(onEdit(state), false);
  assert.equal(onFailure(state, fail(), 3), "");
  assert.equal(onFailure(state, fail(), 4), "");
  assert.notEqual(onFailure(state, fail(), 5), "");
});

test("calls the user stopped or a rule refused are not counted", () => {
  const state = emptyLoopState();
  const ignored = [
    fail({ is_interrupt: true }),
    fail({ error: "The user doesn't want to proceed with this tool use." }),
    fail({ error: "Permission to use Bash with command rm -rf has been denied." }),
    fail({ error: "Cancelled: parallel tool call Bash(npm test) errored" }),
    fail({ error: "Exit code 1" }),
    fail({ tool_name: undefined }),
  ];
  for (let round = 0; round < 4; round++) {
    for (const input of ignored) assert.equal(onFailure(state, input, round), "");
  }
  assert.deepEqual(state.streaks, {});
});

test("the main agent and a subagent are counted apart", () => {
  const state = emptyLoopState();
  onFailure(state, fail(), 1);
  onFailure(state, fail(), 2);
  assert.equal(onFailure(state, fail({ agent_id: "agent-7" }), 3), "");
  assert.notEqual(onFailure(state, fail(), 4), "");
});

test("only hashes and counters are kept, never the command or the error", () => {
  const state = emptyLoopState();
  onFailure(state, fail({ tool_input: { command: "curl -H 'X-Key: topsecret' https://api.example.com" }, error: "curl: (6) Could not resolve host" }), 1);
  const stored = JSON.stringify(state);
  assert.doesNotMatch(stored, /topsecret|curl|resolve/);
  assert.match(Object.keys(state.streaks)[0], /^[0-9a-f]{16}$/);
});

test("the number of tracked calls per session is bounded", () => {
  const state = emptyLoopState();
  for (let i = 0; i < LOOP.maxEntries + 50; i++) {
    onFailure(state, fail({ tool_input: { command: `tool-${String.fromCharCode(97 + (i % 26))}${"x".repeat(i)}` } }), i);
  }
  assert.equal(Object.keys(state.streaks).length, LOOP.maxEntries);
});

test("a long error line is cut in the notice", () => {
  const state = emptyLoopState();
  const input = fail({ error: "Error: " + "y".repeat(500) });
  onFailure(state, input, 1);
  onFailure(state, input, 2);
  const notice = onFailure(state, input, 3);
  assert.ok(notice.length < 500, `length ${notice.length}`);
});

test("a damaged session file yields an empty state", () => {
  for (const bad of [undefined, null, "x", {}, { version: 3, streaks: {} }]) {
    assert.deepEqual(normalizeLoopState(bad), emptyLoopState());
  }
});

test("keyErrorLines skips banners and echoes and finds the line that says what failed", () => {
  // npm echoes the script first; quoting it told the model nothing.
  assert.deepEqual(keyErrorLines("Exit code 1\n> app@1.0.0 test\n> vitest run\nFAIL src/a.test.ts"), ["FAIL src/a.test.ts"]);
  // Python puts the exception last, after a fixed header.
  assert.deepEqual(
    keyErrorLines('Traceback (most recent call last):\n  File "x.py", line 1, in <module>\nModuleNotFoundError: No module named \'yaml\''),
    ["ModuleNotFoundError: No module named 'yaml'"],
  );
  // Nothing looks like an error: the first meaningful line stands in.
  assert.deepEqual(keyErrorLines("Exit code 2\nsomething odd happened"), ["something odd happened"]);
  assert.deepEqual(keyErrorLines("Exit code 1"), []);
});

test("the same banner with a different failure is a different streak; the notice quotes the failure", () => {
  const state = emptyLoopState();
  const run = (err) => onFailure(state, fail({ error: `Exit code 1\n> app@1.0.0 test\n${err}` }), 0);
  run("FAIL src/a.test.ts");
  run("FAIL src/b.test.ts");
  assert.equal(run("FAIL src/c.test.ts"), "");
  run("FAIL src/a.test.ts");
  const notice = run("FAIL src/a.test.ts");
  assert.match(notice, /failed 3 times/);
  assert.match(notice, /"FAIL src\/a\.test\.ts"/);
});
