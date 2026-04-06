# Agent Workflow Runbook

This document shows exactly how to run the same real-client workflows that were used to validate StatTools with Claude Code CLI. Other MCP-capable agents can use the same MCP config and the same prompts.

The goal is not just to test internal tool calls. The goal is to test the real user path:

1. Build StatTools
2. Start it as an MCP server
3. Connect from an external agent
4. Ask for a statistical task in plain English
5. Confirm the agent can complete the workflow

## Scope

Validated successfully through the real Claude Code CLI path:

- OLS regression
- mixed-effects modeling with `lme4::lmer`
- Welch two-sample t-test
- data reshaping with `tidyr::pivot_wider`

Validated as current product limitations:

- `ggplot2` visualization workflows
- `glmnet` model-selection workflows

Those failures are useful. They show where the current tool surface still needs work.

## Prerequisites

- Node 22.x
- R >= 4.1 with `jsonlite`
- built StatTools repo
- search index built with `npm run build-index`
- optional: `npm run extract-tarballs -- --top 500`
- Claude Code CLI installed if you want to reproduce the exact client path below

## 1. Build And Validate

From the repo root:

```bash
nvm use
npm install
npm run build
npm run build-index
npm run validate
```

Optional richer index:

```bash
npm run extract-tarballs -- --top 500
```

## 2. Create An MCP Config For Claude Code

Create a file like `tmp_mcp_config.json` in the repo root:

```json
{
  "mcpServers": {
    "stattools": {
      "command": "/absolute/path/to/.nvm/versions/node/v22.x.x/bin/node",
      "args": ["/absolute/path/to/stattools/dist/index.js"],
      "env": {
        "STATTOOLS_DATA_ROOTS": "/tmp:/absolute/path/to/stattools/test/fixtures/data",
        "STATTOOLS_LOG_USAGE": "1",
        "R_PATH": "/absolute/path/to/Rscript",
        "PATH": "/path/to/R/bin:/path/to/node/bin:/usr/bin:/bin"
      }
    }
  }
}
```

Notes:

- `command` must point to Node 22, not just `node`
- `R_PATH` and `PATH` must let the server find `Rscript`
- `STATTOOLS_LOG_USAGE=1` enables `data/usage_log.jsonl`

## 3. Claude Code CLI Command Pattern

Use strict MCP config and explicitly allow only the StatTools tools:

```bash
claude -p \
  --strict-mcp-config \
  --mcp-config /absolute/path/to/stattools/tmp_mcp_config.json \
  --allowedTools \
  mcp__stattools__stat_search,\
mcp__stattools__stat_resolve,\
mcp__stattools__stat_call,\
mcp__stattools__stat_method,\
mcp__stattools__stat_load_data,\
mcp__stattools__stat_session,\
mcp__stattools__stat_describe,\
mcp__stattools__stat_install \
  --output-format json \
  "YOUR PROMPT HERE"
```

If you are using another agent:

- load the same MCP server
- grant it the StatTools tools
- reuse the prompts below
- ask it to explain which tools it used and what result it obtained

## 4. Fixture Data Used In Validation

StatTools already includes this CSV fixture:

- `test/fixtures/data/mtcars_sample.csv`

Two temporary CSVs were used for the mixed-model and reshape workflows. You can recreate them with:

### Mixed-effects fixture

```bash
python3 - <<'PY'
import csv
import random

random.seed(7)
rows = []
groups = ["A", "B", "C", "D", "E"]
group_effects = {"A": -1.2, "B": -0.2, "C": 0.5, "D": 1.4, "E": 2.0}

for g in groups:
    for i in range(8):
        x = i + 1
        y = 10 + 1.8 * x + group_effects[g] + random.uniform(-0.6, 0.6)
        rows.append({
            "y": round(y, 3),
            "x": x,
            "group": g,
            "subject": f"{g}{i + 1}",
            "time": i + 1,
        })

with open("/tmp/stattools_mixed.csv", "w", newline="") as f:
    writer = csv.DictWriter(f, fieldnames=["y", "x", "group", "subject", "time"])
    writer.writeheader()
    writer.writerows(rows)
PY
```

### Reshape fixture

```bash
python3 - <<'PY'
import csv

rows = [
    {"id": 101, "quarter": "Q1", "sales": 100.0, "cost": 70.0},
    {"id": 101, "quarter": "Q2", "sales": 110.0, "cost": 77.0},
    {"id": 101, "quarter": "Q3", "sales": 95.0, "cost": 66.5},
    {"id": 102, "quarter": "Q1", "sales": 120.0, "cost": 84.0},
    {"id": 102, "quarter": "Q2", "sales": 132.0, "cost": 92.4},
    {"id": 102, "quarter": "Q3", "sales": 114.0, "cost": 79.8},
    {"id": 103, "quarter": "Q1", "sales": 90.0, "cost": 63.0},
    {"id": 103, "quarter": "Q2", "sales": 99.0, "cost": 69.3},
    {"id": 103, "quarter": "Q3", "sales": 85.5, "cost": 59.9},
]

with open("/tmp/stattools_long.csv", "w", newline="") as f:
    writer = csv.DictWriter(f, fieldnames=["id", "quarter", "sales", "cost"])
    writer.writeheader()
    writer.writerows(rows)
PY
```

## 5. Real Workflow Prompts

Each prompt below was run through the real Claude Code CLI path with StatTools loaded as an MCP server.

### A. OLS Regression

