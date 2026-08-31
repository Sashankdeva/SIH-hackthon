"""Analysis for benchmarks/majority_vote_experiment.json.

EXPERIMENT ONLY. Computes single-call vs 3-vote metrics, classifies
each case into A/B/C/D per the stability-investigation follow-up, and
reports agreement statistics without assuming independence between the
three votes in a trial.

    cd server
    PYTHONPATH=. python -m benchmarks.majority_vote_analysis
"""

import collections
import json
import statistics
from pathlib import Path

RESULTS_DIR = Path(__file__).parent / "results"


def is_acceptable(outcome: str, acceptable: list) -> bool:
    if outcome is None or outcome.startswith("ERROR"):
        return False
    action, _, target = outcome.partition("/")
    target_val = None if target == "None" else int(target) if target.lstrip("-").isdigit() else target
    return [action, target_val] in acceptable


def classify(single_correct_rate: float, trial_majority_correct_rate: float, any_split: bool) -> str:
    """A/B/C/D per the brief.
    A: stable and correct   — single-call already right, no real split.
    B: stable and wrong     — single-call consistently wrong, voting can't help
                              if the wrong answer also wins the majority.
    C: unstable but majority correct — the useful category.
    D: unstable and majority wrong.
    """
    stable = not any_split
    if stable:
        return "A" if single_correct_rate >= 0.8 else "B"
    return "C" if trial_majority_correct_rate >= 0.8 else "D"


def analyze_action_case(entry: dict) -> dict:
    acceptable = entry["acceptable"]
    singles = entry["single"]
    trials = entry["trials"]

    single_outcomes = [s["outcome"] for s in singles]
    single_correct = [is_acceptable(o, acceptable) for o in single_outcomes]
    single_correct_rate = sum(single_correct) / len(single_correct)
    single_stable = len(set(single_outcomes)) == 1

    unanimous_trials = sum(1 for t in trials if t["unanimous"])
    split_trials = [t for t in trials if not t["unanimous"]]
    no_majority_trials = sum(1 for t in trials if not t["has_majority"])

    trial_majority_outcomes = [t["majority_outcome"] for t in trials if t["has_majority"]]
    trial_majority_correct = [is_acceptable(o, acceptable) for o in trial_majority_outcomes]
    trial_majority_correct_rate = (
        sum(trial_majority_correct) / len(trial_majority_correct) if trial_majority_correct else 0.0
    )

    # Agreement within each trial's 3 votes — the key "don't assume
    # independence" measurement. Reported as the empirical fraction of
    # vote-pairs that agree, per trial and averaged.
    pairwise_agreements = []
    for t in trials:
        keys = [tuple(v["key"]) if isinstance(v["key"], list) else v["key"] for v in t["votes"]]
        pairs = [(0, 1), (0, 2), (1, 2)]
        agree = sum(1 for i, j in pairs if keys[i] == keys[j])
        pairwise_agreements.append(agree / 3)

    any_split = len(split_trials) > 0 or not single_stable
    category = classify(single_correct_rate, trial_majority_correct_rate, any_split)

    all_single_latencies = [s["latency_ms"] for s in singles]
    all_trial_wall = [t["wall_ms"] for t in trials]
    all_trial_sum = [t["sum_ms"] for t in trials]

    return {
        "id": entry["id"], "category": entry["category"], "task": entry["task"],
        "acceptable": acceptable,
        "single_outcomes": single_outcomes,
        "single_correct_rate": round(single_correct_rate, 2),
        "single_stable": single_stable,
        "trials": len(trials),
        "unanimous_trials": unanimous_trials,
        "split_trials": len(split_trials),
        "no_majority_trials": no_majority_trials,
        "trial_majority_outcomes": trial_majority_outcomes,
        "trial_majority_correct_rate": round(trial_majority_correct_rate, 2),
        "mean_pairwise_agreement": round(statistics.mean(pairwise_agreements), 2),
        "split_detail": [
            {"trial": t["trial"], "votes": [v["outcome"] for v in t["votes"]],
             "majority": t["majority_outcome"]}
            for t in split_trials
        ],
        "classification": category,
        "single_latency_mean_ms": round(statistics.mean(all_single_latencies)),
        "vote_wall_mean_ms": round(statistics.mean(all_trial_wall)),
        "vote_sum_mean_ms": round(statistics.mean(all_trial_sum)),
    }


def analyze_completion_case(entry: dict) -> dict:
    expected = entry["expected"]
    singles = entry["single"]
    trials = entry["trials"]

    def correct(outcome):
        return outcome == str(expected)

    single_outcomes = [s["outcome"] for s in singles]
    single_correct_rate = sum(correct(o) for o in single_outcomes) / len(single_outcomes)
    single_stable = len(set(single_outcomes)) == 1

    split_trials = [t for t in trials if not t["unanimous"]]
    trial_majority_outcomes = [t["majority_outcome"] for t in trials if t["has_majority"]]
    trial_majority_correct_rate = (
        sum(correct(o) for o in trial_majority_outcomes) / len(trial_majority_outcomes)
        if trial_majority_outcomes else 0.0
    )
    any_split = len(split_trials) > 0 or not single_stable
    category = classify(single_correct_rate, trial_majority_correct_rate, any_split)

    return {
        "id": entry["id"], "task": entry["task"], "expected": expected,
        "single_outcomes": single_outcomes,
        "single_correct_rate": round(single_correct_rate, 2),
        "single_stable": single_stable,
        "split_trials": len(split_trials),
        "trial_majority_outcomes": trial_majority_outcomes,
        "trial_majority_correct_rate": round(trial_majority_correct_rate, 2),
        "classification": category,
        "single_latency_mean_ms": round(statistics.mean(s["latency_ms"] for s in singles)),
        "vote_wall_mean_ms": round(statistics.mean(t["wall_ms"] for t in trials)),
        "vote_sum_mean_ms": round(statistics.mean(t["sum_ms"] for t in trials)),
    }


