---
name: forget
description: Delete everything the memheal plugin has stored for the current project. Use only when the user runs /memheal:forget or asks to delete memheal's record for this project.
disable-model-invocation: true
---

Run this command in the shell, then tell the user what it printed.

node "${CLAUDE_PLUGIN_ROOT}/scripts/memheal.mjs" forget --data "${CLAUDE_PLUGIN_DATA}" --project "${CLAUDE_PROJECT_DIR}"

It deletes one file, the record of earlier prompts for this project. It touches nothing else. If the command cannot run, say why in one sentence and stop.
