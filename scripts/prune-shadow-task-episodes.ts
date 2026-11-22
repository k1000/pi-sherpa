#!/usr/bin/env bun
/** Local-only hourly retention cleanup for private Sherpa task cards. */
import { pruneShadowTaskEpisodes } from "../lib/shadow-task-episodes";

try {
  pruneShadowTaskEpisodes();
} catch (error) {
  console.error("Sherpa shadow episode retention failed:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
