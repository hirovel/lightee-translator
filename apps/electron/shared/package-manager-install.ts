/**
 * 这一份是不是由包管理器（Scoop 等）安装的——决定自动更新归谁管。
 *
 * 不是洁癖问题。Windows 上 electron-updater 的更新方式是下载 setup.exe 再运行它，
 * 而那个安装器只认 `%LOCALAPPDATA%\Programs\Lightee`。包管理器管着的那一份原地不动，
 * 磁盘上凭空多出第二份，两份各自更新，包管理器记录的版本从此和实际运行的对不上。
 * 包管理器渠道的更新交给 `scoop update lightee`，应用自己不插手。
 *
 * 判据用可执行文件路径：Scoop 的布局固定为 `<scoop 根>\apps\<名字>\<版本>\`，
 * 用户即使改过 Scoop 根目录，`apps\lightee\` 这一段仍然在。
 */
const PACKAGE_MANAGER_PATH = /[\\/]scoop[\\/]apps[\\/]|[\\/]apps[\\/]lightee[\\/]/i;

export function isPackageManagerInstall(execPath: string): boolean {
  return PACKAGE_MANAGER_PATH.test(execPath);
}
