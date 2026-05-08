// ============================================================================
// StatTools — Stage 2 Recipes
// ============================================================================
// Maps "package::function" → a stat_call invocation that exercises the
// function with safe inputs. Two layers:
//
//   1. Exact recipes (highest confidence) — explicit per-function args for the
//      most-valuable Tier A families: stats, broom, forecast, survival, dplyr,
//      tidyr, plus a small set of sklearn constructors.
//
//   2. Schema-pattern recipes (broader, lower confidence) — match schema
//      argument names against patterns and substitute fixtures: formula+data,
//      x numeric, x+y numeric, model object. Conservative: skip rather than
//      guess. False negatives > invalid calls.
//
// The Stage 2 harness consults exact recipes first, falls back to pattern
// recipes, and skips with a structured reason if neither matches.
// ============================================================================

import type { FixtureLibrary } from "./fixtures.js";

// ----------------------------------------------------------------------------
// Recipe shape
// ----------------------------------------------------------------------------

export type CallArgs = {
  args?: Record<string, unknown>;
  expressions?: Record<string, string>;
  dot_expressions?: string[];
  dot_args?: string[];
  coerce?: Record<string, string>;
};

export type Recipe = CallArgs & {
  /** name of the recipe selected for this function (exact key or pattern id) */
  recipe: string;
};

// Schema as returned by stat_resolve (loosely typed — only the fields we use)
export type ResolvedSchema = {
  type?: string;
  properties?: Record<string, { type?: string; description?: string }>;
  required?: string[];
};

// ----------------------------------------------------------------------------
// Exact recipes (Tier A)
// ----------------------------------------------------------------------------

