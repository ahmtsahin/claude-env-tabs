# claude-env-tabs

Keep the folders you work in at the top of Claude Desktop's Code tab.

Pin a folder and **env-tabs** gives it:

- **A tab above the prompt.** Click it to open that folder's latest session. The tab of the folder you are in is highlighted, and `●` marks a folder with a session running.
- **A section at the top of the sidebar.** The section sits under Pinned, above the app's own list of folders, and the folder's sessions are filed into it. A new session started in the folder files itself there.

Sessions you filed into a section of your own, or pinned, stay where you put them.

## Why

The Code tab's sidebar orders its folder groups by itself (by recent activity, or A to Z), and there is no way to keep the ones you use most at the top. Many people have asked for one, on Windows and on macOS: see [anthropics/claude-code#70104](https://github.com/anthropics/claude-code/issues/70104), [anthropics/claude-code#66196](https://github.com/anthropics/claude-code/issues/66196) and [anthropics/claude-code#102088](https://github.com/anthropics/claude-code/issues/102088).

A mod cannot draw into the app's sidebar, so env-tabs uses the app's own sidebar sections for that, and draws its tabs above the prompt.

## Install

At the prompt of a terminal session:

```
/plugin install env-tabs --marketplace ahmtsahin/claude-env-tabs
```

From a shell:

```
claude plugin install env-tabs --marketplace ahmtsahin/claude-env-tabs
```

Answer `y` to add the marketplace and pick the user scope, so the tabs show in every session.

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `ahmtsahin/claude-env-tabs`, then **Add plugin**.

Requires Claude Desktop with mod support. Built and tested with Claude Code 2.1.301 on Windows 11. macOS uses the same code (sessions are opened with `open` instead of `rundll32`) and is covered by the tests, but has not been tried on a Mac yet.

## Use

- Click **+ Pin this folder** above the prompt in a session of the folder.
- Or ask Claude: *"pin this folder"*, *"move api to the first tab"*, *"unpin docs"*.
- Or use the command:

| Command | What it does |
| --- | --- |
| `/env-tabs` | Lists the pinned folders |
| `/env-tabs pin [folder]` | Pins this session's folder, or the one given |
| `/env-tabs unpin <n>` | Unpins tab `n` (or the tab with that label) and removes its section |
| `/env-tabs move <n> <to>` | Moves tab `n` to position `to` |
| `/env-tabs rename <n> <label>` | Renames tab `n` and its section |
| `/env-tabs sync` | Files each pinned folder's loose sessions into its section again |
| `/env-tabs status` | Shows what env-tabs sees |

## Good to know

- **Auto mode.** Claude Desktop's auto mode does not approve a mod moving *other* sessions. When that happens env-tabs says so; drag the sessions into the section, or ask Claude to move them (Claude can call the sidebar tool itself). In the default permission mode the app asks you instead.
- **Recent sessions only.** env-tabs reads your 60 most recent sessions, since the app caps the size of the session list it hands to a mod. Older sessions of a pinned folder stay in the app's list; drag them over if you want them in the section.
- **Section order.** Sections appear in the order you pinned the folders. Moving a tab does not move its section.
- **Per computer.** Pins are kept on the computer where you made them.

## Develop

```
claude plugin validate .
claude plugin test .
```

To run a working copy, start a session with `claude --plugin-dir <this folder>`, or name the folder in `CLAUDE_CODE_PLUGIN_DIRS`.

## Türkçe

Claude Desktop'ın Code sekmesinde sık kullandığın klasörleri en üste sabitler. Sabitlediğin her klasör için promptun üstüne bir sekme koyar (tıklayınca o klasörün son oturumu açılır) ve sidebar'ın en üstünde bir bölüm açıp o klasörün oturumlarını içine taşır. Kurulum ve kullanım için yukarıdaki adımlara bak; Claude'a Türkçe "bu klasörü sabitle" demen de yeterli.

## License

[MIT](LICENSE)
