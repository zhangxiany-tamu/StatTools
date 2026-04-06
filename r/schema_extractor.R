#!/usr/bin/env Rscript
# ============================================================================
# StatTools — Schema Extractor
# ============================================================================
# Extracts function metadata from installed R packages and outputs NDJSON
# (one JSON object per line) to stdout.
#
# Usage: Rscript schema_extractor.R [package_names...]
# If no packages specified, extracts from all installed packages.
#
# Each line: {"package":"stats","function":"lm","title":"...","description":"...","has_formula":true,"has_dots":true}
# ============================================================================

library(jsonlite)

extract_package_functions <- function(pkg) {
  # Skip packages that can't be loaded
  if (!requireNamespace(pkg, quietly = TRUE)) return(NULL)

  # Get exported functions
  ns <- tryCatch(getNamespaceExports(pkg), error = function(e) character(0))
  if (length(ns) == 0) return(NULL)

  # Filter to actual functions
  fns <- character(0)
  for (nm in ns) {
    obj <- tryCatch(getExportedValue(pkg, nm), error = function(e) NULL)
    if (is.function(obj)) {
      fns <- c(fns, nm)
    }
  }
  if (length(fns) == 0) return(NULL)

  # Get .Rd documentation database
  rd_db <- tryCatch(tools::Rd_db(pkg), error = function(e) list())

  # Build alias → Rd object mapping. Many .Rd files document multiple functions
  # via \alias{}, so fn_name.Rd often doesn't exist for aliased functions.
  alias_map <- list()
  for (rd_name in names(rd_db)) {
    rd_obj <- rd_db[[rd_name]]
    aliases <- tryCatch(
      tools:::.Rd_get_metadata(rd_obj, "alias"),
      error = function(e) character(0)
    )
    for (a in aliases) {
      alias_map[[a]] <- rd_obj
    }
  }

  results <- vector("list", length(fns))
  for (i in seq_along(fns)) {
    fn_name <- fns[i]
    fn_obj <- tryCatch(getExportedValue(pkg, fn_name), error = function(e) NULL)
    if (is.null(fn_obj)) next

    # Get formals
    fmls <- tryCatch(formals(fn_obj), error = function(e) {
      tryCatch(formals(args(fn_obj)), error = function(e2) NULL)
    })

    has_formula <- any(grepl("formula", names(fmls), ignore.case = TRUE))
    has_dots <- "..." %in% names(fmls)

    # Get title and description from .Rd — try alias map first, then fn_name.Rd
    title <- ""
    description <- ""
    rd_obj <- alias_map[[fn_name]]
    if (is.null(rd_obj)) rd_obj <- rd_db[[paste0(fn_name, ".Rd")]]
    if (!is.null(rd_obj)) {
      title <- tryCatch({
        t <- tools:::.Rd_get_metadata(rd_obj, "title")
        if (length(t) > 0) gsub("\\s+", " ", trimws(t[1])) else ""
      }, error = function(e) "")

      description <- tryCatch({
        d <- tools:::.Rd_get_metadata(rd_obj, "description")
        if (length(d) > 0) {
          clean <- gsub("\\s+", " ", trimws(paste(d, collapse = " ")))
          substr(clean, 1, 500)
        } else ""
      }, error = function(e) "")
    }

    results[[i]] <- list(
      package = pkg,
      function_name = fn_name,
      title = title,
      description = description,
      has_formula = has_formula,
      has_dots = has_dots
    )
  }

  # Remove NULLs
  results <- Filter(Negate(is.null), results)
  results
}

# ---- Main -------------------------------------------------------------------

args <- commandArgs(trailingOnly = TRUE)

if (length(args) == 0) {
  # Extract from all installed packages
  pkgs <- sort(installed.packages()[, "Package"])
} else {
  pkgs <- args
}

# Output NDJSON to stdout
for (pkg in pkgs) {
  cat(paste0('{"status":"extracting","package":"', pkg, '"}'), "\n",
      sep = "", file = stderr())

  results <- tryCatch(
    extract_package_functions(pkg),
    error = function(e) NULL
  )

  if (!is.null(results)) {
    for (entry in results) {
      line <- toJSON(entry, auto_unbox = TRUE, null = "null")
      cat(line, "\n", sep = "")
    }
  }
}

cat('{"status":"done"}', "\n", sep = "", file = stderr())
