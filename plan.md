# Tool Dependency Graph Generator: Engineering Plan

## 1. Purpose

Build a catalog-driven generator that discovers meaningful precursor relationships between tools. Given any Composio-style toolkit catalog, the program will write a `dependency_graph.json` whose edges explain which producer action can supply a required field for which consumer action.

The primary objective is not maximum edge count or superficial feature completion. It is a defensible, general, observable inference system whose output quality can be measured and explained. The implementation should make it easy for a reviewer to answer:

- Why does this edge exist?
- Why was a tempting but incorrect edge omitted?
- Does the generator work on a catalog it has never seen?
- What happens when schemas are incomplete, deeply nested, or ambiguous?
- How do deterministic analysis and model reasoning complement one another?
- Can the result be reproduced, inspected, and tested?

## 2. Requirements distilled from the assessment

### Required behavior

- Accept the toolkit catalog path as a command-line argument.
- Read the supplied catalog at runtime; never hard-code GitHub slugs or a fixed graph.
- Support the catalog as either a top-level list or a supported object wrapper.
- Write `dependency_graph.json` at the repository root.
- Emit nodes using actual Composio tool slugs from the input catalog.
- Emit directed edges in producer-to-consumer order.
- Label each edge with the consumer field supplied by the producer.
- Declare installation/build and execution commands in `generator.json`.
- Use Node.js/TypeScript with `tsx`; do not depend on Bun.
- Include the supplied GitHub catalog.
- Include a visualization in which nodes and edges can be inspected.

### Quality expectations inferred from the brief

- Prefer precise, useful dependencies over a dense graph of name matches.
- Generalize across toolkits and schema styles.
- Handle multiple valid producers for one required field.
- Distinguish tool-producible values from values usually supplied by the user.
- Use the assessment model credentials where they add semantic value.
- Remain useful if the model endpoint is unavailable or returns invalid output.
- Commit frequently in cohesive increments and retain a professional history.
- Prepare enough evidence to explain architectural decisions in the video walkthrough.

### Canonical acceptance examples

At minimum, the generated GitHub graph should support the relationships described by the assessment:

1. `GITHUB_LIST_REPOSITORY_ISSUES -> GITHUB_CREATE_AN_ISSUE_COMMENT`, labeled `issue_number`.
2. `GITHUB_LIST_PULL_REQUESTS -> GITHUB_MERGE_A_PULL_REQUEST`, labeled `pull_number`.

These are acceptance checks, not special cases. They must emerge from the same catalog/schema inference used for every other toolkit.

## 3. Guiding engineering principles

### Evidence before guesses

Every candidate relationship will originate from observable catalog evidence: a required consumer input, a producer output, compatible entity context, and compatible field semantics. Model reasoning may adjudicate that evidence, but it may not invent nodes or fields.

### Precision before density

A graph with thousands of syntactically plausible but operationally false edges is worse than a smaller graph that an agent can safely act on. The system will rank candidates, cap broad ambiguous matches, and abstain when evidence is weak.

### Generalization before GitHub-specific tuning

The GitHub catalog is the principal real-world fixture, not the architecture. Rules will be expressed in terms of JSON Schema, field normalization, entity concepts, operation roles, and evidence scores. Any GitHub-specific observation must be converted into a toolkit-independent rule or kept only as an evaluation assertion.

### Determinism around probabilistic reasoning

Parsing, schema traversal, candidate retrieval, validation, de-duplication, ordering, and graph serialization will be deterministic. The model operates only within a bounded candidate set and returns structured selections. The final output is sanitized by code.

### Graceful degradation

Model access improves semantic precision, but it must not be a single point of failure. Missing credentials, timeouts, rate limits, malformed responses, or partial batch failures will fall back to high-confidence deterministic edges and produce useful diagnostics.

### Explainability without compromising the required graph contract

`dependency_graph.json` will retain the simple required `nodes`/`edges` shape. Rich evidence, confidence, rejection reasons, run statistics, and model/fallback status will live in a separate diagnostic report so strict graders are not exposed to an experimental schema.

## 4. Proposed architecture: an evidence-carrying inference pipeline