def main() -> None:
    payload = json.loads((RESULTS_DIR / "majority_vote_experiment.json").read_text(encoding="utf-8"))

    analyses = [analyze_action_case(e) for e in payload["results"]]
    completion_analysis = analyze_completion_case(payload["completion_case"])

    print(f"{'id':<4}{'cat':<11}{'single stable':<14}{'single ok%':<11}"
          f"{'splits/5':<9}{'maj ok%':<9}{'pair-agree':<11}{'class'}")
    print("-" * 85)
    for a in analyses:
        print(f"{a['id']:<4}{a['category']:<11}{str(a['single_stable']):<14}"
              f"{a['single_correct_rate']*100:<11.0f}{a['split_trials']}/{a['trials']:<7}"
              f"{a['trial_majority_correct_rate']*100:<9.0f}{a['mean_pairwise_agreement']:<11}"
              f"{a['classification']}")

    print(f"\n{'ML1 (completion)':<15}single stable={completion_analysis['single_stable']} "
          f"single ok%={completion_analysis['single_correct_rate']*100:.0f} "
          f"maj ok%={completion_analysis['trial_majority_correct_rate']*100:.0f} "
          f"class={completion_analysis['classification']}")

    # ---- Non-unanimous detail, formatted as requested ----
    print("\n" + "=" * 70)
    print("NON-UNANIMOUS TRIALS — full detail")
    print("=" * 70)
    for a in analyses:
        if not a["split_detail"]:
            continue
        print(f"\n### {a['id']} — {a['task']!r} (acceptable: {a['acceptable']})")
        for d in a["split_detail"]:
            print(f"  Trial {d['trial']}:")
            for i, v in enumerate(d["votes"], 1):
                print(f"    Call {i}: {v}")
            print(f"    Majority: {d['majority'] or '(no majority — 3-way split)'}")
            print(f"    Ground truth: {a['acceptable']}")

    # ---- Classification summary ----
    counts = collections.Counter(a["classification"] for a in analyses)
    print("\n" + "=" * 70)
    print("CLASSIFICATION SUMMARY (action cases)")
    print("=" * 70)
    for k in "ABCD":
        print(f"  {k}: {counts.get(k, 0)}  "
              f"({'stable+correct' if k=='A' else 'stable+wrong' if k=='B' else 'unstable, majority correct' if k=='C' else 'unstable, majority wrong'})")

    # ---- Cost summary ----
    print("\n" + "=" * 70)
    print("COST")
    print("=" * 70)
    single_lat = [a["single_latency_mean_ms"] for a in analyses]
    wall_lat = [a["vote_wall_mean_ms"] for a in analyses]
    sum_lat = [a["vote_sum_mean_ms"] for a in analyses]
    print(f"  mean single-call latency        : {statistics.mean(single_lat):.0f} ms")
    print(f"  mean 3-vote latency (concurrent) : {statistics.mean(wall_lat):.0f} ms "
          f"(+{statistics.mean(wall_lat)-statistics.mean(single_lat):.0f} ms, "
          f"{statistics.mean(wall_lat)/statistics.mean(single_lat):.2f}x)")
    print(f"  mean 3-vote latency (sequential) : {statistics.mean(sum_lat):.0f} ms "
          f"(+{statistics.mean(sum_lat)-statistics.mean(single_lat):.0f} ms, "
          f"{statistics.mean(sum_lat)/statistics.mean(single_lat):.2f}x)")
    print("  inference calls per decision     : 1 (single) vs 3 (vote) = 3.0x")

    # ---- Selective-voting simulation: how often would a disagreement
    #      trigger actually fire, using the measured split rate itself
    #      (not a hand-picked confidence threshold) ----
    print("\n" + "=" * 70)
    print("SELECTIVE VOTING — trigger frequency (measured, not assumed)")
    print("=" * 70)
    total_trials = sum(a["trials"] for a in analyses)
    total_splits = sum(a["split_trials"] for a in analyses)
    unstable_cases = sum(1 for a in analyses if not a["single_stable"] or a["split_trials"] > 0)
    print(f"  cases with ANY observed disagreement : {unstable_cases}/{len(analyses)}")
    print(f"  trials that were non-unanimous        : {total_splits}/{total_trials} "
          f"({100*total_splits/total_trials:.1f}%)")
    print("  -> a trigger based on 'disagreement observed' cannot be evaluated")
    print("     from a SINGLE call (there's nothing to disagree with yet); a real")
    print("     selective policy needs a signal available from ONE call, e.g.")
    print("     confidence. Confidence values observed below.")
    # Pull raw confidences directly from payload for the stable vs unstable comparison.
    stable_confidences, unstable_confidences = [], []
    for entry in payload["results"]:
        confs = [s["confidence"] for s in entry["single"] if s["confidence"] is not None]
        a = next(x for x in analyses if x["id"] == entry["id"])
        (unstable_confidences if (not a["single_stable"] or a["split_trials"] > 0) else stable_confidences).extend(confs)
    if stable_confidences:
        print(f"  confidence on STABLE cases   : mean={statistics.mean(stable_confidences):.3f} "
              f"min={min(stable_confidences):.2f} max={max(stable_confidences):.2f} n={len(stable_confidences)}")
    if unstable_confidences:
        print(f"  confidence on UNSTABLE cases : mean={statistics.mean(unstable_confidences):.3f} "
              f"min={min(unstable_confidences):.2f} max={max(unstable_confidences):.2f} n={len(unstable_confidences)}")


if __name__ == "__main__":
    main()
