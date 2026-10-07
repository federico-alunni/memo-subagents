import type { HarnessDriver } from "./types.ts";
import { PiHarnessDriver } from "./drivers/pi.ts";

/** memo-subagents launches only pi children. */
const piDriver = new PiHarnessDriver();

export class UnsupportedCliError extends Error {
  constructor(cliName: string) {
    super(
      `Unsupported subagent cli "${cliName}": memo-subagents launches only pi subagents. ` +
        "Remove the `cli` field from the agent definition.",
    );
    this.name = "UnsupportedCliError";
  }
}

export function getHarnessDriver(cliName?: string): HarnessDriver {
  const normalized = cliName?.trim().toLowerCase();
  if (!normalized || normalized === "pi") return piDriver;
  throw new UnsupportedCliError(cliName!.trim());
}
