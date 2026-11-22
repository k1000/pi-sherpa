#!/usr/bin/env python3
"""Offline Laya source-choice shadow. Reads synthetic cases on stdin; never calls Sherpa or sources."""
import json
import math
import sys
import time

SOURCES = {
    "web": "Public internet for current external facts and public URLs",
    "repo_code": "Source code and tests in this local repository",
    "repo_docs": "Local repository documentation and README",
    "git": "Local git changes, status and commits",
    "project_memory": "Local Obsidian project notes and scratchpad",
    "inquirer": "Oracle-hosted Inquirer knowledge database",
    "session": "Earlier conversations and session history",
    "mixed": "Explicit comparison requiring two or more distinct sources",
}


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: laya-source-routing.py /path/to/pinned/local/checkpoint")
    import laya_mlx as laya

    cases = json.load(sys.stdin)
    started = time.perf_counter()
    agent = laya.load(sys.argv[1], dtype="float16", batch_size=16)
    load_ms = round((time.perf_counter() - started) * 1000)
    results = []
    for case in cases:
        before = time.perf_counter()
        answer = agent.predict(case["prompt"], {
            "route": {
                "type": "choice",
                "instructions": "Which evidence source does the user request? Choose mixed for explicit comparison requiring multiple sources.",
                "criteria": SOURCES,
            }
        })["answers"]["route"]
        probabilities = answer["probabilities"]
        if set(probabilities) != set(SOURCES) or any(
            not isinstance(p, (int, float)) or not math.isfinite(p) or not 0 <= p <= 1
            for p in probabilities.values()
        ) or answer["choice"] not in SOURCES:
            raise ValueError("Invalid Laya source-choice response")
        results.append({
            "id": case["id"], "choice": answer["choice"],
            "probability": probabilities[answer["choice"]],
            "elapsedMs": round((time.perf_counter() - before) * 1000, 2),
        })
    print(json.dumps({"loadMs": load_ms, "results": results}))


if __name__ == "__main__":
    main()
