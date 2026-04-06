# Top-500 Coverage Matrix

This document turns the top-500 CRAN package list into a concrete coverage program for StatTools.

The key principle is:

- do not treat all top-500 packages as equal workflow targets
- do treat the entire top-500 ecosystem as a coverage surface
- group packages with identical near-term treatment so the plan stays maintainable
- allow overlap between rows when the same package belongs to multiple workflow families

## Bucket Definitions

| Bucket | Meaning |
|---|---|
| `first_class` | Should have explicit workflows, tests, safety coverage, and good search behavior |
| `indirect` | Important ecosystem package, but no direct end-user workflow target for StatTools |
| `caveated` | Valuable workflow target, but needs missing primitives, system libs, credentials, UI, or long-running execution |
| `out_of_scope` | Not a near-term target for agent-facing workflows; mostly dev/build/deploy or highly interactive |

## Priority Definitions

| Priority | Meaning |
|---|---|
| `P0` | Next phase. Needed for strong real-user workflows. |
| `P1` | Near-term after P0. Valuable but not blocking core adoption. |
| `P2` | Later. Nice coverage, but not a first wave target. |
| `P3` | Indirect or out of scope. Do not spend workflow effort here now. |

## Missing Primitive Legend

| Primitive | Meaning |
|---|---|
| `stat_plot` | Plot artifact/export path for ggplot/htmlwidget/table outputs |
| `stat_extract` | Column/vector/matrix extraction, selection, and model-matrix construction |
| `artifact_export` | Persist files or rich artifacts cleanly |
| `network_auth` | Authenticated web/API/cloud access |
| `db_connect` | Durable DB connection/query surface |
| `long_running` | Async/background support for slow fits/compilation |
| `system_libs` | Host dependencies like GDAL, Java, OpenGL, font stacks |
| `interactive_ui` | Browser/UI/session-based packages not suited to current MCP flow |
| `cross_runtime` | Clean handoff between R and Python object/data workflows |
| `none` | No new primitive is the main blocker |

## Coverage Matrix

