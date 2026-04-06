// ============================================================================
// StatTools — Search Engine (SQLite FTS5 + Reranking)
// ============================================================================
// Two-phase retrieval:
//   Phase A: BM25 recall from FTS5 (top 50, lower = better)
//   Phase B: Rerank in TypeScript with popularity, safety, installed priors

import Database from "better-sqlite3";
import type { SafetyClass } from "../types.js";

export type SearchResult = {
  functionId: string; // "stats::lm" or "py::sklearn.linear_model::LinearRegression"
  runtime: "r" | "python";
  package: string;
  functionName: string;
  title: string;
  description: string;
  safetyClass: SafetyClass;
  installed: boolean;
  installStatus: string;
  downloadsMonthly: number;
  taskViews: string[];
  hasFormula: boolean;
  hasDots: boolean;
  isStub: boolean; // Package-level stub (no function-level metadata)
  score: number; // Combined score (higher = better)
  bm25Score: number; // Raw BM25 (lower = better)
};

export type SearchOptions = {
  query: string;
  taskView?: string;
  installedOnly?: boolean;
  safeOnly?: boolean;
  minDownloads?: number;
  maxResults?: number;
};

// Phase A query: retrieve top N by BM25
const RECALL_SQL = `
  SELECT
    sd.function_id,
    sd.package,
    sd.name,
    sd.title,
    sd.description,
    bm25(search_docs_fts) AS bm25_score
  FROM search_docs_fts fts
  JOIN search_docs sd ON sd.rowid = fts.rowid
  WHERE search_docs_fts MATCH ?
  ORDER BY bm25(search_docs_fts) ASC
  LIMIT ?
`;

// Metadata join for reranking
const METADATA_SQL = `
  SELECT
    f.id AS function_id,
    f.safety_class,
    f.has_formula_arg,
    f.has_dots,
    f.is_stub,
    COALESCE(p.downloads_monthly, 0) AS downloads_monthly,
    COALESCE(p.installed, 1) AS installed,
    COALESCE(p.install_status, 'installed') AS install_status,
    COALESCE(p.task_views, '[]') AS task_views
  FROM functions f
  LEFT JOIN packages p ON f.package = p.name
  WHERE f.id = ?
`;

