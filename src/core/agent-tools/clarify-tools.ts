/**
 * CLARIFY TOOL — ask the user a question mid-task.
 *
 * Tool name matches Hermes: clarify.
 * When an agent needs user input to proceed, it calls clarify with a question.
 * The question is surfaced to the user and the response is returned.
 *
 * In HTTP mode: the question is returned in the response, and the user answers
 * in the next /chat message.
 * In CLI mode: the question is printed to stdout and the agent waits for input.
 */

import type { ToolSpec, ToolHandler, ToolResult } from '../tools.js';

const obj = (
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> => ({ type: 'object', properties, required, additionalProperties: false });

export const clarifyToolSpecs: ToolSpec[] = [
  {
    name: 'clarify',
    description: 'Ask the user a question when you need clarification, feedback, or a decision before proceeding. Supports multiple choice or open-ended questions.',
    parameters: obj(
      {
        question: { type: 'string', description: 'The question to present to the user' },
        choices: {
          type: 'array',
          items: { type: 'string' },
          description: 'Up to 4 answer choices for multiple choice. Omit for open-ended.',
        },
      },
      ['question'],
    ),
  },
];

export function createClarifyToolHandlers(): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();

  handlers.set('clarify', async (args): Promise<ToolResult> => {
    const question = args.question as string;
    const choices = args.choices as string[] | undefined;

    let prompt = `[CLARIFICATION NEEDED]\n${question}`;
    if (choices && choices.length > 0) {
      prompt += '\n\nOptions:';
      choices.forEach((c, i) => {
        prompt += `\n  ${i + 1}. ${c}`;
      });
      prompt += '\n\nPlease respond with the number of your choice or type your own answer.';
    }

    // In HTTP mode, this gets returned to the user as part of the response
    // The next user message is treated as the answer
    return {
      ok: true,
      output: prompt,
    };
  });

  return handlers;
}
