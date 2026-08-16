/**
 * IPC 结果构造与错误载体（RH-11 从 `ipc-service.ts` 提取，零行为变更）。
 *
 * 提出来是因为 `services/*` 全都要用它们，而服务不能反向 import `ipc-service.ts`
 * （那会形成循环依赖）。本模块只依赖契约类型，不依赖任何服务。
 */
import type { IpcError, IpcResult, JsonValue } from "./ipc-contract.js";

export type AnyResult = IpcResult<unknown>;

export const errorFor = (
  code: IpcError["code"],
  message: string,
  retryable = false,
  details?: JsonValue,
): IpcError => ({ code, message, retryable, details });

export const success = <T>(value: T): IpcResult<T> => ({ ok: true, value });
export const failure = <T = never>(error: IpcError): IpcResult<T> => ({ ok: false, error });

/** 抛出即返回 `failure(ipcError)`：让深层代码不必层层回传 result */
export class ServiceError extends Error {
  constructor(readonly ipcError: IpcError) {
    super(ipcError.message);
  }
}
