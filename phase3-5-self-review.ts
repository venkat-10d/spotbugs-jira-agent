#!/usr/bin/env tsx
/**
 * phase3-5-self-review.ts
 *
 * Senior code reviewer pass that runs AFTER generate, BEFORE PR creation.
 * Claude reads every generated file, critiques it as a senior reviewer,
 * then rewrites files that have critical issues. One pass only.
 *
 * Usage:
 *   tsx phase3-5-self-review.ts <task_id> <repo_path>
 *
 * Outputs (stdout, one per line):
 *   REVIEW_CRITICAL=<n>           number of critical issues found
 *   REVIEW_WARNINGS=<n>           number of warnings found
 *   REVIEW_FIXED=<file1>,<file2>  files that were rewritten
 *   REVIEW_CLEAN=true|false       true if no critical issues remained
 */

import fs   from "fs";
import path from "path";
import os   from "os";
import { callClaude, TIER_POWER, TIER_SMART } from "./llm-client.js";

// ── State ──────────────────────────────────────────────────────────────────────

const STATE_DIR = path.join(os.homedir(), ".openclaw", "java-agent");
const PLAN_DIR  = path.join(STATE_DIR, "plans");
const SNAP_DIR  = path.join(STATE_DIR, "snapshots");

// ── Types ──────────────────────────────────────────────────────────────────────

interface ReviewIssue {
  file:     string;
  severity: "critical" | "warning" | "suggestion";
  line?:    number;
  message:  string;
  fix?:     string;   // short description of what to change
}

