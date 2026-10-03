# Change Log

All notable changes to the "vscode-mcp-server" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.20.28] - 2026-10-03
### Fixed
- The agent guide still advertised the parameters 0.20.27 removed. `session_bootstrap_code(memory, guide, skills, layout, workspace)` and `get_project_context_code(depth, includeDeps, includeScripts)` named four and three flags that the schemas no longer have — a model following the guide would pass `memory: false`, have it stripped as an unknown key, and receive the whole memory section it believed it had skipped. The catalog lines now name `sections`, with the enum spelled out. Guide version 12 to 13.
- The `diff_preview_code` recipe was wrong twice over, and predates 0.20.27. It read `diff_preview_code(op="edit", path, old_string, new_string)`: the enum is `replace_lines | create | move | rename`, so `"edit"` was not a value, and `old_string`/`new_string` were never parameters — the tool takes line ranges and content, mirroring `replace_lines_code`. It now reads `diff_preview_code(op="replace_lines", path, startLine, endLine, content)`.

### Added
- The guide catalog is checked against the schemas. Every parameter named in it must exist in that tool's real schema, and every quoted literal must be a value that parameter's enum actually accepts — the two mistakes above were both invisible to the suite, which only counted tools. The hand-maintained catalog cannot drift from the registry again without a red test. Guide costs no payload, so this costs nothing to run.

## [0.20.27] - 2026-10-03
### Fixed
- `get_project_context_code` advertised `includeDeps` and did nothing with it. The parameter existed in the schema and nowhere else — no handler destructured it and the function it feeds does not accept it — so a model asking for `includeDeps: false` got the dependency summary anyway. Removed.

### Changed
- Eight boolean flags that all defaulted to true became two `sections` parameters. `session_bootstrap_code` takes `sections: ["memory","guide","skills","layout"]` and `get_project_context_code` takes `sections: ["scripts","config","readme"]`; omitting either returns everything, which is exactly what four `true` defaults expressed. A parameter whose only job is to switch something off, when it is on by default, reads as a list wearing a disguise, and one enum states the choices better than four switches. Tests pin the default, a single selection, and a multi-part selection. `tools/list` is 26,467 of 26,600 tokens: 403 characters, 0.38 %, measured rather than estimated — the first draft of the replacement text gave the saving straight back in prose.
- The phase A spec records what the shortened `workspace` description did under a real client. Mammouth discovered `list_workspace_folders_code` unprompted and passed the folder name across four consecutive calls with no retry, so the 38-character description suffices. It never read the agent guide at all, which fixes the rule the spec now carries: teaching may move to the guide, semantics may not.

## [0.20.26] - 2026-10-03
### Changed
- The `workspace` parameter stopped repeating where to look up its own values. Seventy-six tools carried `See list_workspace_folders_code.` — teaching, not a schema constraint, and the agent guide exists precisely so teaching costs no payload. The description drops from 71 to 38 characters, and the guide's `list_workspace_folders_code` entry now names itself as the source of the folder names and 1-based indexes, so the knowledge moved rather than disappeared. The long description stays on `list_workspace_folders_code`, the one tool that defines the semantics. `tools/list` is 26,567 of 27,200 tokens, down 627: 2,508 characters, 2.3 %. No capability removed and no tool wording changed.

### Closed
- The phase A payload spec's central recommendation turned out to be already done, and its success criterion unreachable. Commit `ecf789b` had shortened this very description six weeks before the spec was written, and measurement shows the 128 parameters unique to a single tool are worth 14.2 % of the payload in total: removing every one of them recovers less than the 15 % the spec promised, so the target could only have been met by stripping capabilities and calling it optimisation. The spec now carries measured figures, records the arithmetic, and states an honest ceiling near 3 %.

## [0.20.25] - 2026-10-03
### Fixed
- Tool-call counters still reset on every restart; 0.20.24's awaited save repaired the wrong thing. The counters were written in `deactivate` and nowhere else, and a `globalState` update issued while the window is closing never reaches the database. The audit log settles it: it writes through the identical `context.globalState.update`, un-awaited and on every single event, and it survives restarts — so the difference was never the `await`, it was the moment. Counts are now persisted as the session runs, throttled to one write per two seconds, with the awaited shutdown save kept as the backstop for the last two seconds of a session. A test pins that one recorded call reaches the store with no shutdown involved, and a second pins that a burst collapses into a single write still carrying every call.

## [0.20.24] - 2026-10-03
### Fixed
- Tool-call counters never survived a reload, despite 0.20.20 labelling them "across sessions". The store was wired and the save ran, but nothing waited for it: `globalState.update` is asynchronous, `saveUsage` fired it and returned, and the extension host could be gone before the write reached the main process. The installation itself carried the proof: `state.vscdb` holds this extension's `authToken` keys, written once at activation and read back on every start, while `usage.counts` — written only in that deactivation window — appears zero times after a reload, and the counter restarts at zero every session. `saveUsage` is now awaited by `deactivate`, an async store is awaited before `saveUsage` resolves, and a test pins that an intentionally slow store still flushes before the call returns.

## [0.20.23] - 2026-10-03
### Fixed
- `get_server_info_code` printed `Platform` twice. The header carried `- Platform: win32` and the runtime section repeated `Platform: win32` two lines below — `RuntimeFacts.platform` was initialised from `process.platform` and never reassigned, so the two lines could never disagree. The field left `RuntimeFacts` entirely, the header line stays, and the shell test now counts occurrences instead of merely requiring one.
- The same block read `CWD: D:\Program Files\Microsoft VS Code` — the extension host process directory, where no tool call and no shell command resolves anything. It now says `Extension host CWD:`, so a model cannot mistake it for the directory its commands run in.
- The binary verdict conjugated for a crowd that was not there. One missing tesseract produced "the tools that need them will refuse ... until they are installed"; it now reads "need it ... until it is installed", and several missing binaries keep the plural. Two tests pin each side.

## [0.20.22] - 2026-10-02
### Changed
- The extension ships one bundled file instead of 4,254. esbuild bundles `src/extension.ts` into `dist/extension.js` — 1.6 MB, minified, node20/cjs, `vscode` external — and `node_modules` and `out/` are no longer packaged, so express, the MCP SDK and zod ride inside the bundle rather than as 4,123 files on disk. `main` points at the bundle and `compile` builds both halves, so `vscode:prepublish` and `pretest` always package a fresh one. A smoke test requires the bundle from inside the extension host and asserts it still exports `activate` and `deactivate`: the suite alone never loaded the shipped entry point.
- The vsix is 1.31 MB instead of 8.45 MB, and 11 files instead of 4,254. `media/demo.mp4` (2.3 MB) was packaged and referenced by nothing — not the README, not the code — so it is gone; the marketplace icon stays. The sourcemap is still generated but no longer ships: with `sourcesContent` it embedded 436 sources for 4.5 MB, without it 1.5 MB, so it stays on the developer's machine and the package carries the code alone.

## [0.20.21] - 2026-10-01
### Added
- `get_server_info_code` reports the machine's binary picture. One call now answers which PDF routes can actually run: pdftotext, pdfinfo, pdftoppm, tesseract and Git Bash, each with its resolved path, or when missing, the same install hint that would otherwise surface as a failed tool call — tesseract with the working `winget install UB-Mannheim.TesseractOCR` id. The probe runs `where.exe` on Windows and `command -v` elsewhere, off the event loop, with the usual Windows install locations as fallback. The binary knowledge the OCR and render tools already carried — fallback directories, git-bash discovery, the poppler hint — moved to `utils/binaries.ts`, so the doctor and the error messages cannot drift apart.

### Changed
- A missing-binary error now ends by naming `get_server_info_code`, so one call tells the whole story instead of the next tool failing the same way. The tools/list payload is unchanged at 27,194 of 27,200 tokens: no tool was added and no description moved.

## [0.20.20] - 2026-10-01
### Fixed
- The first `get_server_info_code` of a session froze the whole extension host for up to four seconds. `detectRuntimeFacts` probed python through `execFileSync`, so every extension in the window stalled while python started. The probe runs once per session and both suites that call the handler share one process, so whichever paid it first was the one that lost its test to the two-second mocha budget — which is why the same flake read `server info shell report` in 0.20.17 and `usage-never-called` in 0.20.19. It now runs through `execFile` on a promise cached for the session, and both suites prime it in a `suiteSetup` hook.
- `edit_file_code`'s intermittent failure had a third cause, and none of the three were timing in the code under test. `replace_all changes every occurrence` opens a real document through VS Code's API, and the helper that deletes its temp directory then hit `ENOTEMPTY` on Windows: a file watcher or scanner touches the directory while the recursive delete walks it. Five test helpers cleaned up that way, and `node`'s `rmSync` has `maxRetries` and `retryDelay` for precisely this race; all five now pass them. The two-second test budget was left untouched, because it was never the problem.
- Tool-call counters survive a window reload. `usage.ts` stays free of `vscode` imports: an injected load/save pair merges stored counts on activation and flushes the map in `deactivate`, the same shape as the audit log. The two lines that said "since activation" now say "across sessions", because that is what they count.

### Changed
- `tools/list` payload is 27,194 of 27,200 tokens. No tool was added or removed; the description change that freed one token says "across sessions" where it meant it.

### Closed
- The `fetch failed` reports from 28 September, open since 0.20.17, are explained by logs rather than by code. Across all fifteen retained sessions, 27 September to 1 October, the server starts exactly once per window on `127.0.0.1:3400`, with no `[cluster] SPOKE`, no `EADDRINUSE` and no election — including the sessions after 0.20.17 that instrument exactly that path, and the one on 1 October that was restarted three times. On the day itself the server served remote clients until a `render_pdf_pages_code` call, then went quiet until deactivation, logging no error; the server logs every request it receives, so the failing requests never arrived and the spoke hypothesis is discarded. What remains is transport: restart windows the logs do show — 13 seconds on 1 October at 20:51, a deactivate, reactivate and toggle sequence — and a client-side socket reset on multi-megabyte `render_pdf_pages_code` replies. The mitigation is a retry in the client, not a change here.

