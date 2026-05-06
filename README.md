# StatTools

MCP server that lets AI agents discover and call R and Python statistical functions without writing code.

## What It Does

- **Search** ~48k functions on a fresh clone after `build-index`, and ~336k after the full Phase 7 + 7b tarball waves: `"mixed effects model"` finds `lme4::lmer`
- **Validate** before executing: `stat_resolve` checks safety, generates parameter schema
- **Execute** with structured JSON input/output: no R syntax, no script files, no console parsing
- **Track** session state: data handles, model handles, resolved functions
- **Call methods** on Python objects: `model.fit(X, y)`, `model.predict(X_test)`, `scaler.transform(X)`
- **Auto-index** after install: `stat_install` makes new packages immediately searchable

## Architecture

```
Agent (Claude Code / Cursor / custom)
  | MCP protocol (stdio)
  v
TypeScript MCP Server
  |-- SQLite FTS5 search index (~48k fresh-clone baseline, ~336k after the Phase 7 + 7b tarball waves)
  |-- R Worker Pool (persistent subprocess, hot-standby, recycle/crash recovery)
  |-- Python Worker (persistent subprocess, sklearn/statsmodels/scipy/pandas)
  +-- Session state (handles, resolved functions, install jobs)
```

## Quick Start

### Prerequisites

- Node.js 22.x (enforced — see `.nvmrc`)
- R >= 4.1 with `jsonlite` package installed
- Python 3 with sklearn/statsmodels/scipy/pandas (optional — for Python workflows)

### Install & Build

```bash
cd stattools
nvm use          # Use pinned Node 22.x
npm install
npm run build
```

### Build the Search Index

```bash
npm run build-index
```

Indexes all installed R packages + CRAN metadata (~2 minutes).

### Connect to Claude Code

Add to `~/.claude/settings.json`. Use the full path to your Node 22 binary — `better-sqlite3` will crash under a different Node version:

```json
{
  "mcpServers": {
    "stattools": {
      "command": "/path/to/.nvm/versions/node/v22.x.x/bin/node",
      "args": ["/absolute/path/to/stattools/dist/index.js"],
      "env": {
        "STATTOOLS_DATA_ROOTS": "/Users/me/data:/tmp",
        "R_PATH": "/path/to/Rscript",
        "PATH": "/path/to/R/bin:/path/to/node/bin:/usr/bin:/bin"
      }
    }
  }
}
```

Find your Node 22 path with `nvm which 22`. `R_PATH` and `PATH` must include Rscript for the R worker pool to function.

## Tools

| Tool | Purpose |
|------|---------|
| `stat_search` | Search functions by natural language. Returns ranked results with safety class. |
| `stat_resolve` | Validate a function + get full parameter schema. Required before `stat_call`. |
| `stat_call` | Execute a resolved function with JSON arguments. Returns structured results. |
| `stat_method` | Call a method on a Python session object (fit, predict, transform, score). |
| `stat_load_data` | Load CSV/TSV/RDS into session. Supports `runtime="python"` for pandas. |
| `stat_session` | View session state: handles, resolved functions, worker status, install jobs. |
| `stat_describe` | Inspect a handle: schema, head, dimensions, summary, str. |
| `stat_install` | Install a CRAN package (async). Auto-indexes on completion. |

## Example: R Workflow

```
stat_search({ query: "linear regression" })
  -> stats::lm (safe), MASS::lm.ridge (safe), ...

stat_resolve({ package: "stats", function: "lm" })
  -> { resolved: true, safety_class: "safe", schema: { formula, data, ... } }

stat_load_data({ file_path: "/tmp/sales.csv" })
  -> { object_id: "sales", dimensions: { rows: 1000, cols: 8 }, ... }

stat_call({ package: "stats", function: "lm", args: { formula: "revenue ~ ad_spend", data: "sales" } })
  -> { r_squared: 0.73, coefficients: { ad_spend: { estimate: 2.3, p_value: 0.001 }, ... } }
```

## Example: Python Workflow

