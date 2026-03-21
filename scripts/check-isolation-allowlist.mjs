import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SRC_DIR = path.join(ROOT, 'src');
const ISOLATION_HTML = path.join(ROOT, 'src-tauri', 'isolation', 'index.html');

function collectFiles(dir) {
  const out = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectFiles(full));
      continue;
    }
    if (entry.isFile() && (full.endsWith('.ts') || full.endsWith('.tsx'))) {
      out.push(full);
    }
  }
  return out;
}

function parseAllowedCommands(html) {
  const setMatch = html.match(/ALLOWED_CUSTOM_COMMANDS\s*=\s*new\s+Set\s*\(\s*\[([\s\S]*?)\]\s*\)/m);
  if (!setMatch) {
    throw new Error('Could not find ALLOWED_CUSTOM_COMMANDS set in isolation hook.');
  }

  const allowed = new Set();
  const literalRegex = /'([^']+)'|"([^"]+)"/g;
  let literalMatch;
  while ((literalMatch = literalRegex.exec(setMatch[1])) !== null) {
    const cmd = literalMatch[1] ?? literalMatch[2];
    if (cmd) allowed.add(cmd);
  }
  return allowed;
}

function parseInvokedCommands(content) {
  const cmds = new Set();
  const invokeRegex = /invoke(?:<[^)]*>)?\s*\(\s*(['"`])([^'"`]+)\1/gm;
  let m;
  while ((m = invokeRegex.exec(content)) !== null) {
    cmds.add(m[2]);
  }
  return cmds;
}

function main() {
  if (!fs.existsSync(ISOLATION_HTML)) {
    console.error(`FAIL: Missing isolation hook file: ${path.relative(ROOT, ISOLATION_HTML)}`);
    process.exit(1);
  }
  if (!fs.existsSync(SRC_DIR)) {
    console.error(`FAIL: Missing source directory: ${path.relative(ROOT, SRC_DIR)}`);
    process.exit(1);
  }

  const isolationText = fs.readFileSync(ISOLATION_HTML, 'utf8');
  const allowed = parseAllowedCommands(isolationText);

  const files = collectFiles(SRC_DIR);
  const invoked = new Set();
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const cmd of parseInvokedCommands(text)) {
      invoked.add(cmd);
    }
  }

  const missing = [...invoked].filter((cmd) => !allowed.has(cmd)).sort();
  if (missing.length > 0) {
    console.error('FAIL: isolation allowlist is missing invoked command(s):');
    for (const cmd of missing) console.error(`  - ${cmd}`);
    console.error('\nFix: add these to ALLOWED_CUSTOM_COMMANDS in src-tauri/isolation/index.html');
    process.exit(1);
  }

  console.log(`PASS: Isolation allowlist covers ${invoked.size} invoked command(s).`);
}

main();
