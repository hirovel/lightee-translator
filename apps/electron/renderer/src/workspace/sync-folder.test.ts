import { describe, expect, it } from "vitest";
import { detectSyncFolder } from "./sync-folder.js";

describe("同步盘判定", () => {
  it("认出个人版 OneDrive", () => {
    expect(detectSyncFolder("C:\\Users\\akira\\OneDrive\\轻小说")).toBe("OneDrive");
  });

  it("认出企业版 OneDrive 的「OneDrive - 公司名」目录", () => {
    expect(detectSyncFolder("C:\\Users\\akira\\OneDrive - Contoso\\书")).toBe("OneDrive");
  });

  it("认出常见的几家", () => {
    expect(detectSyncFolder("C:\\Users\\akira\\Dropbox\\书")).toBe("Dropbox");
    expect(detectSyncFolder("D:\\我的坚果云\\译稿")).toBe("坚果云");
    expect(detectSyncFolder("C:\\Users\\akira\\Google Drive\\ln")).toBe("Google Drive");
    expect(detectSyncFolder("C:\\Users\\akira\\百度网盘\\ln")).toBe("百度网盘");
  });

  it("大小写与正反斜杠都认", () => {
    expect(detectSyncFolder("c:/users/akira/DROPBOX/书")).toBe("Dropbox");
    expect(detectSyncFolder("C:/Users/akira/onedrive/书")).toBe("OneDrive");
  });

  // 误报比漏报更贵：提示一旦开始说错话，作者就会学会无视它，
  // 真正落在同步盘上的那次也一并被无视了。
  it("名字里带同步盘字样的普通本地目录不算", () => {
    expect(detectSyncFolder("D:\\OneDrive备份\\书")).toBeNull();
    expect(detectSyncFolder("D:\\我的Dropbox资料\\书")).toBeNull();
    expect(detectSyncFolder("D:\\dropbox-export\\书")).toBeNull();
  });

  it("普通本地路径返回 null", () => {
    expect(detectSyncFolder("D:\\译稿\\屋上の灯")).toBeNull();
    expect(detectSyncFolder("C:\\Users\\akira\\Documents\\ln")).toBeNull();
  });

  it("路径中间层命中也算", () => {
    expect(detectSyncFolder("C:\\Users\\akira\\Dropbox\\译稿\\2026\\屋上の灯")).toBe("Dropbox");
  });
});
