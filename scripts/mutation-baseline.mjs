#!/usr/bin/env node
/**
 * Nightly mutation testing: fail on survivors that are not in the baseline.
 *
 * `cargo mutants` writes every mutant no test killed to
 * `mutants.out/missed.txt`. That list is noisy across unrelated edits
 * because each entry starts with `file:line:col`, and line numbers move. The
 * committed baseline (`contracts/escrow/.cargo/mutants-baseline.txt`) keys an
 * accepted survivor by its **mutation description** — which carries the
 * function name and the mutation, never the line — so a survivor is matched
 * across line shifts.
 *
 * Usage (from the repository root):
 *   node scripts/mutation-baseline.mjs validate
 *   node scripts/mutation-baseline.mjs check [--missed <path>] [--baseline <path>]
 *
 * `validate` only parses the baseline (fast, runs before the mutation run).
 * `check` compares `missed.txt` with the baseline, writes the survivors to
 * `$GITHUB_STEP_SUMMARY` when it is set, and exits 1 on a survivor that the
 * baseline does not accept.
 *
 * Exit codes: 0 = no unaccepted survivors, 1 = new survivor(s), 2 = the
 * baseline, the missed list, or the arguments are unusable.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ENTRY_SEPARATOR = " # ";
// cargo-mutants writes "<file>:<line>:<col>: <description>".
const MISSED_LINE = /^(.+):(\d+):(\d+):\s*(.+)$/;
// Resolve the defaults from this script, not the working directory: the
// workflow runs the mutation job from contracts/escrow.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RELATIVE_DEFAULTS = {
  missed: "contracts/escrow/mutants.out/missed.txt",
  baseline: "contracts/escrow/.cargo/mutants-baseline.txt",
};
const DEFAULTS = {
  missed: join(REPO_ROOT, RELATIVE_DEFAULTS.missed),
  baseline: join(REPO_ROOT, RELATIVE_DEFAULTS.baseline),
};

const USAGE = `usage: node scripts/mutation-baseline.mjs <validate|check> [options]

  validate            parse the baseline and report malformed entries
  check               compare mutants.out/missed.txt with the baseline
  --missed <path>     missed list (default: ${RELATIVE_DEFAULTS.missed})
  --baseline <path>   baseline file (default: ${RELATIVE_DEFAULTS.baseline})`;

function usageError(message) {
  console.error(`::error::${message}`);
  console.error(USAGE);
  process.exit(2);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== "validate" && command !== "check") {
    usageError(
      command ? `unknown command "${command}"` : "missing command (validate or check)",
    );
  }
  const options = { command, missed: DEFAULTS.missed, baseline: DEFAULTS.baseline };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (flag !== "--missed" && flag !== "--baseline") {
      usageError(`unknown option "${flag}"`);
    }
    if (value === undefined || value.startsWith("--")) {
      usageError(`${flag} needs a path`);
    }
    options[flag.slice(2)] = resolve(value);
    i += 1;
  }
  return options;
}

/** Whitespace-only differences must not change identity. */
function normalize(text) {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Drop a leading `file:line:col: ` so a line copied straight out of missed.txt
 * (or one whose line number has since moved) still matches its entry.
 */
function stripLocation(text) {
  return normalize(text).replace(/^.+?:\d+:\d+:\s*/, "");
}

/**
 * One accepted survivor per line: `<mutation description>  # <reason>`, so the
 * reason cannot be forgotten. `#` lines and blank lines are comments.
 */
function parseBaseline(path) {
  if (!existsSync(path)) {
    return { entries: [], problems: [`${path}: baseline file not found`] };
  }
  const entries = [];
  const problems = [];
  const seen = new Map();
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  lines.forEach((raw, index) => {
    const line = raw.trim();
    const lineNumber = index + 1;
    if (line === "" || line.startsWith("#")) return;
    const separator = line.indexOf(ENTRY_SEPARATOR);
    if (separator === -1) {
      problems.push(
        line.endsWith("#")
          ? `${path}:${lineNumber}: entry has no reason: ${line}`
          : `${path}:${lineNumber}: expected "<mutation>  # <reason>", got: ${line}`,
      );
      return;
    }
    const key = stripLocation(line.slice(0, separator));
    const reason = line.slice(separator + ENTRY_SEPARATOR.length).trim();
    if (key === "") {
      problems.push(`${path}:${lineNumber}: entry has no mutation description`);
      return;
    }
    if (reason === "") {
      problems.push(`${path}:${lineNumber}: "${key}" has no reason`);
    }
    if (seen.has(key)) {
      problems.push(
        `${path}:${lineNumber}: "${key}" is listed twice (first on line ${seen.get(key)})`,
      );
      return;
    }
    seen.set(key, lineNumber);
    entries.push({ key, reason, lineNumber });
  });
  return { entries, problems };
}

function parseMissed(path) {
  const mutants = [];
  const problems = [];
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const match = MISSED_LINE.exec(line);
    if (!match) {
      problems.push(`${path}:${index + 1}: unrecognized mutant line: ${line}`);
      return;
    }
    const [, file, lineNumber, column, description] = match;
    mutants.push({
      location: `${file}:${lineNumber}:${column}`,
      key: normalize(description),
    });
  });
  return { mutants, problems };
}

