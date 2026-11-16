# Publishing memheal

Two routes, used together: our own marketplace (no review, works at once) and
Anthropic's directory (reviewed, reaches claude.ai, Cowork and Claude Code).

Rules below were read on 15 November 2026 at:

- https://code.claude.com/docs/en/plugins/publish
- https://claude.com/docs/plugins/pre-submission-checklist
- https://claude.com/docs/plugins/submit
- https://claude.com/docs/plugins/platform-support
- https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy

## Checks before a release

```
npm run check                                                  # tests and type check
claude plugin validate ./plugin --strict
claude plugin validate ./plugin --profile directory --strict   # what the directory checks
claude --plugin-dir ./plugin                                   # load it for one session
```

In that session: `/hooks` lists four memheal hooks; a command that fails three
times unchanged draws the notice on the third failure; `/memheal:status`
prints the record; a second session shows the recap once.

## Our own marketplace

The file `.claude-plugin/marketplace.json` at the repository root already
lists the plugin with source `./plugin`. Once the repository is on GitHub:

```
/plugin marketplace add kuandriy/memheal
/plugin install memheal@memheal
```

Releases: raise `version` in `plugin/.claude-plugin/plugin.json`, commit,
push. A user gets the new copy only when the version string changes.

## Anthropic's directory

Needs: a paid claude.ai plan; the GitHub account connected on claude.ai with
push access; the repository public before the listing goes live.

1. Open https://claude.ai/directory/manage, "Submit new", "Plugin bundle".
2. Repository `kuandriy/memheal`, plugin path `plugin`.
3. "Validate". Fix anything marked Blocking, push, "Re-validate".
4. Listing details come from `plugin.json` and `plugin/README.md`.
5. Data handling answers, as the plugin stands:
   - Reads or stores personal data: it stores short excerpts of the user's
     own prompts, on their machine, per project.
   - Sends data elsewhere: no.
   - How long: a topic is deleted 30 days after its last prompt; loop
     counters after 2 days; everything on uninstall.
   - Intended for under 18: no.
6. Submit. A person reviews a new listing. Each later commit on the tracked
   branch is scanned again.

### What to expect from the checks

- **Held for a reviewer on every version**: hooks that run a non-shell file
  ("Scripts the validator couldn't follow"). memheal runs `node` on its own
  `.mjs` files, so this hold is expected. It is not a rejection. It is the
  reason the shipped code is small, readable and free of dependencies.
- **Nothing else should be flagged.** `test/directory-rules.test.mjs` checks
  what can be checked locally: name rules, README length, licence, file types
  and sizes, no `bin/`, no `package.json` in the plugin, exec-form hooks with
  paths from `${CLAUDE_PLUGIN_ROOT}` only, no network or child-process code.

### What a listing needs

- An icon: a square PNG or JPEG, 512 to 2048 px, under 2 MB, at
  `plugin/.claude-plugin/icon.png` (found without setting `icon`). SVG and
  WebP are refused. The portal reads it only the first time the plugin is
  saved; a later change does not update the listing.
- `privacyPolicyUrl`, `supportUrl` and `documentationUrl` in `plugin.json`,
  pointing at pages on memheal.com.
