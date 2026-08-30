$ErrorActionPreference = "Stop"
$TaskName = "wechat-codex-bridge"

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "已移除计划任务：$TaskName"
} else {
  Write-Host "未找到计划任务：$TaskName"
}
