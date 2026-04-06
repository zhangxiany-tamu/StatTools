# P0 Implementation Backlog

This document turns the `P0` subset from [TOP500_COVERAGE_MATRIX.md](./TOP500_COVERAGE_MATRIX.md) into an execution backlog.

Use it as the next implementation queue for Claude Code or any other coding agent.

## How To Use This Backlog

Work in this order:

1. Land the missing primitives that unblock entire package families.
2. Add or expand safety overrides only for workflows the new primitive unlocks.
3. Add workflow tests immediately after each capability lands.
4. Re-run the real-client workflows from [AGENT_WORKFLOW_RUNBOOK.md](./AGENT_WORKFLOW_RUNBOOK.md).
5. Feed any failures back into [phase6-plan.md](./phase6-plan.md) and [TOP500_COVERAGE_MATRIX.md](./TOP500_COVERAGE_MATRIX.md).

## Status Vocabulary

| Status | Meaning |
|---|---|
| `validated` | Real workflow already works through the current tool surface |
| `partial` | Search/resolve mostly works, but workflows are awkward or incomplete |
| `blocked` | Canonical workflow cannot be completed through the current tool surface |
| `not_started` | No reliable workflow path yet, or not yet validated |

## P0 Backlog

| Workstream | Package(s) | Canonical workflow | Current status | Blocking primitive | Test file to add/update | Safety override action |
|---|---|---|---|---|---|---|
| `primitive` | `stat_plot` foundation | create artifact-producing plot/output path for ggplot/htmlwidget/table results | `validated` | `stat_plot` | `test/workflows/plot-workflows.test.ts` | none |
| `primitive` | `stat_extract` foundation | extract vector, select columns, build matrix/data split, create model matrix | `validated` | `stat_extract` | `test/workflows/ml-workflows.test.ts` | none |
| `visualization` | `ggplot2` | scatter plot `mpg ~ wt`, color by factor, add smooth line, save artifact | `validated` | `stat_plot` | `test/workflows/plot-workflows.test.ts` | already classified |
| `visualization` | `plotly` | interactive scatter/table artifact from tabular data | `blocked` | `stat_plot`, `artifact_export` | `test/workflows/plot-workflows.test.ts` | review core constructor helpers only |
| `visualization` | `DT` | render data frame preview as browsable table artifact | `blocked` | `stat_plot`, `artifact_export` | `test/workflows/plot-workflows.test.ts` | review `DT::datatable` |
| `wrangling` | `dplyr` | filter, mutate, group_by, summarize, arrange on loaded CSV | `partial` | NSE limitation | `test/workflows/ml-workflows.test.ts` | already classified; NSE verbs are callable_with_caveats |
| `wrangling` | `tidyr` | `pivot_wider`, `pivot_longer`, `separate`, `unite` | `validated` | none | `test/workflows/wrangling-workflows.test.ts` | expand from `pivot_wider` to core reshape verbs |
| `wrangling` | `readr`, `readxl`, `haven` | import CSV/XLSX/SPSS and inspect schema | `partial` | `artifact_export` for some outputs | `test/workflows/io-workflows.test.ts` | review common import functions actually exposed by workflows |
| `wrangling` | `stringr`, `lubridate` | text cleanup and date parsing in a dplyr pipeline | `partial` | `stat_extract` | `test/workflows/wrangling-workflows.test.ts` | review `str_*` core verbs and `ymd`, `mdy`, `floor_date`, `month` |
| `model-output` | `broom` | tidy/glance/augment a fitted linear or logistic model | `validated` | none | `test/workflows/model-output-workflows.test.ts` | already classified |
| `inference` | `car`, `lmtest`, `sandwich` | VIF, heteroskedasticity tests, robust covariance on `lm` | `validated` | none | `test/workflows/model-output-workflows.test.ts` | already classified |
| `mixed-models` | `lme4` | random intercept and random slope models with extracted summaries | `validated` | none | `test/workflows/model-output-workflows.test.ts` | lmer + glmer validated |
| `survival` | `survival` | `coxph` fit plus survival summary and prediction objects | `validated` | none | `test/workflows/model-output-workflows.test.ts` | coxph validated on lung dataset |
| `ml-core` | `glmnet` | build `x` matrix and `y` vector, fit `cv.glmnet`, inspect lambda/min coefficients | `validated` | none | `test/workflows/ml-workflows.test.ts` | already classified |
| `ml-core` | `caret`, `recipes`, `rsample` | train/test split, preprocessing recipe, train model, evaluate | `validated` | none | `test/workflows/ml-workflows.test.ts` | createDataPartition + trainControl validated |
| `ml-core` | `randomForest`, `ranger`, `e1071`, `rpart`, `xgboost` | fit classifier/regressor, predict, variable importance | `partial` | `stat_extract` | `test/workflows/ml-workflows.test.ts` | already classified; randomForest tested in r-workflows |
| `multivariate` | `psych`, `lavaan` | factor analysis / SEM fit and structured summary | `not_started` | none | `test/workflows/multivariate-workflows.test.ts` | review one canonical entry point per package |
| `timeseries` | `forecast`, `quantmod` | ARIMA or forecast workflow on a clean univariate series | `not_started` | none | `test/workflows/timeseries-workflows.test.ts` | review `auto.arima`, `forecast`, basic `quantmod` data handling only if local data path is used |
| `database` | `DBI`, `RSQLite` | open SQLite DB, query a table, return a data-frame handle | `not_started` | `db_connect` | `test/workflows/db-workflows.test.ts` | review `dbConnect`, `dbGetQuery`, `dbDisconnect` |
| `spatial` | `sf`, `terra` | read local geospatial file, inspect schema, plot simple artifact | `blocked` | `system_libs`, `stat_plot` | `test/workflows/spatial-workflows.test.ts` | review only after system-lib path is stable |
| `reporting` | `officer`, `rmarkdown` | export a simple report/table artifact from an analysis result | `blocked` | `artifact_export` | `test/workflows/reporting-workflows.test.ts` | defer broad coverage; start with one simple export path |

