// Terminal link handler for Files (Markdown): Ctrl/Cmd-clicking a Markdown file opens it in a dialog,
// preserving optional :line / #L5 coordinates from Herdr 0.1.18.
import { openOverlay, shared } from "herdr";

const kitOff = () => {
  const v = shared("herdr-mods.disabled");
  return Array.isArray(v) && v.includes("files-md");
};

export function handleLink(click) {
  if (kitOff()) return "pass";
  const { link, source } = click ?? {};
  if (link?.kind !== "file" || !link.path) return "pass";
  openOverlay({
    mod: "files-md",
    kind: "dialog",
    width: 900,
    height: 0.85,
    props: {
      openFile: link.path,
      openOn: source?.machine ?? null,
      line: typeof link.line === "number" ? link.line : null,
      column: typeof link.column === "number" ? link.column : null,
    },
  });
  return "handled";
}