function exactRecipes(fx: FixtureLibrary): Map<string, Recipe> {
  const r = new Map<string, Recipe>();

  // ---- stats (R) ----
  r.set("stats::lm", { recipe: "lm_formula_data_mtcars",
    args: { formula: "mpg ~ wt + hp", data: fx.dataFrames.mtcars } });
  r.set("stats::glm", { recipe: "glm_formula_data_binomial",
    args: { formula: "I(am == 1) ~ mpg + wt", data: fx.dataFrames.mtcars, family: "binomial" } });
  r.set("stats::t.test", { recipe: "t.test_xy",
    args: { x: fx.vectors.x, y: fx.vectors.y } });
  r.set("stats::cor", { recipe: "cor_xy",
    args: { x: fx.vectors.x, y: fx.vectors.y } });
  r.set("stats::cor.test", { recipe: "cor.test_xy",
    args: { x: fx.vectors.x, y: fx.vectors.y } });
  r.set("stats::var", { recipe: "var_x",
    args: { x: fx.vectors.x } });
  r.set("stats::sd", { recipe: "sd_x",
    args: { x: fx.vectors.x } });
  r.set("stats::mean.default", { recipe: "mean_x",
    args: { x: fx.vectors.x } });
  r.set("stats::median.default", { recipe: "median_x",
    args: { x: fx.vectors.x } });
  r.set("stats::quantile.default", { recipe: "quantile_x",
    args: { x: fx.vectors.x } });
  r.set("stats::aov", { recipe: "aov_formula_data",
    args: { formula: "mpg ~ factor(cyl)", data: fx.dataFrames.mtcars } });
  r.set("stats::anova", { recipe: "anova_lm",
    args: { object: fx.models.lm_mtcars } });
  r.set("stats::prcomp", { recipe: "prcomp_matrix",
    args: { x: fx.matrices.m5x5, center: true, "scale.": false } });
  r.set("stats::kmeans", { recipe: "kmeans_matrix_2",
    args: { x: fx.matrices.m5x5, centers: 2 } });
  r.set("stats::stl", { recipe: "stl_airpass",
    args: { x: fx.timeSeries.AirPassengers, "s.window": "periodic" } });
  r.set("stats::ts", { recipe: "ts_vec",
    args: { data: fx.vectors.x, frequency: 1 } });
  r.set("stats::Box.test", { recipe: "Box.test_airpass",
    args: { x: fx.timeSeries.AirPassengers, lag: 12, type: "Ljung-Box" } });
  r.set("stats::shapiro.test", { recipe: "shapiro_x",
    args: { x: fx.vectors.x } });
  r.set("stats::ks.test", { recipe: "ks.test_x_norm",
    args: { x: fx.vectors.x, y: "pnorm" } });
  r.set("stats::wilcox.test", { recipe: "wilcox_xy",
    args: { x: fx.vectors.x, y: fx.vectors.y } });
  r.set("stats::chisq.test", { recipe: "chisq_xtab",
    expressions: { x: "table(datasets::mtcars$cyl, datasets::mtcars$gear)" } });
  r.set("stats::fisher.test", { recipe: "fisher_xtab",
    expressions: { x: "table(datasets::mtcars$cyl, datasets::mtcars$am)" } });
  r.set("stats::summary.lm", { recipe: "summary_lm",
    args: { object: fx.models.lm_mtcars } });
  r.set("stats::confint", { recipe: "confint_lm",
    args: { object: fx.models.lm_mtcars } });
  r.set("stats::predict.lm", { recipe: "predict_lm",
    args: { object: fx.models.lm_mtcars } });
  r.set("stats::residuals", { recipe: "residuals_lm",
    args: { object: fx.models.lm_mtcars } });
  r.set("stats::fitted", { recipe: "fitted_lm",
    args: { object: fx.models.lm_mtcars } });
  r.set("stats::coef", { recipe: "coef_lm",
    args: { object: fx.models.lm_mtcars } });
  r.set("stats::AIC", { recipe: "AIC_lm",
    args: { object: fx.models.lm_mtcars } });
  r.set("stats::BIC", { recipe: "BIC_lm",
    args: { object: fx.models.lm_mtcars } });
  r.set("stats::logLik", { recipe: "logLik_lm",
    args: { object: fx.models.lm_mtcars } });

  // ---- broom (R) ----
  r.set("broom::tidy", { recipe: "tidy_lm",
    args: { x: fx.models.lm_mtcars } });
  r.set("broom::glance", { recipe: "glance_lm",
    args: { x: fx.models.lm_mtcars } });
  r.set("broom::augment", { recipe: "augment_lm",
    args: { x: fx.models.lm_mtcars } });

  // ---- forecast (R) — many require ts class with explicit frequency ----
  r.set("forecast::auto.arima", { recipe: "auto.arima_airpass",
    args: { y: fx.timeSeries.AirPassengers }, coerce: { y: "ts(frequency=12)" } });
  r.set("forecast::Arima", { recipe: "Arima_airpass",
    args: { y: fx.timeSeries.AirPassengers, order: [1, 0, 0] }, coerce: { y: "ts(frequency=12)" } });
  r.set("forecast::ets", { recipe: "ets_airpass",
    args: { y: fx.timeSeries.AirPassengers }, coerce: { y: "ts(frequency=12)" } });

  // ---- survival (R) ----
  r.set("survival::Surv", { recipe: "Surv_lung",
    expressions: { time: "lung$time", event: "lung$status" } });
  r.set("survival::coxph", { recipe: "coxph_lung",
    args: { formula: "survival::Surv(time, status) ~ age + sex", data: fx.dataFrames.lung } });
  r.set("survival::survfit", { recipe: "survfit_lung",
    args: { formula: "survival::Surv(time, status) ~ sex", data: fx.dataFrames.lung } });

  // ---- dplyr (R, NSE-heavy) — recipes use NSE slots per stat_resolve hints ----
  r.set("dplyr::filter", { recipe: "dplyr_filter_mtcars",
    args: { ".data": fx.dataFrames.mtcars }, dot_expressions: ["cyl > 4", "mpg > 20"] });
  r.set("dplyr::mutate", { recipe: "dplyr_mutate_mtcars",
    args: { ".data": fx.dataFrames.mtcars }, expressions: { mpg_kpl: "mpg * 0.425" } });
  r.set("dplyr::summarise", { recipe: "dplyr_summarise_mtcars",
    args: { ".data": fx.dataFrames.mtcars }, expressions: { mean_mpg: "mean(mpg)", n: "dplyr::n()" } });
  r.set("dplyr::summarize", { recipe: "dplyr_summarize_mtcars",
    args: { ".data": fx.dataFrames.mtcars }, expressions: { mean_mpg: "mean(mpg)", n: "dplyr::n()" } });
  r.set("dplyr::group_by", { recipe: "dplyr_group_by_mtcars",
    args: { ".data": fx.dataFrames.mtcars }, dot_expressions: ["cyl"] });
  r.set("dplyr::arrange", { recipe: "dplyr_arrange_mtcars",
    args: { ".data": fx.dataFrames.mtcars }, dot_expressions: ["dplyr::desc(mpg)"] });
  r.set("dplyr::select", { recipe: "dplyr_select_mtcars",
    args: { ".data": fx.dataFrames.mtcars }, dot_expressions: ["mpg", "cyl", "wt"] });
  r.set("dplyr::count", { recipe: "dplyr_count_mtcars",
    args: { ".data": fx.dataFrames.mtcars }, dot_expressions: ["cyl"] });
  r.set("dplyr::distinct", { recipe: "dplyr_distinct_mtcars",
    args: { ".data": fx.dataFrames.mtcars }, dot_expressions: ["cyl"] });

  // ---- tidyr (R) ----
  r.set("tidyr::pivot_longer", { recipe: "pivot_longer_iris",
    args: { data: fx.dataFrames.iris }, expressions: { cols: "-Species" } });
  r.set("tidyr::pivot_wider", { recipe: "pivot_wider_sleepstudy",
    args: { data: fx.dataFrames.sleepstudy }, expressions: { names_from: "Days", values_from: "Reaction" } });

  // ---- sklearn (Python) — constructors with default-friendly args ----
  r.set("sklearn.linear_model::LinearRegression", { recipe: "sklearn_LinearRegression",
    args: {} });
  r.set("sklearn.linear_model::LogisticRegression", { recipe: "sklearn_LogisticRegression",
    args: { max_iter: 200 } });
  r.set("sklearn.linear_model::Ridge", { recipe: "sklearn_Ridge",
    args: { alpha: 1.0 } });
  r.set("sklearn.linear_model::Lasso", { recipe: "sklearn_Lasso",
    args: { alpha: 1.0 } });
  r.set("sklearn.cluster::KMeans", { recipe: "sklearn_KMeans",
    args: { n_clusters: 3, n_init: 10, random_state: 0 } });
  r.set("sklearn.decomposition::PCA", { recipe: "sklearn_PCA",
    args: { n_components: 2 } });
  r.set("sklearn.preprocessing::StandardScaler", { recipe: "sklearn_StandardScaler",
    args: {} });
  r.set("sklearn.preprocessing::MinMaxScaler", { recipe: "sklearn_MinMaxScaler",
    args: {} });
  r.set("sklearn.tree::DecisionTreeClassifier", { recipe: "sklearn_DTClassifier",
    args: { random_state: 0 } });
  r.set("sklearn.tree::DecisionTreeRegressor", { recipe: "sklearn_DTRegressor",
    args: { random_state: 0 } });
  r.set("sklearn.ensemble::RandomForestClassifier", { recipe: "sklearn_RFClassifier",
    args: { n_estimators: 10, random_state: 0 } });
  r.set("sklearn.ensemble::RandomForestRegressor", { recipe: "sklearn_RFRegressor",
    args: { n_estimators: 10, random_state: 0 } });

  // ---- scipy.stats (Python) — common one-off stats ----
  r.set("scipy.stats::ttest_ind", { recipe: "scipy_ttest_ind",
    args: { a: fx.vectors.x, b: fx.vectors.y } });
  r.set("scipy.stats::ttest_1samp", { recipe: "scipy_ttest_1samp",
    args: { a: fx.vectors.x, popmean: 3 } });
  r.set("scipy.stats::pearsonr", { recipe: "scipy_pearsonr",
    args: { x: fx.vectors.x, y: fx.vectors.y } });
  r.set("scipy.stats::spearmanr", { recipe: "scipy_spearmanr",
    args: { a: fx.vectors.x, b: fx.vectors.y } });
  r.set("scipy.stats::shapiro", { recipe: "scipy_shapiro",
    args: { x: fx.vectors.x } });
  r.set("scipy.stats::norm", { recipe: "scipy_norm",
    args: {} });

  // ---- psych — descriptive stats / factor analysis ----
  r.set("psych::describe", { recipe: "psych_describe", args: { x: fx.dataFrames.mtcars } });
  r.set("psych::describeBy", { recipe: "psych_describeBy", args: { x: fx.dataFrames.iris, group: "Species" } });
  r.set("psych::headTail", { recipe: "psych_headTail", args: { x: fx.dataFrames.mtcars } });
  r.set("psych::corr.test", { recipe: "psych_corr_test", args: { x: fx.dataFrames.mtcars } });
  r.set("psych::cor2", { recipe: "psych_cor2", args: { x: fx.dataFrames.mtcars, y: fx.dataFrames.mtcars } });
  r.set("psych::pairs.panels", { recipe: "psych_pairs_panels", args: { x: fx.matrices.m5x5 } });
  r.set("psych::error.bars", { recipe: "psych_error_bars", args: { x: fx.dataFrames.mtcars } });
  r.set("psych::geometric.mean", { recipe: "psych_geom_mean", args: { x: fx.vectors.x } });
  r.set("psych::harmonic.mean", { recipe: "psych_harm_mean", args: { x: fx.vectors.x } });
  r.set("psych::tr", { recipe: "psych_tr", args: { m: fx.matrices.m5x5 } });
  r.set("psych::winsor", { recipe: "psych_winsor", args: { x: fx.vectors.x } });
  r.set("psych::fisherz", { recipe: "psych_fisherz", args: { rho: 0.5 } });
  r.set("psych::fisherz2r", { recipe: "psych_fisherz2r", args: { z: 0.5 } });
  r.set("psych::skew", { recipe: "psych_skew", args: { x: fx.vectors.x } });
  r.set("psych::kurtosi", { recipe: "psych_kurtosi", args: { x: fx.vectors.x } });
  r.set("psych::SD", { recipe: "psych_SD", args: { x: fx.vectors.x } });

  // ---- performance — model checking (works with lm fixture) ----
  r.set("performance::r2", { recipe: "perf_r2_lm", args: { model: fx.models.lm_mtcars } });
  r.set("performance::r2_efron", { recipe: "perf_r2_efron_lm", args: { model: fx.models.lm_mtcars } });
  r.set("performance::r2_kullback", { recipe: "perf_r2_kullback_lm", args: { model: fx.models.glm_mtcars } });
  r.set("performance::model_performance", { recipe: "perf_modelperf_lm", args: { model: fx.models.lm_mtcars } });
  r.set("performance::compare_performance", { recipe: "perf_compare", args: { model: fx.models.lm_mtcars } });
  r.set("performance::check_collinearity", { recipe: "perf_collinear_lm", args: { x: fx.models.lm_mtcars } });
  r.set("performance::check_normality", { recipe: "perf_normality_lm", args: { x: fx.models.lm_mtcars } });
  r.set("performance::check_heteroscedasticity", { recipe: "perf_hetero_lm", args: { x: fx.models.lm_mtcars } });
  r.set("performance::check_autocorrelation", { recipe: "perf_autocorr_lm", args: { x: fx.models.lm_mtcars } });
  r.set("performance::check_outliers", { recipe: "perf_outliers_lm", args: { x: fx.models.lm_mtcars } });
  r.set("performance::check_model", { recipe: "perf_check_model_lm", args: { x: fx.models.lm_mtcars } });
  r.set("performance::performance_aic", { recipe: "perf_aic_lm", args: { x: fx.models.lm_mtcars } });
  r.set("performance::performance_rmse", { recipe: "perf_rmse_lm", args: { model: fx.models.lm_mtcars } });
  r.set("performance::performance_mae", { recipe: "perf_mae_lm", args: { model: fx.models.lm_mtcars } });
  r.set("performance::icc", { recipe: "perf_icc_lm", args: { model: fx.models.lm_mtcars } });

  // ---- parameters — model parameter extraction ----
  r.set("parameters::model_parameters", { recipe: "params_lm", args: { model: fx.models.lm_mtcars } });
  r.set("parameters::standard_error", { recipe: "params_se_lm", args: { model: fx.models.lm_mtcars } });
  r.set("parameters::p_value", { recipe: "params_p_lm", args: { model: fx.models.lm_mtcars } });
  r.set("parameters::ci", { recipe: "params_ci_lm", args: { x: fx.models.lm_mtcars } });
  r.set("parameters::degrees_of_freedom", { recipe: "params_df_lm", args: { model: fx.models.lm_mtcars } });
  r.set("parameters::dof", { recipe: "params_dof_lm", args: { model: fx.models.lm_mtcars } });
  r.set("parameters::n_parameters", { recipe: "params_n_lm", args: { x: fx.models.lm_mtcars } });
  r.set("parameters::n_clusters", { recipe: "params_n_clusters", args: { x: fx.matrices.m5x5 } });

  // ---- bayestestR — ci/hdi/eti work on numeric vectors directly ----
  r.set("bayestestR::hdi", { recipe: "bay_hdi_x", args: { x: fx.vectors.x } });
  r.set("bayestestR::eti", { recipe: "bay_eti_x", args: { x: fx.vectors.x } });
  r.set("bayestestR::ci", { recipe: "bay_ci_x", args: { x: fx.vectors.x } });
  r.set("bayestestR::map_estimate", { recipe: "bay_map_x", args: { x: fx.vectors.x } });
  r.set("bayestestR::density_at", { recipe: "bay_density_at", args: { posterior: fx.vectors.x, x: 3 } });
  r.set("bayestestR::estimate_density", { recipe: "bay_estimate_density", args: { x: fx.vectors.x } });
  r.set("bayestestR::pd_to_p", { recipe: "bay_pd_to_p", args: { pd: 0.95 } });
  r.set("bayestestR::p_to_pd", { recipe: "bay_p_to_pd", args: { p: 0.05 } });
  r.set("bayestestR::convert_p_to_pd", { recipe: "bay_convert_p_to_pd", args: { p: 0.05 } });

  // Group A — describe/point on posterior_draws data frame.
  // diagnostic_*/effective_sample/mcse are NOT here: those reject data frames at
  // runtime and require a fitted Bayesian model, so they're routed to the
  // NEEDS_STAN_FIT structured skip below. weighted_posteriors does accept a
  // data frame via `...`, so it gets a dot_args recipe instead of a skip.
  r.set("bayestestR::describe_posterior",  { recipe: "bay_describe_draws", args: { posterior: fx.draws.posterior } });
  r.set("bayestestR::point_estimate",      { recipe: "bay_point_draws",    args: { x: fx.draws.posterior } });
  r.set("bayestestR::weighted_posteriors", { recipe: "bay_weighted_post_draws", dot_args: [fx.draws.posterior] });

  // Group B — posterior + prior. These also need the optional `logspline`
  // package, which isn't installed in this environment. Routed to a structured
  // skip below; install logspline to enable.

  // Group C — distribution generators (scalar n + shape params)
  r.set("bayestestR::distribution",          { recipe: "bay_dist",          args: { n: 100 } });
  r.set("bayestestR::distribution_normal",   { recipe: "bay_dist_normal",   args: { n: 100 } });
  r.set("bayestestR::distribution_gaussian", { recipe: "bay_dist_gaussian", args: { n: 100 } });
  r.set("bayestestR::distribution_uniform",  { recipe: "bay_dist_uniform",  args: { n: 100 } });
  r.set("bayestestR::distribution_cauchy",   { recipe: "bay_dist_cauchy",   args: { n: 100 } });
  r.set("bayestestR::distribution_beta",     { recipe: "bay_dist_beta",     args: { n: 100, shape1: 2, shape2: 5 } });
  r.set("bayestestR::distribution_binom",    { recipe: "bay_dist_binom",    args: { n: 100, size: 10, prob: 0.5 } });
  r.set("bayestestR::distribution_binomial", { recipe: "bay_dist_binomial", args: { n: 100, size: 10, prob: 0.5 } });
  r.set("bayestestR::distribution_chisq",    { recipe: "bay_dist_chisq",    args: { n: 100, df: 3 } });
  r.set("bayestestR::distribution_chisquared", { recipe: "bay_dist_chisquared", args: { n: 100, df: 3 } });
  r.set("bayestestR::distribution_gamma",    { recipe: "bay_dist_gamma",    args: { n: 100, shape: 2 } });
  r.set("bayestestR::distribution_nbinom",   { recipe: "bay_dist_nbinom",   args: { n: 100, size: 10, prob: 0.5 } });
  r.set("bayestestR::distribution_poisson",  { recipe: "bay_dist_poisson",  args: { n: 100, lambda: 2 } });
  r.set("bayestestR::distribution_student",  { recipe: "bay_dist_student",  args: { n: 100, df: 5 } });
  r.set("bayestestR::distribution_student_t", { recipe: "bay_dist_student_t", args: { n: 100, df: 5 } });
  r.set("bayestestR::distribution_t",        { recipe: "bay_dist_t",        args: { n: 100, df: 5 } });
  // distribution_tweedie needs the optional `tweedie` package (not installed);
  // routed to structured skip below.
  r.set("bayestestR::distribution_mixture_normal", { recipe: "bay_dist_mix_normal", args: { n: 100 } });
  r.set("bayestestR::distribution_custom",   { recipe: "bay_dist_custom",   args: { n: 100, type: "norm" } });

  // Group D — contrasts (scalar n)
  r.set("bayestestR::contr.bayes",                  { recipe: "bay_contr_bayes",        args: { n: 3 } });
  r.set("bayestestR::contr.equalprior",             { recipe: "bay_contr_equalprior",   args: { n: 3 } });
  r.set("bayestestR::contr.equalprior_pairs",       { recipe: "bay_contr_eq_pairs",     args: { n: 3 } });
  r.set("bayestestR::contr.equalprior_deviations",  { recipe: "bay_contr_eq_dev",       args: { n: 3 } });
  r.set("bayestestR::contr.orthonorm",              { recipe: "bay_contr_orthonorm",    args: { n: 3 } });

  // Group E — simulators (scalar args)
  r.set("bayestestR::simulate_correlation", { recipe: "bay_sim_corr",   args: { n: 50, r: 0.5 } });
  r.set("bayestestR::simulate_difference",  { recipe: "bay_sim_diff",   args: { n: 50, d: 0.5 } });
  r.set("bayestestR::simulate_ttest",       { recipe: "bay_sim_ttest",  args: { n: 50, d: 0.5 } });
  r.set("bayestestR::simulate_simpson",     { recipe: "bay_sim_simpson", args: { n: 50, r: 0.5, groups: 3 } });

  // Group F — BF scalar utilities + p_to_bf fix (signature is p_to_bf(x, ...))
  r.set("bayestestR::bic_to_bf",       { recipe: "bay_bic_to_bf",       args: { bic: 100, denominator: 105 } });
  r.set("bayestestR::convert_pd_to_p", { recipe: "bay_convert_pd_to_p", args: { pd: 0.95 } });
  r.set("bayestestR::p_to_bf",         { recipe: "bay_p_to_bf",         args: { x: 0.05, n_obs: 100 } });

  // ---- effectsize ----
  r.set("effectsize::cohens_d", { recipe: "es_cohens_d_xy", args: { x: fx.vectors.x, y: fx.vectors.y } });
  r.set("effectsize::hedges_g", { recipe: "es_hedges_g_xy", args: { x: fx.vectors.x, y: fx.vectors.y } });
  r.set("effectsize::glass_delta", { recipe: "es_glass_delta_xy", args: { x: fx.vectors.x, y: fx.vectors.y } });
  r.set("effectsize::cliffs_delta", { recipe: "es_cliffs_delta_xy", args: { x: fx.vectors.x, y: fx.vectors.y } });
  r.set("effectsize::rank_biserial", { recipe: "es_rank_biserial_xy", args: { x: fx.vectors.x, y: fx.vectors.y } });
  r.set("effectsize::eta_squared", { recipe: "es_eta_sq_aov", args: { model: fx.models.aov_mtcars } });
  r.set("effectsize::omega_squared", { recipe: "es_omega_sq_aov", args: { model: fx.models.aov_mtcars } });
  r.set("effectsize::epsilon_squared", { recipe: "es_eps_sq_aov", args: { model: fx.models.aov_mtcars } });
  r.set("effectsize::standardize_parameters", { recipe: "es_standardize_lm", args: { model: fx.models.lm_mtcars } });
  r.set("effectsize::interpret_d", { recipe: "es_interpret_d", args: { d: 0.5 } });
  r.set("effectsize::interpret_r", { recipe: "es_interpret_r", args: { r: 0.5 } });
  r.set("effectsize::interpret_r2", { recipe: "es_interpret_r2", args: { r2: 0.5 } });
  r.set("effectsize::interpret_oddsratio", { recipe: "es_interpret_or", args: { OR: 2.0 } });
  const addEffectsizeArgs = (fn: string, args: Record<string, unknown>): void => {
    r.set(`effectsize::${fn}`, { recipe: `es_${fn}`, args });
  };

  for (const fn of [
    "F_to_epsilon2", "F_to_eta2", "F_to_eta2_adj",
    "F_to_f", "F_to_f2", "F_to_omega2",
  ]) {
    addEffectsizeArgs(fn, { f: 4.2, df: 2, df_error: 30 });
  }
  for (const fn of ["F_to_d", "F_to_r"]) {
    addEffectsizeArgs(fn, { f: 4.2, df: 1, df_error: 30 });
  }
  for (const fn of [
    "t_to_d", "t_to_epsilon2", "t_to_eta2", "t_to_eta2_adj",
    "t_to_f", "t_to_f2", "t_to_omega2", "t_to_r",
  ]) {
    addEffectsizeArgs(fn, { t: 2.2, df_error: 30 });
  }
  for (const fn of ["z_to_d", "z_to_r"]) {
    addEffectsizeArgs(fn, { z: 2.2, n: 40 });
  }
  for (const fn of [
    "chisq_to_cohens_w", "chisq_to_cramers_v",
    "chisq_to_pearsons_c", "chisq_to_phi", "chisq_to_tschuprows_t",
  ]) {
    addEffectsizeArgs(fn, { chisq: 5.4, n: 60, nrow: 2, ncol: 2 });
  }
  for (const fn of [
    "d_to_logoddsratio", "d_to_oddsratio", "d_to_r",
  ]) {
    addEffectsizeArgs(fn, { d: 0.5, n1: 20, n2: 20 });
  }
  for (const fn of ["d_to_overlap", "d_to_p_superiority", "d_to_u1", "d_to_u2", "d_to_u3"]) {
    addEffectsizeArgs(fn, { d: 0.5 });
  }
  for (const fn of ["r_to_d", "r_to_logoddsratio", "r_to_oddsratio"]) {
    addEffectsizeArgs(fn, { r: 0.3, n1: 20, n2: 20 });
  }
  for (const fn of [
    "arr_to_logoddsratio", "arr_to_nnt", "arr_to_oddsratio", "arr_to_riskratio",
  ]) {
    addEffectsizeArgs(fn, { ARR: 0.1, p0: 0.2 });
  }
  for (const fn of [
    "logoddsratio_to_arr", "logoddsratio_to_d", "logoddsratio_to_nnt",
    "logoddsratio_to_r", "logoddsratio_to_riskratio",
  ]) {
    addEffectsizeArgs(fn, { logOR: 0.7, p0: 0.2, n1: 20, n2: 20 });
  }
  for (const fn of [
    "nnt_to_arr", "nnt_to_logoddsratio", "nnt_to_oddsratio", "nnt_to_riskratio",
  ]) {
    addEffectsizeArgs(fn, { NNT: 10, p0: 0.2 });
  }
  for (const fn of [
    "oddsratio_to_arr", "oddsratio_to_d", "oddsratio_to_nnt",
    "oddsratio_to_r", "oddsratio_to_riskratio",
  ]) {
    addEffectsizeArgs(fn, { OR: 2, p0: 0.2, n1: 20, n2: 20 });
  }
  for (const fn of [
    "riskratio_to_arr", "riskratio_to_logoddsratio",
    "riskratio_to_nnt", "riskratio_to_oddsratio",
  ]) {
    addEffectsizeArgs(fn, { RR: 1.5, p0: 0.2 });
  }
  for (const [fn, args] of Object.entries({
    c_to_w: { c: 0.3 },
    eta2_to_f: { es: 0.2 },
    eta2_to_f2: { es: 0.2 },
    f2_to_eta2: { f2: 0.25 },
    f_to_eta2: { f: 0.5 },
    fei_to_w: { fei: 0.3, p: 0.5 },
    odds_to_probs: { odds: 2 },
    probs_to_odds: { probs: 0.25 },
    phi_to_chisq: { phi: 0.3, n: 60 },
    rb_to_p_superiority: { rb: 0.3 },
    rb_to_vda: { rb: 0.3 },
    rb_to_wmw_odds: { rb: 0.3 },
    t_to_v: { t: 2.2, nrow: 2, ncol: 2 },
    t_to_w: { t: 2.2, nrow: 2, ncol: 2 },
    v_to_t: { v: 0.3, nrow: 2, ncol: 2 },
    v_to_w: { v: 0.3, nrow: 2, ncol: 2 },
    w_to_c: { w: 0.3 },
    w_to_fei: { w: 0.3, p: 0.5 },
    w_to_t: { w: 0.3, nrow: 2, ncol: 2 },
    w_to_v: { w: 0.3, nrow: 2, ncol: 2 },
  })) {
    addEffectsizeArgs(fn, args);
  }
  for (const [fn, args] of Object.entries({
    interpret_bf: { bf: 3 },
    interpret_cohens_d: { d: 0.5 },
    interpret_cohens_g: { g: 0.2 },
    interpret_cramers_v: { r: 0.3 },
    interpret_epsilon_squared: { es: 0.2 },
    interpret_ess: { ess: 1000 },
    interpret_eta_squared: { es: 0.2 },
    interpret_fei: { r: 0.3 },
    interpret_glass_delta: { delta: 0.5 },
    interpret_hedges_g: { g: 0.5 },
    interpret_icc: { icc: 0.6 },
    interpret_kendalls_w: { w: 0.3 },
    interpret_omega_squared: { es: 0.2 },
    interpret_p: { p: 0.03 },
    interpret_pd: { pd: 0.95 },
    interpret_phi: { r: 0.3 },
    interpret_r2_semipartial: { es: 0.1 },
    interpret_rank_biserial: { r: 0.3 },
    interpret_rhat: { rhat: 1.01 },
    interpret_rope: { rope: 0.03 },
    interpret_vif: { vif: 3 },
  })) {
    addEffectsizeArgs(fn, args);
  }
  for (const fn of ["cohens_f", "cohens_f_squared"]) {
    addEffectsizeArgs(fn, { model: fx.models.aov_mtcars });
  }
  for (const fn of ["effectsize", "r2_semipartial", "standardize_info"]) {
    addEffectsizeArgs(fn, { model: fx.models.lm_mtcars });
  }
  for (const fn of [
    "cohens_u1", "cohens_u2", "cohens_u3", "means_ratio", "p_overlap",
    "p_superiority", "rank_epsilon_squared", "rank_eta_squared", "vd_a",
    "wmw_odds",
  ]) {
    addEffectsizeArgs(fn, { x: "mpg ~ factor(am)", data: fx.dataFrames.mtcars });
  }
  for (const fn of ["sd_pooled", "mad_pooled"]) {
    addEffectsizeArgs(fn, { x: fx.vectors.x, y: fx.vectors.y });
  }
  addEffectsizeArgs("cov_pooled", { x: "mpg + wt ~ am", data: fx.dataFrames.mtcars });
  addEffectsizeArgs("mahalanobis_d", { x: "mpg + wt ~ am", data: fx.dataFrames.mtcars });
  for (const fn of ["arr", "oddsratio", "riskratio", "nnt", "cohens_g"]) {
    addEffectsizeArgs(fn, { x: fx.tables.twoByTwo });
  }
  for (const fn of ["phi", "cramers_v", "pearsons_c", "tschuprows_t"]) {
    addEffectsizeArgs(fn, { x: fx.tables.twoByTwo });
  }
  r.set("effectsize::cohens_h", {
    recipe: "es_cohens_h",
    args: { x: [10, 12], y: [5, 7] },
    coerce: { x: "numeric", y: "numeric" },
  });
  r.set("effectsize::cohens_w", {
    recipe: "es_cohens_w",
    args: { x: [10, 20, 30], p: [1 / 3, 1 / 3, 1 / 3] },
    coerce: { x: "numeric", p: "numeric" },
  });
  addEffectsizeArgs("kendalls_w", { x: fx.matrices.m5x5 });

  // ---- lubridate — date/time parsing ----
  r.set("lubridate::ymd",        { recipe: "lub_ymd",        args: { x: "2020-01-15" } });
  r.set("lubridate::mdy",        { recipe: "lub_mdy",        args: { x: "01/15/2020" } });
  r.set("lubridate::dmy",        { recipe: "lub_dmy",        args: { x: "15/01/2020" } });
  r.set("lubridate::ydm",        { recipe: "lub_ydm",        args: { x: "2020-15-01" } });
  r.set("lubridate::ymd_hms",    { recipe: "lub_ymd_hms",    args: { x: "2020-01-15 12:34:56" } });
  r.set("lubridate::mdy_hms",    { recipe: "lub_mdy_hms",    args: { x: "01/15/2020 12:34:56" } });
  r.set("lubridate::today",      { recipe: "lub_today",      args: {} });
  r.set("lubridate::now",        { recipe: "lub_now",        args: {} });
  r.set("lubridate::year",       { recipe: "lub_year",       args: { x: "2020-01-15" } });
  r.set("lubridate::month",      { recipe: "lub_month",      args: { x: "2020-01-15" } });
  r.set("lubridate::day",        { recipe: "lub_day",        args: { x: "2020-01-15" } });
  r.set("lubridate::hour",       { recipe: "lub_hour",       args: { x: "2020-01-15 12:00:00" } });
  r.set("lubridate::minute",     { recipe: "lub_minute",     args: { x: "2020-01-15 12:34:00" } });
  r.set("lubridate::second",     { recipe: "lub_second",     args: { x: "2020-01-15 12:34:56" } });
  r.set("lubridate::wday",       { recipe: "lub_wday",       args: { x: "2020-01-15" } });
  r.set("lubridate::yday",       { recipe: "lub_yday",       args: { x: "2020-01-15" } });
  r.set("lubridate::quarter",    { recipe: "lub_quarter",    args: { x: "2020-01-15" } });
  r.set("lubridate::semester",   { recipe: "lub_semester",   args: { x: "2020-01-15" } });
  r.set("lubridate::leap_year",  { recipe: "lub_leap_year",  args: { date: "2020-01-15" } });
  r.set("lubridate::days_in_month", { recipe: "lub_days_in_month", args: { x: "2020-02-15" } });
  r.set("lubridate::is.Date",    { recipe: "lub_is_Date",    args: { x: "2020-01-15" } });
  r.set("lubridate::days",       { recipe: "lub_days",       args: { x: 7 } });
  r.set("lubridate::weeks",      { recipe: "lub_weeks",      args: { x: 2 } });
  r.set("lubridate::months",     { recipe: "lub_months",     args: { x: 3 } });
  r.set("lubridate::years",      { recipe: "lub_years",      args: { x: 1 } });
  r.set("lubridate::hours",      { recipe: "lub_hours",      args: { x: 5 } });
  r.set("lubridate::minutes",    { recipe: "lub_minutes",    args: { x: 30 } });
  r.set("lubridate::seconds",    { recipe: "lub_seconds",    args: { x: 60 } });

  // ---- forecast — extensions beyond auto.arima/Arima/ets in Tier A ----
  r.set("forecast::naive",        { recipe: "fc_naive",        args: { y: fx.timeSeries.AirPassengers, h: 12 }, coerce: { y: "ts(frequency=12)" } });
  r.set("forecast::snaive",       { recipe: "fc_snaive",       args: { y: fx.timeSeries.AirPassengers, h: 12 }, coerce: { y: "ts(frequency=12)" } });
  r.set("forecast::meanf",        { recipe: "fc_meanf",        args: { y: fx.timeSeries.AirPassengers, h: 12 }, coerce: { y: "ts(frequency=12)" } });
  r.set("forecast::rwf",          { recipe: "fc_rwf",          args: { y: fx.timeSeries.AirPassengers, h: 12 }, coerce: { y: "ts(frequency=12)" } });
  r.set("forecast::accuracy",     { recipe: "fc_accuracy_ts",  args: { object: fx.timeSeries.AirPassengers } });
  r.set("forecast::ggseasonplot", { recipe: "fc_ggseasonplot", args: { x: fx.timeSeries.AirPassengers }, coerce: { x: "ts(frequency=12)" } });
  r.set("forecast::ggsubseriesplot", { recipe: "fc_ggsubseries", args: { x: fx.timeSeries.AirPassengers }, coerce: { x: "ts(frequency=12)" } });
  r.set("forecast::ggmonthplot",  { recipe: "fc_ggmonthplot",  args: { x: fx.timeSeries.AirPassengers }, coerce: { x: "ts(frequency=12)" } });
  r.set("forecast::tsoutliers",   { recipe: "fc_tsoutliers",   args: { x: fx.timeSeries.AirPassengers }, coerce: { x: "ts(frequency=12)" } });
  r.set("forecast::tsclean",      { recipe: "fc_tsclean",      args: { x: fx.timeSeries.AirPassengers }, coerce: { x: "ts(frequency=12)" } });
  r.set("forecast::ndiffs",       { recipe: "fc_ndiffs",       args: { x: fx.timeSeries.AirPassengers }, coerce: { x: "ts(frequency=12)" } });
  r.set("forecast::nsdiffs",      { recipe: "fc_nsdiffs",      args: { x: fx.timeSeries.AirPassengers }, coerce: { x: "ts(frequency=12)" } });
  r.set("forecast::seasonaldummy", { recipe: "fc_seasonaldummy", args: { x: fx.timeSeries.AirPassengers }, coerce: { x: "ts(frequency=12)" } });
  r.set("forecast::ses",          { recipe: "fc_ses",          args: { y: fx.timeSeries.AirPassengers, h: 12 }, coerce: { y: "ts(frequency=12)" } });
  r.set("forecast::holt",         { recipe: "fc_holt",         args: { y: fx.timeSeries.AirPassengers, h: 12 }, coerce: { y: "ts(frequency=12)" } });
  r.set("forecast::hw",           { recipe: "fc_hw",           args: { y: fx.timeSeries.AirPassengers, h: 12 }, coerce: { y: "ts(frequency=12)" } });

  // ---- pwr — power analysis (newly installed) ----
  r.set("pwr::pwr.t.test",     { recipe: "pwr_t_test",     args: { d: 0.5, "sig.level": 0.05, power: 0.8 } });
  r.set("pwr::pwr.anova.test", { recipe: "pwr_anova_test", args: { k: 3, f: 0.25, "sig.level": 0.05, power: 0.8 } });
  r.set("pwr::pwr.r.test",     { recipe: "pwr_r_test",     args: { r: 0.3, "sig.level": 0.05, power: 0.8 } });
  r.set("pwr::pwr.chisq.test", { recipe: "pwr_chisq_test", args: { w: 0.3, df: 2, "sig.level": 0.05, power: 0.8 } });
  r.set("pwr::pwr.2p.test",    { recipe: "pwr_2p_test",    args: { h: 0.3, "sig.level": 0.05, power: 0.8 } });

  return r;
}

