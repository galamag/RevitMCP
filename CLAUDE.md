# RevitMCP

A custom MCP server and plugin for Autodesk Revit 2027.3 that let Claude create elements in a model, not just read it.

**First goal:** Claude builds a two-storey 300 m² cottage in Revit from scratch, with a livable floor plan and a good-looking 3D view.

Current status lives in the vault note `План разработки`, not in this file.

## Language

- Talk to the user in Russian.
- Everything in the repository is in English: code, comments, MCP tool descriptions, commit messages, documentation, and all Claude configuration (`CLAUDE.md`, agents, settings).
- Revit data keeps its own language: family and type names are Cyrillic and must survive the whole pipeline intact.
- Building designs in `designs/` are project output for the user, so their labels are in Russian.
- Obsidian vault notes are in Russian.

## Architecture

```
Claude ⇄ MCP server (outside Revit) ⇄ local socket ⇄ C# plugin (inside Revit) ⇄ Revit API
```

## Decisions

- We build our own. The official Revit MCP is read-only, so it is out.
- GitHub projects are reference material only. Their code does not go into Revit.
- Commands run on the Revit main thread through `ExternalEvent` and `IExternalEventHandler`.
- Each operation runs in one transaction, so it can be reverted with Undo.
- The MCP server is written in TypeScript. The plugin is C#.
- The plugin and server talk JSON-RPC over a local-only connection, with a token and a request ID on every call.
- No arbitrary code execution tool for now. If ordinary tools fall short, add it later, disabled by default.

Full history: the `Журнал решений` note in the vault. Open questions: the `Открытые вопросы` note. Do not decide open questions alone, discuss them with the user.

## Hard rules

1. **The user decides.** Confirm anything meaningful, and ask before actions that are hard to undo.
2. **Never invent context.** If you do not know a file, API or signature, look it up or ask. Check Revit members against `RevitAPI.xml` and `RevitAPIUI.xml`.
3. **Never expand scope.** One task is one patch. Report other problems separately and wait for a go-ahead.
4. **The core is protected.** Do not change threading, transaction or protocol code without an explicit request. The protected files:
   - `src/plugin/RevitMCP.Bridge`: `Framing.cs`, `RequestQueue.cs`, `RequestStore.cs`, `BridgeServer.cs`
   - `src/plugin/RevitMCP.Commands/Dispatch`: `CommandHandler.cs`
   - `src/plugin/RevitMCP.Commands/Revit`: `Operation.cs`, `DialogGuard.cs`, `FailureCollector.cs`, `UndoHistory.cs`, `UndoTracker.cs`

   Any change that alters `RevitMCP.Plugin.dll`, including the `PluginHost.Start` or `Stop` signatures, makes Revit ask the user for Always Load again.
5. **Verify after changes.** Build, run the tests, and exercise plugin changes in live Revit. If you cannot verify something, say so. Claude may restart Revit for this, but only when every open document is saved in `%USERPROFILE%\Documents\RevitMCP`, and never by killing the process.
6. **Install nothing without consent.** Keep dependencies to a minimum and prefer what Node and .NET already provide. Before adding an npm or NuGet package, check GitHub Advisory Database and make sure the version is at least 14 days old unless it is a security fix. Pin exact versions and commit lock files. npm install scripts stay off. Verify downloaded programs by SHA-512 from two official sources and by digital signature before running them.
7. **Do not copy code from other projects.** Ideas only, and only with a checked license.

## Revit traps

- Modal Revit dialogs block command execution.
- The Revit API may only be called from the main thread in a valid context.
- Revit's internal units are feet, while we work in metres and millimetres.
- Revit must be running with the plugin loaded, otherwise MCP tools do not work.
- `UseRevitContext` defaults to `True`, which puts the add-in in the shared context. Dependency isolation requires setting it to `False` explicitly.
- `Transaction.Commit` can return `RolledBack` without an exception. Always check the status.
- Models can be in Russian: look things up by ID and `BuiltInParameter`, not by localized names.
- The Wall tool in the Revit UI makes two real undo steps, `Set up wall tool` and `Wall - Line`.
- A wall's bounding box can keep an old height after a roof cuts it, so read `topMm`.
- A dialog the guard refuses can make a Revit call return null instead of throwing, as `OpenAndActivateDocument` did on a locked file.

## Environment

