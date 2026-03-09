#!/usr/bin/env tsx
/**
 * quality-gate.ts
 *
 * Runs Checkstyle and SpotBugs against generated files.
 * If violations are found, attempts ONE Claude-powered auto-fix pass.
 * Fails loudly if critical violations remain after the fix attempt.
 *
 * Usage:
 *   tsx quality-gate.ts <task_id> <repo_path>
 *   tsx quality-gate.ts <task_id> <repo_path> --checkstyle-only
 *   tsx quality-gate.ts <task_id> <repo_path> --spotbugs-only
 *
 * Outputs (stdout):
 *   GATE_PASSED=true|false
 *   GATE_CHECKSTYLE_VIOLATIONS=<n>
 *   GATE_SPOTBUGS_BUGS=<n>
 *   GATE_FIXED_FILES=<file1>,<file2>
 *   GATE_REMAINING_VIOLATIONS=<n>
 */

import fs            from "fs";
import path          from "path";
import os            from "os";
import { execSync }  from "child_process";
import { parseStringPromise } from "xml2js";
import { callClaude, TIER_SMART } from "./llm-client.js";

// ── State ──────────────────────────────────────────────────────────────────────

const STATE_DIR = path.join(os.homedir(), ".openclaw", "java-agent");
const PLAN_DIR  = path.join(STATE_DIR, "plans");
const SNAP_DIR  = path.join(STATE_DIR, "snapshots");

// ── Types ──────────────────────────────────────────────────────────────────────

interface StyleViolation {
  file:    string;
  line:    number;
  col?:    number;
  rule:    string;
  message: string;
  source:  "checkstyle" | "spotbugs";
  severity: "error" | "warning" | "info";
}

// ── Runner helpers ────────────────────────────────────────────────────────────

function run(cmd: string, cwd: string): { ok: boolean; output: string } {
  try {
    const out = execSync(cmd, { cwd, stdio: ["pipe","pipe","pipe"], timeout: 180_000 }).toString();
    return { ok: true, output: out };
  } catch (e: any) {
    return { ok: false, output: (e.stdout?.toString() ?? "") + (e.stderr?.toString() ?? "") };
  }
}

function findSnapshot(repoRoot: string): any {
  for (const s of fs.readdirSync(SNAP_DIR).filter(f => f.endsWith(".json"))) {
    const snap = JSON.parse(fs.readFileSync(path.join(SNAP_DIR, s), "utf8"));
    if (snap.repoRoot === path.resolve(repoRoot)) return snap;
  }
  throw new Error(`No snapshot for ${repoRoot}`);
}

// ── Checkstyle ────────────────────────────────────────────────────────────────

async function runCheckstyle(
  repoRoot: string,
  buildTool: string,
  module?: string
): Promise<StyleViolation[]> {
  const cwd = module ? path.join(repoRoot, module) : repoRoot;

  // Run checkstyle — produce XML report
  const cmd = buildTool === "gradle"
    ? "./gradlew checkstyleMain --continue -q"
    : "mvn -q checkstyle:checkstyle --no-transfer-progress -Dcheckstyle.failOnViolation=false";

  console.error("[Quality Gate] Running Checkstyle...");
  run(cmd, cwd); // run even if it exits non-zero — we read the XML

  // Find the XML report
  const xmlPaths = [
    path.join(cwd, "target","checkstyle-result.xml"),
    path.join(cwd, "build","reports","checkstyle","main.xml"),
  ];
  const xmlPath = xmlPaths.find(p => fs.existsSync(p));
  if (!xmlPath) {
    console.error("[Quality Gate] Checkstyle XML not found — skipping");
    return [];
  }

  const data = await parseStringPromise(fs.readFileSync(xmlPath, "utf8"), { explicitArray: true });
  const violations: StyleViolation[] = [];

  for (const fileNode of (data.checkstyle?.file || [])) {
    const relPath = path.relative(repoRoot, fileNode.$.name);
    for (const err of (fileNode.error || [])) {
      violations.push({
        file:     relPath,
        line:     parseInt(err.$.line) || 0,
        col:      err.$.column ? parseInt(err.$.column) : undefined,
        rule:     err.$.source?.split(".").pop() || "unknown",
        message:  err.$.message || "",
        source:   "checkstyle",
        severity: (err.$.severity as "error" | "warning" | "info") || "error",
      });
    }
  }

  return violations;
}

