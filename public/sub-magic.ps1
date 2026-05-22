$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$ConfigPath = '__CONFIG_PATH__'
$SubUrl = '__SUB_URL__'
$StateDir = Join-Path $env:LOCALAPPDATA 'SubMagic'
$EtagPath = Join-Path $StateDir 'sub-magic.etag'
$TempFile = Join-Path $env:TEMP ("sub-magic-" + [guid]::NewGuid().ToString('N') + '.yaml')

function Write-Log {
	param([string]$Message)
	Write-Host "[$(Get-Date -Format s)] $Message"
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

function Get-RuntimeConfigPath {
	$service = Get-MihomoService
	if (-not $service -or [string]::IsNullOrWhiteSpace($service.PathName)) {
		return $null
	}

	$pathName = $service.PathName
	$match = [regex]::Match($pathName, '(?:^|\s)-d\s+"([^"]+)"')
	if (-not $match.Success) {
		$match = [regex]::Match($pathName, '(?:^|\s)-d\s+([^\s"]+)')
	}
	if (-not $match.Success) {
		return $null
	}

	return Join-Path $match.Groups[1].Value 'config.yaml'
}

function Sync-RuntimeConfig {
	$runtimeConfigPath = Get-RuntimeConfigPath
	if ([string]::IsNullOrWhiteSpace($runtimeConfigPath)) {
		return
	}
	if ([System.IO.Path]::GetFullPath($runtimeConfigPath) -eq [System.IO.Path]::GetFullPath($ConfigPath)) {
		return
	}

	try {
		Copy-Item -LiteralPath $TempFile -Destination $runtimeConfigPath -Force
		Write-Log "Runtime config updated: $runtimeConfigPath"
	} catch {
		Write-Warning "Runtime config update skipped: $runtimeConfigPath"
	}
}

function Get-ConfigValue {
	param([string]$Key)

	if (-not (Test-Path -LiteralPath $ConfigPath)) {
		return ''
	}

	$line = Get-Content -LiteralPath $ConfigPath | Where-Object {
		$_ -match "^\s*$([regex]::Escape($Key))\s*:"
	} | Select-Object -First 1
	if (-not $line) {
		return ''
	}

	return ($line -replace "^\s*$([regex]::Escape($Key))\s*:\s*", '').Trim().Trim('"').Trim("'")
}

function Invoke-ConfigReload {
	$controller = Get-ConfigValue -Key 'external-controller'
	$secret = Get-ConfigValue -Key 'secret'

	if (-not [string]::IsNullOrWhiteSpace($controller)) {
		$headers = @{ 'Content-Type' = 'application/json' }
		if (-not [string]::IsNullOrWhiteSpace($secret)) {
			$headers['Authorization'] = "Bearer $secret"
		}

		try {
			Invoke-WebRequest -Uri ("http://{0}/configs?force=true" -f $controller) -Method Put -Headers $headers -Body '{"path":"","payload":""}' -UseBasicParsing | Out-Null
			Write-Log "Mihomo reloaded via API: $controller"
			return
		} catch {
			Write-Warning 'API reload failed, falling back to service restart'
		}
	}

	$service = Get-MihomoService
	if ($service) {
		try {
			Restart-Service -Name $service.Name -ErrorAction Stop
			Write-Log "Mihomo restarted: $($service.Name)"
			return
		} catch {
			Write-Warning "Service restart failed: $($service.Name)"
		}
	}
}

try {
	New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
	New-Item -ItemType Directory -Path (Split-Path -Parent $ConfigPath) -Force | Out-Null

	$etag = ''
	if (Test-Path -LiteralPath $EtagPath) {
		$etag = (Get-Content -LiteralPath $EtagPath -Raw).Trim()
	}

	$request = [System.Net.HttpWebRequest]::Create($SubUrl)
	$request.Method = 'GET'
	$request.UserAgent = 'sub-magic-windows'
	$request.AutomaticDecompression = [System.Net.DecompressionMethods]::GZip -bor [System.Net.DecompressionMethods]::Deflate
	$request.Headers['X-Sub-Magic-Long-Poll'] = '1'
	if ($etag) {
		$request.Headers['If-None-Match'] = $etag
	}

	try {
		$response = $request.GetResponse()
	} catch [System.Net.WebException] {
		$httpResponse = $_.Exception.Response
		if ($httpResponse -and [int]$httpResponse.StatusCode -eq 304) {
			Write-Log 'No config change (304)'
			return
		}
		throw
	}

	try {
		if ([int]$response.StatusCode -ne 200) {
			throw "Subscription fetch failed: HTTP $([int]$response.StatusCode)"
		}

		$stream = $response.GetResponseStream()
		$fileStream = [System.IO.File]::Open($TempFile, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
		try {
			$stream.CopyTo($fileStream)
		} finally {
			$fileStream.Dispose()
			$stream.Dispose()
		}

		if ((Get-Item -LiteralPath $TempFile).Length -le 0) {
			throw 'Subscription fetch returned empty config body'
		}

		Copy-Item -LiteralPath $TempFile -Destination $ConfigPath -Force
		Write-Log "Config updated: $ConfigPath"
		Sync-RuntimeConfig

		$newEtag = $response.Headers['ETag']
		if (-not [string]::IsNullOrWhiteSpace($newEtag)) {
			Set-Content -LiteralPath $EtagPath -Value $newEtag -NoNewline
		}
	} finally {
		$response.Dispose()
	}

	Invoke-ConfigReload
} catch {
	Write-Error $_
	exit 1
} finally {
	if (Test-Path -LiteralPath $TempFile) {
		Remove-Item -LiteralPath $TempFile -Force -ErrorAction SilentlyContinue
	}
}
