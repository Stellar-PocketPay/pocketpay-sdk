/**
 * Public root and package subpath export governance for #317.
 * A deliberate --update commits the reviewed baseline; CI only checks it.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

type SurfaceEntry = { name: string; kind: 'type' | 'value' };
type Snapshot = {
  formatVersion: 1;
  entrypoint: 'src/index.ts';
  rootExports: SurfaceEntry[];
  packageSurface: { main: unknown; types: unknown; exports: unknown };
};

const root = process.cwd();
const snapshotFile = path.join(root, 'docs/public-api-surface.snapshot.json');

function extractExports(code: string): SurfaceEntry[] {
  const sf = ts.createSourceFile('src/index.ts', code, ts.ScriptTarget.Latest, true);
  // A parse-error recovery tree can retain every old export node and make an
  // invalid package entrypoint look API-compatible. Never bless that baseline.
  const syntaxErrors = (sf as ts.SourceFile & {
    parseDiagnostics?: readonly ts.Diagnostic[]
  }).parseDiagnostics;
  if (syntaxErrors?.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) {
    throw new Error('Invalid TypeScript syntax in src/index.ts; cannot approve public API snapshot');
  }
  const found: SurfaceEntry[] = [];
  const add = (name: string, kind: SurfaceEntry['kind']): void => {
    if (!name) throw new Error('Unnamed public export');
    found.push({ name, kind });
  };

  for (const node of sf.statements) {
    // Export assignments have no ExportKeyword modifier in the TypeScript AST.
    if (ts.isExportAssignment(node)) {
      if (node.isExportEquals) throw new Error('CommonJS export assignment needs explicit review');
      add('default', 'value');
      continue;
    }
    if (ts.isExportDeclaration(node)) {
      if (!node.exportClause || !ts.isNamedExports(node.exportClause)) {
        throw new Error('Wildcard/namespace export requires explicit review in src/index.ts');
      }
      for (const element of node.exportClause.elements) {
        add(element.name.text, node.isTypeOnly || element.isTypeOnly ? 'type' : 'value');
      }
      continue;
    }

    const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    if (!modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    const isDefault = modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) throw new Error('Destructured public export needs review');
        add(declaration.name.text, 'value');
      }
    } else if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) ||
               ts.isEnumDeclaration(node) || ts.isInterfaceDeclaration(node) ||
               ts.isTypeAliasDeclaration(node)) {
      const name = isDefault ? 'default' : node.name?.text;
      if (!name) throw new Error('Unnamed public declaration needs review');
      // A class or enum is addressable in BOTH namespaces. A replacement
      // `export const Client` keeps its runtime name but removes the consumer
      // type; the snapshot must catch that breaking change.
      if (ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)) {
        add(name, 'type');
        add(name, 'value');
      } else {
        add(name, ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) ? 'type' : 'value');
      }
    } else {
      throw new Error('Unknown public declaration syntax; inspect src/index.ts');
    }
  }

  if (!found.length) throw new Error('No root exports found; refusing empty baseline');
  const seen = new Set<string>();
  for (const item of found) {
    const key = item.kind + ':' + item.name;
    if (seen.has(key)) throw new Error('Duplicate public export: ' + key);
    seen.add(key);
  }
  return found.sort((a, b) => a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind));
}

function packageSurface(pkg: Record<string, unknown>): Snapshot['packageSurface'] {
  // Conditional exports resolve in insertion order, including nested conditions.
  // Keep that order so a precedence change cannot disappear from the snapshot.
  return { main: pkg.main, types: pkg.types, exports: pkg.exports };
}

function currentSurface(): Snapshot {
  const source = fs.readFileSync(path.join(root, 'src/index.ts'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
  if (!pkg.exports || !pkg.main || !pkg.types) {
    throw new Error('Missing package export map / main / types; review publication contract');
  }
  return {
    formatVersion: 1,
    entrypoint: 'src/index.ts',
    rootExports: extractExports(source),
    packageSurface: packageSurface(pkg),
  };
}

function format(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

function selfTest(): void {
  const invalidEntry = "export { A } from './x'; const unfinished = ;";
  let invalidSyntaxRejected = false;
  try { extractExports(invalidEntry); } catch { invalidSyntaxRejected = true; }
  if (!invalidSyntaxRejected) {
    throw new Error('Source parse failure was ignored because exports stayed unchanged');
  }
  const sample = "export { A, type B as Alias } from './x';\nexport type { C } from './y';";
  const result = extractExports(sample);
  if (format(result) !== format([
    { name: 'A', kind: 'value' },
    { name: 'Alias', kind: 'type' },
    { name: 'C', kind: 'type' },
  ])) throw new Error('Alias/type export fixture failed');
  for (const source of [
    'const value = 1; export default value;',
    'export default 42;',
    'export default function () {}',
  ]) {
    if (format(extractExports(source)) !== format([{ name: 'default', kind: 'value' }])) {
      throw new Error('Default export fixture failed');
    }
  }
  const dualNamespace = extractExports('export class Client {}\nexport enum State { Ready }\nexport default class {}');
  if (format(dualNamespace) !== format([
    { name: 'Client', kind: 'type' },
    { name: 'Client', kind: 'value' },
    { name: 'default', kind: 'type' },
    { name: 'default', kind: 'value' },
    { name: 'State', kind: 'type' },
    { name: 'State', kind: 'value' },
  ])) throw new Error('Class/enum dual namespace fixture failed');
  if (format(extractExports('export class Client {}')) ===
      format(extractExports('export const Client = 1;'))) {
    throw new Error('Class-to-const breaking type removal was not detected');
  }
  const before = { main: './index.js', types: './index.d.ts', exports: {
    '.': { node: { import: './node.mjs', default: './node.js' }, default: './fallback.js' },
  } };
  const reordered = { ...before, exports: {
    '.': { node: { default: './node.js', import: './node.mjs' }, default: './fallback.js' },
  } };
  if (format(packageSurface(before)) === format(packageSurface(reordered))) {
    throw new Error('Conditional export precedence change was ignored');
  }
  for (const invalid of ["export * from './x';", "export * as X from './x';", "const x = {}; export = x;"]) {
    let failed = false;
    try { extractExports(invalid); } catch { failed = true; }
    if (!failed) throw new Error('Unsupported export fixture was accepted');
  }
  process.stdout.write('Public API governance fixtures passed\n');
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some((a) => !['--update', '--self-test'].includes(a))) {
    throw new Error('Usage: tsx scripts/check-public-api.ts [--update|--self-test]');
  }
  if (args[0] === '--self-test') { selfTest(); return; }
  const actual = currentSurface();
  if (args[0] === '--update') {
    fs.writeFileSync(snapshotFile, format(actual), 'utf8');
    process.stdout.write('Updated reviewed public API baseline: ' + actual.rootExports.length + ' symbols\n');
    return;
  }
  const previous = JSON.parse(fs.readFileSync(snapshotFile, 'utf8')) as Snapshot;
  if (format(previous) === format(actual)) {
    process.stdout.write('Public API unchanged (' + actual.rootExports.length + ' root exports and package entrypoints)\n');
    return;
  }
  const oldSet = new Set((previous.rootExports || []).map((e) => e.kind + ':' + e.name));
  const newSet = new Set(actual.rootExports.map((e) => e.kind + ':' + e.name));
  const added = [...newSet].filter((e) => !oldSet.has(e));
  const removed = [...oldSet].filter((e) => !newSet.has(e));
  if (added.length) console.error('Added exports: ' + added.join(', '));
  if (removed.length) console.error('Removed/changed-kind exports: ' + removed.join(', '));
  if (format(previous.packageSurface) !== format(actual.packageSurface)) {
    console.error('package.json main/types/exports changed');
  }
  console.error('Public API drift: review compatibility, then run npm run update:public-api and commit the snapshot.');
  process.exitCode = 1;
}

try { main(); } catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
