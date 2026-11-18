import { StringDecoder } from "node:string_decoder";
import { parseDshWebAnnouncement } from "../../../../mv-dsh-compat/lib/obsidian.js";

type Announcement = NonNullable<ReturnType<typeof parseDshWebAnnouncement>>;
type OutputStream = "stdout" | "stderr";

/** One launch's complete announcements; an HTTP probe is not launch authority. */
export class DshLaunchReadiness {
  private readonly streams = {
    stdout: { decoder: new StringDecoder("utf8"), pending: "" },
    stderr: { decoder: new StringDecoder("utf8"), pending: "" },
  };
  private announcement: Announcement | null = null;

  push(stream: OutputStream, chunk: Buffer): Announcement | null {
    const state = this.streams[stream];
    state.pending += state.decoder.write(chunk);
    let received: Announcement | null = null;
    let end: number;
    while ((end = state.pending.indexOf("\n")) !== -1) {
      const line = state.pending.slice(0, end).replace(/\r$/u, "");
      state.pending = state.pending.slice(end + 1);
      const parsed = parseDshWebAnnouncement(line);
      if (!parsed) continue;
      // A later plain announcement must not discard an already captured token.
      if (this.announcement?.identityUrl !== parsed.identityUrl
          || this.announcement.authMode !== "launch-token"
          || parsed.authMode === "launch-token") this.announcement = parsed;
      received = this.announcement;
    }
    return received;
  }

  requiresAuthorization(authenticationRequired: boolean | undefined): boolean {
    return authenticationRequired === true || this.announcement?.authMode === "launch-token";
  }
}