```text
catalog JSON
    |
    v
Catalog loader and validator
    |
    v
Normalized tool intermediate representation
    |                         |
    |                         +--> node builder
    v
Recursive JSON Schema indexer
    |
    +--> required consumer fields
    +--> producer output fields and paths
    v
Candidate retriever
    |
    +--> lexical/shape compatibility
    +--> entity-context compatibility
    +--> operation-role and scope priors
    +--> negative controls / ambiguity penalties
    v
Bounded candidate evidence ledger
    |                         |
    | credentials available  | unavailable/failure
    v                         v
Model adjudicator       deterministic threshold
    |                         |
    +------------+------------+
                 v
Graph integrity firewall
                 |
       +---------+----------+
       v                    v
dependency_graph.json   inference_report.json
       |
       v
interactive visualization
```

### 4.1 Catalog loader and validator

Responsibilities:

- Resolve and read the CLI path safely.
- Parse JSON with actionable errors for missing paths, invalid JSON, or unsupported shapes.
- Accept a top-level array and common `{ "tools": [...] }` / `{ "items": [...] }` wrappers.
- Validate each usable tool has a non-empty slug from `slug`, `name`, or `function.name` in that precedence order.
- Normalize duplicate slugs deterministically, preferring a non-deprecated/current representation while reporting duplicates.
- Ignore malformed individual entries only when continuing is safe; fail if no usable tools remain.
- Never log the catalog contents or environment secrets unnecessarily.

### 4.2 Normalized tool intermediate representation

Raw catalog formats vary. A small internal representation will isolate inference from format differences:

```ts
interface NormalizedTool {
  slug: string;
  name: string;
  description: string;
  tags: string[];
  toolkit?: string;
  deprecated: boolean;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
}
```

Normalization creates a stable boundary for unit tests and future toolkit formats. Nodes will be constructed directly from this representation, with `service` derived from toolkit metadata or stable semantic tags only when the value is trustworthy.

### 4.3 Recursive JSON Schema indexer

The catalog uses nested objects, arrays, wrappers, and local `$ref` definitions. A schema walker will:

- Resolve local `#/$defs/...` and `#/definitions/...` references.
- Traverse objects, arrays, `allOf`, `anyOf`, and `oneOf`.
- Preserve the full property path and containing schema titles/descriptions.
- Track visited references to stop recursive cycles.
- Mark whether an input is required at the relevant object level.
- Suppress generic response-wrapper fields such as `successful`, `error`, and wrapper `data` while retaining meaningful descendants.
- Produce compact `FieldEvidence` records containing raw name, normalized name, type, path, description, entity terms, and required status.

This is a core source of depth: dependencies often appear as `issue_number` on input but as `data.issues[].number` in output. Comparing only top-level property names would miss the assessment's canonical relationships.

### 4.4 Field and entity normalization

Normalization will separate syntax matching from semantic context:

- Convert camelCase, PascalCase, kebab-case, and spaces to normalized snake-case tokens.
- Singularize conservative entity plurals (`issues` to `issue`) without relying on aggressive linguistic guesses.
- Distinguish generic identity tokens (`id`, `number`, `name`, `sha`, `ref`, `url`) from entity tokens (`issue`, `pull_request`, `workflow`, `release`).
- Extract entity terms from field names, property paths, schema titles, field descriptions, tool names, slugs, and semantic tags.
- Recognize compatible identifier shapes such as entity-qualified input `pull_number` and nested producer output `pull_requests[].number`.
- Require stronger context for generic fields like `id` than for distinctive fields like `migration_id`.

Normalization is intentionally conservative. A small transparent synonym table may cover universal schema concepts (for example `identifier`/`id`), but not GitHub tool names.

### 4.5 Candidate retrieval and scoring

Comparing every input with every output is both noisy and expensive. Candidate retrieval will use a weighted evidence score:

| Evidence | Intent |
| --- | --- |
| Exact normalized field match | Strong structural evidence |
| Entity-qualified input matches generic nested output | Handles `issue_number` -> `issues[].number` |
| Compatible JSON types | Rejects obvious shape mismatches |
| Entity overlap across path/tool/tag/description | Disambiguates generic `id` and `number` |
| Producer operation retrieves, lists, searches, gets, or creates the entity | Favors operationally plausible producers |
| Consumer requires the field | Focuses on true prerequisites |
| Scope/context inputs overlap | Favors tools operating in the same repository/org/project context |
| Same tool, deprecated producer, generic wrapper field, or contradictory entity | Penalty or rejection |

