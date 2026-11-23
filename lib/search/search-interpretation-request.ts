import { interpretationPrompt } from './search-interpretation-prompt'
import { searchPlanSchema } from './search-plan-schema'

export const SEARCH_INTERPRETATION_MODEL = 'claude-sonnet-4-6'

export function interpretationRequest(
  query: string,
  selectedNames: string[],
  kind: 'photo' | 'event',
) {
  return {
    model: SEARCH_INTERPRETATION_MODEL,
    max_tokens: 2048,
    temperature: 0,
    stream: false,
    output_config: { format: { type: 'json_schema', schema: searchPlanSchema(kind) } },
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: interpretationPrompt(query, selectedNames, kind) }],
      },
    ],
  }
}
