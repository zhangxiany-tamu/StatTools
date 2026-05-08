# StatTools — Eval Harness

End-to-end evaluation harness for measuring how much of the indexed StatTools
surface is actually usable by an agent.

## Layout

```
scripts/
├── eval-classified-functions.ts          # Stage 1: stat_resolve every classified non-stub fn
├── eval-classified-functions-call.ts     # Stage 2: stat_call recipes against Stage 1 passes
├── eval-search-quality.ts                # Stage 3: stat_search benchmark vs curated answers
├── eval-stage2/
│   ├── fixtures.ts                       # Per-session fixture library (datasets, vectors, models)
│   └── recipes.ts                        # Exact + pattern recipes per package::function
├── eval-search-quality/
│   └── benchmark.ts                      # Common + long-tail benchmark queries
├── verify-install-state.ts               # Reconciles packages.installed with what Rscript can load
├── reindex-packages.ts                   # Wrapper around src/search/incrementalReindex
└── apply-search-keywords.ts              # Applies data/search_keywords_overrides.csv

data/
├── stattools.db                          # FTS5 index + functions/packages tables
└── search_keywords_overrides.csv         # Semantic synonym keyword expansions per function

reports/                                  # All generated; gitignored
├── classified-functions-resolve.{jsonl,md}
├── classified-functions-call.{jsonl,md}
└── search-quality.{jsonl,md}
```

## Run order (full refresh)

```bash
PYTHON_PATH=/path/to/python3
npm run validate                          # 14/14 should pass
npm run verify-install-state -- --verify-functions   # reconciles installed flags + stale fns
npm run apply-search-keywords             # applies semantic synonyms to FTS5
npm run eval-classified-functions         # Stage 1 (~3-4 min)
npm run eval-classified-functions-call    # Stage 2 (~5-6 min)
npm run eval-search-quality               # Stage 3 (~30 s)
```

## Current numbers

| Track | Result | Target |
|---|---|---|
| Stage 1 (resolve) | 2,008 / 2,021 (99.36%) | "every classified fn resolves" |
| Stage 2 (call) of attempted | 685 / 873 (78.47%) | qualitative |
| Stage 2 (call) of inventory | 685 / 2,021 (33.9%) | grow with more recipes |
| Search common | 86.05% | ≥80% ✓ |
| Search long-tail | 76.67% | ≥60% ✓ |

## Architecture

### Stage 1 — resolve

Loads every `safety_class IN ('safe','callable_with_caveats') AND is_stub=0`
function from the DB, calls `stat_resolve(package, function)` on each, and
records pass/fail with structured error_code (`missing_package`,
`schema_extract_fail`, `unsafe_regression`, `timeout`, etc.). The harness is
the source of truth for "is the index honest"; any failure is a real bug.

### Stage 2 — call

For each function passed by Stage 1 (or the full classified set), look up an
**exact recipe** in `recipes.ts` first, fall back to a **schema-pattern
recipe**, otherwise skip with a structured reason. Pattern recipes are
deliberately conservative — false negatives (skipping) are preferred to
invalid calls (call_fail).

Per-session fixtures (built once via `fixtures.ts` against a fresh
`createStatToolsServer`):

- Built-in datasets: `mtcars`, `iris`, `AirPassengers` (ts), `sleepstudy`
  (lme4), `lung` (survival via the `cancer` dataset name).
- Derived via `stat_extract`: `vec_x` = `mtcars$mpg`, `vec_y` = `mtcars$wt`,
  `factor3` = `iris$Species`, `matrix5x5` = `mtcars[, mpg:wt]` as_matrix.
- Derived via `stat_call`: `char_vec` = `as.character(factor3)`, `cormat5x5`
  = `cor(matrix5x5)` (5×5 square positive semi-definite — used for
  chol/eigen/det/factor analysis fns), `table2x2` = 2×2 contingency-shaped
  numeric matrix (used by `effectsize::Yule*`), `posterior_draws` = 1000×3
  data frame of seeded normals (used by bayestestR descriptive functions).
