# Herdr Plugins

Plugins for [Herdr](https://github.com/herdrdev/herdr).

## Plugins

| Plugin | Description |
| ------ | ----------- |
| [CI Dash](ci-dash/README.md) | Run and watch GitHub Actions workflows from a Herdr pane. |

## Install a plugin

Each plugin lives in its own directory and is linked with the Herdr CLI. For
CI Dash:

```sh
cd ci-dash
npm ci --omit=dev
herdr plugin link .
```

See the plugin README for requirements, keybindings, and configuration.

## Topics

This repository is tagged with
[`herdr-plugin`](https://github.com/topics/herdr-plugin).

## License

MIT
