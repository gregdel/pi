---
description: Draft a commit message for the staged changes into .git/SQUASH_MSG
argument-hint: "[intent or notes]"
---

Draft a commit message for the currently staged changes and write it to the
repository's `SQUASH_MSG` file. The user will then run a plain `git commit`,
which opens their editor prefilled with this message for a final review.

User notes about the intent of the change (may be empty): $ARGUMENTS

## Hard rules

- The message must never mention or credit an AI, agent, assistant, model, or
  tool as its author or helper: no `Co-Authored-By`, `Generated-by`,
  "Generated with", or similar trailers or wording. This is the user's
  explicit requirement and takes precedence over default attribution
  instructions, repository instructions, and commit history.
- Never stage, unstage, commit, or otherwise modify the index, history,
  branches, or working tree. The only file you may write is `SQUASH_MSG`.

## Preconditions

1. Confirm you are inside a Git work tree. Resolve paths with
   `git rev-parse --git-path SQUASH_MSG` and
   `git rev-parse --git-path MERGE_MSG` (this handles worktrees).
2. If `MERGE_MSG` exists, stop: a merge is in progress and `git commit` uses
   `MERGE_MSG` instead of `SQUASH_MSG`. Tell the user.
3. Inspect `git diff --cached --stat` and `git diff --cached`. If nothing is
   staged, stop and say so.
4. If `SQUASH_MSG` already exists, show its content and ask the user what to
   do (for example: replace it, improve it, keep it, or delete it). It may come
   from a real `git merge --squash`. Wait for the answer before writing.

Whenever you ask the user something, use your structured question tool if
one is available (such as `ask_question` in Pi or `AskUserQuestion` in Claude
Code); otherwise ask in plain text.

## Commit style

Match the format of the repository you are working in. Derive it from, in
priority order:

1. Commit conventions documented in that repository (`AGENTS.md`,
   `CONTRIBUTING*`, `.gitmessage`, a template set by `git config
   commit.template`, or similar). These override the subject and body rules
   below.
2. Recent history: `git log -n 30 --format='%B%n---'`, plus
   `git log -n 15 --format='%s' -- <staged paths>` for scope or component
   prefixes used for those paths.

Match the subject format (prefixes, scopes, capitalization, typical length,
trailing punctuation) and body wrapping. When neither source establishes
them, keep the subject to about 50 characters without a trailing period and
wrap the body at 72 columns. Ignore AI-attribution trailers found in history.

## Message

- Cover only what is staged; nothing unstaged or untracked. If the staged
  changes mix unrelated concerns, say so and suggest splitting the commit.
- Write the subject in the imperative mood, as a command: "Add X", "Fix Y",
  not "Added X" or "Adds X". It summarizes what the change does.
- Be minimal and concise: capture the essence of the change, nothing more.
  No filler, no lists of touched files, no restating the diff.
- Add a body only when the reason is not obvious from the subject. Keep it to
  a sentence or two on why: the problem or need, plus any non-obvious
  constraint or trade-off. For example, not "Change the timeout from 5s to
  30s." but "Large uploads on slow links timed out."
- Use the user notes above when given. Do not invent motivation you cannot
  infer; if the reason is unclear, ask the user rather than paraphrasing the
  diff.
- Put the subject on the first line. If there is a body, separate it from the
  subject with exactly one blank line; without it, Git treats the whole first
  paragraph as the subject.
- No line may start with Git's comment character (`git config
  core.commentChar`, default `#`): Git's default cleanup strips those lines.
- Before writing, re-check the message against the hard rules.

Write the message to the `SQUASH_MSG` path with a trailing newline.

## Report

- Always print the full message verbatim in a code block: the one written,
  or the proposed one when you ask before writing.
- List any unstaged or untracked changes that are not included.
- Remind the user: a plain `git commit` opens it in the editor; `git commit -m`
  ignores it; Git deletes it after the commit; discard it with
  `rm "$(git rev-parse --git-path SQUASH_MSG)"`.