// ----------------------------------------------------------------------------
// Schema-pattern recipes (broader, lower confidence)
// ----------------------------------------------------------------------------

export type PatternResult = Recipe | { skip: true; reason: string };

function reqSet(s: ResolvedSchema | undefined): Set<string> {
  return new Set(s?.required ?? []);
}

function propNames(s: ResolvedSchema | undefined): string[] {
  return Object.keys(s?.properties ?? {});
}

// Functions whose name signals a specific class dispatch (e.g. predict.gbm
// expects a gbm object, summary.lavaan a lavaan fit) — never use a generic
// numeric/lm fixture for these.
const CLASS_SUFFIXED_RE = /\.(gbm|svm|glmnet|coxph|brms|stan|rstanarm|aov|nlme|gam|tree|rf|knn|mice|imp|mira|merMod|lme|nlme|gls|polr|loess|gam|nb|svyglm|tbl|tbl_df|tbl_lazy|sf)$/i;

// S3 generics whose dispatch invariably needs a class-specific object.
// Calling them with a numeric vector errors with "no applicable method".
// Skip rather than attempt a recipe.
const S3_DISPATCH_RE = /^(print_html|print_md|print_json|print_yaml|print_color|print_inline|reshape_draws|reshape_iterations|reshape_grouplevel|tidy_summary|knit_print|knit_meta|html_dependencies|display)$/;

