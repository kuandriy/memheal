import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { cleanPrompt, extractFileRefs, isGenericVerb, redact, snippet, stem, tokenize } from "../plugin/scripts/lib/text.mjs";

test("stem joins plurals with their singular, including words ending in e", () => {
  // focus-gate's stemmer turned "files" into "fil" and "classes" into "classe".
  for (const [word, expected] of [
    ["files", "file"], ["tables", "table"], ["modules", "module"], ["caches", "cach"],
    ["classes", "class"], ["class", "class"], ["branches", "branch"], ["indexes", "index"],
    ["queries", "query"], ["tests", "test"], ["status", "status"], ["analysis", "analysis"],
  ]) {
    assert.equal(stem(word), expected, word);
  }
});

test("stem leaves everything but plurals alone, so labels stay real words", () => {
  // focus-gate's derivational pass: apply -> app, disable -> dis, comment -> com,
  // session -> ses, version -> ver, string -> str, staging -> stag.
  for (const word of ["apply", "disable", "comment", "session", "version", "variable", "function",
    "string", "staging", "testing", "tested", "speed"]) {
    assert.equal(stem(word), word, word);
  }
});

test("generic instruction verbs are recognised in their inflections", () => {
  for (const word of ["add", "adds", "added", "adding", "fixing", "updated", "creates", "removing", "running"]) {
    assert.equal(isGenericVerb(word), true, word);
  }
  for (const word of ["address", "settings", "runner", "token"]) assert.equal(isGenericVerb(word), false, word);
});

test("tokenize keeps topic words and drops filler, verbs and numbers", () => {
  assert.deepEqual(tokenize("Please add refresh token rotation to the 2 services"), ["refresh", "token", "rotation", "service"]);
  assert.deepEqual(tokenize("yes please"), []);
  assert.deepEqual(tokenize("fix it"), []);
});

test("tokenize leaves paths and links to the file references", () => {
  assert.deepEqual(tokenize("review the stemmer in plugin/scripts/lib/text.mjs and https://example.com/docs"), ["stemmer"]);
  assert.deepEqual(tokenize("open src\\auth\\login.ts for the session bug"), ["open", "session", "bug"]);
});

test("tokenize splits camelCase, snake_case and hyphens", () => {
  assert.deepEqual(tokenize("rotateRefreshToken in session-expiry and user_profile"), [
    "rotate", "refresh", "token", "session", "expiry", "user", "profile",
  ]);
});

test("cleanPrompt removes tagged blocks and fenced code", () => {
  const raw = "<ide_selection>const x = 1</ide_selection>why does login fail?\n```\nTraceback line 1\n```";
  assert.equal(cleanPrompt(raw), "why does login fail?");
  assert.equal(cleanPrompt("<task-notification>agent finished</task-notification>"), "");
});

test("redact replaces credential-looking text before anything is stored", () => {
  const cases = [
    "key AKIAIOSFODNN7EXAMPLE here",
    "use ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345",
    "password=hunter2 and api_key: s3cr3tvalue",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  ];
  for (const text of cases) {
    const out = redact(text);
    assert.match(out, /\[redacted\]/, text);
    assert.doesNotMatch(out, /AKIAIOSFODNN7EXAMPLE|ghp_abc|hunter2|s3cr3tvalue|eyJhbGci/, text);
  }
  assert.equal(redact("rotate the refresh token"), "rotate the refresh token");
});

test("a deep file path is not mistaken for a credential", () => {
  const deep = "open src/main/java/com/example/project/service/billing/InvoiceService.java please";
  assert.equal(redact(deep), deep);
  assert.match(redact("key " + "a1B2".repeat(12)), /\[redacted\]/);
});

test("a redacted value never becomes a topic term", () => {
  assert.deepEqual(tokenize(redact("deploy with token=abc123secret to staging")), ["deploy", "token", "staging"]);
});

test("snippet is one line of bounded length", () => {
  assert.equal(snippet("a\n  b\tc", 140), "a b c");
  const long = snippet("x".repeat(500), 140);
  assert.equal(long.length, 140);
  assert.ok(long.endsWith("…"));
});

test("extractFileRefs keeps only files that exist inside the project", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memheal-refs-"));
  fs.mkdirSync(path.join(dir, "src", "auth"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "auth", "login.ts"), "");
  fs.writeFileSync(path.join(dir, "src", "auth", "refresh.ts"), "");
  fs.writeFileSync(path.join(dir, "README.md"), "");
  const text =
    "look at src/auth/login.ts src/auth/refresh.ts and `README.md`, not src/gone.ts, " +
    "../outside/x.ts, https://example.com/a/b.js or github.com/user/repo/main.go";
  assert.deepEqual(extractFileRefs(text, dir, 5), ["src/auth/login.ts", "src/auth/refresh.ts", "README.md"]);
  assert.deepEqual(extractFileRefs("open src\\auth\\login.ts", dir, 5), ["src/auth/login.ts"]);
  assert.deepEqual(extractFileRefs(text, dir, 1), ["src/auth/login.ts"]);
  fs.rmSync(dir, { recursive: true, force: true });
});
