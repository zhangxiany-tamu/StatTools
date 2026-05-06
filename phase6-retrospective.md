# Phase 6 Retrospective

## What Phase 6 Set Out To Do

From [phase6-plan.md](./phase6-plan.md):

> Validate what exists, then expand based on evidence. Real agent tasks complete reliably, and the failure backlog is driven by actual usage, not guesses.

Phase 6 was deliberately a **validation-and-iteration phase**, not a feature-build phase. It assumed Phases 1–5 had built the right infrastructure (8 MCP tools, ~336k indexed functions, ~1.9k classified, 100% top-3 search benchmark) and asked whether that infrastructure actually held up under real workflows.

## What Actually Happened

Four rounds of agent-driven evaluation through Claude Code, each producing a structured failure report that drove a focused fix cycle. The cycle was: real eval → triage → small targeted fixes → re-eval. No new infrastructure unless the evidence demanded it.

| Round | Pass | Partial | Blocked | Weighted | Key driver of progress |
|---|---|---|---|---|---|
| 1 | 19 | 2 | 4 | 80% | Baseline |
| 2 | 18 | 6 | 1 | 84% | Search ranking ML/IO + Python error structure + 178 safety overrides |
| 3 | 21 | 4 | 0 | 92% | NSE escape hatch (`expressions` + `dot_expressions`) + `nse_hint` in `stat_resolve` |
| 4 | **24** | **1** | **0** | **98%** | `dataset` loader + `dot_args` + `coerce` field + `class_hint` in `stat_resolve` |

The single non-pass in Round 4 is `bayestestR::hdi` on `stanreg` objects — an upstream serialization bug that StatTools cannot fix.

## Quantitative Deltas Across Phase 6

| Metric | Phase 5 end | Phase 6 end | Δ |
|---|---|---|---|
| Search benchmark queries | 111 | 113 | +2 (eval-derived: "reshape wide to long pivot", "compare nested models") |
| Search top-1 (installable) | 87% (84/97) | 93% (92/99) | +6 pp |
| Search top-3 (installable) | 100% | 100% | unchanged |
| MRR | 0.926 | 0.963 | +0.037 |
| Safety overrides in CSV | 1,846 | 2,026 | +180 high-confidence safe entries |
| Functions classified callable | ~1.9k | ~2.0k | +180 |
| Hermetic test count | 93 | 121 | +28 (across 5 new test files) |
| MCP tools | 10 | 10 | unchanged (no new tools) |
| Tool surface fields | baseline | +6 fields on existing tools | `dataset`/`package` on load_data; `expressions`/`dot_expressions`/`dot_args`/`coerce` on call; `nse_hint`/`class_hint` on resolve; `python_state`/`recent_stderr` on session |

## Technical Wins That Landed

### 1. Structured-error-discoverability pattern (Round 2 → confirmed Rounds 3+4)

The Python integration had structured errors with `python_state`, `python_path`, `missing_modules`, `recent_stderr`, and `hint` fields surfaced directly in tool responses — no separate `stat_session` round trip required. This pattern proved itself: agents read the structured fields and acted on them. We extended the pattern in Round 3+4 to `nse_hint` and `class_hint` on `stat_resolve`, which became the single largest driver of Round 4's jump to 98%.

The Round 2 README caveat experiment (Round 1 + 2 documented dplyr NSE limitations in the README) confirmed the inverse: README docs do **not** reach the agent loop. The agent in Round 2 tried the dplyr verbs anyway and got blocked. Documentation serves humans; structured response fields serve agents.

### 2. NSE escape hatch (Round 3)

The `expressions` (named NSE args) and `dot_expressions` (unnamed `...` slot) fields on `stat_call` parse R expression strings via `rlang::parse_expr` and wrap them in `rlang::new_quosure` whose env is the function's package namespace. The namespace-as-parent trick is what makes dplyr's data-mask pronouns like `n()` and tidyselect helpers like `everything()` resolve correctly even though packages are loaded via `requireNamespace` (not attached to the search path).

