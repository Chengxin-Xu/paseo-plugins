const listeners = new Map<object, Set<(message: string) => void>>();
/** Host toast hooks live in components; the mounted composer icon bridges successful slash-command writes. */
export function onComposerNotice(host: object, listener: (message: string) => void) {
  const group = listeners.get(host) ?? new Set(); group.add(listener); listeners.set(host, group);
  return () => { group.delete(listener); if (!group.size) listeners.delete(host); };
}
export function showComposerNotice(host: object, message: string) {
  // Several workspace tabs can remain mounted. Display one toast on the owning host.
  [...(listeners.get(host) ?? [])].at(-1)?.(message);
}
