param(
	[string]$ConfigPath = (Join-Path (Get-Location).Path 'config.yaml'),
	[Parameter(Mandatory = $true)]
	[string]$SubUrl,
	[string]$TaskName = 'sub-magic',
	[string]$UpdateScriptName = 'sub-magic.ps1'
)

$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
	$scriptPath = $MyInvocation.MyCommand.Path
	if (-not [string]::IsNullOrWhiteSpace($scriptPath)) {
		Write-Host 'Requesting administrator privileges...'
		if (-not [System.IO.Path]::IsPathRooted($ConfigPath)) {
			$ConfigPath = [System.IO.Path]::GetFullPath((Join-Path $PWD.Path $ConfigPath))
		}
		$cmdBody = "Set-Location -LiteralPath '$($PWD.Path.Replace("'","''"))'; & '$($scriptPath.Replace("'","''"))'"
		foreach ($key in $MyInvocation.BoundParameters.Keys) {
			$val = $MyInvocation.BoundParameters[$key]
			$cmdBody += " -$key"
			if ($val -isnot [switch] -and $val -isnot [bool]) {
				$cmdBody += " '$($val.ToString().Replace("'","''"))'"
			}
		}
		$fullCmd = "powershell -NoProfile -ExecutionPolicy Bypass -Command `"$cmdBody`""
		Write-Host "[Elevated command]: $fullCmd"
		$proc = Start-Process -FilePath PowerShell.exe -ArgumentList "-NoProfile -ExecutionPolicy Bypass -Command `"$cmdBody`"" -Verb RunAs -Wait -PassThru
		exit $proc.ExitCode
	}
	throw 'This script requires administrator privileges. Please rerun PowerShell as Administrator.'
}

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

function Get-WindowsArch {
	$arch = $env:PROCESSOR_ARCHITEW6432
	if ([string]::IsNullOrWhiteSpace($arch)) {
		$arch = $env:PROCESSOR_ARCHITECTURE
	}

	switch -Regex ($arch) {
		'ARM64' { return 'arm64' }
		'86' { return '386' }
		default { return 'amd64' }
	}
}

function Get-MihomoAssetPatterns {
	switch (Get-WindowsArch) {
		'arm64' { return @('windows-arm64') }
		'386' { return @('windows-386') }
		default { return @('windows-amd64-compatible', 'windows-amd64') }
	}
}

function Get-WinSWAssetPatterns {
	switch (Get-WindowsArch) {
		'arm64' { return @('WinSW-arm64.exe', 'WinSW-net461arm64.exe') }
		'386' { return @('WinSW-x86.exe', 'WinSW-net461.exe') }
		default { return @('WinSW-x64.exe', 'WinSW-net461x64.exe') }
	}
}

function Escape-PowerShellSingleQuoted {
	param([string]$Value)
	return $Value.Replace("'", "''")
}

function Get-LatestMihomoAsset {
	param([string]$BaseUrl)

	Write-Step 'Resolving latest Mihomo Windows release'
	$releaseJson = Invoke-RestMethod -Uri "$BaseUrl/api/proxy/github/release?repo=MetaCubeX/mihomo"
	if (-not $releaseJson.assets) {
		throw 'GitHub Releases did not return any downloadable assets.'
	}

	foreach ($pattern in Get-MihomoAssetPatterns) {
		$asset = $releaseJson.assets | Where-Object {
			$_.name -like "*$pattern*.zip"
		} | Select-Object -First 1
		if ($asset) {
			return $asset
		}
	}

	throw 'No Mihomo archive matches the current Windows architecture.'
}

function Get-LatestWinSWAsset {
	param([string]$BaseUrl)

	Write-Step 'Resolving latest WinSW Windows release'
	$releaseJson = Invoke-RestMethod -Uri "$BaseUrl/api/proxy/github/release?repo=winsw/winsw"
	if (-not $releaseJson.assets) {
		throw 'WinSW GitHub Releases did not return any downloadable assets.'
	}

	foreach ($pattern in Get-WinSWAssetPatterns) {
		$asset = $releaseJson.assets | Where-Object {
			$_.name -eq $pattern
		} | Select-Object -First 1
		if ($asset) {
			return $asset
		}
	}

	throw 'No WinSW executable matches the current Windows architecture.'
}

