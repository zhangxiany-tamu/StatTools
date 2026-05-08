// ============================================================================
// StatTools — Search-Quality Benchmark Dataset
// ============================================================================
// A curated set of queries paired with accepted "correct" function IDs. The
// harness scores `stat_search` by checking whether any accepted ID appears in
// the top-K results.
//
// Scope split:
//   - common: things a working data scientist would search for daily; we
//     target >=80% top_5 hit rate.
//   - longTail: less obvious or specialized queries; we target >=60%.
//
// Each entry's `accepted` is a set of ids that count as a hit (multiple
// because a query like "linear regression" should match stats::lm OR
// MASS::rlm OR sandwich::vcovHC depending on intent — anything plausible).
// ============================================================================

export type BenchmarkQuery = {
  query: string;
  /** Acceptable correct hits — any one of these in top-K counts as a hit */
  accepted: string[];
  /** Optional task-view filter to pass through to stat_search */
  task_view?: string;
};

export const COMMON_QUERIES: BenchmarkQuery[] = [
  // ----- regression -----
  { query: "linear regression",                   accepted: ["stats::lm", "MASS::rlm", "stats::glm"] },
  { query: "logistic regression",                 accepted: ["stats::glm", "MASS::polr"] },
  { query: "robust regression",                   accepted: ["MASS::rlm", "robustbase::lmrob"] },
  { query: "mixed effects model",                 accepted: ["lme4::lmer", "lme4::glmer", "nlme::lme"] },
  { query: "generalized linear model",            accepted: ["stats::glm"] },
  { query: "lasso regression",                    accepted: ["glmnet::glmnet", "glmnet::cv.glmnet"] },
  { query: "ridge regression",                    accepted: ["glmnet::glmnet", "glmnet::cv.glmnet", "MASS::lm.ridge"] },
  { query: "polynomial regression",               accepted: ["stats::lm", "stats::poly"] },

  // ----- classical stats -----
  { query: "two sample t-test",                   accepted: ["stats::t.test"] },
  { query: "chi-squared test",                    accepted: ["stats::chisq.test"] },
  { query: "fisher exact test",                   accepted: ["stats::fisher.test"] },
  { query: "wilcoxon rank sum",                   accepted: ["stats::wilcox.test"] },
  { query: "shapiro normality test",              accepted: ["stats::shapiro.test"] },
  { query: "kolmogorov smirnov",                  accepted: ["stats::ks.test"] },
  { query: "anova",                               accepted: ["stats::aov", "stats::anova", "car::Anova"] },
  { query: "tukey hsd post-hoc",                  accepted: ["stats::TukeyHSD", "emmeans::emmeans"] },
  { query: "correlation pearson spearman",        accepted: ["stats::cor", "stats::cor.test"] },

  // ----- time series / forecasting -----
  { query: "arima forecasting",                   accepted: ["forecast::auto.arima", "forecast::Arima", "stats::arima"] },
  { query: "exponential smoothing ets",           accepted: ["forecast::ets", "stats::HoltWinters"] },
  { query: "stl decomposition",                   accepted: ["stats::stl", "stats::decompose"] },
  { query: "ljung box test",                      accepted: ["stats::Box.test"] },

  // ----- survival -----
  { query: "cox proportional hazards",            accepted: ["survival::coxph"] },
  { query: "kaplan meier survival curve",         accepted: ["survival::survfit", "survival::Surv"] },

  // ----- clustering / dim reduction -----
  { query: "k-means clustering",                  accepted: ["stats::kmeans"] },
  { query: "principal component analysis",        accepted: ["stats::prcomp", "stats::princomp"] },
  { query: "hierarchical clustering",             accepted: ["stats::hclust", "stats::cutree"] },

  // ----- ML -----
  { query: "random forest classifier",            accepted: ["randomForest::randomForest", "ranger::ranger"] },
  { query: "gradient boosting xgboost",           accepted: ["xgboost::xgb.train", "xgboost::xgboost", "gbm::gbm"] },
  { query: "decision tree",                       accepted: ["rpart::rpart"] },

  // ----- tidy / data manipulation -----
  { query: "filter rows by condition",            accepted: ["dplyr::filter", "base::subset"] },
  { query: "mutate add column",                   accepted: ["dplyr::mutate", "dplyr::transmute"] },
  { query: "group by summarise",                  accepted: ["dplyr::group_by", "dplyr::summarise", "dplyr::summarize"] },
  { query: "pivot wider longer reshape",          accepted: ["tidyr::pivot_wider", "tidyr::pivot_longer"] },
  { query: "join data frames",                    accepted: ["dplyr::inner_join", "dplyr::left_join", "merge"] },

  // ----- model summaries -----
  { query: "tidy model output broom",             accepted: ["broom::tidy", "broom::glance", "broom::augment"] },
  { query: "model fit diagnostics",               accepted: ["broom::glance", "performance::check_model", "broom::augment"] },

  // ----- effect size / power -----
  { query: "cohen's d effect size",               accepted: ["effectsize::cohens_d", "effsize::cohen.d"] },
  { query: "power analysis sample size",          accepted: ["pwr::pwr.t.test", "pwr::pwr.anova.test"] },

  // ----- python-side -----
  { query: "scikit-learn linear regression",      accepted: ["sklearn.linear_model::LinearRegression"] },
  { query: "scikit-learn logistic regression",    accepted: ["sklearn.linear_model::LogisticRegression"] },
  { query: "k-means scikit",                      accepted: ["sklearn.cluster::KMeans"] },
  { query: "scipy ttest",                         accepted: ["scipy.stats::ttest_ind", "scipy.stats::ttest_1samp", "scipy.stats::ttest_rel"] },
  { query: "scipy pearson correlation",           accepted: ["scipy.stats::pearsonr"] },
];

