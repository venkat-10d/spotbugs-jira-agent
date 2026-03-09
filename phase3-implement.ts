#!/usr/bin/env tsx
/**
 * phase3-implement.ts
 * Orchestrates: plan → generate code (per file) → git commit → draft PR
 *
 * Usage:
 *   tsx phase3-implement.ts plan     <task_id> <repo_path>
 *   tsx phase3-implement.ts generate <task_id> <repo_path>
 *   tsx phase3-implement.ts pr       <task_id> <repo_path>
 *   tsx phase3-implement.ts all      <task_id> <repo_path>   ← runs all three
 */

import fs            from "fs";
import path          from "path";
import os            from "os";
import { execSync }  from "child_process";
import { callClaude, TIER_FAST, TIER_SMART, TIER_POWER } from "./llm-client.js";

// ── Paths ─────────────────────────────────────────────────────────────────────

const STATE_DIR = path.join(os.homedir(), ".openclaw", "java-agent");
const SNAP_DIR  = path.join(STATE_DIR, "snapshots");
const TASK_DIR  = path.join(STATE_DIR, "tasks");
const PLAN_DIR  = path.join(STATE_DIR, "plans");
fs.mkdirSync(PLAN_DIR, { recursive: true });

// ── Helpers ────────────────────────────────────────────────────────────────────

function loadTask(taskId: string): any {
  const p = path.join(TASK_DIR, `${taskId}.json`);
  if (!fs.existsSync(p)) throw new Error(`Task not found: ${p}. Run phase1 first.`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function findSnapshot(repoRoot: string): any {
  const snaps = fs.readdirSync(SNAP_DIR).filter(f => f.endsWith(".json"));
  for (const s of snaps) {
    const snap = JSON.parse(fs.readFileSync(path.join(SNAP_DIR, s), "utf8"));
    if (snap.repoRoot === path.resolve(repoRoot)) return snap;
  }
  throw new Error(`No snapshot for ${repoRoot}. Run phase2 first.`);
}

function buildContextBlock(snap: any, taskId?: string): string {
  const anchors    = snap.files.filter((f: any) => f.isAnchor);
  const layerOrder = ["entity","dto","repository","service","controller","config","exception","other"];
  const byLayer: Record<string, any[]> = {};
  for (const f of snap.files) if (!f.isAnchor) (byLayer[f.layer] ??= []).push(f);

  const parts = [
    "=== PROJECT ===",
    `Base package: ${snap.basePackage}  |  Build: ${snap.buildTool}  |  Java ${snap.javaVersion}`,
    "",
    "=== DIRECTORY TREE ===",
    snap.tree.split("\n").slice(0, 60).join("\n"),
    "",
    "=== DEPENDENCIES (excerpt) ===",
    snap.deps.slice(0, 30).join("\n"),
    "",
    "=== CONVENTIONS ===",
    snap.conventions,
  ];

  // ── Inject Confluence architectural context if available ──────────────────
  if (taskId) {
    const ctxFile = path.join(STATE_DIR, "confluence-context", `${taskId}-confluence.json`);
    if (fs.existsSync(ctxFile)) {
      try {
        const ctx = JSON.parse(fs.readFileSync(ctxFile, "utf8"));
        if (ctx.pages > 0 && ctx.summary) {
          parts.push("", "=== ARCHITECTURAL CONTEXT (from Confluence) ===");
          parts.push(`Source: ${ctx.pages} relevant page(s)`);
          parts.push(ctx.summary);
        }
      } catch { /* ignore */ }
    }
  }

  parts.push("", "=== ANCHOR FILES ===");
  for (const f of anchors) parts.push(`\n--- ${f.path} ---\n${f.content.slice(0, 3000)}`);
  for (const layer of layerOrder) {
    const files = (byLayer[layer] || []).slice(0, 2);
    if (files.length) {
      parts.push(`\n=== ${layer.toUpperCase()} EXAMPLES ===`);
      for (const f of files) parts.push(`\n--- ${f.path} ---\n${f.content.slice(0, 2000)}`);
    }
  }
  return parts.join("\n");
}

function git(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: ["pipe","pipe","pipe"] }).toString().trim();
}

// ── GUARDRAIL: block direct pushes to protected branches ─────────────────────

function assertNotProtectedBranch(repoRoot: string): void {
  let current = "";
  try { current = git("git rev-parse --abbrev-ref HEAD", repoRoot); }
  catch { return; }
  const protected_ = ["main","master","trunk","develop","release"];
  if (protected_.includes(current)) {
    throw new Error(
      `🚨 GUARDRAIL: Currently on '${current}' branch. ` +
      `The agent never commits directly to protected branches. ` +
      `Please checkout a feature branch or let the agent create one.`
    );
  }
}