- Revit 2027.3 (27.3.0.28): `C:\Program Files\Autodesk\Revit 2027`, which also holds `RevitAPI.dll`, `RevitAPIUI.dll` and the API descriptions `RevitAPI.xml`, `RevitAPIUI.xml`.
- Revit 2027 runs on .NET 10, so the plugin targets `net10.0-windows`. .NET SDK 10.0.403 is installed.
- User add-in folder: `%APPDATA%\Autodesk\Revit\Addins\2027`. The all-users folder is now under `C:\Program Files`, not `ProgramData`.
- Family library: `C:\ProgramData\Autodesk\RVT 2027\Libraries\Russian`. It is the only real content set installed. Russian project templates are in `C:\ProgramData\Autodesk\RVT 2027\Templates\Russian`.

## Build and run

Run `dotnet` from the repository root and `npm` from `src/server`.

- After a fresh clone: `dotnet restore --locked-mode` and `npm ci`. npm install scripts stay off through `src/server/.npmrc`.
- Build the plugin and the .NET tests: `dotnet build RevitMCP.sln`. It must end with 0 warnings and 0 errors.
- Build the MCP server: `npm run build`. `.mcp.json` starts the result, `src/server/dist/index.js`, so rebuild after changing the server.
- Type check, tests included: `npm run typecheck`.
- Unit tests: `dotnet test RevitMCP.sln` and `npm test`.
- Deploy the plugin and restart Revit: `powershell -NoProfile -ExecutionPolicy Bypass -File scriptsestart-revit.ps1`. It builds with `-p:DeployToRevit=true`, and it closes Revit only when `npm run revit:can-close` passes, so call `save_project` first. If it stops by timeout, a Revit dialog is probably waiting: do not retry, look at Revit.
- Live tests: `npm run test:live`. They need a running Revit with the plugin loaded. Each file creates a new project in `%USERPROFILE%DocumentsRevitMCP`, leaves it open and saved, and `box.live.test.ts` keeps its snapshots in `task14-acceptance` there.
- Reopen check: a live run prints `to check the reopen after a restart, set REVITMCP_REOPEN_NAME=<name>`. Restart Revit with the script, then run `$env:REVITMCP_REOPEN_NAME = '<name>'; npm run test:live` in PowerShell. Without that variable `reopens after a restart with the name intact` is skipped.

## Subagents

Defined in `.claude/agents/`. The main session orchestrates them. Suggest them when useful, and do not spawn them unprompted for trivial work.

**Development**

| Agent | Model | Role | Writes |
|---|---|---|---|
| `sniper` | Opus | Architecture, 3+ files, protected core | Code |
| `debugger` | Sonnet | Errors, journals, fixes in 1-2 files | Code |
| `reviewer` | Opus | Audits patches before commit | Nothing |
| `tester` | Sonnet | Runs tools in live Revit on a test model | Nothing |
| `documenter` | Sonnet | Maintains the vault | Vault only |

**Building design**

| Agent | Model | Role | Writes |
|---|---|---|---|
| `architect` | Opus | Exact plan with dimensions | `designs/<slug>/plan.md` |
| `designer` | Sonnet | Materials, families, furniture, views | `designs/<slug>/materials.md` |
| `builder` | Sonnet | Builds from the plan | **The Revit model, and it alone** |
| `inspector` | Opus | Checks the model against the plan | Nothing |

Order: the main session creates an empty project and writes `catalog.md` with its real types and materials, then `architect`, then `designer`, then the user approves the plan, then `builder`, then `inspector`. The main session leaves the model active before `inspector` starts, because `inspector` cannot open a project. `builder` never starts before that approval. The user does not know Revit, so show the floor plan drawing (`plan.svg`) rather than Revit terms.

Revit runs commands one at a time, so only `builder` writes to a building model, and `tester` writes only to its own disposable models. Give `inspector` the plan and the model, never the architect's reasoning.

## Workflow

Spec, then plan with tasks, then a `feat/...` branch. Each task goes to a subagent, followed by `reviewer`, and by `tester` when it touches Revit behaviour. Specs and plans live in the vault under `Архитектура/`. Run ledgers live in `.superpowers/`, which is not committed.

## Git

- Branches: `feat/...`, `fix/...`. Keep history linear.
- Commit messages follow Conventional Commits, in English.
- Local commits need no confirmation. **Never push without explicit confirmation from the user.**
- No `Co-Authored-By` lines. The user is the sole author, and this applies to all subagents and plugins.

## Vault

- Project Obsidian vault: `D:\GalaObsidian\RevitVault`.
- Record every decision in `Журнал решений`: date, decision, reason.
- Add new questions to `Открытые вопросы`, and move closed ones to the decision log.
- Record verified API facts in `Справочник Revit API` with their source.
- Session summaries go to `Сессии/` as `YYYY-MM-DD-topic.md`.
