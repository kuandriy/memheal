// Text helpers for memheal: cleaning, redaction, tokenizing, light stemming,
// and file references. Ported from focus-gate (internal/text) with the
// changes explained in docs/DESIGN.md. No dependencies.

import fs from "node:fs";
import path from "node:path";

/** Words that carry no topic. Checked on the raw word and on its stem. */
export const STOP_WORDS = new Set(
  `a an the and or but in on at to for of with by from is it as be was are been being
have has had do does did will would could should may might can shall must this that these those
i me my we our you your he she his her they them their what which who when where how why not no
so if then than too very just about also into each all any some more most other up out its only
own same there here am were while during before after above below between through again further
once both such don didn doesn won isn aren wasn weren let need want like make think know see get
got go going one two first new well now way even back much because thing still us really right
re ve ll said say use used please ok okay yes yeah yep nope thanks thank hi hey sure redacted`
    .split(/\s+/),
);

/**
 * Prompts are imperatives. The verb says what to do, not what it is about, and
 * one shared verb is enough to glue two unrelated short prompts together.
 */
const GENERIC_VERBS = new Set([
  "add", "fix", "update", "create", "change", "remove", "delete", "implement",
  "write", "run", "check", "show", "help", "try", "look", "find", "give", "tell",
  "review", "explain", "describe", "list", "summarize", "refactor",
]);

/**
 * True for a generic verb in any common inflection: "fixing", "updated", "adds".
 * @param {string} word lowercased
 */
export function isGenericVerb(word) {
  if (GENERIC_VERBS.has(word)) return true;
  for (const suffix of ["ing", "ed", "es", "s"]) {
    if (word.length <= suffix.length + 2 || !word.endsWith(suffix)) continue;
    const base = word.slice(0, -suffix.length);
    if (GENERIC_VERBS.has(base) || GENERIC_VERBS.has(base + "e")) return true;
    const last = base.length - 1;
    if (last > 1 && base[last] === base[last - 1] && GENERIC_VERBS.has(base.slice(0, last))) return true;
  }
  return false;
}

/**
 * Plural stemmer, nothing more. It accepts a miss ("testing" stays apart from
 * "test") to rule out false merges ("apply" must never become "app") and to
 * keep every topic label a real word.
 * @param {string} word lowercased
 */
export function stem(word) {
  if (word.length < 4) return word;
  if (word.length > 4 && word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (/(?:ss|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s") && !/(?:ss|us|is)$/.test(word)) return word.slice(0, -1);
  return word;
}

/**
 * Turns text into topic terms: split camelCase, lowercase, split on anything
 * that is not a letter or digit, drop numbers, stop words and generic verbs,
 * stem the rest.
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  // Paths and links are kept as file references, not as topic words: their
  // folder names ("src", "lib") would otherwise pull unrelated prompts together.
  const prose = text.replace(/\S*[/\\]\S*/g, " ");
  const spaced = prose.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  const terms = [];
  for (const raw of spaced.split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2 || /^\p{N}+$/u.test(raw)) continue;
    if (STOP_WORDS.has(raw) || isGenericVerb(raw)) continue;
    const term = stem(raw);
    if (term.length < 2 || STOP_WORDS.has(term)) continue;
    terms.push(term);
  }
  return terms;
}

/**
 * Removes material the user did not type as their request: tagged blocks that
 * tools and IDEs wrap around a prompt, and fenced code or logs.
 * @param {string} raw
 */
export function cleanPrompt(raw) {
  return raw
    .replace(/<([a-z][a-z0-9_-]*)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .trim();
}

/** Patterns for things that look like credentials. Matches are replaced, never stored. */
const SECRET_PATTERNS = [
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  // Long opaque strings. "/" is left out so a deep file path is not mistaken for one.
  /\b[A-Za-z0-9+_-]{40,}\b/g,
];
const LABELLED_SECRET = /\b(password|passwd|pwd|secret|token|api[_-]?key)(\s*[:=]\s*)\S+/gi;

/**
 * Replaces credential-looking text with "[redacted]". Runs before anything is
 * tokenized or stored.
 * @param {string} text
 */
export function redact(text) {
  let out = text.replace(LABELLED_SECRET, "$1$2[redacted]");
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[redacted]");
  return out;
}

/**
 * One line, at most `max` characters.
 * @param {string} text
 * @param {number} max
 */
export function snippet(text, max) {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? line.slice(0, max - 1).trimEnd() + "…" : line;
}

const CODE_EXTENSIONS = new Set(
  `go ts js tsx jsx mjs cjs py java rs rb cpp c h hpp cs swift kt scala php vue svelte yaml yml
json toml xml sql sh bash zsh ps1 css scss less html md proto graphql tf mod sum lock env cfg`
    .split(/\s+/),
);
const PATH_PATTERN = /(?:^|[\s`"'(])((?:\.{0,2}\/)?(?:[\w.@-]+\/)+[\w.@-]+\.([a-zA-Z0-9]{1,10}))(?=$|[\s`"'),;:\]])/g;
const BACKTICK_FILE_PATTERN = /`([\w.-]+\.([a-zA-Z0-9]{1,10}))`/g;
const DOMAIN_PARTS = [".com/", ".org/", ".io/", ".net/", ".dev/", ".co/"];

/**
 * File paths mentioned in a prompt that exist inside the project. Paths that
 * do not exist, point outside the project, or look like URLs are dropped, so
 * the result reflects real files and not figures of speech.
 * @param {string} text
 * @param {string} projectDir
 * @param {number} max
 * @returns {string[]} project-relative paths with forward slashes
 */
export function extractFileRefs(text, projectDir, max) {
  const normalized = text.replace(/\\/g, "/");
  const root = path.resolve(projectDir);
  /** @type {string[]} */
  const refs = [];
  for (const pattern of [PATH_PATTERN, BACKTICK_FILE_PATTERN]) {
    for (const match of normalized.matchAll(pattern)) {
      const candidate = match[1];
      if (!CODE_EXTENSIONS.has(match[2].toLowerCase()) || candidate.includes("://")) continue;
      const lower = candidate.toLowerCase();
      if (DOMAIN_PARTS.some((part) => lower.includes(part))) continue;
      const relative = path.relative(root, path.resolve(root, candidate));
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
      const shown = relative.split(path.sep).join("/");
      if (refs.includes(shown)) continue;
      try {
        if (!fs.statSync(path.join(root, relative)).isFile()) continue;
      } catch {
        continue;
      }
      refs.push(shown);
      if (refs.length >= max) return refs;
    }
  }
  return refs;
}
