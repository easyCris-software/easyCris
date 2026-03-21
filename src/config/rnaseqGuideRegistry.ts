/**
 * Bulk RNA-seq Guide Registry
 *
 * Content definitions for the Bulk RNA-seq Guide dialog.
 * Each entry describes a step or concept in the easyCris RNA-seq workflow.
 */

export type RNAseqGuideCategory =
  | 'data_prep'
  | 'project_setup'
  | 'model_config'
  | 'advanced'
  | 'results'

export const RNASEQ_GUIDE_CATEGORIES: Record<RNAseqGuideCategory, string> = {
  data_prep: 'Data Preparation',
  project_setup: 'Project Setup',
  model_config: 'Model Configuration',
  advanced: 'Advanced Models',
  results: 'Results & Interpretation',
}

const CATEGORY_ORDER: RNAseqGuideCategory[] = [
  'data_prep',
  'project_setup',
  'model_config',
  'advanced',
  'results',
]

export interface RNAseqGuideDefinition {
  id: string
  title: string
  category: RNAseqGuideCategory
  badgeLabel?: string
  summary: string
  whenToUse: string[]
  requiredInputs: string[]
  whatToExpect: string[]
  pitfalls: string[]
  keywords: string[]
}

export const RNASEQ_GUIDE_REGISTRY: RNAseqGuideDefinition[] = [
  // ── Data Preparation ──────────────────────────────────
  {
    id: 'count_matrix',
    title: 'Preparing a Count Matrix',
    category: 'data_prep',
    summary:
      'The count matrix is a CSV where rows are genes and columns are samples. Values must be raw, un-normalized integer counts.',
    whenToUse: [
      'You have FASTQ/BAM files that have been aligned and quantified (e.g., featureCounts, HTSeq, STAR)',
      'You exported counts from a public database (GEO, recount3)',
      'You need to verify your file is in the right format before importing',
    ],
    requiredInputs: [
      'First column: gene identifiers (easyCris supports Ensembl, Entrez, UniProt, and UniProt Swiss-Prot IDs for lookup mode, or user-provided gene symbols)',
      'Remaining columns: one per sample, with integer counts',
      'No normalized values (FPKM, TPM, RPKM) — easyCris expects raw counts',
    ],
    whatToExpect: [
      'easyCris validates that all sample columns contain integers',
      'easyCris expects gene identifiers in the first column of the file',
      'Low-count filtering is controlled during run configuration (for example, via Min Count)',
    ],
    pitfalls: [
      'Normalized data (FPKM/TPM) will produce invalid differential expression results — always use raw counts',
      'Decimal values indicate normalization or estimation — round or re-quantify',
      'Duplicate gene IDs need a duplicate policy (sum or keep-first) set during configuration',
      'Excel may silently convert gene names like SEPT1 to dates — prefer CSV export from your pipeline',
    ],
    keywords: ['counts', 'matrix', 'csv', 'raw', 'integer', 'gene', 'sample', 'import', 'format'],
  },
  {
    id: 'metadata_design',
    title: 'Designing Sample Metadata',
    category: 'data_prep',
    summary:
      'The metadata CSV maps each sample to its experimental conditions. The first metadata column should contain sample IDs that match count-matrix sample columns.',
    whenToUse: [
      'You are setting up a new RNA-seq analysis and need to define experimental factors',
      'You want to include covariates like batch, RIN score, or sequencing lane',
      'Your experiment has a multi-factor design (e.g., Drug x CellLine x TimePoint)',
    ],
    requiredInputs: [
      'First metadata column: sample IDs matching count matrix sample names (trimmed and case-insensitive matching is applied)',
      'At least one categorical factor column (e.g., Treatment, Genotype, CellLine)',
      'Optional: continuous covariates (e.g., RIN_score, age, library_size)',
    ],
    whatToExpect: [
      'easyCris auto-detects categorical vs numeric columns from the metadata',
      'Factor columns appear in the model configuration dropdowns',
      'Covariates can be included in model configuration to control for confounders',
    ],
    pitfalls: [
      'Mismatched sample IDs between counts and metadata trigger sample mismatch warnings and can block runs until resolved',
      'Spaces or special characters in sample IDs can cause matching failures — use underscores',
      'A factor with only one level provides no contrast and will cause model errors',
      'Numeric-coded factors (1, 2, 3) may be treated as continuous — use string labels (Group_A, Group_B)',
    ],
    keywords: ['metadata', 'sample', 'factor', 'covariate', 'design', 'condition', 'batch', 'RIN'],
  },

  // ── Project Setup ─────────────────────────────────────
  {
    id: 'project_linking',
    title: 'Creating & Linking an RNA-seq Project',
    category: 'project_setup',
    summary:
      'An RNA-seq project pairs a count matrix with metadata and holds configured models and results.',
    whenToUse: [
      'You are starting a new RNA-seq analysis from scratch',
      'You imported the sample dataset and want to configure your first model',
      'You need to switch between multiple RNA-seq projects in the navigator',
    ],
    requiredInputs: [
      'A count matrix imported into the data store',
      'A metadata CSV imported into the data store',
      'Both linked to the same RNA-seq project via the sidebar controls',
    ],
    whatToExpect: [
      'The RNA-seq sidebar shows the project name with linked dataset indicators',
      'Counts and Metadata tabs let you preview and verify both datasets',
      'The Configure Model button becomes available once both datasets are linked',
    ],
    pitfalls: [
      'Importing a file into the Statistics workspace does not link it to RNA-seq — use the RNA-seq import buttons',
      'Deleting a linked dataset breaks the project link — re-import and re-link if needed',
      'Each project is independent — models and results do not transfer between projects',
    ],
    keywords: ['project', 'create', 'link', 'counts', 'metadata', 'import', 'sidebar', 'navigator'],
  },

  // ── Model Configuration ───────────────────────────────
  {
    id: 'simple_model',
    title: 'Simple Model: ~condition',
    category: 'model_config',
    summary:
      'The simplest easyCris model compares differential expression between levels of one factor.',
    whenToUse: [
      'Your experiment has one main factor (e.g., Treatment vs Control)',
      'You want to compare two or more groups without adjusting for covariates',
      'This is your first model and you want to verify the pipeline works',
    ],
    requiredInputs: [
      'Main factor: the metadata column containing group labels',
      'Reference level: the baseline group (e.g., "Control", "DMSO", "WT")',
      'Test level: the comparison group (e.g., "Treated", "Doxorubicin", "KO")',
      'Design preview is shown in the dialog (for example, ~condition)',
    ],
    whatToExpect: [
      'easyCris runs normalization, dispersion fitting, and fold-change estimation during analysis',
      'Results table: gene, baseMean, log2FoldChange, lfcSE, pvalue, padj',
      'Positive log2FC means higher in test group; negative means higher in reference',
      'padj (Benjamini-Hochberg) is the primary significance metric',
    ],
    pitfalls: [
      'Swapping reference and test flips the sign of log2FC but not significance',
      'With < 3 replicates per group, statistical power is low',
      'The reference level should be the biological control or baseline condition',
    ],
    keywords: ['simple', 'single', 'factor', 'condition', 'design', 'formula', 'reference', 'test', 'contrast'],
  },
  {
    id: 'multifactor_model',
    title: 'Multi-factor Model: ~condition + batch',
    category: 'model_config',
    summary:
      'Add additional main effects or covariates to control confounders while testing your primary factor.',
    whenToUse: [
      'Your samples were processed in different batches or sequencing lanes',
      'You want to adjust for a continuous covariate (e.g., RIN score, age)',
      'PCA shows separation by batch rather than by your factor of interest',
    ],
    requiredInputs: [
      'Main factor plus one or more additional effects/covariates from metadata',
      'Design preview (for example, ~batch + condition) updates from your selections',
      'Categorical covariates need 2+ levels; continuous covariates need numeric values',
    ],
    whatToExpect: [
      'easyCris adjusts for configured effects before estimating your primary contrast',
      'Results reflect the condition effect after controlling for covariates',
      'Adding batch typically increases power by reducing unexplained variance',
    ],
    pitfalls: [
      'Confounded designs (all Treatment samples in Batch 1, all Control in Batch 2) cannot be separated',
      'Too many covariates with few samples causes overfitting — keep the model parsimonious',
      'Covariates with very low variation can make models unstable',
    ],
    keywords: ['multi', 'factor', 'batch', 'covariate', 'adjust', 'control', 'blocking', 'RIN', 'confound'],
  },
  {
    id: 'gene_id_config',
    title: 'Gene ID Lookup & Duplicate Handling',
    category: 'model_config',
    summary:
      'Configure how gene identifiers are resolved and how duplicate gene entries are handled before analysis.',
    whenToUse: [
      'Your count matrix uses Ensembl, Entrez, UniProt, or UniProt Swiss-Prot IDs and you want gene symbols in results',
      'Your gene IDs have version suffixes (ENSG00000141510.12) that need stripping',
      'Multiple rows map to the same gene and you need a merge strategy',
    ],
    requiredInputs: [
      'Gene label source: "user_provided" (use as-is) or "id_lookup" (map via organism database)',
      'Organism: human, mouse, rat, etc. (for ID lookup mode)',
      'Gene ID type: ensembl, entrez, uniprot, or uniprot_swissprot (for ID lookup mode)',
      'Duplicate policy: "sum_duplicates" (add counts) or "keep_first" (take first occurrence)',
    ],
    whatToExpect: [
      'Version suffixes are auto-stripped (ENSG00000141510.12 becomes ENSG00000141510)',
      'Duplicate genes are merged per the selected policy with a warning count',
      'Rows with empty or unmappable gene labels are dropped with a diagnostic message',
    ],
    pitfalls: [
      'Wrong organism selection maps IDs incorrectly — verify organism matches your data',
      'sum_duplicates can inflate counts if duplicates are annotation artifacts, not biological',
      'keep_first is safer for initial exploration; sum_duplicates is better for known multi-mapping',
    ],
    keywords: ['gene', 'id', 'ensembl', 'entrez', 'uniprot', 'swiss-prot', 'symbol', 'lookup', 'organism', 'duplicate', 'version', 'strip'],
  },

  // ── Advanced Models ───────────────────────────────────
  {
    id: 'interaction_model',
    title: 'Interaction Model: ~genotype * treatment',
    category: 'advanced',
    summary:
      'Test whether the effect of one factor depends on the level of another factor using interaction terms.',
    whenToUse: [
      'You suspect the treatment effect differs between genotypes (or cell lines, sexes, etc.)',
      'Your hypothesis is specifically about the interaction, not just main effects',
      'You have a full factorial design with sufficient replicates in each cell',
    ],
    requiredInputs: [
      'At least two categorical factors available from metadata',
      'Interaction runs configured from factor selectors (easyCris builds the interaction formula)',
      'Reference levels for both factors must be set',
    ],
    whatToExpect: [
      'easyCris runs main-effect and interaction comparisons for the selected factors',
      'The interaction term (genotype:treatment) captures genes where treatment effect varies by genotype',
      'Significant interaction means the fold-change of treatment differs between genotype levels',
    ],
    pitfalls: [
      'Interaction models need more replicates — at least 3 per cell of the factorial design',
      'A non-significant interaction does not mean the main effects are absent',
      'With 3+ levels per factor, the interaction has multiple contrasts — check all',
      'Confounded designs make interaction effects unestimable',
    ],
    keywords: ['interaction', 'genotype', 'treatment', 'factorial', 'star', 'colon', 'depends', 'cross'],
  },
  {
    id: 'multirun_comparator',
    title: 'Multi-run Comparator',
    category: 'advanced',
    summary:
      'Run multiple models or contrasts in the same project and review each run from shared run history.',
    whenToUse: [
      'You want to test multiple contrasts (e.g., Drug A vs DMSO, Drug B vs DMSO)',
      'You are comparing models with and without a covariate to assess its impact',
      'You need to identify genes consistently DE across different comparisons',
    ],
    requiredInputs: [
      'Two or more completed RNA-seq result runs in the same project',
      'Each run should have a descriptive name for easy comparison',
    ],
    whatToExpect: [
      'Each configured run is saved in project run history with timestamp and model context',
      'You can open each run, inspect DE results, and export run outputs for external comparison',
      'Result/plot tabs stay tied to the selected run so interpretation remains traceable',
    ],
    pitfalls: [
      'Comparing models with different designs (e.g., ~condition vs ~condition + batch) is valid but results may shift',
      'Different reference levels produce different fold-change signs — ensure consistency',
      'Large numbers of runs can make the comparator view cluttered — focus on key contrasts',
    ],
    keywords: ['multi', 'run', 'compare', 'contrast', 'overlap', 'drift', 'batch', 'multiple'],
  },

  // ── Results & Interpretation ──────────────────────────
  {
    id: 'results_table',
    title: 'Interpreting the Results Table',
    category: 'results',
    summary:
      'Understand result columns and identify significant differentially expressed genes.',
    whenToUse: [
      'Your analysis has completed and you are reviewing the results tab',
      'You need to filter for significant genes or export a gene list',
      'You want to understand what each column means before interpreting biology',
    ],
    requiredInputs: [
      'A completed RNA-seq run with results available in the Results tab',
    ],
    whatToExpect: [
      'baseMean: average normalized count across all samples (higher = more expressed)',
      'log2FoldChange: effect size (positive = up in test group, negative = down)',
      'lfcSE: standard error of the fold change estimate',
      'pvalue: raw p-value from the Wald test',
      'padj: Benjamini-Hochberg adjusted p-value (use this for significance)',
    ],
    pitfalls: [
      'Use padj (not pvalue) to determine significance — raw p-values are not corrected for multiple testing',
      'Genes with very low baseMean may show large fold changes but are unreliable',
      'NA values in padj indicate genes filtered by independent filtering (low information)',
      'Shrinkage (apeglm) changes log2FC values but not padj — it improves ranking, not significance calls',
    ],
    keywords: ['results', 'table', 'padj', 'log2fc', 'basemean', 'significant', 'wald', 'fold change', 'interpret'],
  },
  {
    id: 'pca_qc',
    title: 'PCA & Quality Control Plots',
    category: 'results',
    summary:
      'Use PCA plots and other QC visualizations to assess sample relationships, detect outliers, and verify experimental design.',
    whenToUse: [
      'Before interpreting DE results, to verify samples group as expected',
      'You suspect batch effects, outliers, or sample swaps',
      'You want to check whether the main factor of interest drives the largest variance',
    ],
    requiredInputs: [
      'A completed RNA-seq run (PCA is computed from transformed count values)',
    ],
    whatToExpect: [
      'PCA plot: samples colored by factor, showing PC1 vs PC2 with variance explained',
      'Samples from the same group should cluster together',
      'Gene selection mode controls which genes drive PCA (significant, variable, or both)',
      'Volcano plot: log2FC vs -log10(padj) for quick visual of DE landscape',
    ],
    pitfalls: [
      'If batch drives PC1 instead of your factor, consider adding batch to the model',
      'A single outlier sample can dominate PCA — consider removing and re-running',
      'PCA with too few genes may not capture the true variance structure',
      'Variance explained by PC1+PC2 < 50% suggests complex or noisy data',
    ],
    keywords: ['pca', 'qc', 'quality', 'outlier', 'batch', 'variance', 'volcano', 'plot', 'cluster'],
  },
]

/**
 * Returns guide entries grouped by category in display order.
 */
export function getGuidesByCategory(): Array<[RNAseqGuideCategory, RNAseqGuideDefinition[]]> {
  const map = new Map<RNAseqGuideCategory, RNAseqGuideDefinition[]>()
  for (const entry of RNASEQ_GUIDE_REGISTRY) {
    if (!map.has(entry.category)) {
      map.set(entry.category, [])
    }
    map.get(entry.category)!.push(entry)
  }
  return CATEGORY_ORDER
    .filter((cat) => map.has(cat))
    .map((cat) => [cat, map.get(cat)!] as const)
}
