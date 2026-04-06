# StatTools

MCP server that lets AI agents discover and call R and Python statistical functions without writing code.

## What It Does

- **Search** 67k+ functions out of the box, ~94k after tarball extraction: `"mixed effects model"` finds `lme4::lmer`
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
  |-- SQLite FTS5 search index (67k+ base, ~94k after tarball extraction)
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

647 safety overrides in CSV (~670 classified in the built DB including Python defaults). Unclassified functions are blocked — extend coverage by adding entries to `data/safety_overrides.csv`.

## Search Quality

Benchmark: 111 queries across 12 categories.

**Fresh clone** (after `build-index` only): ~48k functions, ~570 classified. Benchmark pass rate depends on which packages are installed locally and whether tarball extraction has been run. Expect ~90% on a standard R installation.

**Expanded index** (after `extract-tarballs --top 500`): ~94k functions, ~670 classified. 100% top-3 on 97/97 installable queries (MRR: 0.746) — tested on a machine with 708 installed R packages including rstanarm, brms, bayestestR, and the full easystats suite.

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

This runs 12 checks including starting the MCP server and executing a complete search → resolve → load → call → session workflow.

## Development

```bash
nvm use              # Enforce Node 22.x
npm test             # Run the full test suite
npm run test:watch   # Watch mode
npm run build        # Compile TypeScript
npm run build-index  # Rebuild search index
npm run validate     # Full setup validation
```

## Alpha Status: What Works / What Doesn't

**What works reliably:**
- Search: reaches 100% top-3 on 97 benchmark queries with an expanded index; fresh-clone performance is ~90% and depends on which R packages are installed locally
- Core R workflows: OLS, logistic, t-test, ANOVA, correlation, random forest, PCA, k-means, mixed effects, robust SE, broom tidy, VIF, stepwise selection — all validated end-to-end
- Data loading: CSV/TSV/RDS into R session with column schema and preview
- Handle system: models and data persist in session across multiple tool calls
- Install + auto-reindex: `stat_install` installs packages and makes them immediately searchable
- Worker stability: hot-standby pool, crash recovery, handle persistence across recycles

**What works with caveats:**
- Python workflows: `stat_method` (fit/predict/transform) works but requires sklearn/scipy/statsmodels/pandas installed on the host Python. Tests are skipped when unavailable.
- Python data loading: `stat_load_data(runtime="python")` routes to pandas but requires the Python worker to start successfully.
- Bayesian: rstanarm/brms workflows are searchable but slow (MCMC compilation) and classified as `callable_with_caveats`.
- R functions that print to stdout (like `step()`) produce NDJSON parse warnings in stderr but still return valid results.

**What doesn't work yet:**
- Only ~650 of 93k functions are classified as callable. The rest are discoverable but blocked by the fail-closed safety model. Extend coverage by adding entries to `data/safety_overrides.csv`.
- ~22k packages are still stubs (no function-level metadata). Run `npm run extract-tarballs -- --top 1000` to extract more.
- The tarball extraction test (`tarballExtraction.test.ts`) requires network access to CRAN. `npm test` is not fully hermetic.
- Top-1 search accuracy is 54% (agents sometimes need to scan 2-3 results).
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
