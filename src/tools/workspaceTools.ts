import * as vscode from 'vscode';
import { AgentTool, ToolResult } from './index';

export class SearchCodeTool implements AgentTool {
  name = 'searchCode';
  description =
    'Searches for a regex pattern across all files in the workspace using VS Code native search. Returns up to 50 match previews with file paths and line numbers.';
  schema = {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Regex or text query to search for.' },
      isRegex: {
        type: 'boolean',
        description: 'Whether the query is a regular expression. Defaults to true.',
      },
      includes: {
        type: 'string',
        description: 'Glob pattern to filter files (e.g. *.ts, src/**). Optional.',
      },
    },
    required: ['query'],
  };

  async execute(
    input: { query: string; isRegex?: boolean; includes?: string },
    _onProgress?: (data: string) => void,
  ): Promise<ToolResult> {
    try {
      if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        return { success: false, output: '', error: 'No workspace open to search.' };
      }

      const results: string[] = [];
      let matchCount = 0;
      const MAX_RESULTS = 50;

      const isReg = input.isRegex ?? true;
      const regex = new RegExp(
        isReg ? input.query : input.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        'gi',
      );

      const includeGlob = input.includes || '**/*';
      const excludeGlob = '**/{node_modules,.git,dist,out,build,.next,.nx,coverage}/**';

      const files = await vscode.workspace.findFiles(includeGlob, excludeGlob, 5000);

      const decoder = new TextDecoder('utf-8');

      for (const file of files) {
        if (matchCount >= MAX_RESULTS) break;

        try {
          const uint8array = await vscode.workspace.fs.readFile(file);
          const text = decoder.decode(uint8array);

          const lines = text.split('\n');
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            regex.lastIndex = 0;
            if (regex.test(line)) {
              if (matchCount < MAX_RESULTS) {
                const relativePath = vscode.workspace.asRelativePath(file);
                results.push(`${relativePath}:${i + 1} - ${line.trim()}`);
                matchCount++;
              } else {
                break;
              }
            }
          }
        } catch {
          // ignore unreadable files
        }
      }

      const output =
        results.length > 0
          ? `Found ${matchCount} matches${matchCount >= MAX_RESULTS ? ` (showing first ${MAX_RESULTS})` : ''}:\n${results.join('\n')}`
          : 'No matches found.';

      return {
        success: true,
        output,
      };
    } catch (err: unknown) {
      const e = err as Error;
      return { success: false, output: '', error: e.message };
    }
  }
}
