# SwingClips: notes for Gemini CLI

Read **CLAUDE.md** first: the rules, tests and layout apply to you too.

## How work is shared

Claude Code (in `D:\SwingClips-dev\swingclips`, branch `main`) merges. You work in your own
worktree, `D:\SwingClips-dev\swingclips-gemini`, on branch `gemini/work`:

1. Tasks are in `D:\SwingClips-dev\gemini-prompts.md` (outside the repo). Do the one you're given.
2. Start from the latest `main`: `git fetch origin; git rebase origin/main`.
3. Commit on `gemini/work`. Don't push to `main`, open pull requests or force-push.
4. When done, add "Gemini's report" to your task in `gemini-prompts.md`: what changed, what you
   checked, anything left open.

The Python venv lives in the main checkout: from the worktree, run the tests with
`..\..\swingclips\server\.venv\Scripts\python.exe` in place of `.venv\Scripts\python.exe`.
