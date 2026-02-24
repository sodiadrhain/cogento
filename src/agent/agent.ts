import * as vscode from 'vscode';
import { LLMProvider, Message, MessagePart } from '../providers/provider';
import { AgentTool, ToolResult } from '../tools';
import { Planner } from './planner';

export type AgentEventType =
  | 'start'
  | 'reasoning'
  | 'thinking'
  | 'tool_start'
  | 'tool_progress'
  | 'tool_end'
  | 'approval'
  | 'approval_result'
  | 'answer'
  | 'error';

export interface AgentEvent {
  type: AgentEventType;
  text: string;
  data?: unknown;
}

export class Agent {
  public isStopped: boolean = false;
  private cts: vscode.CancellationTokenSource | null = null;
  private planner: Planner;
  private history: Message[] = [];

  constructor(
    private provider: LLMProvider,
    private tools: AgentTool[],
    private onEvent: (event: AgentEvent) => void,
    private askApproval: (
      toolName: string,
      input: unknown,
      preInfo?: unknown,
    ) => Promise<{ approved: boolean; modifiedInput?: unknown }>,
    initialHistory?: Message[],
  ) {
    this.planner = new Planner(provider, tools);
    if (initialHistory) {
      this.history = initialHistory;
    }
  }

  public stop() {
    this.isStopped = true;
    if (this.cts) {
      this.cts.cancel();
      this.cts.dispose();
      this.cts = null;
    }
  }

  public getHistory(): Message[] {
    return this.history;
  }

