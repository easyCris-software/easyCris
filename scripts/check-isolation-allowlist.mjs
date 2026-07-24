import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SRC_DIR = path.join(ROOT, 'src');
const RUST_LIB = path.join(ROOT, 'src-tauri', 'src', 'lib.rs');
const ISOLATION_HTML = path.join(ROOT, 'src-tauri', 'isolation', 'index.html');
const DEFAULT_CAPABILITY = path.join(ROOT, 'src-tauri', 'capabilities', 'default.json');
const APP_COMMANDS_PERMISSION = path.join(ROOT, 'src-tauri', 'permissions', 'app-commands.toml');
const CFG_GATED_REGISTERED_COMMANDS = new Set([
  // Registered only in debug Rust builds and guarded at the frontend callsite.
  'execute_python_script',
]);

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
  let index = 0;
  while ((index = content.indexOf('invoke', index)) !== -1) {
    const before = content[index - 1];
    const after = content[index + 'invoke'.length];
    if ((before && /[A-Za-z0-9_$]/.test(before)) || (after && /[A-Za-z0-9_$]/.test(after))) {
      index += 'invoke'.length;
      continue;
    }

    let cursor = index + 'invoke'.length;
    while (/\s/.test(content[cursor] ?? '')) cursor += 1;

    if (content[cursor] === '<') {
      let depth = 1;
      cursor += 1;
      while (cursor < content.length && depth > 0) {
        const char = content[cursor];
        const previous = content[cursor - 1];
        if (char === '<') {
          depth += 1;
        } else if (char === '>' && previous !== '=') {
          depth -= 1;
        }
        cursor += 1;
      }
    }

    while (/\s/.test(content[cursor] ?? '')) cursor += 1;
    if (content[cursor] !== '(') {
      index += 'invoke'.length;
      continue;
    }

    cursor += 1;
    while (/\s/.test(content[cursor] ?? '')) cursor += 1;
    const quote = content[cursor];
    if (quote !== '\'' && quote !== '"' && quote !== '`') {
      index += 'invoke'.length;
      continue;
    }

    cursor += 1;
    const start = cursor;
    while (cursor < content.length) {
      if (content[cursor] === '\\') {
        cursor += 2;
        continue;
      }
      if (content[cursor] === quote) {
        cmds.add(content.slice(start, cursor));
        break;
      }
      cursor += 1;
    }

    index = cursor + 1;
  }
  return cmds;
}

function parsePermissionCommands(content) {
  const allowMatch = content.match(/commands\.allow\s*=\s*\[([^\]]*)\]/m);
  if (!allowMatch) {
    throw new Error('Could not find commands.allow in app-commands permission.');
  }

  const commands = new Set();
  const literalRegex = /'([^']+)'|"([^"]+)"/g;
  let literalMatch;
  while ((literalMatch = literalRegex.exec(allowMatch[1])) !== null) {
    const cmd = literalMatch[1] ?? literalMatch[2];
    if (cmd) commands.add(cmd);
  }
  return commands;
}