export const LONG_TAIL_QUERIES: BenchmarkQuery[] = [
  { query: "structural equation modeling",        accepted: ["lavaan::sem", "lavaan::cfa"] },
  { query: "bayesian model averaging",            accepted: ["BMS::bms", "BMA::bicreg"] },
  { query: "panel data fixed effects",            accepted: ["plm::plm", "fixest::feols"] },
  { query: "instrumental variables 2sls",         accepted: ["AER::ivreg", "fixest::feols"] },
  { query: "cluster robust standard errors",      accepted: ["sandwich::vcovCL", "sandwich::vcovHC"] },
  { query: "heteroskedasticity test",             accepted: ["lmtest::bptest", "car::ncvTest"] },
  { query: "multiple imputation",                 accepted: ["mice::mice", "Amelia::amelia"] },
  { query: "propensity score matching",           accepted: ["MatchIt::matchit"] },
  { query: "synthetic control method",            accepted: ["Synth::synth", "gsynth::gsynth"] },
  { query: "time-varying coefficient model",      accepted: ["mgcv::gam", "tvReg::tvLM"] },
  { query: "rank deficient regression",           accepted: ["MASS::rlm", "robustbase::lmrob"] },
  { query: "factor analysis exploratory",         accepted: ["psych::fa", "psych::principal", "stats::factanal"] },
  { query: "item response theory",                accepted: ["mirt::mirt", "ltm::ltm"] },
  { query: "negative binomial regression",        accepted: ["MASS::glm.nb"] },
  { query: "quantile regression",                 accepted: ["quantreg::rq"] },
  { query: "generalized additive model",          accepted: ["mgcv::gam", "mgcv::bam"] },
  { query: "loess local regression",              accepted: ["stats::loess", "stats::lowess"] },
  { query: "nonparametric density",               accepted: ["stats::density", "ks::kde"] },
  { query: "bootstrap confidence interval",       accepted: ["boot::boot", "boot::boot.ci"] },
  { query: "permutation test",                    accepted: ["coin::oneway_test"] },
  { query: "bayesian linear regression",          accepted: ["rstanarm::stan_glm", "brms::brm", "BayesFactor::lmBF"] },
  { query: "longitudinal repeated measures",      accepted: ["lme4::lmer", "nlme::lme"] },
  { query: "regression discontinuity",            accepted: ["rdrobust::rdrobust", "rdd::RDestimate"] },
  { query: "differences in differences",          accepted: ["fixest::feols", "didimputation::did_imputation"] },
  { query: "event study",                         accepted: ["fixest::feols", "didimputation::did_imputation"] },
  { query: "spline regression",                   accepted: ["splines::bs", "splines::ns", "mgcv::gam"] },
  { query: "deep learning neural network",        accepted: ["nnet::nnet", "keras3::keras_model"] },
  { query: "naive bayes classifier",              accepted: ["e1071::naiveBayes", "naivebayes::naive_bayes"] },
  { query: "support vector machine",              accepted: ["e1071::svm", "kernlab::ksvm"] },
  { query: "topic modeling lda",                  accepted: ["topicmodels::LDA", "stm::stm"] },
];