## [0.20.19] - 2026-10-01
### Fixed
- `ocr_pdf_code` with `engine: "auto"` now reads the PDF's text layer before reaching for OCR. The flow was one-way to tesseract: every call rasterized the document, ran OCR on it, and the text layer — which `pdftotext` already extracts verbatim, faster and without OCR noise — was never consulted. With `auto`, `pdftotext` runs first; when most requested pages carry usable text, the extraction comes back directly, the scanned minority is marked with the next call to make, and the Ollama probe never happens. The per-engine page cap now sits after the fast path, so it only bites the raster path; an explicit `"tesseract"` call takes the old road unchanged. Runtime hint added to `pdf_needs_ocr_code`'s verdict when text was found. Guide version 11 to 12.
- `render_pdf_pages_code` reads the page count before rasterizing, not after. The old order spent the client time budget on `pdftoppm` first and then tried to fit `pdfinfo` into whatever was left, so the one number that tells a model whether it is looking at page 2 of 2 or page 2 of 130 was exactly the one dropped on large documents — the calls most likely to be slow. The count is now read first with a bounded budget; only a genuinely spent budget still reports the total as unknown, and the wording distinguishes that from a missing `pdfinfo`.

### Changed
- Tool descriptions of the three PDF tools name the text-layer route so a model picks `engine: "auto"` without having to read the guide. The tools/list payload is 27,195 of 27,200 tokens.

## [0.20.18] - 2026-09-30
### Fixed
- Refusing a binary now ends with the call to make. A client handed a model ten tools, three of them PDF readers; the model called `read_file_code` on a PDF, received a refusal naming all three readers, and reported that the document was unreadable. Every other redirect this server emits is syntactic — compaction ends with `[@vscode-mcp: ... retrieve_output_code "handle"]` and `diff_preview_code` ends with the exact call that applies the diff — while the PDF refusal was prose. It now ends the same way, carrying the real path. `read_file_code`'s description names `ocr_pdf_code` and `render_pdf_pages_code` outright instead of promising "a pointer to the tool that reads it", which meant the destination could only be learned by failing first.
- The conversation opener has a fallback. Five places named `session_bootstrap_code` and none named an alternative, so a client that omitted the opener from its callable list left every instruction the model could read pointing at a tool it did not have, while `get_agent_instructions_code` sat available and unmentioned. All five name the fallback now. Guide version 10 to 11. The guide body costs no payload, being returned by a tool call rather than carried in `tools/list`, so `get_agent_instructions_code` was rewritten shorter to pay for naming the readers.
- `get_server_info_code` reports registered tools that were never called. The usage line listed only the tools that had been called, so the number needed to judge a 91-tool registry — which of them have never been touched — was the one number the output could not express. The line subtracts the called set from the registered one; both halves already existed, `callCounts` in `usage.ts` and the registered names behind `_registeredTools`. The catalog follows the registry rather than the static `TOOL_HINTS` list, so it agrees with `enabledTools`: with the `ocr` group off the three PDF readers leave the catalog although all three remain in `TOOL_HINTS`.

### Changed
- `get_server_info_code` keeps an empty input schema, so the tools/list payload is unchanged at 27,190 of 27,200 tokens. The never-called list is bounded at 20 names, alphabetical so two readings diff cleanly, and the line is omitted when nothing is missing.

### Not fixed
- Two tests fail intermittently on timing alone: `edit_file_code`, and the `server info shell report` timeout. Both predate this work and neither has been investigated. A suite that goes red without a code change undermines the revert-before-accept discipline the rest of this entry depends on.
- The usage counters live in memory and reset on a window reload. Enough to spot dead weight in a day's work, not enough to justify removing tools from the registry; across users that is a telemetry decision.
- A client still selects a small subset of the registered tools and can leave out the ones a task needs. Nothing in this release changes that, and it happens before any of this code runs.

## [0.20.17] - 2026-09-30
### Fixed
- The api key commands are registered when the extension activates, not when the module loads. `copyApiKeyCommand` and `generateApiKeyCommand` sat at module scope, so `vscode.commands.registerCommand` ran at import, outside the `try/catch` in `activate()`, and a second load of the module threw `command 'vscode-mcp-server.copyApiKey' already exists`. A throw at that point is worse than a red test: it kills the extension before activation, so there is no status bar, no server and no message, because the handler that would report the failure has not been reached yet. Both now register inside `activate()`, beside the six that already did.
- Five tests in `extension.test.ts` had not run since 0.20.11. The throw above came from the mocha `before each` hook, and mocha abandons an entire suite when that hook fails, so the "1 failing" reported for nine releases was the hook and the five tests underneath it were never executed. One of them asserted `statusBarItem.command === 'showServerInfo'`, a value the code has never set, and nothing had caught it. The fixture was also incomplete: the `./server` stub did not supply `refreshApiKeyCache`, so `activate` threw on every call, and `createMockContext` returns `undefined` from `globalState.get` for every key, so no test could start a server and the assertions expecting a live port in the status bar could not have passed either. The fixture is complete and the suite runs: 225 pass, 0 fail. Each fix was reverted in a scratch copy first, since a test that passes against the broken code tests nothing.
- The server can no longer start twice and leave one copy silently forwarding over HTTP. `configChangeListener` stopped the server and started a replacement with no mutex and no generation check, and it reacts to `enabledTools`, `port` and `host`, so two changes close together both read the same `mcpServer`, both stopped it, and both started a new one. Two `MCPServer` instances then raced for port 3400, and the loser took `EADDRINUSE` and joined the cluster as a spoke, from which point every tool call for that window's folders was forwarded over HTTP to the hub. Restarts are chained and carry a generation; a superseded restart returns before touching the server, checked before the stop and after it, which is where the window was open. `toggleServerState` invalidates the generation and waits for the chain.

### Changed
- Becoming a spoke logs `[cluster] SPOKE` with the port, the extension version and what the forwarding means, replacing a line that only reported that a window had joined. One grep now separates a window that deliberately joined another window's hub from a window that lost the port to another instance of its own server.
- `AUDIT-EXTENSION.md`, `.freebuff/` and `.vscode-test.mjs` are no longer packaged into the VSIX. The tools/list payload is unchanged at 27,189 of 27,200 tokens: no tool was added or removed.

### Not fixed
- The `fetch failed` reports from 28 September are still unproven. The `copyApiKey` fault was never a transport fault, since registering a command does not produce `EADDRINUSE`, and the restart race is now the documented way into the spoke path. But no session has yet shown `[cluster] SPOKE` on a window that should have been hosting. That log line settles it either way: confirmed if it appears, discarded if it never does.
- `PAYLOAD_CEILING` is a local assert in `schema-weight.test.ts`, not a client limit, so the 11-token margin quoted in 0.20.16 was a house rule presented as an external constraint. The real ceiling is the ~100 tool cap. The audit has been corrected; the threshold itself is unchanged.
- The test suite cannot run from a checkout whose path contains a space, because the extension host receives the development path unquoted. This is why 0.20.16's "215 tests pass" could not be reproduced from this checkout without copying the tree elsewhere, and it is worth knowing before a red run is read as a regression.

## [0.20.16] - 2026-09-28
### Fixed
- The already-delivered guide state belongs to the server that sent it. `deliveredGuide` was a module-level variable, so every server registered in one extension host shared it. A second server, which happens when the extension activates twice, answered `session_bootstrap_code` with the "already sent" notice on its very first call although it had never sent the guide, and the model on that side got no catalog and no way to know it was missing. The state is now a closure per registration, so a server only reports a guide it sent itself. The regression test drives two independently registered servers and asserts the second one carries the catalog.

## [0.20.15] - 2026-09-28
### Fixed
- The agent guide is sent once per session instead of once per call. `session_bootstrap_code` returned the full 91-tool catalog on every call, and one conversation called it three times with `guide: true`. A second call in the same VS Code session now returns a two-line notice naming the version and pointing at `get_agent_instructions_code`, so the model can get the catalog back if it is not in context. A guide whose content actually changed is sent again, so a version bump or a different `vscode-mcp-server.agentInstructions` value re-delivers it.
- `search_workspace_code` searches a file when `path` names one, instead of refusing. The parameter was already documented as "Directory or file to search in" and the tool rejected every file, so a caller who knew the file had to fall back to the directory and lose the narrowing. Four calls were spent on this in one session, each returning the same refusal. A named file is searched on its own and `glob` is ignored for it, because a caller who names a file does not want it filtered away.

### Changed
- The `search_workspace_code` description lost two sentences that repeated what the tool already carries: that the tool is read-only, which the `readOnlyHint` and the guide legend both state, and a long form of the cap advice. This buys the headroom the new file behaviour needed. The tools/list payload is 27,189 of 27,200 tokens.

## [0.20.14] - 2026-09-26
### Fixed
- `edit_file_code` names the closest line when the text is not found, instead of the head of the file. A miss returned the first 20 lines, so a wrong quote deep in a file was invisible: a model editing line 378 of a 618-line file was shown lines 1 to 20 and told to re-read, and had no way to see the difference. In the case that prompted this, the whole difference was one backslash inside a character class, written `[^\"]` where the file holds `[^"]`. The tool now looks for the line that matches once backslashes and spacing are ignored, reports that line with one line either side, and says the difference is an added escape. Without a near miss it keeps the old 20-line head and the old advice.
- A near miss can no longer be reported when the text is actually present, so the function is honest for any caller. A needle that is a prefix of a line is a real match, not a near miss.

### Changed
- The `edit_file_code` description says what a zero-match failure returns. The tools/list payload came down to 27,191 of 27,200 tokens, the wording of the `WHEN TO USE` paragraph carried the same advice in fewer words.

### Not fixed
- A client returned two different sets of 11 tools in one conversation, and the two sets shared exactly one tool. A task that needed `edit_file_code` from the first set and `execute_shell_command_code` from the second could not be carried out: the file could be written or the generator could be run, never both. The model diagnosed the fault correctly and reported that no repair had been made. The selection is relevant to the request in both cases, so the ranking is not the problem; the set changing between turns is.

