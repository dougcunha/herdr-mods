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

try {
    $info = hc get $terminal --json 2>$null | ConvertFrom-Json
} catch {
    exit 0
}
if ($null -eq $info) { exit 0 }

if ($Action -eq "start") {
    # "claude.tried=" removes the mark of an earlier resume attempt.
    hc label $terminal "claude.session=$sessionId" "claude.pid=$($info.pid)" "claude.tried=" 2>$null | Out-Null
    exit 0
}

if ($Action -eq "end") {
    # Remove the labels only when the person exits Claude.
    # "other" can be a Windows shutdown: keep the labels for the resume.
    # "clear" starts a new session: the next SessionStart replaces the labels.
    $reason = "$($payload.reason)"
    if ($reason -ne "prompt_input_exit" -and $reason -ne "logout") { exit 0 }
    if ($info.labels.'claude.session' -ne $sessionId) { exit 0 }
    hc label $terminal "claude.session=" "claude.pid=" "claude.tried=" 2>$null | Out-Null
    exit 0
}