- Fitted models: `lm_mtcars`, `glm_mtcars` (logistic), `aov_mtcars`.

The harness **recycles the server every 250 calls** to limit accumulated
worker pollution. Per-call timeout default 15 s.

### Stage 3 — search quality

Curated `BenchmarkQuery[]` lists with `accepted: string[]` answer sets. For
each query, run `stat_search`, check if any accepted id appears in top-K.
Reports hit rate + MRR per bucket (common / long_tail).

## Bugs surfaced and fixed during build-out

1. **Python NaN serialization** (`py/bridge.py`): sklearn schemas with
   `np.nan` defaults emitted literal `NaN` JSON tokens; NDJSON parser
   rejected, forcing 20 s timeouts. Fixed at the source (coerce nan/inf to
   None) plus `allow_nan=False` safety net in `send_response`.
2. **R schema extractor missed S3 methods** (`r/bridge.R` `dispatch_schema`):
   functions like `janitor::clean_names.default` weren't found by
   `getExportedValue`. Fixed by falling back to the namespace's
   `.__S3MethodsTable__.` table.
3. **FTS5 query sanitizer didn't strip operator chars**
   (`src/search/searchEngine.ts` `sanitizeFtsQuery`): query
   `"two sample t-test"` was interpreted as `t MINUS test`, excluding
   `stats::t.test` from the recall. Fixed by stripping `-+&|*^~()[]{}":` etc.
4. **Stale `packages.installed` flag**: 333 of 710 R packages flagged
   installed=1 in the DB couldn't actually be loaded by Rscript (build-index
   relied on `installed.packages()` metadata, never re-verified). Fixed by
   `scripts/verify-install-state.ts` (chunked + per-package fallback on
   segfault, since some packages crash R during load — RcppAnnoy, rstan,
   etc.).
5. **Function-level index drift**: 53 stale function rows across 15
   packages (e.g., 8 `effectsize::convert_*` functions removed in 1.0.2,
   12 xgboost callbacks renamed). Phase 2 of the verifier sweeps these,
   correctly preserving S3 method registrations from `.__S3MethodsTable__.`.
6. **Server `PYTHON_PATH` regression** (GPT-fixed in `src/server.ts`): the
   `pythonPath` config field had lost its `process.env.PYTHON_PATH` fallback.
7. **Eval timeout label** (GPT-fixed in `eval-classified-functions.ts`):
   timeout messages said `stat_stat_resolve` due to a double-prefix bug.

## Backlog — what's left for the next iteration

### High-leverage Stage 2 expansion (1,135 still skipped_no_recipe)

Top still-skipped packages, ordered by impact:

| Package | Skipped | Approach |
|---|---:|---|
| psych | 317 | Multi-arg fns (factor analysis with rotation, cluster analysis with `n`, error.bars with `by`). Need bespoke per-function exact recipes. |
| base | 60 | Diverse: higher-order fns (`Reduce`, `do.call`, `mapply`) need a function-fixture (out of scope today). |
| stats | 60 | Mixed generic/model helpers; add exact recipes only where fixture shape is clear. |
| lubridate | 52 | Many duration/interval helpers need date-time fixtures beyond scalar strings. |
| dplyr | 38 | NSE-heavy; exact recipes covered the core verbs. Remaining are utility fns (`pull`, `rename_with`, `n`, `cur_data`). |
| bayestestR | 33 | All structured skips: 21 `needs_bayesian_model_fixture` (rstan blocked on this toolchain), 8 `needs_optional_r_package` (logspline / tweedie not installed), 4 `s3_generic_no_dispatch` (print_html/print_md/reshape_*). |
| forcats | 30 | Factor manipulation; add a `forcats` pattern using `factor3` for `f`-arg fns. |
| readr | 28 | File readers — need per-format temp-file fixtures (CSV, TSV, JSON). |