| Package(s) | Bucket | Canonical workflow | Missing primitive | Priority |
|---|---|---|---|---|
| `ggplot2`, `gridExtra`, `cowplot`, `patchwork`, `ggrepel`, `GGally`, `ggpubr`, `ggsignif`, `ggsci`, `ggthemes`, `ggforce`, `ggtext`, `ggridges`, `hexbin`, `corrplot` | `caveated` | scatter, line, faceting, diagnostics, composition | `stat_plot` | `P0` |
| `plotly`, `DT`, `htmlwidgets`, `reactable`, `reactR`, `leaflet`, `visNetwork`, `highcharter`, `dygraphs` | `caveated` | interactive visualization and table artifacts | `stat_plot`, `artifact_export`, `interactive_ui` | `P1` |
| `ragg`, `textshaping`, `systemfonts`, `svglite`, `png`, `jpeg`, `Cairo`, `gdtools`, `magick`, `rgl` | `caveated` | graphics device and export stack | `stat_plot`, `system_libs` | `P1` |
| `dplyr`, `tibble`, `tidyr`, `tidyselect`, `purrr`, `stringr`, `forcats`, `readr`, `readxl`, `haven`, `janitor`, `labelled`, `modelr`, `dtplyr`, `dbplyr` | `first_class` | wrangling, joins, mutate/filter, pivoting, import | `stat_extract` | `P0` |
| `data.table`, `reshape2`, `reshape`, `plyr` | `first_class` | fast wrangling, melting/casting, grouped summaries | `stat_extract` | `P1` |
| `lubridate`, `hms`, `clock`, `tzdb`, `timechange`, `anytime`, `zoo`, `xts`, `TTR`, `quantmod`, `forecast`, `tseries`, `urca`, `fracdiff`, `timeDate`, `timeSeries` | `first_class` | time parsing, rolling ops, forecasting, decomposition | `none` | `P1` |
| `broom`, `emmeans`, `car`, `lmtest`, `sandwich`, `performance`, `parameters`, `datawizard`, `insight`, `bayestestR` | `first_class` | model diagnostics, inference, effect sizes, tidying outputs | `none` | `P0` |
| `lme4`, `nlme`, `pbkrtest`, `lmerTest`, `minqa`, `nloptr`, `reformulas` | `first_class` | random intercept/slope models, longitudinal analysis | `none` | `P0` |
| `survival`, `prodlim`, `pROC`, `multcomp`, `multcompView`, `boot`, `MASS`, `cluster`, `KernSmooth`, `class`, `nnet` | `first_class` | classical stats, survival, diagnostics, bootstrap, classification | `none` | `P1` |
| `glmnet`, `Matrix`, `MatrixModels`, `matrixStats`, `SparseM`, `quadprog`, `leaps`, `ModelMetrics`, `ROCR` | `caveated` | penalized regression, model selection, sparse design matrices | `stat_extract` | `P0` |
| `caret`, `recipes`, `rsample`, `hardhat`, `ipred`, `randomForest`, `ranger`, `rpart`, `rpart.plot`, `e1071`, `kernlab`, `xgboost`, `mclust`, `FNN`, `proxy`, `cluster`, `mlbench` | `first_class` | train/test split, preprocessing, fit/predict, importance, clustering | `stat_extract` | `P0` |
| `psych`, `lavaan`, `GPArotation`, `FactoMineR`, `factoextra`, `pcaPP`, `vegan`, `ade4`, `DescTools`, `vcd`, `coin`, `libcoin`, `diptest`, `nortest`, `fitdistrplus`, `robustbase` | `first_class` | factor analysis, SEM, ordination, distribution tests, robust stats | `none` | `P1` |
| `plm`, `AER`, `maxLik`, `quantreg`, `Formula`, `lmtest`, `sandwich`, `miscTools` | `caveated` | panel/econometrics workflows | `stat_extract` | `P1` |
| `rstan`, `StanHeaders`, `loo`, `posterior`, `coda`, `inline`, `rstantools` | `caveated` | Bayesian model fitting and posterior diagnostics | `long_running`, `artifact_export` | `P1` |
| `sf`, `sp`, `terra`, `raster`, `s2`, `units`, `wk`, `geosphere`, `spdep`, `maps`, `mapproj`, `classInt` | `caveated` | spatial joins, mapping, raster/vector workflows | `system_libs`, `stat_plot` | `P1` |
| `DBI`, `RSQLite`, `RMySQL`, `RPostgreSQL`, `odbc`, `sqldf`, `blob` | `caveated` | database connection, query, import/export | `db_connect`, `network_auth` | `P1` |
| `jsonlite`, `yaml`, `xml2`, `XML`, `markdown`, `htmlTable`, `xtable`, `openxlsx`, `writexl`, `rio`, `xlsx`, `xlsxjars`, `officer`, `kableExtra` | `first_class` | import/export, JSON/YAML/XML parsing, spreadsheet/report outputs | `artifact_export` | `P1` |
| `httr`, `httr2`, `curl`, `RCurl`, `openssl`, `askpass`, `rvest`, `selectr`, `gh`, `gargle`, `googledrive`, `googlesheets4` | `caveated` | authenticated APIs, scraping, drive/sheets access | `network_auth` | `P2` |
| `aws.s3`, `aws.signature`, `aws.ec2metadata`, `AzureAuth`, `AzureRMR`, `AzureGraph`, `sparklyr`, `mlflow`, `gmailr` | `out_of_scope` | cloud/service integrations | `network_auth` | `P3` |
| `shiny`, `shinyjs`, `shinyWidgets`, `shinydashboard`, `miniUI`, `httpuv`, `later`, `promises`, `bslib`, `sass`, `fontawesome`, `jquerylib`, `htmltools`, `crosstalk` | `out_of_scope` | live interactive app/session workflows | `interactive_ui` | `P3` |
| `knitr`, `rmarkdown`, `bookdown`, `pkgdown`, `tinytex`, `prettydoc`, `downlit`, `litedown`, `highr`, `xfun`, `evaluate`, `commonmark` | `caveated` | report and doc generation | `artifact_export` | `P2` |
| `devtools`, `usethis`, `pkgbuild`, `pkgload`, `pkgdown`, `remotes`, `roxygen2`, `rcmdcheck`, `covr`, `lintr`, `styler`, `testthat`, `waldo`, `mockery`, `vdiffr`, `spelling`, `urlchecker`, `reprex`, `sessioninfo`, `desc`, `pkgconfig`, `pkgload`, `pkgbuild`, `rversions`, `gitcreds`, `gert`, `git2r` | `out_of_scope` | package development and release tooling | `none` | `P3` |
| `rlang`, `vctrs`, `cli`, `lifecycle`, `pillar`, `glue`, `stringi`, `magrittr`, `digest`, `R6`, `withr`, `utf8`, `ellipsis`, `generics`, `pkgconfig`, `fs`, `fansi`, `crayon`, `prettyunits`, `backports`, `cachem`, `fastmap`, `memoise`, `rematch`, `rematch2`, `assertthat`, `uuid`, `base64enc`, `mime`, `rappdirs`, `clipr`, `fastmatch`, `bindr`, `bindrcpp`, `cpp11`, `Rcpp`, `RcppEigen`, `RcppArmadillo`, `RcppParallel`, `RcppRoll`, `RcppProgress`, `RcppTOML`, `BH`, `S7`, `processx`, `callr`, `ps`, `brio`, `rex`, `zip`, `whisker`, `registry`, `sourcetools`, `futile.logger`, `futile.options`, `lambda.r`, `ids`, `rex` | `indirect` | ecosystem support only | `none` | `P3` |
| `viridisLite`, `viridis`, `RColorBrewer`, `colorspace`, `labeling`, `farver`, `munsell`, `isoband`, `gtable`, `polyclip`, `dichromat`, `prismatic`, `paletteer` | `indirect` | palettes, scales, geometry support | `none` | `P3` |
| `vroom`, `cellranger`, `progress`, `progressr`, `pbapply`, `prettyunits` | `indirect` | import/progress helpers | `none` | `P3` |
| `Hmisc`, `htmlTable`, `acepack` | `caveated` | summary tables, descriptive stats, reporting | `artifact_export` | `P2` |
| `igraph`, `ggraph`, `tidygraph`, `graphlayouts`, `dendextend`, `ape`, `flashClust` | `caveated` | graph/network/cluster visualization and analytics | `stat_plot` | `P2` |
| `readxl`, `openxlsx`, `writexl`, `rio`, `haven`, `foreign` | `first_class` | spreadsheet and foreign-format ingestion/export | `artifact_export` | `P1` |
| `reticulate` | `caveated` | R/Python bridge workflows | `cross_runtime` | `P2` |
| `plumber` | `out_of_scope` | API server construction | `interactive_ui` | `P3` |
| `sf`, `leaflet`, `mapproj`, `maps`, `spatstat.utils` | `caveated` | geospatial mapping and artifact export | `stat_plot`, `system_libs` | `P2` |
| `lava`, `arm`, `effects`, `emmeans`, `estimability` | `first_class` | post-estimation summaries and effect displays | `none` | `P1` |
| `survey`, `mitools`, `mice` | `caveated` | survey-weighted and imputation workflows | `stat_extract` | `P1` |
| `deSolve`, `pracma`, `expm`, `Deriv`, `numDeriv`, `polynom` | `caveated` | numerical methods, derivatives, ODEs | `none` | `P2` |
| `tm`, `NLP`, `SnowballC`, `hunspell`, `tokenizers`, `tidytext`, `wordcloud` | `caveated` | text mining and preprocessing | `stat_extract`, `stat_plot` | `P2` |
| `countrycode`, `janitor`, `snakecase`, `labelled`, `clipr` | `first_class` | messy data cleanup and labeling | `none` | `P1` |
| `data.table`, `dtplyr`, `future`, `future.apply`, `furrr`, `parallelly`, `foreach`, `iterators`, `doParallel`, `snow`, `globals`, `listenv` | `caveated` | large-data and parallel compute workflows | `long_running` | `P2` |
| `openxlsx`, `xlsx`, `xlsxjars`, `rJava` | `caveated` | Excel workflows with Java dependency | `system_libs` | `P2` |
| `arrow` | `caveated` | parquet/feather and large-table workflows | `system_libs` | `P2` |
| `terra`, `raster`, `sf`, `s2`, `units`, `wk` | `caveated` | high-value spatial stack | `system_libs` | `P1` |
| `caret`, `recipes`, `rsample`, `hardhat`, `ModelMetrics`, `ROCR`, `ipred` | `first_class` | structured ML training/evaluation | `stat_extract` | `P0` |
| `glmnet`, `xgboost`, `ranger`, `randomForest`, `kernlab`, `e1071`, `nnet`, `class`, `FNN` | `first_class` | predictive modeling and classification | `stat_extract` | `P0` |
| `survival`, `coxph`-adjacent packages like `prodlim`, `timeDate`, `zoo` | `first_class` | Kaplan-Meier, Cox PH, time-to-event summaries | `none` | `P1` |
| `mgcv`, `gam`-style workflows via `mgcv`, `gam`-adjacent helpers like `gplots`, `plotrix` | `caveated` | GAM fitting and diagnostics | `stat_plot` | `P1` |
| `lmtest`, `sandwich`, `multcomp`, `car`, `AER`, `quantreg`, `robustbase` | `first_class` | econometrics and robust inference | `stat_extract` | `P1` |
| `rpart`, `rpart.plot`, `party` | `first_class` | decision trees and rule-based models | `stat_plot` | `P1` |
| `FactoMineR`, `factoextra`, `cluster`, `mclust`, `fpc`, `dbscan`, `irlba` | `first_class` | PCA, clustering, low-rank approximation | `stat_extract` | `P1` |
| `vegan`, `ade4`, `permute`, `ape` | `caveated` | ordination, ecology, distance/permutation workflows | `stat_plot` | `P2` |
| `lavaan`, `psych`, `GPArotation`, `mnormt`, `corpcor` | `first_class` | psychometrics, SEM, latent variable models | `none` | `P1` |
| `posterior`, `loo`, `bayestestR`, `coda`, `rstan` | `caveated` | posterior diagnostics and Bayesian summaries | `long_running` | `P1` |
| `DBI`, `RSQLite`, `odbc`, `sqldf`, `dbplyr` | `caveated` | SQL-backed analytics | `db_connect` | `P1` |
| `rvest`, `xml2`, `httr2`, `curl`, `openssl`, `gargle`, `googledrive`, `googlesheets4` | `caveated` | data acquisition from APIs and web | `network_auth` | `P2` |
| `officer`, `rmarkdown`, `knitr`, `bookdown`, `kableExtra`, `gt`, `htmlwidgets`, `DT` | `caveated` | reporting, slides, dashboards, formatted outputs | `artifact_export`, `stat_plot` | `P2` |
| `shiny`, `miniUI`, `httpuv`, `later`, `promises`, `shinyjs`, `shinydashboard`, `shinyWidgets` | `out_of_scope` | app/session runtime | `interactive_ui` | `P3` |
| `devtools`, `remotes`, `usethis`, `pkgbuild`, `pkgload`, `roxygen2`, `testthat`, `covr`, `lintr`, `styler`, `rcmdcheck`, `pkgdown`, `renv`, `packrat` | `out_of_scope` | package engineering lifecycle | `none` | `P3` |
| `aws.s3`, `aws.signature`, `aws.ec2metadata`, `AzureAuth`, `AzureRMR`, `AzureGraph`, `sparklyr`, `mlflow`, `rsconnect` | `out_of_scope` | deployment and cloud-service integration | `network_auth` | `P3` |
| `rprojroot`, `here`, `xopen`, `rstudioapi`, `sessioninfo`, `credentials`, `gitcreds`, `gert`, `git2r` | `out_of_scope` | local IDE/project/git integration | `none` | `P3` |
| `memoise`, `cachem`, `fastmap`, `future`, `future.apply`, `furrr`, `parallelly`, `foreach`, `iterators`, `doParallel`, `snow`, `globals`, `listenv` | `indirect` | caching and execution support | `none` | `P3` |
| `randomForest`, `ranger`, `xgboost`, `caret`, `recipes`, `rsample`, `hardhat`, `glmnet` | `first_class` | top-demand ML workflows | `stat_extract` | `P0` |
| `ggplot2`, `plotly`, `DT`, `leaflet`, `highcharter`, `reactable` | `caveated` | top-demand presentation layer | `stat_plot` | `P0` |

## Immediate P0 Package Set

If you want a concrete next-wave target list from the top 500, this is the most valuable subset:

- `ggplot2`
- `dplyr`
- `tidyr`
- `readr`
- `readxl`
- `stringr`
- `lubridate`
- `data.table`
- `broom`
- `car`
- `lmtest`
- `sandwich`
- `lme4`
- `survival`
- `glmnet`
- `caret`
- `recipes`
- `rsample`
- `randomForest`
- `ranger`
- `xgboost`
- `e1071`
- `rpart`
- `psych`
- `lavaan`
- `forecast`
- `quantmod`
- `DBI`
- `RSQLite`
- `sf`
- `terra`
- `plotly`
- `DT`
- `officer`
- `rmarkdown`

## What This Means Operationally

The top-500 program should be executed in this order:

1. Add `stat_plot`
2. Add `stat_extract`
3. Lock down P0 workflows
4. Expand safety coverage for P0/P1 packages
5. Use real usage logs to decide which P2 packages get promoted

Do not attempt to build first-class workflows for every top-500 package at once. The right unit of work is a package family plus a canonical workflow.
