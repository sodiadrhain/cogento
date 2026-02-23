import { LLMProvider, Message, MessagePart } from '../providers/provider';
import { AgentTool } from '../tools';
import { Planner, PlanStep } from './planner';

export type AgentEventType =
  | 'start'
  | 'reasoning'
  | 'tool_start'
  | 'tool_progress'
  | 'tool_end'
  | 'approval'
  | 'answer'
  | 'error';

export interface AgentEvent {
  type: AgentEventType;
  text: string;
  data?: any;
}

export class Agent {
  private history: Message[] = [];
  private planner: Planner;
  private isStopped: boolean = false;

  constructor(
    private provider: LLMProvider,
    private tools: AgentTool[],
    private onEvent: (event: AgentEvent) => void,
    private askApproval?: (toolName: string, toolInput: any, preInfo?: any) => Promise<boolean>,
    initialHistory?: Message[],
    private projectInsight: string = '',
  ) {
    if (initialHistory) {
      this.history = [...initialHistory];
    }
    this.planner = new Planner(provider, tools);
  }

  public stop() {
    this.isStopped = true;
  }

  public getHistory(): Message[] {
    return this.history;
  }

  async run(task: string | MessagePart[]): Promise<void> {
    this.isStopped = false; // Reset on new run
    this.history.push({ role: 'user', content: task });
    this.onEvent({ type: 'start', text: 'Received task.' });

    const systemPrompt = `You are Cogento, an autonomous AI programming agent running in VS Code. 

${this.projectInsight ? 'CONTEXT ABOUT THE CURRENT PROJECT:\n' + this.projectInsight + '\n' : ''}

GUIDELINES:
1. **Be Conversational**: In your "reasoning" field, describe what you are about to do in a way that keeps the user informed (e.g., "I'm going to create the backend folder and initialize the project...").
2. **Handle the Environment**: If a tool is missing or a command fails, don't just give up. Analyze the error. If a command like 'nest' is missing, suggest how to install it or try installing it yourself using npm.
3. **Process Management**: 
   - When running development servers or long-running processes, prefer using \`spawn\` with \`{ stdio: 'inherit' }\` or piping streams (e.g., \`.pipe(process.stdout)\`). 
   - Avoid using \`exec\` for interactive-like commands as it buffers output and can strip colors/TTY features.
4. **Non-Interactive Commands**: When using tools like 'npx', always use non-interactive flags (e.g., '-y' or '--yes') to avoid blocking on prompts.
5. **Think Step-by-Step**: Use your tools logically to satisfy the user's request. Always explain your intent before calling a tool.`;

    let isFinished = false;
    let iterations = 0;
    const maxIterations = 15;

    while (!isFinished && iterations < maxIterations) {
      if (this.isStopped) {
        this.onEvent({ type: 'error', text: 'Agent execution stopped by user.' });
        break;
      }
      iterations++;
      // Plan step
      const { plan, rawText } = await this.planner.generatePlan(this.history, systemPrompt);

      this.onEvent({ type: 'reasoning', text: plan.reasoning, data: plan });

      if (this.isStopped) break;

      if (plan.isFinished) {
        isFinished = true;
        if (plan.finalAnswer) {
          this.onEvent({ type: 'answer', text: plan.finalAnswer });
          this.history.push({ role: 'assistant', content: rawText });
        }
        break;
      }

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

        if (tool.requiresApproval) {
          if (this.askApproval) {
            let preInfo = null;
            if (tool.getPreExecutionInfo) {
              preInfo = await tool.getPreExecutionInfo(plan.tool_input);
            }

            this.onEvent({
              type: 'approval',
              text: `Waiting for user approval to run ${tool.name}...`,
              data: { toolName: tool.name, toolInput: plan.tool_input, preInfo },
            });

            const approved = await this.askApproval(tool.name, plan.tool_input, preInfo);

            if (this.isStopped) break;

            if (!approved) {
              this.onEvent({ type: 'error', text: `User denied execution of ${tool.name}.` });
              this.history.push({ role: 'assistant', content: rawText });
              this.history.push({
                role: 'system',
                content: `User DENIED execution of ${tool.name}. Explain alternative or abort.`,
              });
              continue;
            }
          } else {
            this.onEvent({
              type: 'error',
              text: `Error: Tool ${tool.name} requires approval but no approval handler is registered.`,
            });
            continue;
          }
        }

        this.onEvent({
          type: 'tool_start',
          text: `Running tool: ${plan.tool_name}`,
          data: { toolName: plan.tool_name, toolInput: plan.tool_input },
        });

        const result = await tool.execute(plan.tool_input || {}, (chunk: string) => {
          this.onEvent({ type: 'tool_progress', text: chunk, data: { toolName: plan.tool_name } });
        });

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

        // Add to history
        this.history.push({ role: 'assistant', content: rawText });
        this.history.push({
          role: 'system',
          content: `Tool Result for ${plan.tool_name}:\n${result.success ? result.output : 'Error: ' + result.error}`,
        });
      } else {
        // Agent didn't finish and didn't call a tool
        this.onEvent({ type: 'error', text: `Warning: No tool called and not finished.` });
        this.history.push({ role: 'assistant', content: rawText });
        this.history.push({
          role: 'system',
          content: `You did not call a tool and did not set isFinished to true. Please proceed.`,
        });
      }
    }

    if (iterations >= maxIterations) {
      this.onEvent({ type: 'error', text: 'Reached maximum iteration limit.' });
    }
  }
}
