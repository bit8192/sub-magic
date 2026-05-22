param(
	[string]$ConfigPath = (Join-Path (Get-Location).Path 'config.yaml'),
	[Parameter(Mandatory = $true)]
	[string]$SubUrl,
	[string]$TaskName = 'sub-magic',
	[string]$UpdateScriptName = 'sub-magic.ps1'
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Write-Step {
	param([string]$Message)
	Write-Host "==> $Message"
}

function Confirm-Action {
	param(
		[string]$Message,
		[bool]$DefaultYes = $false
	)

	$hint = if ($DefaultYes) { '[Y/n]' } else { '[y/N]' }
	$answer = Read-Host "$Message $hint"
	if ([string]::IsNullOrWhiteSpace($answer)) {
		return $DefaultYes
	}

	return $answer.Trim().ToLowerInvariant() -in @('y', 'yes')
}

function Get-MihomoService {
	$services = Get-CimInstance Win32_Service | Where-Object {
		$joined = @($_.Name, $_.DisplayName, $_.PathName) -join ' '
		$joined -match '(?i)mihomo'
	}
	return $services | Sort-Object {
		if ($_.Name -eq 'mihomo') { 0 } elseif ($_.DisplayName -match '(?i)^mihomo$') { 1 } else { 2 }
	} | Select-Object -First 1
}

function Get-LocalMihomoExe {
	param([string]$Directory)

	$exact = Join-Path $Directory 'mihomo.exe'
	if (Test-Path -LiteralPath $exact) {
		return (Get-Item -LiteralPath $exact).FullName
	}

	$candidates = Get-ChildItem -LiteralPath $Directory -Filter 'mihomo*.exe' -File -ErrorAction SilentlyContinue |
		Sort-Object LastWriteTimeUtc -Descending
	return ($candidates | Select-Object -First 1).FullName
}

function Get-WindowsAssetPatterns {
	$arch = $env:PROCESSOR_ARCHITEW6432
	if ([string]::IsNullOrWhiteSpace($arch)) {
		$arch = $env:PROCESSOR_ARCHITECTURE
	}

	switch -Regex ($arch) {
		'ARM64' { return @('windows-arm64') }
		'86' { return @('windows-386') }
		default { return @('windows-amd64-compatible', 'windows-amd64') }
	}
}

function Escape-PowerShellSingleQuoted {
	param([string]$Value)
	return $Value.Replace("'", "''")
}

function Get-LatestMihomoAsset {
	$releaseApi = 'https://api.github.com/repos/MetaCubeX/mihomo/releases/latest'
	$headers = @{
		'User-Agent' = 'sub-magic-installer'
		'Accept' = 'application/vnd.github+json'
	}

	Write-Step '正在解析 Mihomo 最新 Windows 发布信息'
	$release = Invoke-RestMethod -Uri $releaseApi -Headers $headers
	if (-not $release.assets) {
		throw 'GitHub Releases 未返回可下载资产。'
	}

	foreach ($pattern in Get-WindowsAssetPatterns) {
		$asset = $release.assets | Where-Object {
			$_.name -like "*$pattern*.zip"
		} | Select-Object -First 1
		if ($asset) {
			return $asset
		}
	}

	throw '未找到匹配当前 Windows 架构的 Mihomo 压缩包。'
}

function Download-MihomoExe {
	param([string]$TargetDirectory)

	$asset = Get-LatestMihomoAsset
	$tempZip = Join-Path $env:TEMP $asset.name
	$extractDir = Join-Path $env:TEMP ("sub-magic-mihomo-" + [guid]::NewGuid().ToString('N'))

	try {
		Write-Step "下载 $($asset.name)"
		Invoke-WebRequest -Uri $asset.browser_download_url -Headers @{ 'User-Agent' = 'sub-magic-installer' } -OutFile $tempZip

		Write-Step '解压 Mihomo 压缩包'
		Expand-Archive -LiteralPath $tempZip -DestinationPath $extractDir -Force

		$exe = Get-ChildItem -LiteralPath $extractDir -Filter 'mihomo*.exe' -File -Recurse |
			Sort-Object FullName |
			Select-Object -First 1
		if (-not $exe) {
			throw '压缩包中未找到 Mihomo 可执行文件。'
		}

		$targetExe = Join-Path $TargetDirectory 'mihomo.exe'
		Copy-Item -LiteralPath $exe.FullName -Destination $targetExe -Force
		Write-Step "已解压可执行文件到 $targetExe"
		return $targetExe
	} finally {
		if (Test-Path -LiteralPath $tempZip) {
			Remove-Item -LiteralPath $tempZip -Force -ErrorAction SilentlyContinue
		}
		if (Test-Path -LiteralPath $extractDir) {
			Remove-Item -LiteralPath $extractDir -Recurse -Force -ErrorAction SilentlyContinue
		}
	}
}

function Install-MihomoService {
	param(
		[string]$ExePath,
		[string]$ConfigFilePath
	)

	$configDir = Split-Path -Parent $ConfigFilePath
	if (-not (Test-Path -LiteralPath $configDir)) {
		New-Item -ItemType Directory -Path $configDir -Force | Out-Null
	}

	$serviceName = 'mihomo'
	$displayName = 'Mihomo Service'
	$binPath = "`"$ExePath`" -d `"$configDir`""

	$existing = Get-MihomoService
	if ($existing) {
		Write-Step "发现已存在的服务: $($existing.Name)，正在移除..."
		Stop-Service -Name $existing.Name -Force -ErrorAction SilentlyContinue
		sc.exe delete $existing.Name
		if ($LASTEXITCODE -ne 0) {
			throw "无法移除现有服务: $($existing.Name)"
		}
		Start-Sleep -Seconds 2
	}

	Write-Step "创建服务 $serviceName"
	New-Service -Name $serviceName -DisplayName $displayName -BinaryPathName $binPath -StartupType Automatic
	if (-not $?) {
		throw "New-Service 创建失败"
	}

	Write-Step "启动服务 $serviceName"
	Start-Service -Name $serviceName
}

function Install-UpdateScript {
	param(
		[string]$BaseUrl,
		[string]$ConfigFilePath,
		[string]$TargetScriptPath,
		[string]$SubscriptionUrl
	)

	Write-Step "下载自动更新脚本到 $TargetScriptPath"
	$rawContent = (New-Object System.Net.WebClient).DownloadString("$BaseUrl/sub-magic.ps1")
	$content = $rawContent.Replace('__CONFIG_PATH__', (Escape-PowerShellSingleQuoted $ConfigFilePath)).Replace('__SUB_URL__', (Escape-PowerShellSingleQuoted $SubscriptionUrl))
	[System.IO.File]::WriteAllText($TargetScriptPath, $content, [System.Text.UTF8Encoding]::new($false))
}

function Register-UpdateTask {
	param(
		[string]$ScheduledTaskName,
		[string]$ScriptPath
	)

	$startTime = [DateTime]::Now.AddMinutes(1).ToString('yyyy-MM-ddTHH:mm:ss')
	$xmlPath = Join-Path $env:TEMP "$ScheduledTaskName.xml"

	$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Sub Magic config updater</Description>
  </RegistrationInfo>
  <Principals>
    <Principal id="Author">
      <LogonType>S4U</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Triggers>
    <TimeTrigger>
      <Repetition>
        <Interval>PT1M</Interval>
        <Duration>P3650D</Duration>
      </Repetition>
      <StartBoundary>$startTime</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Actions Context="Author">
    <Exec>
      <Command>powershell.exe</Command>
      <Arguments>-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$ScriptPath"</Arguments>
    </Exec>
  </Actions>
  <Settings>
    <Enabled>true</Enabled>
  </Settings>
</Task>
"@
	try {
		[System.IO.File]::WriteAllText($xmlPath, $xml, [System.Text.Encoding]::Unicode)
		$env:_SCHTN = $ScheduledTaskName
		$env:_SCHTXML = $xmlPath
		Write-Step "注册计划任务 $ScheduledTaskName"
		cmd.exe /c --% schtasks /create /tn "%_SCHTN%" /xml "%_SCHTXML%" /f
		if ($LASTEXITCODE -ne 0) {
			throw "schtasks /create /xml 失败，退出码: $LASTEXITCODE"
		}
	} finally {
		Remove-Item env:_SCHTN, env:_SCHTXML -ErrorAction SilentlyContinue
		if (Test-Path -LiteralPath $xmlPath) {
			Remove-Item -LiteralPath $xmlPath -Force -ErrorAction SilentlyContinue
		}
	}

	schtasks /run /tn $ScheduledTaskName
}

if (-not [System.IO.Path]::IsPathRooted($ConfigPath)) {
	$ConfigPath = [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $ConfigPath))
}