Effectsize scalar/model recipe expansion is now mostly complete: 161 pass,
0 fail, 9 intentionally skipped (`display`, print helpers, posterior-only
standardization, and other class/reporting helpers).

bayestestR: 92 → 59 call_pass / 0 call_fail / 33 structured-skip. 30 new
exact recipes covering distribution generators, contrasts, simulators, and
BF scalar utilities, anchored on the new `posterior_draws` fixture. Two
quick unblocks for the next iteration: `install.packages("logspline")` →
+7 BF-pair functions; `install.packages("tweedie")` → +1.

Recommended next iteration: tackle `psych` (largest remaining skip count),
or invest in a fitted Bayesian-model fixture if/when rstan is unblocked
(would convert all 21 `needs_bayesian_model_fixture` to call_pass).

### Search quality — common still <100%

9 misses remain. Most are name-collision losses where `base::sample` /
`base::diag` / `correlation::correlation` win on raw token match.
Tractable next steps:

- Add a global "name match score cap" so very common base function names
  can't outrank canonical-promoted answers.
- Extend `CANONICAL_RESULTS` for: "wilcoxon rank sum mann whitney", "model
  fit diagnostics", "join data frames", "correlation pearson spearman".

### Search quality — long-tail unblocks

- Install `topicmodels` (failed: dep `slam` compilation issue on this
  toolchain). Last LDA query miss.
- 2 still-uninstalled packages in CSV: `rdd` (only AER's `RDestimate`
  alternative).

### Toolchain blockers (won't fix without env change)

- **brms + rstanarm**: 13 functions blocked by macOS arm64 + Homebrew R +
  GCC-15 + rstan segfault on `Rcpp::loadModule("class_model_base")`. Tried
  CRAN release, stan-dev/r-universe with StanHeaders 2.36 — both segfault.
  Resolution requires either:
    1. Switch user's R to the official CRAN macOS R distribution.
    2. Port StatTools to `cmdstanr` backend (brms + rstanarm both depend on
       rstan in their Imports:, so a cmdstanr-only env doesn't help —
       upstream change required).
- **rstan in general**: any function that touches rstan modules during load.
- **RcppAnnoy / packages depending on it** (e.g., uwot, text2vec): same
  `Rcpp::loadModule` segfault. Verifier handles these gracefully via
  per-package fallback.

### Schema extractor enhancement (R bridge)

For S3 generics whose `.default` method takes more args than the generic's
formals show (e.g., `e1071::naiveBayes` schema only exposes `x`, but real
call needs `(x, y)`), the schema extractor could try to introspect the
`.default` method's formals when the generic's formals look minimal. Out of
scope for this iteration but would unlock another ~80 ML-trainer functions
that the harness currently skips with reason `ml_trainer_needs_xy_recipe`.

### Generic infrastructure

- **Function fixtures**: a small registry of named R closures (e.g.,
  `f_sum: function(x) sum(x)`) so harness can recipe higher-order fns.
- **DB connection fixture**: open an in-memory `RSQLite::dbConnect`,
  register as `db_conn`. Unblocks DBI/RSQLite (~50 fns).
- **Posterior draws fixture**: a 3×1000 data frame of standard normals
  named `draws`. Most bayestestR fns dispatch on this shape.
- **2×2 contingency table fixture**: unblocks psych Yule family.

## How the next iteration should start

1. `git pull` + `npm install` + `npm run build`.
2. `npm run validate` — confirm 14/14 still pass.
3. `npm run eval-classified-functions` — establish Stage 1 baseline.
4. `npm run eval-classified-functions-call` — establish Stage 2 baseline.
5. Read `reports/classified-functions-call.md` "Top 20 packages by call_fail" + `skipped_no_recipe` reasons.
6. Pick one item from the backlog above, add fixtures + recipes for it, re-run only that package via `--packages=<name>`.
7. Once that batch is stable, run full Stage 2.
