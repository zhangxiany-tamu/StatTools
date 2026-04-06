# Phase 6: Real-User Validation + Targeted Expansion

## Context

Phases 1-5 built the infrastructure: 8 MCP tools, 93k indexed functions, 647 safety overrides, 100% benchmark on 111 queries, tarball extraction for top 500 packages, usage logging, and Claude Code MCP connection. The biggest remaining risk is product truth: whether agents can actually complete real analysis tasks without falling into stub gaps, unclassified functions, or ranking noise.

## Principle

Do not add more infrastructure. Validate what exists, then expand based on evidence.

## Step 1: Run Real Workflows (20-30 tasks)

Start a fresh Claude Code session. StatTools is already configured in `~/.claude/settings.json` with `STATTOOLS_LOG_USAGE=1`.

Target tasks across domains:

**Regression & Inference (5-6 tasks)**
- OLS regression with robust standard errors (sandwich)
- Logistic regression with marginal effects (marginaleffects)
- Fixed effects panel regression (fixest)
- Polynomial regression with model comparison
- Weighted least squares

**Mixed Models & Longitudinal (3-4 tasks)**
- Random intercept model (lme4)
- Random slope model with crossed effects
- Generalized linear mixed model (binomial)

**Survival Analysis (2-3 tasks)**
- Cox PH model with Kaplan-Meier curve
- Parametric survival with Weibull
- Time-varying covariates

**ML & Classification (3-4 tasks)**
- Random forest with variable importance
- PCA + k-means clustering
- Train/test split with cross-validation (caret)
- sklearn linear regression fit/predict (Python)

**Bayesian (2 tasks)**
- Bayesian regression (rstanarm or brms)
- Posterior summary with credible intervals (bayestestR)

**Time Series (2 tasks)**
- ARIMA forecast
- Seasonal decomposition

**Data Wrangling (2-3 tasks)**
- dplyr pipeline: filter, mutate, group_by, summarize
- tidyr reshape: pivot_wider/longer
- pandas DataFrame manipulation (Python)

**Visualization (2 tasks)**
- ggplot2 scatter + regression line
- Multi-panel diagnostic plot

For each task: use real or simulated data, go through the full search -> resolve -> load -> call -> describe pipeline naturally. Do not shortcut.

## Step 2: Collect and Summarize Logs

After the session:

```bash
cd stattools
npx tsx scripts/summarize-usage.ts
```

This outputs:
- Event counts by type with success/failure rates
- Search -> resolve -> call conversion funnel
- Top failed/empty search queries
- Top stub-triggered queries
- Top blocked (unclassified) function resolves
- Most requested packages

## Step 3: Triage Failures

Bucket every failure into exactly one category:

| Bucket | Description | Fix |
|--------|-------------|-----|
| **Search miss** | Right function exists but wasn't in top 3 | Add curated alias + benchmark query |
| **Stub gap** | Package is a stub, no function-level metadata | Add to next tarball extraction batch |
| **Unclassified** | Function exists and is correct but blocked by fail-closed | Add safety override |
| **Schema gap** | resolve succeeds but call fails due to wrong arg mapping | Fix schema_extractor or add adapter |
| **Runtime bug** | Worker crash, timeout, serialization failure | Fix in engine code |
| **Install issue** | Package not installed, install fails | Document or fix install path |

## Step 4: Fix Top 10 by Impact

For each top-10 failure:
1. If search miss: add to `CURATED_ALIASES` in `searchEngine.ts` + add query to `benchmark.json`
2. If stub gap: add package to the next `extract-tarballs` batch
3. If unclassified: add to `data/safety_overrides.csv` + rebuild index
4. If schema/runtime bug: fix the code
5. If install issue: document workaround

## Step 5: Expand Tarball Extraction (if warranted)

Only scale from 500 to 1000+ if the usage logs show that the next packages are actually being requested. Do not speculatively index.

```bash
npx tsx scripts/extract-tarballs.ts --top 1000
```

Quality gates before scaling:
- Title coverage >= 80% on existing 500
- Zero orphan safety override IDs
- Search benchmark still at 100%
- Real usage data shows demand for the additional packages

## Step 6: Update Benchmark

Add every real search miss to `test/search/benchmark.json` with the correct expected function. This turns real failures into regression tests.

Target: benchmark grows from 111 to 130+ queries, all driven by real usage.

## Exit Criteria

| Metric | Target |
|--------|--------|
| Real workflows completed | 20-30 |
| Usage log events collected | 100+ |
| Failures triaged | All |
| Top 10 failures fixed | Yes |
| Benchmark queries (from real usage) | 130+ |
| Search benchmark pass rate | Still 100% |

## What NOT to Do

- Do not add another language/runtime
- Do not chase "all 23k packages callable"
- Do not build multi-tenant/auth infrastructure
- Do not add more tools before validating existing ones
- Do not expand tarball extraction beyond what usage data justifies

## Success Criterion

Not "more functions indexed." It is: **real agent tasks complete reliably, and the failure backlog is driven by actual usage, not guesses.**