// ── SpotBugs ──────────────────────────────────────────────────────────────────

async function runSpotBugs(
  repoRoot: string,
  buildTool: string,
  module?: string
): Promise<StyleViolation[]> {
  const cwd = module ? path.join(repoRoot, module) : repoRoot;

  const cmd = buildTool === "gradle"
    ? "./gradlew spotbugsMain --continue -q"
    : "mvn -q spotbugs:spotbugs --no-transfer-progress";

  console.error("[Quality Gate] Running SpotBugs...");
  run(cmd, cwd);

  const xmlPaths = [
    path.join(cwd, "target","spotbugsXml.xml"),
    path.join(cwd, "target","spotbugs.xml"),
    path.join(cwd, "build","reports","spotbugs","main.xml"),
  ];
  const xmlPath = xmlPaths.find(p => fs.existsSync(p));
  if (!xmlPath) {
    console.error("[Quality Gate] SpotBugs XML not found — skipping");
    return [];
  }

  const data  = await parseStringPromise(fs.readFileSync(xmlPath, "utf8"), { explicitArray: true });
  const violations: StyleViolation[] = [];

  for (const bugInstance of (data.BugCollection?.BugInstance || [])) {
    const category = bugInstance.$.category || "";
    const type     = bugInstance.$.type || "";
    const rank     = parseInt(bugInstance.$.rank) || 20;

    // Only report rank ≤ 14 (scary/troubling/of concern in SpotBugs ranking)
    if (rank > 14) continue;

    const srcLine = bugInstance.SourceLine?.[0] || bugInstance.Method?.[0]?.SourceLine?.[0];
    const fileAttr = srcLine?.$?.sourcepath || "";
    const lineNum  = parseInt(srcLine?.$?.start) || 0;

    // Resolve relative path
    const foundFile = fileAttr
      ? (fs.readdirSync(repoRoot, { recursive: true }) as string[])
          .find(f => f.endsWith(fileAttr)) || fileAttr
      : "";

    violations.push({
      file:     foundFile,
      line:     lineNum,
      rule:     `${category}:${type}`,
      message:  bugInstance.LongMessage?.[0] || bugInstance.ShortMessage?.[0] || type,
      source:   "spotbugs",
      severity: rank <= 4 ? "error" : "warning",
    });
  }

  return violations;
}

// ── Auto-fix pass ─────────────────────────────────────────────────────────────

const FIX_SYSTEM = `You are a senior Java developer fixing code quality violations.
Output ONLY the complete corrected Java file. No markdown, no fences.
First character must be the first character of the file.

Fix ALL listed violations. Do not change anything not mentioned.
Preserve all business logic exactly.`;

