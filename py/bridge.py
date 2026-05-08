#!/usr/bin/env python3
"""
StatTools — Python Worker Bridge
=================================
Persistent Python subprocess. Reads NDJSON from stdin, dispatches calls,
writes structured JSON to stdout. Keeps packages, data, and model objects
loaded between calls.

Protocol: one JSON object per line on stdin, one on stdout.
"""

import sys
import json
import math
import traceback
import importlib
import inspect
import warnings
from typing import Any, Dict, List, Optional, Tuple

# ---- Session Environment ----------------------------------------------------

_session: Dict[str, Any] = {}
_session_meta: Dict[str, dict] = {}

# ---- Serializable class whitelist -------------------------------------------

SERIALIZABLE_CLASSES = {
    "DataFrame", "Series", "ndarray",
    "LinearRegression", "LogisticRegression", "Ridge", "Lasso", "ElasticNet",
    "RandomForestClassifier", "RandomForestRegressor",
    "GradientBoostingClassifier", "GradientBoostingRegressor",
    "DecisionTreeClassifier", "DecisionTreeRegressor",
    "SVC", "SVR", "KNeighborsClassifier", "KNeighborsRegressor",
    "KMeans", "PCA", "StandardScaler", "MinMaxScaler",
    "OLSResults", "RegressionResultsWrapper",
    "dict", "list", "int", "float", "str", "bool",
    "tuple", "set", "frozenset",
}

def is_serializable(obj: Any) -> bool:
    return type(obj).__name__ in SERIALIZABLE_CLASSES

# ---- Response Helpers -------------------------------------------------------

def send_response(resp: dict) -> None:
    # allow_nan=False makes plain Python floats with NaN/Inf raise instead of
    # emitting non-standard JSON tokens that the Node NDJSON parser rejects.
    # Per-value sanitization should happen at the source; this is the safety net.
    try:
        line = json.dumps(resp, default=_json_default, ensure_ascii=False, allow_nan=False)
    except Exception as e:
        line = json.dumps({
            "id": resp.get("id", -1),
            "error": {"code": 98, "message": f"JSON serialization failed: {e}"}
        })
    sys.stdout.write(line + "\n")
    sys.stdout.flush()

def error_response(req_id: int, code: int, message: str,
                    suggestion: str = None, tb: str = None) -> dict:
    resp = {"id": req_id, "error": {"code": code, "message": message}}
    if suggestion:
        resp["error"]["suggestion"] = suggestion
    if tb:
        resp["error"]["traceback"] = tb
    return resp

def _json_default(obj: Any) -> Any:
    """Custom JSON serializer for types json module can't handle."""
    import numpy as np
    import pandas as pd

    if isinstance(obj, np.integer):
        return int(obj)
    if isinstance(obj, np.floating):
        if np.isnan(obj) or np.isinf(obj):
            return None
        return float(obj)
    if isinstance(obj, np.ndarray):
        return obj.tolist()
    if isinstance(obj, pd.DataFrame):
        return obj.to_dict(orient="records")
    if isinstance(obj, pd.Series):
        return obj.to_dict()
    if isinstance(obj, (pd.Timestamp, pd.Timedelta)):
        return str(obj)
    if isinstance(obj, set):
        return list(obj)
    if hasattr(obj, "__dict__"):
        return {k: v for k, v in obj.__dict__.items() if not k.startswith("_")}
    return str(obj)

# ---- Dispatch ---------------------------------------------------------------

def dispatch(req: dict) -> dict:
    req_id = req.get("id", -1)
    method = req.get("method", "")
    params = req.get("params", {})

    handlers = {
        "call": dispatch_call,
        "call_method": dispatch_call_method,
        "healthcheck": dispatch_healthcheck,
        "select_columns": dispatch_select_columns,
        "load_data": dispatch_load_data,
        "inspect": dispatch_inspect,
        "list_objects": dispatch_list_objects,
        "schema": dispatch_schema,
    }

    handler = handlers.get(method)
    if handler is None:
        return error_response(req_id, -1, f"Unknown method: {method}")

    try:
        return handler(req_id, params)
    except Exception as e:
        return error_response(req_id, 1, str(e),
                              tb=traceback.format_exc()[-500:])

