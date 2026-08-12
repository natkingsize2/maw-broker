export type CursorOutcome = "OWNER_MISMATCH" | "CHANNEL_NOT_PROJECT" | "CONFIG_FAILURE" | "AUTH_FAILURE" | "TRANSPORT_FAILURE" | "INJECTOR_FAILURE" | "RESOLVED";
export function shouldAdvanceCursor(outcome: CursorOutcome): boolean {
  return outcome === "OWNER_MISMATCH" || outcome === "CHANNEL_NOT_PROJECT" || outcome === "RESOLVED";
}
