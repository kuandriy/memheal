---
name: status
description: Show what the memheal plugin has stored for the current project, where the file is, and what the next session will be shown. Use only when the user asks what memheal has stored or runs /memheal:status.
disable-model-invocation: true
---

Run this command in the shell, then show its output to the user exactly as printed, in a code block. Do not summarize it.

node "${CLAUDE_PLUGIN_ROOT}/scripts/memheal.mjs" status --data "${CLAUDE_PLUGIN_DATA}" --project "${CLAUDE_PROJECT_DIR}"

If the command cannot run, say why in one sentence and stop. The usual reasons are that Node.js is not installed, or that this is not a Claude Code or Cowork session running on the user's computer, where memheal's hooks do not run and nothing is stored.
