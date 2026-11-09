import { inputSchema } from './card-inputs.js'

export const formToolSpec = Object.freeze({
  name: 'octo_form',
  description: 'Ask the current Octo requester to fill a short form and WAIT for its answer in this same turn (up to 15 minutes). Supports text, number, date, time, toggle and single/multiple choice. Submit is not DSH tool approval or permission. No custom recipient, callbacks or action data. Use ask_user_question for ordinary questions; use this for typed forms. Never request credentials. After the answer, complete the work and provide a final response.',
  parameters: { type: 'object', additionalProperties: false, required: ['title', 'inputs', 'actions'], properties: {
    title: { type: 'string', minLength: 1, maxLength: 160 }, text: { type: 'string', minLength: 1, maxLength: 2048 },
    inputs: inputSchema,
    actions: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'object', additionalProperties: false,
      required: ['id', 'label'], properties: {
        id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$' }, label: { type: 'string', minLength: 1, maxLength: 100 },
      } } },
  } },
})