function stripRustComments(content) {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function extractBalancedBracketBody(content, openBracketIndex) {
  let depth = 0;
  for (let index = openBracketIndex; index < content.length; index += 1) {
    const char = content[index];
    if (char === '[') {
      depth += 1;
      continue;
    }
    if (char === ']') {
      depth -= 1;
      if (depth === 0) {
        return content.slice(openBracketIndex + 1, index);
      }
    }
  }
  throw new Error('Could not find the end of the generate_handler! command list.');
}

function parseRegisteredCommands(content) {
  const cleaned = stripRustComments(content);
  const macroIndex = cleaned.indexOf('generate_handler!');
  if (macroIndex === -1) {
    throw new Error('Could not find generate_handler! command list in src-tauri/src/lib.rs.');
  }

  const openBracketIndex = cleaned.indexOf('[', macroIndex);
  if (openBracketIndex === -1) {
    throw new Error('Could not find generate_handler! opening bracket in src-tauri/src/lib.rs.');
  }

  const body = extractBalancedBracketBody(cleaned, openBracketIndex);
  const commands = new Set();
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#[')) continue;
    const commandMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*,?$/);
    if (commandMatch) commands.add(commandMatch[1]);
  }
  if (commands.size === 0) {
    throw new Error('No commands found in generate_handler! command list.');
  }
  return commands;
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
  if (!fs.existsSync(DEFAULT_CAPABILITY)) {
    console.error(`FAIL: Missing default capability file: ${path.relative(ROOT, DEFAULT_CAPABILITY)}`);
    process.exit(1);
  }
  if (!fs.existsSync(APP_COMMANDS_PERMISSION)) {
    console.error(`FAIL: Missing app command permission file: ${path.relative(ROOT, APP_COMMANDS_PERMISSION)}`);
    process.exit(1);
  }
  if (!fs.existsSync(RUST_LIB)) {
    console.error(`FAIL: Missing Rust app entry file: ${path.relative(ROOT, RUST_LIB)}`);
    process.exit(1);
  }

  const isolationText = fs.readFileSync(ISOLATION_HTML, 'utf8');
  const capabilityText = fs.readFileSync(DEFAULT_CAPABILITY, 'utf8');
  const appCommandsText = fs.readFileSync(APP_COMMANDS_PERMISSION, 'utf8');
  const rustLibText = fs.readFileSync(RUST_LIB, 'utf8');
  const allowed = parseAllowedCommands(isolationText);
  const appCommands = parsePermissionCommands(appCommandsText);
  const registered = parseRegisteredCommands(rustLibText);

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

  if (!capabilityText.includes('"app-commands"')) {
    console.error('FAIL: default capability must include "app-commands" so Tauri permits app invokes.');
    process.exit(1);
  }

  if (capabilityText.includes('"remote-session"')) {
    console.error('FAIL: remote-session commands are covered by app-commands; remove the stale remote-session capability.');
    process.exit(1);
  }

  const unknownCfgGatedCommands = [...CFG_GATED_REGISTERED_COMMANDS].filter((cmd) => !registered.has(cmd)).sort();
  if (unknownCfgGatedCommands.length > 0) {
    console.error('FAIL: cfg-gated command exception(s) no longer appear in generate_handler![]:');
    for (const cmd of unknownCfgGatedCommands) console.error(`  - ${cmd}`);
    console.error('\nFix: remove stale command names from CFG_GATED_REGISTERED_COMMANDS.');
    process.exit(1);
  }

  const alwaysRegistered = new Set([...registered].filter((cmd) => !CFG_GATED_REGISTERED_COMMANDS.has(cmd)));

  const registeredNotAllowed = [...alwaysRegistered].filter((cmd) => !allowed.has(cmd)).sort();
  if (registeredNotAllowed.length > 0) {
    console.error('FAIL: isolation allowlist is missing registered command(s):');
    for (const cmd of registeredNotAllowed) console.error(`  - ${cmd}`);
    console.error('\nFix: add these to ALLOWED_CUSTOM_COMMANDS in src-tauri/isolation/index.html');
    process.exit(1);
  }

  const registeredPermissionMissing = [...alwaysRegistered].filter((cmd) => !appCommands.has(cmd)).sort();
  if (registeredPermissionMissing.length > 0) {
    console.error('FAIL: app-commands permission is missing registered command(s):');
    for (const cmd of registeredPermissionMissing) console.error(`  - ${cmd}`);
    console.error('\nFix: add these to src-tauri/permissions/app-commands.toml');
    process.exit(1);
  }

  const cfgGatedPermissionMissing = [...CFG_GATED_REGISTERED_COMMANDS]
    .filter((cmd) => invoked.has(cmd) && (!allowed.has(cmd) || !appCommands.has(cmd)))
    .sort();
  if (cfgGatedPermissionMissing.length > 0) {
    console.error('FAIL: cfg-gated dev command(s) are invoked but not permitted for dev builds:');
    for (const cmd of cfgGatedPermissionMissing) console.error(`  - ${cmd}`);
    console.error('\nFix: either permit these commands for dev builds or remove their frontend invoke callsites.');
    process.exit(1);
  }

  const allowedUnregistered = [...allowed].filter((cmd) => !registered.has(cmd)).sort();
  if (allowedUnregistered.length > 0) {
    console.error('FAIL: isolation allowlist includes command(s) without a Rust handler:');
    for (const cmd of allowedUnregistered) console.error(`  - ${cmd}`);
    console.error('\nFix: register these in generate_handler![] or remove them from ALLOWED_CUSTOM_COMMANDS.');
    process.exit(1);
  }

  const appCommandsUnregistered = [...appCommands].filter((cmd) => !registered.has(cmd)).sort();
  if (appCommandsUnregistered.length > 0) {
    console.error('FAIL: app-commands permission includes command(s) without a Rust handler:');
    for (const cmd of appCommandsUnregistered) console.error(`  - ${cmd}`);
    console.error('\nFix: register these in generate_handler![] or remove them from src-tauri/permissions/app-commands.toml.');
    process.exit(1);
  }

  const permissionMissing = [...allowed].filter((cmd) => !appCommands.has(cmd)).sort();
  if (permissionMissing.length > 0) {
    console.error('FAIL: app-commands permission is missing isolation-allowed command(s):');
    for (const cmd of permissionMissing) console.error(`  - ${cmd}`);
    console.error('\nFix: add these to src-tauri/permissions/app-commands.toml');
    process.exit(1);
  }

  console.log(
    `PASS: Isolation allowlist and app permissions cover ${invoked.size} invoked command(s).`
  );
}

main();
