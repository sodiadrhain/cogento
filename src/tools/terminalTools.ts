import * as vscode from 'vscode';
import { AgentTool, ToolResult } from './index';

export class RunCommandTool implements AgentTool {
  name = 'runCommand';
  description =
    'Runs a shell command in the workspace root by opening a new visible VS Code Terminal. Use this for starting servers, running complex builds, or anything that requires user visibility.';
  requiresApproval = true;
  schema = {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to run.' },
    },
    required: ['command'],
  };

  private agentTerminal: vscode.Terminal | null = null;

  constructor(private workspaceRoot: string) {}

  async execute(
    input: { command: string },
    onProgress?: (data: string) => void,
  ): Promise<ToolResult> {
    if (!this.workspaceRoot) {
      return {
        success: false,
        output: '',
        error: 'No workspace folder is open. Please open a folder in VS Code first.',
      };
    }

    try {
      if (onProgress) onProgress(`\nOpening terminal to run: ${input.command}\n`);

      // Reuse the existing agent terminal if it exists, otherwise create a new one
      if (!this.agentTerminal || this.agentTerminal.exitStatus) {
        this.agentTerminal = vscode.window.createTerminal({
          name: 'Cogento Execution',
          cwd: this.workspaceRoot,
        });
      }

      this.agentTerminal.show(true); // show but don't steal focus
      this.agentTerminal.sendText(input.command);

      return {
        success: true,
        output: `Command "${input.command}" was successfully sent to the "Cogento Execution" terminal in VS Code. Please check the terminal panel for the output.`,
      };
    } catch (err: unknown) {
      return {
        success: false,
        output: '',
        error: `Failed to launch terminal: ${(err as Error).message}`,
      };
    }
  }
}
