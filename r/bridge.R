# ============================================================================
# StatTools — R Worker Bridge
# ============================================================================
# Persistent R subprocess. Reads NDJSON from stdin, dispatches, writes NDJSON
# to stdout. Keeps packages, data, and model objects loaded between calls.
#
# Protocol: one JSON object per line on stdin, one JSON object per line on stdout.
# stderr is captured internally (not piped to parent).
# ============================================================================

library(jsonlite)

# Load companion modules
# Priority: STATTOOLS_BRIDGE_DIR env var (set by TypeScript) > --file= arg > "."
bridge_dir <- Sys.getenv("STATTOOLS_BRIDGE_DIR", unset = "")
if (nchar(bridge_dir) == 0) {
  bridge_dir <- tryCatch({
    args <- commandArgs(trailingOnly = FALSE)
    file_arg <- grep("^--file=", args, value = TRUE)
    if (length(file_arg) > 0) {
      dirname(sub("^--file=", "", file_arg[1]))
    } else {
      "."
    }
  }, error = function(e) ".")
}
source(file.path(bridge_dir, "session_env.R"))
source(file.path(bridge_dir, "formatters.R"))

# ---- Response Helpers -------------------------------------------------------

send_response <- function(resp) {
  tryCatch({
    json <- toJSON(resp, auto_unbox = TRUE, null = "null", na = "string",
                   force = TRUE, pretty = FALSE)
    cat(json, "\n", sep = "")
    flush(stdout())
  }, error = function(e) {
    # Fallback: send minimal error if toJSON fails
    cat(paste0('{"id":', resp$id %||% -1, ',"error":{"code":98,"message":"toJSON failed: ',
               gsub('"', '\\\\"', conditionMessage(e)), '"}}'), "\n", sep = "")
    flush(stdout())
  })
}

error_response <- function(id, code, message, suggestion = NULL, traceback = NULL) {
  resp <- list(id = id, error = list(code = code, message = message))
  if (!is.null(suggestion)) resp$error$suggestion <- suggestion
  if (!is.null(traceback)) resp$error$traceback <- traceback
  resp
}

# ---- Dispatch ---------------------------------------------------------------

dispatch <- function(req) {
  id <- req$id %||% -1L
  method <- req$method %||% ""
  params <- req$params %||% list()

  tryCatch(
    switch(method,
      "call"         = dispatch_call(id, params),
      "load_data"    = dispatch_load_data(id, params),
      "schema"       = dispatch_schema(id, params),
      "inspect"      = dispatch_inspect(id, params),
      "persist"      = dispatch_persist(id, params),
      "restore"      = dispatch_restore(id, params),
      "list_objects"     = dispatch_list_objects(id, params),
      "extract_columns"  = dispatch_extract_columns(id, params),
      "render_plot"      = dispatch_render_plot(id, params),
      error_response(id, -1L, paste0("Unknown method: ", method))
    ),
    error = function(e) {
      error_response(id, 1L, conditionMessage(e),
                     traceback = paste(limitedTraceback(), collapse = "\n"))
    }
  )
}

# ---- Method: call -----------------------------------------------------------

