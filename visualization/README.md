# Dependency Atlas

Run `npm run visualize`, then open `http://127.0.0.1:4173`.

The dependency-free Canvas interface provides two complementary representations: a draggable and zoomable 3D atlas of all tools and edges, and a focused upstream/downstream flow for one operation. Search or click any node, filter direction, tune visible connections, then click a highlighted connection (or its inspector row) to inspect the required input, producer output path, score, confidence, and weighted features. Faint global edges provide spatial context but intentionally are not clickable. Use `?view=focus` to deep-link to the focused flow. All data and assets are local.
