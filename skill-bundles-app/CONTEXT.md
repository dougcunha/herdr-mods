# Skill Bundles

The words that the `skill-bundles` mod, its README and the link script use for agent skills in a project.

## Language

### Files

**Catalog**:
A Git repository of agent skills with a `bundles.yaml` at its root.
_Avoid_: skills repo, skill store

**Clone**:
The folder with a checkout of the Catalog, on the computer of the project (this computer, or the machine of a remote space). It is the only place where the skills have version control. It is the person's own clone (a setting) or, without that setting, a clone that the mod keeps in its cache.
_Avoid_: copy, checkout

**Bundle**:
A named group of skills of the Catalog, listed in `bundles.yaml`. The bundle `core` is in every project.
_Avoid_: pack, set

**Manifest**:
The `skills.yaml` of a project: the Bundles and the Sources that the project uses. It is committed with the project.
_Avoid_: config, skills file

**Source**:
One entry of `sources:` in the Manifest: a repository and skills from it that are not in a Bundle of the project.
_Avoid_: ad hoc bundle

**Source clone**:
A clone of a repository that is not the Catalog, which a Source (or an Extra skill) names. The mod keeps it in its cache (`cache/skill-bundles/sources/<owner>/<name>`). The mod fetches it on the timer but changes its files only when the person clicks **Update**.
_Avoid_: vendor, mirror

**Link**:
A directory junction (Windows) or a symbolic link (macOS, Linux) in an agent folder of a project (`.agents/skills`, `.claude/skills`, `.codex/skills`) that points to the folder of one skill in the Clone (or in a Source clone). A project has no files of a linked skill: it reads the clone.
_Avoid_: shortcut, install, copy

**Exclude block**:
The lines that the mod writes into `.git/info/exclude` of a project, one for each Link. Git does not see the Links, and the block is the record of the Links that the mod made.
_Avoid_: gitignore block

**Link script**:
`link-skills.mjs`: one Node file without dependencies that reads a project and makes its Links. The mod runs it, and a person can run it in a terminal from the Clone.

**Lock**:
The `skills-lock.json` that `npx skills` wrote in a project, before the mod used Links. The mod reads it only to find Copies.

### Skills in a project

**Linked skill**:
A skill that the project gets through a Link.

**Extra skill**:
A Linked skill that is not in the Manifest (a skill added for one task, or a project without a Manifest).
_Avoid_: orphan, ad hoc skill

**Local skill**:
A real skill folder that a person wrote in the project, or a link that the mod did not make. The mod removes it only when the person clicks **Remove** on it.
_Avoid_: custom skill

**Copy**:
A real skill folder that `npx skills` installed (it has a Lock entry). The mod changes it to a Link on the first action in the project.

**Backup**:
`.agents/skills-backup/<skill>`: where the mod moves a real skill folder that it replaces by a Link when it cannot prove that the folder has no changes of the person.

### States

**Linked**: the Links of the skill are there and point to the Clone.

**Missing**: the Manifest asks for the skill, but a Link is not there (or points to another place).

**Stale**: a Link that the mod made, but the Manifest no longer asks for the skill, or the Clone no longer has it. The mod offers to remove it.

**Copy**: see above. It counts as work to do.

**Conflict**: the Manifest asks for the skill, but the project has a Local skill (or a Copy that Git tracks) with that name. The Local skill wins until the person clicks **Replace by link**.

**Not in the Clone**: the Manifest asks for a skill that the Clone does not have.

**Not cloned**: a skill of a repository that is not the Catalog, and the mod has no Source clone of that repository yet (or could not clone it).