The retriever will retain only a small top-K set per required consumer input. Scores and evidence features will be preserved in an internal ledger. This improves model focus, controls cost, and makes rejected edges auditable.

Candidate generation will include both discovery actions and creation actions. A newly created resource can legitimately produce an identifier required by a later action, while list/get/search actions often discover existing identifiers.

### 4.6 User-supplied versus tool-producible fields

Not every required input implies a precursor tool. Content fields (`body`, `title`, `message`), credentials, free-form queries, and common context locators (`owner`, repository name) are often expected from the user or current execution context.

Rather than using a single hard-coded denylist, the system will combine:

- identity-likeness of the field;
- evidence that a producer actually exposes the value;
- entity/context compatibility;
- ambiguity of the candidate set;
- model adjudication when available.

Negative tests will ensure common values do not turn into high-degree false-positive hubs.

### 4.7 Model adjudicator using Litmus credentials

The assessment-provided OpenAI-compatible endpoint will be used through environment variables only:

- `OPENAI_API_KEY` — required for online adjudication;
- `OPENAI_BASE_URL` — assessment proxy URL;
- `DEPENDENCY_GRAPH_MODEL` — optional model override;
- a documented default such as `openai/gpt-4o`.

No key will appear in source, tests, commits, diagnostics, or generated HTML.

The model will receive compact batches of candidate cases, not the entire eight-megabyte catalog. Each case contains:

- the consumer slug and intent;
- one required input and its schema evidence;
- a short ranked list of candidate producer slugs;
- relevant producer output paths/descriptions;
- instructions to select zero, one, or multiple producers and to abstain when uncertain.

The response will use a strict JSON shape. Programmatic validation will enforce:

- selected producer and consumer slugs exist in the input catalog;
- the selected label is exactly the presented required input;
- selections came from the supplied candidate set;
- no self-edge or duplicate edge is introduced;
- no prose or invented identifiers enter the graph.

Operational controls:

- bounded batch size and concurrency;
- request timeouts;
- exponential backoff with jitter for transient errors;
- limited retries;
- deterministic ordering before and after requests;
- per-batch fallback so one failure does not discard the run;
- token-conscious compact prompts;
- optional local cache keyed by catalog hash, model, prompt version, and candidate content;
- run summary that reports online, mixed, or offline mode without exposing credentials.

The model is an evidence adjudicator, not an unconstrained graph author. This “hallucination firewall” is a central architectural choice.

### 4.8 Deterministic fallback

When model adjudication is unavailable, candidates above a deliberately high confidence threshold will be emitted. Ambiguous generic identifiers will require an entity-context margin over the next candidate or will be omitted. The fallback should produce both canonical assessment edges from schema evidence alone.

This path will be tested as a first-class mode, not treated as an error branch.

### 4.9 Graph assembly and integrity firewall

Before writing output, graph validation will guarantee:

- every node ID is a real normalized catalog slug;
- every edge endpoint exists in `nodes`;
- every edge label is a required input on its consumer;
- no self-edges;
- no exact duplicates;
- stable lexical ordering for reproducible diffs;
- one node per unique slug;
- the graph object contains the required arrays even for a catalog with no inferred edges.

Serialization will be atomic where practical: write a temporary file in the destination directory and rename it only after validation succeeds, preventing a failed run from leaving truncated JSON.

### 4.10 Explainability report

An optional `inference_report.json` will record run-level evidence without changing the grader-facing graph schema:

- catalog hash, tool count, active/deprecated counts, and schema coverage;
- inference mode and model identifier (never the key);
- counts of required inputs, indexed outputs, candidates, accepted edges, rejected cases, fallbacks, and failures;
- score distribution and rejection-reason distribution;
- edge-level evidence summaries and confidence bands;
- warnings for duplicate slugs, unresolved references, and malformed tools;
- timing by pipeline stage.

This report supports debugging, visual explanations, and the walkthrough. If size becomes excessive, retain accepted-edge evidence plus aggregated rejection statistics.

### 4.11 Interactive visualization