$baseUrl = $SubUrl -replace '/sub/.*$', ''
$workDir = (Get-Location).Path
$updateScriptPath = Join-Path $workDir $UpdateScriptName

Write-Host "Config path: $ConfigPath"
Write-Host "Work dir:    $workDir"
Write-Host "Task name:   $TaskName"

$mihomoService = Get-MihomoService
$mihomoExePath = $null

if ($mihomoService) {
	Write-Step "检测到 Mihomo 服务: $($mihomoService.Name)"
} else {
	Write-Step '未检测到 Mihomo 服务'
	$mihomoExePath = Get-LocalMihomoExe -Directory $workDir

	if (-not $mihomoExePath) {
		if (Confirm-Action -Message '当前目录未找到 Mihomo 可执行程序，是否尝试从 https://github.com/MetaCubeX/mihomo/releases 下载当前 Windows 平台最新版本？') {
			$mihomoExePath = Download-MihomoExe -TargetDirectory $workDir
		} else {
			Write-Warning '已跳过 Mihomo 下载。'
		}
	} else {
		Write-Step "当前目录找到 Mihomo 可执行程序: $mihomoExePath"
	}

	if ($mihomoExePath -and (Confirm-Action -Message '是否现在安装 Mihomo 服务？')) {
		Install-MihomoService -ExePath $mihomoExePath -ConfigFilePath $ConfigPath
	}
}

Install-UpdateScript -BaseUrl $baseUrl -ConfigFilePath $ConfigPath -TargetScriptPath $updateScriptPath -SubscriptionUrl $SubUrl
Register-UpdateTask -ScheduledTaskName $TaskName -ScriptPath $updateScriptPath

Write-Host "Installed: task=$TaskName, config=$ConfigPath"
