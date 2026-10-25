# Debugging

Breakpoints, stepping, variables and a debug console for JavaScript (Node) and Ruby, over the Debug Adapter Protocol. Node uses Microsoft's js-debug (fetched into `vendor/js-debug` on `npm install`, or run `npm run fetch:js-debug`); Ruby uses the `debug` gem's `rdbg` (bundled with Rails 7+, otherwise `gem install debug`).

## JavaScript (Node)

1. Open the `.js` file.
2. Click the gutter left of a line number to set a breakpoint (red dot). `f9` toggles one at the cursor.
3. Press `f5`. The debug panel opens; the config picker shows `Run <file> (Node)`.
4. Execution pauses on the breakpoint. The line is highlighted; the call stack and variables fill in.
5. Inspect values: hover a variable in the editor, expand objects in **Variables**, or type an expression in the console input and press `enter`.
6. Step with `f10` (over), `f11` (into), `shift+f11` (out); `f5` continues.
7. `shift+f5` stops the session.

For a custom entry point or arguments, add `.vscode/launch.json`; it then appears in the config picker:

```json
{ "configurations": [
  { "type": "node", "request": "launch", "name": "Server",
    "program": "${workspaceFolder}/src/index.js", "args": ["--port", "3000"] }
] }
```

## Ruby

1. Open the `.rb` file.
2. Set a breakpoint in the gutter.
3. Press `f5`. The picker shows `Run <file> (Ruby)`, which runs `ruby <file>` under `rdbg`.
4. Inspect and step as above.

For Rails or any other command, add a config to `.vscode/launch.json`, pick it in the panel and press `f5`. Program output appears in the debug console.

```json
{ "configurations": [
  { "type": "rdbg", "request": "launch", "name": "Rails server",
    "script": "bin/rails s", "cwd": "${workspaceFolder}" }
] }
```

## Shortcuts

| | |
|---|---|
| `f5` / `shift+f5` | start or continue / stop |
| `f9` | toggle breakpoint at the cursor |
| `f10` / `f11` / `shift+f11` | step over / into / out |
| `cmd+shift+p`, type `Debug` | every debug command (pause, remove all breakpoints, toggle panel, …) |

## Details

- **Conditional breakpoints and logpoints**: right-click a line → *Add Conditional Breakpoint…* (pauses only when the expression is true) or *Add Logpoint…* (prints a message instead of pausing; `{expr}` interpolates).
- **Call stack**: click a frame to inspect its variables and jump to its file.
- **Hollow breakpoint**: the debugger couldn't bind it (file not loaded yet, or not an executable line).
- **Save first**: breakpoint lines match the file on disk.
- **Config variables**: `${workspaceFolder}`, `${file}`, `${fileBasename}`, `${fileDirname}`, `${relativeFile}`, `${env:NAME}`.
- **Ruby attach**: `{ "type": "rdbg", "request": "attach", "port": 12345 }` connects to a process started with `rdbg --open --port 12345`.
- **Limits**: programs run with js-debug's `internalConsole` (`integratedTerminal` / `externalTerminal` are ignored; output goes to the debug console); Ruby launches don't stop on entry; reloading the window stops the session.