# ---- Method: healthcheck -----------------------------------------------------

def dispatch_healthcheck(req_id: int, params: dict) -> dict:
    required_modules = ["pandas", "sklearn", "scipy", "statsmodels"]
    available = []
    missing = []

    for mod in required_modules:
        try:
            importlib.import_module(mod)
            available.append(mod)
        except Exception:
            missing.append(mod)

    return {
        "id": req_id,
        "result": {
            "python_version": sys.version.split()[0],
            "required_modules": required_modules,
            "available_modules": available,
            "missing_modules": missing,
            "healthy": len(missing) == 0,
        }
    }

# ---- Method: call -----------------------------------------------------------

def dispatch_call(req_id: int, params: dict) -> dict:
    module_path = params.get("module") or params.get("package", "")
    func_name = params.get("function", "")
    args = params.get("args", {})
    assign_to = params.get("assign_to")

    if not module_path or not func_name:
        return error_response(req_id, 2, "Missing 'module' or 'function'")

    # Import module
    try:
        mod = importlib.import_module(module_path)
    except ImportError as e:
        return error_response(req_id, 3,
            f"Module '{module_path}' not available: {e}",
            suggestion="Install the package with pip")

    # Get function/class
    obj = mod
    for part in func_name.split("."):
        obj = getattr(obj, part, None)
        if obj is None:
            return error_response(req_id, 2,
                f"'{func_name}' not found in '{module_path}'",
                suggestion="Use stat_search to find the correct function")

    # Resolve session references in args
    resolved_args = _resolve_refs(args)
    if isinstance(resolved_args, dict) and "error" in resolved_args:
        return error_response(req_id, 4, resolved_args["error"]["message"],
                              suggestion=resolved_args["error"].get("suggestion"))

    # Execute with warning capture
    caught_warnings: List[str] = []
    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter("always")
        try:
            if callable(obj):
                result = obj(**resolved_args)
            else:
                result = obj
        except Exception as e:
            return error_response(req_id, 1, str(e),
                suggestion=_generate_suggestion(e, module_path, func_name),
                tb=traceback.format_exc()[-500:])
        caught_warnings = [str(warning.message) for warning in w]

    # Assign to session
    objects_created = []
    if assign_to or _should_auto_assign(result):
        ref_id = assign_to or _auto_ref_id(result)
        _session[ref_id] = result
        meta = _make_object_summary(result, ref_id)
        _session_meta[ref_id] = meta
        objects_created.append(meta)

    # Format result
    formatted = _format_result(result)

    resp: dict = {"id": req_id, "result": formatted}
    if caught_warnings:
        resp["warnings"] = caught_warnings
    if objects_created:
        resp["objectsCreated"] = objects_created
    return resp

# ---- Method: call_method ----------------------------------------------------

def dispatch_call_method(req_id: int, params: dict) -> dict:
    """Call a method on a session object. E.g., model_1.fit(X, y)."""
    obj_id = params.get("object", "")
    method_name = params.get("method", "")
    args = params.get("args", {})
    positional = params.get("positional_args", [])
    assign_to = params.get("assign_to")

    if not obj_id or obj_id not in _session:
        available = ", ".join(_session.keys()) or "(none)"
        return error_response(req_id, 4,
            f"Object '{obj_id}' not found. Available: {available}")

    obj = _session[obj_id]
    method = getattr(obj, method_name, None)
    if method is None or not callable(method):
        return error_response(req_id, 2,
            f"Method '{method_name}' not found on {type(obj).__name__}")

    # Resolve references in args and positional_args
    resolved_args = _resolve_refs(args)
    resolved_pos = [_session[a] if isinstance(a, str) and a in _session else a
                    for a in positional]

    caught_warnings: List[str] = []
    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter("always")
        try:
            result = method(*resolved_pos, **resolved_args)
        except Exception as e:
            return error_response(req_id, 1, str(e),
                suggestion=_generate_suggestion(e, type(obj).__name__, method_name),
                tb=traceback.format_exc()[-500:])
        caught_warnings = [str(warning.message) for warning in w]

    # Many sklearn methods return self (fit returns the model)
    # Update the session object if result is self
    if result is obj:
        _session_meta[obj_id] = _make_object_summary(obj, obj_id)

    objects_created = []
    if assign_to and result is not obj:
        _session[assign_to] = result
        meta = _make_object_summary(result, assign_to)
        _session_meta[assign_to] = meta
        objects_created.append(meta)

    formatted = _format_result(result if result is not obj else obj)

    resp: dict = {"id": req_id, "result": formatted}
    if caught_warnings:
        resp["warnings"] = caught_warnings
    if objects_created:
        resp["objectsCreated"] = objects_created
    return resp

