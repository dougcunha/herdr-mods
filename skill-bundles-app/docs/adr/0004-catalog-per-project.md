# 0004: A project names its Catalog

Date: 2026-11-15

## Context

The mod had one Catalog for each computer (the **Skill Catalog** setting). A person with projects
of 2 groups (company repositories and open source repositories) needs a different Catalog for
each group. 2 Catalogs can have skills and Bundles with the same names (`core`, `commit`), so a
project that is read with the wrong Catalog gets links that look correct and point to the wrong
clone.

## Decision

- `skills.yaml` has an optional key `catalog: owner/name`. Without it, the project uses the
  default Catalog of the computer. The key is in the committed file, so it is the same on every
  computer. A rule by folder was rejected: it is a setting of one computer.
- The link script (`link-skills.mjs`) is the guard. `read` reports `catalogProblem` and asks for
  nothing of the clone, and `apply` and the terminal refuse, when the clone is not of the Catalog
  that the Manifest names. The clone matches by `repo:` of its `bundles.yaml` or by the name that
  the caller found it with (`catalogAs`: the setting of the mod, or its `origin`).
- The name is text that another person can write, and the mod clones it on a read. Only
  `owner/name` of GitHub is accepted: no leading `-`, no `.` or `..` part.
- The mod keeps the clones of a read with the project (`proj.clones`) and with its offer. A
  change uses them, not the Catalog of a later focus.
- The person's own clones are a table in the settings (Catalog name → folder). The old setting
  stays as the own clone of the default Catalog. **Clone URL** is of the default Catalog only.
- The mod writes `catalog:` only when the Catalog is not the default one, and keeps a key that
  is there. So the files of projects that use the default Catalog do not change.

## Consequences

- Every tool that reads `skills.yaml` must follow the key. The `colibri-skills` wizard of
  `agents-instructions` keeps unknown keys but does not read this one yet: it would link a project
  of another Catalog to its own clone.
- A Catalog that is not on GitHub needs a row in the table of own clones.
