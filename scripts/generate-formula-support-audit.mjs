import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import FormulaParser from 'fast-formula-parser';

const ROOT = process.cwd();
const FORMULA_SERVICE_PATH = path.join(ROOT, 'src', 'lib', 'grid', 'formulas', 'formulaService.ts');
const OUTPUT_DIR = path.join(ROOT, '_documentation', 'formula');
const OUTPUT_AUDIT_PATH = path.join(OUTPUT_DIR, 'FORMULA_SUPPORT_AUDIT.md');
const OUTPUT_MANIFEST_PATH = path.join(OUTPUT_DIR, 'FORMULA_SUPPORT_MANIFEST.json');
const CHECK_MODE = process.argv.includes('--check');

const CATEGORY_LABELS = {
  math: 'Math & Trig',
  statistical: 'Statistical',
  logical: 'Logical',
  date: 'Date & Time',
  financial: 'Financial',
  engineering: 'Engineering',
};

const CATEGORY_ORDER = ['math', 'statistical', 'logical', 'date', 'financial', 'engineering'];

function parseSource(filePath) {
  return ts.createSourceFile(
    filePath,
    fs.readFileSync(filePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
}

function unwrap(node) {
  let cur = node;
  while (cur && (ts.isAsExpression(cur) || ts.isParenthesizedExpression(cur))) {
    cur = cur.expression;
  }
  return cur;
}

function getVarInitializer(src, name) {
  for (const st of src.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const decl of st.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.name.text === name) {
        return decl.initializer ?? null;
      }
    }
  }
  return null;
}

function parseStringLiteral(expr) {
  const node = unwrap(expr);
  if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
    return node.text;
  }
  return null;
}

function parseBooleanLiteral(expr) {
  const node = unwrap(expr);
  if (!node) return null;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  return null;
}

function parseStringArray(node) {
  const arr = unwrap(node);
  if (!arr || !ts.isArrayLiteralExpression(arr)) return [];
  const out = [];
  for (const el of arr.elements) {
    const txt = parseStringLiteral(el);
    if (txt) out.push(txt);
  }
  return out;
}

function parseObjectOfStringArrays(node) {
  const obj = unwrap(node);
  if (!obj || !ts.isObjectLiteralExpression(obj)) return {};

  const out = {};
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const key = ts.isIdentifier(prop.name)
      ? prop.name.text
      : ts.isStringLiteral(prop.name)
        ? prop.name.text
        : null;
    if (!key) continue;
    out[key] = parseStringArray(prop.initializer);
  }
  return out;
}

function parseSetOfStrings(node) {
  const expr = unwrap(node);
  if (!expr || !ts.isNewExpression(expr)) return [];
  if (!expr.expression || !ts.isIdentifier(expr.expression) || expr.expression.text !== 'Set') {
    return [];
  }
  if (!expr.arguments || expr.arguments.length === 0) return [];
  return parseStringArray(expr.arguments[0]);
}

function parseStringMap(node) {
  const obj = unwrap(node);
  if (!obj || !ts.isObjectLiteralExpression(obj)) return {};

  const out = {};
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const key = ts.isIdentifier(prop.name)
      ? prop.name.text
      : ts.isStringLiteral(prop.name)
        ? prop.name.text
        : null;
    if (!key) continue;
    const value = parseStringLiteral(prop.initializer);
    if (value) out[key.toUpperCase()] = value;
  }
  return out;
}

function parseBackendFunctionPolicy(node) {
  const arr = unwrap(node);
  if (!arr || !ts.isArrayLiteralExpression(arr)) return [];

  const out = [];
  for (const el of arr.elements) {
    const obj = unwrap(el);
    if (!obj || !ts.isObjectLiteralExpression(obj)) continue;

    let name = null;
    let backendSupport = null;
    let autocompleteVisible = null;
    let spillRisk = null;

    for (const prop of obj.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const key = ts.isIdentifier(prop.name)
        ? prop.name.text
        : ts.isStringLiteral(prop.name)
          ? prop.name.text
          : null;
      if (!key) continue;

      if (key === 'name') name = parseStringLiteral(prop.initializer);
      if (key === 'backendSupport') backendSupport = parseStringLiteral(prop.initializer);
      if (key === 'autocompleteVisible') autocompleteVisible = parseBooleanLiteral(prop.initializer);
      if (key === 'spillRisk') spillRisk = parseStringLiteral(prop.initializer);
    }

    if (!name || (backendSupport !== 'scalar' && backendSupport !== 'array')) continue;

    out.push({
      name,
      backendSupport,
      spillRisk: spillRisk ?? 'none',
      autocompleteVisible: autocompleteVisible ?? backendSupport === 'scalar',
    });
  }

  return out;
}

