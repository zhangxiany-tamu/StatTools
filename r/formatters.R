# ============================================================================
# StatTools — Structured JSON Output Formatters
# ============================================================================
# Class-based dispatch: each R class gets a formatter that returns a clean
# JSON-safe list. The bridge calls format_for_json() on every result.

format_for_json <- function(obj) {
  cls <- class(obj)[1]

  result <- tryCatch(
    switch(cls,
      "lm"          = format_lm(obj),
      "glm"         = format_glm(obj),
      "htest"       = format_htest(obj),
      "anova"       = format_anova(obj),
      "aov"         = format_anova(summary(obj)[[1]]),
      "data.frame"  = format_dataframe(obj),
      "tbl_df"      = format_dataframe(as.data.frame(obj)),
      "matrix"      = format_matrix(obj),
      "summary.lm"  = format_summary_lm(obj),
      "summary.glm" = format_summary_glm(obj),
      "numeric"     = format_numeric(obj),
      "table"       = format_table(obj),
      "density"     = format_density(obj),
      format_default(obj)
    ),
    error = function(e) format_default(obj)
  )

  result
}

# ---- Linear Model ----------------------------------------------------------

format_lm <- function(obj) {
  s <- summary(obj)
  coefs <- as.data.frame(s$coefficients)
  names(coefs) <- c("estimate", "std_error", "t_value", "p_value")

  list(
    class = "lm",
    call = paste(deparse(obj$call, width.cutoff = 200), collapse = " "),
    coefficients = coefs,
    r_squared = s$r.squared,
    adj_r_squared = s$adj.r.squared,
    f_statistic = if (!is.null(s$fstatistic)) list(
      value = s$fstatistic[1],
      numdf = s$fstatistic[2],
      dendf = s$fstatistic[3]
    ) else NULL,
    residual_se = s$sigma,
    df = s$df,
    n = nrow(obj$model)
  )
}

# ---- Generalized Linear Model -----------------------------------------------

format_glm <- function(obj) {
  base <- format_lm(obj)
  base$class <- "glm"
  base$family <- obj$family$family
  base$link <- obj$family$link
  base$deviance <- obj$deviance
  base$null_deviance <- obj$null.deviance
  base$aic <- obj$aic
  base$df_residual <- obj$df.residual
  # Remove r_squared/adj_r_squared (not meaningful for GLMs)
  base$r_squared <- NULL
  base$adj_r_squared <- NULL
  base
}

# ---- Hypothesis Test --------------------------------------------------------

format_htest <- function(obj) {
  list(
    class = "htest",
    method = obj$method,
    statistic = as.list(obj$statistic),
    p_value = obj$p.value,
    conf_int = if (!is.null(obj$conf.int)) as.numeric(obj$conf.int) else NULL,
    conf_level = if (!is.null(obj$conf.int)) attr(obj$conf.int, "conf.level") else NULL,
    estimate = if (!is.null(obj$estimate)) as.list(obj$estimate) else NULL,
    null_value = if (!is.null(obj$null.value)) as.list(obj$null.value) else NULL,
    alternative = obj$alternative,
    data_name = obj$data.name
  )
}

# ---- ANOVA ------------------------------------------------------------------

format_anova <- function(obj) {
  df <- as.data.frame(obj)
  list(
    class = "anova",
    table = df,
    terms = rownames(obj)
  )
}

# ---- Data Frame (preview) ---------------------------------------------------

