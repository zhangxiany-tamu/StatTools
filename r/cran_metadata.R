#!/usr/bin/env Rscript
# ============================================================================
# StatTools — CRAN Package Metadata Extractor
# ============================================================================
# Outputs NDJSON (one line per package) with title + description from
# tools::CRAN_package_db(). This is the only reliable source for
# Title and Description of ALL CRAN packages.
# ============================================================================

library(jsonlite)

`%||%` <- function(a, b) if (is.null(a) || is.na(a)) b else a

cat('{"status":"fetching_cran_db"}', "\n", sep = "", file = stderr())
db <- tools::CRAN_package_db()
cat(paste0('{"status":"fetched","count":', nrow(db), '}'), "\n", sep = "", file = stderr())

for (i in seq_len(nrow(db))) {
  entry <- list(
    name = db$Package[i] %||% "",
    version = db$Version[i] %||% "",
    title = gsub("\\s+", " ", trimws(db$Title[i] %||% "")),
    description = gsub("\\s+", " ", trimws(db$Description[i] %||% "")),
    depends = db$Depends[i] %||% "",
    imports = db$Imports[i] %||% ""
  )
  cat(toJSON(entry, auto_unbox = TRUE), "\n", sep = "")
}

cat('{"status":"done"}', "\n", sep = "", file = stderr())
