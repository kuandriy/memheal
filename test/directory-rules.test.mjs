// The parts of Anthropic's plugin pre-submission checklist that can be checked
// from here. This is a local stand-in for the developer portal's Validate
// button, not a replacement for it.
// Source: https://claude.com/docs/plugins/pre-submission-checklist (read 2026-11-15)

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const PLUGIN = fileURLToPath(new URL("../plugin/", import.meta.url));
const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
  );
}
const files = walk(PLUGIN);
const rel = (/** @type {string} */ f) => path.relative(PLUGIN, f).split(path.sep).join("/");
const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN, ".claude-plugin", "plugin.json"), "utf8"));
const hooks = JSON.parse(fs.readFileSync(path.join(PLUGIN, "hooks", "hooks.json"), "utf8"));

test("manifest: permanent lowercase name, and the metadata the portal warns about", () => {
  assert.match(manifest.name, /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
  for (const reserved of ["claude", "anthropic", "official", "plugin", "mcp", "test"]) assert.notEqual(manifest.name, reserved);
  assert.doesNotMatch(manifest.name, /^(claude-|anthropic-|anthropics-|cc-plugin-)/);
  for (const field of ["version", "description", "license"]) assert.equal(typeof manifest[field], "string", field);
  assert.equal(typeof manifest.author.name, "string");
  assert.doesNotThrow(() => new URL(manifest.homepage), "homepage must parse as a URL or the plugin fails to load");
  assert.ok(!("experimental" in manifest), "component keys under experimental block a submission");
  assert.ok(!("hooks" in manifest), "hooks/hooks.json loads by itself; listing it draws a warning");
});

test("the marketplace entry names the same plugin and points at the plugin folder", () => {
  const marketplace = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin", "marketplace.json"), "utf8"));
  assert.equal(marketplace.plugins.length, 1);
  assert.equal(marketplace.plugins[0].name, manifest.name);
  assert.equal(marketplace.plugins[0].source, "./plugin");
  assert.ok(!("version" in marketplace.plugins[0]), "the version lives in plugin.json only");
});

test("README has at least 40 words outside code blocks, and a licence file exists", () => {
  const readme = fs.readFileSync(path.join(PLUGIN, "README.md"), "utf8").replace(/```[\s\S]*?```/g, " ");
  assert.ok(readme.split(/\s+/).filter(Boolean).length >= 40);
  assert.ok(fs.existsSync(path.join(PLUGIN, "LICENSE")));
});

test("no file a reviewer would hold or the portal would refuse", () => {
  assert.ok(files.length <= 512, `${files.length} files`);
  const names = new Set();
  for (const file of files) {
    const name = rel(file);
    assert.ok(fs.statSync(file).size < 256 * 1024, `${name} is 256 KiB or more`);
    assert.match(name, /\.(mjs|json|md)$|^LICENSE$/, `${name}: only readable text is shipped`);
    assert.doesNotMatch(name, /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|__MACOSX)(\/|$)/);
    assert.doesNotMatch(name, /[:<>"|?*]|[. ](\/|$)/, `${name}: not a valid name on Windows`);
    assert.ok(!names.has(name.toLowerCase()), `${name}: differs from another name only by case`);
    names.add(name.toLowerCase());
    assert.ok(!fs.lstatSync(file).isSymbolicLink(), `${name} is a symbolic link`);
  }
  assert.ok(!fs.existsSync(path.join(PLUGIN, "bin")), "a top-level bin/ makes chat and Cowork refuse the plugin");
  for (const banned of ["package.json", "package-lock.json", "bun.lock", ".npmrc", "CLAUDE.md", ".mcp.json"]) {
    assert.ok(!fs.existsSync(path.join(PLUGIN, banned)), `${banned} must not be in the plugin folder`);
  }
});

test("hooks.json: wrapped event map, documented events, exec form, paths from the plugin root only", () => {
  assert.deepEqual(Object.keys(hooks).sort(), ["description", "hooks"]);
  const documented = new Set(["SessionStart", "UserPromptSubmit", "PostToolUse", "PostToolUseFailure"]);
  for (const [event, groups] of Object.entries(hooks.hooks)) {
    assert.ok(documented.has(event), event);
    for (const group of /** @type {any[]} */ (groups)) {
      for (const handler of group.hooks) {
        assert.equal(handler.type, "command");
        assert.equal(handler.command, "node", "exec form: the executable alone");
        assert.deepEqual(handler.args, ["${CLAUDE_PLUGIN_ROOT}/scripts/memheal.mjs", "hook"]);
        assert.ok(fs.existsSync(path.join(PLUGIN, "scripts", "memheal.mjs")));
        assert.ok(handler.timeout <= 30);
      }
    }
  }
  assert.equal(hooks.hooks.SessionStart[0].matcher, "startup|compact");
  assert.ok(!("matcher" in hooks.hooks.UserPromptSubmit[0]));
});

test("skills: valid front matter, a single-line description, user-invoked only", () => {
  const skills = files.filter((f) => rel(f).startsWith("skills/"));
  assert.deepEqual(skills.map(rel).sort(), ["skills/forget/SKILL.md", "skills/status/SKILL.md"]);
  for (const file of skills) {
    const text = fs.readFileSync(file, "utf8");
    const front = /^---\n([\s\S]*?)\n---\n/.exec(text.replace(/\r\n/g, "\n"));
    assert.ok(front, `${rel(file)} has no front matter`);
    const fields = Object.fromEntries(front[1].split("\n").map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1).trim()]));
    assert.equal(fields.name, path.basename(path.dirname(file)));
    assert.ok(fields.description.length > 40 && !fields.description.startsWith("["));
    assert.equal(fields["disable-model-invocation"], "true");
    assert.match(text, /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/memheal\.mjs/);
  }
});

test("the shipped program: no dependencies, no network, no child processes, nothing hidden", () => {
  const sources = files.filter((f) => f.endsWith(".mjs"));
  let lines = 0;
  for (const file of sources) {
    const text = fs.readFileSync(file, "utf8");
    lines += text.split("\n").length;
    const imports = [...text.matchAll(/^import\s.*?\sfrom\s+"([^"]+)";$/gm)].map((m) => m[1]);
    assert.ok(imports.length === text.split("\n").filter((line) => line.startsWith("import ")).length, `${rel(file)}: an import this test cannot read`);
    for (const spec of imports) {
      assert.match(spec, /^(node:(fs|os|path|crypto)|\.\/[\w./-]+\.mjs)$/, `${rel(file)} imports ${spec}`);
    }
    assert.doesNotMatch(text, /child_process|node:(http|https|net|dgram|dns|tls|worker_threads|vm)\b|\bfetch\s*\(|\beval\s*\(|new Function|\bimport\s*\(/, rel(file));
    assert.ok(text.split("\n").every((line) => line.length < 200), `${rel(file)} has a line a reviewer cannot read`);
  }
  assert.ok(lines < 1000, `${lines} lines: every shipped line is read by a reviewer on every release`);
});