export class SearchEngine {
  private db: Database.Database;
  private recallStmt: Database.Statement;
  private metadataStmt: Database.Statement;
  private dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.db = new Database(dbPath, { readonly: true });
    this.db.pragma("journal_mode = WAL");
    this.recallStmt = this.db.prepare(RECALL_SQL);
    this.metadataStmt = this.db.prepare(METADATA_SQL);
  }

  /** Close and reopen the database connection. Call after incremental reindex. */
  refresh(): void {
    this.db.close();
    this.db = new Database(this.dbPath, { readonly: true });
    this.db.pragma("journal_mode = WAL");
    this.recallStmt = this.db.prepare(RECALL_SQL);
    this.metadataStmt = this.db.prepare(METADATA_SQL);
  }

  search(options: SearchOptions): SearchResult[] {
    const {
      query,
      taskView,
      installedOnly = false,
      safeOnly = false,
      minDownloads = 0,
      maxResults = 10,
    } = options;

    // Sanitize query for FTS5 (escape special chars, handle common patterns)
    const ftsQuery = sanitizeFtsQuery(query);
    if (!ftsQuery) return [];

    // Phase A: BM25 recall (fetch 50 candidates)
    const recallLimit = Math.max(50, maxResults * 5);
    let candidates: Array<{
      function_id: string;
      package: string;
      name: string;
      title: string;
      description: string;
      bm25_score: number;
    }>;

    // Staged retrieval: try AND first, fall back to OR for broader recall
    try {
      candidates = this.recallStmt.all(
        ftsQuery,
        recallLimit,
      ) as typeof candidates;
    } catch {
      candidates = [];
    }

    // If AND produced <10 results, try OR for broader recall
    if (candidates.length < 10) {
      const orQuery = query
        .replace(/[^a-zA-Z0-9\s]/g, "")
        .trim()
        .split(/\s+/)
        .filter((w) => w.length > 1)
        .join(" OR ");
      if (orQuery) {
        try {
          const orCandidates = this.recallStmt.all(
            orQuery,
            recallLimit,
          ) as typeof candidates;
          const seenIds = new Set(candidates.map((c) => c.function_id));
          for (const oc of orCandidates) {
            if (!seenIds.has(oc.function_id)) {
              candidates.push(oc);
              seenIds.add(oc.function_id);
            }
          }
        } catch {
          // OR also failed — continue with what we have
        }
      }
    }

    // Also search by function name directly (catches abbreviations like cor, aov, t.test)
    const { all: nameVariants, curated: curatedVariants } = generateNameVariants(query);
    if (nameVariants.length > 0) {
      const nameCandidates = this.searchByName(nameVariants, recallLimit);
      // Merge without duplicates
      const seenIds = new Set(candidates.map((c) => c.function_id));
      for (const nc of nameCandidates) {
        if (!seenIds.has(nc.function_id)) {
          candidates.push(nc);
          seenIds.add(nc.function_id);
        }
      }
    }

    if (candidates.length === 0) return [];

    // Phase B: Enrich with metadata and rerank
    const enriched: SearchResult[] = [];

    for (const c of candidates) {
      const meta = this.metadataStmt.get(c.function_id) as {
        function_id: string;
        safety_class: string;
        has_formula_arg: number;
        has_dots: number;
        is_stub: number;
        downloads_monthly: number;
        installed: number;
        install_status: string;
        task_views: string;
      } | undefined;

      if (!meta) continue;

      const safetyClass = meta.safety_class as SafetyClass;
      const installed = meta.installed === 1;
      const downloadsMonthly = meta.downloads_monthly || 0;

      let taskViews: string[] = [];
      try {
        taskViews = JSON.parse(meta.task_views || "[]");
      } catch {
        taskViews = [];
      }

      // Apply filters
      if (installedOnly && !installed) continue;
      if (safeOnly && safetyClass !== "safe" && safetyClass !== "callable_with_caveats") continue;
      if (downloadsMonthly < minDownloads) continue;
      if (taskView && !taskViews.includes(taskView)) continue;

      // Compute combined score
      const isStub = (meta.is_stub ?? 0) === 1;

      const score = computeScore(
        c.bm25_score,
        downloadsMonthly,
        safetyClass,
        installed,
        taskViews,
        taskView,
        c.name,
        c.package,
        query,
        isStub,
      );

      enriched.push({
        functionId: c.function_id,
        runtime: c.function_id.startsWith("py::") ? "python" as const : "r" as const,
        package: c.package,
        functionName: c.name,
        title: c.title,
        description: c.description,
        safetyClass,
        installed,
        installStatus: meta.install_status,
        downloadsMonthly,
        taskViews,
        hasFormula: meta.has_formula_arg === 1,
        hasDots: meta.has_dots === 1,
        isStub,
        score,
        bm25Score: c.bm25_score,
      });
    }

    // Sort by combined score (higher = better)
    enriched.sort((a, b) => b.score - a.score);

    // Promote name-variant matches from well-known packages only.
    // This prevents false positives like base::norm for "normality test"
    // while ensuring survival::coxph appears for "cox proportional hazards".
    if (nameVariants.length > 0) {
      const nameVariantIds = new Set<string>();
      for (const v of nameVariants) {
        // Only consider generated variants that are ≥4 chars to avoid short
        // false positives (e.g., "norm" for "normality", "mean" for "k means").
        // Curated aliases (e.g., "lm", "glm") bypass the length filter since
        // they are explicitly mapped and known to be correct.
        if (v.length < 4 && !curatedVariants.has(v)) continue;
        const rows = this.db
          .prepare("SELECT sd.function_id, sd.package FROM search_docs sd WHERE sd.name = ?")
          .all(v) as Array<{ function_id: string; package: string }>;
        for (const row of rows) {
          // Only promote if package is well-known AND function is callable
          const fnMeta = this.getFunctionMeta(
            row.package,
            v,
          );
          const isCallable = fnMeta &&
            (fnMeta.safetyClass === "safe" || fnMeta.safetyClass === "callable_with_caveats");
          if (BASE_POPULARITY[row.package] && isCallable) {
            nameVariantIds.add(row.function_id);
          }
        }
      }

      if (nameVariantIds.size > 0) {
        const promoted = enriched
          .filter((r) => nameVariantIds.has(r.functionId))
          .sort((a, b) => b.score - a.score); // Sort promoted by score (popularity wins)
        const rest = enriched.filter((r) => !nameVariantIds.has(r.functionId));
        const seen = new Set<string>();
        const final: SearchResult[] = [];
        for (const r of [...promoted, ...rest]) {
          if (!seen.has(r.functionId)) {
            seen.add(r.functionId);
            final.push(r);
          }
        }
        return final.slice(0, maxResults);
      }
    }

    return enriched.slice(0, maxResults);
  }

  /** Check if a specific function exists in the index. */
  functionExists(packageName: string, functionName: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM functions WHERE id = ?")
      .get(`${packageName}::${functionName}`);
    return row !== undefined;
  }

  /** Get function metadata from the index. */
  getFunctionMeta(
    packageName: string,
    functionName: string,
  ): {
    title: string;
    description: string;
    safetyClass: SafetyClass;
    hasFormula: boolean;
    hasDots: boolean;
    installed: boolean;
    isStub: boolean;
  } | null {
    const row = this.db
      .prepare(
        `SELECT f.title, f.description, f.safety_class, f.has_formula_arg, f.has_dots,
                f.is_stub, COALESCE(p.installed, 1) AS installed
         FROM functions f
         LEFT JOIN packages p ON f.package = p.name
         WHERE f.id = ?`,
      )
      .get(`${packageName}::${functionName}`) as {
      title: string;
      description: string;
      safety_class: string;
      has_formula_arg: number;
      has_dots: number;
      is_stub: number;
      installed: number;
    } | undefined;

    if (!row) return null;

    return {
      title: row.title,
      description: row.description,
      safetyClass: row.safety_class as SafetyClass,
      hasFormula: row.has_formula_arg === 1,
      hasDots: row.has_dots === 1,
      installed: row.installed === 1,
      isStub: (row.is_stub ?? 0) === 1,
    };
  }

  /** Search by function name variants (for abbreviations, dot-separated names). */
  private searchByName(
    nameVariants: string[],
    limit: number,
  ): Array<{
    function_id: string;
    package: string;
    name: string;
    title: string;
    description: string;
    bm25_score: number;
  }> {
    const results: Array<{
      function_id: string;
      package: string;
      name: string;
      title: string;
      description: string;
      bm25_score: number;
    }> = [];

    const stmt = this.db.prepare(
      `SELECT sd.function_id, sd.package, sd.name, sd.title, sd.description
       FROM search_docs sd
       WHERE sd.name = ?
       LIMIT ?`,
    );

    for (const variant of nameVariants) {
      const rows = stmt.all(variant, limit) as Array<{
        function_id: string;
        package: string;
        name: string;
        title: string;
        description: string;
      }>;
      for (const row of rows) {
        results.push({ ...row, bm25_score: -50.0 }); // Very strong synthetic score for exact name matches
      }
    }

    return results;
  }

  close(): void {
    this.db.close();
  }
}