```text
Use only the StatTools MCP tools. Load /absolute/path/to/stattools/test/fixtures/data/mtcars_sample.csv, fit an OLS regression of mpg on wt, hp, and cyl using R, and report the coefficients, p-values, and R-squared. Briefly say which tools you used.
```

Expected outcome:

- loads CSV successfully
- resolves `stats::lm`
- calls `lm(formula = "mpg ~ wt + hp + cyl", data = <handle>)`
- returns coefficient table and R-squared

Observed result in validation:

- R-squared `0.8535`
- adjusted R-squared `0.8260`
- `wt` estimate `-3.2515`, p-value `0.0071`

### B. Mixed-Effects Model

```text
Use only the StatTools MCP tools. Load /tmp/stattools_mixed.csv and fit a mixed-effects model y ~ x + (1|group) using lme4 in R. Report the fixed effect for x and the random-intercept variance for group. Briefly say which tools you used.
```

Expected outcome:

- loads CSV successfully
- resolves `lme4::lmer`
- calls `lmer(formula = "y ~ x + (1|group)", data = <handle>)`

Observed result in validation:

- fixed effect for `x`: `1.819`
- random intercept std. dev. about `1.2921`
- random intercept variance about `1.67`

### C. Welch Two-Sample T-Test

```text
Use only the StatTools MCP tools. Load /absolute/path/to/stattools/test/fixtures/data/mtcars_sample.csv and run a Welch two-sample t-test comparing mpg by am. Report the test statistic, p-value, and group means. Briefly say which tools you used.
```

Expected outcome:

- loads CSV successfully
- resolves `stats::t.test`
- calls `t.test(formula = "mpg ~ am", data = <handle>)`

Observed result in validation:

- t statistic `-3.6284`
- p-value `0.0081`
- mean for `am = 0`: `17.22`
- mean for `am = 1`: `26.92`

### D. Data Reshaping

```text
Use only the StatTools MCP tools. Load /tmp/stattools_long.csv and reshape it from long to wide so there is one row per id and separate columns Q1, Q2, and Q3 containing sales. Show the resulting columns and a preview. Briefly say which tools you used.
```

Expected outcome:

- loads CSV successfully
- searches and resolves `tidyr::pivot_wider`
- calls `pivot_wider(names_from = quarter, values_from = sales, id_cols = id)`

Observed result in validation:

- columns: `id, Q1, Q2, Q3`
- preview:
  - `101 100 110 95`
  - `102 120 132 114`
  - `103 90 99 85.5`

### E. ggplot Visualization

```text
Use only the StatTools MCP tools. Load /absolute/path/to/stattools/test/fixtures/data/mtcars_sample.csv and create a ggplot scatter plot of mpg vs wt colored by cyl, with a fitted line. If it fails, explain exactly why the current StatTools tool surface cannot complete the task.
```

Current expected outcome:

- search and resolve may succeed
- the full workflow should fail for real product-surface reasons

Observed failure mode:

- `aes()` cannot be passed as a real quosure through JSON args
- ggplot objects are not JSON-serializable
- there is no `+` layer-composition primitive
- there is no plot artifact/save tool

This is a known limitation, not an agent mistake.

### F. glmnet Model Selection

```text
Use only the StatTools MCP tools. Load /absolute/path/to/stattools/test/fixtures/data/mtcars_sample.csv and try to fit a glmnet model for mpg using wt, hp, and cyl with cross-validation. If the workflow cannot be completed, explain the missing StatTools primitives that block it.
```

Current expected outcome:

- search and resolve may succeed
- the workflow should expose the current preprocessing gap

Observed failure mode:

- no clean way to extract `y` as a standalone vector
- no first-class way to build `x` as a predictor matrix
- formula-style preprocessing for `model.matrix` is not usable enough through the current tool surface

This is also a known limitation.

## 6. How To Judge The Run

Treat these as successful validations:

- the agent uses `stat_load_data`, `stat_search`, `stat_resolve`, `stat_call`, and `stat_session` coherently
- the agent completes OLS, mixed-effects, t-test, and reshape workflows without manual coding
- the agent correctly explains why `ggplot2` and `glmnet` workflows currently fail

Treat these as bugs:

- the agent cannot find `stats::lm`, `lme4::lmer`, `stats::t.test`, or `tidyr::pivot_wider`
- `stat_call` fails on those workflows after successful resolve
- session handles disappear unexpectedly
- usage logging crashes or blocks the workflow

## 7. Collect Usage Logs

After running workflows, summarize the log:

```bash
tsx scripts/summarize-usage.ts
```

Useful signals:

- empty or low-quality searches
- blocked resolves
- repeated install requests
- common package demand
- frequent call failures

## 8. Suggested Prompt For Other Agents

If you want another agent to reproduce the same validation, give it this instruction:

```text
Connect to the StatTools MCP server and validate six workflows:
1. OLS regression on mtcars_sample.csv
2. mixed-effects model on /tmp/stattools_mixed.csv
3. Welch t-test on mtcars_sample.csv
4. long-to-wide reshape on /tmp/stattools_long.csv
5. ggplot scatter plot attempt
6. glmnet model-selection attempt

Use only StatTools MCP tools. For each workflow, report:
- whether it succeeded
- which StatTools tools were used
- the key result or exact failure reason

Do not write raw R or Python scripts unless the workflow is impossible through the current StatTools tool surface and you are explicitly explaining why.
```

## 9. Current Product Gaps Exposed By Real Client Validation

The real Claude Code workflow runs showed two concrete next-step gaps:

- plotting/output artifacts for `ggplot2`
- matrix/vector preprocessing primitives for packages like `glmnet`

Those are better next targets than adding more generic infrastructure.