dispatch_call <- function(id, params) {
  pkg <- params$package %||% params$pkg
  fn <- params[["function"]] %||% params$fn
  args <- params$args %||% list()
  assign_to <- params$assign_to

  # Validate package
  if (is.null(pkg) || is.null(fn)) {
    return(error_response(id, 2L, "Missing 'package' or 'function' parameter"))
  }

  # Load package if needed
  if (!isNamespaceLoaded(pkg)) {
    if (!requireNamespace(pkg, quietly = TRUE)) {
      return(error_response(id, 3L,
        paste0("Package '", pkg, "' is not installed"),
        suggestion = "Use stat_install to install it first"))
    }
  }

  # Get function (try package namespace first, then base/global for generics)
  f <- tryCatch(
    getExportedValue(pkg, fn),
    error = function(e) {
      # Fallback: some generics (summary, print, plot) live in base
      tryCatch(get(fn, envir = baseenv()), error = function(e2) NULL)
    }
  )
  if (is.null(f) || !is.function(f)) {
    return(error_response(id, 2L,
      paste0("Function '", fn, "' not found in package '", pkg, "'"),
      suggestion = "Use stat_search to find the correct function name"))
  }

  # Resolve object references in args
  args <- resolve_refs(args, id)
  if (is.list(args) && isTRUE(args$is_ref_error)) return(args$response)

  # Convert formula strings
  for (nm in names(args)) {
    if (nm == "formula" || grepl("formula", nm, ignore.case = TRUE)) {
      if (is.character(args[[nm]])) {
        args[[nm]] <- tryCatch(
          as.formula(args[[nm]], env = .ss),
          error = function(e) {
            return(NULL)
          }
        )
        if (is.null(args[[nm]])) {
          return(error_response(id, 5L,
            paste0("Invalid formula: '", params$args[[nm]], "'"),
            suggestion = "Use R formula syntax, e.g. 'y ~ x1 + x2'"))
        }
      }
    }
  }

  # Validate formula columns against data if both present
  validation <- validate_formula_columns(args)
  if (!is.null(validation)) {
    return(error_response(id, 5L, validation$message, suggestion = validation$suggestion))
  }

  # Execute with warning capture
  warnings_list <- character(0)
  result <- tryCatch(
    withCallingHandlers(
      do.call(f, args),
      warning = function(w) {
        warnings_list <<- c(warnings_list, conditionMessage(w))
        invokeRestart("muffleWarning")
      }
    ),
    error = function(e) {
      return(error_response(id, 1L, conditionMessage(e),
        suggestion = generate_suggestion(e, pkg, fn, args),
        traceback = paste(limitedTraceback(), collapse = "\n")))
    }
  )

  # If result is an error response, return it
  if (is.list(result) && !is.null(result$error)) return(result)

  # Assign to session if requested
  objects_created <- list()
  if (!is.null(assign_to) || should_auto_assign(result)) {
    ref_id <- assign_to %||% auto_ref_id(result)
    assign(ref_id, result, envir = .ss)
    meta <- make_object_summary(result, ref_id)
    register_object(meta$id, meta$type, meta$rClass,
                    meta$sizeBytes, meta$summary, meta$schema)
    objects_created <- list(meta)
  }

  # Format result
  formatted <- format_for_json(result)

  resp <- list(id = id, result = formatted)
  if (length(warnings_list) > 0) resp$warnings <- warnings_list
  if (length(objects_created) > 0) resp$objectsCreated <- objects_created
  resp
}

# ---- Method: load_data ------------------------------------------------------

dispatch_load_data <- function(id, params) {
  file_path <- params$file_path
  name <- params$name
  sep <- params$separator

  if (is.null(file_path)) {
    return(error_response(id, 2L, "Missing 'file_path' parameter"))
  }
  if (!file.exists(file_path)) {
    return(error_response(id, 4L, paste0("File not found: ", file_path)))
  }

  # Auto-detect format
  ext <- tolower(tools::file_ext(file_path))
  data <- tryCatch({
    if (ext == "rds") {
      readRDS(file_path)
    } else if (ext == "tsv" || (!is.null(sep) && sep == "\t")) {
      read.csv(file_path, sep = "\t", stringsAsFactors = FALSE)
    } else if (ext == "csv" || ext == "") {
      read.csv(file_path, sep = if (!is.null(sep)) sep else ",",
               stringsAsFactors = FALSE)
    } else {
      read.csv(file_path, stringsAsFactors = FALSE)
    }
  }, error = function(e) {
    return(error_response(id, 1L, paste0("Failed to read file: ", conditionMessage(e))))
  })

  if (is.list(data) && !is.null(data$error)) return(data)

  # Generate reference ID
  ref_id <- name %||% tools::file_path_sans_ext(basename(file_path))
  # Sanitize: replace non-alphanumeric with underscore
  ref_id <- gsub("[^a-zA-Z0-9_]", "_", ref_id)

  assign(ref_id, data, envir = .ss)
  meta <- make_object_summary(data, ref_id)
  register_object(meta$id, meta$type, meta$rClass,
                  meta$sizeBytes, meta$summary, meta$schema)

  formatted <- format_for_json(data)
  formatted$object_id <- ref_id

  list(id = id, result = formatted, objectsCreated = list(meta))
}

# ---- Method: schema ---------------------------------------------------------