// ---- Scoring ---------------------------------------------------------------

// Well-known base R packages get a popularity boost even without cranlogs data.
// These are the top packages by actual CRAN downloads (approximate monthly).
const BASE_POPULARITY: Record<string, number> = {
  // Base R packages have 0 cranlogs downloads (bundled with R).
  // stats gets a higher floor than MASS/tidyverse so canonical functions
  // (lm, glm, t.test) outrank wrappers when promoted via curated aliases.
  base: 1_500_000, utils: 1_000_000, stats: 3_000_000, methods: 500_000,
  grDevices: 300_000, graphics: 300_000, datasets: 200_000,
  // Tidyverse fallbacks only used if cranlogs fetch failed:
  ggplot2: 2_000_000, dplyr: 2_000_000, tidyr: 1_500_000, purrr: 1_500_000,
  tibble: 3_000_000, readr: 2_000_000, stringr: 2_000_000, forcats: 1_500_000,
  lubridate: 1_500_000, MASS: 2_000_000, Matrix: 2_000_000,
  survival: 1_500_000, lme4: 1_000_000, caret: 800_000, glmnet: 1_000_000,
  randomForest: 500_000, xgboost: 500_000, forecast: 500_000,
  sandwich: 300_000, car: 500_000, lmtest: 400_000, plm: 200_000,
  rstanarm: 200_000, brms: 200_000, nnet: 300_000, rpart: 300_000,
  mgcv: 500_000, nlme: 500_000, boot: 400_000, cluster: 400_000,
  KernSmooth: 300_000,
  // Packages needed for curated alias promotion:
  bayestestR: 200_000, haven: 500_000, quantreg: 300_000,
  fixest: 400_000, e1071: 400_000, class: 300_000, gbm: 200_000,
  broom: 800_000, emmeans: 400_000, psych: 400_000, lavaan: 300_000,
  vegan: 300_000, performance: 300_000, "data.table": 1_500_000,
  scales: 1_000_000, tseries: 300_000, marginaleffects: 200_000,
};

