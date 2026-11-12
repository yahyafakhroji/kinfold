Kinfold {{VERSION}} is one program for macOS, Linux and Windows. It gives Claude Code, OpenCode, Codex and Cursor a shared local memory, stored on your machine.

## Install

With Node 18 or later:

```sh
npx kinfold@{{VERSION}} install
```

On macOS or Linux, without Node:

```sh
curl -fsSL https://github.com/yahyafakhroji/kinfold/releases/download/v{{VERSION}}/install.sh | KINFOLD_VERSION={{VERSION}} sh
```

On Windows, in PowerShell:

```powershell
$env:KINFOLD_VERSION = '{{VERSION}}'; irm https://github.com/yahyafakhroji/kinfold/releases/download/v{{VERSION}}/install.ps1 | iex
```

The curl and PowerShell installers check the program against the SHA256SUMS below before they run it. A program installed through npm checks its own bytes against the same list before `install` changes anything. The npm packages carry the same programs, with npm provenance that links them to this release's build.

WSL is a preview in this release. Agents inside a WSL distro use the memory of the Windows install, and WSL needs mirrored networking for that.

## Checksums

```text
{{SHA256SUMS}}
```

Setup, the security model and the comparison with other memory tools are in the [README](https://github.com/yahyafakhroji/kinfold#readme).
