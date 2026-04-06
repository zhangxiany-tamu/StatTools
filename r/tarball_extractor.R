#!/usr/bin/env Rscript
# ============================================================================
# StatTools — Tarball Extractor
# ============================================================================
# Extracts function metadata from CRAN source tarballs WITHOUT installing.
# Parses man/*.Rd files with tools::parse_Rd() and NAMESPACE for exports.
#
# Usage: Rscript tarball_extractor.R /path/to/extracted/pkg1 [/path/to/pkg2 ...]
# Output: NDJSON to stdout (same format as schema_extractor.R)
# ============================================================================

library(jsonlite)

# ---- Rd AST helper: flatten to plain text -----------------------------------

flatten_rd <- function(rd_nodes) {
  # Recursively extract text content from Rd AST nodes
  text_parts <- character(0)
  for (node in rd_nodes) {
    if (is.character(node)) {
      text_parts <- c(text_parts, node)
    } else if (is.list(node)) {
      tag <- attr(node, "Rd_tag")
      # Skip code blocks and internal markup
      if (!is.null(tag) && tag %in% c("\\code", "\\pkg", "\\sQuote",
                                        "\\dQuote", "\\emph", "\\bold",
                                        "\\link", "\\url", "\\href")) {
        text_parts <- c(text_parts, flatten_rd(node))
      } else if (!is.null(tag) && tag %in% c("\\R", "\\dots")) {
        text_parts <- c(text_parts, if (tag == "\\R") "R" else "...")
      } else {
        text_parts <- c(text_parts, flatten_rd(node))
      }
    }
  }
  paste(text_parts, collapse = "")
}

get_rd_section_text <- function(rd_obj, section_name) {
  for (node in rd_obj) {
    tag <- attr(node, "Rd_tag")
    if (!is.null(tag) && tag == paste0("\\", section_name)) {
      text <- flatten_rd(node)
      return(gsub("\\s+", " ", trimws(text)))
    }
  }
  ""
}

# ---- Parse NAMESPACE for exported symbols -----------------------------------

parse_exports <- function(namespace_path) {
  if (!file.exists(namespace_path)) return(NULL)

  lines <- readLines(namespace_path, warn = FALSE)
  exports <- character(0)
  has_export_pattern <- FALSE

  for (line in lines) {
    line <- trimws(line)
    if (startsWith(line, "#")) next

    # export(foo) or export(foo, bar, baz)
    m <- regmatches(line, gregexpr('export\\(([^)]+)\\)', line))[[1]]
    for (match in m) {
      inner <- sub('export\\((.+)\\)', '\\1', match)
      syms <- trimws(strsplit(inner, ",")[[1]])
      syms <- gsub('"', '', syms)
      syms <- gsub("'", '', syms)
      exports <- c(exports, syms)
    }

    # S3method(generic, class) -> generic.class
    m3 <- regmatches(line, gregexpr('S3method\\(([^)]+)\\)', line))[[1]]
    for (match in m3) {
      inner <- sub('S3method\\((.+)\\)', '\\1', match)
      parts <- trimws(strsplit(inner, ",")[[1]])
      parts <- gsub('"', '', parts)
      parts <- gsub("'", '', parts)
      if (length(parts) >= 2) {
        exports <- c(exports, paste0(parts[1], ".", parts[2]))
      }
    }

    # exportPattern — flag that we should be permissive
    if (grepl('exportPattern', line)) {
      has_export_pattern <- TRUE
    }
  }

  list(exports = unique(exports), has_pattern = has_export_pattern)
}

# ---- Extract functions from a single package directory ----------------------