function computeScore(
  bm25: number,
  downloads: number,
  safety: SafetyClass,
  installed: boolean,
  taskViews: string[],
  queryTaskView: string | undefined,
  functionName: string,
  packageName: string,
  query: string,
  isStub: boolean = false,
): number {
  // LIVE SIGNALS: BM25, function name matching, BASE_POPULARITY (hardcoded),
  //   installed, safety_class (from safety_overrides.csv)
  // STUBBED (always 0 in current DB): downloads_monthly, task_views
  // Stubbed signals activate when: cranlogs data fetched, task views wired

  const bm25Normalized = 1 / (1 + Math.abs(bm25));

  let score = bm25Normalized * 3.0; // Base text relevance

  // Popularity prior — uses hardcoded BASE_POPULARITY until cranlogs is wired
  const effectiveDownloads = downloads || BASE_POPULARITY[packageName] || 0;
  if (effectiveDownloads > 0) {
    score += Math.log1p(effectiveDownloads) * 0.3;
  }

  // Callability multiplier. Agents hit stat_resolve after stat_search.
  // Unclassified functions are blocked there, so ranking them high wastes
  // the agent's turn. Instead of a flat bonus (which gets overwhelmed by
  // name-match bonuses), we apply a multiplier AFTER all signals are computed.
  // This is applied at the end of this function — see below.
  // Both safe and callable_with_caveats are callable — same multiplier.
  // The distinction matters at stat_resolve (caveats shown) not at search ranking.
  const callabilityMultiplier =
    (safety === "safe" || safety === "callable_with_caveats") ? 1.5
    : safety === "unsafe" ? 0.1
    : 0.6; // unclassified: 40% penalty

  // Installed bonus
  if (installed) score += 0.3;

  // Task view match
  if (queryTaskView && taskViews.includes(queryTaskView)) {
    score += 1.5;
  }

  // ---- Function name matching (strongest signal) ----
  const queryTerms = query.toLowerCase().replace(/[^a-z0-9._ ]/g, "").split(/\s+/);
  const queryJoined = queryTerms.join("");      // "t test" → "ttest"
  const queryDotted = queryTerms.join(".");     // "t test" → "t.test"
  const queryUnder = queryTerms.join("_");      // "chi squared" → "chi_squared"
  const fnLower = functionName.toLowerCase();
  const fnNoDots = fnLower.replace(/\./g, "");

  // Exact function name match: "lm" query → stats::lm
  if (queryTerms.some((term) => fnLower === term || fnNoDots === term)) {
    score += 10.0;
  }
  // Joined query matches function name: "ttest" → "t.test", "chisqtest" → "chisq.test"
  else if (fnNoDots === queryJoined || fnLower === queryDotted || fnLower === queryUnder) {
    score += 10.0;
  }
  // Function name is abbreviation of query: "aov" from "analysis of variance"
  // Only apply for ≥3 letter abbreviations to avoid false positives (rf, sd, df)
  else if (queryTerms.length >= 3 && fnLower.length >= 3 && isAbbreviation(fnLower, queryTerms)) {
    score += 8.0;
  }
  // Function name contains query term as substring
  else if (queryTerms.some((term) => term.length > 2 && fnLower.includes(term))) {
    score += 2.0;
  }

  // Query contains function name parts: "t test" → t.test
  const fnParts = fnLower.replace(/[._]/g, " ").split(/\s+/);
  if (fnParts.length > 1 && fnParts.every((part) => queryTerms.includes(part))) {
    score += 8.0;
  }

  // Package name matches query term
  const pkgLower = packageName.toLowerCase();
  if (queryTerms.some((term) => pkgLower === term)) {
    score += 3.0;
  }
  // Package name strongly related: "survival" in "survival analysis"
  if (queryTerms.some((term) => term.length > 3 && pkgLower.includes(term))) {
    score += 2.0;
  }

  // Stub penalty: package stubs (no real function data) are discoverable
  // but should rank far below real function entries. With full CRAN descriptions,
  // stubs for niche packages have very high BM25 for generic queries like
  // "linear regression". The 0.1x penalty ensures real functions always win.
  if (isStub) {
    score *= 0.1;
  }

  // Apply callability multiplier last — this ensures callable functions
  // outrank unclassified ones even when both have strong name matches.
  return score * callabilityMultiplier;
}

