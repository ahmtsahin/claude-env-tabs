# claude-env-tabs

Keep the projects you work in at the top of Claude Desktop's Code tab.

Pin a project and **env-tabs** gives it:

- **A place at the top of the Projects pane.** The pane sits beside the conversation and lists your recent projects with their sessions, the way the sidebar does, but the pinned ones stay on top, in the order you choose. Each project has an icon, its first letter on a color of its own, and the project you are in is highlighted. Click a project to open or close its list, click a session to open it. Point at a project's row for **+ New**, which starts a new session in it, and **Pin** or **Unpin** (on the terminal they always show).
- **Session states, as the sidebar's dots show them.** Each session has a dot: amber when it waits for you (a permission or a question), blue when it finished since you last looked at it, grey and pulsing while it runs. A project's row and its tab count the sessions that wait for you or are unread, amber while one waits.
- **A tab above the prompt.** It carries the project's icon. Click it to open that project's latest session, or to start one in its folder when it has none yet. The tab of the project you are in is highlighted.

Your sessions are not moved or filed anywhere: the app's own sidebar stays as it is.

## Why

The Code tab's sidebar orders its folder groups by itself (by recent activity, or A to Z), and there is no way to keep the ones you use most at the top. Many people have asked for one, on Windows and on macOS: see [anthropics/claude-code#70104](https://github.com/anthropics/claude-code/issues/70104), [anthropics/claude-code#66196](https://github.com/anthropics/claude-code/issues/66196) and [anthropics/claude-code#102088](https://github.com/anthropics/claude-code/issues/102088).

Neither a mod nor Claude can pin a folder group in the app's sidebar or draw into it, so env-tabs draws a Projects pane of its own beside the conversation, and its tabs above the prompt.

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

- The Projects pane opens by itself when the window has room for it beside the conversation. Otherwise click **Projects** above the prompt, or run `/env-tabs panel`. Close it and it stays closed in later sessions until you open it again.
- Click **Pin** on a project in the pane, or **+ Pin this folder** above the prompt in a session of the project.
- Or ask Claude: *"pin this project"*, *"move api to the first tab"*, *"unpin docs"*.
- Or use the command:

| Command | What it does |
| --- | --- |
| `/env-tabs` | Lists the pinned projects |
| `/env-tabs pin [folder]` | Pins this session's project, or the folder given |
| `/env-tabs unpin <n>` | Unpins tab `n` (or the tab with that label) |
| `/env-tabs move <n> <to>` | Moves tab `n` to position `to`, in the pane too |
| `/env-tabs rename <n> <label>` | Renames tab `n` and its project in the pane |
| `/env-tabs panel` | Opens the Projects pane |
| `/env-tabs status` | Shows what env-tabs sees |

## Good to know

- **A project is a folder, as in the sidebar.** A session is listed under the folder it runs in, so a project inside a pinned folder keeps its own row: pinning `D:\Code` does not gather `D:\Code\api` under it. Pin that one too.
- **Worktrees.** A session in one of a repository's worktrees (`.claude/worktrees/...`) is listed under the repository, and pinning from such a session pins the repository.
- **This computer.** A session started without a folder runs in a scratch folder the app makes for it. The pane lists all of these sessions in one row, This computer, at the bottom of Projects. There is no folder to start a session in or to pin, so that row has no **+ New** or **Pin**, and a scratch session offers no **+ Pin this folder**.
- **Where the states come from.** Every 4 seconds env-tabs reads the file each running session keeps in `~/.claude/sessions` (busy, idle, or waiting for you) and the desktop's own record of each session (when you last looked at it, when it last did something). `/env-tabs status` says where it found them. The session you are in is never shown as unread.
- **Recent sessions only.** env-tabs reads your 60 most recent sessions, since the app caps the size of the session list it hands to a mod. A project with no session among them is not listed until you pin it, and the pane shows up to 5 sessions per project.
- **New sessions.** **+ New** and a tab with no session open the app's documented link, `claude://code/new?folder=...`. The app asks you to confirm the folder each time (**Trust workspace**), since it does not trust a folder that comes from a link, even one you trusted before. Now and then the app still starts the session in a new scratch folder instead, and its Environment card shows **Choose folder…**: choose the folder there before you send the first message.
- **Per computer.** Pins are kept on the computer where you made them.

## Develop

```
claude plugin validate .
claude plugin test .
```

To run a working copy, start a session with `claude --plugin-dir <this folder>`, or name the folder in `CLAUDE_CODE_PLUGIN_DIRS`.

## Türkçe

Claude Desktop'ın Code sekmesinde sık kullandığın projeleri en üstte tutar. Sohbetin yanında bir **Projeler** paneli açar: son projelerin oturumlarıyla birlikte orada listelenir, sabitlediklerin en üstte durur. Her projenin kendi renginde, baş harfiyle bir ikonu var; içinde bulunduğun proje vurgulanır. Her oturumun yanında sidebar'daki gibi bir nokta durur: sarı seni bekliyor (izin ya da soru), mavi sen baktıktan sonra bitti, gri ve yanıp sönen çalışıyor; projenin satırı ve sekmesi seni bekleyen ya da okunmamış oturumları sayar. Bir projenin satırının üzerine gelince çıkan **Pin** / **Unpin** ile sabitler ya da kaldırırsın, bir oturuma tıklayınca o oturum açılır, yine satırda çıkan **+ New** ile o projede yeni bir oturum başlatırsın (uygulama klasörü her seferinde **Trust workspace** ile onaylatır; Environment kartında **Choose folder…** görürsen ilk mesajı göndermeden klasörü orada seç). Ayrıca sabitlediğin her proje için promptun üstüne bir sekme koyar. Her oturum, sidebar'daki gibi çalıştığı klasörün altında listelenir: sabitlediğin bir klasörün içindeki projeler kendi satırlarında görünür, onları da ayrıca sabitleyebilirsin. Klasör seçmeden başlattığın oturumlar uygulamanın açtığı scratch klasörlerinde çalışır; panel bunları en altta tek bir **This computer** satırında toplar. Oturumların hiçbir yere taşınmaz, uygulamanın kendi sidebar'ı olduğu gibi kalır. Claude'a Türkçe "bu projeyi sabitle" demen de yeterli.

## License

[MIT](LICENSE)
