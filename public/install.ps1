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

function Invoke-MihomoServiceCommand {
	param(
		[string]$ExePath,
		[string[]]$Arguments
	)

	$variants = @(
		@('-service') + $Arguments,
		@('service') + $Arguments
	)

	foreach ($variant in $variants) {
		try {
			& $ExePath @variant | Out-Host
			if ($LASTEXITCODE -eq 0) {
				return $true
			}
		} catch {
		}
	}

	return $false
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

	Write-Step '尝试安装 Mihomo Windows 服务'
	$installed = Invoke-MihomoServiceCommand -ExePath $ExePath -Arguments @('install', '-d', $configDir)
	if (-not $installed) {
		throw "无法通过 Mihomo 内置服务命令安装服务，请手动检查 $ExePath 是否支持 service install。"
	}

	Start-Sleep -Seconds 1
	$service = Get-MihomoService
	if ($service -and $service.State -ne 'Running') {
		try {
			Start-Service -Name $service.Name
		} catch {
			Invoke-MihomoServiceCommand -ExePath $ExePath -Arguments @('start') | Out-Null
		}
	}
}

function Install-UpdateScript {
	param(
		[string]$BaseUrl,
		[string]$ConfigFilePath,
		[string]$TargetScriptPath,
		[string]$SubscriptionUrl
	)

	Write-Step "下载自动更新脚本到 $TargetScriptPath"
	$scriptContent = Invoke-WebRequest -Uri "$BaseUrl/sub-magic.ps1" -UseBasicParsing
	$content = $scriptContent.Content.Replace('__CONFIG_PATH__', (Escape-PowerShellSingleQuoted $ConfigFilePath)).Replace('__SUB_URL__', (Escape-PowerShellSingleQuoted $SubscriptionUrl))
	[System.IO.File]::WriteAllText($TargetScriptPath, $content, [System.Text.UTF8Encoding]::new($false))
}

function Register-UpdateTask {
	param(
		[string]$ScheduledTaskName,
		[string]$ScriptPath
	)

	$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`""
	$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1)
	$trigger.RepetitionInterval = (New-TimeSpan -Minutes 1)
	$trigger.RepetitionDuration = (New-TimeSpan -Days 3650)
	$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

	Write-Step "注册计划任务 $ScheduledTaskName"
	Register-ScheduledTask -TaskName $ScheduledTaskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
	Start-ScheduledTask -TaskName $ScheduledTaskName
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