// bayestestR functions that require a fitted Bayesian model (rstanarm/brms).
// rstan is blocked on this toolchain (Rcpp::loadModule segfault on macOS arm64
// + Homebrew R + GCC-15), so these can never be exercised here. Skip with a
// structured reason so the next iteration finds them.
//
// diagnostic_posterior/diagnostic_draws/effective_sample/mcse/weighted_posteriors
// also belong here — they reject posterior_draws data frames at runtime
// ("only works with rstanarm/brms/blavaan models" / "not yet implemented for
// objects of class 'data.frame'").
const BAYESTESTR_NEEDS_STAN_FIT = new Set([
  "bayesfactor", "bayesfactor_inclusion", "bayesfactor_models",
  "bayesfactor_restricted", "bf_inclusion", "bf_models", "bf_restricted",
  "bayesian_as_frequentist", "convert_bayesian_as_frequentist",
  "check_prior", "describe_prior", "model_to_priors",
  "sensitivity_to_prior", "unupdate", "mediation", "simulate_prior",
  "diagnostic_posterior", "diagnostic_draws",
  "effective_sample", "mcse",
]);

// bayestestR functions that depend on optional R packages not installed in
// this environment. Skip with a structured reason; the next iteration can
// `install.packages(...)` and convert these to call_pass.
const BAYESTESTR_NEEDS_OPTIONAL_PKG = new Set([
  // Need `logspline` (used internally for prior-density estimation):
  "bayesfactor_parameters", "bayesfactor_pointnull", "bayesfactor_rope",
  "bf_parameters", "bf_pointnull", "bf_rope", "si",
  // Need `tweedie`:
  "distribution_tweedie",
]);