## [0.20.13] - 2026-09-26
### Fixed
- Output compaction no longer folds a command that reports several statements. `&&`, `||` and `;` are not recognised as statement boundaries, so a chain was categorised `generic` and then reduced by duplicate-line collapsing and a head+tail cap. A single `python generate_pdf.py` chained with a second one produced 1,101 characters of output that compaction returned as 49: the two scripts print a near-identical `PDF genere` line and the WeasyPrint `GLib-GIO-WARNING` notices repeat across both processes, so the first statement's entire output was attributed to the second. The model then reported a success it had not observed. A command containing a statement separator now returns its output untouched and labels the reason, because a result covering N operations cannot be folded without making it unattributable. A lone `|` is still one stream and still folds, and a separator inside quotes costs the saving but never loses output.
- The agent guide no longer claims all 85 tools when 91 are registered. The count in the tool description was typed by hand and drifted from the registry; the guide body derived it from `TOOL_HINTS` and so had been correct all along, which is why the mismatch survived. Both read the registry now, and a test reads the description off a real `tools/list` to keep them equal.
- The test that guards the guide version no longer checks a number that stopped being the previous one. It asserted the version differed from `8` while the version was `9`, so it could not fail. It asserts a floor instead, so forgetting to bump on a content change is now loud.

### Changed
- The agent guide states that the callable tool list may be partial and that the missing one should be named. Clients cap discovery and can change the selection between requests in the same conversation; a model that sees a tool named in the catalog it cannot call tends to report a wrong-tool mistake or to route around the gap, and the workaround is what burns the budget. Guide version 9 to 10.

### Not fixed
- The 11-tool discovery cap is the client's, and a `get more tools` tool was raised with the authors. The server cannot add a tool to the list the model is holding mid-turn: a discovery tool only helps if the client re-sends a widened `tools/list` after it is called, and only returns knowledge without that. Their answer decides whether it is worth building, and adding a tool costs about 50 tokens of the tools/list payload, which is 5 tokens from its ceiling.

## [0.20.12] - 2026-09-26
### Fixed
- A repeat read no longer costs a second copy of the file. The cache refused a full re-read but stepped aside for any line range, so the escape route it advertised — "read a line range" — handed back the whole file when the range happened to cover it. A model told to page through a large file asked for `startLine: 1, endLine: 100000` and got all 197 KB of four course transcripts again, about 50,000 tokens, after the cache had already reported them as present. A range that covers the file is now recognised as that same read, a section that was already read is refused on the second attempt, and the notice states the line count so the size of a real section can be judged before asking for it. A section read no longer makes a later full read look cached. The cache is bounded at 256 entries, which it was not before.
- A binary file is refused with a route instead of decoded as text. `read_file_code` only recognised images; a PDF fell through to the text path and came back as compressed bytes, about 70,000 characters for one course document, and the model concluded the document was unreadable while `render_pdf_pages_code` and `ocr_pdf_code` sat unused. A PDF, and any other file carrying a NUL byte in its first 8 KB, now returns a message naming the tool that reads it. A text file is unaffected and `encoding: "base64"` still returns the raw string.

### Changed
- The start-up log no longer reports success twice. The extension and the server each logged `MCP Server started successfully` at the same millisecond on every activation.
- `read_file_code` states that a PDF is refused, that a repeat read costs nothing, and that a tool list showing 11 of 91 tools is partial with `session_bootstrap_code` holding the rest. The wording was cut to fit the tools/list payload budget, which was 5 tokens from its ceiling.

### Measured
- Every refused repeat is written to the traffic log with the running count, so the tokens not spent are countable after the fact rather than inferred: `read_file_code repeat refused path=… — N refused this session, M characters not re-sent`.

### Not fixed
- The client advertised 11 of the 91 registered tools, and a different 11 on the next request in the same conversation. `server.ts` registers all of them and the extension log shows every category enabled, so the cap and its instability are in the client. A model that saw only the first list reported having no way to write a file while `create_file_code` was registered. Until the cap is lifted, the redirect in `read_file_code` is the only lever available from this side.

## [0.20.11] - 2026-09-25
### Fixed
- `render_pdf_pages_code` and `read_file_code` now say the picture came back attached to the reply. This did not stop the duplicate: a model that receives both pages inline still announces it will open them and calls `read_file_code` on the PNGs, so the user sees every page twice. The wording is an attempt that failed, recorded here so the next one starts from what is known. The waste is two tool calls and about 2,000 tokens per render.
- A page count that was skipped because the time budget ran out no longer reports "pdfinfo not found". 0.20.10 skips the lookup when the raster has used the available time, and reused the wording reserved for a real absence, so a machine with Poppler installed was told it was missing a tool. A missing binary now points at poppler-utils; an exhausted budget names the time.
- The image caption names the format instead of repeating the mime type, which read "a image/png image".

## [0.20.10] - 2026-09-25
### Fixed
- `render_pdf_pages_code` can no longer spend past the point where the client has already given up. The 27s figure is the whole budget a call gets before the client disconnects at 30s, but the tool was handing each of its shell calls that full figure in turn: four sequential calls could add up to 45s. A cold first `pdftoppm` took about 28s on its own, so the two metadata lookups added by 0.20.8 were enough to push the whole response past the ceiling. The tool now measures elapsed time from entry and gives each call only what is left, and skips the page count entirely when under a second remains, reporting the total as unknown instead. The rendered pages are never withheld to make room for metadata.

## [0.20.9] - 2026-09-25
### Fixed
- `read_file_code` returns an image as a picture instead of decoding its bytes as text. A PNG used to come back as roughly 140 KB of mojibake, which cost about 35,000 tokens and showed the model nothing. It now comes back as an image block with a one-line caption giving the format, byte size, pixel dimensions and what the picture costs, which is about 1,000 tokens for a document page. An explicit `encoding: "base64"` still returns the raw string, line ranges on a bitmap are refused with an explanation instead of mojibake, and anything over 4 MB is refused with a pointer to a cheaper route.
- `render_pdf_pages_code` no longer discards a rasterization that finished after the shell call gave up. A cold `pdftoppm` on Windows can overrun the 27s client budget, the tool saw a non-zero exit and reported a failure, and the pages it had already written were deleted with the temp directory. The tool now checks what landed on disk before declaring failure, and says so when the pages arrived after the deadline. A run that produced nothing still fails, with the shell output.

## [0.20.8] - 2026-09-25
### Fixed
- `render_pdf_pages_code` now states how many pages the document has in total. The summary read "2 page(s) rendered ... (pages 1–2)", which a model took as the length of the document: rendering pages 1–2 of a 5-page PDF came back with the confident claim "the PDF has 2 pages", and the three unread pages were never offered. The tool now reads the count from `pdfinfo` and reports "Pages 1–2 of 5 — 3 page(s) of this document were not rendered". When `pdfinfo` is unavailable it says the total is unknown rather than letting a partial render pass for the whole file, and the pages are still returned.

## [0.20.7] - 2026-09-25
### Fixed
- The queue no longer refuses a long request when the terminal is free. Admission compared the requested timeout against the client budget without ever checking whether anything was actually running, so a 60s render on an idle terminal was rejected with a message claiming the terminal was busy. The rejection now happens at enqueue time and only when real work is ahead of the call, so a free terminal always runs the command and returns partial output instead of refusing outright.
- `render_pdf_pages_code` and the OCR rasterizer cap their shell timeout at the client budget rather than a hardcoded 60s that could never return before the client disconnected.

## [0.20.6] - 2026-09-25
### Fixed
- `execute_shell_command_code` pins the working directory to the workspace root when `cwd` is omitted. It previously emitted no `cd` at all, so a command inherited whatever directory the previous call had left the shared terminal in. A `cd subdir && build` followed by `ls subdir` failed on a path that plainly existed, and the tool description promised a default the code did not implement.
- The runtime probe no longer reports "python not found". It spawns `python` through the extension host, whose PATH differs from the integrated terminal's, so a machine with Python on PATH in the terminal was reported as having none. It now names the scope of the check and tells the model to run `command -v python`.

## [0.20.5] - 2026-09-25
### Fixed
- `get_server_info_code` no longer states an unverified shell as fact. A terminal restored by VS Code after a window reload comes back without `creationOptions`, so detection fell through to the Windows default profile and reported `powershell` while Git Bash was actually running. The server now labels that case as an assumption and points at the tool that confirms it.
- The agent guide no longer claims "Terminal is Git Bash" on Windows. It cannot verify that, and the claim contradicted what `get_server_info_code` reported. It now directs the model to the tool.

## [Unreleased]
### Added
- The agent guide now carries an ENVIRONMENT section stating what this machine actually has: on Windows the interpreter is `python` (there is no `python3`), search is `grep` (no `rg`), there is no `fc-list`, and paths are `d:/...` or `/d/...` rather than `/mnt/...`. Guide version moved to v9 so a session holding a cached v8 reloads it. The section is generated per platform, so a Linux or macOS host is never told Windows facts.
- A dead integrated terminal is now detected immediately instead of waiting out the full 5s shell-integration timeout on every call, and the shell tools take a terminal provider so a terminated terminal is replaced rather than failing until the window reloads. A command using `set -e` was enough to kill the shared terminal and leave every later shell call stalling.

### Fixed
- `detectShellKind` no longer lets a failed wrap retry override an explicit `shellPath`. One PowerShell command arriving at a Git Bash terminal could pin the terminal to PowerShell for the rest of the session, wrapping every later command in `& { $ok = $true ... }` with no way back.
- The wrap-mismatch detector no longer fires on a bare "not recognized", which only PowerShell emits for an unknown cmdlet.

### Added
- The shell queue is bounded. Commands on one terminal are still serialized, but a call that would still be waiting when the client budget runs out is now rejected immediately with a message naming `background_task_code`, instead of silently queueing until the client disconnects and returning nothing. Previously four commands arriving together could each hold a valid per-command timeout and still lose the race as a group.
- An incoming `timeout` larger than the client budget is clamped, and the clamp is reported in the result text. A request for 120s used to be accepted and could never return anything, because the client disconnects first regardless.
- The active terminal shell is published in two places the model reads without running a command: the `execute_shell_command_code` description and a new `- Shell:` line in `get_server_info_code`.

### Changed
- The client ceiling is recorded as the measured 30000 ms rather than an approximation. Server logs show the disconnect landing at 29999 ms, so the budget is derived as the ceiling minus a named response reserve, and the schema default, the handler, and the tests all read the same constants.
- Release notes and changelog entries that described the ceiling as "roughly 30s" now state the measured value.

## [0.20.3] - 2026-09-25
### Changed
- `execute_shell_command_code` default timeout raised from 10s to 25s, finishing before the calling client's 30s cutoff so a slow command returns partial output and exit code 124 rather than nothing. The schema default and the handler default now read the same `SHELL_TIMEOUT_MS` constant, and a test asserts they agree, so the two can no longer drift apart silently.

