/** `tawny ...` with plain args, optionally followed by one quoted heredoc as stdin and nothing after it. */
export function isTawnyCall(cmd: string) {
  const i = cmd.indexOf('<<');
  const head = (i < 0 ? cmd : cmd.slice(0, i)).trim();
  if (!/^tawny( [^;&|`$()<>\n]*)?$/.test(head)) return false;
  return i < 0 || /^<<-?\s*(['"])(\w+)\1[^\n]*\n(?:[\s\S]*\n)?\2\s*$/.test(cmd.slice(i));
}
