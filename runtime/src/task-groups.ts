// Display order only; never change saved IDs, API ordering or scan cursors.
export function groupedTasks<T extends { chatId: string; parentChatId?: string }>(items: readonly T[]): T[] {
  const byId = new Map(items.map(row => [row.chatId, row]));
  const root = (row: T) => {
    for (let i = 0; i < items.length; i++) {
      if (!row.parentChatId) return Number(row.chatId);
      const parent = byId.get(row.parentChatId);
      if (!parent) return Number(row.parentChatId);
      row = parent;
    }
    return Number(row.chatId);
  };
  return [...items].sort((a, b) => root(a) - root(b) || Number(a.chatId) - Number(b.chatId));
}
