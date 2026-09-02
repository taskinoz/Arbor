// Shortens an absolute path under the user's home directory to a `~`-relative
// one for display. Never use this for values passed back to git/Tauri
// commands - those need the real absolute path.
export function toDisplayPath(path: string, home: string | null): string {
  if (!home) return path;
  if (path === home) return '~';
  if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  return path;
}
