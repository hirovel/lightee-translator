/**
 * 单实例守卫（RH-18 / 架构评估 A-5）。
 *
 * 第二个实例会与第一个争抢工作区锁、重复轮询 watcher、并发写工作区注册表——这些竞态
 * 在界面上表现为莫名其妙的裸错误。桌面语义是「单实例」：后启动的直接退出，把已有窗口
 * 叫到前面来。
 *
 * **为什么是单独一个模块**：ESM 的静态 import 全部先于模块体求值，所以把守卫写在
 * `main.js` 的 import 之后是没用的——`main-ipc.js` 早就跑完了（会创建服务、迁移注册表）。
 * 让 `main.js` 在所有其他 import 之前 import 本模块，才能真正抢在副作用之前判定。
 *
 * 验收脚本要并行启动多个隔离 profile 的实例，用 LIGHTEE_ALLOW_MULTI_INSTANCE=1 豁免。
 */
import { app, BrowserWindow } from "electron";

export const multiInstanceAllowed = process.env.LIGHTEE_ALLOW_MULTI_INSTANCE === "1";

if (!multiInstanceAllowed) {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    // quit() 只是请求退出，之后本模块的调用方仍会继续加载并产生副作用（注册表迁移、
    // 服务构造）。这里必须硬退出。
    process.exit(0);
  }
  app.on("second-instance", () => {
    const [existing] = BrowserWindow.getAllWindows();
    if (!existing) return;
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
  });
}
