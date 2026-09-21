import {
  dshUrlHasSecretQuery,
  dshWebLaunchUrl,
} from "../../../../mv-dsh-compat/lib/obsidian.js";

/**
 * Resolve the URL an mv-agent iframe is allowed to load for a semantic
 * endpoint/launch URL.
 *
 * The result of `frameUrlFor` is the plugin-owned loopback proxy for
 * auth-gated endpoints (the browser can never carry the SameSite=Strict
 * session cookie across the cross-site frame boundary) or the endpoint
 * itself for no-auth endpoints. Two failure shapes must NEVER degrade into
 * loading the raw launch URL directly:
 *
 * 1. `frameUrlFor` missing/throwing (feature not activated yet, proxy or
 *    token exchange failed). A direct token navigation would render the SPA
 *    — index and static assets are not auth-gated upstream — while every
 *    /api request 401s: the page looks alive but cannot send anything, and
 *    the silent catch made the real error invisible.
 * 2. A resolved frame URL that still carries launch authority (`?token=`).
 *    That is always a bug: frame URLs must be tokenless.
 */
export async function resolveFrameUrlForNavigation(
  frameUrlFor: ((launchUrl: string) => Promise<string>) | undefined,
  launchUrl: string,
): Promise<string> {
  if (!frameUrlFor) {
    throw new DshFrameUrlUnavailableError("mv-agent 功能尚未就绪，无法解析 dsh 页面地址。");
  }
  const frameUrl = await frameUrlFor(launchUrl);
  if (dshUrlHasSecretQuery(frameUrl)) {
    throw new Error("解析得到的 dsh 页面地址仍携带一次性鉴权 token，拒绝直接加载。");
  }
  if (!dshWebLaunchUrl(frameUrl)) {
    throw new Error(`解析得到的 dsh 页面地址无效：${frameUrl}`);
  }
  return frameUrl;
}

/** Thrown while the dsh feature is still activating (early view restore). */
export class DshFrameUrlUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DshFrameUrlUnavailableError";
  }
}
