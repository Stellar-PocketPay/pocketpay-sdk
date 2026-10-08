#!/usr/bin/env node
/**
 * Pre-submission verification command (issue #392).
 *
 * One local command contributors run before opening or updating an SDK PR.
 * Mirrors the `npm run verify` CI-parity pipeline with clear step output and
 * failure guidance.
 */
import { spawnSync } from 'child_process';
import path from 'path';

const ROOT = path.resolve(__dirname, '..');

interface CheckStep {
  id: string;
  label: string;
  /** npm script name shown in logs (e.g. lint, test:coverage). */
  npmScript: string;
  command: string;
  args: string[];
  /** Short fix hint shown when this step fails. */
  failureHint: string;
}

const STEPS: CheckStep[] = [
  {
    id: 'lint',
    label: 'Lint / typecheck',
    npmScript: 'lint',
    command: 'npm',
    args: ['run', 'lint'],
    failureHint:
      'Fix TypeScript errors reported by `tsc --noEmit`. Do not silence them with `@ts-ignore`.',
  },
  {
    id: 'circular',
    label: 'Circular dependency check',
    npmScript: 'check:circular',
    command: 'npm',
    args: ['run', 'check:circular'],
    failureHint:
      'Break the import cycle (move shared types/helpers into a leaf module). See docs/dependency_direction_map.md.',
  },
  {
    id: 'test',
    label: 'Unit tests (offline)',
    npmScript: 'test',
    command: 'npm',
    args: ['test'],
    failureHint:
      'Read the Vitest failure output and fix the cause (or the test if the assertion is wrong). Keep unit tests offline — see docs/testing.md.',
  },
  {
    id: 'coverage',
    label: 'Coverage report',
    npmScript: 'test:coverage',
    command: 'npm',
    args: ['run', 'test:coverage'],
    failureHint:
      'Ensure `@vitest/coverage-v8` is installed (`npm install`). Thresholds are informational (0) unless raised in config.',
  },
  {
    id: 'build',
    label: 'Package build',
    npmScript: 'build',
    command: 'npm',
    args: ['run', 'build'],
    failureHint:
      'Resolve `tsc` emit errors (usually the same root cause as lint). Confirm `dist/` is produced.',
  },
  {
    id: 'smoke',
    label: 'Packaged consumer smoke (offline)',
    npmScript: 'smoke:consumer',
    command: 'npm',
    args: ['run', 'smoke:consumer'],
    failureHint:
      'Verify dist public exports and offline wallet, payment, config and error contracts. See docs/package-smoke.md.',
  },
];

function printHelp(): void {
  console.log(`
PocketPay SDK — Pre-submission verification

Usage:
  npm run presubmit
  npm run verify:presubmit

Runs the same local CI-parity checks as \`npm run verify\`:
  lint → check:circular → test → test:coverage → build → smoke:consumer

Stops at the first failure and prints fix guidance.

Documentation: docs/pre-submission-verification.md
`);
}

function runStep(step: CheckStep): { ok: boolean; durationMs: number } {
  const started = Date.now();
  const result = spawnSync(step.command, step.args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  return { ok: result.status === 0, durationMs: Date.now() - started };
}

function main(argv: string[]): number {
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return 0;
  }

  console.log('PocketPay SDK — Pre-submission verification');
  console.log('==========================================');
  console.log('Run this before opening or updating a pull request.');
  console.log('Pipeline: lint → circular → test → coverage → build → smoke:consumer\n');

  for (let i = 0; i < STEPS.length; i++) {
    const step = STEPS[i]!;
    console.log(`→ [${i + 1}/${STEPS.length}] ${step.label} (\`npm run ${step.npmScript}\`)`);
    const result = runStep(step);
    if (!result.ok) {
      console.error(`\n✗ Failed: ${step.label} (${result.durationMs}ms)`);
      console.error(`  Fix: ${step.failureHint}`);
      console.error('\nSee docs/pre-submission-verification.md#failure-guidance for the full table.');
      console.error('Re-run `npm run presubmit` after fixing.\n');
      return 1;
    }
    console.log(`✓ ${step.label} (${result.durationMs}ms)\n`);
  }

  console.log('✓ Pre-submission verification passed.');
  console.log('  You are ready to push and open/update your PR.');
  console.log('  Optional next: `npm run verify:pr` for acceptance-criteria reminders.');
  console.log('  See docs/pre-submission-verification.md\n');
  return 0;
}

process.exit(main(process.argv.slice(2)));
