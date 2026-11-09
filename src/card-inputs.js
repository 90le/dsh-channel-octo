// Reviewed Octo v2 contract: openclaw-channel-octo 3cdb7e79 card-author/card-caps.
// Callback data is untrusted even after Octo authenticates the operator.
const kinds = { text: 'Input.Text', number: 'Input.Number', date: 'Input.Date', time: 'Input.Time', toggle: 'Input.Toggle', choice: 'Input.ChoiceSet' }
const own = (v) => v && typeof v === 'object' && !Array.isArray(v)
const validId = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(v)
  && !Object.hasOwn(Object.prototype, v) && v !== 'prototype'
const clean = (v, n) => typeof v === 'string' && v.trim() && Buffer.byteLength(v) <= n && !/[\x00-\x1f\x7f]/u.test(v)
const literal = v => v.replace(/[\\[\]<>]/g, '\\$&')
const fail = () => { throw new Error('invalid_card_inputs') }

export const inputSchema = {
  type: 'array', minItems: 1, maxItems: 8, items: { type: 'object', additionalProperties: false,
    properties: {
      id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$' },
      kind: { type: 'string', enum: Object.keys(kinds) }, label: { type: 'string', minLength: 1, maxLength: 100 },
      required: { type: 'boolean' }, multi: { type: 'boolean' },
      options: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'object', additionalProperties: false,
        properties: { title: { type: 'string', minLength: 1, maxLength: 100 }, value: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$',
          not: { enum: [...Object.getOwnPropertyNames(Object.prototype), 'prototype'] } } }, required: ['title', 'value'] } },
    }, required: ['id', 'kind', 'label'],
  },
}

export function cardInputs(inputs, taken = new Set()) {
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 8) fail()
  return inputs.map(input => {
    if (!own(input) || Object.keys(input).some(k => !['id', 'kind', 'label', 'required', 'multi', 'options'].includes(k))
      || !validId(input.id) || taken.has(input.id) || !Object.hasOwn(kinds, input.kind) || !clean(input.label, 100)
      || input.required !== undefined && typeof input.required !== 'boolean'
      || input.multi !== undefined && (typeof input.multi !== 'boolean' || input.kind !== 'choice')
      || input.options !== undefined && input.kind !== 'choice') fail()
    taken.add(input.id)
    const node = { type: kinds[input.kind], id: input.id, label: literal(input.label.trim()), isRequired: input.required === true }
    if (input.kind === 'text') { node.isMultiline = true; node.maxLength = 1000 }
    if (input.kind === 'toggle') Object.assign(node, { title: literal(input.label.trim()), valueOn: 'true', valueOff: 'false', value: 'false' })
    if (input.kind === 'choice') {
      const values = new Set()
      if (!Array.isArray(input.options) || !input.options.length || input.options.length > 12) fail()
      node.choices = input.options.map(option => {
        if (!own(option) || Object.keys(option).some(k => !['title', 'value'].includes(k))
          || !clean(option.title, 100) || !validId(option.value) || values.has(option.value)) fail()
        values.add(option.value)
        return { title: option.title.trim(), value: option.value }
      })
      node.style = 'expanded'; node.isMultiSelect = input.multi === true
    }
    return node
  })
}

/** Exact declared fields, real calendar values, bounded UTF-8; null means rejected. */
export function cardInputValues(specs, inputs, limits = {}) {
  if (!own(inputs)) return null
  try { cardInputs(specs) } catch { return null }
  const maxText = Math.min(limits.max_input_text_bytes ?? 4000, 4000)
  const maxTotal = Math.min(limits.max_inputs_bytes ?? 16 * 1024, 16 * 1024)
  if (![maxText, maxTotal].every(value => Number.isSafeInteger(value) && value > 0)) return null
  if (Object.keys(inputs).some(key => !specs.some(spec => spec.id === key)) || Buffer.byteLength(JSON.stringify(inputs)) > maxTotal) return null
  const values = {}
  for (const spec of specs) {
    const raw = inputs[spec.id]
    if (raw === undefined || raw === '') { if (spec.required) return null; values[spec.id] = null; continue }
    if (!['string', 'number', 'boolean'].includes(typeof raw)) return null
    const value = String(raw)
    if (Buffer.byteLength(value) > maxText || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value)) return null
    if (spec.kind === 'text') { if (spec.required && !value.trim()) return null; values[spec.id] = value }
    if (spec.kind === 'number') {
      if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value) || !Number.isFinite(Number(value))) return null
      if (Number.isInteger(Number(value)) && !Number.isSafeInteger(Number(value))) return null
      values[spec.id] = Number(value)
    }
    if (spec.kind === 'date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
      const d = new Date(value + 'T00:00:00Z')
      if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== value) return null
      values[spec.id] = value
    }
    if (spec.kind === 'time') { if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return null; values[spec.id] = value }
    if (spec.kind === 'toggle') { if (!['true', 'false'].includes(value)) return null; values[spec.id] = value === 'true' }
    if (spec.kind === 'choice') {
      const selected = spec.multi ? value.split(',') : [value]
      if (new Set(selected).size !== selected.length || selected.some(v => !spec.options.some(option => option.value === v))) return null
      values[spec.id] = spec.multi ? selected : value
    }
  }
  return values
}
