// Pure URL and probe compatibility helpers used by the Obsidian host. DSH
// 0.1.2 launch tokens are authority, not endpoint identity: callers may retain
// launchUrl in memory, while every comparison and persisted view state uses
// identityUrl.

const ANNOUNCEMENT = /dsh\s+web:\s*(https?:\/\/\S+)/iu;
const AUTH_REQUIRED = 'dsh web authentication required; reopen the URL printed by dsh web.';
const SECRET_QUERY_KEYS = new Set(['token', 'access_token', 'auth', 'authorization']);

function httpUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

export function dshWebIdentityUrl(raw) {
  const url = httpUrl(raw);
  if (!url) return null;
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function dshWebLaunchUrl(raw) {
  const url = httpUrl(raw);
  if (!url) return null;
  url.hash = '';
  return url.toString();
}

export function parseDshWebAnnouncement(output) {
  if (typeof output !== 'string') return null;
  const match = ANNOUNCEMENT.exec(output);
  if (!match) return null;
  const launchUrl = dshWebLaunchUrl(match[1]);
  const identityUrl = dshWebIdentityUrl(match[1]);
  if (!launchUrl || !identityUrl) return null;
  const parsed = new URL(launchUrl);
  const hasLaunchAuthority = [...parsed.searchParams.keys()].some((key) => SECRET_QUERY_KEYS.has(key.toLowerCase()));
  return Object.freeze({
    identityUrl,
    launchUrl: hasLaunchAuthority ? launchUrl : identityUrl,
    authMode: hasLaunchAuthority ? 'launch-token' : 'none',
  });
}

/**
 * Whether a URL carries launch authority (token etc.). Frame URLs must never
 * carry it: the SameSite=Strict cookie minted by the token navigation is
 * bound to the dsh origin, and the cross-site Obsidian iframe never attaches
 * it to /api requests — a direct token load yields a page that renders but
 * whose every API call fails with 401.
 */
export function dshUrlHasSecretQuery(raw) {
  const url = httpUrl(raw);
  if (!url) return false;
  for (const key of url.searchParams.keys()) {
    if (SECRET_QUERY_KEYS.has(key.toLowerCase())) return true;
  }
  return false;
}

export function redactDshWebSecrets(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/([?&](?:token|access_token|auth|authorization)=)[^&#\s)]+/giu, '$1<redacted>');
}

/**
 * Whether a probed `dsh web --help` output advertises the `--no-open` flag.
 * The flag first shipped in dsh v0.1.0-rc.8; earlier web profiles never open
 * a browser on their own, so omitting the flag there is semantically
 * identical. A missing or failed probe resolves to `true`, preserving the
 * established behavior for every runtime whose capability is unknown.
 */
export function dshWebSupportsNoOpen(helpOutput) {
  if (typeof helpOutput !== 'string' || !helpOutput) return true;
  return helpOutput.includes('--no-open');
}

export function classifyDshWebProbe(status, text) {
  if (typeof status !== 'number' || status <= 0) {
    return Object.freeze({ reachable: false, isDsh: false, authenticationRequired: false });
  }
  const body = typeof text === 'string' ? text : '';
  const authenticationRequired = status === 401 && body.includes(AUTH_REQUIRED);
  const isDsh = body.includes('__DSH_BOOT__') || authenticationRequired;
  return Object.freeze({ reachable: true, isDsh, authenticationRequired });
}
