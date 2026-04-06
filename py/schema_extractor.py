#!/usr/bin/env python3
"""
StatTools — Python Schema Extractor
Extracts function/class metadata from installed Python packages.
Outputs NDJSON to stdout.
"""

import sys
import json
import inspect
import importlib

# Key packages and their important submodules
PACKAGES = {
    "sklearn.linear_model": [
        "LinearRegression", "LogisticRegression", "Ridge", "Lasso",
        "ElasticNet", "SGDClassifier", "SGDRegressor",
    ],
    "sklearn.ensemble": [
        "RandomForestClassifier", "RandomForestRegressor",
        "GradientBoostingClassifier", "GradientBoostingRegressor",
        "AdaBoostClassifier", "AdaBoostRegressor",
    ],
    "sklearn.tree": [
        "DecisionTreeClassifier", "DecisionTreeRegressor",
    ],
    "sklearn.svm": ["SVC", "SVR", "LinearSVC", "LinearSVR"],
    "sklearn.neighbors": [
        "KNeighborsClassifier", "KNeighborsRegressor",
    ],
    "sklearn.cluster": ["KMeans", "DBSCAN", "AgglomerativeClustering"],
    "sklearn.decomposition": ["PCA", "NMF", "TruncatedSVD"],
    "sklearn.preprocessing": [
        "StandardScaler", "MinMaxScaler", "LabelEncoder",
        "OneHotEncoder", "PolynomialFeatures",
    ],
    "sklearn.model_selection": [
        "train_test_split", "cross_val_score", "GridSearchCV",
        "RandomizedSearchCV",
    ],
    "sklearn.metrics": [
        "accuracy_score", "precision_score", "recall_score",
        "f1_score", "mean_squared_error", "r2_score",
        "confusion_matrix", "classification_report",
        "roc_auc_score", "mean_absolute_error",
    ],
    "sklearn.feature_selection": [
        "SelectKBest", "chi2", "f_classif", "mutual_info_classif",
    ],
    "sklearn.pipeline": ["Pipeline", "make_pipeline"],
    "statsmodels.api": ["OLS", "GLS", "WLS", "Logit", "Probit", "MNLogit"],
    "statsmodels.formula.api": ["ols", "logit", "probit", "glm"],
    "statsmodels.tsa.api": [
        "ARIMA", "SARIMAX", "ExponentialSmoothing", "VAR",
    ],
    "scipy.stats": [
        "ttest_ind", "ttest_1samp", "ttest_rel",
        "chi2_contingency", "pearsonr", "spearmanr", "kendalltau",
        "mannwhitneyu", "wilcoxon", "kruskal", "friedmanchisquare",
        "shapiro", "normaltest", "kstest",
        "linregress", "f_oneway",
        "describe",
    ],
    "pandas": [
        "DataFrame", "Series", "read_csv", "read_excel",
        "read_parquet", "merge", "concat", "pivot_table",
        "get_dummies", "cut", "qcut",
    ],
    "numpy": [
        "array", "zeros", "ones", "linspace", "arange",
        "mean", "std", "var", "median", "percentile",
        "corrcoef", "cov", "dot", "matmul",
        "linalg.solve", "linalg.inv", "linalg.eig", "linalg.svd",
        "random.seed", "random.normal", "random.uniform",
    ],
}


def extract_function_meta(module_path: str, func_name: str):
    try:
        mod = importlib.import_module(module_path)
    except ImportError:
        return None

    obj = mod
    for part in func_name.split("."):
        obj = getattr(obj, part, None)
        if obj is None:
            return None

    # Get docstring
    docstring = inspect.getdoc(obj) or ""
    title = docstring.split("\n")[0][:200] if docstring else ""
    description = docstring[:500] if docstring else ""

    # Check if it has formula support (statsmodels)
    has_formula = "formula" in (inspect.signature(obj).parameters if callable(obj) else {})

    return {
        "package": module_path,
        "function_name": func_name,
        "title": title,
        "description": description,
        "has_formula": has_formula,
        "has_dots": False,  # Python uses **kwargs, handled differently
        "runtime": "python",
    }


def main():
    for module_path, functions in PACKAGES.items():
        print(json.dumps({"status": "extracting", "module": module_path}),
              file=sys.stderr)

        for func_name in functions:
            meta = extract_function_meta(module_path, func_name)
            if meta:
                print(json.dumps(meta))

    print(json.dumps({"status": "done"}), file=sys.stderr)


if __name__ == "__main__":
    main()
