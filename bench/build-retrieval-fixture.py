#!/usr/bin/env python3
"""Freeze the candidate-generation (retrieval) benchmark fixture.

Provenance is the same traces/evaluations as bench/fixture.json, but this fixture
keeps the retrieval inputs (planner indicators + source plan) instead of the
resulting candidate pool. It exists to measure the stage that ranking cannot fix:
whether known-relevant paths are surfaced as candidates at all.

Usage: python3 bench/build-retrieval-fixture.py
"""

import glob
import json
import os
import re

TRACE_GLOB = "/Users/kamil/.pi-memory/sherpa-traces/*.jsonl"
EVAL_DIR = "/Users/kamil/Documents/articles/projects/kamil/wiki/evidence/sherpa-evaluations"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "retrieval-fixture.json")


def parse_frontmatter(raw: str) -> dict:
    m = re.match(r"^---\n(.*?)\n---", raw, re.S)
    if not m:
        return {}
    fm = {}
    for line in m.group(1).split("\n"):
        i = line.find(":")
        if i > 0:
            fm[line[:i].strip()] = line[i + 1:].strip()
    return fm


def parse_array(value: str) -> list:
    v = (value or "").strip()
    if not v:
        return []
    if v.startswith("["):
        v = v[1:]
    if v.endswith("]"):
        v = v[:-1]
    return [x.strip().strip("\"'") for x in v.split(",") if x.strip()]


def load_traces() -> dict:
    traces = {}
    for fp in sorted(glob.glob(TRACE_GLOB)):
        for line in open(fp, encoding="utf8"):
            try:
                t = json.loads(line)
            except json.JSONDecodeError:
                continue
            if t.get("version") == 1 and t.get("bundleId"):
                traces[t["bundleId"]] = t
    return traces


def main() -> None:
    traces = load_traces()
    cases = []
    for fn in sorted(os.listdir(EVAL_DIR)):
        if not fn.endswith(".md"):
            continue
        raw = open(os.path.join(EVAL_DIR, fn), encoding="utf8", errors="replace").read()
        fm = parse_frontmatter(raw)
        if not fm:
            continue
        bundle = fm.get("bundle_id", fn[:-3])
        missed = parse_array(fm.get("missed", ""))
        noise = parse_array(fm.get("noise", ""))
        if not missed and not noise:
            continue
        t = traces.get(bundle)
        if not t:
            continue
        cases.append({
            "bundleId": bundle,
            "focus": t.get("focus", ""),
            "mode": t.get("mode", "front-door"),
            "planner": (t.get("sourcePlan") or {}).get("planner", ""),
            "sourcePlan": {
                "sources": (t.get("sourcePlan") or {}).get("sources", []),
                "routePlan": (t.get("sourcePlan") or {}).get("routePlan", {}),
            },
            "indicators": (t.get("indicators") or {}).get("indicators", []),
            "missed": missed,
            "noise": noise,
        })
    fixture = {
        "version": 1,
        "kind": "retrieval-benchmark",
        "source": {"traces": TRACE_GLOB, "evaluations": EVAL_DIR},
        "cases": cases,
    }
    with open(OUT, "w", encoding="utf8") as fh:
        json.dump(fixture, fh, ensure_ascii=False, indent=1)
    print(f"wrote {OUT}")
    print(f"cases={len(cases)} missed_labels={sum(len(c['missed']) for c in cases)}")


if __name__ == "__main__":
    main()
