# VSCode Reveal Repo

Working with dozens of Git clones in a multi-root workspace?

Spending too much time scrolling through the Source Control view to find the repository that owns the active file?

Scroll no longer!

Reveal Repo selects the Git repository for the active editor file in VS Code's Source Control view.

## Usage

1. Open a file that belongs to a Git repository in the current workspace.
1. Run `Git: Select Repository of Active File` from the Command Palette.
1. VS Code opens the Source Control view and selects the repository for the active file.

The extension makes most sense if bound to a keyboard shortcut, e.g.:

```json
{
    "key": "ctrl+alt+g",
    "command": "activeGitRepository.select"
}
```

## Recommended VS Code Settings

```json
{
    "scm.alwaysShowRepositories": true
}
```

## How It Works

Reveal Repo uses VS Code's built-in Git extension API to find the repository for the active file, then opens and focuses the Source Control repositories view. Since VS Code's private `scm<N>` commands do not reliably map back to Git repositories, Reveal Repo navigates the visible repositories list directly and selects the repository that matches the active file.

This functionality would ideally live directly in VS Code. A related feature request existed upstream but seems abandoned: <https://github.com/microsoft/vscode/issues/152653>.
