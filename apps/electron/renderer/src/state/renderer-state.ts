export type RendererVariant = "dash" | "main";

export interface RendererState {
  variant: RendererVariant;
  ready: boolean;
  bootError: string | null;
}

type Listener = (state: RendererState) => void;

export function createRendererStore(initial: Partial<RendererState> = {}) {
  let state: RendererState = {
    variant: "dash",
    ready: false,
    bootError: null,
    ...initial,
  };
  const listeners = new Set<Listener>();

  return {
    get(): RendererState {
      return state;
    },
    patch(patch: Partial<RendererState>): RendererState {
      state = { ...state, ...patch };
      for (const listener of listeners) listener(state);
      return state;
    },
    subscribe(listener: Listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const rendererStore = createRendererStore();