// Supervised-ML training entry points: schema only exposes `x` because the
// generic doesn't capture the .default formals, but the real call needs at
// minimum (x, y) plus a formula or matrix-like input. Skip generic numeric
// recipes for these; they need an exact recipe per package.
const ML_TRAINER_RE = /^(train|preProcess|naiveBayes|svm|gknn|knn|knn3|knncat|gausspr|ksvm|rvm|lssvm|rda|lda|qda|fda|mda|nnet|multinom|mlp|cppls|pls|plsr|pcr|pcaNet|earth|gbm\.fit|cubist|bagging|boosting|fitcat|cv\.glmnet)$/;

// Functions that operate on data frames specifically — generic numeric vectors
// will fail.
const DATA_FRAME_FN_RE = /^(filter|mutate|summari[sz]e|group_by|ungroup|arrange|select|count|tally|distinct|rename|transmute|left_join|right_join|inner_join|full_join|anti_join|semi_join|nest_join|cross_join|bind_rows|bind_cols|pivot_|unnest|nest|complete|drop_na|fill|separate|unite|gather|spread|extract|any_of|all_of|starts_with|ends_with|contains|matches|num_range|everything|across|where|last_col|first|where_|relocate|slice|slice_head|slice_tail|slice_min|slice_max|slice_sample|reframe|rowwise|ungroup|group_split|group_keys|group_data|group_indices|group_size|n_groups|cur_group|cur_data|cur_column|cur_group_id|cur_group_rows|context_peek|context_poke|context_local|context_unset|data_filter|data_select|data_rename|data_to_wide|data_to_long|data_arrange)$/i;

