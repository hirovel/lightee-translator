/**
 * OAuth 登录服务（RH-11 从 `ipc-service.ts` 搬出，零行为变更）。
 *
 * 通用浏览器授权流：login 起本地回环 server 并返回授权 URL；用户在浏览器完成授权后回调
 * 携带 code 回来；wait 消费登录结果。会话生命周期与定时器卫生见 RH-08，state 闭环见 RH-18。
 */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { IpcRequestMap } from "../ipc-contract.js";
import { errorFor, failure, success, type AnyResult } from "../ipc-result.js";
import { mutateLighteeAuth, readLighteeAuth, readLighteeModels, authSecret } from "../lightee-config.js";
import type { ServiceContext } from "./service-context.js";

/** OAuth 浏览器授权流的等待上限 */
const OAUTH_LOGIN_TIMEOUT_MS = 300_000;

export class OauthService {
  constructor(private readonly ctx: ServiceContext) {}

  private get oauthSessions() { return this.ctx.oauthSessions; }
  private openExternal(url: string): Promise<boolean> { return this.ctx.openExternal(url); }

  async oauthLogin(request: IpcRequestMap["ai.oauth.login"]): Promise<AnyResult> {
    const providers = await readLighteeModels();
    const cfg = providers[request.providerId];
    if (!cfg?.oauth) return failure(errorFor("invalid_request", "该服务商未配置 OAuth（可用 API Key）", false));
    const oauth = cfg.oauth;
    // 重复 login：关掉旧 server 并清掉旧超时定时器（M-3：只 close 不 clearTimeout 会留下 5 分钟的悬挂定时器）
    this.oauthSessions.get(request.providerId)?.dispose();

    let resolveLogin: ((result: AnyResult) => void) | null = null;
    const promise = new Promise<AnyResult>((resolve) => { resolveLogin = resolve; });
    let timer: NodeJS.Timeout | null = null;
    const providerId = request.providerId;
    // RH-18 / A-6：state 必须在回调里闭环校验。回环端口对本机任意进程开放，
    // 不比对 state 就等于接受任何人塞进来的 code。
    const expectedState = randomUUID();
    /**
     * 唯一收尾出口：成功 / 失败 / 超时 / 被新会话取代都走这里——定时器与 server 一次清干净。
     * 会话条目本身**不在这里删**：`oauthWait` 可能在回调之后才被调用，需要拿到这个已完成的
     * promise。条目由 `oauthWait` 消费后删除，或被同 provider 的下一次 login 替换（dispose）。
     */
    const settle = (result?: AnyResult): void => {
      if (timer) { clearTimeout(timer); timer = null; }
      try { server.close(); } catch { /* 已关闭 */ }
      if (!resolveLogin) return;
      const resolve = resolveLogin;
      resolveLogin = null;
      resolve(result ?? success({ ok: false, providerId, message: "登录已取消" }));
    };

    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") { res.writeHead(404); res.end(); return; }
      // state 校验必须发生在任何「登录成功」的响应之前——先回 200 再拒绝，
      // 等于给攻击者一个「注入已被接受」的假象，也让用户以为自己登录成功了。
      if (url.searchParams.get("state") !== expectedState) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end("授权校验失败（state 不匹配），请回到 Lightee 重新登录。");
        settle(success({ ok: false, providerId, message: "授权校验失败（state 不匹配），请重试登录" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("登录成功，可以关闭此窗口并返回 Lightee。");
      if (!resolveLogin) { settle(); return; }
      const code = url.searchParams.get("code");
      if (!code) { settle(success({ ok: false, providerId, message: "未获得授权码" })); return; }
      try {
        const token = await exchangeOAuthToken(oauth, code, `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`);
        await mutateLighteeAuth((auth) => {
          auth[providerId] = { type: "oauth", key: token.accessToken, refreshToken: token.refreshToken, expiresAt: token.expiresAt };
          return { auth, result: undefined };
        });
        settle(success({ ok: true, providerId }));
      } catch (error) {
        settle(success({ ok: false, providerId, message: error instanceof Error ? error.message : String(error) }));
      }
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;
    const params = new URLSearchParams({ client_id: oauth.clientId, redirect_uri: redirectUri, response_type: "code", state: expectedState });
    if (oauth.scopes) params.set("scope", oauth.scopes);
    const authUrl = `${oauth.authorizeUrl}?${params.toString()}`;
    this.oauthSessions.set(providerId, {
      promise,
      server,
      dispose: () => {
        settle();
        if (this.oauthSessions.get(providerId)?.promise === promise) this.oauthSessions.delete(providerId);
      },
    });
    void this.openExternal(authUrl);
    timer = setTimeout(() => settle(success({ ok: false, providerId, message: "登录超时（5 分钟）" })), OAUTH_LOGIN_TIMEOUT_MS);
    // 超时定时器不应阻止进程退出（Electron 主进程/测试环境同理）
    timer.unref?.();
    return success({ authUrl, redirectUri, providerId });
  }
  async oauthWait(request: IpcRequestMap["ai.oauth.wait"]): Promise<AnyResult> {
    const session = this.oauthSessions.get(request.providerId);
    if (!session) return failure(errorFor("not_found", "没有进行中的 OAuth 登录", false));
    try {
      return await session.promise;
    } finally {
      // 结果已被消费 → 释放会话（server/定时器已在 settle 中清理）
      if (this.oauthSessions.get(request.providerId) === session) this.oauthSessions.delete(request.providerId);
    }
  }

  // ===== Agent LLM 调用日志（debug：完整 prompt/response，环形缓冲） =====

  async oauthRefresh(request: IpcRequestMap["ai.oauth.refresh"]): Promise<AnyResult> {
    const auth = await readLighteeAuth();
    const entry = auth[request.providerId] as Record<string, unknown> | undefined;
    const refreshToken = authSecret(entry, "refreshToken");
    if (!refreshToken) return failure(errorFor("invalid_request", "无 refresh token（请重新登录）", false));
    const providers = await readLighteeModels();
    const oauth = providers[request.providerId]?.oauth;
    if (!oauth) return failure(errorFor("invalid_request", "该服务商未配置 OAuth", false));
    try {
      // 刷新是网络调用，必须在写队列之外完成；只有合并写入进入临界区（并以队列内快照为准）。
      const token = await exchangeOAuthTokenRefresh(oauth, refreshToken);
      await mutateLighteeAuth((current) => {
        const latest = (current[request.providerId] as Record<string, unknown> | undefined) ?? entry ?? {};
        current[request.providerId] = { ...latest, type: "oauth", key: token.accessToken, refreshToken: token.refreshToken ?? refreshToken, expiresAt: token.expiresAt };
        return { auth: current, result: undefined };
      });
      return success({ ok: true, providerId: request.providerId });
    } catch (error) {
      return success({ ok: false, providerId: request.providerId, message: error instanceof Error ? error.message : String(error) });
    }
  }
}


/** OAuth 授权码换 token */
async function exchangeOAuthToken(oauth: { tokenUrl: string; clientId: string }, code: string, redirectUri: string): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: number }> {
  const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: oauth.clientId });
  const response = await fetch(oauth.tokenUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() });
  const text = await response.text();
  if (!response.ok) throw new Error(`Token 交换失败：HTTP ${response.status}${text ? " — " + text.slice(0, 140) : ""}`);
  const json = JSON.parse(text) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error("响应缺少 access_token");
  return { accessToken: json.access_token, refreshToken: json.refresh_token, expiresAt: json.expires_in ? Date.now() + json.expires_in * 1000 : undefined };
}
/** OAuth refresh_token 刷新 */
async function exchangeOAuthTokenRefresh(oauth: { tokenUrl: string; clientId: string }, refreshToken: string): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: number }> {
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: oauth.clientId });
  const response = await fetch(oauth.tokenUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() });
  const text = await response.text();
  if (!response.ok) throw new Error(`Token 刷新失败：HTTP ${response.status}${text ? " — " + text.slice(0, 140) : ""}`);
  const json = JSON.parse(text) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error("响应缺少 access_token");
  return { accessToken: json.access_token, refreshToken: json.refresh_token, expiresAt: json.expires_in ? Date.now() + json.expires_in * 1000 : undefined };
}
