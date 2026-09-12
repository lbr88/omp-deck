---
name: create-skill
description: Author a new omp-native skill. Use when the user wants to capture a recurring workflow, create a skill from scratch, formalize a procedure into a SKILL.md, scaffold a new skill under ~/.omp/agent/skills/, or "turn this into a skill".
tags: [authoring, meta, omp-native]
---

# Create Skill

You are helping the user author a new **omp-native skill** — a `SKILL.md`
file that lives under `~/.omp/agent/skills/<name>/` (user scope) or
`<project>/.omp/skills/<name>/` (project scope) and gets discovered by `omp`
at session start.

This skill is intentionally minimal. It walks you through the author loop
using only `omp`'s standard tools (`read`, `write`, `edit`, `bash`). It does
NOT shell out to other coding agents and does NOT depend on any external
CLI.

## What a skill is, in two sentences

A skill is a markdown file. Only its frontmatter `description` reaches the
system prompt at session start (that's the *trigger*); the body is injected
as a user message when the user runs `/skill:<name>` or when the model
decides the description matches. Co-located files (scripts, references,
assets) ship next to it on disk and are reachable on demand via `read` /
`bash`, but they are **never** auto-loaded into the context.

So a well-authored skill is two things at once:

1. A **trigger** (frontmatter `description`) that fires when it should and
   stays silent otherwise.
2. A **playbook** (SKILL.md body) the agent follows once triggered, naming
   any co-located files it should reach for.

Both matter. A vague trigger never fires; a specific trigger that points to
empty guidance wastes a turn. Tune both.

## The loop

Work through these in order. Skip steps the user has already given you
answers to; never invent details to fill silence.

### 1. Capture intent

Ask the user:

- **What should this skill enable the agent to do?** One sentence. If
  they answer "a lot of things", narrow until you can name a single shape
  (e.g. "scaffold a Vite + Tailwind project" not "do frontend work").
- **When should it trigger?** What phrase, request, or symptom should
  make `omp` reach for this skill? Two or three concrete examples.
- **Scope.** User-level (`~/.omp/agent/skills/`) or project-level
  (`<repo>/.omp/skills/`)? Default to user unless the skill is
  project-specific (touches `.claude/`-style config, depends on a
  particular file layout, etc.).
- **Co-located files.** Will the skill ship scripts (`scripts/foo.py`),
  reference docs (`references/`), starter assets (`assets/`)? Capture
  the list now even if you write the files later.

If the user is updating an existing skill rather than creating one, jump
straight to step 4 (revise) after locating the existing `SKILL.md`.

### 2. Choose the name and pick the path

The **directory name** under `skills/` is what `/skill:<name>` resolves
to. Keep it short, lowercase, kebab-case. Match the frontmatter `name`
field to the directory name unless you have a reason not to.

The full target path is:

```
~/.omp/agent/skills/<dir-name>/SKILL.md                 # user scope
<project>/.omp/skills/<dir-name>/SKILL.md               # project scope
```

Before writing, verify the directory doesn't already exist. If it does,
ask the user whether to overwrite, pick a new name, or revise the
existing skill.

### 3. Write the description

This is the load-bearing step. The frontmatter `description` is the
*only* signal `omp` gives the model about your skill at session start.
Get it wrong and the skill silently never fires.

Rules:

- Lead with **what the skill does**, not who wrote it or how cool it is.
- Use the form `Use when <situation> — <implicit: this is the right tool>`.
  Examples that work:
  - `Use when a PowerShell 5.1 wrapper around a native exe falsely reports failure because it captured benign stderr INFO logs as ErrorRecords.`
  - `Use when round-tripping a UTF-8 file via PS 5.1 Get-Content + Set-Content -Encoding utf8 corrupts em-dashes to "â€"" and similar mojibake.`
- Name the symptom in concrete terms ("crashes after 2-3 deploys",
  "fails with HTTP 401", "produces empty output"). Vague is dead.
- Keep it to **one or two sentences**. Long descriptions get truncated.
- If the skill is procedural ("when X happens, do Y"), make sure the
  trigger half names X, not Y. The model decides whether to fire based
  on whether X matches its current task.

If you can't write a tight description, the skill might not be
well-defined yet. Back up to step 1.

### 4. Draft the SKILL.md

Layout:

```markdown
---
name: <kebab-case-name>
description: <one-or-two-sentence trigger from step 3>
tags: [<optional, lowercase, kebab>]
---

# <Human-readable Title>

<One paragraph explaining what this skill helps with and when.>

## <Section 1 — typically context / preconditions>

<Concrete bullets the agent can act on.>

## <Section 2 — the procedure>

1. Step one — name the exact tool to use.
2. Step two — point at any co-located files by relative path
   (`scripts/foo.py`, `references/schemas.md`).
3. ...

## Notes / failure modes

<Things that commonly break and how to recognize them.>
```

Concrete > abstract. The agent benefits more from "run `bash` with `npm
run build && npm test`" than from "ensure quality." Always.

Reference co-located files by relative path; the agent will resolve them
against the skill's `baseDir`.

### 5. Write it to disk

Use `omp`'s `write` tool to create both the directory (`write` creates
parents) and the file. Example:

```
write ~/.omp/agent/skills/<dir-name>/SKILL.md
<full content of the skill>
```

If you're also shipping scripts or references, write them now too. Keep
the tree tidy:

```
<dir-name>/
├── SKILL.md                 # required
├── scripts/<name>.py        # optional
├── references/<topic>.md    # optional
└── assets/                  # optional
```

### 6. Verify

Three checks, in this order:

1. **File is on disk.** `bash ls -la ~/.omp/agent/skills/<dir-name>/`
   (or `dir` on Windows). Confirm SKILL.md is present and non-empty.
2. **omp can see it.** If the user is running omp-deck, hit
   `GET http://127.0.0.1:8787/api/skills` and confirm the new skill
   appears with `provider: "native"`. If the user is on bare omp, ask
   them to run `omp` once and check the system prompt loaded it.
3. **The trigger fires when it should.** Suggest the user open a fresh
   session and describe the situation the skill is for. Watch whether
   the agent reaches for the skill (look for `/skill:<name>` in the
   trace, or just the agent saying "I'll use the <name> skill"). If
   it doesn't fire, tune the description.

### 7. Iterate

Skills get better by use. If the description doesn't trigger when it
should, tighten the symptom language; if it triggers when it shouldn't,
narrow the situation. Edit `SKILL.md` directly with the `edit` tool;
`omp` re-reads on the next session start.

## What to avoid

- **`claude -p` references.** This skill is omp-native. If the user's
  workflow really does require shelling out to Claude Code, capture it
  as a project skill in `<repo>/.omp/skills/`, not as a portable user
  skill — and document the dependency in the SKILL.md body.
- **Task-tool subagent names.** `omp` has subagents (`omp agents`) but
  the wire format is different from Claude Code's Task tool. If the
  skill needs subagents, talk to the user about whether they want a
  subagent (separate authoring step) or just guidance the main agent
  follows.
- **Pre-rendering co-located files into SKILL.md.** That defeats
  progressive disclosure. Keep scripts as scripts; reference them by
  path.
- **Trigger phrases inside the SKILL.md body.** Trigger lives in
  frontmatter `description`. The body is the playbook the model
  follows *after* triggering.

## When the user just wants to update an existing skill

Quick path:

1. Read the current `SKILL.md` with the `read` tool.
2. Discuss the change with the user — is it the trigger (description),
   the playbook (body), or both?
3. Use `edit` for surgical changes; `write` only if you're rewriting
   the whole file.
4. Re-run step 6 (verify).

## When the user wants project scope

The active session's `cwd` matters. Write to
`<repo>/.omp/skills/<dir-name>/SKILL.md` instead of the user-level path.
The deck's `/skills` view will show the new skill with `level: "project"`
when it's opened against that cwd.

---

When you're done, summarize for the user:

- Skill name + path
- The exact trigger sentence
- How to invoke it (`/skill:<name>`)
- Any co-located files you shipped, and what they're for
