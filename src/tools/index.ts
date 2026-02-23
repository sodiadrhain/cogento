export interface AgentTool {
    name: string;
    description: string;
    schema: any; // JSON Schema for the tool inputs
    requiresApproval?: boolean;
    getPreExecutionInfo?(input: any): Promise<any>;
    execute(input: any, onProgress?: (data: string) => void): Promise<ToolResult>;
}

export interface ToolResult {
    success: boolean;
    output: string;
    error?: string;
}
