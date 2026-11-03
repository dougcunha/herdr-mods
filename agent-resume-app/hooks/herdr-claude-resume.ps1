# Claude Code hook for the Herdr app mod "agent-resume".
# It writes the Claude session id on the herdr-core terminal as labels:
#   claude.session = the session id
#   claude.pid     = the pid of the shell that runs Claude now
# After a reboot, herdr-core gives the terminal a new shell with a new pid.
# The mod sees the different pid and types "claude --resume <id>" in the shell.
#
# Usage (from ~/.claude/settings.json):
#   SessionStart: powershell -NoProfile -ExecutionPolicy Bypass -File <this file> start
#   SessionEnd:   powershell -NoProfile -ExecutionPolicy Bypass -File <this file> end

param([string]$Action = "")

# Only terminals of herdr-core have this variable.
$terminal = $env:HC_TERMINAL_ID
if ([string]::IsNullOrWhiteSpace($terminal)) { exit 0 }

# Read the hook input as UTF-8 bytes.
$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)
$text = $reader.ReadToEnd()
try {
    $payload = if ([string]::IsNullOrWhiteSpace($text)) { $null } else { $text | ConvertFrom-Json }
} catch {
    exit 0
}
if ($null -eq $payload) { exit 0 }

# Sub-agents share the terminal of the main session. Do not record them.
if (-not [string]::IsNullOrWhiteSpace($payload.agent_id)) { exit 0 }

$sessionId = $payload.session_id
if ([string]::IsNullOrWhiteSpace($sessionId)) { exit 0 }

# Find the claude process above this hook, to read its command line.
function Get-ClaudeCommandLine {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$PID" -ErrorAction SilentlyContinue
    for ($i = 0; $i -lt 8 -and $null -ne $proc; $i++) {
        if ($proc.Name -match '^claude(\.exe)?$' -or $proc.CommandLine -match '[\\/]@anthropic-ai[\\/]claude-code[\\/]') {
            return $proc.CommandLine
        }
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($proc.ParentProcessId)" -ErrorAction SilentlyContinue
    }
    return $null
}

# Keep the flags that change how Claude runs. Drop the session flags and any prompt text.
function Get-ResumeArgs([string]$commandLine) {
    $tokens = [regex]::Matches($commandLine, '"[^"]*"|\S+') | ForEach-Object { $_.Value.Trim('"') }
    $tokens = @($tokens | Select-Object -Skip 1)
    $withValue = @('--model', '--permission-mode', '--effort', '--agent', '--settings', '--add-dir', '--mcp-config', '--fallback-model')
    $sessionFlags = @('--resume', '-r', '--continue', '-c', '--session-id', '--fork-session', '--from-pr')
    $keep = New-Object System.Collections.Generic.List[string]
    for ($i = 0; $i -lt $tokens.Count; $i++) {
        $tok = $tokens[$i]
        $name = ($tok -split '=', 2)[0]
        if ($sessionFlags -contains $name) {
            # Skip the value of --resume <id> and --session-id <id>.
            if ($tok -notmatch '=' -and $i + 1 -lt $tokens.Count -and $tokens[$i + 1] -notmatch '^-') { $i++ }
            continue
        }
        if ($withValue -contains $tok -and $i + 1 -lt $tokens.Count) {
            $keep.Add($tok); $keep.Add($tokens[$i + 1]); $i++
            continue
        }
        if ($tok -match '^--?[A-Za-z][\w-]*(=[\w.:/\\-]+)?$') { $keep.Add($tok) }
    }
    # Only safe characters go to the shell later.
    return (@($keep | Where-Object { $_ -match '^[\w.:/\\=-]+$' }) -join ' ')
}

try {
    $info = hc get $terminal --json 2>$null | ConvertFrom-Json
} catch {
    exit 0
}
if ($null -eq $info) { exit 0 }

if ($Action -eq "start") {
    $commandLine = Get-ClaudeCommandLine
    # "claude -p" (print mode) is a one-shot run, often from a script or an agent. Do not record it.
    if ($null -eq $commandLine) { exit 0 }
    if ($commandLine -match '(\s|^)(-p|--print)(\s|=|$)') { exit 0 }
    $resumeArgs = Get-ResumeArgs $commandLine
    # "claude.tried=" removes the mark of an earlier resume attempt.
    hc label $terminal "claude.session=$sessionId" "claude.pid=$($info.pid)" "claude.args=$resumeArgs" "claude.tried=" 2>$null | Out-Null
    exit 0
}

if ($Action -eq "end") {
    # Remove the labels only when the person exits Claude.
    # "other" can be a Windows shutdown: keep the labels for the resume.
    # "clear" starts a new session: the next SessionStart replaces the labels.
    $reason = "$($payload.reason)"
    if ($reason -ne "prompt_input_exit" -and $reason -ne "logout") { exit 0 }
    if ($info.labels.'claude.session' -ne $sessionId) { exit 0 }
    hc label $terminal "claude.session=" "claude.pid=" "claude.args=" "claude.tried=" 2>$null | Out-Null
    exit 0
}
