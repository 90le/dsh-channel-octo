const ownerDmOperations = new Set(['space.members.search', 'groups.create'])

/** Use the same policy at discovery and invocation. Runtime dispatch still
 * verifies live Space, route, sender, and action-specific authorization. */
export function operationAvailable(spec, { config, job, channel, toolsAllowed }) {
  const type = job.channel_type
  if (!spec?.available || ![1, 2, 5].includes(type) || !channel
    || config.toolPermission === 'text-only'
    || config.toolPermission === 'read-only' && spec.mutating
    || channel.supports?.(spec.name) === false
    || spec.requiresFiles && (!toolsAllowed || !config.allowFiles)
    || spec.requiresHostTools && !toolsAllowed
    || spec.privateOnly && type !== 1 && !(spec.sharedTopicSend && toolsAllowed)
    || spec.sharedOnly && type === 1
    || spec.ownerOnly && (!config.ownerUid || job.sender !== config.ownerUid)) return false
  if (type !== 1) return !spec.name.startsWith('voice.context.')
  return toolsAllowed && (spec.dmAvailable || spec.name === 'inspect' || spec.name.startsWith('messages.')
    || !!config.ownerUid && job.sender === config.ownerUid
      && (spec.name.startsWith('voice.context.') || ownerDmOperations.has(spec.name)))
}
