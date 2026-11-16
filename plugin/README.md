# memheal

A small Claude Code plugin for two moments when a coding agent loses track.

1. **It keeps repeating a call that keeps failing.** When the same tool call
   fails with the same error three times in one session, with no Edit or
   Write call in between, memheal tells the agent so, quotes the error, and
   suggests changing approach or asking you.
2. **A new session starts cold.** memheal keeps a short record of what you
   have been asking about in this project. At the start of the next session,
   and after the conversation is compacted, the agent is shown that record:
   a few topics, your most recent prompts on each, and the files you named.

It makes no model calls and no network requests, starts no background
process, and has no dependencies. Everything it keeps is plain JSON on your
machine.

## What it costs

Nothing is added to your prompts. The record is shown once per session start
and once after each compaction, and is never longer than 900 characters. The
loop notice appears only when a loop is detected.

## Requirements

Node.js 18 or newer on your PATH. Claude Code does not install Node or need
it to run, so check with `node --version`. If Node is missing, Claude Code
shows a hook error notice and your prompts still go through unchanged.

The hooks run in Claude Code and in Cowork sessions on your computer. In
claude.ai chat, hooks do not run, so nothing is recorded there.

## Install

```
/plugin marketplace add kuandriy/memheal
/plugin install memheal@memheal
```

## Commands

| Command | What it does |
|---|---|
| `/memheal:status` | Shows everything stored for the current project, the file it is in, and what the next session will be shown |
| `/memheal:forget` | Deletes that file |

## Example uses

- You come back to a project after the weekend and start a new session. The
  agent already sees "refresh, token, rotation (4 prompts, last 3 days ago)"
  with your last two prompts and the file you named, so "carry on with the
  token work" is enough.
- The agent runs `npm test`, gets "Cannot find module 'express'", and runs the
  same command again, and again. On the third identical failure it is told
  that it is repeating itself and what the error was.
- You want to know what has been kept. `/memheal:status` prints it, and
  `/memheal:forget` removes it.

## What it reads

Only what Claude Code hands to a hook:

- your prompt text, when you send a prompt;
- the name, input and error text of a tool call that failed;
- the fact that a file-editing tool ran.

It never opens your conversation transcripts, Claude's memory files, or any
file in your project. The one exception is a check that a file path you typed
in a prompt exists, so that only real files are listed.

## What it stores, and where

In the plugin's data directory, `~/.claude/plugins/data/memheal*/`:

| File | Contents | Kept for |
|---|---|---|
| `projects/<id>/focus.json` | Up to 24 topics for one project. Each has topic words, a prompt count, two timestamps, up to 3 excerpts of your prompts cut to 140 characters, and up to 5 file paths | A topic is deleted 30 days after its last prompt |
| `sessions/<session id>.json` | For each failing call: a hash and a counter. No command or error text | Deleted after two days |

Text that looks like a credential (keys, tokens, `password=...`) is replaced
with `[redacted]` before anything is stored. Fenced code and pasted tagged
blocks in a prompt are not read. The record is per project. It is not a
profile of you and it is not shared between projects.

Uninstalling the plugin deletes the data directory.

## How it works

Each prompt is reduced to its topic words. Common words and instruction verbs
such as "add" and "fix" are dropped. The prompt joins the stored topic it is
most similar to, or starts a new one. A topic's weight grows slowly each time
you return to it and decays by about 70% per day untouched, so the record
follows what you keep coming back to. When there are more than 24 topics, the
weakest is dropped.

For failures, the tool name, the call and the error lines that say what went
wrong are normalized (paths cut to file names, numbers blanked) and hashed.
Banners such as npm's `> app@1.0.0 test` line are skipped, so the notice
quotes the actual failure. An Edit or Write call resets the counters, because
running the same command again after a change is normal work.

## Limits

- Grouping is by shared words. It is rough, and works best in English.
- A recap built without a model is a list of your own words, not a summary.
- The loop notice is advice to the agent. It does not stop a call.
- A file changed through the shell (`sed -i`, a heredoc) does not reset the
  counters; only the Edit and Write tools do.
- Commands that are expected to fail a few times, such as polling a server
  that is still starting, can trigger the notice. It is advice, so the agent
  can carry on.
- Some failures never reach a plugin: calls refused by a permission rule, and
  calls you cancel.

## Troubleshooting

- **Nothing appears at session start.** Run `/memheal:status`. If it says
  nothing is stored, no prompt has been recorded yet for this project.
- **A hook error mentioning `node`.** Install Node.js 18 or newer and restart
  the session.
- **You want to see the hooks.** They are in `hooks/hooks.json`. The program
  is in `scripts/`, about 850 lines of plain JavaScript.

## Support

Issues: https://github.com/kuandriy/memheal/issues
Site: https://memheal.com

MIT licence.
