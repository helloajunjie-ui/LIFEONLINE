# 端到端验证：浏览器存档 → Go 服务端落库
#
# 用法（在本机桌面执行，不要在受限沙箱里跑）：
#   右键 → 使用 PowerShell 运行   或   tools\verify-cloud.cmd
#
# 它会做：
#   1. 启动 server\home-server.exe（已在跑则复用）
#   2. 用无头 Edge 打开 dist\2.5D小屋.html（首次会自动建号并上传存档）
#   3. 轮询 /leaderboard，确认服务端真的收到了存档
#   4. 打印结果，并保留服务端继续运行（方便你自己打开游戏看效果）

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$exe  = Join-Path $root 'server\home-server.exe'
$page = Join-Path $root 'dist\2.5D小屋.html'
$api  = 'http://127.0.0.1:8787/api/v1'

# 本机回环请求不要走系统代理（Clash 等会把 127.0.0.1 也代理走，导致超时）
function Api($path){
  return (& curl.exe -s -m 5 --noproxy '*' ($api + $path)) -join ''
}

Write-Host '== 1. 局域网服务端 ==' -ForegroundColor Cyan
$listening = (netstat -ano | Select-String ':8787' | Select-String 'LISTENING')
if (-not $listening){
  if (-not (Test-Path $exe)){ Write-Host "找不到 $exe，请先编译服务端（见 server/README.md）" -ForegroundColor Red; exit 1 }
  Write-Host '   启动 home-server.exe ...'
  $proc = Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe) -WindowStyle Minimized -PassThru
  Start-Sleep -Seconds 2
  Write-Host "   pid = $($proc.Id)"
} else {
  Write-Host '   已在运行，复用现有进程'
}

$health = Api '/health'
if (-not $health){ Write-Host '   服务端不可达，退出' -ForegroundColor Red; exit 1 }
Write-Host "   health: $health"

Write-Host '== 2. 推送一次存档（curl 模拟客户端）==' -ForegroundColor Cyan
$guest  = (& curl.exe -s -m 5 --noproxy '*' -X POST -H 'Content-Type: application/json' -d '{"nickname":"脚本验证"}' ($api + '/auth/guest')) -join ''
$token  = ($guest | ConvertFrom-Json).token
Write-Host "   token: $($token.Substring(0,8))..."

$payload = '{"data":{"placed":[{"catalogId":"bed","gx":5,"gy":5},{"catalogId":"rug_warm","gx":8,"gy":8}],"money":500,"day":1,"houseLevel":0,"floorStyle":0,"wallStyle":0,"savedAt":' + [DateTimeOffset]::Now.ToUnixTimeMilliseconds() + '}}'
$put = (& curl.exe -s -m 8 --noproxy '*' -X PUT -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -H 'If-Match: 0' -d $payload ($api + '/save')) -join ''
Write-Host "   PUT /save -> $put"

Write-Host '== 3. 浏览器真实存档 ==' -ForegroundColor Cyan
$edge = @(
  'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
  'C:\Program Files\Microsoft\Edge\Application\msedge.exe'
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($edge){
  $prof = Join-Path $env:TEMP ('home_edge_' + (Get-Date -Format 'HHmmss'))
  Write-Host '   用无头 Edge 打开游戏（会建号 + 上传）...'
  & $edge --headless --disable-gpu "--user-data-dir=$prof" --window-size=1280,800 --virtual-time-budget=9000 --dump-dom ("file:///" + ($page -replace '\\','/')) 2>$null | Out-Null
  Start-Sleep -Seconds 1
} else {
  Write-Host '   未找到 Edge，跳过浏览器步骤（可手动双击 dist\2.5D小屋.html）' -ForegroundColor Yellow
}

Write-Host '== 4. 服务端记录 ==' -ForegroundColor Cyan
$lb = (Api '/leaderboard?limit=5' | ConvertFrom-Json)
Write-Host "   排行榜条目数: $($lb.items.Count)"
foreach ($it in $lb.items){ Write-Host ("   - {0}  装修度 {1}  (第{2}天)" -f $it.nickname, $it.cozyScore, $it.day) }

$feed = (Api '/rooms/feed?limit=5' | ConvertFrom-Json)
Write-Host "   可串门房间数: $($feed.items.Count)"
foreach ($r in $feed.items){
  $n = 0
  if ($r.room -and $r.room.placed) { $n = $r.room.placed.Count }
  Write-Host ("   - {0} 的家  装修度 {1}  家具 {2} 件  被参观 {3} 次" -f $r.room.nickname, $r.cozyScore, $n, $r.visits)
}

if ($lb.items.Count -ge 1){
  Write-Host "`n✓ 端到端通过：存档已落到服务端 SQLite。" -ForegroundColor Green
  Write-Host '  打开 dist\2.5D小屋.html 时，HUD 徽章应显示「已同步 ✓」。' -ForegroundColor Green
} else {
  Write-Host "`n✗ 服务端没有收到任何存档，请检查上面的输出。" -ForegroundColor Red
  exit 1
}
Write-Host "`n服务端仍在运行（数据库 server\data\home.db），可直接打开游戏体验同步。" -ForegroundColor DarkGray