```
stat_load_data({ file_path: "/tmp/data.csv", runtime: "python", name: "df" })
  -> { object_id: "df", class: "DataFrame", dimensions: { rows: 500, cols: 10 } }

stat_resolve({ package: "sklearn.linear_model", function: "LinearRegression" })
  -> { resolved: true, runtime: "python", schema: { ... } }

stat_call({ package: "sklearn.linear_model", function: "LinearRegression", args: {}, assign_to: "model" })
  -> { objects_created: [{ id: "model", type: "model" }] }

stat_method({ object: "model", method: "fit", positional_args: ["X_train", "y_train"] })
  -> { coefficients: [2.3, -0.5], intercept: 1.2 }

stat_method({ object: "model", method: "predict", positional_args: ["X_test"], assign_to: "preds" })
  -> { class: "ndarray", shape: [100], ... }
```

## Safety Model

Functions are classified into tiers:

| Class | Behavior |
|-------|----------|
| `safe` | Fully callable. Pure computation. |
| `callable_with_caveats` | Callable with warnings (e.g., NSE, graphics, RNG). |
| `unsafe` | Blocked. File writes, network, system modification. |
| `unclassified` | Blocked by default. Discoverable but not callable. |

2,024 safety overrides in CSV (~2,048 classified in the built DB including Python defaults). Unclassified functions are blocked — extend coverage by adding entries to `data/safety_overrides.csv`.

## Search Quality

Benchmark: 111 queries across 12 categories.

**Fresh clone** (after `build-index` only): ~48k functions, ~570 classified. Benchmark pass rate depends on which packages are installed locally and whether tarball extraction has been run. Expect ~90% on a standard R installation.

**Expanded index** (after the full Phase 7 + 7b tarball waves + ranking/callability updates): ~336k functions, ~2.0k classified. 100% top-3 and 93% top-1 on 97/97 installable queries (MRR: 0.962) — tested on a machine with a rich local R library including the easystats suite. ML, IO, visualization, mixed-models, wrangling, and diagnostics categories are at 100% top-1; weaker categories (testing, bayesian) sit at 83%.

The headline 100% number requires both a rich local R library and tarball extraction. Your mileage will vary based on which packages are installed.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `STATTOOLS_DATA_ROOTS` | Current directory | Colon-separated list of allowed data directories |
| `R_PATH` | `Rscript` | Path to Rscript binary |

## Setup Validation

After build + index, verify everything works:

```bash
npm run validate     # Checks Node, R, build, index, server, and runs a real workflow
```

This runs 14 checks including safety-override integrity, starting the MCP server, inspecting Python runtime health, and executing a complete search → resolve → load → call → session workflow.

For real external-client validation through Claude Code CLI, including exact prompts for OLS, mixed-effects, reshape, `ggplot2`, and `glmnet`, see [AGENT_WORKFLOW_RUNBOOK.md](./AGENT_WORKFLOW_RUNBOOK.md).

## Development

```bash
nvm use              # Enforce Node 22.x
npm test             # Run the hermetic default test suite
npm run test:tarball-live  # Optional live CRAN tarball smoke test
npm run test:benchmark     # Run the heavy 111-query benchmark separately
npm run test:watch   # Watch mode
npm run build        # Compile TypeScript
npm run build-index  # Rebuild search index
npm run apply-safety-overrides  # Sync safety_overrides.csv into the current DB
npm run check-safety-overrides  # Fail if safety_overrides.csv has orphan or duplicate IDs
npm run validate     # Full setup validation
```

## Status: Beta for Tier A workflows (v0.2.0)

Phase 6 closed with a four-round agent eval going from 80% → 84% → 92% → **98% weighted pass rate** on a 25-task representative workflow set. The single remaining non-pass is an upstream R-package bug. See [phase6-retrospective.md](./phase6-retrospective.md) for the full story.

