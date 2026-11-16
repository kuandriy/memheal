// Where memheal keeps its files, and how it reads and writes them.
// Everything is plain JSON under one directory. Nothing is written anywhere else.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A value passed from a skill is unusable when the "${...}" placeholder was
 * not filled in.
 * @param {string | undefined} value
 */
function usable(value) {
  return value && !value.includes("${") ? value : undefined;
}

/**
 * The data directory: the one Claude Code gives the plugin, which survives
 * plugin updates and is deleted on uninstall. "~/.memheal" is used only when
 * the scripts are run by hand outside Claude Code.
 * @param {string} [explicit]
 */
export function dataDir(explicit) {
  return usable(explicit) ?? usable(process.env.CLAUDE_PLUGIN_DATA) ?? path.join(os.homedir(), ".memheal");
}

/**
 * @param {string} [explicit]
 * @param {string} [cwd]  the working directory reported by the hook
 */
export function projectDir(explicit, cwd) {
  return path.resolve(usable(explicit) ?? usable(process.env.CLAUDE_PROJECT_DIR) ?? cwd ?? process.cwd());
}

/**
 * A short, stable name for a project directory. Windows paths are compared
 * without regard to case.
 * @param {string} dir
 */
export function projectKey(dir) {
  const resolved = path.resolve(dir);
  const normalized = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/**
 * @param {string} data
 * @param {string} project
 */
export function focusFile(data, project) {
  return path.join(data, "projects", projectKey(project), "focus.json");
}

/**
 * @param {string} data
 * @param {string} sessionId
 */
export function sessionFile(data, sessionId) {
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "unknown";
  return path.join(data, "sessions", `${safe}.json`);
}

/**
 * Reads a JSON file. A missing or damaged file yields undefined.
 * @param {string} file
 * @returns {unknown}
 */
export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Writes a JSON file through a temporary file and a rename, so a reader never
 * sees half a file.
 * @param {string} file
 * @param {unknown} value
 */
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 1) + "\n", "utf8");
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true }); // leave no stray file behind
    throw error;
  }
}

/**
 * Deletes a file and its directory if that leaves it empty.
 * Returns true when a file was deleted.
 * @param {string} file
 */
export function removeFile(file) {
  try {
    fs.rmSync(file);
  } catch {
    return false;
  }
  try {
    fs.rmdirSync(path.dirname(file));
  } catch {
    // directory not empty or already gone: nothing to do
  }
  return true;
}

/**
 * Deletes per-session files that have not been touched for `maxAgeMs`.
 * @param {string} data
 * @param {number} maxAgeMs
 * @param {number} now
 * @returns {number} files deleted
 */
export function sweepSessions(data, maxAgeMs, now) {
  const dir = path.join(data, "sessions");
  let removed = 0;
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      if (now - fs.statSync(file).mtimeMs > maxAgeMs) {
        fs.rmSync(file);
        removed++;
      }
    } catch {
      // another session removed it first
    }
  }
  return removed;
}
