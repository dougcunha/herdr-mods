// Terminal link handler for Image Viewer: Ctrl/Cmd-clicking an image path opens it in a dialog.
import { openOverlay, shared } from "herdr";

const kitOff = () => {
  const v = shared("herdr-mods.disabled");
  return Array.isArray(v) && v.includes("image-viewer");
};

export function handleLink(click) {
  if (kitOff()) return "pass";
  const { link, source } = click ?? {};
  if (link?.kind !== "file" || !link.path || source?.machine) return "pass";
  openOverlay({
    mod: "image-viewer",
    kind: "dialog",
    width: 920,
    height: 0.85,
    props: { file: link.path, fileOn: null },
  });
  return "handled";
}
