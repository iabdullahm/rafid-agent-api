# manifests/

`distribution/manifest.json` (one level up) is Rafid's single machine-readable distribution manifest. It is **generated**, not hand-written:

```bash
npm run distribution:manifest
```

runs `scripts/generateDistributionManifest.ts`, which imports directly from the same modules every live discovery endpoint reads from — `src/domain/capabilities.ts` (the capability registry), `src/billing/catalog.ts` (prices), `src/domain/roadmap.ts` (planned capabilities), `src/domain/oman/locations.ts` (supported geography), and the route-prefix constants in `src/api/agent.ts`/`src/billing/x402.ts`/`src/mcp/remote.ts` — and writes a projection of them to `../manifest.json`. It adds no manual tool catalog of its own and holds no fact that isn't already true of the live registry.

Regenerate it (and re-run `npm run distribution:check`, which regenerates it automatically first via its own `predistribution:check` npm script) whenever `src/domain/capabilities.ts` or any of the other source modules above change, so `distribution/manifest.json` never drifts from what the live API actually returns. `distribution:check`'s "manifest freshness" check compares the file on disk against the registry and fails if they disagree.

This subfolder holds no data files of its own — it exists to document how `../manifest.json` comes to exist, since a static JSON file with no comments can't explain its own provenance.
