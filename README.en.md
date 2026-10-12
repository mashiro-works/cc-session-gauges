# cc-session-gauges

A personal marketplace of Claude Code Mods. Not an official Anthropic project.

A plugin marketplace for Claude Code Mods. Japanese: [README.md](README.md)

## Mods

| Mod | What it does |
|-----|--------------|
| model-watch | Records which model answered each request and shows it in a band above the prompt. `/model-watch report` prints a summary; `/model-watch force opus` pins the subagent model |
| usage-band | Shows 5-hour and weekly usage limits above the prompt at all times |
| delete-guard | Requires a reason and impact for delete commands such as `rm -rf`, then asks you to confirm |

## Install

```
/plugin marketplace add mashiro-works/cc-session-gauges
/plugin install model-watch@cc-session-gauges
```

To try without installing: `git clone` this repository and run `claude --plugin-dir ./plugins/model-watch`.

Run `claude plugin validate ./plugins/model-watch` to list the events a Mod handles and the APIs it calls. Mods run with your permissions and are not sandboxed.

## Requirements

Claude Code 2.1.287 or later (Desktop app 2.1.286 or later). Tested on 2.1.295.

## Disable

Start with `--safe-mode`, or disable the Mod from the Installed tab in `/plugin`.

## Known limitations

- model-watch may not capture internal engine requests (such as title generation)
- Installing both usage-band and model-watch stacks two bands above the prompt
- delete-guard matches strings, so it also reacts to text inside heredocs

## License

MIT