**What works reliably:**
- Search: ~90% top-3 on a fresh clone. On the fully expanded Phase 7 + 7b index, the benchmark is 100% top-3 and 93% top-1 on 99 installable queries (MRR 0.963).
- Core R workflows: OLS, logistic, t-test, ANOVA, correlation, random forest, PCA, k-means, mixed effects (lme4 random intercept/slope/GLMM), survival (Kaplan-Meier, Cox PH, Weibull), robust SE, broom tidy, VIF, stepwise selection, time series (auto.arima, STL, forecast), Bayesian regression (rstanarm), polynomial regression with model comparison, fixest panel regression — all validated end-to-end through agent evals.
- Data loading: CSV/TSV/RDS via `file_path`, **built-in R datasets via `dataset` (mtcars, iris, sleepstudy, lung, cbpp, Grunfeld, AirPassengers, ...)**, pandas DataFrame via `runtime="python"`. Handles register identically.
- NSE-heavy verbs (dplyr, tidyr, ggplot2::aes): `stat_call`'s `expressions` and `dot_expressions` fields take R expression strings, parsed via `rlang::parse_expr` and forwarded as quosures. dplyr data-mask pronouns like `n()` and tidyselect helpers like `everything()` / `-Species` resolve correctly. `stat_resolve` returns an `nse_hint` field for ~15 known NSE functions with worked examples.
- Multi-object dispatch (`anova(m1, m2)`, `AIC(m1, m2)`): `stat_call`'s `dot_args` field resolves session handle IDs as positional `...` args.
- Class coercion (factor/ts/matrix): `stat_call`'s `coerce` field accepts whitelisted specs (`factor`, `ts(frequency=N)`, etc.) and applies them before the call. `stat_resolve`'s `class_hint` field tells you when to use it.
- Python workflows: structured errors with `python_state` (`spawn_failed` / `modules_missing` / `crashed` / `healthy`), `python_path`, `missing_modules`, `recent_stderr`, and `hint` — no separate `stat_session` round trip required.
- Verbose R functions: console output is captured/suppressed so it does not pollute the NDJSON channel.
- Handle system: models and data persist in session across calls.
- Install + auto-reindex: `stat_install` installs and makes packages immediately searchable.
- Worker stability: hot-standby pool, crash recovery, handle persistence across recycles.

**What works with caveats:**
- Python install path: the server uses whatever `python3` / `PYTHON_PATH` resolves to at startup. If you `pip install` into a different interpreter, the server won't see the modules. Install into the binary `stat_session` reports under `python.path`, or set `PYTHON_PATH` explicitly.
- Bayesian: rstanarm/brms are slow (MCMC compilation) and classified as `callable_with_caveats`. `bayestestR::hdi(stanreg_model)` currently throws a names-length error on rstanarm fits (upstream bug) — use `bayestestR::describe_posterior(model, ci_method="HDI")` instead.
- `lm(weights = ...)`: the `weights` arg is captured via `model.frame`, not the rlang/dplyr NSE machinery. `expressions={"weights": "1/hp"}` is rejected. Workaround: extract the column with `stat_extract` and pass the resulting numeric vector handle.
- S3 dispatch on first positional arg (`randomForest`, `survival::Surv`, etc.): when both `formula` and `x` are passed, R silently falls through to `.default` (matrix mode). Workaround: use matrix form (`x=`, `y=`) with `coerce={y:"factor"}` for classification, or pass the formula as the first positional arg.

**What doesn't work yet:**
- Only ~2.0k of ~336k functions are classified as callable. The rest are discoverable but blocked by the fail-closed safety model. Extend coverage by adding entries to `data/safety_overrides.csv`.
- ~14.9k packages are still stubs (no function-level metadata). `data/tarball_targets_phase7.txt` covers 8,500 priority packages.
- Tarball expansion is network-bound and incremental. `npm test` is hermetic; `npm run test:tarball-live` requires live CRAN access.
- Top-1 search accuracy is 93%; weakest in `testing` and `bayesian` categories at 83%. Top-3 remains 100%.
- No multi-tenant support — single-user local server only.

**Known environment requirements:**
- Node 22.x (enforced; better-sqlite3 will crash on other versions)
- R >= 4.1 with jsonlite
- macOS or Linux (not tested on Windows)
- For Python workflows: python3 with sklearn, scipy, statsmodels, pandas

## Tier A Packages

Deeply classified packages with safety overrides, curated aliases, and workflow tests:

**Core Stats:** stats, base, utils, MASS, boot, cluster
**Tidyverse:** dplyr, tidyr, ggplot2, readr, purrr, stringr, forcats, tibble, scales
**Modeling:** lme4, nlme, mgcv, glmnet, survival, sandwich, car, lmtest, forecast
**ML:** caret, randomForest, rpart, nnet, e1071
**Model Output:** broom, emmeans, marginaleffects, performance, parameters, effectsize
**Bayesian:** rstanarm, brms, bayestestR
**Specialized:** psych, lavaan, vegan, datawizard, insight, haven, data.table, fixest
**Python:** sklearn (linear_model, ensemble, tree, svm, neighbors, cluster, decomposition, preprocessing, metrics, model_selection), statsmodels, scipy.stats, pandas
