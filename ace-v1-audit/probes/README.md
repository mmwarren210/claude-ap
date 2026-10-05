# ACE v1 audit reproduction probes

These are test files for the **ace-v1** repository. They are stored as `.txt` so this repository's own tooling ignores them.

## Install into ace-v1

From the ace-v1 repo root (branch `codex/ace-v1-full-build`):

```bash
mkdir -p .audit-probes
cp <path-to-claude-ap>/ace-v1-audit/probes/probes.test.ts.txt .audit-probes/probes.test.ts
cp <path-to-claude-ap>/ace-v1-audit/probes/pg.test.ts.txt     .audit-probes/pg.test.ts
```

The files import `../apps/api/src/...`, so they must sit in a folder directly under the ace-v1 root.

## Run

```bash
npx vitest run .audit-probes/probes.test.ts
DATABASE_URL=<disposable dev database> npx vitest run .audit-probes/pg.test.ts
```

## Meaning

Each probe asserts the current defective behavior. A **passing** probe means the bug is still present.

At audited commit `636c9b0`, all 11 pass: P1–P8, PG1, PG1b and PG2. PG1 and PG2 need `DATABASE_URL` and skip without it.

| Probe | Finding |
|---|---|
| P1 | F3 numeric conflict verifies |
| P2 | F4 sibling publisher domains |
| P3 | F1 unverified evidence narrated and published |
| P4 | F2 headline in templates; G4 duration |
| P5 | G2 Auto Mode can't approve |
| P6 | G1 live mode can't verify; zero platform candidates |
| P7 | G3 constant creative dimensions |
| P8 | F8 tokenless cross-site POST |
| PG1/PG1b | F5 reconnect broken |
| PG2 | F6 pool starvation |

After fixing a finding, invert that probe's assertions and move it into `tests/` as a permanent regression test.
