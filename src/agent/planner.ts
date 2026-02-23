import { AgentTool } from '../tools';
import { LLMProvider, Message } from '../providers/provider';

export interface PlanStep {
  reasoning: string;
  tool_name?: string;
  tool_input?: any;
  isFinished?: boolean;
  finalAnswer?: string;
}

export class Planner {
  constructor(
    private provider: LLMProvider,
    private tools: AgentTool[],
  ) {}

  async generatePlan(
    history: Message[],
    systemPrompt: string,
  ): Promise<{ plan: PlanStep; rawText: string }> {
    const toolsSchema = this.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.schema,
    }));

    const prompt = `${systemPrompt}

You have access to the following tools: 
${JSON.stringify(toolsSchema, null, 2)}

Respond with a JSON object strictly matching this schema:
{
    "reasoning": "<your thought process>",
    "tool_name": "<name of tool to call, or null if finished>",
    "tool_input": <object containing tool arguments>,
    "isFinished": <true if you have fully completed the task, otherwise false>,
    "finalAnswer": "<Response to the user if finished, or null>"
}

CRITICAL INSTRUCTIONS:
1. Return ONLY valid JSON.
2. For the \`writeFile\` tool, use \`contentLines\` (an array of strings). Each string represents one line. Do NOT include manual \`\\n\` or \`\\r\\n\` characters in these strings; the tool will join them for you.
3. Do NOT wrap your response in markdown blocks like \`\`\`json.`;

    const input = {
      systemPrompt: prompt,
      messages: history,
    };

    // For MVP, we pass a dummy abort token
    const dummyToken = {
      isCancellationRequested: false,
      onCancellationRequested: () => {
        return { dispose: () => {} };
      },
    };

    let fullText = '';
    for await (const token of this.provider.generate(input, dummyToken)) {
      fullText += token.text;
    }

    try {
      // Find JSON block more robustly
      const cleanText = fullText.trim();

      // Extract the first JSON object found
      const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in response');
      }

      const jsonString = jsonMatch[0];
      const plan = JSON.parse(jsonString) as PlanStep;
      return { plan, rawText: fullText };
    } catch (e) {
      console.error('Failed to parse planner output', fullText);
      const fallback: PlanStep = {
        reasoning: 'Failed to parse',
        isFinished: true,
        finalAnswer:
          'I encountered an error planning the next step. The JSON response was invalid. Please try again.',
      };
      return { plan: fallback, rawText: fullText };
    }
  }
}
