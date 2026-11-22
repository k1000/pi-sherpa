#!/usr/bin/env python3
"""Freeze the deterministic-selection benchmark fixture.

Provenance (read-only inputs, not shipped with the repo):
  - retrieval traces:   /Users/kamil/.pi-memory/sherpa-traces/*.jsonl
  - human evaluations:  /Users/kamil/Documents/articles/projects/kamil/wiki/evidence/sherpa-evaluations/*.md

Only fields needed for replay + scoring are kept:
  trace: bundleId, focus, mode, candidate pool (handle/type/source/relevance/summary[<=200])
  eval:  bundleId, recall, precision, missed[], noise[]

Ground truth is the human-written `missed` (should have been surfaced) and
`noise` (should not have been surfaced) frontmatter from real Sherpa
self-evaluations. It is frozen so repeated experiments compare the same data.

Usage: python3 bench/build-fixture.py
"""

import glob
import json
import os
import re

TRACE_GLOB = "/Users/kamil/.pi-memory/sherpa-traces/*.jsonl"
EVAL_DIR = "/Users/kamil/Documents/articles/projects/kamil/wiki/evidence/sherpa-evaluations"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixture.json")


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


def parse_float(value: str):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def load_traces() -> dict:
    traces = {}
    for fp in sorted(glob.glob(TRACE_GLOB)):
        for line in open(fp, encoding="utf8"):
            try:
                t = json.loads(line)
            except json.JSONDecodeError:
                continue
            if t.get("version") != 1 or not t.get("bundleId"):
                continue
            traces[t["bundleId"]] = t
    return traces


def load_evals() -> dict:
    evals = {}
    for fn in sorted(os.listdir(EVAL_DIR)):
        if not fn.endswith(".md"):
            continue
        raw = open(os.path.join(EVAL_DIR, fn), encoding="utf8", errors="replace").read()
        fm = parse_frontmatter(raw)
        if not fm:
            continue
        bundle = fm.get("bundle_id", fn[:-3])
        evals[bundle] = {
            "bundleId": bundle,
            "recall": parse_float(fm.get("recall", "")),
            "precision": parse_float(fm.get("precision", "")),
            "missed": parse_array(fm.get("missed", "")),
            "noise": parse_array(fm.get("noise", "")),
        }
    return evals


def main() -> None:
    traces = load_traces()
    evals = load_evals()
    cases = []
    for bundle, ev in sorted(evals.items()):
        t = traces.get(bundle)
        if not t:
            continue
        if not ev["missed"] and not ev["noise"]:
            continue
        pool = []
        for c in t.get("candidates", []):
            pool.append({
                "handle": c.get("handle", ""),
                "type": c.get("type", ""),
                "source": c.get("source", ""),
                "relevance": c.get("relevance", 0),
                "summary": (c.get("summary") or "")[:200],
            })
        if not pool:
            continue
        cases.append({
            "bundleId": bundle,
            "focus": t.get("focus", ""),
            "mode": t.get("mode", "front-door"),
            "pool": pool,
            "missed": ev["missed"],
            "noise": ev["noise"],
            "recall": ev["recall"],
            "precision": ev["precision"],
        })
    fixture = {
        "version": 1,
        "source": {
            "traces": TRACE_GLOB,
            "evaluations": EVAL_DIR,
        },
        "cases": cases,
    }
    with open(OUT, "w", encoding="utf8") as fh:
        json.dump(fixture, fh, ensure_ascii=False, indent=1)
    print(f"wrote {OUT}")
    print(f"cases={len(cases)} traces={len(traces)} evals={len(evals)}")
    print(f"missed_labels={sum(len(c['missed']) for c in cases)} noise_labels={sum(len(c['noise']) for c in cases)}")


if __name__ == "__main__":
    main()
