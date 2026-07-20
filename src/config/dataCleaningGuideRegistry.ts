/**
 * Data Cleaning Guide Registry
 *
 * Content definitions for the Data Cleaning Guide dialog.
 * Each entry describes a data tool available in easyCris.
 */

export type DataToolCategory = 'reshape' | 'filter_sort' | 'summarize' | 'navigate'
export const DATA_CLEANING_ACTION_IDS = [
  'pivot_wider',
  'pivot_longer',
  'advanced_filter',
  'sort',
  'group_aggregate',
  'outline',
] as const
export type DataCleaningActionId = (typeof DATA_CLEANING_ACTION_IDS)[number]

export function isDataCleaningActionId(value: string): value is DataCleaningActionId {
  return (DATA_CLEANING_ACTION_IDS as readonly string[]).includes(value)
}

export interface BeforeAfterExample {
  before: string[][]
  after: string[][]
  caption?: string
}

export interface DataToolDefinition {
  id: string
  title: string
  category: DataToolCategory
  badgeLabel?: string
  summary: string
  whenToUse: string[]
  requiredInputs: string[]
  whatChanges: string[]
  pitfalls: string[]
  exampleBeforeAfter: BeforeAfterExample
  keywords: string[]
  actionId?: DataCleaningActionId
}

export const DATA_TOOL_CATEGORIES: Record<DataToolCategory, string> = {
  reshape: 'Reshape',
  filter_sort: 'Filter & Sort',
  summarize: 'Summarize',
  navigate: 'Navigate',
}

const CATEGORY_ORDER: DataToolCategory[] = ['reshape', 'filter_sort', 'summarize', 'navigate']