/** Best-effort function name, for the summary only — matching uses the whole key. */
function mutantFunction(description) {
  let match = /\bin ([A-Za-z_][\w:]*)$/.exec(description);
  if (match) return match[1];
  match = /^replace ([A-Za-z_][\w:]*)(?: ->| with )/.exec(description);
  if (match) return match[1];
  return "(unknown)";
}

function reportProblems(problems) {
  for (const problem of problems) console.error(`::error::${problem}`);
  console.error(
    `\n${problems.length} problem(s). See contracts/escrow/.cargo/mutants-baseline.txt for the format.`,
  );
  process.exit(2);
}

function writeSummary(markdown) {
  process.stdout.write(`${markdown}\n`);
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (target) appendFileSync(target, `${markdown}\n`);
}

function runValidate(options) {
  const baseline = parseBaseline(options.baseline);
  if (baseline.problems.length > 0) reportProblems(baseline.problems);
  console.log(
    `${options.baseline}: ${baseline.entries.length} accepted survivor(s), every entry has a reason.`,
  );
}

function runCheck(options) {
  const baseline = parseBaseline(options.baseline);
  if (baseline.problems.length > 0) reportProblems(baseline.problems);

  if (!existsSync(options.missed)) {
    reportProblems([
      `${options.missed}: no mutant list found. The mutation run did not finish, ` +
        `so survivors cannot be checked against the baseline.`,
    ]);
  }
  const missed = parseMissed(options.missed);
  if (missed.problems.length > 0) reportProblems(missed.problems);

  const accepted = new Map(baseline.entries.map((entry) => [entry.key, entry]));
  const survivedKeys = new Set(missed.mutants.map((mutant) => mutant.key));
  const newSurvivors = missed.mutants.filter((mutant) => !accepted.has(mutant.key));
  const stale = baseline.entries.filter((entry) => !survivedKeys.has(entry.key));

  const lines = ["## Mutation testing: survivors", ""];
  lines.push(
    `- ${missed.mutants.length} mutant(s) survived`,
    `- ${baseline.entries.length} accepted in \`contracts/escrow/.cargo/mutants-baseline.txt\``,
    `- ${newSurvivors.length} new (not accepted)`,
    `- ${stale.length} baseline entr${stale.length === 1 ? "y" : "ies"} no longer survived`,
    "",
  );

  if (newSurvivors.length > 0) {
    lines.push("### New survivors — fix the test, or accept with a reason", "");
    for (const mutant of newSurvivors) {
      lines.push(`- \`${mutantFunction(mutant.key)}\` — ${mutant.key}`);
      lines.push(`  - at \`${mutant.location}\``);
    }
    lines.push(
      "",
      "To accept one, add its line below to the baseline with a one-line reason",
      "(a survivor that no test can reasonably kill is the only good reason):",
      "",
      "```text",
      ...uniqueKeys(newSurvivors).map((key) => `${key}${ENTRY_SEPARATOR}<why this survivor is acceptable>`),
      "```",
      "",
    );
  }

  if (stale.length > 0) {
    lines.push(
      "### Stale baseline entries (not an error — prune them)", "",
      ...stale.map(
        (entry) => `- ${entry.key} — no longer survives (baseline line ${entry.lineNumber})`,
      ),
      "",
    );
  }

  writeSummary(lines.join("\n"));

  if (newSurvivors.length > 0) {
    for (const mutant of newSurvivors) {
      console.error(`::error::unaccepted mutant survived: ${mutant.location}: ${mutant.key}`);
    }
    process.exit(1);
  }
  console.log("Every surviving mutant is accepted in the baseline.");
}

function uniqueKeys(mutants) {
  return [...new Set(mutants.map((mutant) => mutant.key))];
}

const options = parseArgs(process.argv.slice(2));
if (options.command === "validate") runValidate(options);
else runCheck(options);
