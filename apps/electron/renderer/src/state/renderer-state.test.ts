import { describe, expect, it } from "vitest";
import { createRendererStore } from "./renderer-state";

describe("renderer store", () => {
  it("publishes immutable state patches to subscribers", () => {
    const store = createRendererStore();
    const seen: string[] = [];
    const unsubscribe = store.subscribe((state) => {
      seen.push(`${state.variant}:${state.ready}`);
    });

    store.patch({ variant: "main", ready: true });
    unsubscribe();
    store.patch({ bootError: "late error" });

    expect(seen).toEqual(["main:true"]);
    expect(store.get()).toMatchObject({
      variant: "main",
      ready: true,
      bootError: "late error",
    });
  });
});
