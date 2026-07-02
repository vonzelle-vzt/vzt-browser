// ---------------------------------------------------------------------------
// Session GIF assembly — uses ffmpeg when present on PATH, otherwise returns
// the frames directory so the user can review the JPEG trail directly.
// No GIF npm dependency by design.
// ---------------------------------------------------------------------------

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SESSIONS_DIR } from "./paths.js";

const execFileAsync = promisify(execFile);

export async function assembleGif(sessionId: string): Promise<{ gif?: string; framesDir: string; frames: number }> {
  const framesDir = join(SESSIONS_DIR, sessionId);
  if (!existsSync(framesDir)) throw new Error(`No session directory for "${sessionId}".`);
  const frames = readdirSync(framesDir).filter((f) => f.endsWith(".jpg")).length;
  if (frames === 0) return { framesDir, frames };

  try {
    await execFileAsync("ffmpeg", ["-version"]);
  } catch {
    return { framesDir, frames }; // no ffmpeg — frames only
  }

  const gif = join(framesDir, "session.gif");
  await execFileAsync("ffmpeg", [
    "-y",
    "-framerate", "1.5",
    "-pattern_type", "glob",
    "-i", join(framesDir, "*.jpg"),
    "-vf", "scale=960:-1:flags=lanczos",
    gif,
  ]);
  return { gif, framesDir, frames };
}
