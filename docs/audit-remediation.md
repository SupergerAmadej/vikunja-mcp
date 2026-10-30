# Audit remediation

## Security refresh (30 October 2026)

The default backend now builds **2.7.1+atomic-fields.1**, rebased onto upstream
commit `5619c4a9f66ddfc13f7bbba24ada07c3e82ae7a0`. This incorporates the 2.7.1
security fixes, including the account-deletion privilege escalation and webhook
task disclosure. The active patch, source archive and changed-file hashes are
recorded in `upstream/vikunja-2.7.1-atomic-fields.json`. The old 2.7.0 patch and
manifest are retired from the published source tree. Upstream's 2.7.1 migrations
are preserved; deployment and rollback instructions require a cold backup.

The lockfile now resolves `body-parser` **2.4.0**. Compressed MCP request bodies
are disabled before decompression, with regression coverage for valid compressed
JSON, malformed trailing bytes, authentication ordering and subsequent service
availability. A fresh npm advisory check reports zero vulnerabilities.

Gitleaks is checksum-pinned in CI and scans complete Git history. Local ignore
rules additionally exclude database copies, private keys and account exports.
Runtime `.env` and data paths remain ignored; plaintext credential copies,
client-config backups and historical generated artifacts belong in restricted
private storage outside the checkout. Commit identity was retained at the
maintainer's request.

Verification passes 47 server tests and 11 stock 2.7.1 integration tests on both
Windows and Linux, ten atomic integration tests on Linux, and the production
container/Compose checks. Expanded upstream tests also cover account-deletion
shares, Kanban updates, webhook creator access and API-token route permissions.
The unpatched 2.7.1 control reproduces the three remaining reminder/project/label
replacement failures; scalar task collections are already fixed upstream.
Current evidence is in `docs/atomic-verification.json`; the previous evidence is
preserved in `docs/atomic-verification-2026-10-20.json`. Existing deployments have
not been upgraded by these repository changes.

The remainder of this document describes the earlier audit and its historical
verification results. Its 2.7.0 pins and advisory counts are not current release
recommendations.

The 20 October 2026 audit is preserved as a snapshot. These changes address its
findings and add executable regression coverage. The supported contract is
Vikunja 2.7.0's v1 API plus the reviewed v2 field-update extension, with Node.js
24 LTS.

The maintainer approved adoption of the tested backend extension for F03. Version
0.2.1 now builds it by default in Compose and requires atomic support unless
compatibility mode is explicitly selected. Stock 2.7.0 retains the documented
replacement limits; local verification does not upgrade an existing deployment.

| Finding | Change | Verification |
| --- | --- | --- |
| F01 server file access | Local imports disabled by default; optional import directory rejects escapes, symbolic and hard links, non-files and oversized content. Base64 is validated and bounded. Runtime runs without root. | `test/uploads.test.mjs`, upload transport tests, CI image user check. |
| F02 runtime and dependencies | Docker uses pinned Node 24.22.0 image and digest; patched dependencies and a lockfile install with `npm ci`. | `npm audit --audit-level=moderate`, build, regression and real-API suites. |
| F03 concurrent updates | The default Compose backend includes the reviewed field-mask extension and MCP defaults to required support. Shared per-object queues remain. The patch preserves omitted fields/collections and returns canonical task metadata. | Stock negative controls reproduce the four original overwrite failures. The patched backend passes nine MCP scenarios, including independent writers, explicit unchanged values, moves, clears and reminder base-date races. Upstream permission/model tests and production-stack verification cover the adopted build. Existing live deployments must still be upgraded. |
| F04 percentage scale | Divide the public 0–100 input by 100 before sending `percent_done`. | Boundary tests for 0, 50 and 100; real API stores 0.5. |
| F05 task ordering | Require `projectViewId` and use the dedicated position endpoint. | Route regression test and real view ordering check. |
| F06 upload results | Parse `success` and `errors`; return created IDs and partial failures. No-success results are tool errors. | Success, mixed, all-failed and malformed response tests; real attachment upload/download. |
| F07 pagination | Send project and completion filters to Vikunja before pagination; omit absent or invalid metadata. | Two-page fixture with filtered totals, unknown versus zero headers, real API filtering. |
| F08 Origin validation | Exact Host and Origin allowlists before authentication and body parsing; local binding defaults to loopback. | Untrusted hosts and origins rejected, allowed browser and native clients accepted, unauthorized malformed JSON rejected. |
| F09 deployment | Lockfile installs, pinned releases, non-root image, restricted Compose sidecar, loopback port publishing and persistent database/files mounts. | Compose rendering, CI image build/start, disposable real-server recreation and cold backup/restore. |
| F10 test and release checks | Node test runner, real release integration harness, Linux/Windows CI and production container smoke job. Configuration, uploads and update queues have dedicated modules. | `npm test`, `npm run test:integration`, `.github/workflows/ci.yml`. |
| F11 expansions | Validate supported names and retain normalized expansion values, including subtask relations. | Expansion regression test plus real comments/subtasks/count and identifier lookup. |
| F12 configuration | Reject explicitly invalid URLs, numeric bounds, allowlists and directories; only omitted optional values use defaults. | Config unit tests and validate-only process exit checks. |