The committed visualization will be a dependency-free HTML viewer so the reviewer can open it without installing another framework. The generator can embed or load the graph and report into a generated HTML artifact.

Planned interactions:

- visible directed nodes and labeled edges;
- zoom, pan, drag, and fit-to-view;
- search by tool slug, entity, or edge label;
- filter by service/tag, confidence band, and producer/consumer role;
- click a node to show incoming prerequisites and outgoing dependents;
- click an edge to show the field and compact evidence;
- highlight a shortest precursor path where one exists;
- density-safe rendering for the full GitHub graph, with labels shown contextually instead of all at once;
- summary cards for nodes, edges, components, high-degree hubs, and inference mode;
- accessible colors, keyboard-friendly controls, and readable empty/error states.

The visualizer must remain useful with only the required graph file. Explainability data will enhance it but not be mandatory.

## 5. Testing strategy

Testing will be layered so failures identify which reasoning stage broke.

### 5.1 Unit tests

#### Catalog ingestion

- top-level array;
- `{ tools: [...] }` and `{ items: [...] }` wrappers;
- fallback slug locations and precedence;
- duplicate slugs;
- deprecated tools;
- invalid JSON, missing file, unsupported wrapper, and empty catalog;
- malformed entries mixed with valid entries.

#### Schema traversal

- direct properties;
- nested objects and arrays;
- `$defs` and `definitions` references;
- `allOf`, `anyOf`, and `oneOf`;
- cyclic references;
- required versus optional fields;
- repeated names at different paths;
- response wrapper suppression without losing descendants;
- missing descriptions and incomplete schemas.

#### Normalization and scoring

- snake/camel/Pascal/kebab equivalence;
- `issue_number` matched to `issues[].number`;
- `pull_number` kept distinct from issue number when context differs;
- compatible and incompatible types;
- operation-role priors;
- self/deprecated/contradictory penalties;
- stable tie-breaking;
- bounded top-K behavior.

#### Graph integrity

- dangling endpoints rejected;
- hallucinated labels rejected;
- optional consumer labels rejected when policy requires prerequisites;
- self-edges and duplicates removed;
- deterministic node and edge order;
- atomic write behavior on validation failure.

### 5.2 Model boundary tests

Use a fake OpenAI-compatible client rather than spending assessment tokens in unit tests:

- valid zero/one/multiple selections;
- response containing a fabricated slug;
- response selecting a producer outside the candidates;
- wrong or optional label;
- invalid JSON and prose-wrapped JSON;
- timeout, rate limit, server error, and exhausted retries;
- partial batch failure with mixed online/fallback output;
- stable prompt structure and bounded batch size;
- secrets absent from prompts, logs, reports, and snapshots.

One opt-in live integration check can exercise the Litmus proxy when credentials are present; it will never be part of the default deterministic test command.

### 5.3 Synthetic end-to-end fixtures

Small toolkit-neutral catalogs will make intended behavior unambiguous:

1. **Issue-like discovery:** list resources produces nested `items[].number`; comment requires `item_number`.
2. **Create then mutate:** create widget produces `widgetId`; update widget requires `widget_id`.
3. **Multiple valid producers:** get and search both produce a required ID.
4. **Ambiguous generic ID:** project and user tools both produce `id`; only entity-compatible producer is accepted.
5. **User content negative control:** producer returns `body`; unrelated create action requires user-authored `body`; no dependency.
6. **Context negative control:** many tools return `name`; no graph explosion around repository/project names.
7. **Recursive schema:** resource contains children of its own type; traversal terminates.
8. **No-output catalog:** valid nodes and zero safe edges.
9. **Mixed schema quality:** useful inference continues around one malformed tool.
10. **Non-GitHub vocabulary:** proves no GitHub slug or entity assumptions are necessary.

### 5.4 Metamorphic and property-oriented tests

These tests probe generalization more strongly than snapshots:

- Shuffling catalog order must not change output.
- Renaming slugs while preserving schemas must change node/edge endpoints accordingly, proving provenance rather than hard-coding.
- Adding an unrelated tool must not alter existing relationships.
- Converting equivalent camelCase fields to snake_case should preserve semantic edges.
- Wrapping an output one level deeper should preserve the inferred relationship.
- Duplicating a catalog entry should not duplicate nodes or edges.
- Randomly generated acyclic mini-catalogs should always satisfy graph integrity invariants.

