import { spawn } from 'child_process';
import { AgentTool, ToolResult } from './index';

export class RunCommandTool implements AgentTool {
    name = 'runCommand';
    description = 'Runs a shell command in the workspace root. Must be approved by the user.';
    requiresApproval = true;
    schema = {
        type: 'object',
        properties: {
            command: { type: 'string', description: 'The shell command to run.' }
        },
        required: ['command']
    };

    constructor(private workspaceRoot: string) {}

    async execute(input: { command: string }, onProgress?: (data: string) => void): Promise<ToolResult> {
        if (!this.workspaceRoot) {
            return { success: false, output: '', error: 'No workspace folder is open. Please open a folder in VS Code first.' };
        }
        
        const command = input.command;

        return new Promise((resolve) => {
            // Using spawn to get streaming output
            const child = spawn(command, { 
                cwd: this.workspaceRoot, 
                shell: true,
                timeout: 60000 
            });

            let stdout = '';
            let stderr = '';

            child.stdout.on('data', (data) => {
                const chunk = data.toString();
                stdout += chunk;
                if (onProgress) onProgress(chunk);
            });

            child.stderr.on('data', (data) => {
                const chunk = data.toString();
                stderr += chunk;
                if (onProgress) onProgress(chunk);
            });

            child.on('close', (code) => {
                let output = stdout || '';
                if (stderr) {
                    output += '\nStandard Error:\n' + stderr;
                }

                if (code !== 0) {
                    const msg = stderr.includes('not found') || stderr.includes('command not found')
                        ? `Command not found: ${command.split(' ')[0]}. Is it installed and in your PATH?`
                        : `Command failed with exit code ${code}`;
                    resolve({ success: false, output, error: msg });
                } else {
                    resolve({ success: true, output });
                }
            });

            child.on('error', (error) => {
                resolve({ success: false, output: stdout, error: error.message });
            });
        });
    }
}
