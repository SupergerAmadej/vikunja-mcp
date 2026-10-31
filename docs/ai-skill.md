# Vikunja MCP skill

The reusable skill lives in [`skills/vikunja-mcp`](../skills/vikunja-mcp/SKILL.md).
It follows the shared `SKILL.md` format and uses the MCP tools already exposed by
the host. The portable bundle contains instructions, two focused references and
optional Codex UI metadata; it contains no secrets, configured endpoint, direct
HTTP client or tool-approval overrides.

## Use it

In Codex, select the skill or invoke:

```text
$vikunja-mcp Review open tasks in the local Vikunja Ops project.
```

In Claude Code, invoke:

```text
/vikunja-mcp Add a reminder to OPS-17 on the selected Vikunja instance.
```

The host must already have an authenticated Vikunja MCP connection. A skill does
not install or configure that connection. Local and remote connections are
separate targets. The skill preserves the user's selected instance and asks when
that choice is actually ambiguous, instead of assuming a universal local or
remote default.

Install from the repository's `skills/vikunja-mcp` folder. Generated ZIP bundles
under `output/skills/` are local artifacts and are not included in the repository.
The recorded validation checked matching personal Codex and Claude Code copies.
Claude Code format compatibility is validated; execution inside Claude Code was
not tested.

The same folder can be copied to a Codex personal skill directory or a trusted
repository's `.agents/skills/vikunja-mcp`, and to Claude Code's personal
`~/.claude/skills/vikunja-mcp` or repository `.claude/skills/vikunja-mcp`.
Use one discovery location per host to avoid duplicate entries.
Skill Creator's default personal Codex location is `~/.codex/skills`; current
Codex documentation also describes `~/.agents/skills` for personal discovery.
Claude Code's personal installation does not configure Claude.ai or Cowork.
See the official [Codex skill documentation](https://learn.chatgpt.com/docs/build-skills)
and [Claude Code skill documentation](https://code.claude.com/docs/en/skills).

## Covered workflows and limits

- Resolve projects/tasks without guessing ambiguous IDs or switching instances.
- Capture and edit tasks, create linked subtasks, and report partial successes.
- Review the requested pages/status scope with honest coverage and counts.
- Handle offset timestamps, relative reminders and named recurrence modes.
- Add labels or assignees while preserving existing collection members.
- Use comments, relations and attachments with their supported tool semantics.
- Reconcile uncertain writes instead of duplicating creates or recurring completions.
- Inspect backend update capabilities before the first affected write; use the
  stock fallback when supported and skip unsupported operations or strict-mode
  blocks. Retain known authorization failures until the instance changes.

The skill does not add missing MCP capabilities. User lookup, view/bucket
discovery, bucket moves, arbitrary filters and attachment-content retrieval are
still limited by the server's exposed tools. Existing host approval rules and
backend permissions continue to apply. No MCP configuration is changed by skill
creation or installation.

## Maintain and validate

Edit the repository copy first; its references are self-contained when copied to
another host. Review compatibility whenever the public tool contract changes.
`references/tool-contract.md` records the reviewed MCP version and fingerprint;
the live host schema remains authoritative.

```powershell
# Uses the normal repository tests; no live task mutations.
npm test

# Or run only the packaged-reference/schema checks.
node --test test/skill-examples.test.mjs

# Also check the saved offline agent traces against state/scope assertions.
npm run test:skill
```

The skill-specific tests validate the JSON example calls against the reviewed
public schemas, check the compatibility snapshot and ensure local reference
links stay inside the bundle. They do not prove model behavior. Skill Creator's
`quick_validate.py` additionally checks frontmatter and unfinished scaffolding;
it requires Python with PyYAML.

An offline forward-test uses fictional tasks and tool responses to inspect
collection preservation, multi-page reviews, instance ambiguity, partial child
creation, uncertain recurring completion, stock updates, blocked updates and
known-denied expansions. This is separate from the 42-tool
live deployment tests. It does not establish Claude model execution, benchmark
improvements over a baseline or a general success rate. Structural validation,
example checks and observed agent scenarios must be reported separately.

The recorded trial and fictional inputs are in
[`evals/vikunja-mcp`](../evals/vikunja-mcp/requests.json). Eight cases and twenty-seven
schema-valid planned calls passed the recorded state/scope checks. Rerun the
agent trial in an isolated environment when changing the skill's instructions;
the trace checker detects changes using hashes of the shipped files. It checks
saved traces rather than starting a model itself. `docs/skill-verification.json`
records the packaged files, installations and validation results.