interface ReviewResult {
  issues:       ReviewIssue[];
  filesToRewrite: string[];
  summary:      string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function findSnapshot(repoRoot: string): any {
  const snaps = fs.readdirSync(SNAP_DIR).filter(f => f.endsWith(".json"));
  for (const s of snaps) {
    const snap = JSON.parse(fs.readFileSync(path.join(SNAP_DIR, s), "utf8"));
    if (snap.repoRoot === path.resolve(repoRoot)) return snap;
  }
  throw new Error(`No snapshot for ${repoRoot}`);
}

// ── Review prompt ─────────────────────────────────────────────────────────────

const REVIEW_SYSTEM = `You are a principal Java engineer doing a thorough code review.
Your goal: catch issues BEFORE the PR is opened, not after.

Review for:
CRITICAL (must fix — will block merge):
  - Wrong package name or import
  - Missing @Transactional where needed (multi-step DB writes)
  - N+1 query patterns (calling repository inside a loop)
  - Missing null checks / Optional.get() without isPresent()
  - Returning mutable internal state directly
  - Security: SQL injection risk, logging sensitive data, missing @PreAuthorize
  - Breaking existing API contracts (changed response shape / removed field)
  - Exception swallowed silently (empty catch block)

WARNING (should fix — tech debt):
  - Unused imports or fields
  - Magic strings/numbers not extracted to constants
  - Method longer than 40 lines
  - Commented-out code
  - Missing Javadoc on public methods

SUGGESTION (nice to have):
  - Style inconsistency with existing codebase
  - Opportunity to simplify with Java 17+ feature

Output ONLY valid JSON. No markdown, no preamble.
Schema:
{
  "summary": "one paragraph summary of overall quality",
  "issues": [
    {
      "file": "relative/path/to/File.java",
      "severity": "critical|warning|suggestion",
      "line": 42,
      "message": "what is wrong",
      "fix": "what to do instead"
    }
  ],
  "filesToRewrite": ["relative/path/to/File.java"]
}
Only include files in "filesToRewrite" if they have CRITICAL issues.`;

const REWRITE_SYSTEM = `You are a principal Java engineer rewriting a file to fix review issues.
Output ONLY the complete corrected file content. No markdown, no fences, no commentary.
First character of output must be first character of the file (usually 'p' for package).`;

// ── Core review ───────────────────────────────────────────────────────────────

async function reviewAllFiles(
  patches: any[],
  task: any,
  snap: any,
  absRoot: string
): Promise<ReviewResult> {

  // Build a combined view of all generated files (capped to avoid token overflow)
  const fileBlocks: string[] = [];
  let totalChars = 0;
  const CAP = 28_000;

  for (const patch of patches) {
    if (!patch.path.endsWith(".java")) continue;
    const fullPath = path.join(absRoot, patch.path);
    if (!fs.existsSync(fullPath)) continue;
    const content = fs.readFileSync(fullPath, "utf8");
    const block   = `\n${"=".repeat(60)}\nFILE: ${patch.path}  [layer: ${patch.layer}]\n${"=".repeat(60)}\n${content}`;
    if (totalChars + block.length > CAP) break;
    fileBlocks.push(block);
    totalChars += block.length;
  }

  const prompt = `=== CODEBASE CONVENTIONS ===
${snap.conventions}

=== BASE PACKAGE ===
${snap.basePackage}  |  Java ${snap.javaVersion}  |  ${snap.buildTool}

=== TASK BEING IMPLEMENTED ===
${task.id}: ${task.title}
${task.description}

Acceptance Criteria:
${(task.acceptanceCriteria || []).map((c: string) => `- ${c}`).join("\n")}

=== GENERATED FILES TO REVIEW ===
${fileBlocks.join("\n")}

Review all files above. Return the JSON review result.`;

  console.error("[Phase 3.5] Sending to reviewer (power tier)...");
  const raw = await callClaude(prompt, { system: REVIEW_SYSTEM, tier: TIER_POWER, maxTokens: 3000 });

  let result: ReviewResult;
  try {
    const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
    result = {
      issues:         parsed.issues || [],
      filesToRewrite: parsed.filesToRewrite || [],
      summary:        parsed.summary || "",
    };
  } catch {
    console.error("[Phase 3.5] Could not parse review JSON — skipping rewrites");
    return { issues: [], filesToRewrite: [], summary: "Review parse failed" };
  }

  return result;
}

// ── Rewrite a single file based on its issues ─────────────────────────────────

async function rewriteFile(
  filePath: string,
  issues: ReviewIssue[],
  snap: any,
  absRoot: string
): Promise<void> {
  const fullPath = path.join(absRoot, filePath);
  if (!fs.existsSync(fullPath)) return;
  const original = fs.readFileSync(fullPath, "utf8");

  const issueList = issues
    .filter(i => i.file === filePath)
    .map(i => `- [${i.severity.toUpperCase()}] ${i.line ? `Line ${i.line}: ` : ""}${i.message} → Fix: ${i.fix || "see message"}`)
    .join("\n");

  const prompt = `=== CONVENTIONS ===
${snap.conventions}

=== FILE TO FIX: ${filePath} ===
${original}

=== ISSUES TO FIX ===
${issueList}

Rewrite the complete file fixing all issues listed above.
Keep everything that is not mentioned in the issues.`;

  console.error(`[Phase 3.5] Rewriting: ${filePath}`);
  const fixed = await callClaude(prompt, { system: REWRITE_SYSTEM, tier: TIER_SMART, maxTokens: 4096 });
  fs.writeFileSync(fullPath, fixed);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const [,, taskId, repoRoot] = process.argv;
  if (!taskId || !repoRoot) {
    console.error("Usage: tsx phase3-5-self-review.ts <task_id> <repo_path>");
    process.exit(1);
  }

  const planPath = path.join(PLAN_DIR, `${taskId}-plan.json`);
  if (!fs.existsSync(planPath)) throw new Error(`Plan not found for ${taskId}`);

  const { task, plan: planData } = JSON.parse(fs.readFileSync(planPath, "utf8"));
  const snap    = findSnapshot(repoRoot);
  const absRoot = path.resolve(repoRoot);

  // ── Step 1: Review all generated files ────────────────────────────────────
  const review = await reviewAllFiles(planData.patches || [], task, snap, absRoot);

  const criticals   = review.issues.filter(i => i.severity === "critical");
  const warnings    = review.issues.filter(i => i.severity === "warning");
  const suggestions = review.issues.filter(i => i.severity === "suggestion");

  console.error(`[Phase 3.5] Review complete:`);
  console.error(`  Critical: ${criticals.length}  Warnings: ${warnings.length}  Suggestions: ${suggestions.length}`);

  // ── Step 2: Rewrite files with critical issues ─────────────────────────────
  const fixed: string[] = [];
  for (const filePath of review.filesToRewrite) {
    await rewriteFile(filePath, review.issues, snap, absRoot);
    fixed.push(filePath);
  }

  // ── Step 3: Persist review report ─────────────────────────────────────────
  const reportPath = path.join(PLAN_DIR, `${taskId}-review.json`);
  fs.writeFileSync(reportPath, JSON.stringify({
    taskId,
    summary:    review.summary,
    criticals,
    warnings,
    suggestions,
    fixed,
    timestamp:  new Date().toISOString(),
  }, null, 2));

  // ── Output ─────────────────────────────────────────────────────────────────
  console.log(`REVIEW_CRITICAL=${criticals.length}`);
  console.log(`REVIEW_WARNINGS=${warnings.length}`);
  console.log(`REVIEW_SUGGESTIONS=${suggestions.length}`);
  console.log(`REVIEW_FIXED=${fixed.join(",")}`);
  console.log(`REVIEW_CLEAN=${criticals.length === 0}`);
  console.log(`REVIEW_SUMMARY=${review.summary}`);
  console.log(`REVIEW_REPORT=${reportPath}`);

  // Print issue list for OpenClaw to forward to user
  if (criticals.length > 0) {
    console.log("---CRITICAL_ISSUES---");
    criticals.forEach(i =>
      console.log(`  ❌ ${i.file}${i.line ? `:${i.line}` : ""} — ${i.message}`)
    );
  }
  if (warnings.length > 0) {
    console.log("---WARNINGS---");
    warnings.forEach(i =>
      console.log(`  ⚠️  ${i.file}${i.line ? `:${i.line}` : ""} — ${i.message}`)
    );
  }
}

main().catch(e => { console.error("❌ " + e.message); process.exit(1); });
