export const protocolVersion = "0.1" as const;

export interface ProtocolEnvelope {
  readonly protocolVersion: typeof protocolVersion;
  readonly requestId: string;
}