dispatch_schema <- function(id, params) {
  pkg <- params$package
  fn <- params[["function"]]

  if (is.null(pkg) || is.null(fn)) {
    return(error_response(id, 2L, "Missing 'package' or 'function'"))
  }

  if (!requireNamespace(pkg, quietly = TRUE)) {
    return(error_response(id, 3L, paste0("Package '", pkg, "' not installed")))
  }

  f <- tryCatch(getExportedValue(pkg, fn), error = function(e) NULL)
  if (is.null(f) || !is.function(f)) {
    return(error_response(id, 2L, paste0("'", fn, "' not found in '", pkg, "'")))
  }

  fmls <- formals(f)
  if (is.null(fmls)) fmls <- formals(args(f))

  # Get Rd documentation
  arg_docs <- tryCatch({
    rd_db <- tools::Rd_db(pkg)
    rd_file <- rd_db[[paste0(fn, ".Rd")]]
    if (!is.null(rd_file)) parse_rd_arguments(rd_file) else list()
  }, error = function(e) list())

  # Build JSON Schema properties
  properties <- list()
  required <- character(0)

  for (nm in names(fmls)) {
    if (nm == "...") next

    default_val <- fmls[[nm]]
    prop <- list()

    # Infer type from default value
    # Note: default_val can be missing symbol (no default), a value, or an expression
    is_missing_default <- tryCatch(
      identical(default_val, quote(expr = )) || is.name(default_val),
      error = function(e) TRUE
    )

    if (is_missing_default) {
      prop$type <- "string"
      required <- c(required, nm)
    } else if (is.numeric(default_val) && length(default_val) == 1) {
      prop$type <- "number"
      prop$default <- default_val
    } else if (is.logical(default_val) && length(default_val) == 1) {
      prop$type <- "boolean"
      prop$default <- default_val
    } else if (is.character(default_val) && length(default_val) > 1) {
      # match.arg pattern: enum
      prop$type <- "string"
      prop$enum <- as.character(default_val)
      prop$default <- default_val[1]
    } else if (is.character(default_val) && length(default_val) == 1) {
      prop$type <- "string"
      prop$default <- default_val
    } else if (is.null(default_val)) {
      prop$type <- "string"
      prop$default <- NULL
    } else {
      # Expression or complex default — treat as string, not required
      prop$type <- "string"
    }

    # Override for formula parameters
    if (nm == "formula" || grepl("formula", nm, ignore.case = TRUE)) {
      prop$type <- "string"
      prop$description <- paste0(
        arg_docs[[nm]] %||% "Model formula",
        " (R formula syntax, e.g. 'y ~ x1 + x2')"
      )
    } else {
      prop$description <- arg_docs[[nm]] %||% ""
    }

    properties[[nm]] <- prop
  }

  has_dots <- "..." %in% names(fmls)

  # I() forces jsonlite to serialize as array even with length 1
  schema <- list(
    type = "object",
    properties = properties,
    required = I(required)
  )
  if (has_dots) schema$additionalProperties <- TRUE

  list(id = id, result = list(
    package = pkg,
    function_name = fn,
    schema = schema,
    has_dots = has_dots,
    typical_return_class = tryCatch({
      # Quick heuristic: check .Rd \value section or use known mappings
      NULL
    }, error = function(e) NULL)
  ))
}

# ---- Method: inspect --------------------------------------------------------

dispatch_inspect <- function(id, params) {
  obj_id <- params$object %||% params$handle
  if (is.null(obj_id)) {
    return(error_response(id, 2L, "Missing 'object' parameter"))
  }
  if (!exists(obj_id, envir = .ss, inherits = FALSE)) {
    available <- paste(ls(envir = .ss), collapse = ", ")
    return(error_response(id, 4L,
      paste0("Object '", obj_id, "' not found. Available: ", available)))
  }

  obj <- get(obj_id, envir = .ss, inherits = FALSE)
  formatted <- format_for_json(obj)
  list(id = id, result = formatted)
}

# ---- Method: persist --------------------------------------------------------

dispatch_persist <- function(id, params) {
  handle_ids <- params$handles %||% character(0)
  session_dir <- params$session_dir
  if (is.null(session_dir)) {
    return(error_response(id, 2L, "Missing 'session_dir'"))
  }

  failed <- persist_handles(handle_ids, session_dir)
  list(id = id, result = list(persisted = setdiff(handle_ids, failed)),
       persistFailed = if (length(failed) > 0) failed else NULL)
}

