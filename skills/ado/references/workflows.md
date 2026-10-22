# ADO Workflows — task playbooks

Step-by-step recipes for common tasks. Every step is one `ado` command; read
steps come before mutating steps. See `commands.md` for full flag reference.

## Code review a PR

1. `ado pr context <prId>` — one call: metadata, linked work items, commits, changed files, threads.
2. `ado pr diff <prId> --hunks` — the actual unified diff. Review the hunks, not the file list.
3. Read the linked work item (`ado wi get <id>`) so you can check the PR against its intended scope; `ado wi attachments <id>` when the ticket references screenshots.
4. For files that need a closer look: `ado pr file --path <file> <prId>` (use `--start`/`--end` for large files).
5. Leave findings as anchored comments: `ado pr comment <prId> --comment "<finding>" --file <path> --line <n>`.
6. Vote once at the end: `ado pr vote <prId> <approve|suggestions|wait|reject> [--comment "<summary>"]`.

Guidelines:
- Comment BEFORE voting — a vote with unexplained rejection is useless to the author.
- `suggestions` = approved with non-blocking notes; `wait` = author must respond; `reject` = blocking defect.
- If threads already exist, read them (`ado pr threads <prId>`) so you don't repeat resolved feedback.

## Answer / follow up on PR threads

1. `ado pr threads <prId>` — full discussion; each thread starts with `#<threadId>`.
2. Reply in the thread: `ado pr reply <prId> <threadId> --comment "<reply>"`; add `--status fixed` (or `wontFix`, `closed`, `byDesign`) to resolve it, or pass `--status` alone.
3. New feedback goes in a new thread: `ado pr comment <prId> --comment "<text>" [--file <path> --line <n>]`.

## Create a work item

1. Check the project rules first: read `[work_item.create]` in `.adoconfig.toml` (enabled? allowed types? required fields?).
2. Unsure about valid types: `ado wi types`.
3. Create: `ado wi create --title "<t>" --type <Type> [--description "<d>"] [--priority <n>] [--parent <id>]`.
4. For a child of an existing item: `ado wi create-child --parent <id> --title "<t>"`.

If creation is rejected, the error names the violated rule — fix the flag, don't retry blindly.

## Update a work item after finishing work

1. `ado wi get <id>` — confirm current state and that it's the right item.
2. `ado wi update <id> --state "<state>" --comment "<what was done, PR link>"` — one command updates state and comments.

## Create a PR for finished work

1. Confirm the branch exists and is pushed (git, not ado).
2. `ado wi get <id>` if linking a work item — verify the ID.
3. `ado pr create --repo <r> --source <branch> --target <branch> --title "<t>" --wi <id> [--draft]`.
4. Respect `.adoconfig.toml` `[pr]` rules: `require_work_item`, `default_draft`.

## Create a chain of PRs from work items

1. `ado wi get <id>` for each item — confirm order and scope.
2. `ado pr chain --repo <r> --wi 1,2,3 [--strategy feature-chain|stacked]` — order of `--wi` is the chain order.
3. Strategy/base/prefix default from `.adoconfig.toml` `[chain]`; only pass flags to override.

## Find my pending work

- PRs waiting for my review or authored by me: `ado pr list`.
- Work items assigned to me (non-Closed): `ado wi list`.
- Filter: `ado wi list --state "In Dev" --type Bug`.
