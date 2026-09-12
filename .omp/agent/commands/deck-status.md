---
description: Test project-local slash command — report task/inbox/routine counts for omp-deck itself
---
You are running in the omp-deck workspace. Hit:

1. `curl -s http://127.0.0.1:8787/api/tasks` — report counts per state.
2. `curl -s http://127.0.0.1:8787/api/inbox?includeProcessed=0` — count unprocessed by kind.
3. `curl -s http://127.0.0.1:8787/api/routines` — report enabled count.

End with: "All systems nominal." or the first problem you spot.