# ---- Method: select_columns -------------------------------------------------

def dispatch_select_columns(req_id: int, params: dict) -> dict:
    """Select columns from a DataFrame session object. Creates a new session ref."""
    import pandas as pd

    obj_id = params.get("object", "")
    columns = params.get("columns", [])
    assign_to = params.get("assign_to", "")

    if not obj_id or obj_id not in _session:
        return error_response(req_id, 4, f"Object '{obj_id}' not found")

    obj = _session[obj_id]
    if not isinstance(obj, pd.DataFrame):
        return error_response(req_id, 2, f"'{obj_id}' is not a DataFrame")

    if not columns:
        return error_response(req_id, 2, "Missing 'columns' parameter")

    # Single column → Series, multiple → DataFrame
    missing = [c for c in columns if c not in obj.columns]
    if missing:
        return error_response(req_id, 5,
            f"Columns not found: {missing}. Available: {list(obj.columns)}",
            suggestion="Check column names with stat_describe")

    if len(columns) == 1:
        result = obj[columns[0]]
    else:
        result = obj[columns]

    if not assign_to:
        assign_to = f"{obj_id}_{'_'.join(columns[:3])}"

    _session[assign_to] = result
    meta = _make_object_summary(result, assign_to)
    _session_meta[assign_to] = meta

    formatted = _format_result(result)
    formatted["object_id"] = assign_to

    return {"id": req_id, "result": formatted, "objectsCreated": [meta]}

# ---- Method: load_data ------------------------------------------------------

def dispatch_load_data(req_id: int, params: dict) -> dict:
    import pandas as pd

    file_path = params.get("file_path", "")
    name = params.get("name")
    sep = params.get("separator")

    if not file_path:
        return error_response(req_id, 2, "Missing 'file_path'")

    try:
        ext = file_path.rsplit(".", 1)[-1].lower() if "." in file_path else ""
        if ext == "tsv" or sep == "\t":
            df = pd.read_csv(file_path, sep="\t")
        elif ext == "parquet":
            df = pd.read_parquet(file_path)
        else:
            df = pd.read_csv(file_path, sep=sep if sep else ",")
    except Exception as e:
        return error_response(req_id, 1, f"Failed to read file: {e}")

    ref_id = name or file_path.rsplit("/", 1)[-1].rsplit(".", 1)[0]
    ref_id = "".join(c if c.isalnum() or c == "_" else "_" for c in ref_id)

    _session[ref_id] = df
    meta = _make_object_summary(df, ref_id)
    _session_meta[ref_id] = meta

    formatted = _format_result(df)
    formatted["object_id"] = ref_id

    return {"id": req_id, "result": formatted, "objectsCreated": [meta]}

# ---- Method: inspect --------------------------------------------------------

def dispatch_inspect(req_id: int, params: dict) -> dict:
    obj_id = params.get("object") or params.get("handle", "")
    if not obj_id or obj_id not in _session:
        available = ", ".join(_session.keys()) or "(none)"
        return error_response(req_id, 4,
            f"Object '{obj_id}' not found. Available: {available}")

    return {"id": req_id, "result": _format_result(_session[obj_id])}

# ---- Method: list_objects ---------------------------------------------------

def dispatch_list_objects(req_id: int, params: dict) -> dict:
    return {"id": req_id, "result": {
        "objects": _session_meta,
        "loaded_modules": list(sys.modules.keys())[:50],
        "python_version": sys.version.split()[0],
    }}

# ---- Method: schema ---------------------------------------------------------

