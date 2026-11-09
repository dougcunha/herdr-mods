# Skill Bundles

The words that the `skill-bundles` mod, its README and the scripts of a Catalog use for agent skills in a project.

## Language

### Files

**Catalog**:
A Git repository of agent skills with a `bundles.yaml` at its root.
_Avoid_: skills repo, skill store

**Bundle**:
A named group of skills of the Catalog, listed in `bundles.yaml`. The bundle `core` is in every project.
_Avoid_: pack, set

**Manifest**:
The `skills.yaml` of a project: the Bundles and the Sources that the project uses. It is committed with the project.
_Avoid_: config, skills file

**Source**:
One entry of `sources:` in the Manifest: a repository and skills from it that are not in a Bundle of the project.
_Avoid_: ad hoc bundle

**Lock**:
The `skills-lock.json` that `npx skills` writes in a project: the installed skills, where each came from and the hash of its folder.

### Skills in a project

**Extra skill**:
A skill that `npx skills add` installed in the project but that is not in the Manifest.
_Avoid_: orphan, ad hoc skill

**Local skill**:
A skill that a person wrote in the project by hand. It has no entry in the Lock. The mod removes it only when the person clicks **Remove** on it.
_Avoid_: custom skill

### States

**OK**: an installed skill of the Manifest that is the same as in the Catalog.

**Outdated**: an installed skill of the Manifest whose Lock hash is not the hash of its folder in the Catalog.

**Missing**: a skill of the Manifest that is not installed.

**Unchecked**: an installed skill from a repository that is not the Catalog. The mod cannot compare it.

**No manifest**: the project has no `skills.yaml`.
