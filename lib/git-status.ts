import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Return `git status --short` output for cwd, or empty string outside/unavailable git repos. */
export async function gitChanged(cwd: string): Promise<string> {
  try { const { stdout } = await execFileAsync("git", ["-C", cwd, "status", "--short"], { timeout: 1500 }); return stdout; }
  catch { return ""; }
}