// Function names that imply matrix-like input (2D), not 1D vectors.
const MATRIX_FN_RE = /^(chol|chol2inv|svd|qr|eigen|crossprod|tcrossprod|solve|det|determinant|kronecker|backsolve|forwardsolve|colMeans|rowMeans|colSums|rowSums|colMaxs|colMins|colVars|rowVars|colMedians|rowMedians|colNorms)$/i;

// Functions that take character-only x. With a char_vec fixture available we
// can attempt these via pattern_character_x (below) instead of skipping.
const CHARACTER_FN_RE = /^(toupper|tolower|nchar|chartr|substring?|gsub|sub|regmatches|grepl|grep|str_|sprintf|trimws|tolower|toupper|startsWith|endsWith)$/i;

// psych functions whose first required arg is a correlation matrix or
// covariance matrix. Names typically reference matrices or factor analysis.
const PSYCH_CORMAT_FN_RE = /^(KMO|ICLUST|VSS|Procrustes|Promax|RMSEA|Pinv|Yule|Yule\.|Yule2|TargetQ|TargetT|fa\.|principal|fa[A-Z]|alpha2|cluster\.cor|cor2cov|partial\.r|smc|guttman|paran|nfactors|polychoric|tetrachoric|mixedCor|cohen\.kappa)/;

