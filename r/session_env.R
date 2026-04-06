# ============================================================================
# StatTools — Session Environment Management
# ============================================================================
# All user objects (data, models, predictions, test results) live in .ss.
# This isolates session state from bridge internals.

# Session environment — parent is .GlobalEnv so loaded packages are visible
.ss <- new.env(parent = .GlobalEnv)

# Metadata tracking (not visible to user code)
.ss_meta <- new.env(parent = emptyenv())
.ss_meta$objects <- list()  # id -> list(type, rClass, sizeBytes, summary)

# ---- Object Registration ---------------------------------------------------

register_object <- function(id, type, r_class, size_bytes, summary, schema = NULL) {
  .ss_meta$objects[[id]] <- list(
    id = id,
    type = type,
    rClass = r_class,
    sizeBytes = size_bytes,
    summary = summary,
    schema = schema
  )
}

unregister_object <- function(id) {
  .ss_meta$objects[[id]] <- NULL
  if (exists(id, envir = .ss, inherits = FALSE)) {
    rm(list = id, envir = .ss)
  }
}

get_object_meta <- function(id) {
  .ss_meta$objects[[id]]
}

list_objects <- function() {
  .ss_meta$objects
}

# ---- Object Summary Generation ----------------------------------------------

make_object_summary <- function(obj, id) {
  cls <- class(obj)[1]

  summary_text <- tryCatch({
    if (is.data.frame(obj)) {
      paste0(id, " (", nrow(obj), "x", ncol(obj), " ", cls, ")")
    } else if (inherits(obj, "lm") || inherits(obj, "glm")) {
      paste0(id, " (", cls, ": ", deparse(formula(obj), width.cutoff = 60)[1], ")")
    } else if (inherits(obj, "htest")) {
      paste0(id, " (", obj$method, ")")
    } else if (is.matrix(obj)) {
      paste0(id, " (", nrow(obj), "x", ncol(obj), " matrix)")
    } else if (is.numeric(obj)) {
      paste0(id, " (numeric, length ", length(obj), ")")
    } else {
      paste0(id, " (", cls, ")")
    }
  }, error = function(e) {
    paste0(id, " (", cls, ")")
  })

  size_bytes <- tryCatch(as.numeric(object.size(obj)), error = function(e) 0)

  schema <- NULL
  if (is.data.frame(obj)) {
    schema <- as.list(setNames(
      sapply(obj, function(x) class(x)[1], USE.NAMES = FALSE),
      names(obj)
    ))
  }

  list(
    id = id,
    type = infer_handle_type(obj),
    rClass = cls,
    sizeBytes = size_bytes,
    summary = summary_text,
    schema = schema
  )
}

infer_handle_type <- function(obj) {
  if (is.data.frame(obj) || is.matrix(obj)) return("data")
  if (inherits(obj, "lm") || inherits(obj, "glm") || inherits(obj, "nls") ||
      inherits(obj, "lmerMod") || inherits(obj, "coxph")) return("model")
  if (inherits(obj, "htest") || inherits(obj, "anova")) return("test_result")
  if (is.numeric(obj) && !is.matrix(obj) && length(obj) > 1) return("prediction")
  "generic"
}

# ---- Persistence (whitelist-based) ------------------------------------------

# R classes known to survive saveRDS/readRDS safely
SERIALIZABLE_CLASSES <- c(
  "data.frame", "tbl_df", "data.table", "matrix", "array",
  "list", "numeric", "integer", "character", "logical", "complex",
  "factor", "Date", "POSIXct", "POSIXlt",
  "lm", "glm", "nls", "htest", "anova", "aov",
  "summary.lm", "summary.glm",
  "lmerMod", "glmerMod", "coxph", "survfit", "survreg",
  "prcomp", "kmeans", "ts", "mts", "formula",
  "table", "ftable", "dendrogram", "dist", "density"
)

is_serializable <- function(obj) {
  cls <- class(obj)
  any(cls %in% SERIALIZABLE_CLASSES)
}

#' Persist only the specified handle IDs to disk.
#' Called by TypeScript handle registry — R does NOT decide what to persist.
#' @param handle_ids Character vector of handle IDs to persist
#' @param session_dir Directory to save .rds files
#' @return List of IDs that failed to persist
persist_handles <- function(handle_ids, session_dir) {
  if (!dir.exists(session_dir)) dir.create(session_dir, recursive = TRUE)
  failed <- character(0)

  for (name in handle_ids) {
    if (!exists(name, envir = .ss, inherits = FALSE)) {
      failed <- c(failed, name)
      next
    }
    tryCatch({
      saveRDS(get(name, envir = .ss, inherits = FALSE),
              file = file.path(session_dir, paste0(name, ".rds")))
    }, error = function(e) {
      failed <<- c(failed, name)
    })
  }
  failed
}

#' Restore handles from disk after worker recycle.
#' @param session_dir Directory containing .rds files
#' @return List of restored handle IDs
restore_handles <- function(session_dir) {
  if (!dir.exists(session_dir)) return(character(0))

  rds_files <- list.files(session_dir, pattern = "\\.rds$", full.names = TRUE)
  restored <- character(0)

  for (f in rds_files) {
    name <- tools::file_path_sans_ext(basename(f))
    tryCatch({
      obj <- readRDS(f)
      assign(name, obj, envir = .ss)
      # Re-register metadata
      meta <- make_object_summary(obj, name)
      register_object(meta$id, meta$type, meta$rClass,
                      meta$sizeBytes, meta$summary, meta$schema)
      restored <- c(restored, name)
    }, error = function(e) {
      # Silently skip — TypeScript will mark as lost
    })
  }
  restored
}