extract_tarball_functions <- function(pkg_dir) {
  pkg_name <- basename(pkg_dir)
  man_dir <- file.path(pkg_dir, "man")
  namespace_path <- file.path(pkg_dir, "NAMESPACE")

  if (!dir.exists(man_dir)) return(NULL)

  # Parse NAMESPACE
  ns_info <- parse_exports(namespace_path)
  export_set <- if (!is.null(ns_info)) ns_info$exports else character(0)
  has_pattern <- if (!is.null(ns_info)) ns_info$has_pattern else TRUE

  # List all .Rd files
  rd_files <- list.files(man_dir, pattern = "\\.Rd$", full.names = TRUE)
  if (length(rd_files) == 0) return(NULL)

  # Parse each .Rd file and build alias -> metadata mapping
  results <- list()
  for (rd_file in rd_files) {
    rd_obj <- tryCatch(
      tools::parse_Rd(rd_file),
      error = function(e) NULL,
      warning = function(w) {
        suppressWarnings(tryCatch(tools::parse_Rd(rd_file), error = function(e) NULL))
      }
    )
    if (is.null(rd_obj)) next

    # Extract metadata
    aliases <- tryCatch(
      tools:::.Rd_get_metadata(rd_obj, "alias"),
      error = function(e) character(0)
    )
    if (length(aliases) == 0) next

    title <- tryCatch({
      get_rd_section_text(rd_obj, "title")
    }, error = function(e) "")

    description <- tryCatch({
      d <- get_rd_section_text(rd_obj, "description")
      substr(d, 1, 500)
    }, error = function(e) "")

    # Extract argument names from \arguments section to detect formula and ...
    has_formula <- FALSE
    has_dots <- FALSE
    args_section <- tryCatch({
      tools:::.Rd_get_section(rd_obj, "arguments")
    }, error = function(e) NULL)

    if (!is.null(args_section)) {
      # Walk the Rd AST looking for \item tags
      arg_names <- character(0)
      for (node in args_section) {
        if (is.list(node) && !is.null(attr(node, "Rd_tag"))) {
          if (attr(node, "Rd_tag") == "\\item" && length(node) >= 1) {
            # First element of \item is the argument name
            arg_text <- paste(unlist(node[[1]]), collapse = "")
            arg_names <- c(arg_names, trimws(arg_text))
          }
        }
      }
      has_formula <- any(grepl("formula", arg_names, ignore.case = TRUE))
      has_dots <- any(arg_names == "\\dots" | arg_names == "...")
    }

    # Emit one entry per alias that is exported
    for (alias in aliases) {
      # Check if exported: either in explicit export list, or exportPattern is used
      is_exported <- (alias %in% export_set) || has_pattern
      if (!is_exported) next

      # Skip internal-looking names (start with .)
      if (startsWith(alias, ".")) next

      results[[length(results) + 1]] <- list(
        package = pkg_name,
        function_name = alias,
        title = title,
        description = description,
        has_formula = has_formula,
        has_dots = has_dots,
        source = "tarball"
      )
    }
  }

  results
}

# ---- Main -------------------------------------------------------------------

args <- commandArgs(trailingOnly = TRUE)
if (length(args) == 0) {
  cat("Usage: Rscript tarball_extractor.R /path/to/pkg1 [/path/to/pkg2 ...]\n",
      file = stderr())
  quit(status = 1)
}

total <- 0
for (pkg_dir in args) {
  pkg_name <- basename(pkg_dir)
  cat(paste0('{"status":"extracting","package":"', pkg_name, '"}'), "\n",
      sep = "", file = stderr())

  results <- tryCatch(
    extract_tarball_functions(pkg_dir),
    error = function(e) {
      cat(paste0('{"status":"error","package":"', pkg_name,
                 '","message":"', gsub('"', '\\\\"', conditionMessage(e)), '"}'),
          "\n", sep = "", file = stderr())
      NULL
    }
  )

  if (!is.null(results) && length(results) > 0) {
    for (entry in results) {
      line <- toJSON(entry, auto_unbox = TRUE, null = "null")
      cat(line, "\n", sep = "")
    }
    total <- total + length(results)
  }
}

cat(paste0('{"status":"done","total":', total, '}'), "\n",
    sep = "", file = stderr())
