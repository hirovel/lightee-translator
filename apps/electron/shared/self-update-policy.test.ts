import { describe, expect, it } from "vitest";
import { evaluateSelfUpdate } from "./self-update-policy.js";

const NSIS_EXEC = "C:\\Users\\me\\AppData\\Local\\Programs\\Lightee\\Lightee.exe";

describe("evaluateSelfUpdate", () => {
  it("开发模式（未打包）→ 跳过，原因 not-packaged", () => {
    expect(evaluateSelfUpdate({ isPackaged: false, env: {}, execPath: NSIS_EXEC })).toEqual({
      update: false,
      reason: "not-packaged",
    });
  });

  it("LIGHTEE_DISABLE_UPDATES=1 → 跳过，原因 disabled-by-env", () => {
    expect(
      evaluateSelfUpdate({ isPackaged: true, env: { LIGHTEE_DISABLE_UPDATES: "1" }, execPath: NSIS_EXEC }),
    ).toEqual({ update: false, reason: "disabled-by-env" });
  });

  it("LIGHTEE_DISABLE_UPDATES 设成其他值（非 '1'）→ 不触发跳过", () => {
    const decision = evaluateSelfUpdate({
      isPackaged: true,
      env: { LIGHTEE_DISABLE_UPDATES: "true" },
      execPath: NSIS_EXEC,
    });
    expect(decision.update).toBe(true);
  });

  it("portable 版（PORTABLE_EXECUTABLE_DIR 存在）→ 跳过，原因 portable-build", () => {
    expect(
      evaluateSelfUpdate({
        isPackaged: true,
        env: { PORTABLE_EXECUTABLE_DIR: "D:\\下载" },
        execPath: "D:\\下载\\Lightee-0.10.0-win-x64-portable.exe",
      }),
    ).toEqual({ update: false, reason: "portable-build" });
  });

  it("Scoop 安装 → 跳过，原因 package-manager-install", () => {
    expect(
      evaluateSelfUpdate({
        isPackaged: true,
        env: {},
        execPath: "C:\\Users\\me\\scoop\\apps\\lightee\\0.10.0\\Lightee.exe",
      }),
    ).toEqual({ update: false, reason: "package-manager-install" });
  });

  it("NSIS 安装版、打包、无豁免环境变量 → 允许更新", () => {
    expect(evaluateSelfUpdate({ isPackaged: true, env: {}, execPath: NSIS_EXEC })).toEqual({ update: true });
  });

  it("四条跳过路径都不命中时才允许更新——顺序不影响结果", () => {
    const decision = evaluateSelfUpdate({
      isPackaged: true,
      env: { SOME_OTHER_VAR: "1" },
      execPath: NSIS_EXEC,
    });
    expect(decision).toEqual({ update: true });
  });
});