function markdownEscapeCell(value) {
  return String(value)
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim();
}

function parseSignatureDetails(functionName, signature) {
  if (!signature) {
    return {
      signature: null,
      args: [],
      arity: { min: null, max: null, kind: 'unknown' },
      docStatus: 'pending',
    };
  }

  const fallbackPattern = new RegExp(`^${functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\(\\.\\.\\.\\)$`, 'i');
  if (fallbackPattern.test(signature.trim())) {
    return {
      signature: null,
      args: [],
      arity: { min: null, max: null, kind: 'unknown' },
      docStatus: 'pending',
    };
  }

  const openIdx = signature.indexOf('(');
  const closeIdx = signature.lastIndexOf(')');
  if (openIdx === -1 || closeIdx === -1 || closeIdx < openIdx) {
    return {
      signature: null,
      args: [],
      arity: { min: null, max: null, kind: 'unknown' },
      docStatus: 'pending',
    };
  }

  const body = signature.slice(openIdx + 1, closeIdx).trim();
  if (!body) {
    return {
      signature,
      args: [],
      arity: { min: 0, max: 0, kind: 'fixed' },
      docStatus: 'complete',
    };
  }

  const tokens = body
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);

  const args = [];
  let requiredCount = 0;
  let optionalCount = 0;
  let variadic = false;
  let position = 1;

  for (const token of tokens) {
    if (token === '...') {
      variadic = true;
      continue;
    }
    const isOptional = token.includes('[') || token.includes(']');
    const isVariadic = token.includes('...');
    const cleanName = token
      .replace(/[\[\]]/g, '')
      .replace(/\.\.\./g, '')
      .trim();

    const name = cleanName || `arg${position}`;
    args.push({
      name,
      optional: isOptional || isVariadic,
      variadic: isVariadic,
    });
    if (isOptional || isVariadic) optionalCount += 1;
    else requiredCount += 1;
    if (isVariadic) variadic = true;
    position += 1;
  }

  const max = variadic ? null : requiredCount + optionalCount;
  const kind =
    variadic ? 'variadic' : optionalCount > 0 ? 'range' : 'fixed';

  return {
    signature,
    args,
    arity: { min: requiredCount, max, kind },
    docStatus: 'complete',
  };
}

function synthesizeArgsFromArity(arity) {
  if (!Number.isInteger(arity) || arity <= 0) return [];
  const args = [];
  for (let idx = 1; idx <= arity; idx += 1) {
    args.push({
      name: `arg${idx}`,
      optional: false,
      variadic: false,
    });
  }
  return args;
}

function signatureFromArgs(functionName, args, arityKind) {
  if (!args || args.length === 0) return `${functionName}()`;
  const formattedArgs = args.map((arg) =>
    arg.variadic ? `${arg.name}...` : arg.optional ? `[${arg.name}]` : arg.name
  );
  if (arityKind === 'variadic' && !formattedArgs.some((arg) => arg.includes('...'))) {
    formattedArgs.push('...');
  }
  return `${functionName}(${formattedArgs.join(', ')})`;
}

