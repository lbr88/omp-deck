# Merge: kaka ↔ cnlimiter

Branch `merge/kaka-cnlimiter` combines two forks of [bjb2/omp-deck](https://github.com/bjb2/omp-deck):

| Remote | Repo | Role in this merge |
|--------|------|--------------------|
| `origin` | lbr88/omp-deck | Target fork / PR destination |
| `kaka` | kaka-sangi/omp-deck | **Ours (HEAD)** — voice, rich editor, focus mode, auto-kanban, worktrees/repo manager, Gholam, storefront, UX redesign, security/build fixes |
| `cnlimiter` | cnlimiter/omp-deck | **Theirs** — multi-machine remote agent hosts (`apps/agent-host`), center-deck orchestration, `OMP_DECK_ACCESS_TOKEN` session login, docker/install scripts, multi-machine docs, i18n |

## Strategy

Keep **both** feature sets where possible:

- UI/UX and security from kaka
- Multi-machine / machines registry / remote sessions / access-token auth from cnlimiter
- Dockerfile stages both `apps/agent-host` and `apps/gholam`
- Root deps keep kaka’s `@oh-my-pi/*@17.2.15` and protocol `0.7.0`; `bun.lock` regenerated with `bun install`
- Task model keeps kaka `energy_tag` / `dispatch_json` **and** cnlimiter `assigned_agent`
- Session model keeps worktree/AI meta **and** `agentId` / `agentName`
- Auth nests kaka password `AuthGate` with cnlimiter access-token gate

## Notable resolutions

- `apps/server/src/bridge/in-process.ts` — cnlimiter thin bridge over shared `session-core` (old inlined handle removed)
- `apps/agent-host/src/bridge/plan-mode-bridge.ts` — took cnlimiter agent-host copy (correct `bridge-context` imports; SDK 17 feature detection)
- Web SessionPicker / Sidebar — preferred kaka `SessionRow` UX (urgency, archive, AI meta)
- OAuthFlowModal — preferred kaka remote-deck paste-code UX
- i18n wired where it did not dismantle kaka UI

## Follow-ups

- Migration id collision: both `005-assigned-agent.sql` (cnlimiter) and `005-auth.sql` (kaka) — verify migrate runner ordering
- Duplicate `010-*.sql` filenames similarly
- Port any kaka-only plan-mode polish into agent-host bridge if SDK 17 gaps appear
- Full typecheck/test suite; i18n coverage for strings still hard-coded from kaka
- Confirm nested AuthGates behave correctly when only one auth mode is enabled
