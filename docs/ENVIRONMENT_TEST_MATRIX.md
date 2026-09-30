# Environment test matrix (Windows, 2026-09-28)

Test board: `https://miro.com/app/board/uXjVJSz4qHA=/`. Test vault:
`OBS_TEST`. No credential values were saved in this repository or test log.

| Environment | Result | Evidence / limit |
|---|---|---|
| Browser-only workflow, with Miro Desktop closed | Browser bridge works | Dedicated Chromium reused its signed-in profile, loaded `TEST_BOARD`, and exposed a loopback CDP endpoint to a separate process and the default Codex CLI. This tests independence from a running Desktop app; the Desktop binary was still installed on this PC. |
| Browser-only workflow, clean profile | First login handled | Miro redirected the dashboard to sign-in. The bridge opened the sign-in page and stopped before starting the agent. The account owner then signed in once; later runs reused that profile. |
| Live Web SDK export through `Miro to Obsidian - local export` | Passed | The owner opened the correct installed app on `TEST_BOARD` and downloaded `OBS_TEST/miro-websdk-export-board-1790616426147.json` on 2026-09-28. Strict `validate_websdk_export` passed for board `uXjVJSz4qHA=`: 477 items, `maximum_board_v1`, complete Web SDK capture. The app explicitly reports unsupported-item and comment-content limits. |
| Live REST + Web SDK union | Passed with public API limits | The agent transferred the correct app's credentials through a loopback browser form without reading their values, completed OAuth, and ran the pipeline with the OS-stored token and the owner's earlier Web SDK JSON. The canonical source contains 479 items; the validated `miro-canvas` has 445 nodes and 30 edges. Required assets completed with no failures: 78 images, 1 document, and 2 `doc_format` items. The missing-item audit reports 0 actionable omissions. Its remaining 8 entries are board metadata (2), intentional PDF page preview slots (5), and source coverage limited by Miro's public APIs (1). The earlier Web-SDK-only Canvas is a diagnostic artifact, not the final output. |
| Repeat Web SDK capture by agent | Blocked in this browser | After reloading `TEST_BOARD`, the authorized in-app browser's Miro Tools catalog listed only the older `export to Json` app under `export`; searching for `Miro to Obsidian` returned no result. The agent could not repeat the whole-board download through the correct app in that browser. The successful union used the owner-downloaded, strictly validated capture instead. |
| Miro Desktop present | Not verified | The signed per-user Miro executable launched and exposed an Electron webview, but its separate sign-in required a browser-to-Desktop return link that did not work for the account owner. Per the owner's instruction, Desktop export was left untested. |
| Code conversion without Miro access | Passed | Source and packaged CLI each converted the local canonical JSON fixture to `miro-canvas` in `OBS_TEST`; the resulting Canvas passed schema validation. This is a conversion test, not a fresh Miro export. |
| Packaged Windows runtime | Passed | Fresh PyInstaller CLI and GUI builds passed `--self-test`; CLI passed `--browser-self-test` and exposes the new `setup-serve --help` command. This machine did not test macOS or Linux binaries. |
| OS credential store inside Codex sandbox | Restricted | Windows Credential Manager returned Win32 error 1312 in a sandboxed process. The same user's unsandboxed process read the saved token and completed the REST export. Run credential-dependent imports in the normal user session. |
| Obsidian `miro-canvas` plugin | Installed and enabled | `OBS_TEST/.obsidian/plugins/miro-canvas` exists and `community-plugins.json` enables it. The final Canvas passed schema and local file-reference checks; interactive rendering in Obsidian was not observed because Obsidian was not running. |

The Agent browser path is deliberately independent of Miro Desktop. On a
machine without Desktop, it uses the same dedicated Chromium profile; on this
machine, closing Desktop did not change that path. A live run on a machine
where Miro Desktop is actually absent remains to be verified.

## Follow-up (2026-09-30)

| Check | Result | Evidence / limit |
|---|---|---|
| Correct app settings and installation | Settings verified; board launch still blocked | The signed-in Miro developer settings showed the correct app's Web SDK URL at `http://localhost:8766/index.html` and OAuth callback at `http://localhost:8765/callback`. The app's installation link completed the Dev team consent flow and returned to Miro, but the in-app browser's `TEST_BOARD` Tools catalog still showed only the older exporter. A new Web SDK download through the correct app was not obtained. |
| Independent managed Chromium rerun | Board readiness unverified | The bridge navigated to the board URL, but Chromium displayed Miro's loading screen for more than 65 seconds. Its current readiness check accepts a `/app/dashboard` or `/app/board/` URL after `domcontentloaded`; that does not prove the board UI has loaded. This run produced no new export. |
| Other Windows browser UI | Tool stopped | An attempt to inspect the available browser through Windows Computer Use stopped because that tool could not determine the current browser URL with enough confidence. No Miro action or export was completed through that route. |

The successful REST/Web SDK union above used the owner's earlier validated JSON.
Agent-only creation, installation, and fresh Web SDK capture remain unverified
end to end on this PC. The two temporary local servers used for this follow-up
were stopped afterward.