function buildArtifacts() {
  if (!fs.existsSync(FORMULA_SERVICE_PATH)) {
    throw new Error(`formulaService.ts not found: ${FORMULA_SERVICE_PATH}`);
  }

  const src = parseSource(FORMULA_SERVICE_PATH);

  const excel = parseObjectOfStringArrays(getVarInitializer(src, 'EXCEL_FUNCTIONS'));
  const backendPolicy = parseBackendFunctionPolicy(getVarInitializer(src, 'BACKEND_FUNCTION_POLICY'));
  const backendScalar = new Set(
    backendPolicy
      .filter((entry) => entry.backendSupport === 'scalar')
      .map((entry) => entry.name.toUpperCase())
  );
  const backendArray = new Set(
    backendPolicy
      .filter((entry) => entry.backendSupport === 'array')
      .map((entry) => entry.name.toUpperCase())
  );
  const backendAutocomplete = new Set(
    backendPolicy
      .filter((entry) => entry.autocompleteVisible)
      .map((entry) => entry.name.toUpperCase())
  );
  const excludedAutocomplete = new Set(
    parseSetOfStrings(getVarInitializer(src, 'EXCLUDED_AUTOCOMPLETE_FUNCTIONS')).map((s) =>
      s.toUpperCase()
    )
  );
  const customSync = new Set(
    parseSetOfStrings(getVarInitializer(src, 'CUSTOM_SYNC_FUNCTIONS')).map((s) => s.toUpperCase())
  );
  const signatures = parseStringMap(getVarInitializer(src, 'FUNCTION_SIGNATURES'));

  const categoryToFunctions = {
    math: excel.math ?? [],
    statistical: excel.statistical ?? [],
    logical: excel.logical ?? [],
    date: excel.date ?? [],
    financial: excel.financial ?? [],
    engineering: excel.engineering ?? [],
  };

  const rows = [];
  for (const category of CATEGORY_ORDER) {
    const funcs = [...(categoryToFunctions[category] ?? [])].sort((a, b) => a.localeCompare(b));
    for (const fn of funcs) {
      rows.push({ category, fn });
    }
  }

  const parser = new FormulaParser();
  const parserSupported =
    typeof parser.supportedFunctions === 'function'
      ? new Set(parser.supportedFunctions().map((f) => String(f).toUpperCase()))
      : new Set();

  for (const fn of customSync) {
    parserSupported.add(fn);
  }

  const parserFunctionImpl = parser.functions ?? {};

  const enriched = rows.map(({ category, fn }) => {
    const upper = fn.toUpperCase();
    const isParser = parserSupported.has(upper);
    const parserNonSpill = isParser && !backendArray.has(upper);
    const isBackendScalar = backendScalar.has(upper);
    const autocompleteVisible =
      (parserNonSpill || backendAutocomplete.has(upper)) && !excludedAutocomplete.has(upper);

    let execPath = 'missing';
    if (isParser) execPath = 'parser';
    else if (isBackendScalar) execPath = 'backend-scalar';

    const parserImpl = parserFunctionImpl[upper];
    const arityFromEngine = typeof parserImpl === 'function' ? parserImpl.length : null;
    const signatureMeta = parseSignatureDetails(upper, signatures[upper] ?? null);

    let args = signatureMeta.args;
    let arity = signatureMeta.arity;
    let docStatus = signatureMeta.docStatus;
    if (docStatus !== 'complete' && Number.isInteger(arityFromEngine) && arityFromEngine > 0) {
      args = synthesizeArgsFromArity(arityFromEngine);
      arity = { min: arityFromEngine, max: arityFromEngine, kind: 'fixed' };
      docStatus = 'arity_only';
    }

    const normalizedSignature = signatureMeta.signature
      ? signatureMeta.signature
      : signatureFromArgs(upper, args, arity.kind);

    return {
      category,
      categoryLabel: CATEGORY_LABELS[category],
      functionName: upper,
      signature: normalizedSignature,
      parser: isParser,
      backendScalar: isBackendScalar,
      autocompleteVisible,
      execPath,
      arity,
      args,
      docStatus,
    };
  });

  const total = enriched.length;
  const parserCount = enriched.filter((r) => r.parser).length;
  const backendScalarCount = enriched.filter((r) => r.backendScalar).length;
  const autocompleteCount = enriched.filter((r) => r.autocompleteVisible).length;
  const missingCount = enriched.filter((r) => !r.autocompleteVisible).length;
  const missingFns = enriched
    .filter((r) => !r.autocompleteVisible)
    .map((r) => r.functionName)
    .sort((a, b) => a.localeCompare(b));

  const docCoverage = {
    complete: enriched.filter((r) => r.autocompleteVisible && r.docStatus === 'complete').length,
    arityOnly: enriched.filter((r) => r.autocompleteVisible && r.docStatus === 'arity_only').length,
    pending: enriched.filter((r) => r.autocompleteVisible && r.docStatus === 'pending').length,
  };

  const categories = CATEGORY_ORDER.map((id) => {
    const items = enriched.filter((row) => row.category === id);
    return {
      id,
      label: CATEGORY_LABELS[id],
      advertisedCount: items.length,
      visibleCount: items.filter((row) => row.autocompleteVisible).length,
    };
  });

  const manifest = {
    source: 'src/lib/grid/formulas/formulaService.ts',
    summary: {
      advertised: total,
      parserSupported: parserCount,
      backendScalar: backendScalarCount,
      autocompleteVisible: autocompleteCount,
      missing: missingCount,
      docCoverage,
    },
    categories,
    functions: enriched.map((row) => ({
      functionName: row.functionName,
      category: row.category,
      categoryLabel: row.categoryLabel,
      autocompleteVisible: row.autocompleteVisible,
      execPath: row.execPath,
      parser: row.parser,
      backendScalar: row.backendScalar,
      signature: row.signature,
      arity: row.arity,
      args: row.args,
      docStatus: row.docStatus,
    })),
  };

  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;

  const lines = [];
  lines.push('# Formula Support Audit');
  lines.push('');
  lines.push('Source: `src/lib/grid/formulas/formulaService.ts`');
  lines.push('Scope: marketed 6 categories (Math, Statistical, Logical, Date, Financial, Engineering).');
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Advertised functions: **${total}**`);
  lines.push(`- Parser-supported (including custom sync): **${parserCount}**`);
  lines.push(`- Backend scalar allowlist: **${backendScalarCount}**`);
  lines.push(`- Autocomplete-visible (parser OR backend scalar): **${autocompleteCount}**`);
  lines.push(`- Missing from autocomplete/runtime path: **${missingCount}**`);
  lines.push('');
  lines.push('## Documentation Coverage (Visible Functions)');
  lines.push('');
  lines.push(`- Complete signature docs: **${docCoverage.complete}**`);
  lines.push(`- Arity-derived docs: **${docCoverage.arityOnly}**`);
  lines.push(`- Pending docs: **${docCoverage.pending}**`);
  lines.push('');
  lines.push('## Missing Functions (Advertised but not wired for parser/backend-scalar fallback)');
  lines.push('');
  if (missingFns.length === 0) {
    lines.push('- None');
  } else {
    lines.push(missingFns.map((fn) => `\`${fn}\``).join(', '));
  }
  lines.push('');
  lines.push(`## Full ${total}-Function Matrix`);
  lines.push('');
  lines.push('| # | Category | Function | Signature | Parser | Backend Scalar | Autocomplete | Exec Path | Doc Status |');
  lines.push('|---:|---|---|---|:---:|:---:|:---:|---|---|');

  enriched.forEach((row, idx) => {
    lines.push(
      `| ${idx + 1} | ${markdownEscapeCell(row.categoryLabel)} | ${markdownEscapeCell(row.functionName)} | ${markdownEscapeCell(row.signature)} | ${row.parser ? 'Y' : 'N'} | ${row.backendScalar ? 'Y' : 'N'} | ${row.autocompleteVisible ? 'Y' : 'N'} | ${row.execPath} | ${row.docStatus} |`
    );
  });

  const markdown = `${lines.join('\n')}\n`;

  return { markdown, manifestJson, summary: manifest.summary };
}

