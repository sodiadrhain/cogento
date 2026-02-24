export interface AgentTool {
  name: string;
  description: string;
  schema: Record<string, unknown>; // JSON Schema for the tool inputs
  requiresApproval?: boolean;
  getPreExecutionInfo?(input: unknown): Promise<unknown>;
  execute(input: unknown, onProgress?: (data: string) => void): Promise<ToolResult>;
}

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
}