### Added
- `shell-timeout` test gates the default against the client ceiling and checks the description documents the 124 recovery path and points at `background_task_code`.
- `schema-weight` test measures the expensive tail rather than the mean: a max-per-tool cap of 950, a p95 cap of 480, and a total payload ceiling of 27,200 tokens. The previous mean-based check passed while one tool sat at 907 tokens and 36 exceeded 300.

## [0.20.2] - 2026-09-25
### Added
- `edit_file_code` — exact string replacement that refuses to guess when the target appears more than once and reports the matching locations instead. Fixes two async bugs the tests caught: an unawaited `applyEdit` and an unawaited `save`, either of which could report success before the edit was on disk.
- `get_active_editor_code` and `list_open_tabs_code` so the model can read the editor's current state without a shell round trip.
- The agent guide's tool count is derived from `TOOL_HINTS`, with a test keeping the two in sync.

## [0.20.1] - 2026-09-25
### Changed
- Tool schema payload cut by 20% (32,828 to 26,243 tokens) with no tool or parameter removed. The largest single saving came from `WORKSPACE_PARAM_DESCRIPTION`, which repeated 340 characters of multi-root explanation across 76 tools (6,460 tokens, 20% of the payload); it is now 71 characters pointing at `list_workspace_folders_code`, which carries the full text in its own description. Tool descriptions for `ocr_pdf_code`, `execute_shell_command_code`, `search_workspace_code`, `scope_keys_code`, `background_task_code`, `checkpoint_code`, `validate_skill_code` and `pdf_needs_ocr_code` were trimmed to what constrains a call, dropping repetition of parameter docs and workflow tutorials. Facts that prevent a wasted step are kept: the client 30s ceiling and per-engine OCR page caps, the read-only-tool preference on the shell, and the append-to-accumulate pattern.
- `list_workspace_folders_code` now carries the full multi-root resolution explanation it used to only hint at.

### Added
- `schema-weight` test measures the real `tools/list` round trip and fails above 26,500 tokens, if the repeated workspace parameter description exceeds 90 characters, or if any single tool reaches Mammouth's 32 KB per-tool cap.
- `registry-integrity` test fails when a tool is registered without a scope mapping (the class of bug fixed in 0.19.18), without annotations, or when a scope entry points at a tool that no longer exists.

### Fixed
- Test files that used mocha's BDD globals (`describe`/`it`) are converted to the `suite`/`test` interface the VS Code test runner expects, matching the pre-existing `extension.test.ts`.

## [0.20.0] - 2026-09-23
### Added
- Workspace state snapshot (`<workspace>_STATE.md`): a small, always-overwritten file holding the version, branch, status, what is in progress and the single next step. Unlike memory it never accumulates, so the model always resumes knowing which version it was working on instead of re-deriving it.
- `session_end_code(summary, version, branch, status, inProgress, nextStep)`: closes a unit of work by writing the state snapshot and appending a dated summary to the workspace log. The summary carries what no tool can infer — the intent behind the work, the decisions and their reasoning, and what was deliberately left out. Wired into the agent guide as the closing step of a task.
- `workspace_log_code(count)`: reads recent session history (files touched, commands run) when the state snapshot is not detailed enough.
- `workspace_state_code(action="read"|"write", …)`: read or update the snapshot directly, for recording a mid-task state change.
- Server-side activity journal: tool calls with a file path, command or query are recorded to the workspace log automatically, buffered and flushed on a timer, with no model call and no tokens spent. Works even if the model never calls a tool.

### Changed
- `session_bootstrap_code` is now budgeted and leads with the state snapshot. It returns the state in full, memory files trimmed to a budget with the dropped size reported, and only the most recent log entries. On a realistic memory pair this cuts the bootstrap payload by ~75% (25.6k to 6.5k chars in the reference case) while leaving small memory files untouched.
- `memory_load_code` gained a `full` flag: budgeted by default, verbatim on request. It also surfaces the workspace state alongside memory.
- Agent guide v7 documents the state, session-end and log tools and adds closing a session to the non-negotiable workflow.

## [0.19.18] - 2026-09-22
### Fixed
- `session_bootstrap_code` was denied for EVERY key (even full-scope ones) with
  "not permitted by the granted access level": the tool was missing from the
  `SCOPE_TOOLS` mapping in `src/auth/scopes.ts`, and the scope gate fails closed
  for unmapped tools. It is now mapped to `fs:read` (the bootstrap is purely
  read-only: memory, workspace folders, root layout, skills, agent guide), so
  every key preset (read-only / standard / full) can open a session in one call.
- Regression guard: the server now logs a startup warning listing any registered
  tool that has no scope mapping (`Tools without scope mapping (denied for every
  key): ...`), so a missing entry in `SCOPE_TOOLS` can never ship silently again.

## [0.19.17] - 2026-09-21
### Added
- `session_bootstrap_code` (always-on, read-only, annotated RO): ONE-CALL session start - returns persistent memory (global + project), the open workspace folders with the first folder's root layout, the skills list and the full agent guide in a single response. Registered outside the enabledTools groups, next to the agent guide tool: it is the intended conversation opener and cannot be switched off. Motivation: clients cap tool calls per response, and a real task (read a skill, copy an annex script, write the .md, run the generator, verify pdfinfo) needs its budget for actual work, not for loading context.
- Agent guide v6: new "TOOL BUDGET" section (open with one bootstrap call, never list what the user already gave, never re-read what you just wrote, chain shell steps with &&, copy annex files instead of retyping them, write deliverables FIRST so the files exist even if the budget runs out mid-task). Tool count 84 -> 85 (49 read-only / 26 mutating / 10 destructive).
### Fixed
- `list_skills_code` no longer fails with "No such folder: ".claude/skills"" when called without arguments: the root auto-detects, scanning "skills" first, then ".claude/skills"; an explicit root= still wins. The old hard-coded default wasted one tool call per conversation in every workspace that stores skills under skills/.

## [0.19.16] - 2026-09-21
### Fixed
- Extension activation failed with "Cannot find module 'express'" (`out/server.js` requires `express` at startup): the `.vsix` now bundles the production `node_modules` (express, zod, @modelcontextprotocol/sdk and their transitive dependencies). Since v0.19.13 the packaging used `vsce package --no-dependencies`, which silently strips every runtime dependency from the archive — the published VSIX only worked when installed from a dev checkout with `node_modules` next to it. Packaging now resolves dependencies normally, so the shipped VSIX is self-contained.
- `@types/express` moved from `dependencies` to `devDependencies` (compile-time only, no longer shipped in the VSIX) and the compiled test artifacts (`out/test/`) are excluded from the package via `.vscodeignore`.

