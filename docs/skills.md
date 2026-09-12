# Skills

The `/skills` view is the cockpit's inventory of every skill `omp`
discovers — native skills under `~/.omp/agent/skills/` plus sibling
agent-tool config dirs (Claude Code, Codex, OpenCode, and so on).

## How omp loads skills

`omp` is intentionally polyglot. The SDK's capability system enumerates skills
from multiple providers, each scanning its own conventional location:

| Provider          | User location                                     | Project location                              |
|-------------------|---------------------------------------------------|-----------------------------------------------|
| **`native` (OMP)** | `~/.omp/agent/skills/`                            | `<cwd>/.omp/skills/` (walks up to repo root)  |
| `claude-plugins`  | `~/.omp/plugins/cache/plugins/<plugin>/skills/`   | same                                          |
| `claude`          | `~/.claude/skills/`                               | `<cwd>/.claude/skills/`                       |
| `codex`           | `~/.codex/skills/`                                | `<cwd>/.codex/skills/`                        |
| `opencode`        | `~/.config/opencode/skills/`                      | `<cwd>/.opencode/skills/`                     |
| `cursor`, `windsurf`, `cline`, `gemini`, `agents` | each agent tool's conventional dir         | same                                          |

The deck calls `loadCapability(skillCapability.id, { cwd })` once per request;
that returns the union across every provider, each entry tagged with
`_source: { provider, providerName }` plus `level: "user" | "project"`.

**`native` is omp's own.** If you want to author a skill that's "yours" rather
than borrowed from another agent tool, drop a `SKILL.md` under
`~/.omp/agent/skills/<name>/` (user) or `<project>/.omp/skills/<name>/`
(project). The cockpit shows it immediately.

## What you see

### Left sidebar

- **Source** — filter by provider. `OMP` (native) is highlighted because
  it's the one you author into. Other providers (Claude Plugins, Claude Code,
  Codex, …) are read-only mirrors of those tools' configs.
- **Level** — `user` vs `project`. Project skills are resolved against the
  active session's `cwd`; user skills come from `~/.<provider>/...`.

### Skill list (middle pane)

One row per skill. Rows are sorted **native first**, then by provider
priority, then by name. Each row shows:

- the skill name (frontmatter `name`, falls back to dir name),
- a provider badge (rust accent for `native`, muted for everything else),
- the level (USER / PROJECT),
- the owning plugin name when this skill came from a marketplace install,
- the description (clamped to two lines).

Use the search box at the top of the main pane to filter by name, description,
triggers, or tags.

### Detail pane

- Header: skill name, provider badge, level.
- Sub-line: source — owning plugin id if `claude-plugins`, otherwise
  provider + dir name.
- Description, triggers, tags.
- Rendered `SKILL.md` body (frontmatter stripped), using the chat's Markdown +
  `highlight.js` pipeline.

### Right inspector

Frontmatter as a definition list (name, dir, provider, level, plugin if
present, enabled, model when set, absolute SKILL.md path) followed by the
list of co-located files with sizes. The "Bundled files" header makes the
limit explicit: **co-located files are reachable on demand, not
auto-injected into the agent's context.** SKILL.md's instructions tell the
agent how to reach them with its normal `read` / `bash` tools.

## What actually hits the agent

Out of everything on disk, only two things ever land in the agent's prompt:

1. **At session start**: the skill's `name` + `description` (frontmatter)
   enter the system prompt's `<skills>` listing. That's the agent's
   triggering signal — "this skill exists, and here's roughly what it does."
2. **On invoke** (`/skill:<name>`): omp reads SKILL.md, strips the
   frontmatter, and injects the body as a user message. That's the working
   instructions.

Everything else under the skill directory — `scripts/`, `references/`,
`agents/`, `eval-viewer/`, `assets/`, `LICENSE.txt` — is on-demand. The
agent has to `read` or `bash` it to use it. This is the **progressive
disclosure** model the SKILL.md format is designed around.

## Marketplace skill portability

Skills authored against Claude Code can encode environmental assumptions omp
doesn't satisfy:

- Subprocess calls to `claude -p` (the Claude Code CLI).
- File layout assumptions like `.claude/commands/`.
- `Task(subagent_type="…")`-style named subagent invocation, which expects
  Claude Code's Task tool and a registered subagent of that name.
- Hooks API specifics that differ from omp's hook surface.

If a skill body assumes Claude Code-specific tools, it will fail at runtime
unless that tool is also installed. Author portable skills against the
`native` location (`~/.omp/agent/skills/`).

## Lifecycle

- **Install** a native skill by dropping `SKILL.md` under `~/.omp/agent/skills/<name>/` (or POST `/api/skills/install`).
- **Enable / disable** is **plugin-level** (or `frontmatter.hide: true` for
  individual skills under any provider). The Skills view shows the
  inherited state and the hidden flag, but doesn't expose a finer toggle —
  the SDK doesn't have one.
- **Live updates**: the deck broadcasts a `skills_changed` WebSocket frame
  whenever any watched root mutates. Watched roots:
  `~/.omp/agent/skills/`, `<defaultCwd>/.omp/skills/`,
  `~/.omp/plugins/cache/plugins/`. Missing roots are skipped silently;
  others (`~/.claude/skills/`, etc.) get refreshed manually on next refetch.
- The watcher is debounced 250 ms to coalesce filesystem bursts during
  install.

## Environment

- `OMP_DECK_WATCH_SKILLS=0` disables the disk watcher (useful on filesystems
  that misbehave under recursive `fs.watch` — some VPNs, network drives,
  OneDrive shadowing). The view still works; it just won't auto-refresh
  when changes happen outside the deck's own REST endpoints.

## REST surface

- `GET /api/skills?cwd=<abs>` → `{ skills: SkillSummary[] }`. `cwd`
  defaults to the deck's `defaultCwd`; pass an active session's cwd to
  resolve project-scoped providers correctly.
- `GET /api/skills/:id?cwd=<abs>` → `SkillSummary` + `body` (SKILL.md,
  frontmatter stripped) + `files` (recursive walk, capped at 500 entries
  and depth 6).

`id` is server-issued and opaque to clients (base64url of the absolute
SKILL.md path). Always pass back the value returned in the list.

## Authoring a new omp-native skill

For now, by hand:

```sh
mkdir -p ~/.omp/agent/skills/my-skill
$EDITOR ~/.omp/agent/skills/my-skill/SKILL.md
```

Required frontmatter:

```yaml
---
name: my-skill
description: One line, used both for /skill:my-skill matching and for the
  <skills> listing the agent sees at session start.
---
```

The deck shows it instantly; no restart needed.

A first-class **"New skill" → chat-session-prefilled-with-authoring-prompt**
flow plus a deck-native eval loop targeting native-provider skills lands in
Phase 3 of the [Skills Cockpit proposal](./proposals/skills-cockpit.md).