### 5.5 GitHub real-catalog evaluation harness

The real catalog harness will report more than “has edges”:

- node provenance ratio (target: 1.0);
- duplicate/dangling/self-edge count (target: 0);
- labeled edge ratio (target: 1.0);
- percentage of edge labels that are required consumer inputs (target: 1.0);
- canonical edge recall (both README examples present);
- identifier-like required-input coverage;
- number of consumers with at least one plausible precursor;
- graph density, component count, isolated node count, and hub dominance;
- online/offline overlap and disagreement rate;
- deterministic repeat-run equality;
- generation duration and model request/token statistics when available.

Coverage and density will be interpreted, not blindly maximized. A manual quality sample will inspect:

- high-confidence accepted edges;
- low-margin accepted edges;
- rejected near-matches;
- highest-degree producer hubs;
- edges involving generic `id`/`number`/`name` fields;
- several create-to-mutate and list/get-to-mutate chains.

### 5.6 Visualization checks

- graph and diagnostics load successfully;
- full GitHub graph remains navigable;
- search and filters produce accurate subsets;
- edge directions and labels are visible;
- empty, malformed, and missing report inputs show useful states;
- no external network is required to inspect the committed visualization;
- basic responsive layout and keyboard navigation work.

## 6. Evaluation philosophy and quality gates

### Gate A: Contract correctness

- Generator command works from a clean install.
- CLI argument is honored.
- Required files are produced in the correct location and shape.
- Nodes and edges pass all integrity invariants.

### Gate B: Generalization

- Synthetic non-GitHub fixtures pass.
- Metamorphic tests pass.
- No source rule contains a GitHub tool slug.

### Gate C: Dependency quality

- Both README examples arise naturally.
- Manual samples show strong operational plausibility.
- Generic identifier hubs are controlled.
- Multiple valid producers are retained where evidence supports them.
- The generator can abstain from weak cases.

### Gate D: Resilience and reproducibility

- Offline fallback is tested and useful.
- API failures are isolated by batch.
- Repeated offline runs are byte-for-byte stable.
- Online output is sanitized and produces a clear run report.

### Gate E: Reviewer experience

- The architecture and trade-offs are documented.
- Tests and evaluation commands are discoverable.
- Visualization makes real relationships explorable.
- Git history tells a coherent engineering story.
- Walkthrough notes connect claims to executable evidence.

## 7. Branching and commit strategy

The repository currently uses `master` as its release branch. We will preserve it until final integration rather than renaming the assessment's default branch midstream.

```text
master                         release-ready assessment state
└── dev                        integration branch
    ├── documents/project-plan
    ├── features/catalog-ir
    ├── features/schema-indexer
    ├── features/candidate-inference
    ├── features/model-adjudicator
    ├── features/explainability-report
    ├── features/visualization
    ├── tests/evaluation-harness
    └── bugs/<focused-fix>
```

Workflow for each slice:

1. Start from an up-to-date `dev`.
2. Create one focused branch.
3. Make cohesive commits that each leave the branch understandable and preferably passing its relevant tests.
4. Run targeted tests, then the broader suite before integration.
5. Merge into `dev` with `--no-ff` so branch intent remains visible.
6. Use a dedicated `bugs/...` branch for any non-trivial regression found after integration.
7. Merge `dev` into `master` only after all final gates pass.

Planned commit narrative (exact wording may change to reflect actual work):

1. `docs: define evidence-driven dependency inference plan`
2. `feat: normalize and validate toolkit catalogs`
3. `test: cover catalog variants and malformed inputs`
4. `feat: index nested JSON Schema input and output fields`
5. `test: exercise references, arrays, unions, and recursive schemas`
6. `feat: rank dependency candidates using field and entity evidence`
7. `test: add synthetic and metamorphic inference cases`
8. `feat: adjudicate bounded candidates with the assessment model`
9. `feat: validate model selections and fall back per batch`
10. `test: harden the model boundary against malformed responses and failures`
11. `feat: emit inference diagnostics and reproducible graph output`
12. `feat: add an interactive dependency graph explorer`
13. `test: add GitHub quality metrics and canonical-edge checks`
14. Focused `fix:` commits for issues discovered by real-catalog review.
15. `docs: document operation, architecture, evaluation, and walkthrough`

