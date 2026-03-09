#!/usr/bin/env tsx
/**
 * confluence-context.ts
 *
 * Searches Confluence (via Atlassian MCP JSON passed as arg) for ADRs and
 * design docs relevant to the task, distils them with Claude, and writes
 * an architectural context block to state — injected into Phase 3 prompts.
 *
 * Confluence is accessed exclusively through the Atlassian MCP server
 * declared in skill.md. OpenClaw calls the MCP tools and passes the results
 * here as JSON — this script never makes direct HTTP calls to Confluence.
 *
 * Workflow in skill.md:
 *   1. mcp[atlassian]: confluence_search(query="<task title> architecture")
 *   2. mcp[atlassian]: confluence_search(query="ADR <component>")
 *   3. mcp[atlassian]: confluence_get_page(pageId="<id>") for top 3 results
 *   4. exec: node scripts/confluence-context.ts <task_id> '<SEARCH_RESULTS_JSON>'
 *
 * Usage (direct):
 *   tsx confluence-context.ts <task_id> '<json_array_of_pages>'
 *   tsx confluence-context.ts <task_id> --skip     ← skip, write empty context
 *
 * Outputs (stdout):
 *   CONFLUENCE_PAGES=<n>
 *   CONFLUENCE_CONTEXT_FILE=<path>
 *   CONFLUENCE_SUMMARY=<one-liner>
 */

import fs   from "fs";
import path from "path";
import os   from "os";
import { callClaude, TIER_FAST } from "./llm-client.js";

// ── State ──────────────────────────────────────────────────────────────────────

const STATE_DIR   = path.join(os.homedir(), ".openclaw", "java-agent");
const CONTEXT_DIR = path.join(STATE_DIR, "confluence-context");
fs.mkdirSync(CONTEXT_DIR, { recursive: true });

// ── Types ──────────────────────────────────────────────────────────────────────

interface ConfluencePage {
  id:      string;
  title:   string;
  space?:  string;
  url?:    string;
  body:    string;   // plain text extracted by MCP
  labels?: string[];
}

interface ArchContext {
  taskId:   string;
  pages:    number;
  summary:  string;     // 400-word distil by Claude
  rawPages: ConfluencePage[];
  timestamp: string;
}

// ── Relevance classifier ──────────────────────────────────────────────────────

const ADR_SIGNALS   = ["adr", "architecture decision", "decision record", "rfc", "design doc"];
const AVOID_SIGNALS = ["meeting notes", "sprint retrospective", "standup", "onboarding"];

function scoreRelevance(page: ConfluencePage, taskTitle: string): number {
  const text  = `${page.title} ${page.body} ${(page.labels || []).join(" ")}`.toLowerCase();
  const title = taskTitle.toLowerCase();
  let score   = 0;

  // Positive signals
  ADR_SIGNALS.forEach(s => { if (text.includes(s)) score += 3; });
  title.split(" ").filter(w => w.length > 3).forEach(w => { if (text.includes(w)) score += 1; });

  // Negative signals (meeting notes, retros, etc. are rarely useful)
  AVOID_SIGNALS.forEach(s => { if (text.includes(s)) score -= 5; });

  return score;
}

// ── Claude distil ─────────────────────────────────────────────────────────────

const DISTIL_SYSTEM = `You are a principal Java architect summarising Confluence docs
for a developer agent about to implement a feature.

Extract ONLY what is architecturally relevant:
- Decisions already made (and why alternatives were rejected)
- Patterns the team has mandated (e.g. "always use outbox pattern for events")
- Known constraints (performance budgets, latency SLAs, data residency)
- Pitfalls to avoid (documented bugs or mistakes from past work)
- Approved libraries or approaches for this domain

Ignore: project management content, team introductions, meeting notes.
Be concise. Maximum 400 words. Use bullet points.`;

