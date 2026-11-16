// Loop breaker: notices when the same tool call fails with the same error
// several times in one session with no Edit or Write call in between, and says so.
//
// The call and error normalization is ported from repeat-miner (normCmd,
// signature). Only a hash of each signature and a counter are kept, and only
// for the current session. See docs/DESIGN.md.

import crypto from "node:crypto";

export const LOOP = Object.freeze({
  threshold: 3, // identical failures before the first notice
  repeatEvery: 2, // then again at 5, 7, ...
  errorChars: 160, // length of the error line quoted in the notice
  maxEntries: 200, // distinct failing calls tracked per session
});

/**
 * @typedef {object} LoopState
 * @property {number} version
 * @property {Record<string, { n: number, t: number }>} streaks  signature hash -> count and last time
 */

/** @returns {LoopState} */
export function emptyLoopState() {
  return { version: 1, streaks: {} };
}

/**
 * @param {unknown} value
 * @returns {LoopState}
 */
export function normalizeLoopState(value) {
  const v = /** @type {Partial<LoopState> | null} */ (value);
  if (!v || typeof v !== "object" || v.version !== 1 || !v.streaks || typeof v.streaks !== "object") {
    return emptyLoopState();
  }
  return { version: 1, streaks: v.streaks };
}

const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

/**
 * Strips the parts of a shell command that do not change what was attempted:
 * a leading "cd dir &&", output redirections, and everything after the first
 * pipe. "cd x && npm test 2>&1 | tail -5" becomes "npm test".
 * @param {string} command
 */
export function normalizeCommand(command) {
  const kept = [];
  for (let segment of command.split(/\s*(?:&&|;)\s*/)) {
    const pipe = segment.search(/\|(?!\|)/);
    if (pipe >= 0 && segment[pipe - 1] !== "|") segment = segment.slice(0, pipe);
    segment = segment.replace(/\s*\d*>&?\s*\S+/g, "").replace(/\s+/g, " ").trim();
    if (!segment || /^(?:cd|pushd|set-location)\s/i.test(segment)) continue;
    kept.push(segment);
  }
  return kept.join(" && ");
}

/**
 * The part of a tool's input that identifies what was attempted.
 * @param {string} tool
 * @param {unknown} input
 */
export function callKey(tool, input) {
  const fields = /** @type {Record<string, unknown>} */ (input && typeof input === "object" ? input : {});
  if (SHELL_TOOLS.has(tool) && typeof fields.command === "string") return normalizeCommand(fields.command);
  for (const name of ["command", "file_path", "notebook_path", "path", "pattern", "url", "query"]) {
    const value = fields[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return JSON.stringify(fields).slice(0, 200);
}

// A line that says what went wrong, as opposed to a banner or an echo of the
// command ("> app@1.0.0 test", "Traceback (most recent call last):").
const SAYS_WHAT_FAILED = /error|fail|exception|fatal|denied|not found|cannot|can't|unable|no such|panic|invalid|refused|timed out/i;

/**
 * The lines of an error that say what went wrong: up to five, from the top.
 * When no line looks like one, the first meaningful line stands in. The first
 * of them is quoted in the notice; all of them make up the signature, so two
 * runs that print the same banner and fail differently are not the same.
 * @param {string} error
 * @returns {string[]}
 */
export function keyErrorLines(error) {
  const lines = error
    .replace(/<\/?[a-z_]+>/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^exit code \d+$/i.test(l));
  const telling = lines.filter((l) => SAYS_WHAT_FAILED.test(l) && !/^traceback \(most recent call/i.test(l));
  return telling.length ? telling.slice(0, 5) : lines.slice(0, 1);
}

/**
 * A stable form of an error line: lowercased, paths cut to their file name,
 * ids and numbers blanked, so the same failure matches itself.
 * @param {string} line
 */
export function errorSignature(line) {
  return line
    .toLowerCase()
    .replace(/(?:\b[a-z]:)?[^\s"'`:]*[/\\][^\s"'`:]*/g, (p) => p.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? "")
    .replace(/\b[0-9a-f]{7,}\b/g, "H")
    .replace(/\d+/g, "N")
    .replace(/\s+/g, " ")
    .slice(0, 120);
}

// Failures that are not the agent being stuck: the user stopped the call, a
// permission rule refused it, or it was cancelled with a sibling call.
const NOT_A_FAILURE = [
  /doesn't want to proceed|user rejected|rejected by (?:the )?user|interrupted by (?:the )?user|request interrupted|tool use was rejected/i,
  /permission to use .{0,80}denied|requires approval|blocked by (?:a |the )?(?:hook|permission|policy|rule)|requested permissions/i,
  /cancelled: parallel tool call/i,
];

/**
 * @typedef {object} FailureInput
 * @property {string} [tool_name]
 * @property {unknown} [tool_input]
 * @property {string} [error]
 * @property {boolean} [is_interrupt]
 * @property {string} [agent_id]
 */

/**
 * Counts one failed tool call. Mutates `state`. Returns the notice to show the
 * model, or "" when there is nothing to say.
 * @param {LoopState} state
 * @param {FailureInput} input
 * @param {number} now
 */
export function onFailure(state, input, now) {
  const tool = typeof input.tool_name === "string" ? input.tool_name : "";
  const error = typeof input.error === "string" ? input.error : "";
  if (!tool || input.is_interrupt || NOT_A_FAILURE.some((re) => re.test(error))) return "";
  const lines = keyErrorLines(error);
  if (lines.length === 0) return "";
  const line = lines[0];

  const signature = [input.agent_id ?? "main", tool, callKey(tool, input.tool_input), ...lines.map(errorSignature)].join("\n");
  const key = crypto.createHash("sha256").update(signature).digest("hex").slice(0, 16);
  const streak = state.streaks[key] ?? { n: 0, t: now };
  streak.n++;
  streak.t = now;
  state.streaks[key] = streak;

  const keys = Object.keys(state.streaks);
  if (keys.length > LOOP.maxEntries) {
    keys.sort((a, b) => state.streaks[a].t - state.streaks[b].t);
    for (const old of keys.slice(0, keys.length - LOOP.maxEntries)) delete state.streaks[old];
  }

  if (streak.n < LOOP.threshold || (streak.n - LOOP.threshold) % LOOP.repeatEvery !== 0) return "";
  const shown = line.length > LOOP.errorChars ? line.slice(0, LOOP.errorChars - 1) + "…" : line;
  return (
    `memheal: this same ${tool} call has now failed ${streak.n} times in this session with the same error ` +
    `and no Edit or Write call in between: "${shown}". Repeating it unchanged is unlikely to help. ` +
    "Try a different approach, or stop and tell the user what is blocking."
  );
}

/**
 * A file was edited: later failures are a new attempt, not a repeat.
 * Returns true when there was something to clear.
 * @param {LoopState} state
 */
export function onEdit(state) {
  if (Object.keys(state.streaks).length === 0) return false;
  state.streaks = {};
  return true;
}