def dispatch_schema(req_id: int, params: dict) -> dict:
    module_path = params.get("module") or params.get("package", "")
    func_name = params.get("function", "")

    if not module_path or not func_name:
        return error_response(req_id, 2, "Missing 'module' or 'function'")

    try:
        mod = importlib.import_module(module_path)
    except ImportError:
        return error_response(req_id, 3, f"Module '{module_path}' not available")

    obj = mod
    for part in func_name.split("."):
        obj = getattr(obj, part, None)
        if obj is None:
            return error_response(req_id, 2, f"'{func_name}' not found in '{module_path}'")

    # Extract signature
    try:
        sig = inspect.signature(obj)
    except (ValueError, TypeError):
        # Some builtins don't have inspectable signatures
        return {"id": req_id, "result": {
            "module": module_path,
            "function": func_name,
            "schema": {"type": "object", "properties": {}, "required": []},
        }}

    properties = {}
    required = []

    for name, param in sig.parameters.items():
        if name in ("self", "cls"):
            continue
        if param.kind in (inspect.Parameter.VAR_POSITIONAL, inspect.Parameter.VAR_KEYWORD):
            continue

        prop: dict = {"type": "string"}

        # Infer type from default
        if param.default is not inspect.Parameter.empty:
            default = param.default
            if isinstance(default, bool):
                prop = {"type": "boolean", "default": default}
            elif isinstance(default, int):
                prop = {"type": "integer", "default": default}
            elif isinstance(default, float):
                # NaN/Inf are not valid JSON; sklearn uses np.nan as a sentinel
                # default for several params (e.g. cross_val_score scoring=nan).
                if math.isnan(default) or math.isinf(default):
                    prop = {"type": "number", "default": None}
                else:
                    prop = {"type": "number", "default": default}
            elif isinstance(default, str):
                prop = {"type": "string", "default": default}
            elif default is None:
                prop = {"type": "string", "default": None}
        else:
            required.append(name)

        # Try to get description from docstring
        prop["description"] = ""

        properties[name] = prop

    schema = {
        "type": "object",
        "properties": properties,
        "required": required,
    }

    # Get docstring
    docstring = inspect.getdoc(obj) or ""

    return {"id": req_id, "result": {
        "module": module_path,
        "function": func_name,
        "schema": schema,
        "docstring": docstring[:500] if docstring else "",
    }}

# ---- Helpers ----------------------------------------------------------------

def _resolve_refs(args: dict) -> dict:
    resolved = {}
    for key, val in args.items():
        if isinstance(val, str) and val in _session:
            resolved[key] = _session[val]
        else:
            resolved[key] = val
    return resolved

def _should_auto_assign(result: Any) -> bool:
    type_name = type(result).__name__
    return type_name in (
        "LinearRegression", "LogisticRegression", "Ridge", "Lasso",
        "RandomForestClassifier", "RandomForestRegressor",
        "GradientBoostingClassifier", "GradientBoostingRegressor",
        "SVC", "SVR", "KMeans", "PCA",
        "OLSResults", "RegressionResultsWrapper",
        "DataFrame",
    )

def _auto_ref_id(result: Any) -> str:
    import pandas as pd
    if isinstance(result, pd.DataFrame):
        prefix = "data"
    elif hasattr(result, "predict"):
        prefix = "model"
    elif hasattr(result, "pvalues"):
        prefix = "test"
    else:
        prefix = "generic"

    n = sum(1 for k in _session if k.startswith(prefix + "_")) + 1
    return f"{prefix}_{n}"

def _make_object_summary(obj: Any, ref_id: str) -> dict:
    import pandas as pd
    import numpy as np

    type_name = type(obj).__name__
    size_bytes = sys.getsizeof(obj)

    if isinstance(obj, pd.DataFrame):
        summary = f"{ref_id} ({obj.shape[0]}x{obj.shape[1]} DataFrame)"
        schema = {col: str(dtype) for col, dtype in obj.dtypes.items()}
        return {
            "id": ref_id, "type": "data", "rClass": type_name,
            "sizeBytes": size_bytes, "summary": summary, "schema": schema,
        }
    elif hasattr(obj, "predict"):
        summary = f"{ref_id} ({type_name})"
        return {
            "id": ref_id, "type": "model", "rClass": type_name,
            "sizeBytes": size_bytes, "summary": summary,
        }
    elif isinstance(obj, np.ndarray):
        summary = f"{ref_id} ({obj.shape} ndarray)"
        return {
            "id": ref_id, "type": "data", "rClass": "ndarray",
            "sizeBytes": size_bytes, "summary": summary,
        }
    else:
        summary = f"{ref_id} ({type_name})"
        return {
            "id": ref_id, "type": "generic", "rClass": type_name,
            "sizeBytes": size_bytes, "summary": summary,
        }