function Download-MihomoExe {
	param(
		[string]$TargetDirectory,
		[string]$BaseUrl
	)

	$asset = Get-LatestMihomoAsset -BaseUrl $BaseUrl
	$tempZip = Join-Path $env:TEMP $asset.name
	$extractDir = Join-Path $env:TEMP ("sub-magic-mihomo-" + [guid]::NewGuid().ToString('N'))

	try {
		Write-Step "Downloading $($asset.name)"
		Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $tempZip

		Write-Step 'Extracting Mihomo archive'
		Expand-Archive -LiteralPath $tempZip -DestinationPath $extractDir -Force

		$exe = Get-ChildItem -LiteralPath $extractDir -Filter 'mihomo*.exe' -File -Recurse |
			Sort-Object FullName |
			Select-Object -First 1
		if (-not $exe) {
			throw 'The Mihomo executable was not found in the archive.'
		}

		$targetExe = Join-Path $TargetDirectory 'mihomo.exe'
		Copy-Item -LiteralPath $exe.FullName -Destination $targetExe -Force
		Write-Step "Extracted executable to $targetExe"
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

function Download-WinSWExe {
	param(
		[string]$TargetDirectory,
		[string]$BaseUrl
	)

	$asset = Get-LatestWinSWAsset -BaseUrl $BaseUrl
	$targetExe = Join-Path $TargetDirectory 'mihomo-service.exe'

	Write-Step "Downloading WinSW $($asset.name)"
	Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $targetExe
	Write-Step "Saved WinSW to $targetExe"
	return $targetExe
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
	$workDir = (Get-Location).Path
	$winswExe = Join-Path $workDir 'mihomo-service.exe'
	$winswXml = Join-Path $workDir 'mihomo-service.xml'

	$existing = Get-MihomoService
	if ($existing) {
		Write-Step "Found existing service: $($existing.Name). Removing it..."
		Stop-Service -Name $existing.Name -Force -ErrorAction SilentlyContinue
		if ($existing.PathName -match 'mihomo-service\.exe') {
			$oldExe = $existing.PathName.Trim('"')
			if (Test-Path -LiteralPath $oldExe) {
				& $oldExe uninstall 2>&1 | Out-Null
			}
		}
		sc.exe delete $existing.Name
		if ($LASTEXITCODE -ne 0) {
			Write-Warning "sc.exe delete returned $LASTEXITCODE. Continuing..."
		}
		Start-Sleep -Seconds 2
	}

	Write-Step "Writing WinSW config to $winswXml"
	$xml = @"
<service>
  <id>mihomo</id>
  <name>Mihomo Service</name>
  <description>Mihomo Proxy Service</description>
  <executable>$ExePath</executable>
  <arguments>-d "$configDir"</arguments>
  <workingdirectory>$workDir</workingdirectory>
  <logmode>roll</logmode>
  <onfailure action="restart" delay="10 sec" />
  <onfailure action="restart" delay="20 sec" />
  <onfailure action="none" delay="30 sec" />
  <resetfailure>1 hour</resetfailure>
</service>
"@
	[System.IO.File]::WriteAllText($winswXml, $xml, [System.Text.UTF8Encoding]::new($false))

	Write-Step "Installing service $serviceName"
	& $winswExe install
	if ($LASTEXITCODE -ne 0) {
		throw "WinSW install failed with exit code $LASTEXITCODE"
	}

	Write-Step "Starting service $serviceName"
	& $winswExe start
	if ($LASTEXITCODE -ne 0) {
		throw "WinSW start failed with exit code $LASTEXITCODE"
	}
}

function Install-UpdateScript {
	param(
		[string]$BaseUrl,
		[string]$ConfigFilePath,
		[string]$TargetScriptPath,
		[string]$SubscriptionUrl
	)

	Write-Step "Downloading update script to $TargetScriptPath"
	$rawContent = (New-Object System.Net.WebClient).DownloadString("$BaseUrl/sub-magic.ps1")
	$content = $rawContent.Replace('__CONFIG_PATH__', (Escape-PowerShellSingleQuoted $ConfigFilePath)).Replace('__SUB_URL__', (Escape-PowerShellSingleQuoted $SubscriptionUrl))
	[System.IO.File]::WriteAllText($TargetScriptPath, $content, [System.Text.UTF8Encoding]::new($true))
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
		Write-Step "Registering scheduled task $ScheduledTaskName"
		cmd.exe /c --% schtasks /create /tn "%_SCHTN%" /xml "%_SCHTXML%" /f
		if ($LASTEXITCODE -ne 0) {
			throw "schtasks /create /xml failed with exit code $LASTEXITCODE"
		}
	} finally {
		Remove-Item env:_SCHTN, env:_SCHTXML -ErrorAction SilentlyContinue
		if (Test-Path -LiteralPath $xmlPath) {
			Remove-Item -LiteralPath $xmlPath -Force -ErrorAction SilentlyContinue
		}
	}

	schtasks /run /tn $ScheduledTaskName
}

try {
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
	Write-Step "Detected Mihomo service: $($mihomoService.Name)"
} else {
	Write-Step 'No Mihomo service detected'
	$mihomoExePath = Get-LocalMihomoExe -Directory $workDir

	if (-not $mihomoExePath) {
		if (Confirm-Action -Message 'No Mihomo executable was found in the current directory. Download it through the Cloudflare Worker proxy?') {
			$mihomoExePath = Download-MihomoExe -TargetDirectory $workDir -BaseUrl $baseUrl
		} else {
			Write-Warning 'Skipped Mihomo download.'
		}
	} else {
		Write-Step "Found Mihomo executable in current directory: $mihomoExePath"
	}

	if ($mihomoExePath -and (Confirm-Action -Message 'Install the Mihomo service now?')) {
		$winswExe = Join-Path $workDir 'mihomo-service.exe'
		if (-not (Test-Path -LiteralPath $winswExe)) {
			Write-Step 'Downloading WinSW service wrapper'
			$null = Download-WinSWExe -TargetDirectory $workDir -BaseUrl $baseUrl
		}
		Install-MihomoService -ExePath $mihomoExePath -ConfigFilePath $ConfigPath
	}
}

Install-UpdateScript -BaseUrl $baseUrl -ConfigFilePath $ConfigPath -TargetScriptPath $updateScriptPath -SubscriptionUrl $SubUrl
Register-UpdateTask -ScheduledTaskName $TaskName -ScriptPath $updateScriptPath

Write-Host "Installed: task=$TaskName, config=$ConfigPath"
} catch {
	Write-Host "Installation failed: $_" -ForegroundColor Red
} finally {
	if ($host.UI.RawUI) {
		Write-Host "`nPress any key to exit..."
		$null = $host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
	}
}
