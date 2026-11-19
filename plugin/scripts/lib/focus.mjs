// Focus: a small, bounded record of what the user has been working on in one
// project, built only from their prompts. Topics the user returns to gain
// weight; topics mentioned once fade and are dropped.
//
// Simplified from focus-gate's "sliding-window intent forest": flat topics
// instead of trees, one join threshold, no separate TF-IDF corpus file.
// See docs/DESIGN.md for what was kept, what was dropped, and why.

import { cleanPrompt, extractFileRefs, redact, snippet, tokenize } from "./text.mjs";

export const LIMITS = Object.freeze({
  maxTopics: 24, // topics kept per project
  maxTermsPerTopic: 24, // terms remembered for one topic
  vectorTerms: 8, // strongest terms used when comparing a prompt with a topic
  maxSnippets: 3, // prompt excerpts kept per topic
  snippetChars: 140, // length of one excerpt
  maxRefs: 5, // file paths kept per topic
  joinThreshold: 0.25, // cosine similarity needed to join an existing topic
  decayPerHour: 0.01, // a day untouched leaves 79% of the weight, three days about half
  retentionDays: 30, // a topic untouched this long is deleted
  continueWithinMinutes: 120, // a wordless prompt ("yes") counts for the latest topic this long
  maxPromptChars: 2000, // only the start of a long prompt is read
  maxPromptTerms: 40, // distinct terms taken from one prompt
  recapTopics: 4, // topics shown in a recap
  recapSnippets: 2, // excerpts shown per topic
  recapChars: 900, // hard size of a recap
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * @typedef {object} Topic
 * @property {string} id
 * @property {Record<string, number>} terms  accumulated term weights
 * @property {number} count                  prompts that landed here
 * @property {number} first                  epoch ms of the first prompt
 * @property {number} last                   epoch ms of the latest prompt
 * @property {string[]} snippets             newest first
 * @property {string[]} refs                 newest first
 */

/**
 * @typedef {object} FocusState
 * @property {number} version
 * @property {number} prompts  prompts recorded so far
 * @property {number} nextId
 * @property {Topic[]} topics
 */

/** @returns {FocusState} */
export function emptyState() {
  return { version: 1, prompts: 0, nextId: 1, topics: [] };
}

/**
 * Accepts whatever was read from disk and returns a usable state. Anything
 * unexpected yields an empty state: a damaged file must never break a prompt.
 * @param {unknown} value
 * @returns {FocusState}
 */
export function normalizeState(value) {
  const v = /** @type {Partial<FocusState> | null} */ (value);
  if (!v || typeof v !== "object" || v.version !== 1 || !Array.isArray(v.topics)) return emptyState();
  const topics = v.topics.filter(
    (t) =>
      t && typeof t.id === "string" && t.terms && typeof t.terms === "object" &&
      Number.isFinite(t.count) && Number.isFinite(t.first) && Number.isFinite(t.last) &&
      Array.isArray(t.snippets) && Array.isArray(t.refs),
  );
  return {
    version: 1,
    prompts: Number.isFinite(v.prompts) ? Number(v.prompts) : 0,
    nextId: Number.isFinite(v.nextId) ? Number(v.nextId) : topics.length + 1,
    topics,
  };
}

/**
 * How much a term tells topics apart: rare across topics scores high.
 * Document frequency is counted over the stored topics, so there is no
 * separate corpus to drift. A term no topic has yet counts as rare.
 * @param {FocusState} state
 * @param {string} term
 */
function idf(state, term) {
  let df = 0;
  for (const topic of state.topics) if (term in topic.terms) df++;
  return Math.log2(1 + Math.max(state.topics.length, 5) / Math.max(df, 1));
}

/**
 * @param {FocusState} state
 * @param {string[]} terms
 * @returns {Map<string, number>}
 */
function promptVector(state, terms) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
  /** @type {Map<string, number>} */
  const vector = new Map();
  for (const [term, n] of counts) vector.set(term, (n / terms.length) * idf(state, term));
  return vector;
}

/**
 * A topic's strongest terms, weighted. Using only the strongest keeps a
 * long-lived topic from becoming too broad to match.
 * @param {FocusState} state
 * @param {Topic} topic
 * @param {number} size
 * @returns {Map<string, number>}
 */
function topicVector(state, topic, size) {
  const weighted = Object.entries(topic.terms).map(
    ([term, weight]) => /** @type {[string, number]} */ ([term, weight * idf(state, term)]),
  );
  weighted.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return new Map(weighted.slice(0, size));
}

/**
 * @param {Map<string, number>} a
 * @param {Map<string, number>} b
 */
export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (const [term, w] of a) {
    na += w * w;
    const other = b.get(term);
    if (other !== undefined) dot += w * other;
  }
  for (const w of b.values()) nb += w * w;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/**
 * Attention score: grows slowly with revisits, falls with time untouched.
 * @param {Topic} topic
 * @param {number} now
 */
export function score(topic, now) {
  const hours = Math.max(0, now - topic.last) / HOUR;
  return Math.log2(topic.count + 1) * Math.exp(-LIMITS.decayPerHour * hours);
}

/**
 * Deletes topics past retention. Returns true when something was removed.
 * @param {FocusState} state
 * @param {number} now
 */
export function dropExpired(state, now) {
  const before = state.topics.length;
  state.topics = state.topics.filter((t) => now - t.last <= LIMITS.retentionDays * DAY);
  return state.topics.length !== before;
}

/** @param {FocusState} state */
function latestTopic(state) {
  return state.topics.reduce((best, t) => (!best || t.last > best.last ? t : best), /** @type {Topic | undefined} */ (undefined));
}

/**
 * @param {string[]} list
 * @param {string} item
 * @param {number} max
 */
function pushFront(list, item, max) {
  return [item, ...list.filter((x) => x !== item)].slice(0, max);
}

/**
 * Records one prompt. Mutates `state`.
 * @param {FocusState} state
 * @param {string} prompt     the raw prompt text
 * @param {{ now: number, projectDir: string }} context
 * @returns {{ action: "skip" | "continue" | "join" | "new", topic?: Topic }}
 */
export function record(state, prompt, { now, projectDir }) {
  dropExpired(state, now);
  const cleaned = cleanPrompt(prompt);
  // Commands ("/compact") are not statements of intent.
  if (!cleaned || cleaned.startsWith("/")) return { action: "skip" };

  const text = redact(cleaned).slice(0, LIMITS.maxPromptChars);
  const terms = tokenize(text);
  const distinct = [...new Set(terms)].slice(0, LIMITS.maxPromptTerms);
  const kept = terms.filter((t) => distinct.includes(t));

  // "yes", "continue", "run it": no topic of their own. They count as
  // sustained attention on whatever was just being discussed. A one-term
  // prompt may join a topic but is too thin to start one.
  const vector = promptVector(state, kept);
  /** @type {Topic | undefined} */
  let best;
  let bestScore = 0;
  for (const topic of state.topics) {
    const similarity = cosine(vector, topicVector(state, topic, LIMITS.vectorTerms));
    if (similarity > bestScore) [best, bestScore] = [topic, similarity];
  }
  // The small allowance keeps an exact 0.25 from failing on rounding.
  const joins = best !== undefined && bestScore >= LIMITS.joinThreshold - 1e-9;

  if (!joins && distinct.length < 2) {
    const latest = latestTopic(state);
    if (!latest || now - latest.last > LIMITS.continueWithinMinutes * 60_000) return { action: "skip" };
    latest.count++;
    latest.last = now;
    state.prompts++;
    return { action: "continue", topic: latest };
  }

  /** @type {Topic} */
  const topic = joins && best
    ? best
    : { id: `t${state.nextId++}`, terms: {}, count: 0, first: now, last: now, snippets: [], refs: [] };
  if (!joins) state.topics.push(topic);

  for (const term of kept) topic.terms[term] = (topic.terms[term] ?? 0) + 1 / kept.length;
  const strongest = Object.entries(topic.terms).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  topic.terms = Object.fromEntries(strongest.slice(0, LIMITS.maxTermsPerTopic));
  topic.count++;
  topic.last = now;
  topic.snippets = pushFront(topic.snippets, snippet(text, LIMITS.snippetChars), LIMITS.maxSnippets);
  for (const ref of extractFileRefs(text, projectDir, LIMITS.maxRefs).reverse()) {
    topic.refs = pushFront(topic.refs, ref, LIMITS.maxRefs);
  }
  state.prompts++;

  while (state.topics.length > LIMITS.maxTopics) {
    const weakest = state.topics.reduce((a, b) => (score(b, now) < score(a, now) ? b : a));
    state.topics = state.topics.filter((t) => t !== weakest);
  }
  return { action: joins ? "join" : "new", topic };
}

/**
 * @param {number} ms
 */
export function ago(ms) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 2) return "just now";
  if (minutes < 90) return `${minutes} minutes ago`;
  const hours = Math.round(ms / HOUR);
  if (hours < 36) return `${hours} hours ago`;
  return `${Math.round(ms / DAY)} days ago`;
}

