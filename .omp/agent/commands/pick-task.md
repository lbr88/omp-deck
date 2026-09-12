---
description: Pick the next active task from the omp-deck kanban and start working
argument-hint: [top|t_<id>|<title-fragment>]
---
You are about to start work on an omp-deck task. Discover before you act — do not move tasks around the kanban yourself.

1. **Read state**. `curl -s http://127.0.0.1:8787/api/tasks` returns `{ tasks, states }`. Find the `id` of the state whose `name` matches `"active"` case-insensitively. Filter `tasks` to that state, exclude archived, sort by `orderInState` ascending. The top of the column is the highest priority by user-curated order.

2. **Resolve the argument** (everything after `/pick-task`):
   - Empty or `top` → take the top entry.
   - `t_<id>` → take the matching task (exact id match).
   - Any other string → fuzzy-match against `title` (case-insensitive substring). Multiple matches → list them and stop.
   - Zero active tasks → print `No active tasks. Move one from backlog before invoking /pick-task.` and stop.

3. **Brief and commit**. Print ONE line: `Taking: <title> (t_<id>)`. No other preamble.

4. **Internalize**. Read the task's `body` field — it contains the first action, acceptance criteria, approach, and steps. Treat the `first-action` as your literal next step. Treat the `acceptance-criteria` as the bar for declaring done.

5. **Work**. Default to the task's stated approach unless you have concrete evidence it's wrong. If you find a real reason to deviate, say so once, then proceed. When acceptance criteria are met, `POST /api/tasks/<id>/move` with `{ stateId: "s_done", index: 0 }` to move the task to the Done column before reporting — don't leave it parked in Active.

6. **Stop conditions**:
   - Acceptance criteria met → move the task to `s_done` (step 5), then report what shipped + the task id in one paragraph. If the user disagrees with the move, they revert it.
   - Genuinely blocked → state what's missing in one sentence + the smallest unblock you can identify. Do not yield half-done work as complete.
   - User interrupts → wrap to a safe checkpoint and stop.

Keep step 1–3 under 5 lines of output before you start step 4. The user wants you working, not narrating.
