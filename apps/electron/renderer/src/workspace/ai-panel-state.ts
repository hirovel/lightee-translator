/**
 * 「模型 · 服务商」面板的纯判定（无 DOM）。
 *
 * 面板本身是 master-detail：左列选服务商、右侧一处编辑到底。渲染是直白的 DOM 拼装，
 * 唯一有分支的地方是「左列该选中谁」——选错的表现是用户刚点的服务商被弹回去。
 */

/**
 * 左列选中哪个服务商。回落顺序及其对应场景：
 *  1. `preferred` —— 用户刚点选的，最高优先；
 *  2. 当前翻译模型所属的服务商 —— 首次打开面板时停在正在用的那个；
 *  3. 第一个 —— 前两者都指向已被删除的服务商时的兜底。
 *
 * 模型 ref 形如 `provider/model`，而模型 id 本身可能含斜杠
 * （如 `siliconflow/deepseek-ai/DeepSeek-V3`），所以只取第一段。
 */
export function resolveSelectedProvider(providerIds: readonly string[], preferred: string, currentModelRef: string): string {
  if (providerIds.includes(preferred)) return preferred;
  const owner = currentModelRef.split("/")[0] ?? "";
  if (providerIds.includes(owner)) return owner;
  return providerIds[0] ?? "";
}