  async run(task: string | MessagePart[], projectInsight?: string): Promise<void> {
    this.isStopped = false; // Reset on new run
    this.cts = new vscode.CancellationTokenSource();
    this.history.push({ role: 'user', content: task });
    this.onEvent({ type: 'start', text: 'Received task.' });

    const systemPrompt = `You are Cogento, an autonomous AI programming agent running in VS Code. 
${projectInsight ? `\n${projectInsight}\n` : ''}
GUIDELINES:
1. **Be Conversational**: In your "reasoning" field, describe what you are about to do in a way that keeps the user informed (e.g., "I'm going to create the backend folder and initialize the project...").
2. **Handle the Environment**: If a tool is missing or a command fails, don't just give up. Analyze the error. If a command like 'nest' is missing, suggest how to install it or try installing it yourself using npm.
3. **Process Management**: 
   - When running development servers or long-running processes, prefer using \`spawn\` with \`{ stdio: 'inherit' }\` or piping streams (e.g., \`.pipe(process.stdout)\`). 
   - Avoid using \`exec\` for interactive-like commands as it buffers output and can strip colors/TTY features.
4. **Non-Interactive Commands**: When using tools like 'npx', always use non-interactive flags (e.g., '-y' or '--yes') to avoid blocking on prompts.
5. **Think Step-by-Step**: Use your tools logically to satisfy the user's request. Always explain your intent before calling a tool.
6. **Actions vs. Words**: Do NOT just describe what you will do. You MUST use tools like \`writeFile\` or \`runCommand\` to actually perform the work. If you say "I will update the file", you must follow that with a tool call to \`writeFile\`.
7. **Strict JSON Format**: You MUST respond with ONLY a single, valid JSON object matching the provided schema. Do NOT wrap your response in \`\`\`json markdown blocks. Do NOT add any conversational text before or after the JSON object. Failure to return raw, parseable JSON will cause a fatal system error.`;

    let isFinished = false;
    let iterations = 0;
    const maxIterations = 10; // Reduced to prevent runaway long stalls

    while (!isFinished && iterations < maxIterations) {
      // Guard: if cts was nullified by a concurrent stop() call, exit immediately
      if (this.isStopped || !this.cts || this.cts.token.isCancellationRequested) {
        this.onEvent({ type: 'error', text: 'Agent execution stopped by user.' });
        break;
      }
      iterations++;

      // Safety: Prune history to avoid Extension Host freezing on serialization
      this.pruneHistory();

      // Plan step
      this.onEvent({ type: 'thinking', text: 'Thinking...' });
      const { plan, rawText } = await this.planner.generatePlan(
        this.history,
        systemPrompt,
        this.cts?.token ?? new vscode.CancellationTokenSource().token,
        (reasoningChunk: string) => {
          if (!this.isStopped) {
            this.onEvent({ type: 'thinking', text: reasoningChunk });
          }
        },
      );

      if (this.isStopped || !this.cts || this.cts.token.isCancellationRequested) break;

      // Truncate reasoning to prevent webview/history bloat
      const reasoningLimit = 2000;
      const displayReasoning =
        plan.reasoning.length > reasoningLimit
          ? plan.reasoning.substring(0, reasoningLimit) + '...'
          : plan.reasoning;

      this.onEvent({ type: 'reasoning', text: displayReasoning, data: plan });

      if (this.isStopped) break;

      // Execute Tool
      if (plan.tool_name) {
        const tool = this.tools.find((t) => t.name === plan.tool_name);
        if (!tool) {
          const errorMsg = `Tool ${plan.tool_name} not found.`;
          this.onEvent({ type: 'error', text: errorMsg });
          this.history.push({ role: 'assistant', content: rawText });
          this.history.push({ role: 'system', content: `Tool Execution Failed: ${errorMsg}` });
          continue;
        }

        let approved = true;
        let modifiedInput: unknown = null;

        if (tool.requiresApproval) {
          this.onEvent({ type: 'approval', text: `Waiting for user approval to run ${tool.name}` });
          if (tool.getPreExecutionInfo) {
            const preInfo = await tool.getPreExecutionInfo(plan.tool_input);
            const approvalState = await this.askApproval(tool.name, plan.tool_input, preInfo);
            approved = approvalState.approved;
            if (approvalState.modifiedInput !== undefined) {
              modifiedInput = approvalState.modifiedInput;
            }
          } else {
            const approvalState = await this.askApproval(tool.name, plan.tool_input);
            approved = approvalState.approved;
            if (approvalState.modifiedInput !== undefined) {
              modifiedInput = approvalState.modifiedInput;
            }
          }
        }

        if (this.isStopped) break;

        this.onEvent({
          type: 'approval_result',
          text: approved ? 'Approved by user' : 'Denied by user',
          data: { approved },
        });

        if (!approved) {
          this.onEvent({ type: 'error', text: `User denied execution of ${tool.name}.` });
          this.history.push({ role: 'assistant', content: rawText });
          this.history.push({
            role: 'system',
            content: `User DENIED execution of ${tool.name}. Explain alternative or abort.`,
          });
          continue;
        }

        const finalInput = modifiedInput !== null ? modifiedInput : plan.tool_input;

        this.onEvent({
          type: 'tool_start',
          text: `Running tool: ${plan.tool_name}`,
          data: { toolName: plan.tool_name, toolInput: finalInput },
        });

        let result: ToolResult;
        try {
          result = await Promise.race([
            tool.execute(finalInput, (progress: string) => {
              this.onEvent({ type: 'tool_progress', text: progress });
            }),
            new Promise<ToolResult>((_, reject) => {
              if (this.cts) {
                this.cts.token.onCancellationRequested(() => {
                  reject(new Error('Tool execution cancelled.'));
                });
              }
            }),
          ]);
        } catch (err) {
          const e = err as Error;
          result = { success: false, output: '', error: e.message };
        }

        if (this.isStopped) break;

        if (result.success) {
          this.onEvent({
            type: 'tool_end',
            text: `Tool succeeded. Output length: ${result.output.length}`,
            data: result,
          });
        } else {
          this.onEvent({ type: 'error', text: `Tool failed: ${result.error}`, data: result });
        }
        // Store a compact tool turn in history instead of the full 10k JSON rawText.
        // This prevents history from ballooning and freezing the LLM on subsequent calls.
        const TOOL_TRUNCATE_LIMIT = 3000;
        const truncatedOutput =
          result.output.length > TOOL_TRUNCATE_LIMIT
            ? result.output.substring(0, TOOL_TRUNCATE_LIMIT) + '... (truncated)'
            : result.output;
        const errorText = result.error ? `Error: ${result.error}` : '';
        const compactReasoning =
          plan.reasoning.length > 500 ? plan.reasoning.substring(0, 500) + '...' : plan.reasoning;

        this.history.push({
          role: 'assistant',
          content: JSON.stringify({
            reasoning: compactReasoning,
            tool_name: plan.tool_name,
            tool_input: plan.tool_input,
          }),
        });
        this.history.push({
          role: 'system',
          content: `Tool Result for ${plan.tool_name}:\n${result.success ? truncatedOutput : errorText}`,
        });
      } else if (plan.isFinished) {
        isFinished = true;
        if (plan.finalAnswer) {
          this.onEvent({ type: 'answer', text: plan.finalAnswer });

          // Store a compact JSON in history (not plain text, not full rawText).
          // Storing plain text breaks the model's expected JSON format pattern on subsequent turns.
          // Storing full rawText (10k chars of JSON) causes history bloat and LLM freezes.
          // Compact JSON (<800 chars) keeps history small AND keeps the format consistent.
          const ANSWER_LIMIT = 800;
          const compactAnswer =
            plan.finalAnswer.length > ANSWER_LIMIT
              ? plan.finalAnswer.substring(0, ANSWER_LIMIT) + '... (truncated)'
              : plan.finalAnswer;
          const compactReasoning =
            plan.reasoning.length > 200 ? plan.reasoning.substring(0, 200) + '...' : plan.reasoning;
          this.history.push({
            role: 'assistant',
            content: JSON.stringify({
              reasoning: compactReasoning,
              tool_name: null,
              isFinished: true,
              finalAnswer: compactAnswer,
            }),
          });
        }
        break;
      } else {
        // Agent didn't finish and didn't call a tool
        this.onEvent({ type: 'error', text: `Warning: No tool called and not finished.` });
        this.history.push({
          role: 'system',
          content: `You did not call a tool and did not set isFinished to true. Please proceed correctly.`,
        });
      }
    }

    if (iterations >= maxIterations) {
      this.onEvent({ type: 'error', text: 'Reached maximum iteration limit.' });
    }
  }

  private pruneHistory() {
    // Hard limit on total characters in history to prevent serialization freeze
    const MAX_HISTORY_CHARS = 100000;
    const currentChars = this.history.reduce((sum, msg) => {
      if (typeof msg.content === 'string') return sum + msg.content.length;
      if (Array.isArray(msg.content))
        return sum + msg.content.reduce((s, p) => s + (p.text?.length || 0), 0);
      return sum;
    }, 0);

    if (currentChars > MAX_HISTORY_CHARS) {
      // More aggressive pruning: keep only first message (system/user start) and last few turns
      console.info(`Pruning history: ${currentChars} > ${MAX_HISTORY_CHARS}`);
      const systemMsg = this.history[0];
      const recentTurns = this.history.slice(-6); // Keep last 3 turns (assistant + system/user)
      this.history = [
        systemMsg,
        { role: 'system', content: '... (older history heavily pruned to maintain performance)' },
        ...recentTurns,
      ];
    }

    // Also limit by count
    if (this.history.length > 30) {
      this.history = [
        this.history[0],
        { role: 'system', content: '... (older sequence pruned)' },
        ...this.history.slice(-15),
      ];
    }
  }
}
