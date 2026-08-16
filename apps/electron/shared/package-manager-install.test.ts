import { describe, expect, it } from "vitest";
import { isPackageManagerInstall } from "./package-manager-install.js";

/**
 * 这一组守的是「同一台机器上出现两份 Lightee」这个后果：Scoop 装的那份如果还
 * 自己去下载 setup.exe，安装器会往 %LOCALAPPDATA%\Programs\Lightee 再装一份。
 */
describe("isPackageManagerInstall", () => {
  it("Scoop 默认布局 → 认定为包管理器安装", () => {
    expect(isPackageManagerInstall("C:\\Users\\me\\scoop\\apps\\lightee\\0.10.0\\Lightee.exe")).toBe(true);
  });

  it("Scoop 的 current 联结点 → 同样认定", () => {
    expect(isPackageManagerInstall("C:\\Users\\me\\scoop\\apps\\lightee\\current\\Lightee.exe")).toBe(true);
  });

  it("用户改过 Scoop 根目录 → 仍靠 apps\\lightee 段认出", () => {
    expect(isPackageManagerInstall("D:\\tools\\apps\\lightee\\0.10.0\\Lightee.exe")).toBe(true);
  });

  it("NSIS 安装版 → 不是包管理器安装，自动更新照常", () => {
    expect(isPackageManagerInstall("C:\\Users\\me\\AppData\\Local\\Programs\\Lightee\\Lightee.exe")).toBe(false);
  });

  it("免安装版放在任意目录 → 不是包管理器安装", () => {
    expect(isPackageManagerInstall("D:\\下载\\Lightee-0.10.0-win-x64-portable.exe")).toBe(false);
  });

  it("路径里只是恰好含 scoop 字样 → 不误判", () => {
    expect(isPackageManagerInstall("C:\\Users\\me\\Desktop\\scoop-notes\\Lightee.exe")).toBe(false);
  });
});