Implementation pivot during Round 3: `do.call(f, args)` was replaced with `eval(rlang::call2(f, !!!args), envir = .ss)` when NSE expressions are present. `do.call` was eagerly evaluating quosures, which broke dplyr's data-mask machinery for `n()` even though it worked for column references.

### 3. `dataset` field on `stat_load_data` (Round 4)

Before: every R task that needed mtcars / iris / lung / sleepstudy / cbpp / Grunfeld / AirPassengers had to materialize the data via Bash + Rscript to a CSV, then load it. ~5–10 wasted tool calls per eval.

After: `stat_load_data({dataset: "mtcars"})` or `stat_load_data({dataset: "sleepstudy", package: "lme4"})` calls `utils::data()` and registers the handle. Round 4 used this 8+ times. Single most user-visible UX fix in Phase 6.

### 4. `dot_args` field for multi-object dispatch (Round 4)

`anova(m1, m2)` and similar `(object, ...)` signatures previously failed because `dot_expressions=["model_id"]` parsed `model_id` as a literal R name (which then didn't resolve as a session handle). The new `dot_args` field is symmetric to `dot_expressions` but applies handle resolution instead of expression parsing.

### 5. `coerce` field + `class_hint` on `stat_resolve` (Round 4)

For functions that dispatch on a specific R class (`randomForest` needs `factor` y for classification; `forecast::auto.arima` and `stats::stl` need `ts`), the agent previously chained two `stat_call` invocations: one to coerce, one to use the result. The new `coerce` field on `stat_call` accepts a whitelisted spec (`factor`, `character`, `numeric`, `integer`, `matrix`, `data.frame`, `ts`, `ts(frequency=N)`) and applies it before the call. The `class_hint` field on `stat_resolve` tells the agent when to use it.

### 6. Search ranking targeted fixes (Rounds 2+3)

Top-1 in ML categories went from 67% → 100%, IO from 75% → 100%, visualization from 86% → 100%. All via narrow `CANONICAL_RESULTS` and `CURATED_ALIASES` entries — never a category-wide prior, since the round-3 attempt to add a broad "model comparison" canonical accidentally regressed the Bayes factor query. Lesson: in retrieval, narrow specificity beats broad coverage every time.

### 7. Formula auto-convert extended (Rounds 3+4)

`fml` (fixest) and `form` (caret) added to the formula-arg name list in `r/bridge.R`. Round 3 confirmed `fml` works (`fixest::feols` passed naturally). Round 4 confirmed the broader fix.

## Design Principles That Validated

1. **Discoverability via response fields beats documentation.** Three eval rounds confirmed agents read tool responses, not READMEs.
2. **Whitelist over arbitrary `eval`.** Both the NSE escape hatch (parses with `rlang::parse_expr` then wraps in quosure — never an unrestricted `eval`) and the `coerce` field (whitelisted spec strings, no template eval) avoid giving agents a generic R-expression backdoor while solving the underlying need.
3. **Per-function annotation maps over schema-side detection.** `NSE_HINTS` and `CLASS_HINTS` are hard-coded `Record<string, T>` maps in `statResolve.ts`. ~15 entries each cover the practical surface. Schema-side auto-detection was considered and deferred — the maps are simpler to maintain and reason about.
4. **Eval → triage → fix → eval loop scales linearly.** Each round took ~1 hour of agent runtime + ~2–4 hours of focused fix work. The bucketed failure schema (`search miss / unclassified / stub gap / schema gap / runtime bug / install issue`) made triage mechanical.
5. **Quick wins compound.** Three rounds of "round N quick wins" (each ~3–6 hours) produced more cumulative value than any single architectural redesign would have.

## What Stayed Open

| Item | Why deferred |
|---|---|
| `bayestestR::hdi(stanreg)` runtime bug | Upstream R-package issue. Workaround documented: use `describe_posterior(ci_method="HDI")`. |
| `lm(weights = "expr")` via NSE | `lm`'s `weights` arg is captured via `model.frame`, not the rlang/dplyr NSE machinery. Structurally hard to bridge cleanly; the `stat_extract` workaround is sound. |
| `randomForest.formula` vs `.default` S3 dispatch ambiguity | When `formula` and `x` are both passed, R silently dispatches to `.default` (matrix mode). Cosmetic; matrix form works. |
| Pandas `DataFrame.agg` kwargs vs positional | Round 2 surfaced this; round 4 agent recovered via `positional_args`. Python-side, not high-priority. |
| ~14.9k stub packages (no function-level metadata) | Phase 7 + 7b extended `tarball_targets_phase7.txt` to 8,500 priority packages. Remaining stubs are lower-demand; phase6-plan says "do not scale unless usage justifies." Usage data does not currently justify. |
| Multi-tenant support | Explicitly excluded by phase6-plan. |
| Bayesian (rstanarm/brms) MCMC slowness | Intrinsic to the algorithm. Documented as `callable_with_caveats`. |

## What Phase 7 Should Consider

**Strategic options, not commitments:**

1. **Depth on Tier A**: harden the ~50 most-used packages with package-specific adapters, formatters, and per-function hints. Highest evidence base; most aligned with current trajectory.
2. **Breadth via auto-classification**: build a signature-based or LLM-assisted triage tool to lift the safety-classified count from ~2k toward ~10k. Largest unlocked surface area; biggest unknown on quality.
3. **New domains** from the original 90-day plan: spatial (`sf`/`terra` — needs system libs), reporting (`officer`/`rmarkdown` — needs artifact_export), database (`DBI`/`RSQLite` — partial coverage exists). Each is its own ~week of work.
4. **Agent-loop ergonomics**: error messages with `did_you_mean` suggestions; auto-retry with coercion when type errors are detected; richer `stat_session` view of recent failures.

The retrospective's main recommendation: **whichever is chosen, keep the eval-driven loop.** The single biggest lesson of Phase 6 is that 4 hours of agent eval + 4 hours of targeted fixes beats 8 hours of speculative implementation every time.

## Reusable Artifacts

For future phases or agents working in this codebase:

- [phase6-plan.md](./phase6-plan.md) — the original plan document. Most exit criteria now met.
- [P0_IMPLEMENTATION_BACKLOG.md](./P0_IMPLEMENTATION_BACKLOG.md) — Wave 1–4 backlog. All Tier-A items now `validated`.
- [TOP500_COVERAGE_MATRIX.md](./TOP500_COVERAGE_MATRIX.md) — package-priority planning across CRAN.
- [AGENT_WORKFLOW_RUNBOOK.md](./AGENT_WORKFLOW_RUNBOOK.md) — real-client validation prompts.
- The eval prompt template (refined across rounds 1–4): see plan files in `~/.claude/plans/` for the latest version.
- `data/usage_log.jsonl` — append-only log of every tool call, ~600 events as of Phase 6 end. Source of truth for usage-driven decisions.
- `scripts/summarize-usage.ts` — log aggregator (event counts, funnel, top failures).

## End State

StatTools at the close of Phase 6:
- 10 MCP tools, ~336k indexed functions, ~2.0k classified callable.
- 121 hermetic tests pass; 6 skipped (Python-env-dependent).
- Search benchmark: 100% top-3, 93% top-1, MRR 0.963 on 99 installable queries.
- Agent eval: 24/25 pass on a representative 25-task workflow set; remaining 1 is upstream.
- The supported-Tier-A surface is reliably callable through the JSON tool interface for dplyr, tidyr, lme4, survival, glmnet, randomForest, caret, forecast, broom, sandwich, car, lmtest, marginaleffects, rstanarm, bayestestR, and the base/stats canonical functions, plus sklearn / pandas / scipy / statsmodels via Python.
