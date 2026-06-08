/**
 * VISION TOOL — image analysis via API.
 *
 * Tool name matches Hermes: vision_analyze.
 * Uses the same MiMo API the agents already have configured.
 */
import { readFileSync, existsSync } from 'node:fs';
import type { ToolSpec, ToolHandler, ToolResult } from '../tools.js';

const obj = (
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> => ({ type: 'object', properties, required, additionalProperties: false });

export const visionToolSpecs: ToolSpec[] = [
  {
    name: 'vision_analyze',
    description: 'Analyze an image. Accepts file path or URL.',
    parameters: obj(
      {
        image_url: { type: 'string', description: 'Image URL or local file path' },
        question: { type: 'string', description: 'Question about the image' },
      },
      ['image_url', 'question'],
    ),
  },
];

export function createVisionToolHandlers(apiKey?: string): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();

  handlers.set('vision_analyze', async (args): Promise<ToolResult> => {
    const imageUrl = args.image_url as string;
    const question = args.question as string;

    try {
      let base64Data: string;
      let mimeType = 'image/png';

      if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
        // Download image
        const response = await fetch(imageUrl, { signal: AbortSignal.timeout(15_000) });
        const buffer = await response.arrayBuffer();
        base64Data = Buffer.from(buffer).toString('base64');
        const contentType = response.headers.get('content-type');
        if (contentType) mimeType = contentType.split(';')[0]!; // split always yields ≥1 element
      } else {
        // Read local file
        const filePath = imageUrl.replace(/^file:\/\//, '');
        if (!existsSync(filePath)) {
          return { ok: false, output: '', error: `Image file not found: ${filePath}` };
        }
        const buffer = readFileSync(filePath);
        base64Data = buffer.toString('base64');
        if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) mimeType = 'image/jpeg';
        else if (filePath.endsWith('.webp')) mimeType = 'image/webp';
        else if (filePath.endsWith('.gif')) mimeType = 'image/gif';
      }

      // Call MiMo vision API
      const key = apiKey || process.env.MIMO_API_KEY;
      if (!key) {
        return { ok: false, output: '', error: 'No API key configured for vision' };
      }

      const response = await fetch('https://api.xiaomimimo.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': key,
        },
        body: JSON.stringify({
          model: 'mimo-v2.5',
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: question },
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:${mimeType};base64,${base64Data}`,
                  },
                },
              ],
            },
          ],
          max_tokens: 2048,
        }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'unknown');
        return { ok: false, output: '', error: `Vision API error ${response.status}: ${errorText.slice(0, 200)}` };
      }

      const data = await response.json() as any;
      const content = data.choices?.[0]?.message?.content ?? 'No analysis available';
      return { ok: true, output: content };
    } catch (err) {
      return { ok: false, output: '', error: `Vision failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  return handlers;
}