async function distilContext(pages: ConfluencePage[], taskTitle: string): Promise<string> {
  if (!pages.length) return "(No relevant Confluence pages found)";

  const combined = pages
    .map(p => `### ${p.title}\n${p.body.slice(0, 3000)}`)
    .join("\n\n---\n\n")
    .slice(0, 18_000);

  const prompt = `Task being implemented: "${taskTitle}"

Confluence pages found:
${combined}

Distil the architectural guidance relevant to this task.`;

  return callClaude(prompt, { system: DISTIL_SYSTEM, tier: TIER_FAST, maxTokens: 600 });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const [,, taskId, rawArg] = process.argv;

  if (!taskId) {
    console.error("Usage: tsx confluence-context.ts <task_id> '<json>' | --skip");
    process.exit(1);
  }

  const contextFile = path.join(CONTEXT_DIR, `${taskId}-confluence.json`);

  // ── Skip mode — write empty context ───────────────────────────────────────
  if (rawArg === "--skip" || !rawArg) {
    const empty: ArchContext = {
      taskId,
      pages:    0,
      summary:  "(Confluence search skipped)",
      rawPages: [],
      timestamp: new Date().toISOString(),
    };
    fs.writeFileSync(contextFile, JSON.stringify(empty, null, 2));
    console.log("CONFLUENCE_PAGES=0");
    console.log(`CONFLUENCE_CONTEXT_FILE=${contextFile}`);
    console.log("CONFLUENCE_SUMMARY=skipped");
    return;
  }

  // ── Parse MCP results ─────────────────────────────────────────────────────
  let mcpData: any;
  try {
    mcpData = JSON.parse(rawArg);
  } catch {
    console.error("[Confluence] Could not parse MCP JSON — skipping");
    mcpData = [];
  }

  // MCP returns either an array of pages or an object with a results array
  const rawPages: any[] = Array.isArray(mcpData)
    ? mcpData
    : (mcpData.results || mcpData.pages || []);

  // Normalise to ConfluencePage shape
  const pages: ConfluencePage[] = rawPages.map((p: any) => ({
    id:     p.id || p.pageId || "",
    title:  p.title || p.name || "Untitled",
    space:  p.space?.key || p.spaceKey || "",
    url:    p._links?.webui || p.url || "",
    body:   p.body?.storage?.value
         || p.body?.view?.value
         || p.excerpt
         || p.content
         || p.text
         || "",
    labels: (p.metadata?.labels?.results || []).map((l: any) => l.name),
  }));

  // Load task title for relevance scoring
  const taskFile = path.join(STATE_DIR, "tasks", `${taskId}.json`);
  const taskTitle = fs.existsSync(taskFile)
    ? JSON.parse(fs.readFileSync(taskFile, "utf8")).title
    : taskId;

  // Score and filter — keep top 4 most relevant
  const scored  = pages
    .map(p => ({ p, score: scoreRelevance(p, taskTitle) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map(({ p }) => p);

  console.error(`[Confluence] ${pages.length} pages received, ${scored.length} deemed relevant`);

  // ── Distil with Claude ────────────────────────────────────────────────────
  const summary = await distilContext(scored, taskTitle);

  const ctx: ArchContext = {
    taskId,
    pages:    scored.length,
    summary,
    rawPages: scored,
    timestamp: new Date().toISOString(),
  };

  fs.writeFileSync(contextFile, JSON.stringify(ctx, null, 2));

  console.log(`CONFLUENCE_PAGES=${scored.length}`);
  console.log(`CONFLUENCE_CONTEXT_FILE=${contextFile}`);
  console.log(`CONFLUENCE_SUMMARY=${summary.split("\n")[0].slice(0, 120)}`);

  if (scored.length > 0) {
    console.log("---PAGES_USED---");
    scored.forEach(p => console.log(`  📄 ${p.title} (${p.space})`));
  }
}

main().catch(e => { console.error("❌ " + e.message); process.exit(1); });
