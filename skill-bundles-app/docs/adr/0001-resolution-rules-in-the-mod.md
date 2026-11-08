# The mod has its own copy of the resolution rules

The PowerShell scripts of the Catalog (`Install-Skills.ps1`, `Init-Skills.ps1`, `Configure-Skills.ps1`, `Add-Skill.ps1`, `Skills.Common.ps1`) read `bundles.yaml` and `skills.yaml`, resolve the Bundles into skills and find the Extra skills. The `skill-bundles` mod does the same in JavaScript and calls only `npx skills`, because the mod must work on macOS, where `pwsh` is not installed, and because the Catalog repository must not hold Herdr mods. For a time, the same rules are in 2 places, and a change of the rules must be made in both.

The plan is to unify this: in the future, the mod is the only tool, and the PowerShell scripts are removed from the Catalog.

## Consequences

- Keep the two parsers the same: the mod reads the YAML line by line with the same patterns as `Read-ProjectManifest` and `Read-BundlesCatalog`, not with a full YAML library. A file that the scripts read must give the same result in the mod.
- The mod writes `skills.yaml` in the same form as `Configure-Skills.ps1` and `Add-Skill.ps1` (comments are not kept).
- Before the scripts are removed, the mod must also cover what only the scripts do now: the git hook (`Install-Skills.ps1 -Silent`) and `Update-AllSkills.ps1` for all projects under a folder.