async function autoFixFile(
  relPath: string,
  violations: StyleViolation[],
  snap: any,
  absRoot: string
): Promise<boolean> {
  const fullPath = path.join(absRoot, relPath);
  if (!fs.existsSync(fullPath)) return false;

  const content   = fs.readFileSync(fullPath, "utf8");
  const issueList = violations.map(v =>
    `  - Line ${v.line}: [${v.source.toUpperCase()}/${v.rule}] ${v.message}`
  ).join("\n");

  const prompt = `=== CONVENTIONS ===
${snap.conventions}

=== FILE: ${relPath} ===
${content}

=== VIOLATIONS TO FIX ===
${issueList}

Fix every violation. Return the complete corrected file.`;

  console.error(`[Quality Gate] Auto-fixing: ${relPath} (${violations.length} violations)`);
  const fixed = await callClaude(prompt, { system: FIX_SYSTEM, tier: TIER_SMART, maxTokens: 4096 });
  fs.writeFileSync(fullPath, fixed);
  return true;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args       = process.argv.slice(2);
  const taskId     = args[0];
  const repoRoot   = args[1];
  const flags      = args.slice(2);

  if (!taskId || !repoRoot) {
    console.error("Usage: tsx quality-gate.ts <task_id> <repo_path> [--checkstyle-only|--spotbugs-only]");
    process.exit(1);
  }

  const planPath = path.join(PLAN_DIR, `${taskId}-plan.json`);
  if (!fs.existsSync(planPath)) throw new Error(`Plan not found for ${taskId}`);

  const { task } = JSON.parse(fs.readFileSync(planPath, "utf8"));
  const snap     = findSnapshot(repoRoot);
  const absRoot  = path.resolve(repoRoot);
  const module   = task.modules?.[0];

  const skipCheckstyle = flags.includes("--spotbugs-only");
  const skipSpotBugs   = flags.includes("--checkstyle-only");

  // ── Run tools ─────────────────────────────────────────────────────────────
  const csViolations  = skipCheckstyle ? [] : await runCheckstyle(absRoot, snap.buildTool, module);
  const sbViolations  = skipSpotBugs   ? [] : await runSpotBugs(absRoot, snap.buildTool, module);
  const allViolations = [...csViolations, ...sbViolations];

  console.error(`[Quality Gate] Checkstyle: ${csViolations.length}  SpotBugs: ${sbViolations.length}`);

  if (allViolations.length === 0) {
    console.log("GATE_PASSED=true");
    console.log("GATE_CHECKSTYLE_VIOLATIONS=0");
    console.log("GATE_SPOTBUGS_BUGS=0");
    console.log("GATE_FIXED_FILES=");
    console.log("GATE_REMAINING_VIOLATIONS=0");
    return;
  }

  // ── Group by file ─────────────────────────────────────────────────────────
  const byFile: Record<string, StyleViolation[]> = {};
  for (const v of allViolations) {
    if (v.file) (byFile[v.file] ??= []).push(v);
  }

  // ── ONE auto-fix pass ─────────────────────────────────────────────────────
  const fixed: string[] = [];
  for (const [relPath, violations] of Object.entries(byFile)) {
    const didFix = await autoFixFile(relPath, violations, snap, absRoot);
    if (didFix) fixed.push(relPath);
  }

  // ── Re-run to count remaining violations ──────────────────────────────────
  if (fixed.length > 0) {
    console.error("[Quality Gate] Re-running checks after fixes...");
    const csAfter = skipCheckstyle ? [] : await runCheckstyle(absRoot, snap.buildTool, module);
    const sbAfter = skipSpotBugs   ? [] : await runSpotBugs(absRoot, snap.buildTool, module);
    const remaining = csAfter.length + sbAfter.length;
    const passed    = remaining === 0;

    // Persist report
    fs.writeFileSync(
      path.join(PLAN_DIR, `${taskId}-quality.json`),
      JSON.stringify({ taskId, initial: allViolations.length, remaining, fixed, timestamp: new Date().toISOString() }, null, 2)
    );

    console.log(`GATE_PASSED=${passed}`);
    console.log(`GATE_CHECKSTYLE_VIOLATIONS=${csAfter.length}`);
    console.log(`GATE_SPOTBUGS_BUGS=${sbAfter.length}`);
    console.log(`GATE_FIXED_FILES=${fixed.join(",")}`);
    console.log(`GATE_REMAINING_VIOLATIONS=${remaining}`);

    if (!passed) {
      console.log("---REMAINING---");
      [...csAfter, ...sbAfter].slice(0, 10).forEach(v =>
        console.log(`  ⚠️  ${v.file}:${v.line} [${v.rule}] ${v.message}`)
      );
    }
  } else {
    // Nothing was fixable (files not on disk, etc.)
    console.log(`GATE_PASSED=false`);
    console.log(`GATE_CHECKSTYLE_VIOLATIONS=${csViolations.length}`);
    console.log(`GATE_SPOTBUGS_BUGS=${sbViolations.length}`);
    console.log(`GATE_FIXED_FILES=`);
    console.log(`GATE_REMAINING_VIOLATIONS=${allViolations.length}`);
  }
}

main().catch(e => { console.error("❌ " + e.message); process.exit(1); });
