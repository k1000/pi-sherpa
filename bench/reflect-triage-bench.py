#!/usr/bin/env python3
"""Offline-first reflection triage pilot. Only reviewed synthetic states may reach Jev.

Run: python3 bench/reflect-triage-bench.py --self-test
     LAYA_VENDOR_PATH=... LAYA_MODEL_PATH=... python3 bench/reflect-triage-bench.py --local
     # Hosted synthetic replay only; JEV_API_KEY required in the process environment:
     LAYA_VENDOR_PATH=... LAYA_MODEL_PATH=... python3 bench/reflect-triage-bench.py --both
This is a bounded two-question sweep, NOT a DSPy optimizer or deployment gate.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import time
import urllib.request

FIXTURE = Path(__file__).with_name("reflect-triage-fixture.json")
APPROVED_SHA256 = "d61d7078139f8be9e786d83c1777adac374955b5984d0c1642db63236611d56f"
QUESTIONS = {
    "baseline": "Does this reflection warrant investigating a reusable improvement to Sherpa or Reflect?",
    "specific": (
        "Does this reflection describe a specific, novel, evidence-backed agent workflow defect or recurring "
        "opportunity with an actionable fix worth investigating? Answer no for routine status, generic advice, "
        "already-fixed duplicates, or a single resolved transient error. This is triage, not permission to modify code."
    ),
}
SPLITS = ("train", "seen-validation", "challenge")


def approved_fixture(raw):
    return hashlib.sha256(raw).hexdigest() == APPROVED_SHA256


def load_cases():
    raw = FIXTURE.read_bytes()
    if not approved_fixture(raw):
        raise ValueError("Reviewed synthetic fixture changed: do not send content to Jev")
    fixture = json.loads(raw)
    cases = fixture["cases"]
    if fixture["version"] != "synthetic-reflect-triage-v1" or len(cases) != 28:
        raise ValueError("Unexpected fixture version or case count")
    if len({c["id"] for c in cases}) != len(cases) or any(
        c["split"] not in SPLITS or not isinstance(c["actionable"], bool) or
        not isinstance(c["state"], str) or len(c["state"]) > 600 for c in cases
    ):
        raise ValueError("Malformed synthetic fixture")
    return cases


def evaluate(cases, scores, split, threshold=0.5):
    selected = [(c, score) for c, score in zip(cases, scores) if c["split"] == split]
    if len(scores) != len(cases) or not selected or any(
        not isinstance(score, (int, float)) or not math.isfinite(score) or not 0 <= score <= 1 for _, score in selected
    ):
        raise ValueError("Missing or invalid decision scores")
    tp = fp = fn = tn = 0
    protected_misses = []
    for case, score in selected:
        predicted = score >= threshold
        gold = case["actionable"]
        tp += int(predicted and gold)
        fp += int(predicted and not gold)
        fn += int(not predicted and gold)
        tn += int(not predicted and not gold)
        if gold and not predicted and case.get("protected"):
            protected_misses.append(case["id"])
    positives = [score for c, score in selected if c["actionable"]]
    negatives = [score for c, score in selected if not c["actionable"]]
    auc = sum((p > n) + 0.5 * (p == n) for p in positives for n in negatives) / (len(positives) * len(negatives))
    return {"tp": tp, "fp": fp, "fn": fn, "tn": tn, "auc": round(auc, 3),
            "loss_2fn_1fp": 2 * fn + fp, "protected_misses": protected_misses}


def choose_train_threshold(cases, scores):
    train_scores = sorted({s for c, s in zip(cases, scores) if c["split"] == "train"})
    candidates = [0.0, 0.5, 1.0001] + [(a + b) / 2 for a, b in zip(train_scores, train_scores[1:])]
    return min(candidates, key=lambda t: (
        evaluate(cases, scores, "train", t)["loss_2fn_1fp"],
        evaluate(cases, scores, "train", t)["fn"], abs(t - 0.5), t,
    ))


def local_scores(cases):
    vendor = os.environ.get("LAYA_VENDOR_PATH")
    if vendor:
        sys.path.insert(0, vendor)
    import laya_mlx as laya
    model = os.environ.get("LAYA_MODEL_PATH")
    if not model:
        raise ValueError("Set LAYA_MODEL_PATH to a pinned local checkpoint")
    agent = laya.load(model, dtype="float16", batch_size=16)
    result = {key: [] for key in QUESTIONS}
    for case in cases:
        answers = agent.predict(case["state"], {
            key: {"type": "noul", "instructions": question} for key, question in QUESTIONS.items()
        })["answers"]
        for key in QUESTIONS:
            if answers[key].get("type") != "noul":
                raise ValueError("Unexpected Laya response")
            result[key].append(answers[key]["noul"])
    return result


def hosted_scores(cases):
    key = os.environ.get("JEV_API_KEY")
    if not key:
        raise ValueError("JEV_API_KEY required for --both")
    scores = []
    model = None
    for case in cases:
        payload = json.dumps({"model": "jev-latest", "state": case["state"], "questions": {
            "baseline": {"type": "noul", "instructions": QUESTIONS["baseline"]}
        }}).encode()
        req = urllib.request.Request("https://api.typesafe.ai/v1/systemone", data=payload, headers={
            "Authorization": f"Bearer {key}", "Content-Type": "application/json"
        })
        with urllib.request.urlopen(req, timeout=20) as response:
            data = json.load(response)
        model = data.get("model")
        answer = data["answers"]["baseline"]
        if answer.get("type") != "noul":
            raise ValueError("Unexpected Jev response")
        scores.append(answer["noul"])
    return model, scores


def self_test():
    cases = load_cases()
    assert not approved_fixture(FIXTURE.read_bytes() + b" ")
    assert [sum(c["split"] == split and c["actionable"] == label for c in cases)
            for split in SPLITS for label in (True, False)] == [4, 4, 4, 4, 6, 6]
    perfect = [float(c["actionable"]) for c in cases]
    assert evaluate(cases, perfect, "challenge")["loss_2fn_1fp"] == 0
    assert evaluate(cases, perfect, "challenge")["auc"] == 1.0
    assert choose_train_threshold(cases, perfect) == 0.5
    try:
        evaluate(cases, perfect[:-1], "challenge")
        raise AssertionError("missing score row was accepted")
    except ValueError:
        pass
    print("Reflection fixture, privacy checksum, split and scoring checks passed")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--local", action="store_true")
    parser.add_argument("--both", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    if args.local == args.both:
        parser.error("Choose exactly one of --local or --both")
    cases = load_cases()  # Check approved outbound content before either model call.
    started = time.perf_counter()
    rows = local_scores(cases)
    hosted_model = None
    if args.both:
        hosted_model, rows["jev_baseline"] = hosted_scores(cases)
    reports = {}
    for name, scores in rows.items():
        threshold = choose_train_threshold(cases, scores)
        reports[name] = {"train_selected_threshold": round(threshold, 4),
            "fixed_0.5": {split: evaluate(cases, scores, split) for split in SPLITS},
            "train_calibrated": {split: evaluate(cases, scores, split, threshold) for split in SPLITS}}
    local_winner = min(QUESTIONS, key=lambda name: (
        reports[name]["train_calibrated"]["train"]["loss_2fn_1fp"],
        name != "baseline",
    ))
    print(json.dumps({"fixture": "synthetic-reflect-triage-v1", "cases": len(cases), "hosted_model": hosted_model,
        "selected_local_prompt_on_train_only": local_winner,
        "elapsed_ms_including_load_and_network": round((time.perf_counter() - started) * 1000),
        "warning": "Synthetic author labels; 0.5 diagnostic, train-calibrated thresholds not production thresholds. "
                   "seen-validation was viewed in a prior pilot; challenge is the new holdout. No live routing changes.",
        "reports": reports}, indent=2))


if __name__ == "__main__":
    main()
