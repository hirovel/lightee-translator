/**
 * 文件树「当前卷」判定。
 *
 * 拆出来是因为它曾经问错了数据源：设计稿的 `syncCurrentVolume` 查的是原型演示数据
 * `BOOKS`（v01 装 ch001/ch002，v02 装 ch003…），而真实工作区的章节 id 与它毫无关系。
 * 于是只有恰好与演示数据同 id 的头两章能点亮正确的卷，第三章往后要么点亮错的卷、
 * 要么一个都不亮——「只有第一话第二话卷名才变色」正是这个形状。
 *
 * 判定必须只依据**真实工作区结构**。卷标题不可作为键：EV-01 之后合本书里
 * 「幕間」这类分节名会重复出现，只有卷 id 是唯一的。
 */
export interface VolumeLike {
  id: string;
  chapters: ReadonlyArray<{ id: string }>;
}

/** 含有该章节的卷 id；章节不存在或未指定时返回 null（调用方据此清空高亮） */
export function currentVolumeId(volumes: ReadonlyArray<VolumeLike>, chapterId: string | null | undefined): string | null {
  if (!chapterId) return null;
  for (const volume of volumes) {
    if (volume.chapters.some((chapter) => chapter.id === chapterId)) return volume.id;
  }
  return null;
}
