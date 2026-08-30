# 使用“任务计划程序”注册登录时自动启动的 Windows 后台任务。
# 需要先完成一次前台登录，让 state/auth.json 保存 token：
#   npm start

$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$TaskName = "wechat-codex-bridge"
$Node = (Get-Command node.exe -ErrorAction Stop).Source
$Script = Join-Path $ProjectDir "index.mjs"

$Action = New-ScheduledTaskAction `
  -Execute $Node `
  -Argument "`"$Script`"" `
  -WorkingDirectory $ProjectDir

$Trigger = New-ScheduledTaskTrigger -AtLogOn

$Principal = New-ScheduledTaskPrincipal `
  -UserId $env:USERNAME `
  -LogonType Interactive `
  -RunLevel Limited

$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $Action `
  -Trigger $Trigger `
  -Principal $Principal `
  -Settings $Settings `
  -Force | Out-Null

Write-Host "已注册计划任务：$TaskName"
Write-Host "查看状态：Get-ScheduledTask -TaskName $TaskName"
Write-Host "手动启动：Start-ScheduledTask -TaskName $TaskName"
