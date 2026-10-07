/** Private identity variables of a runtime child (set by AgentRuntime, read by the child extension). */
export const CHILD_ENV = {
  protocolDir: "MEMO_RUNTIME_PROTOCOL_DIR",
  nonce: "MEMO_RUNTIME_NONCE",
  scope: "MEMO_RUNTIME_SCOPE",
  agentId: "MEMO_RUNTIME_AGENT_ID",
  attempt: "MEMO_RUNTIME_ATTEMPT",
} as const;
