/**
 * 把迁移挂在**模块求值**上，而不是 main.js 里的一句调用。
 *
 * ESM 的求值顺序是：一个模块所有的 import 全部先求值完，才轮到模块体的第一条语句。
 * 所以在 main.js 里写 `runStorageMigration()` 是没用的——那时 `main-ipc.js` 早就跑完了，
 * 配置和工作区注册表已经按迁移前的状态读过一遍。只有做成一个 import，才能真正插进
 * `single-instance.js` 与 `main-ipc.js` 中间。
 */
import { runStorageMigration } from "./user-data-root.js";

runStorageMigration();
