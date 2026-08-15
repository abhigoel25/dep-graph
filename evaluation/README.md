# Evaluation evidence

The checked-in reports make quality claims reproducible rather than relying on terminal output.

- `github-gold.json` contains 24 hand-reviewed positive and negative cases across list, get, create, update, and misleading cross-resource relationships.
- `evaluation_report.json` evaluates the final deterministic artifact: 24/24 accuracy, 100% positive retrieval/selection recall, 100% negative rejection, complete provenance, and no dangling edges.
- `live-calibration-report.json` preserves the focused GPT-5.4 calibration result (87.5%) from before the assessment proxy budget was exhausted.

Calibration was iterative but conservative. A broader model prompt fell to 75% and was rejected. A blanket threshold change was also rejected because it discarded valid generic `data.id` and `data.number` create results. The final deterministic policy instead requires multiple independent causal signals and rejects nested or conflicting resource qualifiers. A wider audit of every recovered edge caught and removed an initially over-permissive rule before release.

```bash
npm run evaluate -- github_catalog.json dependency_graph.json evaluation_report.json
npm run evaluate:live -- github_catalog.json evaluation/github-gold.json evaluation/live-calibration-report.json
```

The live command is optional and requires configured assessment credentials; the deterministic evaluation does not.
