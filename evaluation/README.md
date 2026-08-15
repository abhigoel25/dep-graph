# Evaluation evidence

The checked-in reports make quality claims inspectable rather than relying on terminal output.

- `github-gold.json` contains 16 hand-reviewed positive and negative dataflow cases. It intentionally mixes canonical README examples, direct list/create chains, low-score generic identifiers, incidental nested identifiers, and misleading name matches.
- `evaluation_report.json` evaluates the full 893-tool GPT-5.4 graph against structural, topology, offline-overlap, and gold-set metrics.
- `live-calibration-report.json` is an opt-in focused GPT-5.4 run over the 15 unique consumer-input cases represented by the gold set.

## Calibration decision

The original conservative prompt scored 14/16 (87.5%) in both the full run and a later focused rerun: 90% positive selection recall and 83.3% negative rejection. Candidate retrieval recall was 100%, so the two misses occur at adjudication rather than retrieval.

We tested a broader prompt that explicitly emphasized selecting every valid producer and accepting generic create-result IDs. It did not recover the missed create-release edge and introduced two additional false positives, reducing accuracy to 75% and negative rejection to 50%. That experiment was rejected and the original prompt restored.

We also rejected a blanket threshold increase. Several correct create-to-consumer chains score below the offline threshold because their APIs return generic `data.id` or `data.number` fields. Raising the threshold would improve one narrow negative at the expense of general recall.

Known reviewed misses are preserved in the report:

- false negative: create release to delete release via `release_id`;
- false positive: add issue assignees to delete milestone via incidental nested `milestone_number`.

Run the deterministic report with:

```bash
npm run evaluate -- github_catalog.json dependency_graph.json evaluation_report.json
```

Run the opt-in live calibration (requires `.env`) with:

```bash
npm run evaluate:live -- github_catalog.json evaluation/github-gold.json evaluation/live-calibration-report.json
```