## [0.19.15] - 2026-09-20
### Security
- CodeQL `js/type-confusion-through-parameter-tampering` (alerts #1/#2, `src/auth-oauth.ts`): the `/authorize` handler read `req.query` through a `Record<string, string | undefined>` cast. A client sending a repeated parameter (`?redirect_uri=a&redirect_uri=b`) makes Express return an ARRAY, and the `redirect_uri.includes('?')` calls at the two `res.redirect` sites then run array semantics on attacker-controlled input (CWE-843). All six query parameters are now extracted through a runtime `typeof v === 'string'` guard (`queryStr`), so a tampered parameter degrades to `undefined` and the existing exact-match redirect_uri validation rejects the request.
- CodeQL `js/cors-misconfiguration-for-credentials` (alert #22, `src/server.ts`): the CORS middleware reflected the request Origin together with `Access-Control-Allow-Credentials: true`. Nothing in the server uses cookies or ambient credentials (auth is `Authorization`/`X-Api-Key` headers only, OAuth tokens are Bearer headers), so credentialed CORS had no legitimate use: the `Allow-Credentials` header is removed and the Origin header is now runtime type-checked before being reflected through the existing `originAllowed` whitelist gate.
- CodeQL `js/missing-rate-limiting` (alerts #3-#8, `src/server.ts`): a global fixed-window rate limiter (600 req/min per IP, same in-house mechanism as the 240/min `/mcp` guard) now runs before every route — `/health`, the traffic middleware, the CORS middleware, `/__traffic` and the auth/cluster middlewares all perform fs/crypto/auth work that was previously unthrottled. Limiter instances keep per-instance hit maps (no double counting for requests passing both the global and the `/mcp` limiter) and `rateLimitSnapshot()` (consumed by `expose_audit_code`) aggregates all instances.
- CodeQL `js/incomplete-sanitization` + `js/double-escaping` (alerts #9-#21 across `calendar-tools.ts`, `frontend-tools.ts`, `skills-tools.ts`, `productivity-tools.ts`):
  - `calendar-tools.ts`: DOCX (`unzip -p`) and PDF (`pdftotext`) extraction switched from shell strings to `execFileSync` with an argv array — no shell, no escaping to get wrong. The XML entity unescape chain now unescapes `&amp;` LAST (unescaping it first turned `&amp;lt;` into a bare `<`). ICS text escaping escapes backslash FIRST, then `,`/`;` (a literal backslash in a title previously swallowed the escape); the DESCRIPTION source-line gets the same treatment.
  - `frontend-tools.ts`: the HTML-comment stripper now also matches comments ending with `--!>` (HTML comment-end-bang state) that browsers accept.
  - `skills-tools.ts`: the embedded-JS validator matches `<SCRIPT ...>` / `</SCRIPT foo="bar">` (case, attributes, parser-error end tags); the `create_skill_code` YAML description escapes backslash first and flattens newlines.
  - `productivity-tools.ts`: `find_dead_code_code` escapes ALL regex metacharacters in parsed symbol names, not just `$`.
  - Alerts #12/#15/#16 (`run_sql_query_code` string escaping) were already fixed by the 0.19.13 `execFile` rewrite — they close once these sources land on master.
- `test_api_endpoint_code` SSRF fix completion: the 0.19.13 guard validated every REDIRECT hop but NOT the initial request — `http://169.254.169.254/` still went out unvalidated (confirmed live by PoC; the request died on timeout only because the local machine runs no metadata service; on a cloud host the response would have come back). `assertUrlSafe` now runs BEFORE the first fetch, so the whole request path (initial + hops) is validated.
- `assertUrlSafe` hardening: link-local addresses (169.254.0.0/16, fe80::/10 — the cloud metadata range) are now ALWAYS blocked. They were previously bypassable with `allowPrivateNetwork=true`; the `test_api_endpoint_code` param description no longer advertises metadata targets.
- `ocr_pdf_code` vision engine SSRF guard: `ollamaUrl` is agent-controlled and previously fetched without any check (its error paths even reflect server data); the vision path now validates the URL through `assertUrlSafe` before contacting Ollama (loopback/private allowed, metadata hard-blocked).
## [0.19.14] - 2026-09-13
### Added
- Ten new tools, agent guide bumped to v5 (84 tools total: 48 read-only / 26 mutating / 10 destructive):
  - `diff_preview_code` (read-only): dry-run of `replace_lines_code` / `create_file_code` / `move_file_code` / `rename_file_code` - returns the unified diff that WOULD be written, applies nothing, and ends with the exact call to execute it. Catches accidental overwrites before they happen.
  - `checkpoint_code` (mutating): one-call undo point. `save` records uncommitted tracked changes as a named checkpoint via `git stash create` + `git stash store` (NON-destructive: the working tree keeps its changes), `list` shows checkpoints and whether their stash is still alive, `restore` re-applies the stash (kept, so it can be restored repeatedly; requires `confirm=true`), `drop` removes one. Outside git, only metadata is saved. This is the missing "annuler tout" button next to `snapshot_workspace_code`.
  - `plan_mode_code` (mutating): global planning switch. While ON, every execution tool (`execute_shell_command_code`, `run_sql_query_code`, `run_task_code`, `build_project_code`, `run_tests_code`, `restart_dev_server_code`, `profile_command_code`, `run_alias_code`) returns a "would run" description instead of executing; read-only tools keep working so the agent can still explore. Draft risky operations, present the plan, flip it off, execute.
  - `background_task_code` (mutating): runs long commands (builds, test suites, installs, dev servers) DETACHED via the system shell - returns a task id immediately instead of hitting the 10 s terminal timeout. `start` still goes through the shellguard policy; `list` shows state/duration/output size; `output` pages through results (compacted once on first read, full text retrievable via a `retrieve_output_code` handle); `kill` terminates. 8 concurrent tasks, 200 KB output cap (tail kept), finished tasks kept 1 h.
  - `scope_keys_code` (admin): creates/lists/revokes SCOPED api keys (`mcpk_ro_...` / `mcpk_std_...` / `mcpk_full_...`). A scoped key maps to the existing OAuth presets: read-only = `fs:read` only (no shell, no edits, no SQL), standard adds `fs:write` + `shell:exec`, full adds network + memory. Administration is never granted to scoped keys. Stored hashed (sha256) in SecretStorage, shown in plaintext exactly once. This closes the architectural half of "one leaked funnel key = full RCE": remote clients and funnels should hold a read-only key, never the primary.
  - `secret_rotate_code` (admin): regenerates the primary API key and invalidates the old one immediately (SecretStorage + server cache), in one audited call. For the moment the key was pasted into a chat or a file. Scoped keys are unaffected.
  - `expose_audit_code` (admin, read-only): aggregated exposure view over the audit log - per-client tool counts, denied/blocked events, last-seen times - plus the current rate-limit window with the top source IPs and their request share. Answers "who is hitting this server and is the funnel being scanned?" without paging raw events.
  - `call_graph_code` (read-only): call graph of a symbol with configurable depth and direction (callees/callers/both), served by a new heuristic workspace index cached in `.codegraph/index.json` (TS/JS/Python declarations + call sites + relative-import edges; built on first use, then incremental by mtime+size; delete the folder to force a rebuild). Name-based by design: same-named symbols merge, dynamic dispatch is not resolved.
  - `test_impact_code` (read-only): changed source files -> test files that (transitively) import them, walking the reverse import graph. Defaults to git working-tree changes; use before committing to run exactly the right tests instead of the whole suite.
  - `migration_diff_code` (read-only): compares two revisions (`base...head`) - changed files, declarations added, BREAKING declarations removed (rename/changed-in-place flagged separately) - parsed from the unified diff of code files. Use before merging.
- api-key auth: the middleware now resolves a per-key scope verdict. The primary key keeps full access; `mcpk_` scoped keys authenticate with their preset scopes and appear in the audit log as client `key:<label>`, so multi-client setups are visible and bounded per client. Timing-safe comparison (sha256 + `timingSafeEqual`); the rate limiter moved to `auth/ratelimit.ts` and exposes the window snapshot consumed by `expose_audit_code`.
- `get_audit_log_code` accepts the new audit kinds `key_created` and `key_revoked`.
### Changed
- Agent guide v5: the ten new tools are in the catalog (new PLANNING and ACCESS CONTROL sections) and the workflow/recipes were extended (diff preview before edits, checkpoint before big refactors, plan mode for risky commands, background tasks for long builds, scoped keys for remote clients). Pure ASCII, unchanged delivery channel.
- `vscode-mcp-server.agentInstructions` setting description no longer mentions the removed initialize-response delivery; it now describes what the setting really overrides (the `get_agent_instructions_code` guide).
- README: tool count 74 -> 84.

## [0.19.13] - 2026-09-13
### Security
- `run_sql_query_code` no longer builds shell command strings: sqlite3/psql/mysql are spawned via `execFile` with an argv array and `shell: false`, so `query`, `filePath`, `connectionString` and credentials can no longer break out of the double-quoted shell context (`"`-only escaping was bypassable with `$(...)`, backticks and `; | &`). Database passwords no longer appear in argv either: MySQL uses `MYSQL_PWD`, PostgreSQL `PGPASSWORD`, and the password is stripped from the psql connection-string argument.
- `test_api_endpoint_code` is SSRF-guarded: http/https only, and every resolved address is validated per request AND per redirect hop (manual redirect loop, max 5 hops — a public-to-internal redirect no longer bypasses the check). Loopback (localhost/127.0.0.1/::1) stays always allowed for dev-server testing; private ranges (RFC1918 10/8, 172.16/12, 192.168/16), link-local including cloud metadata 169.254.0.0/16, tailnet CGNAT 100.64/10, IPv6 ULA/link-local and 0.0.0.0/8 are blocked unless the new `allowPrivateNetwork=true` param is passed. Response body capped at 1 MB with an explicit truncation note.
- `check_env_vars_code` redacts `.env` values by default: the new `revealValues` param (default false) reports value length + first 8 hex chars of sha256 instead of plaintext, so duplicate/drift detection still works without exposing secrets. The output footer states which mode ran; `revealValues: true` marks the result as secret.
- shellguard blocklist extended (defense in depth, best-effort by design): pwsh/powershell encoded-command aliases (`-e/-ec/-en/-enc` and slash forms), `-WindowStyle Hidden`, `certutil -decode/-decodehex/-urlcache/-verifyctl`, `bitsadmin /transfer|/create|/addfile`, registry Run/RunOnce writes (`New/Set/Remove-ItemProperty -Path ...HKCU|HKLM\...Run`, `reg add ... \Run`), drive-root wildcard deletes with flags after the target (`Remove-Item C:\* -Recurse`, `del/erase/ri` variants), `%COMSPEC%`/`$env:ComSpec` invocation, and POSIX `curl|sh` / `wget|bash` download-execute pipes.
- Rate limiting on `/mcp`, cluster `/register` and cluster invoke: 240 requests/min per client IP (in-memory, no new dependency), 429 + `Retry-After` + `X-RateLimit-*` beyond that. Keys on the first `X-Forwarded-For` hop (correct behind tunnels/funnels) falling back to the socket address; map capped at 5000 entries with expired-entry eviction.
- Hardening odds and ends: `X-Powered-By: Express` disabled; `/health` no longer reports the version (`{ok, mode}` — the version remains available in `get_server_info_code` behind auth); `OPTIONS /mcp` no longer answers `Access-Control-Allow-Origin: *` — it reflects the Origin only when it is allowed, answers 403 for foreign origins, and its allow-headers list now covers `Authorization`/`X-Api-Key`/session headers (previously a browser preflight carrying `Authorization` got no echo and failed).
- New pure-HTTP guard helpers live in `src/utils/security-helpers.ts` (IPv4/IPv6 range classification, DNS-resolving URL check, sha256 value masking, capped body reader) — no new npm dependencies.

## [0.19.12] - 2026-09-10
### Changed
- `get_agent_instructions_code` now returns the COMPLETE tool catalog (guide v3): all 74 tools listed by exact name, grouped by task (files, code structure, edits, diagnostics, tests/builds, git, shell, memory, security, project/docs, skills, frontend, PDF/OCR, network/misc), each with its key parameters and an `[RO]`/`[MUT]`/`[DST]` tag matching the tool annotations, plus a non-negotiable workflow section and common recipes (locate an implementation, change code safely, ship a change, read a scanned PDF). Agents no longer need to discover tools by trial and error or spend calls figuring out how to do something: one call at conversation start provides the full map. The tool description itself now advertises the complete catalog. Guide remains pure ASCII; guide version bumped to 3.

## [0.19.11] - 2026-09-10
### Fixed
- Critical: 19 tools were silently denied at execution (empty response, `content: []`) even for fully-privileged clients, because the compiled `SCOPE_TOOLS` mapping in `auth/scopes.js` was never updated when tools were added. Affected: `search_workspace_code`, `retrieve_output_code`, `find_secrets_code`, `security_scan_code`, `regex_tester_code`, `find_dead_code_code`, `find_duplicate_code_code`, `suggest_refactoring_code`, `analyze_bundle_code`, `analyze_css_code`, `audit_accessibility_code`, `find_unused_css_code`, `inspect_element_code`, `get_test_coverage_code`, `lint_and_fix_code`, `convert_encoding_code`, `extract_function_code`, `brew_coffee_code`. The mapping now covers all 74 registered tools, and a regression test keeps it in sync with the registry.
- Scope denials now return a proper MCP error result (`isError: true` + explicit reason text) instead of a malformed `{allowed: false}` object with no content, so agents can see WHY a tool was refused and adapt instead of silently moving on.
### Added
- New read-only tool `get_agent_instructions_code`: returns the agent guide (tool map, workflow rules, approval behavior, memory protocol) on demand. Its description explicitly instructs agents to CALL IT FIRST AT THE START OF EVERY CONVERSATION, exactly like loading persistent memory, so the guide reaches the agent context even on clients that never surface server instructions. The tool is marked `readOnlyHint` (auto-approved), the guide footer carries a version tag, and the `vscode-mcp-server.agentInstructions` setting + `Copy Agent Instructions` command now feed the tool output.
### Changed
- Removed the `instructions` field from the MCP `initialize` response: probing showed some clients (e.g. Mammouth) ignore it entirely, so the guide is now delivered exclusively through `get_agent_instructions_code`, which works everywhere tool descriptions are visible. The guide text is now pure ASCII (em-dashes no longer turn into mojibake on Windows consoles such as PowerShell), guide version bumped to 2.

## [0.19.10] - 2026-09-10
### Added
- Server-sent agent instructions: the MCP `initialize` response now carries an `instructions` field with a built-in workflow guide (tool map, read-only preference, diagnostics-first editing, multi-root handling, memory auto-load). Clients that honour the MCP spec (Claude, Cline, Mammouth, ...) inject it into the model context at connection time, so the agent knows which tool to use WITHOUT discovering/re-listing tools first. Override it (or disable it by setting your own) with the new `vscode-mcp-server.agentInstructions` setting.
- New command `MCP Server: Copy Agent Instructions` — copies the same guide to the clipboard for pasting into agent instructions that cannot read the initialize response (`CLAUDE.md`, project instructions, Mammouth memory, ...).
- `GET /health` endpoint documented for tunnel liveness probes: the existing unauthenticated, pre-auth health route (`{ok, mode, version}`, answers before auth in every auth mode) is now the recommended probe target for `tailscale serve` / cloudflared / nginx / uptime monitors. `/favicon.ico` now answers `204 No Content` instead of triggering a `401 api-key` warning in the logs on every browser or health-checker hit.
### Changed
- Anti-502 hardening behind proxies/tunnels: `keepAliveTimeout` raised 65s → 90s (and `headersTimeout` 91s) on both listener paths. A server closing an idle keep-alive connection while a proxy (Cloudflare, relay, tunnel) reuses it is the classic cause of intermittent `502 origin_bad_gateway` errors; the server now holds idle sockets longer than any intermediate's reuse window.
- `/mcp` diagnostics: when a client disconnects before the response completes, the log now records `MCP client <name> @ <ip> disconnected after <N>ms before the response completed (possible tunnel/proxy drop)` — correlate its timestamp with 502/timeout pages to tell a network/tunnel drop (warning present) apart from a request that never reached the machine (nothing in the log).

## [0.19.9] - 2026-09-10
### Added
- MCP tool annotations: every tool now declares standard `readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint` annotations. Read-only tools (file reads, listings, search, diagnostics, git blame/diff/history, symbol lookup, static analyzers, ...) are marked `readOnlyHint: true`, so MCP clients that honour annotations can auto-approve them — no more manual validation for pure reads. Classification is conservative: anything that can modify files, run arbitrary commands/SQL or erase data is never marked read-only. Tools unknown to the table get no hints (clients keep asking), and a warning lists them in the server log.
- New tool `search_workspace_code` (strictly read-only): regex search across the workspace with matches grouped by file and 1-based line numbers, optional glob filter (`*.ts` matches the file name at any depth, `src/**/*.py` matches relative paths), case sensitivity control, `skipCommon` toggle for vendor/build directories (default on: node_modules, dist, out, build, dot-directories, ...), binary/large-file skip and a result cap (default 50, max 200). This fills the last gap that forced agents to route simple greps through `execute_shell_command_code` (which requires manual approval).
### Changed
- `execute_shell_command_code` description now explicitly steers agents to the dedicated read-only tools (`read_file_code`, `list_files_code`, `search_workspace_code`, `get_git_diff_code`, `get_file_history_code`, `get_diagnostics_code`) for simple reads, reserving the shell tool for commands that actually mutate something.

## [0.19.8] - 2026-09-10
### Added
- Token-efficiency layer (inspired by rtk-ai/rtk and headroomlabs-ai/headroom, implemented natively):
  - `execute_shell_command_code` output is token-compacted by default (`outputMode` param, `"compact"` default): progress bars stripped, repeated lines collapsed (`×N repeat`), long lines truncated, head+tail capped at 500 lines, plus category-specific filters for git transport/status/diff, package-manager installs (deprecated-warning spam collapsed), test runners (failures + totals kept) and builds (errors-only on failure, last lines on success). Pass `outputMode: "raw"` for the untouched output; outputs where compaction would save less than ~15% are returned raw (never needlessly reformatted).
  - New tool `retrieve_output_code`: headroom-style CCR — whenever a result is compacted or truncated, the FULL original is kept in memory and the result carries a handle (`[@vscode-mcp: ... retrieve_output_code "a1b2c3d4e5"]`). Call it to page back through the original (offset/maxChars). Handles live in the VS Code window's memory (most recent 40 stored outputs).
  - `ocr_pdf_code` result text is lightly compacted (blank/duplicate-line collapse, same 15% guard) and over-long previews now also carry a `retrieve_output_code` handle instead of being unrecoverably truncated.
### Changed
- OCR "vision"/"auto" engines: pages are now processed 2 at a time (bounded concurrency) under a shared wall-clock deadline — roughly half the wall time for vision-heavy batches, and the call ALWAYS returns within its internal budget: pages that don't fit come back as explicit `[Skipped: ... firstPage=N lastPage=N]` markers (with a footer note and counts) instead of the whole call being killed client-side at the 30s ceiling mid-flight.
- Tesseract detection: added the per-user install locations (`%LOCALAPPDATA%\Programs\Tesseract-OCR`, e.g. winget user-scope installs) to the Windows fallback probe list, on top of `command -v` / `where.exe` / `C:\Program Files`.

## [0.19.7] - 2026-09-10
### Changed
- `/mcp` request log no longer prints "MCP request from unknown" for clients that don't send the `x-mcp-client-name` header: the log now falls back to the MCP `initialize` `clientInfo.name` (taken from the JSON-RPC body), then to the User-Agent's first token, and always appends the client IP — e.g. `MCP request from mammouth-connector @ 100.94.96.66`. Clients that want a stable, explicit name in the logs can send an `X-MCP-Client-Name: <name>` header (already allowed through CORS).

## [0.19.6] - 2026-09-10
### Fixed
- Cluster join (2nd window) could never join when auth.mode = "api-key": the api-key branch of the auth middleware answered 401 on `/__mcp_cluster/identity` before the PUBLIC_PATHS exemption was reached, so the joining window parsed the 401 body as a (role-less) identity, re-threw EADDRINUSE and gave up. The identity probe is now answered before any auth mode branch, restricted to loopback peers (127.0.0.1 / ::1).
- The identity probes in `joinAfterAddressInUse` and the election path now send the cluster credential (`x-mcp-token`) and require `response.ok` before parsing, so a 401 JSON body can no longer be mistaken for a valid identity.
- In api-key mode the cluster credential now falls back to the settings-configured `auth.apiKey` when the SecretStorage cache is empty, so register/heartbeat/invoke from a spoke carry a key the hub actually accepts.
- Cluster routes (register/heartbeat/deregister/hub-shutdown/invoke) now accept the current token AND recently rotated ones (authTokenHistory), instead of only the current token — a spoke holding a technically-valid but stale credential is no longer dropped during a rotation/election window.
- Registration failures now log each of the 6 attempts and include the hub's refusal detail (code/detail body) in the error instead of a bare "HTTP 401".
## [0.17.0] - 2026-09-05
### Added
- New `skills` tool group (4 tools, toggle `vscode-mcp-server.enabledTools.skills`, default on) for managing folder-based agent skills (SKILL.md convention):
  - `list_skills_code`: recursively scans a root folder (`.claude/skills` by default) for SKILL.md files and returns each skill's name + description parsed from its frontmatter. Read-only.
  - `validate_skill_code`: validates a SKILL.md — required frontmatter fields, balanced ``` fences, referenced sibling files that actually exist next to it, and a non-executing syntax check (`new Function`, nothing is run) of embedded `javascript` blocks and `<script>` tags.
  - `package_skill_code`: packages a skill folder into a .zip via the system `zip` CLI (availability probed with `zip -v`, works in both bash and PowerShell terminals), excluding `*.bak`, `.DS_Store`, `node_modules/*`, `__pycache__/*` by default plus optional extra patterns.
  - `create_skill_code`: scaffolds `<root>/<slug>/SKILL.md` with a valid frontmatter from a human-readable name (accent-stripping slugify), refuses to overwrite unless `overwrite: true`.
- Scope classification: `list_skills_code`/`validate_skill_code` → `fs:read`, `create_skill_code` → `fs:write`, `package_skill_code` → `shell:exec` (enforced by the existing permission gate).

## [0.16.2] - 2026-09-05
### Added
- Hidden traffic log ("boîte noire" HTTP): every incoming request — including ones silently dropped before the auth middleware (404 unknown path, 405, 406, 400 malformed JSON, 403 origin guard) or aborted mid-flight — is now journaled to `<home>/.vscode-mcp-server/traffic.log` (2 MB rotation to `.1`, path overridable via `VSCODE_MCP_TRAFFIC_LOG`). Each line records method, path, client IP (X-Forwarded-For aware), Host, Origin, User-Agent, masked credentials (never the full key), Content-Type, Accept, protocol headers, a ≤400-char body preview and the response status with duration.
- TCP-level hooks on the HTTP server (`connection`, `clientError`): connections that never produce a complete HTTP request (proxy/timeout issues) are now visible in the journal.
- Protected diagnostic endpoint `GET /__traffic?key=<your key>[&lines=N]` returning the last N journal lines as plain text, so the whole chain (Mammouth → Tailscale Funnel → extension) can be inspected remotely with a browser. Denied without a valid key (401, logged).

## [0.16.1] - 2026-09-05
### Fixed
- CORS preflight (`OPTIONS`) was handled after the auth middleware, so a browser-originated client (Mammouth connector update) got 401/403 on the preflight and could never reach `/mcp`. Preflight is now answered before origin/auth: 204 with `Access-Control-Allow-Origin` echoing the allowed origin, `Access-Control-Allow-Credentials: true`, and the full allow-headers list (Authorization, X-Api-Key, Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, X-Mcp-Token, X-Mcp-Cluster).
- Successful and error responses now carry `Access-Control-Allow-Origin` when the Origin is allowed (echoed origin + `Vary: Origin`), so browser-based clients can read both 200 and 401/403 responses.
- `extractToken` now also accepts the key sent in `X-Api-Key` (some MCP clients no longer use the Bearer header).

## [0.16.0] - 2026-09-01
### Fixed
- `server.ts` patched only the parsed `req.headers` accept value, but the MCP SDK (>= 1.17) converts the request through `@hono/node-server`, which reads `req.rawHeaders`. Any client not sending exactly `Accept: application/json, text/event-stream` was rejected with 406 `Not Acceptable`. Both header views are now normalized.
- `server.ts` read `this.oauthRouterInstance` in the auth middleware while the router is created lazily, so a valid OAuth token got a flaky 401 on the first request after a restart until discovery was re-run. The lazy getter is now used and verification is always available.
- `auth.ts` `bearerAuth` treated an empty expected token as "no auth needed", so `auth.mode = static-token` with an empty `auth.staticToken` left the server wide open. Misconfigured secure modes now deny with 503 `auth_misconfigured` and `bearerAuth` denies when no candidate is configured.
- `server.ts` async auth middleware had no rejection handler (Express 4 does not catch them), so a throwing check left requests hanging forever.
- Multi-window token race: the 700 ms reconciliation could invalidate tokens announced seconds earlier. `expectedTokens()` now accepts the current token plus the recent `vscode-mcp.authTokenHistory` entries.
- `server.ts` `refreshApiKeyCache` only refreshed when api-key mode was already active; switching `auth.mode` at runtime left a stale cache. It now refreshes unconditionally.
- `shellguard.ts` only matched destructive deletes ending in `X:\`, so `Remove-Item -Path C:\*`, `rm -rf /`, `rm -fr /*` and `rm -rf ~` were allowed. Wildcard/drive-root endings, POSIX root and home deletes are now blocked.
### Added
- Unauthenticated `GET /health` endpoint returning `{ok, mode, version}` to verify the whole chain (Tailscale Funnel → serve → extension) without credentials.
- `auth.allowedOrigins` entries may contain one `*` wildcard in the host (e.g. `https://*.ts.net`) for browser clients behind a funnel.
- Every rejected request (401/403/503) is now logged with method, path and client IP (X-Forwarded-For aware) — silent drops behind proxies are visible in the MCP output channel.
- Proxy stability: `keepAliveTimeout` raised from 5 s to 65 s and `headersTimeout` to 66 s on both HTTP listeners, eliminating random ECONNRESET when a funnel/tunnel reuses sockets; JSON body limit raised to 10 MB on `/mcp` and cluster invoke.

## [0.14.8] - 2026-08-29
### Fixed
- Two windows starting at once could generate different `vscode-mcp.authToken` values and the second write overwrote the first, so tokens issued before the race (`HMAC(oldToken, client|scopes)`) failed after the next restart. Token creation now checks for an existing value before writing, keeps the last three tokens in `vscode-mcp.authTokenHistory`, and `verifyDerivedToken` tries every stored secret. Installations stay valid even if a race happened.
- `server.ts` `saveClients` overwrote `globalState` with the in-memory list, wiping a client added by another window. Saves now merge with the current stored list and preserve `grantedScopes` when the incoming entry has none.
- `auth-oauth.ts` `verifyDerivedToken` and `/revoke` now reload clients from storage if the token is not found and try every known secret. A spoke that becomes the new hub after the old hub closes will find clients registered after it was created.

## [0.14.7] - 2026-08-28
### Fixed
- `server.ts` discarded `grantedScopes` when loading `vscode-mcp.oauthClients` from `globalState`, so a Mammouth client authorized as Full was verified as Standard and rejected with 401 `mcp_needs_auth`. Scopes now persist and restore correctly.
- `auth-oauth.ts` `verifyDerivedToken` and `/revoke` try the stored scopes, the legacy token (`HMAC(secret, clientId)`), and every preset. Installations broken by the 0.14.0 scope change recover without re-authorizing.
- Hardcoded `0.14.0` version in the MCP session server updated to the package version.

## [0.14.6] - 2026-08-28
### Fixed
- Restored full `WHEN TO USE` descriptions for all 64 tools. 0.14.1 had cut them to ~33 chars average and the agent looped over `list_files`/`read_file` instead of calling `execute_shell` to run WeasyPrint.

### Changed
- Kept pagination for large results: `list_files_code` now takes `limit` (1-500, default 100) and `offset`; `get_document_symbols_code` takes `maxItems` (1-300). Both return `{files, total, hasMore}` or a truncated banner instead of dumping everything.

## [0.14.5] - 2026-08-28
### Fixed
- First attempt at the same reload bug: migrated clients without `grantedScopes` to `standard` and accepted legacy tokens in `/revoke` and `verifyDerivedToken`. Superseded by 0.14.7 which persists scopes correctly.

## [0.14.4] - 2026-08-28
### Added
- Dashboard: 60-minute sparkline, per-tool avg/p95 latency, slowest-tools list, live search and tool/denied-only filters, burst alert on 4 denied in 8, per-client Revoke button, Blocked shell/sandbox panels, audit log (last 40) with Export JSON, and sandbox mode/host/port footer.

## [0.14.3] - 2026-08-28
### Changed
- Dashboard redesigned to a minimal native VS Code panel: `var(--vscode-editor-background)` background, 1px borders, three stat cards, Clients/Top-tools tables, plain tape. Removed the instrument-lab theme that broke readability.

## [0.14.1] - 2026-08-28
### Added
- Dashboard webview `vscode-mcp-server.openDashboard` with live tool feed, token estimate (`chars/4`), and cluster info.
- Token-efficiency (partially reverted in 0.14.6): added `limit`/`offset` and `maxItems` pagination. Description shortening from this version was reverted.

## [0.14.0] - 2026-08-26
### Added
- Scope presets `read-only` / `standard` / `full` mapped to 64 tools (`SCOPE_TOOLS`), `AsyncLocalStorage` per-request gate, `runWithScopes`/`checkToolAccess`.
- Shell guard: NFKC + invisible-char normalisation, base64-decode, split on `&&;|` before blocklist, checked before terminal dispatch.
- Audit log: FIFO 500 entries in `globalState`, `get_audit_log_code` (admin only).

## [0.13.1] - 2026-08-26
### Changed
- Stripped `//` and `/* */` comments from 7 `src/*.ts` files. Three `/**` remain inside string literals that generate docstrings.

## [0.13.0] - 2026-08-26
### Added
- Filesystem sandbox (`src/utils/sandbox.ts`, `src/utils/workspace.ts` `assertSandboxed` with `realpathSync` symlink check). Default mode `workspace` (fail-closed), `clusterRootsProvider` for hub/spoke windows, `resolveInputPath` in file tools.

## [0.12.42]

### Added

- Authentication on the MCP endpoint. Every call now carries a credential: a per-session bearer token by default, a static token you pin yourself, or MCP OAuth 2.1 with dynamic client registration and S256 PKCE for remote clients. Requests without a valid credential get a 401 before any tool runs.
- Origin validation. A web page you visit can no longer POST to your local server behind your back: cross-origin requests get a 403 before tokens are even considered. Extra origins can be allowlisted for tunneled clients (`vscode-mcp-server.auth.allowedOrigins`).
- New setting `vscode-mcp-server.auth.mode` with four values: `session-token` (default), `static-token`, `oauth`, `none`. `none` restores the previous open behavior and is documented as unsafe.

### Changed

- Clients configured before 0.12.0 must now send the access token with every request, as `Authorization: Bearer *** or `X-MCP-Token`. A notification at activation walks through the one-time setup.

### Security

- Token comparison runs in constant time. The token never appears in shell captures or logs; it shows up only in server info (to authenticated callers), the copy command and the activation notification.

## [0.11.1]

### Fixed

- A wrong shell verdict can no longer poison a terminal for the whole session. The probe that identifies the shell now needs positive evidence from the family itself: if the bash probe gets no readable answer (a busy pty once ate the leading characters, turning `printf` into `rintf`), PowerShell is asked directly instead of being assumed from silence — and a real command that finishes without its exit marker while spraying foreign parse errors invalidates the cached verdict and re-probes, so the next call wraps in the right dialect instead of burning every timeout.
- Shell output no longer leaks shell-integration control sequences: stray fragments like `]633;C` (OSC 633 command-boundary markers whose escape byte got swallowed upstream) and other OSC/CSI escapes are stripped from every captured command result before parsing and display.
- `memory_load_code` now tells agents explicitly to load memory once per conversation instead of on every message, so repeated loads stop burning tokens for unchanged content.
- Shell execution hardening. Terminal detection now matches shell names on word boundaries ("MCP Shell Commands" no longer reads as `sh`, which used to push POSIX syntax into PowerShell), then consults VS Code's own default-shell signals (`env.shell`, the platform's `terminal.integrated.defaultProfile` setting) each on their own merits instead of assuming win32 means PowerShell — so a Windows box whose default profile is Git Bash gets bash syntax. Terminals still classified by guess alone get one quiet probe round-trip to settle the question; an inconclusive probe (busy terminal, slow startup) retries on the next command rather than pinning a wrong verdict. A stale terminal left over from a previous window load is corrected too, even where the platform fallback says PowerShell — that leftover is exactly what kept feeding PowerShell syntax into Git Bash sessions after an upgrade. A timeout whose captured output shows shell parse errors now says so and points at a wrong-shell diagnosis; a legitimately slow quiet command just reports its timeout. The exit-code marker sits on its own line, so a command ending in a `#` comment can no longer swallow it and report failures as success; in PowerShell the whole template runs inside a script block with braces on their own lines — the same trailing comment can no longer eat the guard around the command either, and the helper variables stay scoped to the run instead of leaking into the session. A failed `Set-Location` skips the command instead of running it in whatever directory the terminal happened to sit in, `$LASTEXITCODE` is reset before each run so cmdlet-only commands report their real status, and working directories are single-quoted so spaces, quotes and backticks survive.
- `rename_file_code` and `move_file_code` refuse root-denoting paths like `.` instead of relocating (or trying to relocate) the workspace folder itself; the comparison folds case where the platform does (Windows, macOS).
- Scanner tools given an explicit path that does not exist (`find_secrets_code`, `security_scan_code`, `find_dead_code_code`) now fail loudly instead of scanning nothing and reporting a clean result. Targets outside every open folder are scanned and reported under their absolute path instead of being silently mangled into a wrong relative location.
- `check_env_vars_code` scans code usage inside the selected folder only — previously variables from other open folders showed up as missing or unused.
- Nested workspace folders resolve to the innermost open root for display and ownership, matching VS Code's own `getWorkspaceFolder` behavior.
- The `.vscode/extensions.json` recommendations file is size-capped on the buffer actually parsed, closing a stat/read race on the cap.

## [0.11.0]

### Added

- One port for every VS Code window (cluster mode). The first window to start owns the configured port and serves `http://localhost:3000/mcp` as before; any further window detects the taken port, verifies it is the same extension version, and joins silently — its folders become reachable through the same client URL with no extra MCP configuration. Tool calls are forwarded to whichever window owns the target folder, and a `FolderName/path` reference or the optional `workspace` parameter now resolves across all windows: names, labels (`proj-beta-2` when two windows open same-named folders) and 1-based indexes are cluster-wide. Whole-workspace diagnostics and symbol search fan out to every window and merge their sections; whole-cluster overviews from `list_workspace_folders_code` and `get_server_info_code`. The status bar shows `MCP Server: 3000 (joined)` on windows sharing another window's server. If the hosting window closes, the remaining windows elect a new host within seconds — the client URL keeps working throughout. A foreign program squatting on the port still fails with the explicit already-in-use error; a window running a different extension version refuses to join with reload guidance instead of split-brain.
- Multi-root workspace support. Every tool that takes a path or working directory accepts an optional `workspace` parameter: an open folder's name (case-insensitive) or its 1-based position. Relative paths resolve against that folder; omitting the parameter keeps using the first folder, so single-folder setups are unchanged. Folder names win over indexes, so a folder named "1" or "2" stays reachable by name. `list_workspace_folders_code` prints the numbering. With several folders open, results referencing files — listings, diagnostics, symbol locations, scanner reports — carry the owning folder's name as a prefix, and those `FolderName/path` forms plus absolute paths are accepted back as inputs by every path-based tool — including `cwd` of shell commands and the git-backed tools (`git_blame_code`, `get_file_history_code`, `get_git_diff_code`, `format_file_code`). Files outside every open root keep absolute paths in results so they still round-trip.
- Advanced tools (2): `get_server_info_code` reports the endpoint, extension/VS Code/Node versions, platform, uptime, open folders and per-tool call counts since activation — counters kept in memory only, nothing leaves the machine — plus whether VS Code runs inside a devcontainer, WSL or SSH remote; `list_extensions_code` lists installed extensions with versions and descriptions, optionally including built-ins, or with `missingOnly` shows the `.vscode/extensions.json` recommendations that are not installed yet.
- New `vscode-mcp-server.enabledTools.advanced` setting, enabled by default.
- Remote environments are surfaced where they matter: the status bar tooltip and the toggle notification point out when VS Code runs inside a devcontainer, WSL or SSH remote and the server is only reachable from within it.

## [0.10.0]

### Added

- Refactoring tools (4): `rename_symbol_code` (word-boundary rename across the workspace with dry-run), `extract_function_code` (line range into a new function plus call site), `find_duplicate_code_code` (normalised sliding-window duplicate blocks with all locations), `suggest_refactoring_code` (body length, parameter count, complexity estimate and nesting per function).
- Frontend tools (4): `audit_accessibility_code` (missing alt/labels, positive tabindex, clickable div/span, empty links, html lang), `analyze_css_code` (duplicate selectors, repeated properties, empty rules, !important overuse), `inspect_element_code` (markup usages plus CSS rules for a selector), `find_unused_css_code` (selectors never referenced in markup or scripts).
- Workflow tools (4): `run_task_code` (lists/runs package.json, composer.json and Makefile tasks through their own runner, with source prefixes like `make:build` when a name is shared), `build_project_code` (detects the build command, overridable, timed), `list_snippets_code` (snippets from `.vscode/snippets` and `.vscode/*.code-snippets`, JSONC tolerated), `run_alias_code` (shared shortcuts from `.mcp-aliases.json` at the workspace root).
- New `vscode-mcp-server.enabledTools.refactoring`, `enabledTools.frontend` and `enabledTools.workflow` settings, enabled by default.

### Fixed

- One hung tool call no longer takes down every other request: each MCP request now gets its own stateless session (transport + tool registry) instead of queueing behind a single shared transport. Previously a shell command exceeding the client timeout starved all later requests until clients reported "Not connected".
- `read_file_code` no longer refuses oversized files: text above `maxCharacters` comes back truncated with a note giving the full size, and `startLine`/`endLine` ranges are applied before the size cap so a narrow slice of a huge file reads fine. `maxCharacters: 0` disables the limit.
- Shell commands that exceed their time limit now return the output captured so far with exit code 124 and a note, instead of failing the whole call. The reader loop still stops consuming on timeout and the terminal queue accepts the next command immediately.
- Shell integration wait raised from 1s to 5s, avoiding spurious "Shell integration not available" errors on slow terminals.

## [0.9.0]

### Added

- Security tools (3): `find_secrets_code` (AWS/GitHub/Slack/Google/Stripe keys, private key blocks, JWTs and generic credential assignments — values masked, placeholders ignored), `security_scan_code` (risky constructs: eval, innerHTML sinks, shell-injection exec, disabled TLS verification, unsafe yaml/pickle/subprocess, SQL string concatenation), `check_dependencies_vulnerabilities_code` (npm audit with per-package advisories and patched versions).
- Performance tools (3): `analyze_bundle_code` (build output sizes with largest files and their share), `get_performance_report_code` (server uptime/memory, workspace weight, heaviest npm packages), `profile_command_code` (wall-clock timing of shell commands over repeated runs).
- New `vscode-mcp-server.enabledTools.security` and `enabledTools.performance` settings, enabled by default.

## [0.8.0]

### Added

- AI productivity tools (4): `find_dead_code_code` (exported symbols never referenced elsewhere), `snapshot_workspace_code` (SHA-256 snapshots with before/after compare), `regex_tester_code` (pattern testing with groups and replace preview), `convert_encoding_code` (utf-8 / utf-8-bom / utf-16le / latin1 detect and convert).
- New `vscode-mcp-server.enabledTools.productivity` setting, enabled by default.
- Branding: new extension logo, publisher and repository now point at Romixo's GitHub, display name "VSCodium MCP Server".

## [0.7.0] - 2026-08-22

### Added

- Persistent memory tools (4): `memory_load_code`, `memory_save_code`, `memory_search_code`, `memory_clear_code` — global memory in `~/Mammouth/MEMORY.md`, per-project memory as `{workspaceName}_MEMORY.md` in the workspace root, with dated entries organized under markdown sections.
- Testing tools (5): `run_tests_code` (auto-detects vitest/jest/pytest/mocha/playwright/cypress), `get_test_coverage_code` (coverage reports for vitest/jest/pytest), `format_document_code` (prettier/black/ruff/rustfmt/gofmt with check-only mode), `lint_and_fix_code` (eslint/ruff/flake8/pylint auto-fix), `get_git_diff_code` (staged/unstaged diffs).
- Git workflow tools (5): `commit_changes_code` (auto-generated conventional commit messages), `create_branch_code` (create/switch/list branches), `get_blame_code` (line-by-line authorship), `list_conflicts_code` (merge conflict markers), `stash_changes_code` (push/pop/list/drop/apply/show).
- Documentation tools (5): `get_package_dependencies_code` (npm/pip/cargo/go/composer/bundler), `get_file_history_code` (per-file git history with stats), `generate_docstring_code` (JSDoc/docstring/PHPDoc/GoDoc/Rustdoc generation), `get_project_context_code` (stack, structure, entry points, scripts, test setup), `find_todo_code` (TODO/FIXME scanning with severity classification).
- Developer productivity / database tools (5): `run_sql_query_code`, `test_api_endpoint_code`, `check_env_vars_code`, `get_open_ports_code`, `restart_dev_server_code`.
- New `vscode-mcp-server.enabledTools` settings for each tool group (`memory`, `test`, `git`, `documentation`, `database`), all enabled by default. The server restarts automatically when the configuration changes.

### Changed

- Total tool count grows from 5 to 29.
- TypeScript source recovered for the tool groups that previously only shipped as compiled JavaScript.

### Fixed

- Server stability on Windows: concurrent MCP requests no longer corrupt the shared stateless transport (requests are now serialized server-side), which was causing `MCP error -32000: Connection closed` / `Not connected` after a long-running command.
- `GET`/`DELETE /mcp` now answer with a spec-compliant bare `405` (+ `Allow: POST`) instead of a JSON-RPC error body that clients misread as a dropped connection.
- Shell execution is PowerShell-compatible: the working-directory prefix no longer uses bash-only `&&`, commands run through VS Code shell integration with per-terminal serialization, timeouts are enforced correctly, and the real exit code is captured via an end-of-output marker instead of always reporting success.
- On Windows the extension terminal now prefers Git Bash when installed, so bash syntax (`&&`, heredocs, forward-slash paths) works out of the box; PowerShell fallback stays fully supported.
- Git tools: exit codes are detected properly (failed commands are no longer reported as success), commit/stash messages and branch sources are safely quoted, empty branch-name slugs are rejected, blame line numbers parse from the correct field, and merge-conflict detection runs `git diff --name-only --diff-filter=U` first so clean merges report "no conflicts".
- Memory tools: clearing one entry keeps its section, clearing a whole section removes only that section, and search results attribute matches to the right scope/section.
- Database tools: environment-variable scan uses glob excludes (no regex crash), MySQL connection strings parse into proper host/port/user flags, PostgreSQL JSON output wraps arbitrary queries safely, port listing filters established connections, and every tool falls back cleanly when no terminal is available.
- Test tools: pytest detection no longer depends on requirements.txt being readable, formatter/linter detection checks the file extension before probing configs, test patterns are always quoted, coverage flags match each framework (c8 for mocha, `--coverage.include` for vitest, `--collectCoverageFrom` for jest), and formatting excerpts are capped at 100 lines.
- Documentation tools: `find_todo_code` no longer silently skips every file (a global-regex capture-group bug) and honors include/exclude globs correctly; cargo/poetry/Pipfile section parsing no longer truncates at inline arrays like `features = ["derive"]`; dependency ecosystem filters map npm/pypi/cargo aliases to their data keys; docstring replacement handles single-line existing docstrings.

## [0.4.0]

- Initial release