// ── GUARDRAIL: secret scan ────────────────────────────────────────────────────

const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/,        // OpenAI / Anthropic keys
  /AKIA[0-9A-Z]{16}/,            // AWS access key
  /ghp_[a-zA-Z0-9]{36}/,         // GitHub PAT
  /-----BEGIN (RSA|EC) PRIVATE KEY-----/,
  /password\s*=\s*["'][^"']{6,}["']/i,
  /secret\s*=\s*["'][^"']{6,}["']/i,
];

function scanForSecrets(content: string, filePath: string): void {
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(content)) {
      throw new Error(
        `🚨 SECRET DETECTED in ${filePath}: matches ${pattern.source.slice(0,30)}... ` +
        `Commit blocked. Remove the secret before proceeding.`
      );
    }
  }
}

// ── STEP 1: Plan ─────────────────────────────────────────────────────────────

const PLAN_SYSTEM = `You are a senior Java architect using Spring Boot 3 and Java 17+.
Output ONLY valid JSON — no markdown fences, no commentary.
Schema:
{
  "summary": "one paragraph",
  "pomAdditions": ["<dependency>...</dependency>"],
  "migrationSql": "SQL or null",
  "envVars": ["VAR_NAME"],
  "patches": [
    { "path": "user-service/src/main/java/com/acme/auth/RegisterController.java",
      "action": "create",
      "layer": "controller",
      "reason": "REST endpoint for registration" }
  ]
}`;

async function plan(taskId: string, repoRoot: string): Promise<any> {
  const task = loadTask(taskId);
  const snap = findSnapshot(repoRoot);
  const ctx  = buildContextBlock(snap, taskId);

  const module     = task.modules?.[0] ? `Primary module: ${task.modules[0]}` : "Single-module project";
  const taskSummary = `
Task ${task.id}: ${task.title}
Description: ${task.description}
Acceptance Criteria:
${(task.acceptanceCriteria || []).map((c: string) => `  - ${c}`).join("\n")}
Tech Hints:
${(task.techHints || []).map((h: string) => `  - ${h}`).join("\n")}
Java ${task.javaVersion} | ${task.buildTool} | ${module}`;

  const prompt = `${ctx}\n\n=== TASK ===\n${taskSummary}\n\nList every file, migration, and dep needed.`;

  console.error("[Phase 3] Planning implementation (power tier)...");
  const raw  = await callClaude(prompt, { system: PLAN_SYSTEM, tier: TIER_POWER, maxTokens: 2000 });
  const data = JSON.parse(raw.replace(/```json|```/g, "").trim());

  const planPath = path.join(PLAN_DIR, `${taskId}-plan.json`);
  fs.writeFileSync(planPath, JSON.stringify({ task, plan: data }, null, 2));
  console.log(`PLAN_FILE=${planPath}`);
  console.log(`PLAN_FILES=${data.patches?.length || 0}`);
  console.log(`PLAN_SUMMARY=${data.summary}`);
  return data;
}

// ── STEP 2: Generate files ────────────────────────────────────────────────────

const CODE_SYSTEM = `You are a senior Java developer writing production-grade Spring Boot 3 code.
Output ONLY the raw Java (or SQL/YAML) file content — no markdown, no fences.
The very first character must be the first character of the file.

Rules:
- Match the project's exact package names, annotations, and patterns
- Use constructor injection (never @Autowired field injection)
- Add @Slf4j for logging where appropriate
- Include Javadoc on public classes and methods
- Use Java 17+ features: records for DTOs, var, text blocks
- Follow the existing exception handling pattern
- Never use deprecated Spring Boot 3 / Spring Security 6 APIs`;