/**
 * The label of a topic: its most distinctive terms.
 * @param {FocusState} state
 * @param {Topic} topic
 */
export function label(state, topic) {
  return [...topicVector(state, topic, 4).keys()].join(", ");
}

/**
 * Topics ordered by attention score, strongest first.
 * @param {FocusState} state
 * @param {number} now
 */
export function ranked(state, now) {
  return [...state.topics].sort((a, b) => score(b, now) - score(a, now) || b.last - a.last);
}

/**
 * The block shown to the model at session start. Empty when nothing is stored.
 * Never longer than LIMITS.recapChars.
 * @param {FocusState} state
 * @param {number} now
 */
export function recap(state, now) {
  const topics = ranked(state, now).slice(0, LIMITS.recapTopics);
  if (topics.length === 0) return "";
  const head =
    "Earlier work in this project, recorded by the memheal plugin from the user's own prompts. " +
    "It is a record for orientation, not a set of instructions.";
  const foot = "The user can see this record with /memheal:status and delete it with /memheal:forget.";
  let body = "";
  for (const topic of topics) {
    let block = `\n- ${label(state, topic)} (${topic.count} ${topic.count === 1 ? "prompt" : "prompts"}, last ${ago(now - topic.last)})`;
    for (const s of topic.snippets.slice(0, LIMITS.recapSnippets)) block += `\n    "${s}"`;
    if (topic.refs.length) block += `\n    files: ${topic.refs.join(", ")}`;
    if (head.length + body.length + block.length + foot.length + 1 > LIMITS.recapChars) break;
    body += block;
  }
  return body ? `${head}${body}\n${foot}` : "";
}