export const DATA_TOOL_REGISTRY: DataToolDefinition[] = [
  {
    id: 'pivot_wider',
    title: 'Pivot Wider',
    category: 'reshape',
    summary: 'Spread a column\'s values into new columns, converting long-format data to wide-format.',
    whenToUse: [
      'Repeated measures are stacked in rows and you need them as separate columns',
      'Each subject has multiple rows (e.g., Pre/Post) and you want one row per subject',
      'A "condition" or "time" column should become column headers',
    ],
    requiredInputs: [
      'Names From — the column whose unique values become new column names',
      'Values From — the column(s) whose values fill those new columns',
    ],
    whatChanges: [
      'Row count decreases (rows are collapsed per unique ID combination)',
      'Column count increases (one new column per unique value in "Names From")',
      'Original "Names From" and "Values From" columns are consumed',
    ],
    pitfalls: [
      'Missing ID columns cause row-index alignment (may produce unexpected pairings)',
      'Duplicate ID + Name combinations need aggregation (mean/sum/first/last/count) or list output to avoid ambiguity',
      'Non-uniform group sizes produce empty cells in the wider result',
    ],
    exampleBeforeAfter: {
      before: [
        ['Subject', 'Time', 'Score'],
        ['S1', 'Pre', '80'],
        ['S1', 'Post', '92'],
        ['S2', 'Pre', '75'],
        ['S2', 'Post', '88'],
      ],
      after: [
        ['Subject', 'Pre', 'Post'],
        ['S1', '80', '92'],
        ['S2', '75', '88'],
      ],
      caption: 'Names From: Time, Values From: Score',
    },
    keywords: ['wide', 'spread', 'reshape', 'pivot', 'columns', 'long to wide', 'unstacking'],
    actionId: 'pivot_wider',
  },
  {
    id: 'pivot_longer',
    title: 'Pivot Longer',
    category: 'reshape',
    summary: 'Stack multiple columns into key-value rows, converting wide-format data to long-format.',
    whenToUse: [
      'Each measurement is a separate column and you need them stacked for analysis',
      'Preparing data for repeated-measures tests that expect long format',
      'Column headers contain variable values (e.g., Day1, Day2, Day3)',
    ],
    requiredInputs: [
      'Columns to Pivot — the columns to stack into rows',
      'Names To — name for the new column that receives the original column headers',
      'Values To — name for the new column that receives the cell values',
    ],
    whatChanges: [
      'Row count increases (one row per pivoted column per original row)',
      'Column count decreases (pivoted columns merge into two: name + value)',
      'Non-pivoted columns are repeated for each new row',
    ],
    pitfalls: [
      'Pivoting columns of mixed types can produce unexpected string conversions',
      'Forgetting to exclude ID columns from the pivot selection',
      'Very wide datasets can create a very large number of rows',
    ],
    exampleBeforeAfter: {
      before: [
        ['Subject', 'Pre', 'Post'],
        ['S1', '80', '92'],
        ['S2', '75', '88'],
      ],
      after: [
        ['Subject', 'Time', 'Score'],
        ['S1', 'Pre', '80'],
        ['S1', 'Post', '92'],
        ['S2', 'Pre', '75'],
        ['S2', 'Post', '88'],
      ],
      caption: 'Columns to Pivot: Pre, Post → Names To: Time, Values To: Score',
    },
    keywords: ['long', 'melt', 'unpivot', 'stack', 'reshape', 'wide to long', 'gather'],
    actionId: 'pivot_longer',
  },
  {
    id: 'advanced_filter',
    title: 'Advanced Filter',
    category: 'filter_sort',
    summary: 'Filter rows using multiple conditions with AND/OR logic and parenthesized grouping.',
    whenToUse: [
      'You need to keep only rows matching specific criteria before analysis',
      'Combining multiple conditions: e.g., Age > 30 AND Gender = "Male"',
      'Complex logic with groups: (A AND B) OR (C AND D)',
    ],
    requiredInputs: [
      'Column — the column to filter on',
      'Operator — equals, not equals, greater than, contains, is empty, regex, etc.',
      'Value — the comparison value (not needed for "is empty" / "is not empty")',
    ],
    whatChanges: [
      'Row count decreases (non-matching rows are removed)',
      'Column structure is preserved (no columns added or removed)',
      'In-place operation — original data is replaced (undo available)',
    ],
    pitfalls: [
      'Filtering on the wrong column type (numeric comparisons on text data)',
      'Case sensitivity — off by default, toggle "Aa" to enable',
      'Empty/missing values (NA, N/A, blank) are treated as empty by "is empty"',
    ],
    exampleBeforeAfter: {
      before: [
        ['Name', 'Age', 'Group'],
        ['Alice', '28', 'Control'],
        ['Bob', '35', 'Treatment'],
        ['Carol', '22', 'Control'],
        ['Dave', '41', 'Treatment'],
      ],
      after: [
        ['Name', 'Age', 'Group'],
        ['Bob', '35', 'Treatment'],
        ['Dave', '41', 'Treatment'],
      ],
      caption: 'Filter: Group = "Treatment"',
    },
    keywords: ['filter', 'subset', 'where', 'condition', 'remove rows', 'select rows', 'query'],
    actionId: 'advanced_filter',
  },
  {
    id: 'sort',
    title: 'Sort',
    category: 'filter_sort',
    summary: 'Reorder rows by a selected column in ascending or descending order.',
    whenToUse: [
      'You need data ordered by a specific variable before inspection or export',
      'Ranking values in one column (e.g., highest score to lowest score)',
      'Finding extreme values (highest/lowest) quickly',
    ],
    requiredInputs: [
      'Column — the column to sort by',
      'Direction — ascending (A→Z, 1→9) or descending (Z→A, 9→1)',
    ],
    whatChanges: [
      'Row order changes (rows are rearranged)',
      'No rows or columns are added or removed',
      'In-place operation — original order is replaced',
    ],
    pitfalls: [
      'Numeric columns stored as text sort lexicographically ("9" > "10")',
      'Empty/missing values typically sort to the end',
      'This dialog applies one sort key at a time; applying a new sort replaces the previous sort order',
    ],
    exampleBeforeAfter: {
      before: [
        ['Name', 'Score'],
        ['Alice', '75'],
        ['Bob', '92'],
        ['Carol', '88'],
      ],
      after: [
        ['Name', 'Score'],
        ['Bob', '92'],
        ['Carol', '88'],
        ['Alice', '75'],
      ],
      caption: 'Sort by Score, descending',
    },
    keywords: ['sort', 'order', 'arrange', 'rank', 'ascending', 'descending'],
    actionId: 'sort',
  },
  {
    id: 'group_aggregate',
    title: 'Group & Aggregate',
    category: 'summarize',
    summary: 'Group rows by one or more columns and compute summary statistics for each group.',
    whenToUse: [
      'Computing group means, sums, or counts from raw data',
      'Creating a summary table (e.g., mean score per treatment group)',
      'Reducing a large dataset to one row per group for reporting',
    ],
    requiredInputs: [
      'Group By — one or more columns that define the groups',
      'Aggregation — function for each remaining column: Sum, Average, Count, Min, Max, Median, Std Dev, or None',
    ],
    whatChanges: [
      'Row count decreases to one row per unique group combination',
      'Columns set to "None" are excluded from the output',
      'Values are replaced by the computed aggregate (mean, sum, etc.)',
    ],
    pitfalls: [
      'Numeric aggregations (Sum, Average, Median, Std Dev) require numeric columns',
      'Count counts non-null values, not total rows',
      '"None" excludes a column entirely — use Count if you want to keep it',
    ],
    exampleBeforeAfter: {
      before: [
        ['Group', 'Score'],
        ['A', '80'],
        ['A', '90'],
        ['B', '70'],
        ['B', '85'],
      ],
      after: [
        ['Group', 'Score'],
        ['A', '85'],
        ['B', '77.5'],
      ],
      caption: 'Group By: Group, Aggregation: Score → Average',
    },
    keywords: ['group', 'aggregate', 'summarize', 'mean', 'sum', 'count', 'rollup', 'collapse'],
    actionId: 'group_aggregate',
  },
  {
    id: 'outline',
    title: 'Outline',
    category: 'summarize',
    badgeLabel: 'Navigate',
    summary: 'Create expandable/collapsible row groups based on unique values in a selected column.',
    whenToUse: [
      'You want to scan data by category without permanently reshaping the dataset',
      'Reviewing patterns within groups such as Treatment, Region, or Timepoint',
      'Temporarily collapsing groups to focus on one subset at a time',
    ],
    requiredInputs: [
      'Outline by Column — choose the column whose unique values define row groups',
    ],
    whatChanges: [
      'Data values are unchanged; outline affects grid presentation only',
      'Rows are shown in expandable/collapsible groups by selected column value',
    ],
    pitfalls: [
      'Columns with many unique values can create too many small groups',
      'Outline is not an aggregation; repeated rows remain repeated inside each group',
    ],
    exampleBeforeAfter: {
      before: [
        ['Group', 'Subject', 'Score'],
        ['Control', 'S1', '80'],
        ['Control', 'S2', '75'],
        ['Treatment', 'S3', '92'],
        ['Treatment', 'S4', '88'],
      ],
      after: [
        ['Outline', 'Subject', 'Score'],
        ['▼ Control', 'S1', '80'],
        ['', 'S2', '75'],
        ['▶ Treatment', '2 rows', 'collapsed'],
      ],
      caption: 'Outline by Column: Group',
    },
    keywords: ['outline', 'group rows', 'collapse', 'expand', 'hierarchy', 'view'],
    actionId: 'outline',
  },
]

/**
 * Returns tools grouped by category in display order.
 */
export function getToolsByCategory(): Array<[DataToolCategory, DataToolDefinition[]]> {
  const map = new Map<DataToolCategory, DataToolDefinition[]>()
  for (const tool of DATA_TOOL_REGISTRY) {
    if (!map.has(tool.category)) {
      map.set(tool.category, [])
    }
    map.get(tool.category)!.push(tool)
  }
  return CATEGORY_ORDER
    .filter((cat) => map.has(cat))
    .map((cat) => [cat, map.get(cat)!] as const)
}
