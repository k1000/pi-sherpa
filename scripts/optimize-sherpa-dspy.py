#!/usr/bin/env python3
"""Offline DSPy-style prompt-feedback compiler for Sherpa retrieval prompts.

This intentionally stays out of Sherpa's runtime path. It reads datasets created
by `/sherpa:dspy:export` and writes plain JSON artifacts that can be reviewed and
promoted later. It is dependency-light and does not import the DSPy package; the
artifact schema is designed so a real DSPy optimizer can replace this later.
"""
from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path
from typing import Any


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    for line in path.read_text().splitlines():
        if line.strip():
            rows.append(json.loads(line))
    return rows


def build_compiled_prompt(base_prompt: str, train: list[dict[str, Any]]) -> str:
    low = [x for x in train if float(x.get("metric", 0.5)) < 0.6]
    high = [x for x in train if float(x.get("metric", 0.5)) >= 0.8]
    hints = Counter(str(x.get("improvementHint", "")).strip() for x in low if x.get("improvementHint"))
    missed = Counter()
    noisy = Counter()
    for x in low:
        reflection = str(x.get("reflection", ""))
        for token in reflection.replace(";", ",").split(","):
            token = token.strip()
            if token.lower().startswith("miss") and len(token) < 160:
                missed[token] += 1
            if token.lower().startswith("noise") and len(token) < 160:
                noisy[token] += 1

    exemplar_lines: list[str] = []
    for x in high[:5]:
        expected = x.get("expected", {})
        sources = expected.get("selectedSources", []) if isinstance(expected, dict) else []
        if sources:
            exemplar_lines.append(f"- For `{x.get('focus', '')}` prefer: {', '.join(map(str, sources[:3]))}")

    additions = [
        "",
        "## DSPy-compiled retrieval guidance",
        "",
        "These rules were compiled from Sherpa trace/evaluation data. Treat them as task-specific tie-breakers after the core Sherpa policy.",
        "",
        "### Repeated improvement hints",
        *(f"- {hint} (seen {count}x)" for hint, count in hints.most_common(8)),
        "- Prefer exact path, symbol, and route-map matches before broad orientation docs.",
        "- Suppress candidates that merely share keywords but do not help answer the specific user request.",
        "",
        "### Successful retrieval exemplars",
        *(exemplar_lines or ["- No high-scoring exemplars were available yet; continue collecting evaluations."]),
    ]
    if missed:
        additions.extend(["", "### Common misses", *(f"- {k} ({v}x)" for k, v in missed.most_common(5))])
    if noisy:
        additions.extend(["", "### Common noise", *(f"- {k} ({v}x)" for k, v in noisy.most_common(5))])
    return base_prompt.rstrip() + "\n" + "\n".join(additions).rstrip() + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="Prepare/review Sherpa DSPy-style prompt-feedback inputs")
    parser.add_argument("--data-dir", default=".pi/sherpa/dspy", help="Directory containing train.jsonl/dev.jsonl")
    parser.add_argument("--out-dir", default=".pi/sherpa/compiled", help="Directory for compiled prompt artifacts")
    parser.add_argument("--base-prompt", default="prompts/RETRIEVAL.md", help="Baseline retrieval prompt to augment")
    parser.add_argument("--dry-run", action="store_true", help="Only summarize data; do not write artifacts")
    args = parser.parse_args()

    data_dir = Path(args.data_dir)
    out_dir = Path(args.out_dir)
    train = read_jsonl(data_dir / "train.jsonl")
    dev = read_jsonl(data_dir / "dev.jsonl")

    print(f"train={len(train)} dev={len(dev)}")
    if not train:
        print("No training data. Run /sherpa:dspy:export after collecting traces/evaluations.")
        return 1

    base_prompt_path = Path(args.base_prompt)
    base_prompt = base_prompt_path.read_text() if base_prompt_path.exists() else "You are Sherpa. Return concise, source-grounded retrieval context."
    compiled_prompt = build_compiled_prompt(base_prompt, train)

    # Keep this script dependency-light by default. If DSPy is installed, users can
    # replace the heuristic compiler below with BootstrapFewShot/MIPROv2 using the
    # exported metric while preserving the same artifact schema.
    artifact = {
        "schema": "sherpa-compiled-prompt/v1",
        "status": "prompt-feedback-compiled",
        "prompt": compiled_prompt,
        "basePrompt": str(base_prompt_path),
        "note": "Dependency-light DSPy-style prompt-feedback compiler; it does not import the dspy package. Replace with DSPy BootstrapFewShot/MIPROv2 when dspy is installed.",
        "recommended_signatures": {
            "planAndCurate": "focus, mode, sourcePlan, indicators, candidates -> selectedSources, abstain, reason",
        },
        "recommended_optimizer": "BootstrapFewShot for <50 examples; BootstrapFewShotWithRandomSearch or MIPROv2(auto='light') for larger sets",
        "dataset": {"train": len(train), "dev": len(dev)},
        "average_metric": sum(float(x.get("metric", 0.5)) for x in train) / len(train),
    }

    if args.dry_run:
        print(json.dumps(artifact, indent=2))
        return 0

    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "retrieval.prompt.json").write_text(json.dumps(artifact, indent=2) + "\n")
    print(f"wrote {out_dir / 'retrieval.prompt.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