# ---- Method: restore --------------------------------------------------------

dispatch_restore <- function(id, params) {
  session_dir <- params$session_dir
  if (is.null(session_dir)) {
    return(error_response(id, 2L, "Missing 'session_dir'"))
  }

  restored <- restore_handles(session_dir)
  list(id = id, result = list(restored = restored))
}

# ---- Method: list_objects ---------------------------------------------------

dispatch_list_objects <- function(id, params) {
  objects <- list_objects()
  list(id = id, result = list(
    objects = objects,
    loaded_packages = loadedNamespaces(),
    r_version = paste0(R.version$major, ".", R.version$minor)
  ))
}

# ---- Extract Columns / Build Matrix -----------------------------------------

dispatch_extract_columns <- function(id, params) {
  obj_id <- params$object %||% params$handle
  columns <- params$columns  # character vector of column names
  assign_to <- params$assign_to
  as_matrix <- isTRUE(params$as_matrix)

  if (is.null(obj_id) || !exists(obj_id, envir = .ss, inherits = FALSE)) {
    available <- paste(ls(envir = .ss), collapse = ", ")
    return(error_response(id, 4L,
      paste0("Object '", obj_id, "' not found. Available: ",
             if (nchar(available) > 0) available else "(none)")))
  }

  obj <- get(obj_id, envir = .ss, inherits = FALSE)
  if (!is.data.frame(obj)) {
    return(error_response(id, 2L,
      paste0("'", obj_id, "' is not a data frame (class: ", class(obj)[1], ")")))
  }

  # Convert from JSON array (list) to character vector
  columns <- unlist(columns)
  if (is.null(columns) || length(columns) == 0) {
    return(error_response(id, 2L, "Missing 'columns' parameter"))
  }

  # Check for missing columns
  missing <- setdiff(columns, names(obj))
  if (length(missing) > 0) {
    return(error_response(id, 5L,
      paste0("Columns not found: ", paste(missing, collapse = ", ")),
      suggestion = paste0("Available: ", paste(names(obj), collapse = ", "))))
  }

  # Extract
  if (length(columns) == 1 && !as_matrix) {
    result <- obj[[columns]]
    r_class <- "numeric"
    type <- "data"
    summary_text <- paste0(obj_id, "$", columns, " (", length(result), " values)")
  } else {
    result <- obj[, columns, drop = FALSE]
    if (as_matrix) {
      result <- as.matrix(result)
      r_class <- "matrix"
      summary_text <- paste0(obj_id, "[", paste(columns, collapse = ","), "] (", nrow(result), "x", ncol(result), " matrix)")
    } else {
      r_class <- "data.frame"
      summary_text <- paste0(obj_id, "[", paste(columns, collapse = ","), "] (", nrow(result), "x", ncol(result), ")")
    }
    type <- "data"
  }

  # Assign to session
  ref_id <- assign_to %||% paste0(obj_id, "_", paste(columns[1:min(2, length(columns))], collapse = "_"))
  assign(ref_id, result, envir = .ss)
  size <- as.numeric(object.size(result))
  register_object(ref_id, type, r_class, size, summary_text)

  # Format preview
  formatted <- format_for_json(result)

  list(id = id,
    result = list(
      object_id = ref_id,
      class = r_class,
      dimensions = if (is.matrix(result) || is.data.frame(result))
        list(rows = nrow(result), cols = ncol(result))
      else list(length = length(result)),
      preview = formatted
    ),
    objectsCreated = list(list(
      id = ref_id, type = type, rClass = r_class,
      sizeBytes = size, summary = summary_text
    ))
  )
}

# ---- Render Plot to File ----------------------------------------------------