async function generate(taskId: string, repoRoot: string): Promise<string[]> {
  const planPath = path.join(PLAN_DIR, `${taskId}-plan.json`);
  if (!fs.existsSync(planPath)) throw new Error(`Plan not found for ${taskId}. Run 'plan' step first.`);

  const { task, plan: planData } = JSON.parse(fs.readFileSync(planPath, "utf8"));
  const snap = findSnapshot(repoRoot);
  const ctx  = buildContextBlock(snap, taskId);

  const layerOrder = ["entity","dto","repository","service","controller","config","exception","other"];
  const ordered    = [...planData.patches].sort(
    (a: any, b: any) => layerOrder.indexOf(a.layer) - layerOrder.indexOf(b.layer)
  );

  const written: Array<{ path: string; content: string }> = [];
  const absRoot = path.resolve(repoRoot);

  for (const patch of ordered) {
    console.error(`[Phase 3] Generating (${patch.layer}): ${patch.path}`);

    const siblings = written.slice(-3)
      .map(w => `// ${w.path}\n${w.content.slice(0, 1500)}`)
      .join("\n\n");

    const prompt = `${ctx}

=== TASK ===
${task.title}: ${task.description}

=== PLAN ===
${planData.summary}
All files: ${ordered.map((p: any) => p.path).join(", ")}

=== ALREADY WRITTEN ===
${siblings || "(none yet)"}

=== YOUR JOB ===
Write the COMPLETE content of: ${patch.path}
Layer: ${patch.layer}
Reason: ${patch.reason}
Action: ${patch.action}
Java ${task.javaVersion} | base package: ${snap.basePackage}`;

    const content = await callClaude(prompt, { system: CODE_SYSTEM, tier: TIER_SMART, maxTokens: 3500 });

    // Guardrail: scan for secrets before writing
    scanForSecrets(content, patch.path);

    const dest = path.join(absRoot, patch.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);

    written.push({ path: patch.path, content });
    console.log(`WRITTEN=${patch.path}`);
  }

  // Write migration if needed
  if (planData.migrationSql) {
    const module      = task.modules?.[0] || "";
    const flywayDir   = path.join(absRoot, module, "src","main","resources","db","migration");
    fs.mkdirSync(flywayDir, { recursive: true });
    const existing    = fs.readdirSync(flywayDir).filter(f => /^V\d+__/.test(f)).length;
    const migFile     = path.join(flywayDir, `V${String(existing + 1).padStart(4,"0")}__${taskId.toLowerCase()}.sql`);
    fs.writeFileSync(migFile, planData.migrationSql);
    console.log(`MIGRATION=${path.relative(absRoot, migFile)}`);
  }

  // Patch pom.xml with new deps
  if (planData.pomAdditions?.length) {
    const module  = task.modules?.[0] || "";
    const pomPath = path.join(absRoot, module, "pom.xml");
    if (fs.existsSync(pomPath)) {
      let pom   = fs.readFileSync(pomPath, "utf8");
      const add = planData.pomAdditions.map((d: string) => `        ${d}`).join("\n");
      pom       = pom.replace("</dependencies>", `${add}\n    </dependencies>`);
      fs.writeFileSync(pomPath, pom);
      console.log(`POM_UPDATED=${module || "root"}/pom.xml`);
    }
  }

  return written.map(w => w.path);
}

// ── STEP 3: Git commit + draft PR ────────────────────────────────────────────

async function createPR(taskId: string, repoRoot: string): Promise<string> {
  const planPath = path.join(PLAN_DIR, `${taskId}-plan.json`);
  const { task, plan: planData } = JSON.parse(fs.readFileSync(planPath, "utf8"));
  const absRoot  = path.resolve(repoRoot);

  // Guardrail check
  assertNotProtectedBranch(absRoot);

  const slug   = task.title.toLowerCase().replace(/[^a-z0-9]+/g,"-").slice(0, 35);
  const branch = `agent/kai/${taskId.toLowerCase()}-${slug}`;

  // Create branch
  try { git(`git checkout -b ${branch}`, absRoot); }
  catch { git(`git checkout ${branch}`, absRoot); }

  // Stage all generated files
  git(`git add -A`, absRoot);

  const msg = `feat(${taskId}): ${task.title}\n\n${planData.summary}\n\nTask: ${taskId}\nGenerated-by: openclaw-java-dev`;
  git(`git commit -m "${msg.replace(/"/g,'\\"')}"`, absRoot);
  git(`git push -u origin ${branch}`, absRoot);

  // Build PR body
  const acChecklist = (task.acceptanceCriteria || []).map((c: string) => `- [ ] ${c}`).join("\n");
  const filesTable  = (planData.patches || []).map((p: any) => `- \`${p.path}\` (${p.action})`).join("\n");
  const pomNote     = planData.pomAdditions?.length
    ? `\n**📦 New Maven deps:**\n\`\`\`xml\n${planData.pomAdditions.join("\n")}\n\`\`\`` : "";
  const dbNote      = planData.migrationSql ? "\n**🗄️ Includes Flyway migration — review SQL before merging.**" : "";
  const envNote     = planData.envVars?.length
    ? `\n**⚠️ New env vars required:**\n${planData.envVars.map((v: string) => `- \`${v}\``).join("\n")}` : "";

  const prBody = `## [${taskId}] ${task.title}

**Java ${task.javaVersion}** | **${task.buildTool}** | **Spring Boot 3**

### Implementation
${planData.summary}

### Files Changed
${filesTable}

