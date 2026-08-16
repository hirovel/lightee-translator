export type ExportFormat = "txt" | "md" | "epub";

export interface ExportRequest {
  workspaceId: string;
  target: string;
  format: ExportFormat;
}

export type ExportOutcome =
  | { ok: true; path: string }
  | { ok: false; message: string };

export interface ExportAdapter {
  run(request: ExportRequest): Promise<ExportOutcome>;
}

export class MemoryExportAdapter implements ExportAdapter {
  runs: ExportRequest[] = [];
  failNext = false;
  latencyMs = 0;

  async run(request: ExportRequest): Promise<ExportOutcome> {
    await sleep(this.latencyMs);
    if (this.failNext) {
      this.failNext = false;
      return { ok: false, message: "导出失败：模拟错误" };
    }
    this.runs.push({ ...request });
    return { ok: true, path: `exports/${request.target}.${request.format}` };
  }
}

export class IpcExportAdapter implements ExportAdapter {
  private readonly api: import("../../../shared/ipc-contract").LighteeApi;

  constructor() {
    if (!window.lightee) throw new Error("Lightee IPC bridge is unavailable");
    this.api = window.lightee;
  }

  async run(request: ExportRequest): Promise<ExportOutcome> {
    const result = await this.api.invoke("export.run", {
      workspaceId: request.workspaceId,
      target: request.target,
      format: request.format === "epub" ? "epub" : request.format,
    });
    if (result.ok) return { ok: true, path: "exported" };
    return { ok: false, message: result.error.message };
  }
}

export type ExportPhase = "idle" | "running" | "done" | "failed";

export class ExportController {
  private readonly adapter: ExportAdapter;
  private phase: ExportPhase = "idle";
  private readonly onStateChange?: (phase: ExportPhase, detail: string | null) => void;

  constructor(adapter: ExportAdapter, onStateChange?: (phase: ExportPhase, detail: string | null) => void) {
    this.adapter = adapter;
    this.onStateChange = onStateChange;
  }

  getPhase(): ExportPhase {
    return this.phase;
  }

  async run(request: ExportRequest): Promise<void> {
    if (this.phase === "running") return;
    this.phase = "running";
    this.onStateChange?.(this.phase, null);
    const outcome = await this.adapter.run(request);
    this.phase = outcome.ok ? "done" : "failed";
    this.onStateChange?.(this.phase, outcome.ok ? outcome.path : outcome.message);
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}
