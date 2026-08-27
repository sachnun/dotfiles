/**
 * Cline Free Models Provider
 * Native pi OAuth login (/login) via device-code flow.
 * Verified free models only (GLM 5.3 Flash is free on Cline).
 */

import type { ExtensionAPI, OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-coding-agent";

const WORKOS = "https://api.workos.com";
const CLINE = "https://api.cline.bot/api/v1";
const CID = "client_01K3A541FN8TA3EPPHTD2325AR";

async function login(cb: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const dc = await fetch(`${WORKOS}/user_management/authorize/device`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `client_id=${CID}`,
  }).then((r) => r.json()) as any;

  cb.onAuth({ url: dc.verification_uri_complete });
  await cb.onPrompt({ message: `Enter code: ${dc.user_code}`, defaultValue: dc.user_code });

  let ms = dc.interval * 1000;
  const end = Date.now() + dc.expires_in * 1000;
  while (Date.now() < end) {
    const r = await fetch(`${WORKOS}/user_management/authenticate`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=${dc.device_code}&client_id=${CID}`,
    }).then((r) => r.json()) as any;
    if (r.access_token) {
      const reg = await fetch(`${CLINE}/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessToken: r.access_token, refreshToken: r.refresh_token }),
      }).then((r) => r.json()) as any;
      return { refresh: reg.data.refreshToken, access: `workos:${reg.data.accessToken}`, expires: Date.now() + 36e5 };
    }
    if (r.error === "expired_token" || r.error === "access_denied") throw new Error(r.error);
    if (r.error === "slow_down") ms += 1000;
    await new Promise((f) => setTimeout(f, ms));
  }
  throw new Error("Timeout");
}

async function refresh(c: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials> {
  const r = await fetch(`${CLINE}/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: c.refresh, grantType: "refresh_token" }),
    signal,
  }).then((r) => r.json()) as any;
  return { refresh: r.data.refreshToken, access: `workos:${r.data.accessToken}`, expires: Date.now() + 36e5 };
}

export default function (pi: ExtensionAPI) {
  pi.registerProvider("cline", {
    baseUrl: CLINE,
    api: "openai-completions",
    headers: { "HTTP-Referer": "https://cline.bot", "X-Title": "Pi", "X-CLIENT-TYPE": "cline-sdk" },
    oauth: { name: "Cline", login, refreshToken: refresh, getApiKey: (c) => c.access },
    models: [
      { id: "z-ai/glm-5.3-flash", name: "GLM 5.3 Flash", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1048576, maxTokens: 131072 },
      { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1048576, maxTokens: 384000 },
    ],
  });
}
