import * as vscode from 'vscode';
import { AgentTool } from '../tools';
import { CogentoTimeoutError, LLMProvider, Message } from '../providers/provider';

export interface PlanStep {
  reasoning: string;
  tool_name?: string;
  tool_input?: unknown;
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
    cancelToken: vscode.CancellationToken,
    onChunk?: (reasoningChunk: string) => void,
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
    "reasoning": "<A natural, user-facing explanation of your thought process. Do NOT mention internal JSON fields like isFinished, finalAnswer, or tool_name>",
    "tool_name": "<name of tool to call, or null>",
    "tool_input": <object containing tool arguments>,
    "isFinished": <true ONLY if the ENTIRE task is complete and NO more tools are required, otherwise false>,
    "finalAnswer": "<A final summary for the user ONLY if isFinished is true, otherwise null>"
}

CRITICAL INSTRUCTIONS:
1. Return ONLY valid JSON.
2. To apply any code changes, use \`writeFile\` (for single files) or \`writeMultipleFiles\` (for multiple files at once). Describing a change in \`reasoning\` does NOT apply it.
3. ALWAYS PREFER \`writeMultipleFiles\` over \`writeFile\` even if you are only editing 2 related files. The user prefers to approve all related changes in a single batch to avoid multiple interruptions.
4. For writing files, use \`contentLines\` (an array of strings). Do NOT include manual \`\\n\` or \`\\r\\n\` characters.
5. Do NOT wrap your response in markdown blocks like \`\`\`json.
6. If you call a tool, \`isFinished\` should be false unless it is the very last step.
7. For conversational replies, greetings, or questions that do NOT require a tool (e.g., "hello", "how are you"), you MUST set \`isFinished: true\`, \`tool_name: null\`, and put your reply in \`finalAnswer\`. NEVER leave both \`tool_name\` and \`isFinished\` as falsy/null at the same time.
8. The \`reasoning\` field is shown directly to the user in the UI. Write it naturally (e.g. "The user is asking for code examples, I will provide them..."). Never mention internal fields like "I will set isFinished to true" or "I will put the code in finalAnswer".
`;

    const input = {
      systemPrompt: prompt,
      messages: history,
    };

    let fullText = '';
    let extractedReasoning = '';
    try {
      for await (const token of this.provider.generate(input, cancelToken)) {
        fullText += token.text;

        // Try to live-parse the reasoning field for the UI if requested
        if (onChunk) {
          try {
            const reasoningMatch = fullText.match(/"reasoning"\s*:\s*"([^]*)/);
            if (reasoningMatch && reasoningMatch[1]) {
              // Extract everything up to the first unescaped quote that finishes the reasoning
              let reasoningStr = reasoningMatch[1];
              // Extremely rough extraction - but since it's just for UI preview, doesn't have to be perfect
              const endQuoteIdx = reasoningStr.search(/[^\\]"/);
              if (endQuoteIdx !== -1) {
                reasoningStr = reasoningStr.substring(0, endQuoteIdx + 1);
              }
              // Unescape basic json strings to look nice
              reasoningStr = reasoningStr.replace(/\\n/g, '\n').replace(/\\"/g, '"');

              if (reasoningStr !== extractedReasoning) {
                extractedReasoning = reasoningStr;
                onChunk(extractedReasoning);
              }
            }
          } catch {
            // Ignore live-parse errors, just wait for full parse
          }
        }
      }

      // Strip any markdown fences that some models occasionally emit despite instructions
      const cleanedText = cleanJsonText(fullText);
      const jsonString = extractOutermostJson(cleanedText);
      if (!jsonString) {
        throw new Error('No valid JSON object found in response');
      }

      const plan = JSON.parse(jsonString) as PlanStep;
      return { plan, rawText: fullText };
    } catch (err: unknown) {
      if (err instanceof CogentoTimeoutError) {
        return {
          plan: {
            reasoning: 'AI Request Timed Out',
            isFinished: true,
            finalAnswer: 'AGENT_TIMEOUT',
          },
          rawText: 'TIMEOUT',
        };
      }

      // Surface API-level errors (rate limits, auth failures, etc.) clearly
      const errMsg = (err instanceof Error ? err.message : String(err)).toLowerCase();
      if (
        errMsg.includes('429') ||
        errMsg.includes('resource_exhausted') ||
        errMsg.includes('quota')
      ) {
        return {
          plan: {
            reasoning: 'Rate limit hit',
            isFinished: true,
            finalAnswer:
              '⚠️ **Quota exhausted** for the current model. Please select a different model from the model dropdown at the bottom of the chat, then try again.',
          },
          rawText: '',
        };
      }

      let displayOutput = fullText;

      // If it looks like a JSON payload that failed to parse (typically due to API truncation),
      // let's try to extract the finalAnswer string and unescape it for a clean UI render.
      if (fullText.trim().startsWith('{')) {
        let extracted = '';
        const answerMatch = fullText.match(/"finalAnswer"\s*:\s*"([^]+)/);

        if (answerMatch) {
          extracted = answerMatch[1];
        } else {
          // Fallback to extracting just reasoning if finalAnswer is missing
          const reasoningMatch = fullText.match(/"reasoning"\s*:\s*"([^]+)/);
          if (reasoningMatch) {
            extracted = reasoningMatch[1];
            // If the reasoning block has subsequent fields like "tool_name", strip them
            const nextFieldMatch = extracted.match(/",\s*"/);
            if (nextFieldMatch && nextFieldMatch.index !== undefined) {
              extracted = extracted.substring(0, nextFieldMatch.index);
            }
          }
        }

        if (extracted) {
          // If it successfully closed, strip the trailing quote and brace
          const lastQuoteIdx = extracted.lastIndexOf('"');
          if (lastQuoteIdx > 0 && extracted.substring(lastQuoteIdx).includes('}')) {
            extracted = extracted.substring(0, lastQuoteIdx);
          } else if (extracted.endsWith('"')) {
            extracted = extracted.substring(0, extracted.length - 1);
          }
          displayOutput = extracted;
        }

        // Unescape standard JSON string escapes so Markdown renders cleanly
        displayOutput = displayOutput
          .replace(/\\n/g, '\n')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\')
          .replace(/\\t/g, '\t');
      }

      const fallback: PlanStep = {
        reasoning: 'Failed to parse',
        isFinished: true,
        finalAnswer: `⚠️ **Format Warning:** The AI encountered a formatting issue (likely an interrupted stream from the API). Recovered output:\n\n${displayOutput}`,
      };
      return { plan: fallback, rawText: '' };
    }
  }
}

/**
 * Strips markdown code fences (```json ... ```) and trims whitespace.
 * This is a safety net for models that occasionally wrap JSON in fences.
 */
function cleanJsonText(text: string): string {
  // Remove leading/trailing whitespace
  let cleaned = text.trim();
  // Strip ```json ... ``` or ``` ... ``` fences
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  return cleaned.trim();
}

/**
 * Extracts the first complete JSON object from a string using a brace-depth counter.
 * This correctly handles nested objects and arrays inside string values.
 */
function extractOutermostJson(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return text.substring(start, i + 1);
      }
    }
  }
  return null; // Incomplete JSON
}
