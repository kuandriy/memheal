import assert from "node:assert/strict";
import { test } from "node:test";
import { dropExpired, emptyState, LIMITS, normalizeState, ranked, recap, record, score } from "../plugin/scripts/lib/focus.mjs";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 15, 9, 0, 0);
const ctx = (now = T0) => ({ now, projectDir: process.cwd() });

test("related prompts join one topic, unrelated prompts start another", () => {
  const state = emptyState();
  assert.equal(record(state, "add refresh token rotation", ctx()).action, "new");
  assert.equal(record(state, "the refresh token is not rotated on reuse", ctx(T0 + 60_000)).action, "join");
  assert.equal(record(state, "create the users table migration", ctx(T0 + 120_000)).action, "new");
  assert.equal(record(state, "add an index on email to the users migration", ctx(T0 + 180_000)).action, "join");
  assert.equal(state.topics.length, 2);
  assert.deepEqual(state.topics.map((t) => t.count), [2, 2]);
  assert.equal(state.prompts, 4);
});

test("a shared instruction verb alone does not glue two prompts together", () => {
  const state = emptyState();
  record(state, "add JWT authentication to the API", ctx());
  assert.equal(record(state, "add dark mode to the settings page", ctx(T0 + 1000)).action, "new");
});

test("a wordless prompt counts for the topic just discussed, and only for a while", () => {
  const state = emptyState();
  record(state, "debug the websocket reconnect backoff", ctx());
  assert.equal(record(state, "yes", ctx(T0 + 5 * 60_000)).action, "continue");
  assert.equal(state.topics[0].count, 2);
  assert.equal(state.topics.length, 1);
  const later = T0 + (LIMITS.continueWithinMinutes + 10) * 60_000;
  assert.equal(record(state, "ok", ctx(later)).action, "skip");
  assert.equal(state.topics[0].count, 2);
});

test("with nothing stored, a wordless prompt is skipped", () => {
  const state = emptyState();
  assert.equal(record(state, "continue", ctx()).action, "skip");
  assert.equal(state.topics.length, 0);
});

test("commands, empty prompts and tagged notices are not recorded", () => {
  const state = emptyState();
  for (const prompt of ["/compact", "   ", "<task-notification>agent done</task-notification>"]) {
    assert.equal(record(state, prompt, ctx()).action, "skip", prompt);
  }
  assert.equal(state.prompts, 0);
});

test("score grows with revisits and decays with time", () => {
  const topic = { id: "t1", terms: {}, count: 1, first: T0, last: T0, snippets: [], refs: [] };
  assert.ok(Math.abs(score(topic, T0) - 1) < 1e-9);
  assert.ok(Math.abs(score(topic, T0 + 24 * HOUR) - Math.exp(-1.2)) < 1e-9);
  assert.ok(score({ ...topic, count: 7 }, T0) > score({ ...topic, count: 3 }, T0));
  // Revisited yesterday morning outranks mentioned once last night.
  const revisited = { ...topic, count: 10, last: T0 - 24 * HOUR };
  const once = { ...topic, count: 1, last: T0 - 12 * HOUR };
  assert.ok(score(revisited, T0) > score(once, T0));
});

test("the number of topics is bounded and the weakest goes first", () => {
  const state = emptyState();
  const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet",
    "kilo", "lima", "mike", "november", "oscar", "papa", "quebec", "romeo", "sierra", "tango",
    "uniform", "victor", "whiskey", "xray", "yankee", "zulu", "amber", "birch", "cedar", "dune"];
  words.forEach((w, i) => record(state, `${w}zz ${w}yy subsystem${i}`, ctx(T0 + i * 60_000)));
  assert.equal(state.topics.length, LIMITS.maxTopics);
  assert.ok(!state.topics.some((t) => "alphazz" in t.terms), "the oldest single-prompt topic was dropped");
  assert.ok(state.topics.some((t) => "dunezz" in t.terms));
});