// ---- FTS5 Query Sanitization -----------------------------------------------

// Curated aliases: maps natural language queries to known R function names.
// These handle cases where the function name is not derivable from the query.
const CURATED_ALIASES: Record<string, string[]> = {
  // ---- Regression & Modeling ----
  "linear regression": ["lm"],
  "logistic regression": ["glm"],
  "generalized linear model": ["glm"],
  "polynomial regression": ["lm", "poly"],
  "ridge regression": ["lm.ridge", "glmnet"],
  "lasso": ["glmnet", "cv.glmnet"],
  "elastic net": ["glmnet", "cv.glmnet"],
  "penalized regression": ["glmnet", "cv.glmnet"],
  "robust regression": ["rlm"],
  "weighted least squares": ["lm"],
  "quantile regression": ["rq"],
  "median regression": ["rq"],
  "poisson regression": ["glm"],
  "negative binomial": ["glm.nb"],
  "ordinal regression": ["polr"],
  "ordinal logistic": ["polr"],
  "multinomial regression": ["multinom"],
  "multinomial logistic": ["multinom"],
  "fixed effects": ["feols", "feglm"],
  "generalized additive model": ["gam"],
  "spline regression": ["gam", "ns", "bs"],

  "probit regression": ["glm"],
  "probit": ["glm"],
  "panel data": ["feols", "plm"],
  "feols": ["feols"],

  // ---- Mixed Models ----
  "mixed effects": ["lmer", "lme", "glmer"],
  "random intercept": ["lmer", "lme"],
  "random slope": ["lmer"],
  "nested random effects": ["lmer"],
  "crossed random effects": ["lmer"],
  "generalized linear mixed": ["glmer"],
  "hierarchical model": ["lmer"],
  "longitudinal": ["lmer", "lme"],

  // ---- Survival ----
  "survival curve": ["survfit"],
  "survival analysis": ["survfit", "Surv", "coxph"],
  "survival object": ["Surv"],
  "event indicator": ["Surv"],
  "kaplan meier": ["survfit"],
  "cox regression": ["coxph"],
  "log rank test": ["survdiff"],
  "parametric survival": ["survreg"],

  // ---- Hypothesis Testing ----
  "normality test": ["shapiro.test", "ks.test"],
  "t test": ["t.test"],
  "chi squared": ["chisq.test"],
  "mann whitney": ["wilcox.test"],
  "wilcoxon test": ["wilcox.test"],
  "wilcoxon signed rank": ["wilcox.test"],
  "anova": ["aov", "anova"],
  "one way anova": ["aov"],
  "fisher exact": ["fisher.test"],
  "proportion test": ["prop.test"],
  "levene test": ["leveneTest"],
  "variance test": ["var.test", "bartlett.test"],
  "kruskal wallis": ["kruskal.test"],

  // ---- Bayesian ----
  "bayesian regression": ["stan_glm", "brm"],
  "bayesian": ["stan_glm", "brm"],
  "posterior distribution": ["describe_posterior"],
  "posterior": ["describe_posterior", "hdi"],
  "credible interval": ["hdi", "ci"],
  "bayesian model": ["brm", "stan_glm"],
  "bayes factor": ["bayesfactor", "bayesfactor_models"],
  "describe posterior": ["describe_posterior"],
  "rope": ["rope", "equivalence_test"],
  "equivalence test": ["equivalence_test", "rope"],
  "hdi": ["hdi"],

  // ---- ML / Classification ----
  "random forest": ["randomForest"],
  "decision tree": ["rpart"],
  "support vector machine": ["svm"],
  "svm": ["svm"],
  "naive bayes": ["naiveBayes"],
  "neural network": ["nnet", "multinom"],
  "gradient boosting": ["gbm", "xgboost"],
  "xgboost": ["xgboost", "gbm"],
  "k nearest neighbors": ["knn"],
  "knn": ["knn"],
  "feature importance": ["importance", "varImpPlot", "varImp"],
  "variable importance": ["varImp", "importance", "varImpPlot"],
  "cross validation": ["trainControl", "train", "cross_val_score", "KFold"],
  "train test split": ["createDataPartition", "train_test_split"],
  "holdout": ["createDataPartition"],

  // ---- Unsupervised ----
  "principal component": ["prcomp", "princomp"],
  "pca": ["prcomp", "princomp"],
  "factor analysis": ["fa", "principal"],
  "cluster analysis": ["kmeans", "hclust", "pam"],
  "k means": ["kmeans"],
  "hierarchical clustering": ["hclust", "cutree"],

  // ---- Data Wrangling ----
  "sort data": ["arrange", "order"],
  "filter rows": ["filter"],
  "group by": ["group_by", "summarise"],
  "pivot wider": ["pivot_wider", "spread"],
  "pivot longer": ["pivot_longer", "gather"],
  "join tables": ["left_join", "inner_join", "merge"],
  "rename columns": ["rename"],
  "distinct values": ["distinct", "unique"],
  "string manipulation": ["str_detect", "str_replace", "str_extract"],

  // ---- Model Output ----
  "tidy model": ["tidy", "glance", "augment"],
  "model summary": ["tidy", "glance", "summary"],
  "marginal means": ["emmeans"],
  "marginal effects": ["marginaleffects", "avg_comparisons"],
  "model diagnostics": ["check_model", "model_performance"],
  "model parameters": ["model_parameters", "standardize_parameters"],
  "effect size": ["cohens_d", "eta_squared", "cramers_v"],
  "robust standard errors": ["vcovHC", "vcovHAC"],
  "heteroskedasticity": ["vcovHC"],

  // ---- Time Series ----
  "arima": ["auto.arima", "arima"],
  "autoregressive": ["auto.arima", "arima"],
  "exponential smoothing": ["ets", "HoltWinters"],
  "holt winters": ["HoltWinters", "ets"],
  "seasonal decomposition": ["stl", "decompose"],
  "autocorrelation": ["acf", "pacf"],
  "acf": ["acf", "pacf"],
  "stationarity test": ["adf.test", "pp.test"],
  "unit root": ["adf.test", "pp.test"],
  "dickey fuller": ["adf.test"],
  "ljung box": ["Box.test"],
  "white noise": ["Box.test"],
  "time series forecast": ["forecast"],

  // ---- Visualization ----
  "scatter plot": ["geom_point", "ggplot"],
  "bar chart": ["geom_bar", "geom_col", "ggplot"],
  "histogram": ["geom_histogram", "hist", "ggplot"],
  "box plot": ["geom_boxplot", "boxplot", "ggplot"],
  "line plot": ["geom_line", "ggplot"],
  "density plot": ["geom_density", "density", "ggplot"],
  "heatmap": ["geom_tile", "heatmap", "ggplot"],

  // ---- I/O ----
  "read csv": ["read.csv", "read_csv", "fread"],
  "read excel": ["read_excel"],
  "read spss": ["read_sav"],
  "spss": ["read_sav"],
  "read stata": ["read_dta"],
  "fast csv": ["fread"],
  "data table": ["fread", "data.table"],

  // ---- Ecology / Psychometrics / SEM ----
  "structural equation": ["sem", "cfa"],
  "confirmatory factor": ["cfa"],
  "reliability analysis": ["alpha"],
  "species diversity": ["diversity", "specnumber"],
  "ordination": ["rda", "cca", "decorana"],

  // ---- Python ----
  "sklearn linear regression": ["LinearRegression"],
  "sklearn random forest": ["RandomForestClassifier", "RandomForestRegressor"],
  "sklearn pca": ["PCA"],
  "sklearn scaler": ["StandardScaler", "MinMaxScaler"],
  "confusion matrix": ["confusion_matrix", "confusionMatrix"],
  "sklearn pipeline": ["Pipeline"],
  "statsmodels ols": ["OLS", "ols"],
  "scipy t test": ["ttest_ind", "ttest_1samp"],
};

