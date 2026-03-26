#!/usr/bin/env node

/**
 * LinkedIn Prospection MCP Server
 *
 * 7 tools for AI agents to automate LinkedIn prospection:
 * 1. find_leads        — Search LinkedIn for burnout/stress leads
 * 2. score_lead        — Score a lead (fit + intent + urgency → P1-P4)
 * 3. qualify_leads     — Batch qualify leads with LLM
 * 4. personalize_message — Generate personalized invitation note / DM
 * 5. run_pipeline      — Trigger full pipeline (find → invite → DM)
 * 6. get_pipeline_status — Get current pipeline status & stats
 * 7. manage_lead       — Update lead status in pipeline
 *
 * Resources:
 * - daily-log: Current day's prospection data
 * - leads: All discovered leads
 *
 * Prompts:
 * - daily_prospection: Guided daily prospection workflow
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const execFileAsync = promisify(execFile);

// ─── Configuration ──────────────────────────────────────────────

const PROSPECTION_DIR =
  process.env.PROSPECTION_DIR ||
  path.join(
    process.env.STRESSZERO_PROJECT || "D:\\Neo business\\stresszero-entrepreneur",
    "lib",
    "prospection",
  );

const SESSION_DIR = path.join(os.homedir(), ".linkedin-playwright-session");

// ICP & scoring constants
const ICP_ROLES = [
  "ceo", "fondateur", "co-fondateur", "cofondateur", "directeur", "gerant",
  "dirigeant", "president", "dg", "pdg", "owner", "partner", "associe",
  "entrepreneur", "freelance", "independant", "patron", "chef d'entreprise",
];

const BURNOUT_KEYWORDS = [
  "burnout", "burn-out", "burn out", "epuisement", "epuise", "surmenage",
  "surmene", "craque", "craque", "fatigue", "insomnie", "anxiete",
  "depression", "stress", "charge mentale", "tout arreter", "tout lacher",
  "au bord", "en peux plus", "a bout",
];

const HIGH_RISK_INDUSTRIES = [
  "tech", "startup", "conseil", "consulting", "sante", "restauration",
  "commerce", "immobilier", "finance", "marketing", "agence", "digital",
];

// ─── Scoring engine ─────────────────────────────────────────────

interface LeadInput {
  name: string;
  title?: string;
  company?: string;
  post_snippet?: string;
  linkedin_url?: string;
  source?: string;
}

interface ScoredLead extends LeadInput {
  fit_score: number;
  intent_score: number;
  urgency_score: number;
  total_score: number;
  priority: "P1-hot" | "P2-warm" | "P3-nurture" | "P4-cold";
  recommended_offer: string;
  reasoning: string;
}

function scoreLead(lead: LeadInput): ScoredLead {
  const titleLower = (lead.title || "").toLowerCase();
  const postLower = (lead.post_snippet || "").toLowerCase();
  const companyLower = (lead.company || "").toLowerCase();

  // FIT (0-30)
  let fit = 0;
  if (ICP_ROLES.some((r) => titleLower.includes(r))) fit += 20;
  if (HIGH_RISK_INDUSTRIES.some((i) => titleLower.includes(i) || companyLower.includes(i))) fit += 7;
  if (titleLower.length > 10 && titleLower.includes("|")) fit += 3;

  // INTENT (0-40)
  let intent = 0;
  const personalBurnout = [
    "j'ai failli", "j'ai craque", "j'etais epuise", "j'ai tout arrete",
    "j'ai du m'arreter", "mon burnout", "mon epuisement",
  ];
  if (personalBurnout.some((s) => postLower.includes(s))) {
    intent += 30;
  } else if (BURNOUT_KEYWORDS.some((k) => postLower.includes(k))) {
    intent += 15;
  }
  if (postLower.includes("aide") || postLower.includes("besoin") || postLower.includes("solution")) {
    intent += 10;
  }

  // URGENCY (0-30)
  let urgency = 0;
  const urgentMarkers = ["en peux plus", "a bout", "craque", "urgence", "au bord", "insomnie"];
  if (urgentMarkers.some((m) => postLower.includes(m))) urgency += 20;
  if (["j'ai", "j'etais", "mon", "ma", "je"].some((p) => postLower.includes(p))) urgency += 10;

  const total = fit + intent + urgency;
  let priority: ScoredLead["priority"];
  let recommended_offer: string;

  if (total >= 60) {
    priority = "P1-hot";
    recommended_offer = "Coaching Decouverte 297€";
  } else if (total >= 35) {
    priority = "P2-warm";
    recommended_offer = "Kit Anti-Burnout 47€";
  } else if (total >= 20) {
    priority = "P3-nurture";
    recommended_offer = "Guide 7 Jours (gratuit)";
  } else {
    priority = "P4-cold";
    recommended_offer = "Newsletter";
  }

  const reasons: string[] = [];
  if (fit >= 20) reasons.push("ICP role match");
  if (intent >= 30) reasons.push("personal burnout signal");
  else if (intent >= 15) reasons.push("burnout keyword detected");
  if (urgency >= 20) reasons.push("urgent markers");

  return {
    ...lead,
    fit_score: fit,
    intent_score: intent,
    urgency_score: urgency,
    total_score: total,
    priority,
    recommended_offer,
    reasoning: reasons.length > 0 ? reasons.join(" + ") : "Low signals",
  };
}

// ─── File helpers ───────────────────────────────────────────────

function readJsonFile(filePath: string): unknown {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function getDailyLogPath(): string {
  return path.join(PROSPECTION_DIR, "daily-log.json");
}

function getLeadsPath(): string {
  return path.join(PROSPECTION_DIR, "leads-v2.json");
}

function getDailyLog(): Record<string, unknown> {
  return (readJsonFile(getDailyLogPath()) as Record<string, unknown>) || {};
}

function getLeads(): Record<string, unknown> {
  return (readJsonFile(getLeadsPath()) as Record<string, unknown>) || {};
}

// ─── Script runner ──────────────────────────────────────────────

async function runScript(
  scriptName: string,
  args: string[] = [],
  timeoutMs = 180_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const scriptPath = path.join(PROSPECTION_DIR, scriptName);
  if (!fs.existsSync(scriptPath)) {
    return { code: -1, stdout: "", stderr: `Script not found: ${scriptPath}` };
  }

  try {
    const { stdout, stderr } = await execFileAsync("node", [scriptPath, ...args], {
      cwd: path.resolve(PROSPECTION_DIR, "../.."),
      timeout: timeoutMs,
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    return { code: 0, stdout, stderr };
  } catch (error: unknown) {
    const err = error as { code?: number; stdout?: string; stderr?: string; message?: string };
    return {
      code: err.code ?? 1,
      stdout: err.stdout || "",
      stderr: err.stderr || err.message || "Unknown error",
    };
  }
}

// ─── Message personalization ────────────────────────────────────

function generateInvitationNote(lead: LeadInput & { priority?: string }): string {
  const firstName = (lead.name || "").split(" ")[0];
  const hasPost = !!lead.post_snippet;
  const priority = lead.priority || "P2-warm";

  if (priority === "P1-hot" && hasPost) {
    return `Bonjour ${firstName}, j'ai lu votre post sur le burnout et ca m'a touche. En tant que coach specialise, j'accompagne les entrepreneurs dans cette epreuve. Echangeons ?`;
  }
  if (priority === "P1-hot") {
    return `Bonjour ${firstName}, j'aide les entrepreneurs a sortir du burnout sans tout arreter. Votre profil m'a interpelle — je serais ravi d'echanger.`;
  }
  if (hasPost) {
    return `Bonjour ${firstName}, votre post m'a interpelle. J'accompagne les entrepreneurs sur le sujet du burnout. Connectons-nous ?`;
  }
  return `Bonjour ${firstName}, je suis Emmanuel, coach specialise burnout entrepreneur. Ravi de me connecter avec vous !`;
}

function generateDM(lead: LeadInput & { priority?: string }, touchNumber: number): string {
  const firstName = (lead.name || "").split(" ")[0];

  if (touchNumber === 1) {
    return `Merci d'avoir accepte ${firstName} ! J'aide les entrepreneurs a reprendre le controle quand la pression devient trop forte. Si le sujet vous parle, j'ai cree un test de burnout gratuit (2 min) : stresszeroentrepreneur.fr/test-burnout — Ca vous dit ?`;
  }
  if (touchNumber === 2) {
    return `Re ${firstName} ! Je voulais juste partager notre guide gratuit "7 jours pour reprendre le controle" — des routines concretes testees par 200+ entrepreneurs. Dispo ici : stresszeroentrepreneur.fr/guide-7-jours — Bonne semaine !`;
  }
  return `${firstName}, je ne veux pas etre insistant. Si le sujet burnout vous concerne un jour, mes DMs sont ouverts. Prenez soin de vous !`;
}

// ─── MCP Server ─────────────────────────────────────────────────

const server = new McpServer(
  { name: "linkedin-prospection-mcp", version: "1.0.0" },
  { capabilities: { logging: {} } },
);

// ─── Tool 1: find_leads ─────────────────────────────────────────

server.registerTool(
  "find_leads",
  {
    title: "Find LinkedIn Leads",
    description:
      "Search LinkedIn for leads posting about burnout, stress, or exhaustion. " +
      "Uses Playwright to scrape LinkedIn posts matching burnout keywords. " +
      "Requires an active LinkedIn session (run setup-session first).",
    inputSchema: {
      dry_run: z.boolean().default(false).optional().describe("Simulate without actually scraping"),
    },
    annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false },
  },
  async ({ dry_run }) => {
    if (!fs.existsSync(SESSION_DIR)) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: "LinkedIn session not found. Run setup-session.js first to log in." }],
      };
    }

    const args = dry_run ? ["--dry-run"] : [];
    const result = await runScript("find-leads-v2.js", args, 300_000);

    if (result.code !== 0) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Lead search failed (code ${result.code}):\n${result.stderr}` }],
      };
    }

    const leads = getLeads();
    const summary = (leads as { summary?: { p1?: number; p2?: number; p3?: number; total?: number } }).summary;

    return {
      content: [
        {
          type: "text" as const,
          text: [
            "Lead search completed!",
            summary ? `P1-hot: ${summary.p1 || 0} | P2-warm: ${summary.p2 || 0} | P3-nurture: ${summary.p3 || 0} | Total: ${summary.total || 0}` : "",
            "",
            result.stdout.slice(-2000),
          ].join("\n"),
        },
      ],
    };
  },
);

// ─── Tool 2: score_lead ─────────────────────────────────────────

server.registerTool(
  "score_lead",
  {
    title: "Score a Lead",
    description:
      "Score a LinkedIn lead based on fit (ICP match), intent (burnout signals), " +
      "and urgency (crisis markers). Returns priority P1-P4 and recommended offer.",
    inputSchema: {
      name: z.string().describe("Lead's full name"),
      title: z.string().optional().describe("Job title / headline"),
      company: z.string().optional().describe("Company name"),
      post_snippet: z.string().optional().describe("Text from their LinkedIn post"),
      linkedin_url: z.string().optional().describe("LinkedIn profile URL"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  },
  async ({ name, title, company, post_snippet, linkedin_url }) => {
    const scored = scoreLead({ name, title, company, post_snippet, linkedin_url });

    const output = [
      `Lead: ${scored.name}`,
      `Title: ${scored.title || "N/A"}`,
      `Company: ${scored.company || "N/A"}`,
      "",
      `Fit Score: ${scored.fit_score}/30`,
      `Intent Score: ${scored.intent_score}/40`,
      `Urgency Score: ${scored.urgency_score}/30`,
      `TOTAL: ${scored.total_score}/100`,
      "",
      `Priority: ${scored.priority}`,
      `Recommended Offer: ${scored.recommended_offer}`,
      `Reasoning: ${scored.reasoning}`,
    ].join("\n");

    return { content: [{ type: "text" as const, text: output }] };
  },
);

// ─── Tool 3: qualify_leads ──────────────────────────────────────

server.registerTool(
  "qualify_leads",
  {
    title: "Qualify Leads (Batch)",
    description:
      "Score and qualify all unscored leads from the latest search. " +
      "Uses the rule-based scoring engine (fit + intent + urgency).",
    inputSchema: {
      limit: z.number().min(1).max(100).default(50).optional().describe("Max leads to score"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  },
  async ({ limit }) => {
    const leadsData = getLeads() as { leads?: LeadInput[] };
    const leads = leadsData.leads || [];

    if (leads.length === 0) {
      return { content: [{ type: "text" as const, text: "No leads found. Run find_leads first." }] };
    }

    const maxLeads = limit ?? 50;
    const toScore = leads.slice(0, maxLeads);
    const scored = toScore.map(scoreLead);

    const p1 = scored.filter((l) => l.priority === "P1-hot");
    const p2 = scored.filter((l) => l.priority === "P2-warm");
    const p3 = scored.filter((l) => l.priority === "P3-nurture");
    const p4 = scored.filter((l) => l.priority === "P4-cold");

    const lines = [
      `Qualified ${scored.length} leads:`,
      `  P1-hot: ${p1.length}`,
      `  P2-warm: ${p2.length}`,
      `  P3-nurture: ${p3.length}`,
      `  P4-cold: ${p4.length}`,
      "",
    ];

    if (p1.length > 0) {
      lines.push("--- P1 HOT LEADS ---");
      p1.forEach((l) => {
        lines.push(`  ${l.name} (${l.total_score}/100) — ${l.title || "?"} — ${l.reasoning}`);
      });
      lines.push("");
    }

    if (p2.length > 0) {
      lines.push("--- P2 WARM LEADS ---");
      p2.forEach((l) => {
        lines.push(`  ${l.name} (${l.total_score}/100) — ${l.title || "?"} — ${l.reasoning}`);
      });
    }

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  },
);

// ─── Tool 4: personalize_message ────────────────────────────────

server.registerTool(
  "personalize_message",
  {
    title: "Personalize Outreach Message",
    description:
      "Generate a personalized LinkedIn invitation note or DM for a specific lead. " +
      "Returns a message ready to copy-paste (max 200 chars for invitations, longer for DMs).",
    inputSchema: {
      name: z.string().describe("Lead's full name"),
      title: z.string().optional().describe("Job title"),
      post_snippet: z.string().optional().describe("Their LinkedIn post text"),
      priority: z.enum(["P1-hot", "P2-warm", "P3-nurture", "P4-cold"]).default("P2-warm").optional(),
      message_type: z.enum(["invitation", "dm1", "dm2", "dm3"]).default("invitation").describe(
        "Type: invitation (max 200 chars), dm1 (first DM after acceptance), dm2 (follow-up J+3), dm3 (final J+7)",
      ),
    },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  },
  async ({ name, title, post_snippet, priority, message_type }) => {
    const lead = { name, title, post_snippet, priority: priority ?? "P2-warm" };
    let message: string;

    if (message_type === "invitation") {
      message = generateInvitationNote(lead);
      if (message.length > 200) {
        message = message.substring(0, 197) + "...";
      }
    } else {
      const touchMap: Record<string, number> = { dm1: 1, dm2: 2, dm3: 3 };
      message = generateDM(lead, touchMap[message_type] || 1);
    }

    return {
      content: [
        {
          type: "text" as const,
          text: [
            `Message type: ${message_type}`,
            `For: ${name}${priority ? ` (${priority})` : ""}`,
            `Length: ${message.length} chars${message_type === "invitation" ? " (max 200)" : ""}`,
            "",
            "---",
            message,
            "---",
          ].join("\n"),
        },
      ],
    };
  },
);

// ─── Tool 5: run_pipeline ───────────────────────────────────────

server.registerTool(
  "run_pipeline",
  {
    title: "Run Prospection Pipeline",
    description:
      "Trigger the full daily prospection pipeline: find leads → send invitations → check acceptances → send DMs. " +
      "Uses the daily-orchestrator.js script. Can skip lead search with skip_leads=true.",
    inputSchema: {
      skip_leads: z.boolean().default(true).optional().describe("Skip lead search (invitations + DMs only)"),
      dry_run: z.boolean().default(false).optional().describe("Simulate without sending"),
    },
    annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false },
  },
  async ({ skip_leads, dry_run }) => {
    if (!fs.existsSync(SESSION_DIR)) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: "LinkedIn session expired. Run setup-session.js to re-login." }],
      };
    }

    const args: string[] = [];
    if (skip_leads) args.push("--skip-leads");
    if (dry_run) args.push("--dry-run");

    const result = await runScript("daily-orchestrator.js", args, 600_000);

    return {
      content: [
        {
          type: "text" as const,
          text: [
            result.code === 0 ? "Pipeline completed successfully!" : `Pipeline finished with code ${result.code}`,
            "",
            result.stdout.slice(-3000),
            result.stderr ? `\nErrors:\n${result.stderr.slice(-500)}` : "",
          ].join("\n"),
        },
      ],
    };
  },
);

// ─── Tool 6: get_pipeline_status ────────────────────────────────

server.registerTool(
  "get_pipeline_status",
  {
    title: "Get Pipeline Status",
    description:
      "Get the current state of your LinkedIn prospection pipeline: " +
      "lead counts by status, invitations sent, DMs sent, acceptance rates, and next actions.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  },
  async () => {
    const log = getDailyLog() as {
      date?: string;
      invitations_sent?: number;
      dms_sent?: number;
      leads_p1?: Array<{ name: string; status: string; priority: string; linkedin_url?: string }>;
      leads_p2?: Array<{ name: string; status: string; priority: string; linkedin_url?: string }>;
    };

    const allLeads = [...(log.leads_p1 || []), ...(log.leads_p2 || [])];

    const statusCounts: Record<string, number> = {};
    allLeads.forEach((l) => {
      const s = l.status || "unknown";
      statusCounts[s] = (statusCounts[s] || 0) + 1;
    });

    const lines = [
      `=== Pipeline Status (${log.date || "today"}) ===`,
      "",
      `Total leads tracked: ${allLeads.length}`,
      `Invitations sent: ${log.invitations_sent || 0}`,
      `DMs sent: ${log.dms_sent || 0}`,
      "",
      "--- Status Breakdown ---",
    ];

    Object.entries(statusCounts).forEach(([status, count]) => {
      lines.push(`  ${status}: ${count}`);
    });

    lines.push("", "--- Lead Details ---");
    allLeads.forEach((l) => {
      lines.push(`  [${l.priority}] ${l.name} — ${l.status}${l.linkedin_url ? ` — ${l.linkedin_url}` : ""}`);
    });

    // Session check
    lines.push("");
    if (fs.existsSync(SESSION_DIR)) {
      lines.push("LinkedIn session: ACTIVE");
    } else {
      lines.push("LinkedIn session: EXPIRED — run setup-session.js");
    }

    // Next actions
    lines.push("", "--- Next Actions ---");
    const pendingInvites = allLeads.filter((l) => l.status === "pending_invitation").length;
    const awaitingAccept = allLeads.filter((l) => l.status === "invitation_sent").length;
    const readyForDM = allLeads.filter((l) => l.status === "connection_accepted").length;

    if (pendingInvites > 0) lines.push(`  Send ${pendingInvites} pending invitations`);
    if (awaitingAccept > 0) lines.push(`  ${awaitingAccept} invitations awaiting acceptance`);
    if (readyForDM > 0) lines.push(`  Send DMs to ${readyForDM} accepted connections`);
    if (pendingInvites === 0 && awaitingAccept === 0 && readyForDM === 0) {
      lines.push("  Find new leads (run find_leads)");
    }

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  },
);

// ─── Tool 7: manage_lead ────────────────────────────────────────

server.registerTool(
  "manage_lead",
  {
    title: "Manage Lead Status",
    description:
      "Update a lead's status in the pipeline. Use this to mark leads as contacted, " +
      "replied, not_interested, or to add notes.",
    inputSchema: {
      name: z.string().describe("Lead name (partial match supported)"),
      status: z.enum([
        "pending_invitation", "invitation_sent", "connection_accepted",
        "dm_sent", "replied", "meeting_booked", "not_interested", "removed",
      ]).describe("New status"),
      notes: z.string().optional().describe("Optional notes about the lead"),
    },
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
  },
  async ({ name, status, notes }) => {
    const logPath = getDailyLogPath();
    const log = getDailyLog() as {
      leads_p1?: Array<Record<string, unknown>>;
      leads_p2?: Array<Record<string, unknown>>;
    };

    const nameLower = name.toLowerCase();
    let found = false;
    let matchedName = "";

    for (const pool of [log.leads_p1 || [], log.leads_p2 || []]) {
      for (const lead of pool) {
        if ((lead.name as string || "").toLowerCase().includes(nameLower)) {
          lead.status = status;
          if (notes) lead.notes = notes;
          lead.updated_at = new Date().toISOString();
          found = true;
          matchedName = lead.name as string;
          break;
        }
      }
      if (found) break;
    }

    if (!found) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Lead "${name}" not found in pipeline.` }],
      };
    }

    fs.writeFileSync(logPath, JSON.stringify(log, null, 2));

    return {
      content: [
        {
          type: "text" as const,
          text: `Updated ${matchedName} → status: ${status}${notes ? ` | notes: ${notes}` : ""}`,
        },
      ],
    };
  },
);

// ─── Resource: daily-log ────────────────────────────────────────

server.registerResource(
  "daily-log",
  "linkedin-prospection://daily-log",
  {
    title: "Daily Prospection Log",
    description: "Current day's LinkedIn prospection data: leads, invitations, DMs, statuses",
    mimeType: "application/json",
  },
  async (uri) => {
    const log = getDailyLog();
    return {
      contents: [{ uri: uri.href, text: JSON.stringify(log, null, 2) }],
    };
  },
);

// ─── Resource: leads ────────────────────────────────────────────

server.registerResource(
  "leads",
  "linkedin-prospection://leads",
  {
    title: "Discovered Leads",
    description: "All leads discovered from LinkedIn search (latest batch)",
    mimeType: "application/json",
  },
  async (uri) => {
    const leads = getLeads();
    return {
      contents: [{ uri: uri.href, text: JSON.stringify(leads, null, 2) }],
    };
  },
);

// ─── Prompt: daily_prospection ──────────────────────────────────

server.registerPrompt(
  "daily_prospection",
  {
    title: "Daily LinkedIn Prospection",
    description: "Guided daily prospection workflow for LinkedIn lead generation",
    argsSchema: {
      mode: z.enum(["full", "quick"]).default("quick").describe(
        "full: find leads + invitations + DMs | quick: invitations + DMs only",
      ),
    },
  },
  ({ mode }) => {
    const isQuick = mode === "quick";

    return {
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              "Lance la prospection LinkedIn du jour pour StressZero Entrepreneur.",
              "",
              isQuick
                ? "Mode QUICK: invitations + DMs seulement (pas de recherche de leads)."
                : "Mode FULL: recherche de leads + invitations + DMs.",
              "",
              "Etapes:",
              "1. Verifie le statut du pipeline avec get_pipeline_status",
              isQuick ? "" : "2. Cherche de nouveaux leads avec find_leads",
              `${isQuick ? "2" : "3"}. Qualifie les leads non scores avec qualify_leads`,
              `${isQuick ? "3" : "4"}. Genere des messages personalises pour les P1/P2 avec personalize_message`,
              `${isQuick ? "4" : "5"}. Lance le pipeline avec run_pipeline (skip_leads=${isQuick})`,
              `${isQuick ? "5" : "6"}. Affiche le rapport final avec get_pipeline_status`,
              "",
              "Important: max 5 invitations/jour, max 5 DMs/jour, messages en francais.",
            ]
              .filter(Boolean)
              .join("\n"),
          },
        },
      ],
    };
  },
);

// ─── Startup ────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("LinkedIn Prospection MCP server running on stdio");
  console.error(`Prospection dir: ${PROSPECTION_DIR}`);
  console.error(`Session dir: ${SESSION_DIR}`);
  console.error(
    "Tools: find_leads, score_lead, qualify_leads, personalize_message, run_pipeline, get_pipeline_status, manage_lead",
  );
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
