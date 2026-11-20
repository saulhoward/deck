// Display order only; never change saved IDs, API ordering or scan cursors.
export function groupedTasks<T extends { chatId: string; parentChatId?: string; managedParentChatId?: string }>(items: readonly T[]): T[] {
  const byId = new Map(items.map(row => [row.chatId, row]));
  const root = (row: T) => {
    for (let i = 0; i < items.length; i++) {
      const parentId = row.managedParentChatId ?? row.parentChatId;
      if (!parentId) return Number(row.chatId);
      const parent = byId.get(parentId);
      if (!parent) return Number(parentId);
      row = parent;
    }
    return Number(row.chatId);
  };
  return [...items].sort((a, b) => root(a) - root(b) || Number(a.chatId) - Number(b.chatId));
}
