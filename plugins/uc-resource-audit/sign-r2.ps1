#requires -Version 7.0

$ErrorActionPreference = 'Stop'
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'manifest.json') -Raw | ConvertFrom-Json
$baseName = "$($manifest.id)-$($manifest.version)-universal"
$candidate = Join-Path $PSScriptRoot "dist/$baseName.dbxp"
$releaseDirectory = Join-Path $PSScriptRoot 'dist/r2'
$packageName = "$baseName-signed.dbxp"
$output = Join-Path $releaseDirectory $packageName
$keyDirectory = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'UC Resource Audit DBX Signing'
$keyPath = Join-Path $keyDirectory 'repository-key.dpapi'
$scope = [Security.Cryptography.DataProtectionScope]::CurrentUser

if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { throw "请先构建未签名的候选包。" }

$cryptoScript = @'
const crypto = require("node:crypto");
const input = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
if (input.generate) {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  process.stdout.write(privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"));
} else {
  const privateKey = crypto.createPrivateKey({
    key: Buffer.from(input.key, "base64"), format: "der", type: "pkcs8",
  });
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("不是 Ed25519 密钥");
  const publicKey = crypto.createPublicKey(privateKey);
  const rawPublicKey = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const fingerprint = crypto.createHash("sha256").update(rawPublicKey).digest("hex").slice(0, 16);
  const payload = Buffer.from(input.payload, "base64");
  const signature = crypto.sign(null, payload, privateKey);
  if (!crypto.verify(null, payload, publicKey, signature)) throw new Error("签名验证失败");
  process.stdout.write(JSON.stringify({
    keyId: "uc-resource-audit.r2." + fingerprint,
    publicKey: rawPublicKey.toString("base64"),
    signature: signature.toString("base64"),
  }));
}
'@

function Invoke-NodeCrypto([hashtable]$data) {
    $result = $data | ConvertTo-Json -Compress | & node -e $cryptoScript
    if ($LASTEXITCODE -ne 0) { throw "Node.js 签名失败。" }
    return $result
}

# DBX 签的是候选包中 checksums.json 的原始字节。
$archive = [IO.Compression.ZipFile]::OpenRead($candidate)
try {
    $entry = $archive.GetEntry('checksums.json')
    if (-not $entry -or $archive.GetEntry('signature.json')) { throw "候选包不符合签名条件。" }
    $buffer = [IO.MemoryStream]::new()
    $stream = $entry.Open()
    try {
        $stream.CopyTo($buffer)
        $checksums = $buffer.ToArray()
    } finally {
        $stream.Dispose()
        $buffer.Dispose()
    }
    $declared = [Text.Encoding]::UTF8.GetString($checksums) | ConvertFrom-Json -AsHashtable
    if ($declared.algorithm -ne 'sha256' -or $declared.files.Count -ne $archive.Entries.Count - 1) {
        throw "候选包的校验清单不完整。"
    }
    foreach ($file in $archive.Entries) {
        if ($file.FullName -eq 'checksums.json') { continue }
        $stream = $file.Open()
        try {
            $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream))
        } finally {
            $stream.Dispose()
        }
        if ($hash -ne $declared.files[$file.FullName]) { throw "校验失败 $($file.FullName)" }
    }
} finally {
    $archive.Dispose()
}

if (-not (Test-Path -LiteralPath $keyPath -PathType Leaf)) {
    [IO.Directory]::CreateDirectory($keyDirectory) | Out-Null
    $newKey = [Convert]::FromBase64String((Invoke-NodeCrypto @{ generate = $true }))
    try {
        $encryptedKey = [Security.Cryptography.ProtectedData]::Protect($newKey, $null, $scope)
        $file = [IO.File]::Open($keyPath, [IO.FileMode]::CreateNew)
        try { $file.Write($encryptedKey) } finally { $file.Dispose() }
    } finally {
        [Array]::Clear($newKey)
    }
}

$privateKey = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($keyPath), $null, $scope)
try {
    $signature = Invoke-NodeCrypto @{
        key = [Convert]::ToBase64String($privateKey)
        payload = [Convert]::ToBase64String($checksums)
    } | ConvertFrom-Json
} finally {
    [Array]::Clear($privateKey)
}

[IO.Directory]::CreateDirectory($releaseDirectory) | Out-Null
$temporary = Join-Path $releaseDirectory (".$packageName.$PID.tmp")
try {
    [IO.File]::Copy($candidate, $temporary)
    $archive = [IO.Compression.ZipFile]::Open($temporary, [IO.Compression.ZipArchiveMode]::Update)
    try {
        $entry = $archive.CreateEntry('signature.json', [IO.Compression.CompressionLevel]::Optimal)
        $entry.LastWriteTime = [DateTimeOffset]::new(1980, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
        $writer = [IO.StreamWriter]::new($entry.Open(), [Text.UTF8Encoding]::new($false))
        try {
            $writer.Write((@{ algorithm = 'ed25519'; key_id = $signature.keyId; signature = $signature.signature } | ConvertTo-Json -Compress))
        } finally {
            $writer.Dispose()
        }
    } finally {
        $archive.Dispose()
    }
    $hash = (Get-FileHash -LiteralPath $temporary).Hash.ToLowerInvariant()
    if (Test-Path -LiteralPath $output) {
        if ((Get-FileHash -LiteralPath $output).Hash -ne $hash) { throw "同版本的签名包已经存在，请提高插件版本。" }
    } else {
        [IO.File]::Move($temporary, $output)
    }
} finally {
    [IO.File]::Delete($temporary)
}

$artifact = @{
    target = 'universal'
    url = $packageName
    sha256 = $hash
    size = (Get-Item -LiteralPath $output).Length
    signingKeyId = $signature.keyId
}
@{
    catalogVersion = 1
    repository = @{ id = 'uc-resource-audit-r2'; name = 'UC 资源工具' }
    plugins = @(@{
        id = $manifest.id
        name = $manifest.name
        publisher = $manifest.publisher
        description = $manifest.description
        permissions = $manifest.permissions
        latestVersion = $manifest.version
        versions = @(@{ version = $manifest.version; artifacts = @($artifact) })
    })
} | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $releaseDirectory 'catalog.json') -Encoding utf8
@{ keyId = $signature.keyId; publicKey = $signature.publicKey } | ConvertTo-Json |
    Set-Content -LiteralPath (Join-Path $releaseDirectory 'dbx-trust-key.json') -Encoding utf8
Write-Output $output
Write-Output "SHA-256 $hash"
