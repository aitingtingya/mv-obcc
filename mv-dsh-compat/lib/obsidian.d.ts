export interface DshWebEndpoint {
  readonly identityUrl: string;
  readonly launchUrl: string;
  readonly authMode: "none" | "launch-token";
}

export interface DshWebProbeClassification {
  readonly reachable: boolean;
  readonly isDsh: boolean;
  readonly authenticationRequired: boolean;
}

export function dshWebIdentityUrl(raw: string): string | null;
export function dshWebLaunchUrl(raw: string): string | null;
export function parseDshWebAnnouncement(output: string): DshWebEndpoint | null;
export function redactDshWebSecrets<T>(value: T): T;
export function classifyDshWebProbe(status: number, text: string | null): DshWebProbeClassification;