The API integration suite also found that the released label update route uses
POST despite the release's Swagger annotation saying PUT. Label updates now use
the actual route and merge existing fields; round-trip tests verify that a title
edit preserves its description and color. Project unparenting sends the explicit
zero required by the release.

## Stock-server concurrency limits

The queue protects writes made by one MCP process. Scalar task columns are named
in the bulk operation, so an unrelated scalar change by an external writer is not
echoed back over its newer value. The v1 model updater nevertheless handles
assignees, reminders and favorites outside its column list, so their current
values must be supplied to preserve them. Project, label and reminder operations
also use replacement semantics. The released API does not provide an atomic
conditional-write contract for those operations. Coordinate other MCP instances
and UI writers while replacing these values. The suite proves the local queue
and scalar behavior; it does not claim general cross-client transaction safety.

No automatic retry of a timed-out write is introduced. Its result can be
ambiguous, and retrying creates, comments or attachments could duplicate them.

## Operation and release checks

- `npm ci` installs the reviewed lockfile.
- `npm test` builds and runs offline logic tests and local mock HTTP tests.
- `npm run test:integration` verifies a downloaded official release digest and
  starts a disposable Vikunja process. Set `TEST_VIKUNJA_BINARY` to use an existing
  2.7.0 executable. It creates its own user, tasks and SQLite/file directories.
- `npm audit --audit-level=moderate` gates dependency advisories.
- `npm run test:container` builds the production image and checks uid 1000,
  read-only startup, dropped capabilities, liveness and authenticated tool listing.
- CI runs both suites on Linux and Windows. A Linux Docker job checks the
  non-root image, read-only startup and liveness endpoint.

Before the tool-audit follow-up, local verification passed 26 regression tests and the real-API suite on Windows
and Linux, clean lockfile installation, zero npm advisories, Compose
configuration validation and the production container build and smoke test.
The native integration suite verifies database and attachment persistence and a
stopped-server backup restored into separate paths. It does not exercise the
host's actual deployment or backup storage.

