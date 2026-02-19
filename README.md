# easyCris

**Professional statistical analysis and RNA-seq for researchers — no coding required.**

> **Beta Release:** easyCris is actively improving and may still contain bugs or unfinished edge cases.

![Platform](https://img.shields.io/badge/platform-Windows-0078d4?logo=windows&logoColor=white)
![Version](https://img.shields.io/github/v/release/easyCris-software/easyCris?color=brightgreen)
![License](https://img.shields.io/badge/license-Proprietary-red)

<table>
  <tr>
    <td><img src="assets/screenshots/anova_bar_tukey.png" alt="One-Way ANOVA with Tukey post-hoc brackets" width="420"/></td>
    <td><img src="assets/screenshots/rnaseq_pca_biplot.png" alt="RNA-seq PCA biplot" width="420"/></td>
  </tr>
</table>

---

## 🔒 Privacy

easyCris runs entirely on your machine.
Your data, files, and results never leave your computer — nothing is uploaded or transmitted.
No account required.
The in-app updater checks release metadata and only downloads update files when you choose to install.
No usage data, analysis data, file contents, or personal information is sent.

---

## 🧪 What is easyCris?

easyCris is a desktop application for scientific data analysis — covering classical statistics, pharmacology, bulk RNA-seq differential expression, and data cleaning tools, all in one place. Core statistical workflows and the RNA-seq pipeline are validated against published methods and reference implementations cited below, giving you publication-ready output without writing a single line of code. All computation runs locally using an embedded analysis engine; no external software installation is required.

---

## ⬇️ Download

**[→ Download Latest Beta Release](https://github.com/easyCris-software/easyCris/releases/latest)**

Windows x64 installer (`.exe`). Once installed, the app supports in-app updates through signed release packages.

---

## 📊 Statistical Analysis

easyCris covers 30+ statistical tests across seven analysis groups. Most tests produce a results table and auto-generated interactive plots.

### 🔬 Parametric Tests

| Test | Accepted Data Format |
|---|---|
| Independent Samples T-Test | Wide or Long |
| Paired Samples T-Test | Wide or Long *(wide preferred)* |
| One Sample T-Test | Wide (single column) |
| One-Way ANOVA | Wide or Long |
| Two-Way ANOVA | Long only |
| Multifactorial ANOVA (3-way) | Long only |

Post-hoc corrections available for ANOVA: Tukey, Bonferroni, Holm, Holm-Sidak, Sidak, Dunnett, FDR-BH.
Two-Way and Multifactorial ANOVA include interaction plots; simple effects analysis is available as an optional step.

### 📉 Nonparametric Tests

| Test | Accepted Data Format | Parametric equivalent |
|---|---|---|
| Mann-Whitney U Test | Wide or Long | Independent T-Test |
| Wilcoxon Signed-Rank Test | Wide or Long *(wide preferred)* | Paired T-Test |
| Kruskal-Wallis H Test | Wide or Long | One-Way ANOVA |
| Scheirer-Ray-Hare Test | Long only | Two-Way ANOVA |

### 📐 Regression & Correlation

Wide format — one column per variable, one row per observation.

| Test | Input |
|---|---|
| Simple Linear Regression | 1 outcome column + 1 predictor column |
| Multiple Linear Regression | 1 outcome column + 2 or more predictor columns |
| Binary Logistic Regression | 1 binary outcome column + 1 or more predictor columns |
| Multinomial Logistic Regression | 1 multi-class outcome column + 1 or more predictor columns |
| Pearson / Spearman / Kendall Tau Correlation | 2 or more numeric columns |

<table>
  <tr>
    <td><img src="assets/screenshots/logistic_regression_roc.png" alt="Binary Logistic Regression ROC curve" width="280"/></td>
    <td><img src="assets/screenshots/plot_box.png" alt="Box plot with significance brackets" width="280"/></td>
    <td><img src="assets/screenshots/plot_violin.png" alt="Violin plot" width="280"/></td>
  </tr>
  <tr>
    <td align="center"><em>ROC Curve</em></td>
    <td align="center"><em>Box Plot</em></td>
    <td align="center"><em>Violin Plot</em></td>
  </tr>
</table>

### 🗂️ Categorical Analysis

Wide format — one column per variable, one row per observation.

| Test | Input |
|---|---|
| Chi-Square Independence Test | 2 categorical columns |
| Chi-Square Goodness of Fit | 1 categorical column |
| Fisher's Exact Test | 2 categorical columns (2 categories each) |
| McNemar's Test | Before column + After column (paired) |

<img src="assets/screenshots/mcnemar_grouped_bar.png" alt="McNemar grouped bar chart" width="480"/>

### 📏 Distribution & Descriptive

Wide format — select one or more numeric columns.

| Test | Description |
|---|---|
| Shapiro-Wilk | Normality test (small to medium samples) |
| Kolmogorov-Smirnov | Normality test against a specified distribution |
| Anderson-Darling | Normality test with emphasis on distribution tails |
| Cramer-von Mises | Goodness-of-fit normality test |
| Jarque-Bera | Normality test based on skewness and kurtosis |
| Normality (All Tests) | Run all 5 normality tests simultaneously on a selected column |
| Descriptive Statistics | Mean, median, SD, quartiles, and outliers for 1 or more columns |
| Outlier Detection | Identify outliers across 1 or more numeric columns |

### 💊 Pharmacology & Dose-Response

Wide format — separate columns for dose and response values.

| Model | Description |
|---|---|
| 3-Parameter Logistic (3PL) | Fits IC50 / EC50 with fixed bottom (0) |
| 4-Parameter Logistic (4PL) | Fits IC50 / EC50 with variable Hill slope |

### ⏱️ Survival Analysis

Wide format — separate columns for time-to-event, event status, and grouping or predictor variables.

| Test | Input |
|---|---|
| Kaplan-Meier Analysis | Time column + event column + group column |
| Cox Proportional Hazards | Time column + event column + 1 or more predictor columns |
| Nelson-Aalen Estimator | Time column + event column + group column |

<img src="assets/screenshots/kaplan_meier_survival.png" alt="Kaplan-Meier survival curve" width="480"/>

### 🔗 Mediation & Moderation

Wide format — one column per variable, one row per observation.

| Analysis | Variables |
|---|---|
| Mediation Analysis (Baron & Kenny Model 4) | Exposure (X), Mediator (M), Outcome (Y) |
| Simple Moderation (Model 1) | Predictor (X), Moderator (W), Outcome (Y) |
| Moderated Mediation (Model 7) | Predictor (X), Mediator (M), Moderator (W), Outcome (Y) |

---

> 💡 **Data format tip:** easyCris accepts both wide and long formats where noted above.
> Use the built-in **Pivot Wider** and **Pivot Longer** tools in Data Cleaning to convert between formats before running your analysis.

---

## 🧬 RNA-seq Analysis

easyCris includes a complete bulk RNA-seq differential expression workflow, from raw count matrix to annotated results and QC plots.

### Data Preparation

| Step | Details |
|---|---|
| Count matrix | Raw integer counts (CSV) from featureCounts, HTSeq, STAR, GEO, or recount3 |
| Sample metadata | CSV with experimental factors — Treatment, Batch, Cell Line, Time Point, and more |
| Gene ID lookup | Ensembl, Entrez, UniProt, UniProt Swiss-Prot IDs → gene symbols |
| Duplicate genes | Sum duplicates or keep first occurrence |

### Model Configuration

| Model | Use case |
|---|---|
| Simple `~condition` | Compare two groups (e.g., Treated vs Control) |
| Multi-factor `~condition + batch` | Adjust for batch effects or continuous covariates |
| Interaction `~genotype * treatment` | Test whether treatment effect varies by genotype or cell line |
| Multi-run comparator | Run multiple contrasts in the same project and review results side by side |

### Results & Visualizations

| Output | Description |
|---|---|
| Results table | gene, baseMean, log2FoldChange, lfcSE, pvalue, padj (Benjamini-Hochberg) |
| PCA biplot | Samples colored by experimental factor — identify batch effects and outliers |
| Volcano plot | log2 fold change vs adjusted p-value — quick overview of the DE landscape |
| Heatmap | Significant genes filtered by adjusted p-value |

<table>
  <tr>
    <td><img src="assets/screenshots/rnaseq_pca_biplot.png" alt="RNA-seq PCA biplot" width="420"/></td>
    <td><img src="assets/screenshots/rnaseq_heatmap.png" alt="RNA-seq significant gene heatmap" width="420"/></td>
  </tr>
  <tr>
    <td align="center"><em>PCA Biplot</em></td>
    <td align="center"><em>Significant Gene Heatmap</em></td>
  </tr>
</table>

---

## 🧹 Data Cleaning

easyCris includes a set of data preparation tools to reshape, filter, and summarise your data before analysis. Each tool has a built-in reference guide with before-and-after examples accessible from the Help menu.

### Reshape

| Tool | When to use | What changes |
|---|---|---|
| **Pivot Wider** | Repeated measures are stacked in rows and you need them as separate columns — e.g., Pre/Post in one column → two separate columns | Row count decreases; column count increases |
| **Pivot Longer** | Each measurement is a separate column and you need them stacked for analysis — e.g., preparing data for repeated-measures tests that expect long format | Row count increases; column count decreases |

### Filter & Sort

| Tool | When to use | What changes |
|---|---|---|
| **Advanced Filter** | Keep only rows matching specific criteria — supports multiple conditions with AND / OR logic and parenthesized grouping | Non-matching rows removed; column structure preserved |
| **Sort** | Reorder rows by a specific variable — ascending or descending | Row order changes; no rows or columns added or removed |

### Summarise

| Tool | When to use | What changes |
|---|---|---|
| **Group & Aggregate** | Compute group means, sums, counts, or other statistics from raw data — e.g., mean score per treatment group | One row per unique group combination; values replaced by computed aggregate |
| **Outline** | Scan data by category without permanently reshaping — expand or collapse row groups to focus on one subset at a time | Data values unchanged; display only |

---

## 🧮 Formula Engine

The easyCris grid formula engine supports Excel-style formulas with dependency tracking, autocomplete, and backend-assisted evaluation for large ranges.

Autocomplete is intentionally limited to these categories (from the current allowed formula set):

| Category | Count | Examples |
|---|---:|---|
| **Math & Trigonometry** | 61 | SUM, ABS, ROUND, SQRT, MOD, LOG, SIN, COS, POWER |
| **Statistical** | 99 | AVERAGE, STDEV.S, COUNT, CORREL, PERCENTILE, NORM.DIST, T.DIST |
| **Date & Time** | 25 | TODAY, NOW, DATE, DATEDIF, NETWORKDAYS, YEAR, MONTH, DAY |
| **Financial** | 55 | NPV, IRR, PMT, FV, RATE |
| **Engineering** | 54 | BIN2DEC, HEX2DEC, CONVERT, COMPLEX, ERF, DELTA, GESTEP |

> Formulas use familiar spreadsheet syntax and run directly in the grid (no scripting required).

---

## 📈 Interactive Plots

All plots are interactive — hover for values, zoom, pan, and export as PNG.

Plots are auto-generated based on the test you run:

| Category | Plot types |
|---|---|
| Hypothesis testing | Bar, box, violin with significance brackets |
| ANOVA | Interaction plots, faceted grouped bar |
| Regression | Scatter, residual, forest, ROC |
| Categorical | Grouped bar, mosaic, heatmap |
| Distribution | Histogram, Q-Q plots, column scatter |
| Survival | Kaplan-Meier curves, cumulative hazard, forest |
| RNA-seq | PCA biplot, volcano, heatmap |
| Pharmacology | Dose-response curves |

<table>
  <tr>
    <td><img src="assets/screenshots/anova_bar_tukey.png" alt="ANOVA bar plot with Tukey brackets" width="280"/></td>
    <td><img src="assets/screenshots/anova_two_way_interaction.png" alt="Two-Way ANOVA interaction plot" width="280"/></td>
    <td><img src="assets/screenshots/kaplan_meier_survival.png" alt="Kaplan-Meier survival curve" width="280"/></td>
  </tr>
  <tr>
    <td align="center"><em>ANOVA + Tukey</em></td>
    <td align="center"><em>Interaction Plot</em></td>
    <td align="center"><em>Kaplan-Meier</em></td>
  </tr>
</table>

---

## 📖 In-App Help

easyCris ships with three built-in reference guides accessible from the Help menu:

| Guide | Contents |
|---|---|
| 📊 **Statistical Tests Guide** | Quick reference for every test — required inputs, parameters, and the plots that will be generated |
| 🧬 **RNA-seq Guide** | Step-by-step walkthrough from count matrix import to differential expression results |
| 🧹 **Data Cleaning Guide** | Reference for every reshape, filter, and aggregate tool with before-and-after examples |

---

## 💻 System Requirements

| | |
|---|---|
| OS | Windows 10 / 11 (x64) |
| RAM | 4 GB minimum, 8 GB recommended |
| Disk | ~200 MB |
| Internet | Not required for analysis; required only for update checks and downloads |

> macOS and Linux builds are planned for a future release.

---

## 🚀 Getting Started

1. Download the installer from the [Releases page](https://github.com/easyCris-software/easyCris/releases/latest)
2. Run the `.exe` installer (admin rights may depend on your system policy)
3. Open easyCris and import your CSV data
4. Select a statistical test or analysis workflow
5. Review your results table and auto-generated plots

---

## 📚 Citations

If you use easyCris in published research, please cite the underlying methods:

| Module | Citation |
|---|---|
| Parametric & Nonparametric Tests | Virtanen et al. (2020) SciPy 1.0: fundamental algorithms for scientific computing in Python. *Nature Methods*, 17, 261–272. https://doi.org/10.1038/s41592-019-0686-2 |
| Regression & Correlation | Seabold S. & Perktold J. (2010) Statsmodels: Econometric and statistical modeling with Python. *Proceedings of the 9th Python in Science Conference*. https://doi.org/10.25080/Majora-92bf1922-011 |
| Mediation & Moderation | Seabold S. & Perktold J. (2010) Statsmodels: Econometric and statistical modeling with Python. *Proceedings of the 9th Python in Science Conference*. https://doi.org/10.25080/Majora-92bf1922-011 |
| Survival Analysis | Davidson-Pilon C. (2019) lifelines: survival analysis in Python. *Journal of Open Source Software*, 4(40), 1317. https://doi.org/10.21105/joss.01317 |
| Dose-Response (3PL / 4PL) | Newville M. et al. (2014) LMFIT: Non-linear least-square minimization and curve-fitting for Python. *Zenodo*. https://doi.org/10.5281/zenodo.11813 |
| Nonparametric Post-hoc Tests | Terpilowski M. (2019) scikit-posthocs: Pairwise multiple comparison tests in Python. *Journal of Open Source Software*, 4(36), 1169. https://doi.org/10.21105/joss.01169 |
| RNA-seq Differential Expression | Love M.I., Huber W. & Anders S. (2014) Moderated estimation of fold change and dispersion for RNA-seq data with DESeq2. *Genome Biology*, 15, 550. https://doi.org/10.1186/s13059-014-0550-8 |

---

## ✅ Statistical Accuracy

Core statistical workflows and the RNA-seq pipeline are validated against published references and manuscript methods listed in the Citations section (including Love et al., 2014 for DESeq2).
Where applicable, validation comparisons are performed against established reference implementations from cited toolchains.

---

## ⚖️ License

Copyright © easyCris Software. All rights reserved.
Unauthorized copying, distribution, or modification is prohibited.
By downloading and using easyCris you agree to the Terms of Use included with the installer.

## ⚠️ Disclaimer

easyCris is intended for research purposes only.
It is not a medical device and should not be used for clinical diagnosis or treatment decisions.