function main() {
  const artifacts = buildArtifacts();

  if (CHECK_MODE) {
    if (!fs.existsSync(OUTPUT_AUDIT_PATH) || !fs.existsSync(OUTPUT_MANIFEST_PATH)) {
      throw new Error(
        `Missing generated files. Run script once before --check.\nExpected:\n- ${OUTPUT_AUDIT_PATH}\n- ${OUTPUT_MANIFEST_PATH}`
      );
    }
    const currentAudit = fs.readFileSync(OUTPUT_AUDIT_PATH, 'utf8');
    const currentManifest = fs.readFileSync(OUTPUT_MANIFEST_PATH, 'utf8');
    if (currentAudit !== artifacts.markdown || currentManifest !== artifacts.manifestJson) {
      throw new Error(
        'Formula support artifacts are out of sync. Run `node scripts/generate-formula-support-audit.mjs` and commit changes.'
      );
    }
    console.log(
      `Formula support audit check passed: advertised=${artifacts.summary.advertised}, visible=${artifacts.summary.autocompleteVisible}, missing=${artifacts.summary.missing}`
    );
    return;
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_AUDIT_PATH, artifacts.markdown, 'utf8');
  fs.writeFileSync(OUTPUT_MANIFEST_PATH, artifacts.manifestJson, 'utf8');

  console.log(`Generated formula support audit: ${OUTPUT_AUDIT_PATH}`);
  console.log(`Generated formula support manifest: ${OUTPUT_MANIFEST_PATH}`);
  console.log(
    `summary: advertised=${artifacts.summary.advertised} parser=${artifacts.summary.parserSupported} backendScalar=${artifacts.summary.backendScalar} autocomplete=${artifacts.summary.autocompleteVisible} missing=${artifacts.summary.missing}`
  );
}

main();
