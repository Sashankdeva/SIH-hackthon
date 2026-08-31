"""Completion-probe prompt — entirely separate from app/llm/prompt.py.

Two prompts, two jobs. The action prompt asks "what should happen next?"
and offers eight action types. This one asks a single yes/no question
and offers no actions at all.

That separation is the whole point. The `done` action was measured
emitting 0 times in 235 real model records — it had to compete for
attention against seven concrete actions that always looked more useful.
Asked as a standalone binary question instead, the same model answered
correctly 94.7% of the time with 0% false negatives. Nothing here
mentions an action enum, an element_id, or a browser operation, and it
must stay that way: reintroducing them reintroduces the competition.

Everything reaching this module is already sanitized — the client's
privacy firewall redacted it and validators/context_validator.py
re-checked it on arrival, exactly as for /reason. Element labels are
redaction tokens wherever the client detected something sensitive.

No rule in this prompt defines what "complete" means for any particular
kind of task, and none may be added. A rule like "a checkout is complete
when..." would be the website-specific hardcoding this design forbids —
and would not generalize to the next site.
"""

from app.models.context import SanitizedContext


def _render_history(context: SanitizedContext) -> str:
    if not context.history:
        return "  (nothing has been done yet)"
    # Chronological (step) order, not array order — see app/llm/prompt.py's
    # identical fix for why: nothing enforces the client's history list
    # arrives pre-sorted, and rendering array position as if it were
    # chronology is exactly the bug that was here.
    lines = []
    for rec in sorted(context.history, key=lambda r: r.step):
        target = f" on {rec.element_label!r}" if rec.element_label else ""
        lines.append(f"  {rec.step}. {rec.action}{target} -> {rec.outcome}")
    return "\n".join(lines)


def _render_elements(context: SanitizedContext) -> str:
    if not context.elements:
        return "  (no interactive elements)"
    lines = []
    for el in context.elements:
        line = f"  - {el.role}: {el.label!r}"
        if el.disabled:
            # Same convention as the action prompt: state it only when
            # true, so an all-enabled page renders identically to how it
            # did before availability was carried on the wire.
            line += " (disabled)"
        lines.append(line)
    return "\n".join(lines)


def _render_last_outcome(context: SanitizedContext) -> str:
    """The most recent verified outcome, taken from the last history
    entry. The client's PVM produced it; the server just reports it back
    to the model as evidence.
    """
    if not context.history:
        return "(no action has been taken)"
    # The HIGHEST step number, not the LAST array element — confirmed by
    # direct test that these can disagree (a hand-built out-of-order
    # history had array[-1] be step 2 while step 3 was the actual most
    # recent). This line answers "what just happened", so getting it
    # wrong is the one place an ordering assumption could most directly
    # skew a completion verdict.
    last = max(context.history, key=lambda r: r.step)
    return f"{last.action} -> verification: {last.outcome}"


def build_completion_prompt(context: SanitizedContext) -> str:
    """Assemble the binary completion prompt for one judgement."""
    return f"""You judge whether a user's requested task is now fully complete.

THE USER ASKED: {context.task}

Steps performed so far:
{_render_history(context)}

Most recent action: {_render_last_outcome(context)}

The page now shows: {context.page}
Interactive elements now on the page:
{_render_elements(context)}

Considering ONLY whether the user's stated task above is fully done,
answer with JSON: {{"complete": true}} or {{"complete": false}}."""

# Tried and reverted (SERVER PHASE S5): a compound-task clause-counting
# rule ("if the task has multiple parts, ALL must be done"), aimed at
# CP1 (pinned failing — see test_completion_regression_live.py) and K1
# (a new S5 three-clause case, same shape). Targeted 10x check against
# the compound category plus 12 neighboring cases (form, selection,
# navigation, semantic, clearly_complete/incomplete):
#   - CP1: FIXED, 0/10 -> 10/10.
#   - K1: unchanged, still 0/10 — the rule did not generalize to a
#     three-clause task the way it fixed the two-clause one.
#   - CP2 (the two-clause case where BOTH parts genuinely are done,
#     included specifically to test the other direction): REGRESSED,
#     10/10 -> 0/10. The model became reflexively reluctant to call any
#     compound-sounding task complete, rather than actually checking
#     whether every clause was satisfied — trading one false positive
#     for a new false negative on the mirror-image case one line below
#     it in the dataset. Every other neighboring category stayed at
#     10/10, so the damage was narrow, but real and severe within its
#     own category, and the "fix" did not demonstrate genuine clause
#     tracking (K1 disproves that). Reverted per this project's
#     standing rule: mixed results are not kept. CP1/K1 remain
#     documented, measured MODEL LIMITATIONS in the SERVER PHASE S5
#     report rather than prompt-patched.