Commit discipline:

- Do not mix formatting, architecture, tests, and unrelated fixes in one commit.
- Do not manufacture meaningless tiny commits; each commit should represent a reviewable idea.
- Commit tests with or immediately after the behavior they specify.
- Avoid committing credentials, `.env` files, transient caches, `node_modules`, or noisy run artifacts.
- Preserve meaningful merge commits as milestones in the activity history.

## 8. Implementation phases

### Phase 0: Plan and baseline

- Commit this plan through the documentation branch.
- Run the untouched self-check and record expected baseline behavior (nodes present, zero edges).
- Confirm clean install/run commands and current Node compatibility.
- Add a test command using Node's built-in test runner plus `tsx` to avoid unnecessary dependencies.

Exit evidence: baseline metrics, clean branch structure, agreed architecture.

### Phase 1: Catalog IR and graph contract

- Implement types, loader, validation, normalization, node builder, and CLI handling.
- Add actionable errors and deterministic serialization.
- Test supported shapes and failures.

Exit evidence: arbitrary valid catalogs yield provenance-safe nodes; invalid catalogs fail clearly.

### Phase 2: Schema indexing

- Implement safe recursive traversal and reference resolution.
- Extract required inputs and meaningful nested outputs.
- Add schema coverage diagnostics and edge-case fixtures.

Exit evidence: canonical GitHub input/output paths are visible in debug/evaluation output without special cases.

### Phase 3: Deterministic candidate inference

- Implement normalization, entity extraction, scoring, top-K retrieval, negative controls, and confidence thresholds.
- Add synthetic, metamorphic, and property-oriented tests.
- Verify the offline graph includes the canonical examples.

Exit evidence: useful non-empty graph without API access, measured precision controls, deterministic repeat runs.

### Phase 4: Model adjudication

- Integrate the OpenAI-compatible client through environment-only configuration.
- Build compact versioned prompts and strict response validation.
- Add batching, concurrency limits, timeouts, retries, and batch-level fallback.
- Test with a fake client, then run one opt-in live smoke check.

Exit evidence: semantic improvements over deterministic candidates, bounded cost, no hallucinated graph identifiers.

### Phase 5: Explainability and visualization

- Emit the inference report.
- Build the interactive offline viewer.
- Surface edge evidence, search, filters, neighborhoods, and graph statistics.
- Test with small fixtures and the full GitHub graph.

Exit evidence: a reviewer can inspect why an edge exists and navigate the real graph.

### Phase 6: Evaluation, tuning, and hardening

- Build and run the GitHub evaluation harness.
- Inspect stratified samples and high-degree hubs.
- Compare online versus offline decisions.
- Fix false-positive patterns through generic scoring/evidence changes.
- Measure clean-install behavior and generation time.
- Run secret scans and inspect committed artifacts.

Exit evidence: all quality gates pass, evaluation report is credible, known limitations are explicit.

### Phase 7: Documentation, release, and submission readiness

- Update README with quick start, configuration, modes, architecture, outputs, tests, visualization, and limitations.
- Prepare concise walkthrough notes with commands and representative relationships.
- Run `litmus doctor` if setup concerns appear.
- Merge all feature branches into `dev` and run a final clean verification.
- Merge `dev` into `master` with a release merge commit.
- Inspect `git log --graph`, `git status`, and tracked files.
- Run `litmus submit` only after explicit final confirmation that required artifacts are committed.

Exit evidence: release branch is clean, reproducible, explainable, and ready for video walkthrough.

## 9. Risk register and mitigations

