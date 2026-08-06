# Blade-REPL

A VS Code extension for the [Blade language](https://github.com/cmdupuis3/Blade): live diagnostics, type hovers, navigation, deduction-aware code actions, Ionide-style type lenses, and an interpreter-backed REPL with inline results.

## Features & keybindings

| Feature | Surface | Keybinding / trigger |
|---|---|---|
| Fast check (parse + typecheck + deduce) | squiggles, hovers, lenses refresh | automatic while typing (~300 ms debounce, via `blade ide serve`) |
| Full check (+ monomorphization → concrete types) | hover/lens type upgrades | automatic on save / open / ~2 s idle; manual `Ctrl+Alt+Enter` (Blade: Check Current File) |
| Go to definition | editor | `F12` / `Ctrl+Click` |
| Peek definition | editor | `Alt+F12` |
| Find all references | references view | `Shift+F12` |
| Rename symbol | in-file rename | `F2` |
| Document outline / breadcrumbs | outline view | `Ctrl+Shift+O` |
| Quick fix: pin deduced comm/anticomm, annotate deduced rank | lightbulb | `Ctrl+.` |
| Signature lens (functions; arrays as `Idx<n> -> T`) | above-line lens | always on (settings toggles) |
| Deduction lens (`deduced comm(a, b) · storage — pin`) | above-line lens, clickable | click applies the pin |
| Type/keyword/builtin/provider hovers | hover | mouse hover |
| Signature help | parameter hints | `(` and `,` while typing a call |
| Completions (bindings, builtins, deduction pins) | IntelliSense | `Ctrl+Space` |
| Send selection/line to REPL (inline result) | REPL + inline decoration | `Alt+Enter` |
| Send file to REPL | REPL terminal | `Alt+Shift+Enter` |
| Notebooks (`.bladenb`): run cell / run all | notebook UI | `Shift+Enter` and the standard notebook keys |
| New notebook / open `.blade` as notebook | notebook editor | command palette |
| Restart notebook kernel (reset session) | notebook toolbar | command palette |
| Run file (full compile + run) | ▶ editor title button | — |
| Show generated C++ | side-by-side editor | command palette |
| Start / Reset REPL session | REPL terminal | command palette |

All navigation features land on VS Code's standard keys — no custom chords to learn beyond the three REPL/check bindings.

## Requirements

A built [Blade compiler](https://github.com/cmdupuis3/Blade). The extension auto-detects the most recently built of `bin/Release` / `bin/Debug` in the standard repo location, or `Blade` on PATH; override with `blade.compilerPath`.

- Compilers with the `ide serve` subcommand get as-you-type checking through a persistent process (two tiers: a fast parse+typecheck+deduce pass while you type, and a full pass through monomorphization on save/idle that upgrades polymorphic value types to their concrete instantiations).
- Older compilers fall back automatically: `ide check --json` on save/open, or plain-text diagnostics for compilers without the JSON subcommand.

## Notebooks

`.bladenb` files open as native VS Code notebooks. The format is plain Blade text with `// %%` cell markers (`// %% [markdown]` for prose cells), so the same file still runs under `blade run` and diffs cleanly in git. Cells evaluate with exact REPL semantics — an accumulating session, rebind-in-place, typed value echoes (`xs = [1.0, 2.0, 3.0] : Array<Float64 like Idx<3>>`), interpreter-first evaluation with a g++ fallback badge — on a dedicated `ide serve` process, so a slow cell never blocks typing-time checking. Cells also get the full IDE feature set: diagnostics, session-aware hovers and completions (names from earlier cells resolve), and type lenses. "Restart Kernel" resets the session; interrupting kills the evaluator and transparently replays the session on the next run.

## Settings

| Setting | Default | Effect |
|---|---|---|
| `blade.compilerPath` | `""` (auto-detect) | Path to `Blade.exe` |
| `blade.liveChecking` | `true` | As-you-type fast checks (requires `ide serve`) |
| `blade.fastCheckDebounceMs` | `300` | Typing debounce before a fast check |
| `blade.fullCheckIdleMs` | `2000` | Idle time before a full-tier check |
| `blade.checkOnSave` / `blade.checkOnOpen` | `true` | Full check on save / open |
| `blade.runTimeoutSeconds` | `180` | Timeout for `Blade run` (first runs invoke g++) |
| `blade.inlineReplResults` | `true` | Inline green/red REPL results at the evaluated line |
| `blade.signatureLens.functions` | `true` | Abstract signature lens above functions |
| `blade.signatureLens.arrays` | `true` | Index-arrow lens above array bindings (`Idx<n> -> Float64`) |
| `blade.deductionLens` | `true` | Deduced comm/anticomm + storage lens with one-click pin |

## Development

Zero dependencies, no build step — plain CommonJS executed by VS Code's Node runtime.

```bash
npm test
```

runs the hermetic suite (syntax gates, grammar/table consistency, provider tests against a vscode mock). Live suites need a built compiler (`BLADE_EXE` env var or the standard build locations): `npm run test:serve` (ide-serve protocol), `npm run test:repl` (REPL protocol), `npm run test:nav` (navigation providers against real compiler payloads), `npm run test:nb` (notebook eval session semantics).