## Recommended Execution Order

### Wave 1: unblock current real-client failures

1. `stat_extract` foundation
2. `glmnet` workflow
3. `dplyr` core pipeline support
4. `caret`/`recipes`/`rsample` minimal structured ML path

### Wave 2: unblock presentation layer

1. `stat_plot` foundation
2. `ggplot2` canonical scatter/smooth/save workflow
3. `DT` table artifact workflow
4. `plotly` simple interactive artifact workflow

### Wave 3: deepen already-usable stats workflows

1. `broom`
2. `car` / `lmtest` / `sandwich`
3. `survival`
4. `lme4::glmer`

### Wave 4: expand into new high-value domains

1. `psych`
2. `lavaan`
3. `forecast`
4. `DBI` / `RSQLite`

## What Claude Code Should Do Next

If you hand this repo to Claude Code, tell it to use these markdown files in this order:

1. [AGENT_WORKFLOW_RUNBOOK.md](./AGENT_WORKFLOW_RUNBOOK.md)
2. [TOP500_COVERAGE_MATRIX.md](./TOP500_COVERAGE_MATRIX.md)
3. [P0_IMPLEMENTATION_BACKLOG.md](./P0_IMPLEMENTATION_BACKLOG.md)
4. [phase6-plan.md](./phase6-plan.md)

And give it this instruction:

```text
Use the markdown planning docs in this order:
1. AGENT_WORKFLOW_RUNBOOK.md for the real-client validation path and current failures
2. TOP500_COVERAGE_MATRIX.md for package-family prioritization
3. P0_IMPLEMENTATION_BACKLOG.md for the concrete next implementation queue
4. phase6-plan.md for the broader validation loop

Implement the backlog in Wave 1 -> Wave 2 -> Wave 3 order.
For each item:
- make the smallest end-to-end change that unlocks the workflow
- add or update a workflow test immediately
- run the relevant tests
- update the markdown docs if the workflow status changes

Do not broaden scope beyond the current backlog unless the tests or real-client workflow logs show a better priority.
```

## Exit Criteria For This Backlog

This P0 backlog is complete when:

- `ggplot2` has one real artifact-producing workflow
- `glmnet` can fit via extracted `x` and `y`
- `dplyr`/`tidyr` workflows feel natural through the tool surface
- `caret` or `recipes` has one passing end-to-end training workflow
- `broom` / `car` / `lmtest` / `sandwich` have structured post-fit workflows
- the new workflows are covered by dedicated tests
