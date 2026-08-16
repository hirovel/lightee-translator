export interface VisibleWorkbenchScope {
  workspaceId: string | null;
  chapterId: string | null;
}

export interface ScopedEventSource {
  workspaceId?: string;
  chapterId?: string;
}

export function acceptsWorkspaceEvent(scope: VisibleWorkbenchScope, source: ScopedEventSource): boolean {
  return Boolean(scope.workspaceId && source.workspaceId === scope.workspaceId);
}

export function acceptsChapterEvent(scope: VisibleWorkbenchScope, source: ScopedEventSource): boolean {
  return acceptsWorkspaceEvent(scope, source) && Boolean(scope.chapterId && source.chapterId === scope.chapterId);
}

export function acceptsAgentEvent(
  scope: VisibleWorkbenchScope,
  source: ScopedEventSource & { operation?: string },
): boolean {
  if (source.workspaceId && source.workspaceId !== scope.workspaceId) return false;
  if (source.chapterId && (source.operation === "translate" || source.operation === "review")) {
    return source.chapterId === scope.chapterId;
  }
  return true;
}
