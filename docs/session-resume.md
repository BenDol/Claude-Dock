# Session Resume

## How It Works

When a dock workspace window closes, the session IDs of active Claude terminals are saved to `sessions.json` (keyed by project directory). On next open, the dock spawns new PTY processes and runs `claude --resume <sessionId>` to restore each conversation.

Resume success is detected by watching for the alternate screen buffer escape (`\x1b[?1049h`). Resume failure is detected by a shell fallback marker (`__DOCK_RF__`) that prints when `claude --resume` exits non-zero. On failure, the dock clears the terminal, generates a fresh session ID, and launches `claude --session-id <newId>` instead.

## Known Edge Case: Claude CLI Updates Clear Sessions

When Claude CLI updates to a new version, all saved sessions will silently reset on next workspace open. The `claude --resume <id>` command exits non-zero for sessions created under the previous CLI version, triggering the resume failure handler which replaces each session with a fresh one.

This affects every workspace opened after the update — not just one.

### Why

- Claude CLI auto-updates independently of the dock
- The `--resume` flag loads conversation history from `~/.claude/projects/<project>/<sessionId>.jsonl`
- A CLI update can change the session file format or `--resume` behavior, making old sessions unloadable
- The dock has no way to distinguish "session expired" from "CLI updated" — both look like a non-zero exit

### Impact

- All conversation history in the dock appears to reset
- The old session files still exist on disk (they are not deleted)
- Users lose the ability to scroll back through prior conversation context

### Possible Mitigations

- **Detect CLI version changes**: Compare `claude --version` at startup against a cached value. If changed, warn the user that sessions may not resume rather than silently resetting.
- **Capture resume error output**: Log Claude's stderr when `--resume` fails so the root cause is diagnosable from dock logs.
- **Retry with `--continue`**: If `--resume` semantics change across versions, try alternate flags before falling back to a fresh session.
