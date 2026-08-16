/**
 * 工作区是否落在云同步文件夹里的判定（纯函数，无 DOM）。
 *
 * 工作区不是一份文档，是一组被持续读写的文件：译稿、草稿、术语快照、章节状态，
 * 编辑时每秒都在落盘。同步软件在后台按自己的节奏上传下载，两边同时写同一个文件时
 * 它按「谁的时间戳新」裁决，于是一次回灌就能把刚改好的译文换成几分钟前的版本。
 * 这种损坏没有任何报错，作者往往隔几章才发现，那时已经无从追溯。
 *
 * 判定按路径分段做全等匹配，不做子串匹配——「OneDrive备份」「我的Dropbox资料」
 * 是本地目录，只是名字里带了这几个字，误报会让提示变成噪音，噪音会让人学会无视它。
 */

interface SyncProvider {
  name: string;
  matches: (segment: string) => boolean;
}

const exact = (name: string, ...segments: string[]): SyncProvider => ({
  name,
  matches: (segment) => segments.includes(segment),
});

const PROVIDERS: SyncProvider[] = [
  // OneDrive 企业版的目录名形如「OneDrive - 公司名」，所以全等之外还认这个前缀
  { name: "OneDrive", matches: (segment) => segment === "onedrive" || segment.startsWith("onedrive - ") },
  exact("Dropbox", "dropbox"),
  exact("Google Drive", "google drive", "googledrive", "my drive", "我的云端硬盘"),
  exact("iCloud 云盘", "icloud drive", "iclouddrive", "icloud"),
  exact("坚果云", "nutstore", "坚果云", "我的坚果云"),
  exact("百度网盘", "baidunetdisk", "百度网盘"),
  exact("阿里云盘", "aliyundrive", "阿里云盘"),
  exact("微云", "weiyun", "微云"),
  exact("Seafile", "seafile"),
];

/** 命中时返回同步盘的显示名（用于提示文案），否则返回 null。 */
export function detectSyncFolder(path: string): string | null {
  for (const segment of path.split(/[\\/]/)) {
    const normalized = segment.trim().toLowerCase();
    if (!normalized) continue;
    const hit = PROVIDERS.find((provider) => provider.matches(normalized));
    if (hit) return hit.name;
  }
  return null;
}
