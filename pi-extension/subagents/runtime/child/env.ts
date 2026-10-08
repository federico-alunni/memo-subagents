/** Private identity variables of a runtime child (set by AgentRuntime, read by the child extension). */
export const CHILD_ENV = {
  protocolDir: "PI_MEMO_RUNTIME_PROTOCOL_DIR",
  nonce: "PI_MEMO_RUNTIME_NONCE",
  scope: "PI_MEMO_RUNTIME_SCOPE",
  agentId: "PI_MEMO_RUNTIME_AGENT_ID",
  attempt: "PI_MEMO_RUNTIME_ATTEMPT",
} as const;