def _format_result(obj: Any) -> dict:
    import pandas as pd
    import numpy as np

    type_name = type(obj).__name__

    # DataFrame
    if isinstance(obj, pd.DataFrame):
        col_types = {col: str(dtype) for col, dtype in obj.dtypes.items()}
        col_summary = {}
        for col in obj.columns:
            s = obj[col]
            if pd.api.types.is_numeric_dtype(s):
                col_summary[col] = {
                    "type": str(s.dtype), "mean": float(s.mean()),
                    "std": float(s.std()), "min": float(s.min()),
                    "max": float(s.max()), "na_count": int(s.isna().sum()),
                }
            else:
                col_summary[col] = {
                    "type": str(s.dtype), "n_unique": int(s.nunique()),
                    "na_count": int(s.isna().sum()),
                }

        return {
            "class": "DataFrame",
            "dimensions": {"rows": obj.shape[0], "cols": obj.shape[1]},
            "column_types": col_types,
            "preview": obj.head(20).to_dict(orient="records"),
            "column_summary": col_summary,
        }

    # sklearn model with coefficients
    if hasattr(obj, "coef_") and hasattr(obj, "intercept_"):
        result = {
            "class": type_name,
            "coefficients": obj.coef_.tolist() if hasattr(obj.coef_, "tolist") else obj.coef_,
            "intercept": float(obj.intercept_) if np.isscalar(obj.intercept_) else obj.intercept_.tolist(),
        }
        if hasattr(obj, "score"):
            result["has_score_method"] = True
        if hasattr(obj, "classes_"):
            result["classes"] = obj.classes_.tolist()
        return result

    # statsmodels results
    if hasattr(obj, "summary") and hasattr(obj, "params"):
        result = {"class": type_name}
        try:
            result["params"] = obj.params.to_dict() if hasattr(obj.params, "to_dict") else obj.params.tolist()
        except:
            pass
        try:
            result["pvalues"] = obj.pvalues.to_dict() if hasattr(obj.pvalues, "to_dict") else obj.pvalues.tolist()
        except:
            pass
        try:
            result["rsquared"] = float(obj.rsquared)
        except:
            pass
        try:
            result["aic"] = float(obj.aic)
        except:
            pass
        try:
            result["summary_text"] = str(obj.summary())[:2000]
        except:
            pass
        return result

    # ndarray
    if isinstance(obj, np.ndarray):
        if obj.size <= 100:
            return {"class": "ndarray", "shape": list(obj.shape), "values": obj.tolist()}
        return {
            "class": "ndarray", "shape": list(obj.shape),
            "dtype": str(obj.dtype),
            "head": obj.flat[:20].tolist(),
        }

    # Scalar
    if isinstance(obj, (int, float, bool, str)):
        return {"class": type_name, "value": obj}

    # Dict/list
    if isinstance(obj, dict):
        return {"class": "dict", "keys": list(obj.keys())[:50], "content": obj}
    if isinstance(obj, (list, tuple)):
        return {"class": type_name, "length": len(obj),
                "preview": obj[:20] if len(obj) > 20 else obj}

    # Default
    try:
        return {"class": type_name, "content": vars(obj)}
    except:
        return {"class": type_name, "text_output": str(obj)[:5000]}

def _generate_suggestion(e: Exception, module: str, func: str) -> Optional[str]:
    msg = str(e)
    if "not fitted" in msg.lower():
        return "Model must be fitted first. Call .fit(X, y) before predict/score."
    if "expected 2d array" in msg.lower():
        return "Input should be a 2D array. Try reshaping: X.reshape(-1, 1) for single feature."
    if "could not convert" in msg.lower():
        return "Type conversion failed. Check that data types match expected input."
    return None

# ---- Main Loop --------------------------------------------------------------

def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            send_response(error_response(-1, -1, "Invalid JSON input"))
            continue

        response = dispatch(req)
        send_response(response)

if __name__ == "__main__":
    main()