dispatch_render_plot <- function(id, params) {
  # Accepts either:
  # 1. object: handle ID of a ggplot/recordedplot object
  # 2. expression: R expression string that produces a plot
  obj_id <- params$object
  expr_str <- params$expression
  file_format <- params$format %||% "png"
  width <- params$width %||% 800
  height <- params$height %||% 600
  dpi <- params$dpi %||% 150

  if (is.null(obj_id) && is.null(expr_str)) {
    return(error_response(id, 2L, "Provide either 'object' (handle ID) or 'expression' (R code that produces a plot)"))
  }

  # Create output path — use output_dir from params if provided, else tempdir
  out_dir <- params$output_dir %||% file.path(tempdir(), "stattools", "plots")
  dir.create(out_dir, recursive = TRUE, showWarnings = FALSE)
  out_file <- file.path(out_dir, paste0("plot_", format(Sys.time(), "%Y%m%d_%H%M%S"), "_", sample(1000:9999, 1), ".", file_format))

  if (!file_format %in% c("png", "pdf", "svg")) {
    return(error_response(id, 2L, paste0("Unsupported format: ", file_format, ". Use png, pdf, or svg.")))
  }

  if (!is.null(obj_id) && !exists(obj_id, envir = .ss, inherits = FALSE)) {
    return(error_response(id, 4L, paste0("Object '", obj_id, "' not found in session")))
  }

  plot_err <- tryCatch({
    # Open device (grDevices may not be attached in vanilla Rscript)
    if (file_format == "png") {
      grDevices::png(out_file, width = width, height = height, res = dpi)
    } else if (file_format == "pdf") {
      grDevices::pdf(out_file, width = width / 72, height = height / 72)
    } else {
      grDevices::svg(out_file, width = width / 72, height = height / 72)
    }

    if (!is.null(obj_id)) {
      obj <- get(obj_id, envir = .ss, inherits = FALSE)
      if (inherits(obj, "ggplot") || inherits(obj, "gg")) {
        print(obj)
      } else if (inherits(obj, "recordedplot")) {
        replayPlot(obj)
      } else {
        print(obj)
      }
    } else {
      # Ensure base R plotting packages are available in the evaluation
      require(graphics, quietly = TRUE)
      require(grDevices, quietly = TRUE)
      require(stats, quietly = TRUE)
      # print() the result — required for ggplot objects which don't auto-render
      plot_result <- eval(parse(text = expr_str), envir = .ss)
      if (inherits(plot_result, "ggplot") || inherits(plot_result, "gg")) {
        print(plot_result)
      }
    }

    grDevices::dev.off()
    NULL  # no error
  }, error = function(e) {
    tryCatch(grDevices::dev.off(), error = function(e2) NULL)
    conditionMessage(e)
  })

  if (!is.null(plot_err)) {
    return(error_response(id, 1L,
      paste0("Plot rendering failed: ", plot_err),
      suggestion = "Check that the expression produces a valid plot"))
  }

  if (!file.exists(out_file)) {
    return(error_response(id, 1L, "Plot file was not created"))
  }

  file_size <- file.info(out_file)$size

  list(id = id, result = list(
    file_path = out_file,
    format = file_format,
    width = width,
    height = height,
    file_size_bytes = file_size,
    message = paste0("Plot saved to: ", out_file)
  ))
}

# ---- Helper Functions -------------------------------------------------------

resolve_refs <- function(args, id = -1L) {
  # Resolve any string argument that matches the name of an object in .ss
  session_objects <- ls(envir = .ss)
  for (nm in names(args)) {
    val <- args[[nm]]
    if (is.character(val) && length(val) == 1 && val %in% session_objects) {
      args[[nm]] <- get(val, envir = .ss, inherits = FALSE)
    }
  }
  # Check for likely object refs that don't exist (data, model, pred, test prefixed,
  # OR any value that was registered via register_object)
  registered_ids <- names(.ss_meta$objects)
  for (nm in names(args)) {
    val <- args[[nm]]
    # If arg is still a string and looks like it was meant to be a ref
    # (matches a registered ID pattern or the parameter name suggests it)
    if (is.character(val) && length(val) == 1 &&
        nm %in% c("data", "object", "model", "newdata", "x", "y") &&
        !(val %in% session_objects) &&
        !file.exists(val) &&
        !grepl("[~=+\n]", val)) {  # Skip strings that look like formulas/syntax, not refs
      available <- paste(session_objects, collapse = ", ")
      return(list(
        is_ref_error = TRUE,
        response = error_response(id, 4L,
          paste0("Object '", val, "' not found in session. Available: ",
                 if (nchar(available) > 0) available else "(none)"),
          suggestion = "Use stat_load_data to load data first")
      ))
    }
  }
  args
}

