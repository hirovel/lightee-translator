import { describe, expect, it } from "vitest";
import { mapSaveResult } from "./client";

describe("IPC save error mapping", () => {
  it("maps a stale revision to conflict instead of retry", () => {
    expect(mapSaveResult({
      ok: false,
      error: { code: "conflict", message: "stale", retryable: false },
    })).toBe("conflict");
  });

  it("maps transient failures to retryable", () => {
    expect(mapSaveResult({
      ok: false,
      error: { code: "busy", message: "pending", retryable: true },
    })).toBe("retryable");
  });

});