/** Generate possible R function names from a natural language query.
 *  Returns { all: string[], curated: Set<string> } where curated variants
 *  are explicitly mapped aliases that should bypass the length filter.
 *
 *  "t test" → ["t.test", "ttest", "t_test"]
 *  "chi squared test" → ["chisq.test", "chi.squared.test", "chi_squared_test"]
 *  "read csv" → ["read.csv", "read_csv", "readcsv"]
 *  "correlation" → ["cor", "correlation"]
 */
function generateNameVariants(query: string): { all: string[]; curated: Set<string> } {
  const terms = query.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).filter(Boolean);
  if (terms.length === 0) return { all: [], curated: new Set<string>() };

  const variants = new Set<string>();

  // Dot-joined: "t test" → "t.test"
  variants.add(terms.join("."));
  // Underscore-joined: "t test" → "t_test"
  variants.add(terms.join("_"));
  // Concatenated: "t test" → "ttest"
  variants.add(terms.join(""));

  // Common R abbreviation patterns
  const abbreviated = terms.map((t) => {
    if (t === "squared") return "sq";
    if (t === "standard") return "std";
    if (t === "deviation") return "dev";
    if (t === "proportional") return "prop";
    if (t === "generalized") return "g";
    if (t === "linear") return "l";
    if (t === "model") return "m";
    if (t === "mixed") return "m";
    if (t === "effects") return "e";
    return t;
  });
  variants.add(abbreviated.join("."));
  variants.add(abbreviated.join(""));
  // Also try partial abbreviation: only abbreviate some words
  if (terms.length >= 2) {
    // First word abbreviated + rest dotted: "logistic regression" → "logistic" (just the word)
    variants.add(terms[0]);
    // "mixed effects" → try known function names
    variants.add(terms.join(""));
  }

  // Single word: try common truncations for R function names
  // "correlation" → "cor", "correlation" → "corr"
  // "forecast" → "fore", "forecast" (exact)
  if (terms.length === 1 && terms[0].length > 3) {
    variants.add(terms[0]); // exact
    variants.add(terms[0].slice(0, 3));
    variants.add(terms[0].slice(0, 4));
    variants.add(terms[0].slice(0, 5));
    variants.add(terms[0].slice(0, 6));
  }
  // Also try each individual term if multi-word
  if (terms.length >= 2) {
    for (const t of terms) {
      if (t.length > 3) {
        variants.add(t);
        variants.add(t.slice(0, 3));
        variants.add(t.slice(0, 4));
      }
    }
  }

  // Two-word: try first word + "." + second word
  if (terms.length === 2) {
    variants.add(terms[0] + "." + terms[1]);
    // Also: second.first for read.csv vs csv.read patterns
  }

  // Three-word: "read csv file" → "read.csv", "read_csv"
  if (terms.length === 3) {
    variants.add(terms[0] + "." + terms[1]);
    variants.add(terms[0] + "_" + terms[1]);
    variants.add(terms[1] + "." + terms[2]);
  }

  // Abbreviation: "analysis of variance" → "aov"
  // Only for 3+ letter abbreviations to avoid false positives
  if (terms.length >= 3) {
    const abbr = terms.map((t) => t[0]).join("");
    if (abbr.length >= 3) variants.add(abbr);
  }

  // Partial abbreviation: first word + initials of rest
  // "cox proportional hazards" → "coxph"
  // "generalized linear model" → "glm"
  if (terms.length >= 2) {
    const firstFull = terms[0];
    const restInitials = terms.slice(1).map((t) => t[0]).join("");
    variants.add(firstFull + restInitials);
    // Also try: first 3 chars + rest initials for long first words
    if (firstFull.length > 3) {
      variants.add(firstFull.slice(0, 3) + restInitials);
    }
  }
  if (terms.length >= 3) {
    // first two words + initials of rest: "cross validated glmnet" → "cv.glmnet"
    variants.add(terms[0] + "." + terms.slice(1).join(""));
  }

  // Curated aliases: check the query against known mappings.
  // Track curated variants separately so they bypass the length filter in promotion.
  const curated = new Set<string>();
  const queryLower = terms.join(" ");
  for (const [pattern, aliases] of Object.entries(CURATED_ALIASES)) {
    if (queryLower.includes(pattern) || pattern.includes(queryLower)) {
      for (const alias of aliases) {
        variants.add(alias);
        curated.add(alias);
      }
    }
  }

  const all = [...variants].filter((v) => v.length >= 2);
  return { all, curated };
}

/** Check if fnName could be an abbreviation of the query terms.
 *  "aov" matches ["analysis","of","variance"] (first letters: a, o, v)
 *  "lm" matches ["linear","model"] (first letters: l, m)
 *  "glm" matches ["generalized","linear","model"]
 */
function isAbbreviation(fnName: string, queryTerms: string[]): boolean {
  if (fnName.length < 2 || fnName.length > queryTerms.length) return false;
  const firstLetters = queryTerms.map((t) => t[0]).join("");
  return firstLetters === fnName || firstLetters.startsWith(fnName);
}

function sanitizeFtsQuery(query: string): string {
  // Remove characters that are special in FTS5
  let clean = query
    .replace(/[":(){}[\]*^~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (clean.length === 0) return "";

  const words = clean.split(" ").filter((w) => w.length > 1);
  if (words.length === 0) {
    // Single char like "t" — match as prefix
    const singleWords = clean.split(" ").filter((w) => w.length > 0);
    return singleWords.map((w) => `"${w}"`).join(" OR ");
  }

  // Use implicit AND (FTS5 default) for precision.
  // FTS5 treats space-separated terms as AND.
  return words.join(" ");
}