validate_formula_columns <- function(args) {
  if (is.null(args$formula) || !inherits(args$formula, "formula")) return(NULL)
  data_obj <- args$data
  if (is.null(data_obj) || !is.data.frame(data_obj)) return(NULL)

  formula_vars <- all.vars(args$formula)
  missing_cols <- setdiff(formula_vars, names(data_obj))

  if (length(missing_cols) > 0) {
    return(list(
      message = paste0("Column(s) not found in data: ",
                       paste(missing_cols, collapse = ", ")),
      suggestion = paste0("Available columns: ",
                          paste(names(data_obj), collapse = ", "))
    ))
  }
  NULL
}

generate_suggestion <- function(e, pkg, fn, args) {
  msg <- conditionMessage(e)

  if (grepl("object '.*' not found", msg)) {
    var <- regmatches(msg, regexpr("'[^']+'", msg))
    return(paste0("Variable ", var, " not found. Check column names in your data."))
  }
  if (grepl("unused argument", msg)) {
    return("Check argument names — use stat_resolve to see valid parameters.")
  }
  if (grepl("0 \\(non-NA\\) cases", msg)) {
    return("All rows have NA in formula columns. Check data with stat_describe.")
  }
  if (grepl("singular", msg, ignore.case = TRUE)) {
    return("Possible multicollinearity. Try removing correlated predictors.")
  }
  if (grepl("not found", msg) && grepl("package", msg, ignore.case = TRUE)) {
    return("Package may not be installed. Use stat_install.")
  }
  NULL
}

should_auto_assign <- function(result) {
  inherits(result, "lm") || inherits(result, "glm") || inherits(result, "nls") ||
  inherits(result, "htest") || inherits(result, "anova") ||
  inherits(result, "lmerMod") || inherits(result, "coxph") ||
  inherits(result, "survfit") || inherits(result, "prcomp") ||
  inherits(result, "kmeans")
}

auto_ref_id <- function(result) {
  type <- infer_handle_type(result)
  # Use a simple counter based on existing objects
  existing <- ls(envir = .ss)
  prefix <- switch(type,
    "model" = "model",
    "test_result" = "test",
    "prediction" = "pred",
    "data" = "data",
    "generic"
  )
  n <- sum(grepl(paste0("^", prefix, "_\\d+$"), existing)) + 1
  paste0(prefix, "_", n)
}

limitedTraceback <- function(n = 5) {
  tb <- sys.calls()
  if (length(tb) > n) tb <- utils::tail(tb, n)
  vapply(tb, function(x) deparse(x, width.cutoff = 80)[1], character(1))
}

parse_rd_arguments <- function(rd) {
  # Extract \arguments{\item{name}{description}} from Rd object
  result <- list()
  tryCatch({
    txt <- paste(capture.output(tools::Rd2txt(rd, fragment = TRUE)), collapse = "\n")
    # Simple regex extraction — not perfect but sufficient
    matches <- gregexpr("\\\\item\\{([^}]+)\\}\\{([^}]+)\\}", txt)
    if (length(matches) > 0) {
      m <- regmatches(txt, matches)[[1]]
      for (match in m) {
        parts <- regmatches(match, gregexpr("\\{([^}]+)\\}", match))[[1]]
        if (length(parts) >= 2) {
          name <- gsub("[{}]", "", parts[1])
          desc <- gsub("[{}]", "", parts[2])
          result[[name]] <- trimws(desc)
        }
      }
    }
  }, error = function(e) {})
  result
}

# Null-coalescing operator
`%||%` <- function(a, b) if (is.null(a)) b else a

# ---- Main Loop --------------------------------------------------------------

main <- function() {
  # Use file("stdin") — stdin() doesn't work with piped input in Rscript
  .stdin_con <- file("stdin", "r")

  repeat {
    line <- readLines(con = .stdin_con, n = 1L, warn = FALSE)
    if (length(line) == 0L) break  # EOF = parent process died

    # Skip empty lines
    if (nchar(trimws(line)) == 0L) next

    req <- tryCatch(
      fromJSON(line, simplifyVector = FALSE),
      error = function(e) NULL
    )

    if (is.null(req)) {
      send_response(error_response(-1L, -1L, "Invalid JSON input"))
      next
    }

    response <- tryCatch(
      dispatch(req),
      error = function(e) {
        error_response(id = req$id %||% -1L, code = 99L,
                       message = paste0("dispatch error: ", conditionMessage(e)))
      }
    )
    send_response(response)
  }

  close(.stdin_con)
}

main()
