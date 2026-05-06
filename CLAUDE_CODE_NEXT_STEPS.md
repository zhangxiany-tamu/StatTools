# Claude Code Next Steps

This file is the shortest version of what Claude Code should do next in this repo.

## Current State (post-Phase 6, v0.2.0)

Phase 6 is closed. See [phase6-retrospective.md](./phase6-retrospective.md) for the full story (4-round eval arc, 80% → 98% pass rate, what landed and what stayed open). The supported Tier-A surface is in beta; the broader ecosystem remains alpha.

## Read These Files In Order

1. [phase6-retrospective.md](./phase6-retrospective.md) — what was learned
2. [phase6-plan.md](./phase6-plan.md) — the validation loop methodology
3. [AGENT_WORKFLOW_RUNBOOK.md](./AGENT_WORKFLOW_RUNBOOK.md) — real-client validation prompts
4. [TOP500_COVERAGE_MATRIX.md](./TOP500_COVERAGE_MATRIX.md) — package-priority planning
5. [P0_IMPLEMENTATION_BACKLOG.md](./P0_IMPLEMENTATION_BACKLOG.md) — Wave 1–4 backlog (now `validated` for Tier A)

## Phase 7 Strategic Options (not yet committed)

The retrospective lays these out:
1. **Depth on Tier A** — package-specific adapters and per-function hints for the ~50 most-used packages.
2. **Breadth via auto-classification** — signature/LLM-assisted triage to lift safety-classified count from ~2k toward ~10k.
3. **New domains** — spatial (`sf`/`terra`), reporting (`officer`/`rmarkdown`), database (`DBI`/`RSQLite`).
4. **Agent-loop ergonomics** — `did_you_mean` suggestions, auto-retry with coercion, richer `stat_session` failure history.

Whichever is chosen, **keep the eval-driven loop**: real eval → triage → focused fix → re-eval. The single biggest lesson of Phase 6 is that this beats speculative implementation every time.

## Required Working Style

- Prefer the smallest end-to-end change that unlocks a real workflow.
- Add workflow tests immediately after implementation.
- Re-run a real-client workflow eval when a major blocker is removed.
- Update the markdown docs when status changes.
- Surface new affordances via response fields (the `nse_hint` / `class_hint` / structured-error pattern), not just README docs — Phase 6 confirmed README caveats don't reach the agent loop.

## Done Means

- The canonical workflow works through the actual tool surface.
- The workflow has a dedicated automated test.
- The relevant docs reflect the new state.
- A real-client eval round confirms agents discover the new affordance via tool/resolve responses, not the prompt.
