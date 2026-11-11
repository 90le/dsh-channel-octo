export const assistantRuntimeKeys = ['cwd', 'provider', 'model', 'reasoningEffort', 'agentPreset', 'permission', 'toolScope']
export const assistantDocKeys = ['agentsMd', 'soulMd']
export function assistantRuntime(value) {
  return Object.fromEntries(assistantRuntimeKeys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]))
}
export function assistantId(record) { return record.assistantId ?? record.id }
export function legacyAssistant(record) {
  return { id: assistantId(record), name: record.label, ...assistantRuntime(record), agentsMd: '', soulMd: '' }
}
export function validAssistantDoc(value) {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= 8192 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value)
}
