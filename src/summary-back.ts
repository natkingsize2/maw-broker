/**
 * Phase-4 — summary-back: the outbound half of the owner's SDLC loop.
 *
 *   agent finishes → comments the git ISSUE (the record, done via gh by the agent) →
 *   posts a human-readable SUMMARY into the project's Discord thread, referencing the issue.
 *
 * This tool is that second step, as one reviewable path:
 *
 *   echo "summary text" | bun src/summary-back.ts <project>
 *
 * env: MAW_BROKER_SECRETS_FILE (bot token), MAW_PROJECT_ROUTES_FILE (the registry).
 * The text arrives on stdin — argv would leak the summary into `ps` output.
 * Outbound only: allowed_mentions parse:[] rides every post (DiscordRestClient), the text is
 * sanitised with the same rules as the state digest, and the issue footer is validated shape,
 * so this path can never ping a room or smuggle a secret.
 */

import { DiscordRestClient, loadRunnerSecrets } from "./runner";
import { sanitizeBlock } from "./state-mirror";
import { loadProjectRoutesFile, ProjectRegistry, type ProjectRoute } from "./project-routes";

/** Discord hard limit is 2000; leave headroom for the footer so a max-length summary still fits. */
const SUMMARY_BODY_CAP = 1800;
export const SUMMARY_MARKER = "⟦project-summary⟧";

export function buildSummaryContent(route: ProjectRoute, text: string): string {
  const body = sanitizeBlock(text, SUMMARY_BODY_CAP);
  if (!body) throw new Error("summary text empty");
  return `${body}\n-# ${SUMMARY_MARKER} ${route.issue}`;
}

export interface SummaryPoster {
  postMessage(channelId: string, content: string): Promise<{ messageId: string }>;
}

export async function postSummary(client: SummaryPoster, registry: ProjectRegistry, project: string, text: string): Promise<{ messageId: string; destination: string; issue: string }> {
  const route = registry.project(project);
  if (!route) throw new Error(`unknown project: ${project} (known: ${registry.names().join(", ")})`);
  const { messageId } = await client.postMessage(route.destination, buildSummaryContent(route, text));
  return { messageId, destination: route.destination, issue: route.issue };
}

async function main(env: Record<string, string | undefined> = process.env): Promise<void> {
  const project = process.argv[2];
  if (!project) throw new Error("usage: echo <summary> | bun src/summary-back.ts <project>");
  const routesFile = env.MAW_PROJECT_ROUTES_FILE;
  if (!routesFile) throw new Error("MAW_PROJECT_ROUTES_FILE missing");
  const registry = new ProjectRegistry(loadProjectRoutesFile(routesFile));
  const secrets = loadRunnerSecrets(env);
  const text = await new Response(Bun.stdin.stream()).text();
  const result = await postSummary(new DiscordRestClient(secrets.discordBotToken), registry, project, text);
  // Counts/ids only — never message content (constraint G).
  console.log(`summary-back project=${project} destination=${result.destination} issue=${result.issue} messageId=${result.messageId}`);
}

if (import.meta.main) { main().catch(error => { console.error(String(error?.message ?? error)); process.exit(1); }); }