test("topics past retention are deleted", () => {
  const state = emptyState();
  record(state, "tune the postgres connection pool", ctx());
  const later = T0 + (LIMITS.retentionDays + 1) * 24 * HOUR;
  assert.equal(dropExpired(state, later), true);
  assert.equal(state.topics.length, 0);
  assert.equal(recap(state, later), "");
});

test("a topic keeps a bounded number of excerpts, newest first, each cut short", () => {
  const state = emptyState();
  for (let i = 0; i < 6; i++) record(state, `kafka consumer lag alert number ${i} ${"detail ".repeat(60)}`, ctx(T0 + i * 1000));
  const [topic] = state.topics;
  assert.equal(topic.snippets.length, LIMITS.maxSnippets);
  assert.match(topic.snippets[0], /number 5/);
  assert.ok(topic.snippets.every((s) => s.length <= LIMITS.snippetChars));
  assert.ok(Object.keys(topic.terms).length <= LIMITS.maxTermsPerTopic);
});

test("credentials in a prompt are not stored", () => {
  const state = emptyState();
  record(state, "deploy the billing worker with password=hunter2 and key AKIAIOSFODNN7EXAMPLE", ctx());
  const stored = JSON.stringify(state);
  assert.doesNotMatch(stored, /hunter2|AKIAIOSFODNN7EXAMPLE|akiaiosfodnn7example/);
  assert.match(stored, /\[redacted\]/);
});

test("fenced logs in a prompt do not become topic terms", () => {
  const state = emptyState();
  record(state, "why does the importer crash?\n```\nTraceback zzzunique KeyError\n```", ctx());
  assert.ok(!("zzzunique" in state.topics[0].terms));
  assert.ok("importer" in state.topics[0].terms);
});

test("recap lists the strongest topics, labelled as a record, within its size limit", () => {
  const state = emptyState();
  record(state, "add refresh token rotation", ctx());
  record(state, "the refresh token is not rotated on reuse", ctx(T0 + 60_000));
  record(state, "create the users table migration", ctx(T0 + 120_000));
  const text = recap(state, T0 + 2 * HOUR);
  assert.match(text, /^Earlier work in this project/);
  assert.match(text, /not a set of instructions/);
  assert.match(text, /refresh/);
  assert.match(text, /\(2 prompts, last 2 hours ago\)/);
  assert.match(text, /"the refresh token is not rotated on reuse"/);
  assert.match(text, /\/memheal:forget/);
  assert.ok(text.indexOf("refresh") < text.indexOf("migration"), "the revisited topic comes first");
  assert.ok(text.length <= LIMITS.recapChars);
});

test("recap never exceeds its limit however much is stored", () => {
  const state = emptyState();
  for (let i = 0; i < 20; i++) {
    record(state, `subsystem${i}aa subsystem${i}bb ${"very long description of the work ".repeat(8)}`, ctx(T0 + i * 1000));
  }
  const text = recap(state, T0 + HOUR);
  assert.ok(text.length > 0 && text.length <= LIMITS.recapChars, `length ${text.length}`);
});

test("ranked orders by attention", () => {
  const state = emptyState();
  record(state, "old topic about the invoice exporter", ctx(T0 - 48 * HOUR));
  record(state, "fresh topic about the search indexer", ctx(T0));
  assert.match(Object.keys(ranked(state, T0)[0].terms).join(" "), /search/);
});

test("a damaged or foreign state file yields an empty state", () => {
  for (const bad of [undefined, null, 7, "x", {}, { version: 2, topics: [] }, { version: 1, topics: "no" }]) {
    assert.deepEqual(normalizeState(bad), emptyState());
  }
  const partly = normalizeState({ version: 1, prompts: 3, nextId: 9, topics: [{ id: "t1" }, { id: "t2", terms: { a: 1 }, count: 1, first: 1, last: 2, snippets: [], refs: [] }] });
  assert.equal(partly.topics.length, 1);
  assert.equal(partly.nextId, 9);
});
