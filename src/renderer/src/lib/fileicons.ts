interface Icons {
  dirs: Record<string, string>;
  dirsOpen: Record<string, string>;
  files: Record<string, string>;
  ext: Record<string, string>;
  folder: string;
  folderOpen: string;
  file: string;
}

declare global {
  interface Window {
    harborFileIcons: Icons;
  }
}

/** Catppuccin icon file for a tree entry: exact file/folder name first, then the longest matching extension. */
export function iconFor(name: string, type: 'file' | 'dir', open?: boolean): string {
  const I = window.harborFileIcons;
  const n = name.toLowerCase();
  if (type === 'dir') return (open ? I.dirsOpen[n] : I.dirs[n]) || (open ? I.folderOpen : I.folder);
  if (I.files[n]) return I.files[n];
  for (let i = n.indexOf('.'); i !== -1; i = n.indexOf('.', i + 1)) {
    const hit = I.ext[n.slice(i + 1)];
    if (hit) return hit;
  }
  return I.file;
}

export const iconSrc = (name: string, type: 'file' | 'dir', open?: boolean) =>
  `fileicons/${window.harborTheme.name}/${iconFor(name, type, open)}.svg`;