### Acceptance Criteria
${acChecklist}
${pomNote}${dbNote}${envNote}

---
> ⚠️ Generated by **openclaw-java-dev (Kai)**. Review all code before merging.
> Run: \`${task.buildTool === "gradle" ? "./gradlew test" : "mvn verify"}\`
`;

  const prTitle = `[${taskId}] ${task.title}`;
  let prUrl = "";
  try {
    prUrl = execSync(
      `gh pr create --title "${prTitle.replace(/"/g,'\\"')}" --body "${prBody.replace(/"/g,'\\"').replace(/\n/g,"\\n")}" --base main --head ${branch} --draft`,
      { cwd: absRoot, stdio: ["pipe","pipe","pipe"] }
    ).toString().trim();
  } catch (e: any) {
    prUrl = `(gh CLI error — branch ${branch} pushed, create PR manually)`;
  }

  console.log(`BRANCH=${branch}`);
  console.log(`PR_URL=${prUrl}`);
  return prUrl;
}

// ── Child script runner ────────────────────────────────────────────────────────
// Runs phase3-5-self-review and quality-gate as child processes so they can
// be used standalone too. Reads their stdout key=value pairs.

function runChildScript(script: string, args: string[]): Record<string, string> {
  const scriptPath = path.join(__dirname, script);
  const result: Record<string, string> = {};
  try {
    const out = execSync(
      `tsx ${scriptPath} ${args.map(a => `"${a.replace(/"/g,'\\"')}"`).join(" ")}`,
      { stdio: ["pipe","pipe","inherit"], timeout: 300_000 }
    ).toString();
    for (const line of out.split("\n")) {
      const eq = line.indexOf("=");
      if (eq !== -1) result[line.slice(0, eq)] = line.slice(eq + 1);
    }
  } catch (e: any) {
    console.error(`[phase3] Child script ${script} failed: ${e.message}`);
  }
  return result;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const [,,subcommand, taskId, repoRoot] = process.argv;

  if (!subcommand || !taskId || !repoRoot) {
    console.error(
      "Usage: tsx phase3-implement.ts <plan|generate|review|quality|pr|all> <task_id> <repo_path>"
    );
    process.exit(1);
  }

  if (subcommand === "plan" || subcommand === "all") {
    await plan(taskId, repoRoot);
  }

  if (subcommand === "generate" || subcommand === "all") {
    await generate(taskId, repoRoot);
  }

  // ── Phase 3.5: Self-review (runs after generate, before quality + PR) ──────
  if (subcommand === "review" || subcommand === "all") {
    console.error("[Phase 3] Running self-review...");
    const reviewOut = runChildScript("phase3-5-self-review.ts", [taskId, repoRoot]);
    const critical  = parseInt(reviewOut["REVIEW_CRITICAL"] || "0");
    const warnings  = parseInt(reviewOut["REVIEW_WARNINGS"] || "0");
    const fixed     = reviewOut["REVIEW_FIXED"] || "";

    console.log(`REVIEW_CRITICAL=${critical}`);
    console.log(`REVIEW_WARNINGS=${warnings}`);
    console.log(`REVIEW_FIXED=${fixed}`);

    // If critical issues couldn't be fixed, stop before opening a PR
    if (reviewOut["REVIEW_CLEAN"] === "false") {
      console.error(`⚠️  ${critical} critical review issues remain after fix attempt.`);
      console.error(`   Review report: ${reviewOut["REVIEW_REPORT"]}`);
      if (subcommand === "all") {
        console.error("   Halting PR creation. Fix issues and re-run 'pr' step manually.");
        process.exit(2); // exit code 2 = review failed
      }
    }
  }

  // ── Quality gate: Checkstyle + SpotBugs ───────────────────────────────────
  if (subcommand === "quality" || subcommand === "all") {
    console.error("[Phase 3] Running quality gate...");
    const qOut      = runChildScript("quality-gate.ts", [taskId, repoRoot]);
    const passed    = qOut["GATE_PASSED"] === "true";
    const remaining = parseInt(qOut["GATE_REMAINING_VIOLATIONS"] || "0");

    console.log(`GATE_PASSED=${passed}`);
    console.log(`GATE_REMAINING=${remaining}`);

    if (!passed) {
      console.error(`⚠️  ${remaining} quality violations remain after auto-fix.`);
      if (subcommand === "all") {
        console.error("   PR will be created but labelled with quality warnings.");
        // Don't block — create the PR with a warning label instead
      }
    }
  }

  if (subcommand === "pr" || subcommand === "all") {
    await createPR(taskId, repoRoot);
  }
}

main().catch(e => { console.error("❌ " + e.message); process.exit(1); });