| Risk | Why it matters | Mitigation |
| --- | --- | --- |
| Nested schemas hide meaningful outputs | Canonical edges can be missed | Full path-aware `$ref`/array/union traversal with fixtures |
| Exact-name matching creates false hubs | Generic `id`, `name`, and `number` occur everywhere | Entity context, type checks, top-K caps, ambiguity penalties, abstention |
| LLM invents plausible tools or fields | Violates catalog provenance | Candidate-only selections plus strict graph firewall |
| Model proxy is slow or unavailable | Generator may fail grading | Timeouts, retries, per-batch fallback, strong offline mode |
| Prompting the full catalog is costly | Token budget and latency | Deterministic retrieval followed by compact candidate batches |
| Tool outputs are underspecified | True edges lack direct structural proof | Combine paths, descriptions, titles, tags, and operation intent; record uncertainty |
| Overfitting to GitHub examples | Hidden toolkit evaluation fails | Non-GitHub fixtures and metamorphic slug/schema tests |
| Graph is too dense to inspect | Visualization exists but is unusable | Neighborhood-first rendering, filters, contextual labels, hub metrics |
| Extra diagnostics break strict grader | Correct reasoning still fails contract | Keep grader JSON minimal; use separate report artifact |
| Secret leaks through code or logs | Security and assessment violation | Environment-only configuration, log redaction, ignore rules, secret scan |
| Frequent commits become noisy | History looks performative rather than professional | One reviewable idea per commit plus meaningful branch merge milestones |
| Time pressure encourages shallow completion | Conflicts with grading emphasis | Protect schema/candidate/test depth first; treat polish as later phase |

## 10. Deliberate trade-offs

- **Hybrid inference over model-only generation:** more engineering effort, but better provenance, reproducibility, cost control, and offline resilience.
- **Candidate recall followed by strict adjudication:** allows multiple valid producers while controlling graph noise.
- **Separate diagnostic artifact:** slightly more output complexity, but preserves a strict graph contract and enables explainability.
- **Conservative abstention:** may miss weak true edges, but the resulting graph is safer for agentic execution and easier to defend.
- **Dependency-light visualization:** avoids build/runtime fragility; advanced layout quality must be achieved with careful browser code rather than a large framework.
- **Meaningful branches and merge commits:** adds workflow overhead, but leaves an auditable narrative aligned with the assessment's activity tracking.

## 11. Definition of done

The project is ready to release when all of the following are true:

- [ ] `generator.json` installs and runs the generator from a clean checkout.
- [ ] The CLI reads the supplied path and writes root `dependency_graph.json`.
- [ ] All emitted node IDs come from the runtime catalog.
- [ ] All edges are producer-to-consumer, labeled, de-duplicated, and integrity checked.
- [ ] The two README example edges are generated without slug-specific rules.
- [ ] Nested outputs and local JSON Schema references are handled safely.
- [ ] Deterministic offline mode produces a useful, reproducible graph.
- [ ] Litmus model mode uses environment-only credentials and bounded validated prompts.
- [ ] API failures degrade per batch rather than failing the whole run.
- [ ] Unit, integration, synthetic, negative, metamorphic, and model-boundary tests pass.
- [ ] The GitHub evaluation harness reports provenance, integrity, canonical recall, density, and review metrics.
- [ ] Manual sampling finds no uncontrolled generic-field hubs.
- [ ] The interactive visualization clearly exposes nodes, directed edges, labels, and neighborhoods.
- [ ] Documentation explains setup, architecture, configuration, outputs, tests, and limitations.
- [ ] No credentials, transient cache, or dependency directories are committed.
- [ ] `git log --graph` shows cohesive feature branches and meaningful incremental commits.
- [ ] `dev` passes final clean verification before its release merge into `master`.
- [ ] The final video walkthrough can demonstrate one canonical edge, one ambiguous rejection, offline fallback, test depth, evaluation metrics, and the visualization.

## 12. Walkthrough narrative to preserve while building

The eventual walkthrough should tell a compact engineering story:

1. Begin with the operational problem: an agent needs an issue or pull-request identifier before it can act.
2. Show how the catalog exposes required inputs and deeply nested outputs.
3. Explain why naive exact matching and unconstrained LLM generation both fail.
4. Demonstrate the evidence pipeline and hallucination firewall.
5. Run a focused test and the GitHub evaluation harness.
6. Inspect the two canonical paths plus one non-obvious valid edge in the visualization.
7. Show an ambiguous candidate the system rejected and explain why abstention is useful.
8. Disable credentials to demonstrate deterministic fallback.
9. Show the branch/commit graph as evidence of incremental development.
10. Close with limitations and the next improvement that would be made with more evaluation data.

This narrative will be updated as implementation evidence replaces planned behavior. Claims in the final walkthrough must be demonstrated by code, tests, or generated metrics rather than relying on aspiration.
