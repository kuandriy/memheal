# memheal

A Claude Code plugin for two moments when a coding agent loses track: it keeps
repeating a call that keeps failing, and a new session starts cold.

What users install is the [`plugin/`](plugin/) folder. Its
[README](plugin/README.md) says what it does, what it stores and how to remove
it. This file is for working on the repository.

## Status

Version 0.1.0, not released yet. It passes Claude Code's plugin validator and
63 automated tests, and Claude Code loads it. It has not yet been watched
through a full live session, so treat it as a preview.

## Layout

```
.claude-plugin/marketplace.json   our own marketplace; its one entry points at ./plugin
plugin/                           everything that ships, and nothing else
  .claude-plugin/plugin.json      manifest
  hooks/hooks.json                four hooks, all running scripts/memheal.mjs
  scripts/                        the program: plain JavaScript, no dependencies
  skills/                         /memheal:status and /memheal:forget
  README.md  LICENSE
test/                             node --test
docs/DESIGN.md                    how it works and what changed from the Go tools
docs/PUBLISHING.md                release steps and the directory checklist
package.json  tsconfig.json       development only
```

Nothing outside `plugin/` reaches a user or Anthropic's scanner. In
particular there is no `package.json` inside `plugin/`: Claude Code would run
an install for it and the directory would hold the plugin for review.

## Work on it

Needs Node.js 18 or newer.

```
npm install        # TypeScript and Node types, for checking only
npm test           # 63 tests
npm run typecheck  # JSDoc types, strict
```

Try the program by hand:

```
echo '{"hook_event_name":"UserPromptSubmit","prompt":"add refresh token rotation"}' | node plugin/scripts/memheal.mjs hook
node plugin/scripts/memheal.mjs status
node plugin/scripts/memheal.mjs forget
```

Run outside Claude Code it keeps its files in `~/.memheal`.

Load it in Claude Code for one session:

```
claude --plugin-dir ./plugin
```

## Rules for changes

- The shipped code is plain JavaScript with JSDoc types. No build step, no
  bundle, no dependency. What is in `plugin/scripts/` is what runs.
- Every line in `plugin/` is read by a reviewer on every release. Keep it
  short. `test/directory-rules.test.mjs` fails above 1,000 lines.
- A hook never blocks and never fails: it exits 0 whatever happens.
- Nothing is stored that is not needed, and everything stored has a size
  limit and an expiry.

## Background

memheal grew out of three experiments: a checker for stale agent notes, a
counter for repeated tool failures, and a prompt hook that tracked what a user
keeps returning to. A critical review dropped most of it. What survived, and
why the rest did not, is in [docs/DESIGN.md](docs/DESIGN.md).

MIT licence.