/**
 * Pick a pattern recipe for a function whose schema we have and which has no
 * exact recipe. Conservative: only match patterns we're confident will produce
 * a valid call. When in doubt, skip.
 */
export function patternRecipe(
  pkg: string,
  fn: string,
  schema: ResolvedSchema | undefined,
  fx: FixtureLibrary,
): PatternResult {
  if (!schema || !schema.properties) return { skip: true, reason: "no_schema" };
  const required = reqSet(schema);
  const names = propNames(schema);
  const hasFormula = names.includes("formula");
  const hasY = names.includes("y");
  const hasData = names.includes("data") || names.includes(".data");
  const dataKey = names.includes("data") ? "data" : ".data";

  // Class-suffixed S3 methods (predict.gbm, summary.lavaan, etc.) must use
  // the matching class fixture — and we don't have those. Skip.
  if (CLASS_SUFFIXED_RE.test(fn)) {
    return { skip: true, reason: "class_specific_s3_method" };
  }

  // Generic-only S3 dispatchers (print_html, reshape_draws, etc.) need a
  // class-specific object; skip rather than send a numeric vector.
  if (S3_DISPATCH_RE.test(fn)) {
    return { skip: true, reason: "s3_generic_no_dispatch" };
  }

  if (pkg === "bayestestR" && BAYESTESTR_NEEDS_STAN_FIT.has(fn)) {
    return { skip: true, reason: "needs_bayesian_model_fixture" };
  }
  if (pkg === "bayestestR" && BAYESTESTR_NEEDS_OPTIONAL_PKG.has(fn)) {
    return { skip: true, reason: "needs_optional_r_package" };
  }

  // Supervised-ML trainers — schema lies about required args; skip generic
  // recipes and rely on exact recipes (per-package) when added.
  if (ML_TRAINER_RE.test(fn)) {
    return { skip: true, reason: "ml_trainer_needs_xy_recipe" };
  }

  // Data-frame-specific verbs (filter/mutate/joins) — exact recipes cover the
  // dplyr/tidyr core; anything else needs an exact recipe, not a pattern.
  if (DATA_FRAME_FN_RE.test(fn)) {
    return { skip: true, reason: "data_frame_verb_no_exact_recipe" };
  }

  // Matrix-only operations: vec_x is 1D, won't satisfy. Use cormat (5×5
  // square symmetric, positive semi-definite — works for chol/eigen).
  if (MATRIX_FN_RE.test(fn) && required.has("x") && !required.has("y")) {
    return {
      recipe: "pattern_matrix_x",
      args: { x: fx.matrices.cormat },
    };
  }
  // base::chol / base::eigen / base::solve etc. need a square matrix as `a`.
  if (MATRIX_FN_RE.test(fn) && required.has("a") && !required.has("b")) {
    return {
      recipe: "pattern_matrix_a",
      args: { a: fx.matrices.cormat },
    };
  }

  // Character-only operations: try with char_vec fixture.
  if (CHARACTER_FN_RE.test(fn) && required.has("x") && required.size === 1) {
    return { recipe: "pattern_character_x", args: { x: fx.vectors.char } };
  }
  // stringr family — char vector handle is the right input.
  if (pkg === "stringr" && required.has("string") && required.size === 1) {
    return { recipe: "pattern_stringr_string", args: { string: fx.vectors.char } };
  }
  if (pkg === "stringr" && required.has("string") && required.has("pattern") && required.size === 2) {
    return { recipe: "pattern_stringr_string_pattern", args: { string: fx.vectors.char, pattern: "a" } };
  }

  // psych functions with correlation-matrix-shaped input.
  if (pkg === "psych" && PSYCH_CORMAT_FN_RE.test(fn)) {
    for (const k of ["r", "x", "m", "C"] as const) {
      if (required.has(k)) {
        return { recipe: "pattern_psych_cormat", args: { [k]: fx.matrices.cormat } };
      }
    }
  }

  if (pkg === "effectsize" && fn === "interpret") {
    return { skip: true, reason: "generic_interpret_needs_rules" };
  }

  // Pattern 1: model accessor — only when name strongly signals a post-fit
  // accessor AND the required object slot is `object` / `model` / `fit`.
  // Removed `x` from the slot list and removed `summary|coef` from the regex
  // because those frequently dispatch on classes other than lm.
  for (const k of ["object", "model", "fit"] as const) {
    if (required.has(k) && /^(tidy|glance|augment|anova|confint|AIC|BIC|logLik|deviance|nobs|residuals|fitted|predict)$/.test(fn)) {
      return { recipe: "pattern_lm_object", args: { [k]: fx.models.lm_mtcars } };
    }
  }

  // Pattern 2: formula + data — but skip when family has known constraints
  // we can't satisfy generically (random-effects, ts, ordinal response).
  if (hasFormula && hasData && required.has("formula")) {
    if (/^(glmer|lmer|nlmer|stan_|brm|tslm|polr|gamlss|svyglm|coxme)/.test(fn)) {
      return { skip: true, reason: "specialized_formula_function" };
    }
    return {
      recipe: "pattern_formula_data_mtcars",
      args: { formula: "mpg ~ wt + hp", [dataKey]: fx.dataFrames.mtcars },
    };
  }

  // Pattern 3: numeric x + y — both must be required AND nothing else required.
  // (joins like dplyr::*_join take x,y but need data frames; those are caught
  // by DATA_FRAME_FN_RE above.)
  if (required.has("x") && required.has("y") && required.size === 2) {
    return { recipe: "pattern_numeric_xy", args: { x: fx.vectors.x, y: fx.vectors.y } };
  }

  // performance/parameters mixed-model-only accessors (Kenward-Roger, ML1,
  // Satterthwaite, between/within) require an lmer/glmer fit which we don't
  // have. Skip rather than send a plain lm.
  if ((pkg === "performance" || pkg === "parameters") && /^(ci_kenward|ci_betwithin|ci_ml1|ci_satterthwaite|p_value_kenward|p_value_betwithin|p_value_ml1|p_value_satterthwaite|dof_kenward|dof_betwithin|dof_ml1|dof_satterthwaite|standard_error_kenward|degrees_of_freedom_kenward)$/.test(fn)) {
    return { skip: true, reason: "needs_mixed_model_fixture" };
  }

  // psych Yule family expects a 2×2 contingency table, not a 5×5 matrix.
  // Skip — would need a dedicated fixture.
  if (pkg === "psych" && /^(Yule|Yule\.inv|Yule2phi|Yule2poly|Yule2tetra|YuleBonett|YuleCor)$/.test(fn)) {
    return { skip: true, reason: "needs_2x2_table_fixture" };
  }

  // Pattern 4: single-arg `x` — package-family-aware fixture choice.
  // psych: data frame (most descriptive functions take a frame/matrix)
  // performance/parameters: model object (these are model accessors)
  // others: numeric vector (fallback)
  if (required.has("x") && required.size === 1 && !hasY) {
    if (pkg === "psych") {
      return { recipe: "pattern_dataframe_x_mtcars", args: { x: fx.dataFrames.mtcars } };
    }
    if (pkg === "performance" || pkg === "parameters") {
      return { recipe: "pattern_lm_x_easystats", args: { x: fx.models.lm_mtcars } };
    }
    return { recipe: "pattern_numeric_x", args: { x: fx.vectors.x } };
  }

  // Pattern 5: model accessor by `model`/`object`/`fit` — narrow regex
  // covering common easystats / broom accessor names.
  if ((pkg === "performance" || pkg === "parameters") && /^(check_|r2_|icc_|model_|standard_|p_|ci_|degrees_|dof_|n_)/.test(fn)) {
    for (const k of ["model", "object", "fit"] as const) {
      if (required.has(k)) {
        return { recipe: "pattern_lm_for_easystats", args: { [k]: fx.models.lm_mtcars } };
      }
    }
  }

  // Pattern 6: data only (no formula) — but only if `data` is the sole
  // required arg, otherwise we'd miss other required slots.
  if (required.has(dataKey) && !hasFormula && required.size === 1) {
    return { recipe: "pattern_data_mtcars", args: { [dataKey]: fx.dataFrames.mtcars } };
  }

  // Pattern 7: dplyr / tidyr NSE — skip; exact recipes cover the verbs we
  // know are safe.
  if (pkg === "dplyr" || pkg === "tidyr") {
    return { skip: true, reason: "nse_no_recipe" };
  }

  // Zero required args was previously a pattern but produced 82 false
  // positives (functions whose required args live in `...`). Drop it: better
  // to skip than to make invalid calls.
  return { skip: true, reason: "no_pattern_match" };
}

// ----------------------------------------------------------------------------
// Public lookup
// ----------------------------------------------------------------------------

export type RecipeLookup = (pkg: string, fn: string, schema?: ResolvedSchema) => Recipe | { skip: true; reason: string };

export function makeRecipeLookup(fx: FixtureLibrary): RecipeLookup {
  const exact = exactRecipes(fx);
  return (pkg, fn, schema) => {
    const exactKey = `${pkg}::${fn}`;
    const ex = exact.get(exactKey);
    if (ex) return ex;
    return patternRecipe(pkg, fn, schema, fx);
  };
}
