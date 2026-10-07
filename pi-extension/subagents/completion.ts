/** How a subagent ended, as recorded in its lifecycle (see runtime-client.ts for the source of truth). */
export interface CompletionResult {
  reason: "done" | "ping" | "sentinel" | "error";
  exitCode: number;
  ping?: { name: string; message: string };
  errorMessage?: string;
}
