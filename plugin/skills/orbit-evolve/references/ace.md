# ACE baseline for Orbit

This is a bounded, host-driven adaptation of Agentic Context Engineering (ACE), not a reproduction
of the paper's benchmark results or a claim that Orbit runs the upstream Python trainer.

Sources checked for V2:

- [Paper](https://arxiv.org/abs/2510.04618) and [authors' project](https://ace-agent.github.io/).
- Official [ace-agent/ace snapshot](https://github.com/ace-agent/ace/tree/82709de050e1db6e6ef2f07bcb0393560b94992a),
  specifically `ace/ace.py`, `ace/core/reflector.py`, `ace/prompts/reflector.py`,
  `ace/prompts/curator.py` and `playbook_utils.py`.

The serial implementation separates generation, reflection and curation; playbook bullets have
stable IDs and helpful/harmful counters. Its executable updater supports ADD; UPDATE/MERGE/DELETE
are future operations there. Optional semantic deduplication is off by default. Orbit pins that
ADD-and-counter variant, with strict validation and case-insensitive duplicate rejection. It does not implement
the newer batched reducer, semantic pruning or arbitrary harness search. The following instructions
and helper are an independent adaptation, not copied upstream prompts/code.

Read [the shared baseline rules](baselines.md) first. Use the same evidence and budgets as bounded
notes. Limit one proposal to one exported trial's feedback so a bullet is tagged at most once per
observation. For more evidence, process a prospectively fixed sequence; charge every edit against
that round's cumulative change budget and include every used trial in lineage. Do not evaluate and
pick intermediate proposals on held-out results.

## Roles within the existing host workflow

1. **Generator:** the already evaluated parent Agent. Its valid failed evolve trajectory and
   environment feedback are the evidence; do not rerun a bespoke generator or inspect held-outs.
2. **Reflector:** before editing, record the observed failure, its plausible cause, evidence locations,
   and a general lesson. Separate observed facts from uncertainty, especially with redacted/missing
   tool arguments. For existing ACE bullets actually used in the trajectory, mark helpful, harmful,
   or neutral. Do not infer bullet use from mere presence in the prompt; no evidence means no tag.
   New bullets have no prior success credit. Request a short evidence summary, not hidden reasoning.
3. **Curator:** read that reflection and the current parent playbook. Propose only useful, general
   ADD entries in known sections; avoid advice already covered, contradictory guidance, credentials,
   answers and task-specific lookup rules. Keep old bullet content/IDs intact. If an old harmful rule
   needs deletion to make the candidate coherent, stop this ADD-only variant rather than silently
   introducing a different algorithm. Neutral-only or empty updates do not warrant evaluation.
4. **Deterministic application:** use `scripts/build-baseline.mjs` to apply validated tags/ADDs to a
   copied bundle. It retains the original instruction prefix and other files, increments existing
   helpful/harmful counters, gives new entries IDs with zero counts, and writes a managed Markdown
   playbook at the end of AGENTS.md. Counter metadata lives inside the bundle content revision,
   not an extra daemon entity or mutable external store. Keep reflection/proposal files outside it.

The same host performs reflection and curation sequentially with separate saved artifacts; there
are no newly launched agents. The subject Agent/model and all execution conditions stay fixed.
This uses failure-only exported evidence and no reference answers; upstream can also learn from
successes and use ground truth. Observe these deviations in every comparison description.

## Proposal

```json
{
  "variant": "ace",
  "parent": "/outside/current-parent",
  "out": "/outside/ace-child",
  "limits": { "changedLines": 20, "changedBytes": 8192 },
  "bulletTags": [],
  "operations": [
    {
      "type": "ADD",
      "section": "strategies_and_insights",
      "content": "Inspect current state before choosing a dependent action."
    }
  ]
}
```

The content is an illustration, not a default lesson. Sections are `strategies_and_insights`,
`formulas_and_calculations`, `code_snippets_and_templates`, `common_mistakes_to_avoid`,
`problem_solving_heuristics`, `context_clues_and_indicators`, and `others`. Content is one line.
To tag an existing observed entry, use `{"id":"ace-00001","tag":"helpful"}` in `bulletTags`;
`harmful` increments its other counter and `neutral` changes neither. Unknown IDs, duplicate tags,
unsupported operations/sections, duplicate content and malformed existing blocks fail explicitly.

The initial generic prefix is retained without adding a speculative empty playbook to the common
parent. On later accepted rounds, use that accepted bundle, preserving the block and IDs. Both
playbook headers and counters count toward the same line/whole-file byte budgets as other edits.
There is no automatic eviction or increase of the limits when the playbook fills up.

After application, resume SKILL.md at **Check, smoke and plan**. Use all actual evolve trial IDs for
`--informed-by`, the common frozen gate policy, and the existing report/lineage rules. A candidate
that passes a smoke has not demonstrated improvement. Only accept adopts it; other decisions leave
the parent, including its original playbook, intact. No new held-out inspection is authorized.
