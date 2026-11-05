# Craft Watch: instructions for Claude Code
Read `SPEC.md` first; the look is in `design/*.dc.html` (sample data mockups: copy the style, not the fake numbers).
Build one phase at a time (SPEC §7). After each phase: run it, show me what changed, list what I should check, then stop and wait.
Public GitHub data only; signals, not a guarantee; flag, never accuse. Escape all GitHub text. No tracking, no secrets,
no personal info (overprivileged account only, no local paths in code or commits). Never invent data.

## Privacy for a PUBLIC repo (must follow)
- Before the first commit: `git config user.name "Overprivileged"` and `git config user.email "<the noreply address I give you>"` (local to this repo, not global). Ask for the noreply address if you don't have it.
- `.gitignore` from the start: `.env*`, `node_modules/`, `.DS_Store`, `*.log`, `.cache/`, `tmp/`, local screenshots/recordings.
- Never write a token, key, password, email, real name or local home-folder path into any file, commit message or output. Read the GitHub token only from the environment (`GITHUB_TOKEN`); never print it.
- Before EVERY commit: check the staged diff for secrets, emails, personal names and local paths; stop and tell me if you find any.
- Before the repo goes public (phase 9): run a full check (`git log --format='%an <%ae>' | sort -u` must show only Overprivileged + noreply; scan all files and history for tokens/emails/paths) and show me the result.

## No slop (look and words)
Real data only (never invented counters, quotes or results). No AI-generated images. One accent effect max (one gradient
or one glow), no neon/glossy/3D. Max 3 colours + green/red/yellow status. Motion only when it explains something.
No hype words (ultimate, powerful, AI-powered, 100%, guaranteed). Never promise "safe": say what was checked.
Short human sentences, no exclamation spam, no fake urgency. No popups, email capture or nags.
