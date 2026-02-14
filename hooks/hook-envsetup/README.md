# hook-envsetup

Claude Code hook that warns when environment activation may be needed before running commands.

## Overview

Detects when a project uses version managers (nvm, pyenv, asdf, rbenv) or virtual environments, and warns via stderr if the command being run might need them activated first. This is advisory only — it never blocks commands.

## Hook Event

- **PreToolUse** (matcher: `Bash`)

## Detected Environments

| Config File | Environment | Commands Watched |
|-------------|-------------|------------------|
| `.nvmrc`, `.node-version` | nvm | `node`, `npm`, `npx`, `yarn`, `pnpm` |
| `.python-version`, `Pipfile`, `requirements.txt` | Python venv | `python`, `pip`, `pipenv` |
| `poetry.lock` | Poetry | `python`, `pip`, `poetry` |
| `.tool-versions` | asdf | `node`, `python`, `ruby`, `go`, etc. |
| `.ruby-version` | rbenv | `ruby`, `gem`, `bundle`, `rails` |

## Behavior

1. Fires before every Bash command
2. Checks if environment config files exist in the working directory
3. Checks if the command involves tools that need the environment
4. If env file exists but activation is not in the command, logs a warning to stderr
5. Always outputs `{ decision: "approve" }` — never blocks

## Smart Detection

The hook skips warnings when:
- The command already includes the activation step (`nvm use`, `source .venv/bin/activate`, etc.)
- The relevant environment variable is already set (`VIRTUAL_ENV`, `NVM_DIR`)
- The `.venv` directory doesn't exist yet (suggests creating one instead)

## License

Apache-2.0
