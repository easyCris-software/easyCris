/**
 * ECP-Style Table View Component
 *
 * Renders ECP-Style statistical output tables with monospace formatting.
 * Supports publication-ready display and Excel export.
 */

import React from 'react';
import type {
  ECPTable,
  ECPTableCollection,
  ECPRow,
  ECPCell,
} from '../../types/ecpStyleTables';

// =============================================================================
// PROPS
// =============================================================================

interface ECPTableViewProps {
  /** Collection of tables to render */
  tableCollection: ECPTableCollection;
  /** Optional class name for the container */
  className?: string;
  /** Optional: show footnotes */
  showFootnotes?: boolean;
  /** Optional: compact mode */
  compact?: boolean;
}

interface SingleTableProps {
  table: ECPTable;
  compact?: boolean;
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

/**
 * Renders a collection of ECP-Style tables
 */
export function ECPTableView({
  tableCollection,
  className = '',
  showFootnotes: _showFootnotes = true,
  compact = false,
}: ECPTableViewProps) {
  // Note: _showFootnotes reserved for future conditional footnote rendering
  if (!tableCollection.tables || tableCollection.tables.length === 0) {
    return (
      <div className="text-muted-foreground text-sm p-4">
        No tables available for this test.
      </div>
    );
  }

  return (
    <div data-testid="results-table" className={`ecp-table-collection space-y-6 ${className}`}>
      {/* Metadata header */}
      <div className="ecp-metadata text-xs text-muted-foreground border-b pb-2">
        <span className="font-mono">
          {tableCollection.testFamily.toUpperCase()} / {tableCollection.testType}
        </span>
        {tableCollection.metadata?.timestamp && (
          <span className="ml-4">
            {new Date(tableCollection.metadata.timestamp).toLocaleString()}
          </span>
        )}
        {tableCollection.metadata?.counts && tableCollection.metadata.counts.length > 0 ? (
          tableCollection.metadata.counts.map((count) => (
            <span key={`${count.label}-${count.value}`} className="ml-4">
              {count.label} = {count.value}
            </span>
          ))
        ) : tableCollection.metadata?.sampleSize ? (
          <span className="ml-4">N = {tableCollection.metadata.sampleSize}</span>
        ) : null}
        {tableCollection.metadata?.posthocAdjustment && (
          <span className="ml-4">Post-hoc: {tableCollection.metadata.posthocAdjustment}</span>
        )}
      </div>

      {/* Render each table */}
      {tableCollection.tables.map((table, index) => (
        <ECPTableRenderer
          key={`${table.testName || table.title}-${index}`}
          table={table}
          compact={compact}
        />
      ))}
    </div>
  );
}

// =============================================================================
// SINGLE TABLE RENDERER
// =============================================================================

function ECPTableRenderer({ table, compact }: SingleTableProps) {
  return (
    <div className="ecp-table bg-card border rounded-md overflow-hidden">
      {/* Procedure name */}
      {table.procedure && (
        <div className="ecp-procedure bg-muted/50 px-4 py-1 text-xs text-muted-foreground font-mono text-center border-b">
          {table.procedure}
        </div>
      )}

      {/* Dependent variable */}
      {table.dependentVar && (
        <div className="ecp-depvar px-4 py-1 text-xs font-mono text-center border-b">
          Dependent Variable: {table.dependentVar}
        </div>
      )}

      {/* Table title */}
      <div className="ecp-title px-4 py-2 font-semibold text-sm border-b bg-muted/30">
        {table.title}
      </div>

      {/* Table content */}
      <div className="ecp-content overflow-x-auto">
        <table className={`w-full font-mono text-sm ${compact ? 'text-xs' : ''}`}>
          <tbody>
            {table.rows.map((row, rowIndex) => (
              <ECPRowRenderer
                key={rowIndex}
                row={row}
                columns={table.columns}
                compact={compact}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* Footnotes */}
      {table.footnotes && table.footnotes.length > 0 && (
        <div className="ecp-footnotes px-4 py-2 text-xs text-muted-foreground border-t bg-muted/20">
          {table.footnotes.map((note, i) => (
            <div key={i} className="italic">
              {note}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// ROW RENDERER
// =============================================================================

interface ECPRowRendererProps {
  row: ECPRow;
  columns: ECPTable['columns'];
  compact?: boolean;
}

function ECPRowRenderer({ row, columns, compact }: ECPRowRendererProps) {
  // Separator row
  if (row.isSeparator) {
    return (
      <tr className="ecp-separator">
        <td colSpan={columns.length} className="border-b border-dashed h-1" />
      </tr>
    );
  }

  // Subheader row
  if (row.isSubheader) {
    return (
      <tr className="ecp-subheader bg-muted/40">
        {row.cells.map((cell, cellIndex) => (
          <td
            key={cellIndex}
            colSpan={cell.colSpan}
            className={`px-3 py-1 font-semibold ${compact ? 'px-2 py-0.5' : ''}`}
            {...(cell.attrs || {})}
          >
            {formatCellValue(cell)}
          </td>
        ))}
      </tr>
    );
  }

  // Header row
  if (row.isHeader) {
    return (
      <tr className="ecp-header bg-muted">
        {row.cells.map((cell, cellIndex) => {
          const col = columns[cellIndex];
          return (
            <th
              key={cellIndex}
              colSpan={cell.colSpan}
              rowSpan={cell.rowSpan}
              className={`px-3 py-1.5 font-semibold border-b-2 border-foreground/30 ${compact ? 'px-2 py-1' : ''} ${getAlignmentClass(cell.align || col?.align)}`}
              {...(cell.attrs || {})}
            >
              {formatCellValue(cell)}
            </th>
          );
        })}
      </tr>
    );
  }

  // Data row
  return (
    <tr className="ecp-data-row hover:bg-muted/20 border-b border-muted/50">
      {row.cells.map((cell, cellIndex) => {
        const col = columns[cellIndex];
        return (
          <td
            key={cellIndex}
            colSpan={cell.colSpan}
            rowSpan={cell.rowSpan}
            className={`px-3 py-1 ${compact ? 'px-2 py-0.5' : ''} ${getAlignmentClass(cell.align || col?.align)} ${cell.isSignificant ? 'text-primary font-semibold' : ''} ${cell.isBold ? 'font-bold' : ''}`}
            style={{ paddingLeft: row.indent ? `${row.indent * 16 + 12}px` : undefined }}
            {...(cell.attrs || {})}
          >
            {formatCellValue(cell)}
          </td>
        );
      })}
    </tr>
  );
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

function getAlignmentClass(align?: 'left' | 'right' | 'center'): string {
  switch (align) {
    case 'right':
      return 'text-right';
    case 'center':
      return 'text-center';
    default:
      return 'text-left';
  }
}

function formatCellValue(cell: ECPCell): React.ReactNode {
  if (cell.value === null || cell.value === undefined) {
    return '.';
  }

  // If it's already a formatted string, return as-is
  if (typeof cell.value === 'string') {
    return cell.value;
  }

  // Number formatting based on cell format
  if (typeof cell.value === 'number') {
    switch (cell.format) {
      case 'integer':
        return cell.value.toFixed(0);
      case 'pvalue':
        if (cell.value < 0.001) {
          return '<0.001';
        }
        return cell.value.toFixed(4);
      case 'percent':
        return `${cell.value.toFixed(2)}%`;
      case 'scientific':
        return cell.value.toExponential(4);
      case 'decimal':
      default:
        return cell.value.toFixed(4);
    }
  }

  return String(cell.value);
}

// =============================================================================
// EXPORT UTILITY
// =============================================================================

/**
 * Convert ECP table collection to plain text format
 */
export function tablesToPlainText(collection: ECPTableCollection): string {
  const lines: string[] = [];

  // Header
  lines.push('=' .repeat(80));
  lines.push(`${collection.testFamily.toUpperCase()} - ${collection.testType}`);
  if (collection.metadata?.timestamp) {
    lines.push(`Generated: ${new Date(collection.metadata.timestamp).toLocaleString()}`);
  }
  if (collection.metadata?.posthocAdjustment) {
    lines.push(`Post-hoc: ${collection.metadata.posthocAdjustment}`);
  }
  if (collection.metadata?.counts && collection.metadata.counts.length > 0) {
    for (const count of collection.metadata.counts) {
      lines.push(`${count.label}: ${count.value}`);
    }
  } else if (collection.metadata?.sampleSize) {
    lines.push(`N: ${collection.metadata.sampleSize}`);
  }
  lines.push('='.repeat(80));
  lines.push('');

  // Each table
  for (const table of collection.tables) {
    if (table.procedure) {
      lines.push(table.procedure);
    }
    if (table.dependentVar) {
      lines.push(`Dependent Variable: ${table.dependentVar}`);
    }
    lines.push('');
    lines.push(table.title);
    lines.push('-'.repeat(table.title.length));
    lines.push('');

    // Build column widths
    const widths = table.columns.map(col => col.width || 12);

    // Rows
    for (const row of table.rows) {
      if (row.isSeparator) {
        lines.push('-'.repeat(widths.reduce((a, b) => a + b + 2, 0)));
        continue;
      }

      const rowText = row.cells.map((cell, i) => {
        const value = formatCellValuePlain(cell);
        const width = widths[i] || 12;
        const align = cell.align || table.columns[i]?.align || 'left';
        return padCell(value, width, align);
      }).join('  ');

      lines.push(rowText);
    }

    // Footnotes
    if (table.footnotes) {
      lines.push('');
      for (const note of table.footnotes) {
        lines.push(`* ${note}`);
      }
    }

    lines.push('');
    lines.push('');
  }

  return lines.join('\n');
}

function formatCellValuePlain(cell: ECPCell): string {
  if (cell.value === null || cell.value === undefined) {
    return '.';
  }
  if (typeof cell.value === 'string') {
    return cell.value;
  }
  if (typeof cell.value === 'number') {
    if (cell.format === 'integer') {
      return cell.value.toFixed(0);
    }
    if (cell.format === 'pvalue' && cell.value < 0.001) {
      return '<0.001';
    }
    return cell.value.toFixed(4);
  }
  return String(cell.value);
}

function padCell(value: string, width: number, align: 'left' | 'right' | 'center'): string {
  const padLength = Math.max(0, width - value.length);
  switch (align) {
    case 'right':
      return ' '.repeat(padLength) + value;
    case 'center':
      const left = Math.floor(padLength / 2);
      const right = padLength - left;
      return ' '.repeat(left) + value + ' '.repeat(right);
    default:
      return value + ' '.repeat(padLength);
  }
}

// =============================================================================
// DEFAULT EXPORT
// =============================================================================

export default ECPTableView;


