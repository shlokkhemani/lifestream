# Contributing

Lifestream is built in the open by one person, with AI agents doing much of the building. Every issue is read, and what it tells us gets fixed.
Reviewing a pull request often takes more work than writing one, so most help is best sent as an
issue.

## The best way to help: open an issue

An issue is how a bug gets fixed or an idea gets built. Each one is read, and the fix is
made here. Before you open one, search the open issues. If one already covers yours, add what you saw
to it instead of opening another.

- **A bug.** Say what you did, what you expected and what happened instead. Give the steps that
  show it, the message the app showed, the Lifestream version (**Settings** › **Updates**) and
  your macOS or iOS version. Never paste anyone's real messages, mail or other records: describe
  them, or show the bug with made-up data.
- **A connector you want.** Name the provider or the device, and say what of it you want in your
  record and how you get your data out of it today.
- **An idea.** Say what you want to do and what stops you now. A problem you have is more useful
  to us than a design for its fix.

You can also help close issues. If an open issue no longer happens on the latest version, say so
and give the version. If two issues describe one problem, link one from the other.

A security problem is never a public issue. Report it privately, as [SECURITY.md](./SECURITY.md)
says.

## Add a connector without a pull request

You do not need a change to Lifestream to add a connector to your own Lifestream. A connector of
your own is a folder, written against the connector SDK, that Lifestream loads when it starts.
`lifestream connectors install <folder>` checks it and installs it.

- [Add a connector with your coding agent](./docs/user/add-a-connector.md) says how to have an
  agent write one for you.
- [packages/connect/SKILL.md](./packages/connect/SKILL.md) is the guide to writing one.

If a connector works well for you, open an issue: the provider may be added to the release.

## Pull requests

We have little time to review, and we may close a pull request without a review. That is most
likely for:

- a new feature,
- a new connector in the release,
- a change to how an app looks or is laid out,
- a change to the architecture: a new part, a new way for a device to reach Lifestream, a new
  storage format.

For any of these, open an issue instead. If the change fits, it gets built.

A small fix for an obvious bug is welcome. Link the issue that shows the bug, unless the bug is
plain from the change itself. A pull request that follows every rule below can still be closed:
we do not owe a review or a merge.

### If you do send a pull request

- **Fix one problem.** Include every change the fix needs: code, tests and docs. A cleanup, a
  refactor or a second fix goes in a pull request of its own.
- **Say how you found the bug, how you checked the fix and what you saw.** "Tests pass" alone
  does not show that the fix works. A change to an app needs a screenshot from before and after.
- **Test at the cheapest layer that shows the failure:** a rule in-process, a seam against its
  contract's files, a product flow end to end. Run the test files your change reaches by name:
  the ones you edited, and the ones that name a module, route or type you changed. Never run a
  whole package.
- **Run `npm run check` once before you send it,** and send it only when the check passes.
  [Set up to develop](./docs/contributing/develop.md) sets up your Mac and runs the tests.

### How a change lands

Every change reaches `main` here as one pull request, the maintainers' own included, one at a time
and in order.

- **One pull request, one change a person can name.** Its title says what changes for the person
  who uses Lifestream, in plain words, in under 70 characters: "Google Places: each spot asked once,
  at most 500 a day", never "fix places bug".
- **Its description has these parts,** in this order:
  - `## What changes`: what a person or a contributor sees now, a line each;
  - `## Why`: the fault or the need, with `Fixes #N` for the issue it closes;
  - `## How it was checked`: the tests run, by name and result, and for an app a before and after;
  - `## Not in this PR`: what is left, when something is.
- **A large feature lands in parts,** each a pull request of its own that leaves `main` working, a
  part that is not finished switched off ("(off)" in its title).
- **Nothing personal in a title, a description, a commit or a branch name**, as in the files.
- **A maintainer merges** once the tests the change reaches pass. A contributor's pull request is
  merged as their own commit, never rewritten under another name; one rebuilt by a maintainer
  credits them with `Co-authored-by:` and says why.

Every change keeps these rules. The check refuses most breaks of them.

- **No personal data in any file.** Fixtures and examples use obviously fake values:
  `+15550000001`, `person-a@example.com`, `macbook-pro-0001`.
- **No network or model calls in tests.** A test's connection to any host but loopback throws.
- **No comments.** A name, a type or a test says what the code does. A comment stays only as an
  `// external:` line, a fact about what the repository cannot change (macOS, a provider, a
  protocol), and as the one sentence of `/** … */` the connector SDK (`packages/connect/sdk.ts`)
  gives each declaration it exports. `tools/check-comments.ts` refuses the rest.
- **Imports point down the package table** in
  [Architecture](./docs/contributing/architecture.md#the-packages).
- **Docs move with the code.** A change that deletes, renames or reshapes something fixes every
  doc line that describes it.
- **A source's identity needs the maintainer's agreement.** A source id, a connector's kinds and keys,
  what a version id hashes or how content is made canonical: open an issue before you change one,
  and wait for the maintainer's answer.

## Setup

[Set up to develop](./docs/contributing/develop.md) takes you from a fresh clone to a Mac that can
typecheck and test Lifestream, run it from the checkout, and build the apps.

## License

By sending a contribution, you agree that it is licensed under the
[Apache License 2.0](./LICENSE), as the rest of Lifestream is.
