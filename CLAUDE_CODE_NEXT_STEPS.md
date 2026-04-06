# Claude Code Next Steps

This file is the shortest version of what Claude Code should do next in this repo.

## Read These Files In Order

1. [AGENT_WORKFLOW_RUNBOOK.md](./AGENT_WORKFLOW_RUNBOOK.md)
2. [TOP500_COVERAGE_MATRIX.md](./TOP500_COVERAGE_MATRIX.md)
3. [P0_IMPLEMENTATION_BACKLOG.md](./P0_IMPLEMENTATION_BACKLOG.md)
4. [phase6-plan.md](./phase6-plan.md)

## Current Goal

Turn the current StatTools alpha into a stronger real-workflow product by implementing the `P0` backlog.

## Immediate Priorities

1. Add `stat_extract`
2. Make the `glmnet` workflow work
3. Improve `dplyr`/`tidyr` workflow ergonomics
4. Add `stat_plot`
5. Make the `ggplot2` workflow produce a real artifact

## Required Working Style

- prefer the smallest end-to-end change that unlocks a real workflow
- add workflow tests immediately after implementation
- re-run the real-client workflow when a major blocker is removed
- update the markdown docs when status changes
- do not broaden into `P1` or `P2` work unless `P0` is stable or logs justify reprioritization

## Done Means

- the canonical workflow in the backlog works through the actual tool surface
- the workflow has a dedicated automated test
- the relevant docs reflect the new state