format_dataframe <- function(df, max_rows = 20L) {
  preview <- utils::head(df, max_rows)

  column_summary <- lapply(names(df), function(col) {
    x <- df[[col]]
    if (is.numeric(x)) {
      list(
        type = class(x)[1],
        mean = mean(x, na.rm = TRUE),
        sd = sd(x, na.rm = TRUE),
        min = min(x, na.rm = TRUE),
        max = max(x, na.rm = TRUE),
        na_count = sum(is.na(x))
      )
    } else if (is.factor(x) || is.character(x)) {
      vals <- sort(table(x), decreasing = TRUE)
      list(
        type = class(x)[1],
        n_unique = length(unique(x)),
        na_count = sum(is.na(x)),
        top_values = utils::head(as.list(vals), 5)
      )
    } else {
      list(type = class(x)[1], na_count = sum(is.na(x)))
    }
  })
  names(column_summary) <- names(df)

  list(
    class = "data.frame",
    dimensions = list(rows = nrow(df), cols = ncol(df)),
    column_types = as.list(setNames(
      sapply(df, function(x) class(x)[1], USE.NAMES = FALSE),
      names(df)
    )),
    preview = preview,
    column_summary = column_summary
  )
}

# ---- Matrix -----------------------------------------------------------------

format_matrix <- function(obj) {
  list(
    class = "matrix",
    dimensions = list(rows = nrow(obj), cols = ncol(obj)),
    type = typeof(obj),
    preview = if (nrow(obj) <= 20 && ncol(obj) <= 20) obj
              else obj[seq_len(min(20, nrow(obj))), seq_len(min(20, ncol(obj)))]
  )
}

# ---- summary.lm -------------------------------------------------------------

format_summary_lm <- function(obj) {
  coefs <- as.data.frame(obj$coefficients)
  names(coefs) <- c("estimate", "std_error", "t_value", "p_value")

  list(
    class = "summary.lm",
    coefficients = coefs,
    r_squared = obj$r.squared,
    adj_r_squared = obj$adj.r.squared,
    f_statistic = if (!is.null(obj$fstatistic)) list(
      value = obj$fstatistic[1],
      numdf = obj$fstatistic[2],
      dendf = obj$fstatistic[3]
    ) else NULL,
    residual_se = obj$sigma,
    residuals_summary = as.list(summary(obj$residuals))
  )
}

# ---- summary.glm ------------------------------------------------------------

format_summary_glm <- function(obj) {
  base <- format_summary_lm(obj)
  base$class <- "summary.glm"
  base$r_squared <- NULL
  base$adj_r_squared <- NULL
  base$deviance <- obj$deviance
  base$null_deviance <- obj$null.deviance
  base$aic <- obj$aic
  base$dispersion <- obj$dispersion
  base
}

# ---- Numeric vector ---------------------------------------------------------

format_numeric <- function(obj) {
  if (length(obj) <= 100) {
    list(class = "numeric", length = length(obj), values = as.numeric(obj))
  } else {
    list(
      class = "numeric",
      length = length(obj),
      summary = as.list(summary(obj)),
      head = utils::head(as.numeric(obj), 20)
    )
  }
}

# ---- Table ------------------------------------------------------------------

format_table <- function(obj) {
  list(
    class = "table",
    dimensions = dim(obj),
    values = as.data.frame(obj)
  )
}

# ---- Density ----------------------------------------------------------------

format_density <- function(obj) {
  list(
    class = "density",
    n = obj$n,
    bandwidth = obj$bw,
    data_name = obj$data.name,
    range = c(min(obj$x), max(obj$x))
  )
}

# ---- Default Fallback -------------------------------------------------------

format_default <- function(obj) {
  # Try to convert to list; if that fails, capture print output
  result <- tryCatch(
    {
      lst <- as.list(obj)
      list(class = class(obj)[1], content = lst)
    },
    error = function(e) {
      output <- paste(utils::capture.output(print(obj)), collapse = "\n")
      # Truncate very large outputs
      if (nchar(output) > 10000) {
        output <- paste0(substr(output, 1, 10000), "\n... (truncated)")
      }
      list(class = class(obj)[1], text_output = output)
    }
  )
  result
}

# ---- JSON Safety ------------------------------------------------------------
# Handle NaN, Inf, -Inf, NA which jsonlite handles via na/null args

safe_json_value <- function(x) {
  if (is.numeric(x)) {
    x[is.nan(x)] <- NA
    x[is.infinite(x)] <- NA
  }
  x
}