Additional operational changes include redacted request logs, request IDs,
bounded MCP concurrency, shutdown handling, early transport cleanup, sanitized
HTTP parser errors, minimal liveness output and authenticated upstream readiness.
Removal and replacement annotations were corrected. Public-release preparation
adds the root MIT license for the MCP code, documentation and AI skill, with
AGPL-3.0-or-later licensing for `upstream/` and the patched Vikunja backend. See
the [license overview](../README.md#license).

## Tool audit follow-up (0.2.0)

The separate tool audit and skill guide remain snapshots of the reviewed 0.1.0
working tree. The fixes below update that implementation; the reports are not
rewritten as if these changes existed at audit time.

| Finding | Change | Verification |
| --- | --- | --- |
| T01 unsupported/no-op edits | All 42 tool schemas reject unknown keys. Task/project/label patches require a supported field; explicitly unchanged values remain valid. | MCP tests assert unknown-only, mixed and empty requests fail before upstream calls; native persistence confirms rejected edits were not applied. |
| T02 invalid reminders | Mutually exclusive absolute/relative forms; required relative base date and signed offset; unset absolute timestamps rejected; bounded item count and offsets. | MCP tests cover incomplete/ambiguous inputs, missing base dates and valid replacements; real API verifies the calculated reminder instant. |
| T03 false project-clear success | A non-empty description cannot be cleared by the released 2.7.0 API. Reject that request before applying any fields and report the limitation. Actual clearing remains an upstream feature gap. | Mock and real API tests prove a mixed title/clear request changes neither field. |
| T04 identifier lookup | Accept backend-valid numeric-leading prefixes, encode path components and validate safe positive indices. Resolve numeric-only/dot project prefixes to IDs to avoid incorrect task selection. | Encoded-prefix transport tests and native 9TEAM/123/R&D lookups. |
| T05 offset timestamps | Accept RFC3339 offsets and normalize to UTC across creation, edits and reminders. | Equivalent offsets, invalid dates/local times and real persisted instants. |
| T06 repeat disabling | Named modes plus legacy compatibility; a zero interval resets monthly mode unless explicitly requested. Report recurring completion's actual returned state. | Mode/interval constraints, monthly-to-none round trips and real recurring completion/rescheduling. |
| T07 misleading page counts | Add actual page item count, requested page/size, continuation and explicit completeness. Retain the raw legacy header without claiming it is a global total. Correct the mock to match released header semantics. | Multi-page and inconsistent-header regressions; native perPage=1 with multiple matches. |
| T08 schema drift | Bump the release to 0.2.0; read server version from package.json; record the public schemas/fingerprint and compare the runtime catalogue in tests. Existing host/connector caches still require a deployment refresh. | `test/tool-contract.test.mjs`, `docs/tool-contract.json` and protocol initialization checks. |

Missing-tool recommendations are feature proposals, not silently added by these
correctness fixes. No commands were removed, and no AI skill was installed at
the 0.2.0 stage.
The 0.2.0 tests did not establish atomic safety against independent writers.
The 0.2.1 extension described below addresses that F03 gap and is now adopted
by the default project deployment after maintainer approval.

The expanded runs pass 37 regression tests and 11 integration tests (10 scenarios
and their parent test) on both Windows and Linux. The Linux suites ran in an
isolated build-stage container, with the test/schema sources mounted read-only;
the native suite verified and downloaded its own official release binary. They
use mocks or a disposable Vikunja 2.7.0 instance, never the user's deployment.
The updated production image also passes the uid 1000, read-only root, dropped
capabilities, liveness and authenticated 42-tool smoke checks. Its clean lockfile
install reports zero dependency vulnerabilities. The reviewed tool-schema
fingerprint is recorded in `docs/tool-contract.json` and matches on both platforms.

## Atomic field-update follow-up (0.2.1)

The companion patch targets upstream commit
`a16be96aa454671fdf213b0fbe411dd38a098418` (2.7.0). Its source archive, individual
files and patch digest are recorded in
`upstream/vikunja-2.7.0-atomic-fields.json`. Patch SHA256:
`1bd6cd6b6d378b7581fec5c253e73df884a44e00a3012dc06615a4e67937ef18`.
The patch has nine source/test files and adds no migrations. No live backend,
GitHub repository or user data was changed.

The backend advertises protocol 1 and exposes dedicated v2 task/project/label
field-update routes. They use existing permissions and transaction handling.
Omitted task assignees, reminders and favorite state are loaded from the current
database state, while project/label writes name only selected columns. Masked
project writes support explicit description clears and preserve archive/parent
state. Relative reminders are validated against the current base date. Task
responses reload canonical metadata so external moves cannot return stale indices
or identifiers. Parent changes retain the admin gate, including explicit null
detachment, and inherited write permissions remain supported.

The MCP client discovers the protocol once per process and sends the explicitly
requested field set, including values equal to the initial read. Legacy positive
repeat intervals preserve an omitted mode. A failed/denied/missing advertised
field route never causes a replacement fallback. Required mode
(`VIKUNJA_REQUIRE_ATOMIC_UPDATES=1`) rejects affected writes and readiness when
protocol 1 is missing. Required mode is now the default; explicit `0` enables
stock compatibility and still carries the stock F03 limit. Restart after
changing the backend.

Verification is executable with `npm run test:atomic`, also added to CI. It
verifies pinned inputs, builds unpatched and patched test binaries, runs upstream
model/HTTP tests, and compares the same real MCP scenarios. The unpatched source
must fail all four original loss checks; the patched suite passes nine scenarios
plus its parent test in required mode. Separate failing controls verified that
the metadata-return and explicit-write-intent regressions actually caught their
pre-fix implementations. The upstream tests cover positive and negative
permissions, inherited write access, admin-only reparenting and invalid masks.

The final MCP regression suite passes 43 tests on Windows and Linux. The stock
real-API suite passes 11 tests, and production smoke checks pass with uid 1000,
read-only root, dropped capabilities and all 42 tools. Clean image installs report
zero npm dependency vulnerabilities. Full atomic-proof logs and test binaries
are retained under `.tmp/atomic-proof`; those binaries use a placeholder frontend
and are not deployment images.

The backend extension has been adopted as the default after explicit maintainer
approval. `upstream/vikunja.Dockerfile` produces a real frontend and static API,
verifies the pinned archive/patch/file hashes, retains license notices and serves
the corresponding source archive. The Compose backend runs as uid 1000 with a
read-only root, dropped capabilities, a temporary `/tmp` and persistent mounts.
`npm run test:stack` exercises the production Compose services with disposable
data, scoped tokens, permission rejection and database/attachment persistence
after container recreation. The production
proof passes, including 52 frontend assets and the matching corresponding source.
The post-adoption runs pass all 43 MCP regressions on Windows/Linux, 11 stock
compatibility tests on each platform, and all 10 atomic tests on Linux. CI runs
the production proof alongside the differential proof. No existing deployment
or user data was changed. Exact evidence and hashes are saved in
`docs/atomic-verification.json`.

F03 is not claimed fixed for an unpatched deployment. Concurrent callers replacing
the same collection still have conflicting intent; the field protocol does not
add compare-and-swap revisions. Legacy clients that submit their own stale full
replacement can still overwrite newer values and must coordinate their writes.
SQLite transaction overlap is not claimed supported: the independent-process
case deliberately commits stale-snapshot writes in order to isolate lost updates.

## AI skill follow-up (21 October 2026)

The `skills/vikunja-mcp` package now implements the requested skill for Codex and
Claude Code. It contains a short entrypoint, focused contract/workflow references
and Codex UI metadata. The shared instructions preserve the selected instance,
respect replacement semantics, handle pagination and reconcile uncertain writes.
They add no credentials, direct HTTP wrapper, approval override or MCP setting.

Skill Creator validation passes for the source and both personal installations.
Three example/compatibility/bundle checks pass on Windows and Linux. An independent
offline Codex agent handled four fictional cases with thirteen schema-valid
planned calls; recorded state/scope assertions pass. The complete Windows
regression suite now passes 46 tests. No live task data was changed during skill
validation, and existing connection settings are unchanged. Claude Code execution
and comparative model benchmarks are not claimed. Usage, maintenance and exact
evidence are in `docs/ai-skill.md` and `docs/skill-verification.json`.
