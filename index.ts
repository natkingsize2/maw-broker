import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";
import { NAT_USER_ID } from "./src/broker";

export const command = { name: "maw-broker", description: "Authenticated local decision broker diagnostics." };

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const args = ctx.source === "cli" ? (ctx.args as string[]) : [];
  const output = args[0] === "status" || !args[0] ? `maw-broker phase1 owner=${NAT_USER_ID} transport=discord-text` : `maw-broker ${args[0]} is read-only in phase1`;
  if (ctx.writer) ctx.writer(output);
  return { ok: true, output: ctx.writer ? "" : output };
}
