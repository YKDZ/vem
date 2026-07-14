[CmdletBinding()]
param(
  [string]$InstallerPath,
  [string[]]$CorePowerShellPaths = @(),
  [switch]$Library
)

# This harness intentionally runs only on a disposable Windows GitHub runner.
# It builds a signed fixture release, provisions it through the same Factory
# media path as production, and lets the production installer launch it.
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Write-Utf8([string]$Path, [string]$Text) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
  [IO.File]::WriteAllText($Path, $Text, [Text.UTF8Encoding]::new($false))
}
function Write-HarnessWatchdogCommand([string]$Path, [string]$Command, [DateTime]$DeadlineUtc) {
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes($Command + "`n")
  while ($true) {
    if ((Get-HarnessRemainingMilliseconds -DeadlineUtc $DeadlineUtc) -le 0) { throw "suspended-process watchdog command write was late before it could acquire the command path" }
    $stream = $null
    $writeSucceeded = $false
    try {
      $stream = [IO.FileStream]::new($Path, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::Read)
      $stream.Write($bytes, 0, $bytes.Length)
      $stream.Flush($true)
      $writeSucceeded = $true
    } catch [IO.IOException] {
    } catch [UnauthorizedAccessException] {
    } finally {
      if ($null -ne $stream) { $stream.Dispose() }
    }

    if ($writeSucceeded) {
      if ((Get-HarnessRemainingMilliseconds -DeadlineUtc $DeadlineUtc) -le 0) { throw "suspended-process watchdog command write completed after the cleanup deadline" }
      return
    }
    $remainingMilliseconds = Get-HarnessRemainingMilliseconds -DeadlineUtc $DeadlineUtc
    if ($remainingMilliseconds -le 0) { throw "suspended-process watchdog command write could not acquire the command path before the cleanup deadline" }
    Start-Sleep -Milliseconds ([Math]::Min(10, $remainingMilliseconds))
  }
}
function Get-Digest([string]$Path) {
  $stream = $null
  $hash = $null
  try {
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $hash = [Security.Cryptography.SHA256]::Create()
    $digest = $hash.ComputeHash($stream)
    return "sha256:" + ([BitConverter]::ToString($digest).Replace("-", "")).ToLowerInvariant()
  } finally {
    if ($null -ne $hash) { $hash.Dispose() }
    if ($null -ne $stream) { $stream.Dispose() }
  }
}
function Write-Json([string]$Path, [object]$Value) { Write-Utf8 $Path ($Value | ConvertTo-Json -Depth 32 -Compress) }
function Evidence-Identity([string]$Digest) { "factory-evidence://" + $Digest.Replace(":", "/") }
function Assert-True([bool]$Value, [string]$Message) { if (-not $Value) { throw $Message } }
function Write-HarnessStage([string]$Stage, [string]$Status, [string]$Detail = $null) {
  $message = "[vision-installer-harness] timestamp=$([DateTime]::UtcNow.ToString("o")) stage=$Stage status=$Status"
  if (-not [string]::IsNullOrWhiteSpace($Detail)) { $message += " detail=$Detail" }
  Write-Host $message
}
function Remove-HarnessFixtureCertificates {
  param([Parameter(Mandatory = $true)][string]$CertificateSubject)

  foreach ($storePath in @("Cert:\CurrentUser\My", "Cert:\LocalMachine\Root")) {
    $certificates = @(Get-ChildItem -Path $storePath -ErrorAction Stop | Where-Object { $_.Subject -eq $CertificateSubject })
    foreach ($certificate in $certificates) {
      try {
        if ($storePath -eq "Cert:\CurrentUser\My") {
          Remove-Item -LiteralPath $certificate.PSPath -DeleteKey -Force -ErrorAction Stop
        } else {
          Remove-Item -LiteralPath $certificate.PSPath -Force -ErrorAction Stop
        }
        Write-Host "[vision-installer-harness] timestamp=$([DateTime]::UtcNow.ToString("o")) stage=fixture.cleanup-certificates status=removed store=$storePath thumbprint=$($certificate.Thumbprint)"
      } catch {
        Write-Host "[vision-installer-harness] timestamp=$([DateTime]::UtcNow.ToString("o")) stage=fixture.cleanup-certificates status=failed store=$storePath thumbprint=$($certificate.Thumbprint) detail=$($_.Exception.Message)"
        throw
      }
    }
  }
}
function Stop-HarnessFixtureRuntime {
  param([Parameter(Mandatory = $true)][object]$Context)

  $selectionPath = Join-Path $Context.stateRoot "current.json"
  $processPath = Join-Path $Context.stateRoot "process-state\active-process.json"
  if (-not (Test-Path -LiteralPath $selectionPath -PathType Leaf)) { return $true }

  try {
    $selection = Get-Content -LiteralPath $selectionPath -Raw | ConvertFrom-Json
    if ([string]$selection.schemaVersion -cne "vem-vision-selection/v1" -or [string]$selection.bundleDigest -cne [string]$Context.bundleDigest) { return $false }
    if (-not (Test-Path -LiteralPath $processPath -PathType Leaf)) {
      Stop-ScheduledTask -TaskName "StartVisionServer" -TaskPath "\VEM\" -ErrorAction SilentlyContinue
      return $true
    }

    $record = Get-Content -LiteralPath $processPath -Raw | ConvertFrom-Json
    $metadata = Get-Content -LiteralPath ([string]$selection.metadataPath) -Raw | ConvertFrom-Json
    [int]$processId = 0
    if ([string]$record.bundleDigest -cne [string]$selection.bundleDigest -or [string]$record.selectionRevision -cne [string]$selection.revision -or -not [int]::TryParse([string]$record.processId, [ref]$processId) -or $processId -lt 1) { return $false }
    $expectedPath = [IO.Path]::GetFullPath((Join-Path ([string]$selection.installDirectory) ([string]$selection.entrypoint)))
    $expectedDigest = [string]$metadata.entrypointDigest
    if ([string]::IsNullOrWhiteSpace($expectedDigest) -or [IO.Path]::GetFullPath([string]$record.executablePath) -cne $expectedPath -or [string]$record.executableDigest -cne $expectedDigest) { return $false }

    $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if ($null -eq $process) {
      Stop-ScheduledTask -TaskName "StartVisionServer" -TaskPath "\VEM\" -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath $processPath -Force -ErrorAction SilentlyContinue
      return $true
    }
    if ($process -isnot [Diagnostics.Process]) { return $false }
    if ($record.creationTimeUtcTicks -isnot [Int64] -or $record.creationTimeUtcTicks -lt 1) {
      return $false
    }
    if ($process.StartTime.ToUniversalTime().Ticks -ne $record.creationTimeUtcTicks -or -not (Test-Path -LiteralPath $process.Path -PathType Leaf)) { return $false }
    if ([IO.Path]::GetFullPath([string]$process.Path) -cne $expectedPath -or (Get-Digest $process.Path) -cne $expectedDigest) { return $false }

    $verifiedProcessId = $process.Id
    Stop-ScheduledTask -TaskName "StartVisionServer" -TaskPath "\VEM\" -ErrorAction SilentlyContinue
    try {
      if (-not $process.HasExited) {
        try {
          $process.Kill()
        } catch {
          if (-not $process.HasExited) { throw }
        }
      }
      if (-not $process.WaitForExit(5000) -and -not $process.HasExited) { return $false }
    } finally {
      $process.Dispose()
    }
    Remove-Item -LiteralPath $processPath -Force -ErrorAction SilentlyContinue
    Write-HarnessStage "fixture.cleanup-runtime" "terminated" "processId=$verifiedProcessId"
    return $true
  } catch {
    Write-HarnessStage "fixture.cleanup-runtime" "skipped" $_.Exception.Message
    return $false
  }
}
function Invoke-HarnessFixtureCleanup {
  param([Parameter(Mandatory = $true)][object]$Context)

  $runtimeCleaned = $false
  try {
    $runtimeCleaned = Stop-HarnessFixtureRuntime -Context $Context
  } finally {
    $marker = Get-Content -LiteralPath (Join-Path $Context.root "fixture-certificate-cleanup.json") -Raw | ConvertFrom-Json
    if ([string]::IsNullOrWhiteSpace([string]$marker.certificateSubject)) { throw "fixture certificate cleanup marker has no subject" }
    Remove-HarnessFixtureCertificates -CertificateSubject ([string]$marker.certificateSubject)
  }
  if (-not $runtimeCleaned) { throw "fixture runtime cleanup could not verify and terminate the selected process" }
}
function Initialize-HarnessNativeTypes {
  if ($null -eq ("VemVisionHarness.KillOnCloseJob" -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace VemVisionHarness {
  public sealed class RetainedWatchdogProcess : IDisposable {
    private const uint WAIT_OBJECT_0 = 0;
    private const uint WAIT_FAILED = 0xFFFFFFFF;
    private IntPtr processHandle;
    private readonly uint processId;

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    internal RetainedWatchdogProcess(IntPtr processHandle, uint processId) {
      if (processHandle == IntPtr.Zero) { throw new ArgumentException("watchdog process handle is required", "processHandle"); }
      this.processHandle = processHandle;
      this.processId = processId;
    }

    public uint ProcessId { get { return processId; } }

    public bool WaitForExit(uint waitMilliseconds) {
      var handle = processHandle;
      if (handle == IntPtr.Zero) { throw new ObjectDisposedException("RetainedWatchdogProcess"); }
      var waitResult = WaitForSingleObject(handle, waitMilliseconds);
      if (waitResult == WAIT_OBJECT_0) { return true; }
      if (waitResult == WAIT_FAILED) { throw new Win32Exception(Marshal.GetLastWin32Error(), "WaitForSingleObject for watchdog failed"); }
      return false;
    }

    public bool HasExited { get { return WaitForExit(0); } }

    public int ExitCode {
      get {
        var handle = processHandle;
        if (handle == IntPtr.Zero) { throw new ObjectDisposedException("RetainedWatchdogProcess"); }
        uint exitCode;
        if (!GetExitCodeProcess(handle, out exitCode)) { throw new Win32Exception(Marshal.GetLastWin32Error(), "GetExitCodeProcess for watchdog failed"); }
        return unchecked((int)exitCode);
      }
    }

    public void Dispose() {
      var handle = Interlocked.Exchange(ref processHandle, IntPtr.Zero);
      if (handle != IntPtr.Zero && !CloseHandle(handle)) { throw new Win32Exception(Marshal.GetLastWin32Error(), "CloseHandle for watchdog process failed"); }
      GC.SuppressFinalize(this);
    }
  }

  public sealed class SuspendedProcess : IDisposable {
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint WAIT_OBJECT_0 = 0;
    private const uint WAIT_FAILED = 0xFFFFFFFF;
    private IntPtr processHandle;
    private IntPtr threadHandle;
    private readonly uint processId;
    private bool resumed;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO {
      public int cb;
      public string lpReserved;
      public string lpDesktop;
      public string lpTitle;
      public int dwX;
      public int dwY;
      public int dwXSize;
      public int dwYSize;
      public int dwXCountChars;
      public int dwYCountChars;
      public int dwFillAttribute;
      public int dwFlags;
      public short wShowWindow;
      public short cbReserved2;
      public IntPtr lpReserved2;
      public IntPtr hStdInput;
      public IntPtr hStdOutput;
      public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION {
      public IntPtr hProcess;
      public IntPtr hThread;
      public uint dwProcessId;
      public uint dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcessW(
      string applicationName,
      StringBuilder commandLine,
      IntPtr processAttributes,
      IntPtr threadAttributes,
      bool inheritHandles,
      uint creationFlags,
      IntPtr environment,
      string currentDirectory,
      ref STARTUPINFO startupInfo,
      out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DuplicateHandle(
      IntPtr sourceProcess,
      IntPtr sourceHandle,
      IntPtr targetProcess,
      out IntPtr targetHandle,
      uint desiredAccess,
      bool inheritHandle,
      uint options);

    private const uint DUPLICATE_SAME_ACCESS = 0x00000002;

    private SuspendedProcess(IntPtr processHandle, IntPtr threadHandle, uint processId) {
      this.processHandle = processHandle;
      this.threadHandle = threadHandle;
      this.processId = processId;
    }

    public IntPtr ProcessHandle { get { return processHandle; } }
    public uint ProcessId { get { return processId; } }
    public bool IsResumed { get { return resumed; } }

    public static string QuoteArgument(string argument) {
      if (argument == null || argument.Length == 0) { return "\"\""; }
      var requiresQuotes = false;
      for (var index = 0; index < argument.Length; index++) {
        if (Char.IsWhiteSpace(argument[index]) || argument[index] == '"') { requiresQuotes = true; break; }
      }
      if (!requiresQuotes) { return argument; }

      var quoted = new StringBuilder();
      quoted.Append('"');
      var slashCount = 0;
      for (var index = 0; index < argument.Length; index++) {
        var character = argument[index];
        if (character == '\\') { slashCount++; continue; }
        if (character == '"') {
          quoted.Append('\\', (slashCount * 2) + 1);
          quoted.Append('"');
          slashCount = 0;
          continue;
        }
        quoted.Append('\\', slashCount);
        quoted.Append(character);
        slashCount = 0;
      }
      quoted.Append('\\', slashCount * 2);
      quoted.Append('"');
      return quoted.ToString();
    }

    public static SuspendedProcess Create(string applicationName, string[] arguments, string currentDirectory) {
      if (String.IsNullOrWhiteSpace(applicationName) || String.IsNullOrWhiteSpace(currentDirectory)) {
        throw new ArgumentException("CreateProcessW requires application name and current directory");
      }
      var commandLine = new StringBuilder(QuoteArgument(applicationName));
      if (arguments != null) {
        foreach (var argument in arguments) {
          commandLine.Append(' ');
          commandLine.Append(QuoteArgument(argument));
        }
      }
      var startupInfo = new STARTUPINFO();
      startupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFO));
      PROCESS_INFORMATION processInformation;
      if (!CreateProcessW(applicationName, commandLine, IntPtr.Zero, IntPtr.Zero, false, CREATE_SUSPENDED | CREATE_NO_WINDOW, IntPtr.Zero, currentDirectory, ref startupInfo, out processInformation)) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcessW failed");
      }
      if (processInformation.hProcess == IntPtr.Zero || processInformation.hThread == IntPtr.Zero) {
        if (processInformation.hThread != IntPtr.Zero) { CloseHandle(processInformation.hThread); }
        if (processInformation.hProcess != IntPtr.Zero) { CloseHandle(processInformation.hProcess); }
        throw new InvalidOperationException("CreateProcessW returned incomplete process handles");
      }
      return new SuspendedProcess(processInformation.hProcess, processInformation.hThread, processInformation.dwProcessId);
    }

    public RetainedWatchdogProcess StartInheritedHandleWatchdog(string applicationName, string[] arguments, string currentDirectory) {
      if (processHandle == IntPtr.Zero) { throw new ObjectDisposedException("SuspendedProcess"); }
      if (arguments == null || arguments.Length < 1) { throw new ArgumentException("watchdog arguments must reserve index zero for its inherited process handle", "arguments"); }
      IntPtr inheritedHandle;
      if (!DuplicateHandle(GetCurrentProcess(), processHandle, GetCurrentProcess(), out inheritedHandle, 0, true, DUPLICATE_SAME_ACCESS)) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "DuplicateHandle for watchdog failed");
      }
      try {
        var watchdogArguments = (string[])arguments.Clone();
        watchdogArguments[0] = unchecked((ulong)inheritedHandle.ToInt64()).ToString(CultureInfo.InvariantCulture);
        var commandLine = new StringBuilder(QuoteArgument(applicationName));
        foreach (var argument in watchdogArguments) {
            commandLine.Append(' ');
            commandLine.Append(QuoteArgument(argument));
        }
        var startupInfo = new STARTUPINFO();
        startupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        PROCESS_INFORMATION processInformation;
        if (!CreateProcessW(applicationName, commandLine, IntPtr.Zero, IntPtr.Zero, true, CREATE_NO_WINDOW, IntPtr.Zero, currentDirectory, ref startupInfo, out processInformation)) {
          throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcessW for watchdog failed");
        }
        if (processInformation.hProcess == IntPtr.Zero) {
          if (processInformation.hThread != IntPtr.Zero) { CloseHandle(processInformation.hThread); }
          throw new InvalidOperationException("CreateProcessW for watchdog returned no process handle");
        }
        if (processInformation.hThread != IntPtr.Zero && !CloseHandle(processInformation.hThread)) {
          var errorCode = Marshal.GetLastWin32Error();
          CloseHandle(processInformation.hProcess);
          throw new Win32Exception(errorCode, "CloseHandle for watchdog thread failed");
        }
        return new RetainedWatchdogProcess(processInformation.hProcess, processInformation.dwProcessId);
      } finally {
        CloseHandle(inheritedHandle);
      }
    }

    public void Resume() {
      if (processHandle == IntPtr.Zero || threadHandle == IntPtr.Zero) { throw new ObjectDisposedException("SuspendedProcess"); }
      if (Environment.GetEnvironmentVariable("VEM_VISION_HARNESS_FIXTURE_FORCE_RESUME_FAILURE") == "1") {
        throw new Win32Exception(5, "ResumeThread fixture failure");
      }
      var previousSuspendCount = ResumeThread(threadHandle);
      if (previousSuspendCount == UInt32.MaxValue) { throw new Win32Exception(Marshal.GetLastWin32Error(), "ResumeThread failed"); }
      resumed = true;
      CloseAndClear(ref threadHandle, "CloseHandle for suspended process thread failed");
    }

    public void TerminateUnresumed(uint waitMilliseconds) {
      if (resumed) { throw new InvalidOperationException("cannot terminate a resumed process through the suspended-process cleanup path"); }
      if (processHandle == IntPtr.Zero) { return; }
      if (Environment.GetEnvironmentVariable("VEM_VISION_HARNESS_FIXTURE_FORCE_TERMINATE_UNRESUMED_FAILURE") == "1") {
        throw new Win32Exception(5, "TerminateProcess for suspended process fixture failure");
      }
      if (!TerminateProcess(processHandle, 1)) { throw new Win32Exception(Marshal.GetLastWin32Error(), "TerminateProcess for suspended process failed"); }
      if (!WaitForExit(waitMilliseconds)) { throw new TimeoutException("suspended process did not terminate before its cleanup budget elapsed"); }
    }

    public bool WaitForExit(uint waitMilliseconds) {
      if (processHandle == IntPtr.Zero) { throw new ObjectDisposedException("SuspendedProcess"); }
      var waitResult = WaitForSingleObject(processHandle, waitMilliseconds);
      if (waitResult == WAIT_OBJECT_0) { return true; }
      if (waitResult == WAIT_FAILED) { throw new Win32Exception(Marshal.GetLastWin32Error(), "WaitForSingleObject for suspended process failed"); }
      return false;
    }

    public int ExitCode {
      get {
        if (processHandle == IntPtr.Zero) { throw new ObjectDisposedException("SuspendedProcess"); }
        uint exitCode;
        if (!GetExitCodeProcess(processHandle, out exitCode)) { throw new Win32Exception(Marshal.GetLastWin32Error(), "GetExitCodeProcess failed"); }
        return unchecked((int)exitCode);
      }
    }

    private static void CloseAndClear(ref IntPtr handle, string failureMessage) {
      var previous = Interlocked.Exchange(ref handle, IntPtr.Zero);
      if (previous != IntPtr.Zero && !CloseHandle(previous)) { throw new Win32Exception(Marshal.GetLastWin32Error(), failureMessage); }
    }

    public void Dispose() {
      CloseAndClear(ref threadHandle, "CloseHandle for suspended process thread failed");
      CloseAndClear(ref processHandle, "CloseHandle for suspended process failed");
      GC.SuppressFinalize(this);
    }
  }

  public sealed class KillOnCloseJob : IDisposable {
    private const uint JobObjectExtendedLimitInformation = 9;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private IntPtr handle;
    private bool forceActiveProcessCountFailure;
    private readonly bool forcePersistentActiveProcessCountFailure;

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS {
      public ulong ReadOperationCount;
      public ulong WriteOperationCount;
      public ulong OtherOperationCount;
      public ulong ReadTransferCount;
      public ulong WriteTransferCount;
      public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
      public long PerProcessUserTimeLimit;
      public long PerJobUserTimeLimit;
      public uint LimitFlags;
      public UIntPtr MinimumWorkingSetSize;
      public UIntPtr MaximumWorkingSetSize;
      public uint ActiveProcessLimit;
      public UIntPtr Affinity;
      public uint PriorityClass;
      public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
      public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
      public IO_COUNTERS IoInfo;
      public UIntPtr ProcessMemoryLimit;
      public UIntPtr JobMemoryLimit;
      public UIntPtr PeakProcessMemoryUsed;
      public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
      public long TotalUserTime;
      public long TotalKernelTime;
      public long ThisPeriodTotalUserTime;
      public long ThisPeriodTotalKernelTime;
      public uint TotalPageFaultCount;
      public uint TotalProcesses;
      public uint ActiveProcesses;
      public uint TotalTerminatedProcesses;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObject(IntPtr jobAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, uint informationClass, IntPtr information, uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(IntPtr job, uint informationClass, IntPtr information, uint informationLength, IntPtr returnLength);

    private static void AssertOffset(Type type, string field, long expected) {
      var actual = Marshal.OffsetOf(type, field).ToInt64();
      if (actual != expected) {
        throw new InvalidOperationException(type.Name + "." + field + " offset was " + actual + ", expected " + expected);
      }
    }

    private static void AssertSize(Type type, int expected) {
      var actual = Marshal.SizeOf(type);
      if (actual != expected) {
        throw new InvalidOperationException(type.Name + " size was " + actual + ", expected " + expected);
      }
    }

    public static void AssertNativeLayout() {
      var pointerSize = IntPtr.Size;
      var basicSize = pointerSize == 8 ? 64 : 48;
      var ioSize = 48;
      var extendedSize = basicSize + ioSize + (pointerSize * 4);

      AssertOffset(typeof(JOBOBJECT_BASIC_LIMIT_INFORMATION), "PerProcessUserTimeLimit", 0);
      AssertOffset(typeof(JOBOBJECT_BASIC_LIMIT_INFORMATION), "PerJobUserTimeLimit", 8);
      AssertOffset(typeof(JOBOBJECT_BASIC_LIMIT_INFORMATION), "LimitFlags", 16);
      AssertOffset(typeof(JOBOBJECT_BASIC_LIMIT_INFORMATION), "MinimumWorkingSetSize", pointerSize == 8 ? 24 : 20);
      AssertOffset(typeof(JOBOBJECT_BASIC_LIMIT_INFORMATION), "MaximumWorkingSetSize", pointerSize == 8 ? 32 : 24);
      AssertOffset(typeof(JOBOBJECT_BASIC_LIMIT_INFORMATION), "ActiveProcessLimit", pointerSize == 8 ? 40 : 28);
      AssertOffset(typeof(JOBOBJECT_BASIC_LIMIT_INFORMATION), "Affinity", pointerSize == 8 ? 48 : 32);
      AssertOffset(typeof(JOBOBJECT_BASIC_LIMIT_INFORMATION), "PriorityClass", pointerSize == 8 ? 56 : 36);
      AssertOffset(typeof(JOBOBJECT_BASIC_LIMIT_INFORMATION), "SchedulingClass", pointerSize == 8 ? 60 : 40);
      AssertSize(typeof(JOBOBJECT_BASIC_LIMIT_INFORMATION), basicSize);
      AssertSize(typeof(IO_COUNTERS), ioSize);

      AssertOffset(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION), "BasicLimitInformation", 0);
      AssertOffset(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION), "IoInfo", basicSize);
      AssertOffset(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION), "ProcessMemoryLimit", basicSize + ioSize);
      AssertOffset(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION), "JobMemoryLimit", basicSize + ioSize + pointerSize);
      AssertOffset(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION), "PeakProcessMemoryUsed", basicSize + ioSize + (pointerSize * 2));
      AssertOffset(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION), "PeakJobMemoryUsed", basicSize + ioSize + (pointerSize * 3));
      AssertSize(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION), extendedSize);
      AssertSize(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION), 48);
    }

    public KillOnCloseJob() {
      if (Environment.GetEnvironmentVariable("VEM_VISION_HARNESS_FIXTURE_FORCE_CREATE_JOB_FAILURE") == "1") {
        throw new Win32Exception(8, "CreateJobObject fixture failure");
      }
      handle = CreateJobObject(IntPtr.Zero, null);
      if (handle == IntPtr.Zero) { throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject failed"); }

      IntPtr buffer = IntPtr.Zero;
      try {
        AssertNativeLayout();
        forceActiveProcessCountFailure = Environment.GetEnvironmentVariable("VEM_VISION_HARNESS_FIXTURE_FORCE_ACTIVE_PROCESS_COUNT_FAILURE") == "1";
        forcePersistentActiveProcessCountFailure = Environment.GetEnvironmentVariable("VEM_VISION_HARNESS_FIXTURE_FORCE_ACTIVE_PROCESS_COUNT_PERSISTENT_FAILURE") == "1";
        var information = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        var size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        buffer = Marshal.AllocHGlobal(size);
        Marshal.StructureToPtr(information, buffer, false);
        if (Environment.GetEnvironmentVariable("VEM_VISION_HARNESS_FIXTURE_FORCE_SET_JOB_LIMIT_FAILURE") == "1") {
          throw new Win32Exception(5, "SetInformationJobObject fixture failure");
        }
        if (!SetInformationJobObject(handle, JobObjectExtendedLimitInformation, buffer, (uint)size)) {
          throw new Win32Exception(Marshal.GetLastWin32Error(), "SetInformationJobObject failed");
        }
      } catch {
        Dispose();
        throw;
      } finally {
        if (buffer != IntPtr.Zero) { Marshal.FreeHGlobal(buffer); }
      }
    }

    public void Assign(IntPtr processHandle) {
      if (handle == IntPtr.Zero) { throw new ObjectDisposedException("KillOnCloseJob"); }
      if (Environment.GetEnvironmentVariable("VEM_VISION_HARNESS_FIXTURE_FORCE_ASSIGN_JOB_FAILURE") == "1") {
        throw new Win32Exception(5, "AssignProcessToJobObject fixture failure");
      }
      if (!AssignProcessToJobObject(handle, processHandle)) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "AssignProcessToJobObject failed");
      }
    }

    public void Terminate() {
      if (handle == IntPtr.Zero) { return; }
      if (Environment.GetEnvironmentVariable("VEM_VISION_HARNESS_FIXTURE_FORCE_TERMINATE_JOB_FAILURE") == "1") {
        throw new Win32Exception(5, "TerminateJobObject fixture failure");
      }
      if (!TerminateJobObject(handle, 1)) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "TerminateJobObject failed");
      }
    }

    public uint ActiveProcessCount() {
      if (handle == IntPtr.Zero) { throw new ObjectDisposedException("KillOnCloseJob"); }
      if (forcePersistentActiveProcessCountFailure || forceActiveProcessCountFailure) {
        forceActiveProcessCountFailure = false;
        throw new Win32Exception(87, "QueryInformationJobObject fixture failure");
      }
      var size = Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
      var buffer = Marshal.AllocHGlobal(size);
      try {
        if (!QueryInformationJobObject(handle, 1, buffer, (uint)size, IntPtr.Zero)) {
          throw new Win32Exception(Marshal.GetLastWin32Error(), "QueryInformationJobObject failed");
        }
        var information = (JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)Marshal.PtrToStructure(buffer, typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
        return information.ActiveProcesses;
      } finally {
        Marshal.FreeHGlobal(buffer);
      }
    }

    public void Dispose() {
      var previous = Interlocked.Exchange(ref handle, IntPtr.Zero);
      if (previous != IntPtr.Zero && !CloseHandle(previous)) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "CloseHandle for Job Object failed");
      }
      GC.SuppressFinalize(this);
    }
  }

  public sealed class FailFastWatchdog : IDisposable {
    private Timer timer;

    public FailFastWatchdog(string message, TimeSpan dueTime) {
      if (String.IsNullOrWhiteSpace(message)) { throw new ArgumentException("message is required", "message"); }
      if (dueTime <= TimeSpan.Zero) { throw new ArgumentOutOfRangeException("dueTime"); }
      timer = new Timer(FailFast, message, dueTime, Timeout.InfiniteTimeSpan);
    }

    private static void FailFast(object state) {
      Environment.FailFast((string)state);
    }

    public void Dispose() {
      var timer = Interlocked.Exchange(ref this.timer, null);
      if (timer == null) { return; }

      using (var drained = new ManualResetEvent(false)) {
        timer.Dispose(drained);
        drained.WaitOne();
      }
      GC.SuppressFinalize(this);
    }
  }

}
'@
  }
}
function New-HarnessKillOnCloseJob {
  if ($env:OS -ne "Windows_NT") { throw "Windows Job Objects are required for bounded fixture execution" }
  Initialize-HarnessNativeTypes
  return [VemVisionHarness.KillOnCloseJob]::new()
}
function Arm-HarnessFailFastWatchdog {
  param(
    [Parameter(Mandatory = $true)][string]$Message,
    [Parameter(Mandatory = $true)][DateTime]$DeadlineUtc
  )

  $remaining = $DeadlineUtc - [DateTime]::UtcNow
  if ($remaining -le [TimeSpan]::Zero) { throw "watchdog deadline elapsed before it could be armed" }
  return [VemVisionHarness.FailFastWatchdog]::new($Message, $remaining)
}
function Initialize-HarnessSuspendedProcessWatchdog {
  param([Parameter(Mandatory = $true)][string]$HarnessRoot)

  if ($env:OS -ne "Windows_NT") { throw "the suspended-process watchdog requires Windows" }
  $watchdogRoot = Join-Path $HarnessRoot "native-watchdog"
  $watchdogPath = Join-Path $watchdogRoot "suspended-process-watchdog.exe"
  if (Test-Path -LiteralPath $watchdogPath -PathType Leaf) { return $watchdogPath }

  New-Item -ItemType Directory -Force -Path $watchdogRoot | Out-Null
  $sourcePath = Join-Path $watchdogRoot "SuspendedProcessWatchdog.cs"
  Write-Utf8 $sourcePath @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class SuspendedProcessWatchdog {
  private const uint WAIT_OBJECT_0 = 0;
  private const uint WAIT_FAILED = 0xFFFFFFFF;
  private const int MAX_COMMAND_BYTES = 256;

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool TerminateProcess(IntPtr process, uint exitCode);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool CloseHandle(IntPtr handle);

  private static void Write(string path, string value) {
    var bytes = new UTF8Encoding(false).GetBytes(value);
    using (var stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.Read)) {
      stream.Write(bytes, 0, bytes.Length);
      stream.Flush(true);
    }
  }

  private static bool TryReadCommand(string path, out string command) {
    command = null;
    try {
      if (!File.Exists(path)) { return false; }
      using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite)) {
        if (stream.Length < 1 || stream.Length > MAX_COMMAND_BYTES) { return false; }
        var bytes = new byte[(int)stream.Length];
        var offset = 0;
        while (offset < bytes.Length) {
          var read = stream.Read(bytes, offset, bytes.Length - offset);
          if (read == 0) { return false; }
          offset += read;
        }
        var text = new UTF8Encoding(false).GetString(bytes, 0, offset);
        if (!text.EndsWith("\n", StringComparison.Ordinal)) { return false; }
        command = text.TrimEnd('\r', '\n');
      }
      if (String.Equals(command, "disarm", StringComparison.Ordinal)) { return true; }
      DateTime terminationDeadlineUtc;
      return TryGetTerminationDeadline(command, out terminationDeadlineUtc);
    } catch (IOException) {
      return false;
    } catch (UnauthorizedAccessException) {
      return false;
    }
  }

  private static bool TryGetTerminationDeadline(string command, out DateTime deadlineUtc) {
    deadlineUtc = DateTime.MinValue;
    if (command.StartsWith("terminate:", StringComparison.Ordinal)) {
      long deadlineUtcTicks;
      if (!Int64.TryParse(command.Substring("terminate:".Length), NumberStyles.None, CultureInfo.InvariantCulture, out deadlineUtcTicks)) { return false; }
      try {
        deadlineUtc = new DateTime(deadlineUtcTicks, DateTimeKind.Utc);
        return true;
      } catch (ArgumentOutOfRangeException) {
        return false;
      }
    }
    return false;
  }

  private static bool TryTerminateProcess(IntPtr process, uint exitCode) {
    var fixtureResult = Environment.GetEnvironmentVariable("VEM_VISION_HARNESS_FIXTURE_WATCHDOG_TERMINATE_RESULT");
    if (String.Equals(fixtureResult, "success", StringComparison.Ordinal)) { return true; }
    if (String.Equals(fixtureResult, "failure", StringComparison.Ordinal)) { return false; }
    return TerminateProcess(process, exitCode);
  }

  private static void RecordCommandDeadline(DateTime deadlineUtc) {
    var path = Environment.GetEnvironmentVariable("VEM_VISION_HARNESS_FIXTURE_WATCHDOG_COMMAND_DEADLINE_PATH");
    if (!String.IsNullOrWhiteSpace(path)) { File.WriteAllText(path, deadlineUtc.Ticks.ToString(CultureInfo.InvariantCulture)); }
  }

  public static int Main(string[] args) {
    if (args == null || args.Length == 0) {
      var argumentCountPath = Environment.GetEnvironmentVariable("VEM_VISION_HARNESS_FIXTURE_WATCHDOG_PREFLIGHT_ARGUMENT_COUNT_PATH");
      if (!String.IsNullOrWhiteSpace(argumentCountPath)) { File.WriteAllText(argumentCountPath, "0"); }
      var processIdPath = Environment.GetEnvironmentVariable("VEM_VISION_HARNESS_FIXTURE_WATCHDOG_PREFLIGHT_PROCESS_ID_PATH");
      if (!String.IsNullOrWhiteSpace(processIdPath)) {
        using (var currentProcess = Process.GetCurrentProcess()) {
          File.WriteAllText(processIdPath, currentProcess.Id.ToString(CultureInfo.InvariantCulture));
        }
      }
      var delayMilliseconds = 0;
      Int32.TryParse(Environment.GetEnvironmentVariable("VEM_VISION_HARNESS_FIXTURE_WATCHDOG_PREFLIGHT_DELAY_MILLISECONDS"), NumberStyles.None, CultureInfo.InvariantCulture, out delayMilliseconds);
      if (delayMilliseconds > 0) { Thread.Sleep(delayMilliseconds); }
      var exitCode = 0;
      Int32.TryParse(Environment.GetEnvironmentVariable("VEM_VISION_HARNESS_FIXTURE_WATCHDOG_PREFLIGHT_EXIT_CODE"), NumberStyles.Integer, CultureInfo.InvariantCulture, out exitCode);
      return exitCode;
    }
    if (args == null || args.Length != 6) { return 2; }
    ulong inheritedHandleValue;
    long deadlineUtcTicks;
    long automaticConfirmationDeadlineUtcTicks;
    if (!UInt64.TryParse(args[0], NumberStyles.None, CultureInfo.InvariantCulture, out inheritedHandleValue) || !Int64.TryParse(args[4], NumberStyles.None, CultureInfo.InvariantCulture, out deadlineUtcTicks) || !Int64.TryParse(args[5], NumberStyles.None, CultureInfo.InvariantCulture, out automaticConfirmationDeadlineUtcTicks)) { return 2; }
    var commandPath = args[1];
    var readyPath = args[2];
    var completionPath = args[3];
    var process = new IntPtr(unchecked((long)inheritedHandleValue));
    if (process == IntPtr.Zero) { return 2; }
    try {
      DateTime deadlineUtc;
      DateTime automaticConfirmationDeadlineUtc;
      try {
        deadlineUtc = new DateTime(deadlineUtcTicks, DateTimeKind.Utc);
        automaticConfirmationDeadlineUtc = new DateTime(automaticConfirmationDeadlineUtcTicks, DateTimeKind.Utc);
      } catch (ArgumentOutOfRangeException) {
        return 2;
      }
      if (automaticConfirmationDeadlineUtc <= deadlineUtc) { return 2; }
      Write(readyPath, "armed");
      var terminationRequested = false;
      var terminationSignaled = false;
      var confirmationDeadlineUtc = automaticConfirmationDeadlineUtc;
      for (;;) {
        var signal = WaitForSingleObject(process, 0);
        if (signal == WAIT_OBJECT_0) {
          Write(completionPath, "exited");
          return 0;
        }
        if (signal == WAIT_FAILED) {
          Write(completionPath, "wait-failed:" + Marshal.GetLastWin32Error());
          return 1;
        }
        string command;
        if (TryReadCommand(commandPath, out command)) {
          var commandObservedUtc = DateTime.UtcNow;
          if (!terminationRequested && commandObservedUtc < deadlineUtc && String.Equals(command, "disarm", StringComparison.Ordinal)) {
            Write(completionPath, "disarmed");
            return 0;
          }
          DateTime requestedDeadlineUtc;
          if (TryGetTerminationDeadline(command, out requestedDeadlineUtc)) {
            if (!terminationRequested && requestedDeadlineUtc > commandObservedUtc) {
              confirmationDeadlineUtc = requestedDeadlineUtc;
              terminationRequested = true;
              RecordCommandDeadline(confirmationDeadlineUtc);
            } else if (terminationRequested && commandObservedUtc < confirmationDeadlineUtc && requestedDeadlineUtc > confirmationDeadlineUtc) {
              confirmationDeadlineUtc = requestedDeadlineUtc;
              RecordCommandDeadline(confirmationDeadlineUtc);
            }
          }
        }
        if (terminationRequested && DateTime.UtcNow >= confirmationDeadlineUtc) {
          Write(completionPath, "terminate-unconfirmed");
          return 1;
        }
        if (!terminationRequested && DateTime.UtcNow >= deadlineUtc) { terminationRequested = true; }
        if (terminationRequested) {
          var terminateGatePath = Environment.GetEnvironmentVariable("VEM_VISION_HARNESS_FIXTURE_WATCHDOG_TERMINATE_GATE_PATH");
          if (!terminationSignaled && (String.IsNullOrWhiteSpace(terminateGatePath) || File.Exists(terminateGatePath))) {
            if (TryTerminateProcess(process, 1)) {
              terminationSignaled = true;
            } else {
              signal = WaitForSingleObject(process, 0);
              if (signal == WAIT_OBJECT_0) {
                Write(completionPath, "exited");
                return 0;
              }
              if (signal == WAIT_FAILED) {
                Write(completionPath, "wait-failed:" + Marshal.GetLastWin32Error());
                return 1;
              }
            }
          }
          signal = WaitForSingleObject(process, 0);
          if (signal == WAIT_OBJECT_0) {
            Write(completionPath, "terminated");
            return 0;
          }
          if (signal == WAIT_FAILED) {
            Write(completionPath, "wait-failed:" + Marshal.GetLastWin32Error());
            return 1;
          }
        }
        Thread.Sleep(10);
      }
    } catch (Win32Exception exception) {
      Write(completionPath, "watchdog-failed:Win32Exception:" + exception.NativeErrorCode.ToString(CultureInfo.InvariantCulture));
      return 1;
    } catch (Exception exception) {
      Write(completionPath, "watchdog-failed:" + exception.GetType().Name);
      return 1;
    } finally {
      CloseHandle(process);
    }
  }
}
'@
  $csc = Join-Path $env:WINDIR "Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe"
  if (-not (Test-Path -LiteralPath $csc -PathType Leaf)) { throw "C# compiler missing for suspended-process watchdog" }
  & $csc /nologo /target:exe ("/out:{0}" -f $watchdogPath) $sourcePath
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $watchdogPath -PathType Leaf)) { throw "suspended-process watchdog compilation failed" }
  return $watchdogPath
}
function Invoke-HarnessSuspendedProcessWatchdogPreflight {
  param(
    [Parameter(Mandatory = $true)][string]$WatchdogPath,
    [Parameter(Mandatory = $true)][DateTime]$DeadlineUtc,
    [ValidateRange(100, 5000)][int]$CleanupReserveMilliseconds = 1000
  )

  $preflightFailFastWatchdog = Arm-HarnessFailFastWatchdog -Message "suspended-process watchdog preflight exceeded its hard deadline" -DeadlineUtc $DeadlineUtc
  try {
    $operationFailure = $null
    $cleanupFailures = New-Object 'System.Collections.Generic.List[System.Exception]'
    $process = $null
    try {
      try {
        if (-not (Test-Path -LiteralPath $WatchdogPath -PathType Leaf)) { throw "suspended-process watchdog executable is missing: $WatchdogPath" }
        $executionDeadlineUtc = $DeadlineUtc.AddMilliseconds(-$CleanupReserveMilliseconds)
        if ((Get-HarnessRemainingMilliseconds -DeadlineUtc $executionDeadlineUtc) -le 0) { throw "suspended-process watchdog preflight cannot start before its cleanup reserve" }

        $startInfo = [Diagnostics.ProcessStartInfo]::new()
        $startInfo.FileName = $WatchdogPath
        $startInfo.Arguments = ""
        $startInfo.WorkingDirectory = Split-Path -Parent $WatchdogPath
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $process = [Diagnostics.Process]::Start($startInfo)
        if ($null -eq $process) { throw "suspended-process watchdog preflight did not start" }
        $remainingMilliseconds = Get-HarnessRemainingMilliseconds -DeadlineUtc $executionDeadlineUtc
        if (-not $process.WaitForExit($remainingMilliseconds)) { throw "suspended-process watchdog preflight timed out before its cleanup reserve" }
        if ($process.ExitCode -ne 0) { throw "suspended-process watchdog preflight exited with code $($process.ExitCode)" }
      } catch {
        $operationFailure = $_.Exception
      }
    } finally {
      if ($null -ne $process) {
        try {
          if (-not $process.HasExited) {
            try { $process.Kill() } catch { if (-not $process.HasExited) { throw } }
            $cleanupMilliseconds = Get-HarnessRemainingMilliseconds -DeadlineUtc $DeadlineUtc
            if (-not $process.WaitForExit($cleanupMilliseconds)) { throw "suspended-process watchdog preflight cleanup could not confirm process termination before its hard deadline" }
          }
          if ($env:VEM_VISION_HARNESS_FIXTURE_WATCHDOG_PREFLIGHT_FORCE_CLEANUP_FAILURE -eq "1") { throw "suspended-process watchdog preflight fixture forced cleanup failure" }
        } catch {
          $cleanupFailures.Add($_.Exception)
        } finally {
          try { $process.Dispose() } catch { $cleanupFailures.Add($_.Exception) }
        }
      }
    }
    if ($null -ne $operationFailure -and $cleanupFailures.Count -gt 0) {
      $failures = New-Object 'System.Collections.Generic.List[System.Exception]'
      $failures.Add($operationFailure)
      foreach ($cleanupFailure in $cleanupFailures) { $failures.Add($cleanupFailure) }
      throw [AggregateException]::new("suspended-process watchdog preflight failed and cleanup failed", $failures)
    }
    if ($null -ne $operationFailure) { throw $operationFailure }
    if ($cleanupFailures.Count -gt 0) { throw [AggregateException]::new("suspended-process watchdog preflight cleanup failed", $cleanupFailures) }
  } finally {
    $preflightFailFastWatchdog.Dispose()
  }
}
function Get-HarnessSuspendedProcessWatchdogSetupSignalDiagnostic {
  param(
    [Parameter(Mandatory = $true)][ValidateSet("ready", "completion")][string]$Name,
    [Parameter(Mandatory = $true)][string]$Path
  )

  try {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return "$Name=missing" }
    $file = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($file.Length -gt 256) { return "$Name=too-large" }
    $value = [IO.File]::ReadAllText($Path, [Text.UTF8Encoding]::new($false)).Trim()
  } catch {
    return "$Name=unavailable"
  }

  if ($Name -eq "ready") {
    if ($value -eq "armed") { return "ready=armed" }
    return "ready=invalid"
  }
  if ($value -match "^(exited|terminated|disarmed|wait-failed:[0-9]+|terminate-failed:[0-9]+|terminate-unconfirmed|command-invalid|watchdog-failed:[A-Za-z0-9_]+(?::[0-9]+)?)$") {
    return "completion=$value"
  }
  return "completion=invalid"
}
function Get-HarnessSuspendedProcessWatchdogSetupFailureDiagnostic {
  param(
    [object]$Process,
    [Parameter(Mandatory = $true)][string]$WatchdogRoot,
    [Parameter(Mandatory = $true)][string]$ReadyPath,
    [Parameter(Mandatory = $true)][string]$CompletionPath,
    [Parameter(Mandatory = $true)][DateTime]$SetupDeadlineUtc,
    [Parameter(Mandatory = $true)][DateTime]$AutomaticDeadlineUtc,
    [Parameter(Mandatory = $true)][DateTime]$AutomaticConfirmationDeadlineUtc,
    [Parameter(Mandatory = $true)][int]$LastWin32Error
  )

  $processState = "watchdogProcess=unavailable"
  if ($null -ne $Process) {
    try {
      if ($Process.HasExited) {
        try {
          $exitCode = $Process.ExitCode
          [int]$exitCodeValue = 0
          if ($null -eq $exitCode -or -not [int]::TryParse([string]$exitCode, [ref]$exitCodeValue)) { $processState = "watchdogProcess=exited:unknown" }
          else { $processState = "watchdogProcess=exited:$exitCodeValue" }
        } catch {
          $processState = "watchdogProcess=exited:unknown"
        }
      } else {
        $processState = "watchdogProcess=running"
      }
    } catch {
      $processState = "watchdogProcess=unavailable"
    }
  }

  $temporaryFiles = "temporaryFiles=unavailable"
  try {
    $temporaryCounts = @{ command=0; invalid=0 }
    $temporaryEntries = 0
    $temporaryOverflow = $false
    foreach ($temporaryPath in [IO.Directory]::EnumerateFiles($WatchdogRoot)) {
      $temporaryName = [IO.Path]::GetFileName($temporaryPath)
      if ($temporaryName -in @("command", "ready", "completion")) { continue }
      $temporaryEntries++
      if ($temporaryEntries -gt 8) {
        $temporaryOverflow = $true
        break
      }
      if ($temporaryName -match '^\.command\.[0-9a-fA-F]{32}\.tmp$') {
        $temporaryCounts.command++
      } elseif ($temporaryName -match '^\..+\.tmp$') {
        $temporaryCounts.invalid++
      }
    }
    $temporaryFiles = "temporaryFiles=command:$($temporaryCounts.command),invalid:$($temporaryCounts.invalid),overflow:$($temporaryOverflow.ToString().ToLowerInvariant())"
  } catch { }

  return @(
    $processState,
    (Get-HarnessSuspendedProcessWatchdogSetupSignalDiagnostic -Name "ready" -Path $ReadyPath),
    (Get-HarnessSuspendedProcessWatchdogSetupSignalDiagnostic -Name "completion" -Path $CompletionPath),
    $temporaryFiles,
    "setupDeadlineUtcTicks=$($SetupDeadlineUtc.Ticks.ToString([Globalization.CultureInfo]::InvariantCulture))",
    "automaticDeadlineUtcTicks=$($AutomaticDeadlineUtc.Ticks.ToString([Globalization.CultureInfo]::InvariantCulture))",
    "automaticConfirmationDeadlineUtcTicks=$($AutomaticConfirmationDeadlineUtc.Ticks.ToString([Globalization.CultureInfo]::InvariantCulture))",
    "lastWin32Error=$LastWin32Error"
  ) -join ";"
}
function Add-HarnessSuspendedProcessWatchdogSetupFailureDiagnostic {
  param(
    [Parameter(Mandatory = $true)][Management.Automation.ErrorRecord]$ErrorRecord,
    [Parameter(Mandatory = $true)][string]$Diagnostic
  )

  try {
    [void]($ErrorRecord.Exception.Data["VemVisionHarness.SuspendedProcessWatchdogSetupDiagnostic"] = $Diagnostic)
  } catch { }
  try {
    $ErrorRecord.ErrorDetails = [Management.Automation.ErrorDetails]::new("$($ErrorRecord.Exception.Message) [suspended-process-watchdog-setup-diagnostic $Diagnostic]")
  } catch { }
}
function Start-HarnessSuspendedProcessWatchdog {
  param(
    [Parameter(Mandatory = $true)][string]$StageRoot,
    [Parameter(Mandatory = $true)][string]$WatchdogPath,
    [Parameter(Mandatory = $true)][object]$NativeProcess,
    [Parameter(Mandatory = $true)][DateTime]$DeadlineUtc,
    [DateTime]$SetupDeadlineUtc = [DateTime]::MinValue,
    [DateTime]$SetupAcceptanceDeadlineUtc = [DateTime]::MinValue,
    [ValidateRange(100, 5000)][int]$ConfirmationReserveMilliseconds = 1000,
    [DateTime]$AutomaticConfirmationDeadlineUtc = [DateTime]::MinValue,
    [Parameter(Mandatory = $true)][Alias("Watchdog")][ref]$WatchdogReference
  )

  if ($SetupDeadlineUtc -eq [DateTime]::MinValue) { $SetupDeadlineUtc = $DeadlineUtc }
  if ($AutomaticConfirmationDeadlineUtc -eq [DateTime]::MinValue) { $AutomaticConfirmationDeadlineUtc = $DeadlineUtc.AddMilliseconds($ConfirmationReserveMilliseconds) }
  if ($SetupDeadlineUtc -gt $DeadlineUtc) { throw "suspended-process watchdog setup deadline cannot exceed its termination deadline" }
  if ($AutomaticConfirmationDeadlineUtc -le $DeadlineUtc) { throw "suspended-process watchdog automatic confirmation deadline must follow its termination deadline" }
  if ($SetupAcceptanceDeadlineUtc -ne [DateTime]::MinValue -and $SetupAcceptanceDeadlineUtc -ge $SetupDeadlineUtc) { throw "suspended-process watchdog setup acceptance deadline must precede its setup deadline" }
  $watchdogStageRoot = Join-Path $StageRoot "suspended-process-watchdog"
  New-Item -ItemType Directory -Force -Path $watchdogStageRoot | Out-Null
  foreach ($staleSignalPath in @((Join-Path $watchdogStageRoot "command"), (Join-Path $watchdogStageRoot "ready"), (Join-Path $watchdogStageRoot "completion"))) {
    if (Test-Path -LiteralPath $staleSignalPath -PathType Leaf) { Remove-Item -LiteralPath $staleSignalPath -Force -ErrorAction Stop | Out-Null }
  }
  $watchdogRoot = Join-Path $watchdogStageRoot ([guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force -Path $watchdogRoot | Out-Null
  $commandPath = Join-Path $watchdogRoot "command"
  $readyPath = Join-Path $watchdogRoot "ready"
  $completionPath = Join-Path $watchdogRoot "completion"
  $remainingMilliseconds = Get-HarnessRemainingMilliseconds -DeadlineUtc $SetupDeadlineUtc
  if ($remainingMilliseconds -le 0) { throw "suspended-process watchdog deadline elapsed before it could be started" }
  if ($SetupAcceptanceDeadlineUtc -eq [DateTime]::MinValue) {
    $setupHandoffReserveMilliseconds = [Math]::Min(250, [Math]::Max(50, [int][Math]::Floor($remainingMilliseconds / 4)))
    $readyAcceptanceDeadlineUtc = $SetupDeadlineUtc.AddMilliseconds(-$setupHandoffReserveMilliseconds)
  } else {
    $readyAcceptanceDeadlineUtc = $SetupAcceptanceDeadlineUtc
    $setupHandoffReserveMilliseconds = [int][Math]::Floor(($SetupDeadlineUtc - $readyAcceptanceDeadlineUtc).TotalMilliseconds)
  }
  $deadlineUtcTicks = $DeadlineUtc.Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)
  $automaticConfirmationDeadlineUtcTicks = $AutomaticConfirmationDeadlineUtc.Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)
  # StartInheritedHandleWatchdog replaces this reserved argument with the inheritable DuplicateHandle value.
  $arguments = @("inherited-process-handle", $commandPath, $readyPath, $completionPath, $deadlineUtcTicks, $automaticConfirmationDeadlineUtcTicks)
  $process = $null
  $setupCleanupDeadlineUtc = $DeadlineUtc
  $readyFailure = $null
  try {
    $process = $NativeProcess.StartInheritedHandleWatchdog($WatchdogPath, [string[]]$arguments, $watchdogRoot)

    $readySignal = "ready=missing"
    while ($true) {
      $readySignal = Get-HarnessSuspendedProcessWatchdogSetupSignalDiagnostic -Name "ready" -Path $readyPath
      if ($readySignal -eq "ready=armed") {
        if ([DateTime]::UtcNow -ge $readyAcceptanceDeadlineUtc) {
          $readyFailure = "late-armed"
          throw "suspended-process watchdog ready signal armed after setup handoff deadline"
        }
        break
      }
      $remainingReadyMilliseconds = Get-HarnessRemainingMilliseconds -DeadlineUtc $readyAcceptanceDeadlineUtc
      if ($remainingReadyMilliseconds -le 0) {
        $readyFailure = switch ($readySignal) {
          "ready=missing" { "missing"; break }
          "ready=invalid" { "invalid"; break }
          default { "unavailable"; break }
        }
        throw "suspended-process watchdog setup handoff deadline elapsed with $readyFailure ready signal"
      }
      Start-Sleep -Milliseconds ([Math]::Min(10, $remainingReadyMilliseconds))
    }
    $watchdog = [pscustomobject]@{ process=$process; commandPath=$commandPath; completionPath=$completionPath; processId=$NativeProcess.ProcessId; completed=$false; commandAction=$null; confirmationDeadlineUtcTicks=$null; setupHandoffReserveMilliseconds=$setupHandoffReserveMilliseconds; disposed=$false; terminalCompletion=$null }
    [void]($WatchdogReference.Value = $watchdog)
    return
  } catch {
    if ($readyFailure -eq "late-armed") {
      try { [void]($_.Exception.Data["VemVisionHarness.SuspendedProcessWatchdogReadyFailure"] = "late-armed") } catch { }
    }
    if ($null -ne $process) {
      $watchdog = [pscustomobject]@{ process=$process; commandPath=$commandPath; completionPath=$completionPath; processId=$NativeProcess.ProcessId; completed=$false; commandAction=$null; confirmationDeadlineUtcTicks=$null; setupHandoffReserveMilliseconds=$setupHandoffReserveMilliseconds; disposed=$false; terminalCompletion=$null }
      [void]($WatchdogReference.Value = $watchdog)
      [void]($_.Exception.Data["VemVisionHarness.SuspendedProcessWatchdog"] = $watchdog)
    }
    [int]$lastWin32Error = 0
    try { $lastWin32Error = [Runtime.InteropServices.Marshal]::GetLastWin32Error() } catch { }
    $diagnostic = Get-HarnessSuspendedProcessWatchdogSetupFailureDiagnostic -Process $process -WatchdogRoot $watchdogRoot -ReadyPath $readyPath -CompletionPath $completionPath -SetupDeadlineUtc $SetupDeadlineUtc -AutomaticDeadlineUtc $DeadlineUtc -AutomaticConfirmationDeadlineUtc $AutomaticConfirmationDeadlineUtc -LastWin32Error $lastWin32Error
    Add-HarnessSuspendedProcessWatchdogSetupFailureDiagnostic -ErrorRecord $_ -Diagnostic $diagnostic
    throw
  }
}
function Get-HarnessSuspendedProcessWatchdogCompletion {
  param(
    [Parameter(Mandatory = $true)][object]$Watchdog,
    [DateTime]$DeadlineUtc = [DateTime]::MinValue
  )

  while ($true) {
    try {
      if (Test-Path -LiteralPath $Watchdog.completionPath -PathType Leaf) {
        $completion = [IO.File]::ReadAllText($Watchdog.completionPath, [Text.UTF8Encoding]::new($false)).Trim()
        if ($completion -match "^(exited|terminated|disarmed|wait-failed:[0-9]+|terminate-failed:[0-9]+|terminate-unconfirmed|command-invalid|watchdog-failed:[A-Za-z0-9_]+(?::[0-9]+)?)$") { return $completion }
      }
    } catch [IO.FileNotFoundException] {
    } catch [IO.IOException] {
    } catch [UnauthorizedAccessException] {
    }

    if ($DeadlineUtc -eq [DateTime]::MinValue) { return $null }
    $remainingMilliseconds = Get-HarnessRemainingMilliseconds -DeadlineUtc $DeadlineUtc
    if ($remainingMilliseconds -le 0) { return $null }
    Start-Sleep -Milliseconds ([Math]::Min(10, $remainingMilliseconds))
  }
}
function Assert-HarnessSuspendedProcessWatchdogCompletion {
  param(
    [Parameter(Mandatory = $true)][object]$Watchdog,
    [Parameter(Mandatory = $true)][ValidateSet("disarm", "terminate")][string]$Action,
    [Parameter(Mandatory = $true)][string]$Completion
  )

  if ($Action -eq "terminate" -and $Completion -notin @("terminated", "exited")) { throw "suspended-process watchdog could not terminate process $($Watchdog.processId): $Completion" }
  if ($Action -eq "disarm" -and $Completion -notin @("disarmed", "exited")) { throw "suspended-process watchdog could not disarm process $($Watchdog.processId): $Completion" }
}
function Initialize-HarnessSuspendedProcessWatchdogState {
  param([Parameter(Mandatory = $true)][object]$Watchdog)

  foreach ($property in @(@{ name="disposed"; value=$false }, @{ name="terminalCompletion"; value=$null }, @{ name="confirmationDeadlineUtcTicks"; value=$null })) {
    if ($null -eq $Watchdog.PSObject.Properties[$property.name]) {
      $Watchdog | Add-Member -MemberType NoteProperty -Name $property.name -Value $property.value | Out-Null
    }
  }
}
function Close-HarnessSuspendedProcessWatchdog {
  param([Parameter(Mandatory = $true)][object]$Watchdog)

  if ($Watchdog.disposed) { return }
  try {
    [void]$Watchdog.process.Dispose()
  } finally {
    [void]($Watchdog.disposed = $true)
  }
}
function Complete-HarnessSuspendedProcessWatchdogTerminal {
  param(
    [Parameter(Mandatory = $true)][object]$Watchdog,
    [Parameter(Mandatory = $true)][ValidateSet("disarm", "terminate")][string]$Action,
    [Parameter(Mandatory = $true)][string]$Completion
  )

  [void]($Watchdog.terminalCompletion = $Completion)
  try {
    Assert-HarnessSuspendedProcessWatchdogCompletion -Watchdog $Watchdog -Action $Action -Completion $Completion | Out-Null
    [void]($Watchdog.completed = $true)
  } finally {
    Close-HarnessSuspendedProcessWatchdog -Watchdog $Watchdog | Out-Null
  }
  Write-Output -NoEnumerate $Completion
  return
}
function Complete-HarnessSuspendedProcessWatchdog {
  param(
    [Parameter(Mandatory = $true)][object]$Watchdog,
    [Parameter(Mandatory = $true)][ValidateSet("disarm", "terminate")][string]$Action,
    [Parameter(Mandatory = $true)][DateTime]$DeadlineUtc
  )

  Initialize-HarnessSuspendedProcessWatchdogState -Watchdog $Watchdog | Out-Null
  if ($null -ne $Watchdog.terminalCompletion) {
    Assert-HarnessSuspendedProcessWatchdogCompletion -Watchdog $Watchdog -Action $Action -Completion $Watchdog.terminalCompletion | Out-Null
    Write-Output -NoEnumerate "already-completed"
    return
  }
  if ($Watchdog.disposed) { throw "suspended-process watchdog process handle was disposed without a terminal completion" }
  if ($Watchdog.completed) { throw "suspended-process watchdog was marked completed without a terminal completion" }
  if ($Action -eq "disarm" -and [Environment]::GetEnvironmentVariable("VEM_VISION_HARNESS_FIXTURE_FORCE_WATCHDOG_DISARM_COMMAND_WRITE_FAILURE", [EnvironmentVariableTarget]::Process) -eq "1") {
    [Environment]::SetEnvironmentVariable("VEM_VISION_HARNESS_FIXTURE_FORCE_WATCHDOG_DISARM_COMMAND_WRITE_FAILURE", $null, [EnvironmentVariableTarget]::Process)
    throw [InvalidOperationException]::new("fixture forced watchdog disarm command write failure")
  }

  $completion = Get-HarnessSuspendedProcessWatchdogCompletion -Watchdog $Watchdog
  if ($null -ne $completion) {
    return Complete-HarnessSuspendedProcessWatchdogTerminal -Watchdog $Watchdog -Action $Action -Completion $completion
  }

  if ($null -ne $Watchdog.commandAction -and $Watchdog.commandAction -ne $Action) { throw "suspended-process watchdog was already commanded to '$($Watchdog.commandAction)', not '$Action'" }
  $writeCommand = $null -eq $Watchdog.commandAction
  if ($Action -eq "terminate" -and $null -ne $Watchdog.confirmationDeadlineUtcTicks -and $DeadlineUtc.Ticks -gt [Int64]$Watchdog.confirmationDeadlineUtcTicks) {
    $writeCommand = $true
  }
  if ($writeCommand) {
    $command = if ($Action -eq "terminate") { "terminate:" + $DeadlineUtc.Ticks.ToString([Globalization.CultureInfo]::InvariantCulture) } else { $Action }
    Write-HarnessWatchdogCommand $Watchdog.commandPath $command -DeadlineUtc $DeadlineUtc | Out-Null
    [void]($Watchdog.commandAction = $Action)
    if ($Action -eq "terminate") { [void]($Watchdog.confirmationDeadlineUtcTicks = $DeadlineUtc.Ticks) }
  }
  $remainingMilliseconds = Get-HarnessRemainingMilliseconds -DeadlineUtc $DeadlineUtc
  if (-not $Watchdog.process.WaitForExit($remainingMilliseconds)) { throw "suspended-process watchdog did not complete '$Action' before the cleanup deadline" }
  $completion = Get-HarnessSuspendedProcessWatchdogCompletion -Watchdog $Watchdog -DeadlineUtc $DeadlineUtc
  if ($null -eq $completion) { $completion = "missing-completion" }
  Complete-HarnessSuspendedProcessWatchdogTerminal -Watchdog $Watchdog -Action $Action -Completion $completion
}
function Get-HarnessRemainingMilliseconds {
  param(
    [Parameter(Mandatory = $true)][DateTime]$DeadlineUtc
  )

  return [Math]::Max(0, [int][Math]::Floor(($DeadlineUtc - [DateTime]::UtcNow).TotalMilliseconds))
}
function Get-HarnessWatchdogSetupBudgetMilliseconds {
  param([Parameter(Mandatory = $true)][int]$AvailableMilliseconds)

  return [Math]::Min(60000, [Math]::Max(0, $AvailableMilliseconds))
}
function Get-HarnessTerminationConfirmationReserveMilliseconds {
  param([Parameter(Mandatory = $true)][int]$TotalMilliseconds)

  return [Math]::Min(2000, [Math]::Max(1000, [int][Math]::Floor($TotalMilliseconds / 4)))
}
function Get-HarnessWatchdogReserveMilliseconds {
  param([Parameter(Mandatory = $true)][int]$AvailableMilliseconds)

  if ($AvailableMilliseconds -le 50) { return 0 }
  return [Math]::Min(250, [Math]::Max(50, [int][Math]::Floor($AvailableMilliseconds / 4)))
}
function New-HarnessBoundedPowerShellDeadlinePlan {
  param(
    [Parameter(Mandatory = $true)][DateTime]$InvokeStartUtc,
    [Parameter(Mandatory = $true)][DateTime]$HarnessDeadlineUtc,
    [ValidateRange(0, 3600)][int]$CleanupReserveSeconds = 0,
    [ValidateRange(1, 3600)][int]$TimeoutSeconds = 30
  )

  # Round the single sampled interval down before constructing every deadline
  # from the same anchor. This leaves sub-millisecond clock-read overhead out
  # of the usable budget rather than borrowing it from execution cleanup.
  $harnessCleanupDeadlineUtc = $HarnessDeadlineUtc.AddSeconds(-$CleanupReserveSeconds)
  $availableTicks = $harnessCleanupDeadlineUtc.Ticks - $InvokeStartUtc.Ticks
  $availableMilliseconds = [int][Math]::Floor([double]$availableTicks / [TimeSpan]::TicksPerMillisecond)
  if ($availableMilliseconds -le 0) {
    throw "bounded PowerShell cannot start before the harness cleanup deadline"
  }
  $harnessBudgetDeadlineUtc = $InvokeStartUtc.AddMilliseconds($availableMilliseconds)
  $requestedExecutionMilliseconds = $TimeoutSeconds * 1000
  $stageBudgetMilliseconds = [Math]::Min($availableMilliseconds, $requestedExecutionMilliseconds + 2000)
  $confirmationReserveMilliseconds = Get-HarnessTerminationConfirmationReserveMilliseconds -TotalMilliseconds $stageBudgetMilliseconds
  $normalTailMilliseconds = $requestedExecutionMilliseconds + $confirmationReserveMilliseconds
  $preTailAvailableMilliseconds = $availableMilliseconds - $normalTailMilliseconds
  $watchdogHandoffReserveMilliseconds = Get-HarnessWatchdogReserveMilliseconds -AvailableMilliseconds $preTailAvailableMilliseconds
  $automaticTargetReserveMilliseconds = Get-HarnessWatchdogReserveMilliseconds -AvailableMilliseconds $preTailAvailableMilliseconds
  $automaticConfirmationReserveMilliseconds = Get-HarnessWatchdogReserveMilliseconds -AvailableMilliseconds $preTailAvailableMilliseconds
  $resumeTransitionReserveMilliseconds = 50
  if ($watchdogHandoffReserveMilliseconds -le $resumeTransitionReserveMilliseconds -or $automaticTargetReserveMilliseconds -lt 50 -or $automaticConfirmationReserveMilliseconds -lt 50) {
    throw "bounded PowerShell cannot reserve watchdog handoff and automatic confirmation while preserving execution and Job cleanup"
  }
  $automaticTailMilliseconds = $automaticTargetReserveMilliseconds + $automaticConfirmationReserveMilliseconds
  $watchdogTailMilliseconds = [Math]::Max($automaticTailMilliseconds, $normalTailMilliseconds)
  $watchdogSetupAvailableMilliseconds = $availableMilliseconds - $watchdogHandoffReserveMilliseconds - $watchdogTailMilliseconds
  $watchdogSetupBudgetMilliseconds = Get-HarnessWatchdogSetupBudgetMilliseconds -AvailableMilliseconds $watchdogSetupAvailableMilliseconds
  if ($watchdogSetupBudgetMilliseconds -le 0) {
    throw "bounded PowerShell cannot reserve watchdog setup before execution and cleanup"
  }

  $watchdogSetupDeadlineUtc = $InvokeStartUtc.AddMilliseconds($watchdogSetupBudgetMilliseconds)
  $watchdogHandoffEndDeadlineUtc = $watchdogSetupDeadlineUtc.AddMilliseconds($watchdogHandoffReserveMilliseconds)
  $watchdogDisarmHandoffDeadlineUtc = $watchdogHandoffEndDeadlineUtc.AddMilliseconds(-$resumeTransitionReserveMilliseconds)
  $watchdogAutomaticDeadlineUtc = $watchdogHandoffEndDeadlineUtc.AddMilliseconds($automaticTargetReserveMilliseconds)
  $watchdogAutomaticConfirmationDeadlineUtc = $watchdogAutomaticDeadlineUtc.AddMilliseconds($automaticConfirmationReserveMilliseconds)
  $normalExecutionLatestStartDeadlineUtc = $harnessBudgetDeadlineUtc.AddMilliseconds(-$normalTailMilliseconds)
  $setupAcceptanceReserveMilliseconds = Get-HarnessWatchdogReserveMilliseconds -AvailableMilliseconds $watchdogSetupBudgetMilliseconds
  $setupAcceptanceDeadlineUtc = $watchdogSetupDeadlineUtc.AddMilliseconds(-$setupAcceptanceReserveMilliseconds)

  if ($setupAcceptanceDeadlineUtc -ge $watchdogDisarmHandoffDeadlineUtc -or $watchdogDisarmHandoffDeadlineUtc -le $watchdogSetupDeadlineUtc -or $watchdogDisarmHandoffDeadlineUtc -ge $watchdogAutomaticDeadlineUtc -or $watchdogAutomaticConfirmationDeadlineUtc -gt $harnessBudgetDeadlineUtc -or $watchdogHandoffEndDeadlineUtc -gt $normalExecutionLatestStartDeadlineUtc) {
    throw "bounded PowerShell derived an invalid watchdog deadline plan"
  }

  return [pscustomobject]@{
    invokeStartUtc = $InvokeStartUtc
    harnessCleanupDeadlineUtc = $harnessCleanupDeadlineUtc
    harnessBudgetDeadlineUtc = $harnessBudgetDeadlineUtc
    availableMilliseconds = $availableMilliseconds
    requestedExecutionMilliseconds = $requestedExecutionMilliseconds
    confirmationReserveMilliseconds = $confirmationReserveMilliseconds
    normalTailMilliseconds = $normalTailMilliseconds
    watchdogSetupBudgetMilliseconds = $watchdogSetupBudgetMilliseconds
    watchdogHandoffReserveMilliseconds = $watchdogHandoffReserveMilliseconds
    resumeTransitionReserveMilliseconds = $resumeTransitionReserveMilliseconds
    setupAcceptanceReserveMilliseconds = $setupAcceptanceReserveMilliseconds
    automaticTargetReserveMilliseconds = $automaticTargetReserveMilliseconds
    automaticConfirmationReserveMilliseconds = $automaticConfirmationReserveMilliseconds
    watchdogSetupDeadlineUtc = $watchdogSetupDeadlineUtc
    setupAcceptanceDeadlineUtc = $setupAcceptanceDeadlineUtc
    watchdogHandoffEndDeadlineUtc = $watchdogHandoffEndDeadlineUtc
    watchdogDisarmHandoffDeadlineUtc = $watchdogDisarmHandoffDeadlineUtc
    watchdogAutomaticDeadlineUtc = $watchdogAutomaticDeadlineUtc
    watchdogAutomaticConfirmationDeadlineUtc = $watchdogAutomaticConfirmationDeadlineUtc
    normalExecutionLatestStartDeadlineUtc = $normalExecutionLatestStartDeadlineUtc
  }
}
function Wait-HarnessJobTermination {
  param(
    [Parameter(Mandatory = $true)][object]$Job,
    [Parameter(Mandatory = $true)][DateTime]$DeadlineUtc
  )

  $queryFailureDetail = $null
  $activeProcesses = $null
  while ($true) {
    try {
      $activeProcesses = $Job.ActiveProcessCount()
      if ($activeProcesses -eq 0) {
        return [pscustomobject]@{ confirmed=$true; activeProcesses=$activeProcesses; queryFailureDetail=$queryFailureDetail }
      }
    } catch {
      if ($null -eq $queryFailureDetail) {
        $queryFailureDetail = Get-HarnessTerminationFailureDetail -Operation "active-process-count" -ErrorRecord $_
      }
    }

    $remainingMilliseconds = Get-HarnessRemainingMilliseconds -DeadlineUtc $DeadlineUtc
    if ($remainingMilliseconds -le 0) { break }
    $sleepMilliseconds = [Math]::Min(25, $remainingMilliseconds)
    Start-Sleep -Milliseconds $sleepMilliseconds
  }

  return [pscustomobject]@{ confirmed=$false; activeProcesses=$activeProcesses; queryFailureDetail=$queryFailureDetail }
}
function Get-HarnessTerminationFailureDetail {
  param(
    [Parameter(Mandatory = $true)][string]$Operation,
    [Parameter(Mandatory = $true)][object]$ErrorRecord
  )

  $failure = if ($ErrorRecord -is [Management.Automation.ErrorRecord]) { $ErrorRecord.Exception } elseif ($ErrorRecord -is [Exception]) { $ErrorRecord } else { [Exception]::new([string]$ErrorRecord) }
  while ($null -ne $failure.InnerException) { $failure = $failure.InnerException }
  $nativeErrorCode = if ($null -ne $failure.PSObject.Properties["NativeErrorCode"]) { [string]$failure.NativeErrorCode } else { "none" }
  $exceptionType = ($failure.GetType().FullName -replace '[^A-Za-z0-9._:-]', '_')
  $exceptionMessage = ($failure.Message -replace '[^A-Za-z0-9._:-]', '_')
  if ([string]::IsNullOrWhiteSpace($exceptionMessage)) { $exceptionMessage = "empty" }
  if ($exceptionMessage.Length -gt 160) { $exceptionMessage = $exceptionMessage.Substring(0, 160) }
  return "termination=job-object operation=$Operation exceptionType=$exceptionType exceptionMessage=$exceptionMessage nativeErrorCode=$nativeErrorCode"
}
function Invoke-HarnessJobCleanup {
  param(
    [Parameter(Mandatory = $true)][string]$Stage,
    [AllowNull()][object]$Job,
    [Parameter(Mandatory = $true)][object]$CleanupState,
    [Parameter(Mandatory = $true)][DateTime]$CleanupDeadlineUtc,
    [Parameter(Mandatory = $true)][int]$ConfirmationReserveMilliseconds
  )

  $naturalExitDeadlineUtc = $CleanupDeadlineUtc.AddMilliseconds(-$ConfirmationReserveMilliseconds)
  $termination = $null
  if ($null -eq $Job) { return }

  $jobAssigned = $CleanupState.processOwnership -in @("job-assigned-suspended", "resumed-job-assigned")
  $mustTerminate = $CleanupState.exceptionalExit -and $jobAssigned
  if (-not $mustTerminate) {
    Write-HarnessStage $Stage "cleanup-confirmation-waiting" "remainingMilliseconds=$(Get-HarnessRemainingMilliseconds -DeadlineUtc $naturalExitDeadlineUtc) confirmationReserveMilliseconds=$ConfirmationReserveMilliseconds termination=job-object"
    $termination = Wait-HarnessJobTermination -Job $Job -DeadlineUtc $naturalExitDeadlineUtc
    if ($null -ne $termination.queryFailureDetail) {
      Write-HarnessStage $Stage "termination-query-failed" $termination.queryFailureDetail
    }
    if (-not $termination.confirmed) { $mustTerminate = $jobAssigned }
  }

  if ($mustTerminate) {
    Write-HarnessStage $Stage "termination-requested" "termination=job-object"
    try {
      $Job.Terminate()
      Write-HarnessStage $Stage "termination-signaled" "termination=job-object"
    } catch {
      Write-HarnessStage $Stage "termination-failed" (Get-HarnessTerminationFailureDetail -Operation "terminate-job-object" -ErrorRecord $_)
    }
    Write-HarnessStage $Stage "termination-waiting" "remainingMilliseconds=$(Get-HarnessRemainingMilliseconds -DeadlineUtc $CleanupDeadlineUtc) confirmationReserveMilliseconds=$ConfirmationReserveMilliseconds termination=job-object"
    $termination = Wait-HarnessJobTermination -Job $Job -DeadlineUtc $CleanupDeadlineUtc
    if ($null -ne $termination.queryFailureDetail) {
      Write-HarnessStage $Stage "termination-query-failed" $termination.queryFailureDetail
    }
  }

  if ($termination.activeProcesses -eq 0) {
    Write-HarnessStage $Stage "termination-confirmed" "termination=job-object activeProcesses=$($termination.activeProcesses) confirmationReserveMilliseconds=$ConfirmationReserveMilliseconds"
    Write-HarnessStage $Stage "cleanup-job-dispose-started"
    $Job.Dispose()
    Write-HarnessStage $Stage "cleanup-job-dispose-completed"
    return
  }

  Write-HarnessStage $Stage "cleanup-job-dispose-skipped" "reason=termination-unconfirmed activeProcesses=$($termination.activeProcesses)"
  Write-HarnessStage $Stage "hard-watchdog-required" "reason=termination-unconfirmed ownership=$($CleanupState.processOwnership)"
  throw "fixture stage '$Stage' could not confirm its Job Object was empty; leaving the Job Object handle for the hard watchdog to cap"
}
function Invoke-BoundedPowerShell {
  param(
    [Parameter(Mandatory = $true)][string]$Stage,
    [Parameter(Mandatory = $true)][string]$ScriptBody,
    [Parameter(Mandatory = $true)][string]$HarnessRoot,
    [Parameter(Mandatory = $true)][string]$HarnessContextPath,
    [Parameter(Mandatory = $true)][string]$ChildPowerShellPath,
    [Parameter(Mandatory = $true)][DateTime]$HarnessDeadlineUtc,
    [int]$CleanupReserveSeconds = 0,
    [int]$TimeoutSeconds = 30
  )

  $invokeStartUtc = [DateTime]::UtcNow
  $deadlinePlan = New-HarnessBoundedPowerShellDeadlinePlan -InvokeStartUtc $invokeStartUtc -HarnessDeadlineUtc $HarnessDeadlineUtc -CleanupReserveSeconds $CleanupReserveSeconds -TimeoutSeconds $TimeoutSeconds
  $harnessBudgetDeadlineUtc = $deadlinePlan.harnessBudgetDeadlineUtc
  $confirmationReserveMilliseconds = [int]$deadlinePlan.confirmationReserveMilliseconds
  $requestedExecutionMilliseconds = [int]$deadlinePlan.requestedExecutionMilliseconds
  $watchdogSetupDeadlineUtc = $deadlinePlan.watchdogSetupDeadlineUtc
  $setupAcceptanceDeadlineUtc = $deadlinePlan.setupAcceptanceDeadlineUtc
  $setupAcceptanceReserveMilliseconds = [int]$deadlinePlan.setupAcceptanceReserveMilliseconds
  $watchdogDisarmHandoffDeadlineUtc = $deadlinePlan.watchdogDisarmHandoffDeadlineUtc
  $watchdogAutomaticDeadlineUtc = $deadlinePlan.watchdogAutomaticDeadlineUtc
  $watchdogAutomaticConfirmationDeadlineUtc = $deadlinePlan.watchdogAutomaticConfirmationDeadlineUtc
  $normalExecutionLatestStartDeadlineUtc = $deadlinePlan.normalExecutionLatestStartDeadlineUtc
  $cleanupDeadlineUtc = $watchdogAutomaticConfirmationDeadlineUtc
  $executionDeadlineUtc = $null
  $executionMilliseconds = $null
  $effectiveTimeoutSeconds = $null

  $safeStage = $Stage -replace '[^A-Za-z0-9._-]', "-"
  $stageRoot = Join-Path $HarnessRoot ("diagnostics\\" + $safeStage + "-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $stageRoot -ErrorAction Stop | Out-Null
  $scriptPath = Join-Path $stageRoot "operation.ps1"
  $bootstrapPath = Join-Path $stageRoot "bootstrap.ps1"
  $stdoutPath = Join-Path $stageRoot "stdout.log"
  $stderrPath = Join-Path $stageRoot "stderr.log"
  $escapedContextPath = $HarnessContextPath.Replace("'", "''")
  $escapedScriptPath = $scriptPath.Replace("'", "''")
  $escapedStdoutPath = $stdoutPath.Replace("'", "''")
  $escapedStderrPath = $stderrPath.Replace("'", "''")
  $digestFunction = ${function:Get-Digest}.ToString()
  $writeHarnessStageFunction = ${function:Write-HarnessStage}.ToString()
  $cleanupFunction = ${function:Remove-HarnessFixtureCertificates}.ToString()
  $runtimeCleanupFunction = ${function:Stop-HarnessFixtureRuntime}.ToString()
  $cleanupInvocationFunction = ${function:Invoke-HarnessFixtureCleanup}.ToString()
  Write-Utf8 $scriptPath @"
`$ErrorActionPreference = "Stop"
function Write-Utf8([string]`$Path, [string]`$Text) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent `$Path) | Out-Null
  [IO.File]::WriteAllText(`$Path, `$Text, [Text.UTF8Encoding]::new(`$false))
}
function Get-Digest {
$digestFunction
}
function Write-Json([string]`$Path, [object]`$Value) { Write-Utf8 `$Path (`$Value | ConvertTo-Json -Depth 32 -Compress) }
function Evidence-Identity([string]`$Digest) { "factory-evidence://" + `$Digest.Replace(":", "/") }
function Assert-True([bool]`$Value, [string]`$Message) { if (-not `$Value) { throw `$Message } }
function Write-HarnessStage {
$writeHarnessStageFunction
}
function Remove-HarnessFixtureCertificates {
$cleanupFunction
}
function Stop-HarnessFixtureRuntime {
$runtimeCleanupFunction
}
function Invoke-HarnessFixtureCleanup {
$cleanupInvocationFunction
}
`$context = Get-Content -LiteralPath '$escapedContextPath' -Raw | ConvertFrom-Json
$ScriptBody
"@

  Write-Utf8 $bootstrapPath @"
`$ErrorActionPreference = "Stop"
& '$escapedScriptPath' 1> '$escapedStdoutPath' 2> '$escapedStderrPath'
if (`$LASTEXITCODE -ne 0) { exit `$LASTEXITCODE }
"@

  $nativeProcess = $null
  $nativeArguments = [string[]]@("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", $bootstrapPath)
  $nativeCommand = ([VemVisionHarness.SuspendedProcess]::QuoteArgument($ChildPowerShellPath)) + " " + (($nativeArguments | ForEach-Object { [VemVisionHarness.SuspendedProcess]::QuoteArgument($_) }) -join " ")
  $suspendedProcessWatchdog = $null
  $job = $null
  $cleanupState = [pscustomobject]@{
    processOwnership = "not-created"
    exceptionalExit = $false
  }
  $operationFailure = $null
  $watchdogCompletionFailure = $null
  $watchdogCompletionAction = $null
  $cleanupFailures = New-Object 'System.Collections.Generic.List[System.Exception]'
  $result = $null
  if ([string]::IsNullOrWhiteSpace([string]$script:HarnessSuspendedProcessWatchdogPath)) { throw "suspended-process watchdog is not initialized" }
  try {
    $job = New-HarnessKillOnCloseJob
    Write-HarnessStage $Stage "process-ownership" "state=not-created"
    $nativeProcess = [VemVisionHarness.SuspendedProcess]::Create($ChildPowerShellPath, $nativeArguments, $stageRoot)
    $cleanupState.processOwnership = "created-suspended"
    Write-HarnessStage $Stage "process-ownership" "state=created-suspended processId=$($nativeProcess.ProcessId)"
    try {
      Start-HarnessSuspendedProcessWatchdog -StageRoot $stageRoot -WatchdogPath $script:HarnessSuspendedProcessWatchdogPath -NativeProcess $nativeProcess -DeadlineUtc $watchdogAutomaticDeadlineUtc -SetupDeadlineUtc $watchdogSetupDeadlineUtc -SetupAcceptanceDeadlineUtc $setupAcceptanceDeadlineUtc -AutomaticConfirmationDeadlineUtc $watchdogAutomaticConfirmationDeadlineUtc -Watchdog ([ref]$suspendedProcessWatchdog) | Out-Null
    } catch {
      $watchdogSetupDiagnostic = [string]$_.Exception.Data["VemVisionHarness.SuspendedProcessWatchdogSetupDiagnostic"]
      $watchdogReadyFailure = [string]$_.Exception.Data["VemVisionHarness.SuspendedProcessWatchdogReadyFailure"]
      if ($watchdogReadyFailure -eq "late-armed" -and -not [string]::IsNullOrWhiteSpace($watchdogSetupDiagnostic)) {
        $watchdogSetupDiagnostic += ";readyFailure=late-armed"
      }
      if (-not [string]::IsNullOrWhiteSpace($watchdogSetupDiagnostic)) {
        try { Write-HarnessStage $Stage "suspended-process-watchdog-setup-failed" $watchdogSetupDiagnostic } catch { }
      }
      throw
    }
    Write-HarnessStage $Stage "suspended-process-watchdog-armed" "processId=$($nativeProcess.ProcessId) identity=original-process-handle"
    $job.Assign($nativeProcess.ProcessHandle)
    $cleanupState.processOwnership = "job-assigned-suspended"
    Write-HarnessStage $Stage "process-ownership" "state=job-assigned-suspended processId=$($nativeProcess.ProcessId)"
    if ([Environment]::GetEnvironmentVariable("VEM_VISION_HARNESS_FIXTURE_FORCE_PRE_DISARM_OPERATION_FAILURE", [EnvironmentVariableTarget]::Process) -eq "1") {
      [Environment]::SetEnvironmentVariable("VEM_VISION_HARNESS_FIXTURE_FORCE_PRE_DISARM_OPERATION_FAILURE", $null, [EnvironmentVariableTarget]::Process)
      throw "fixture forced pre-disarm operation failure"
    }
    $initialHandoffReserveMilliseconds = [int]$suspendedProcessWatchdog.setupHandoffReserveMilliseconds
    if ($initialHandoffReserveMilliseconds -ne $setupAcceptanceReserveMilliseconds) {
      throw "fixture stage '$Stage' did not preserve its planned watchdog setup acceptance reserve"
    }
    $handoffDeadlineUtc = $watchdogDisarmHandoffDeadlineUtc
    if ($setupAcceptanceDeadlineUtc -ge $handoffDeadlineUtc) {
      throw "fixture stage '$Stage' cannot reserve disarm handoff after setup acceptance"
    }
    if ($handoffDeadlineUtc -ge $watchdogAutomaticDeadlineUtc) {
      throw "fixture stage '$Stage' cannot reserve watchdog automatic termination after disarm handoff"
    }
    if ((Get-HarnessRemainingMilliseconds -DeadlineUtc $handoffDeadlineUtc) -le 0) {
      throw "fixture stage '$Stage' cannot complete its watchdog disarm handoff before the automatic termination reserve"
    }
    try {
      $watchdogCompletion = Complete-HarnessSuspendedProcessWatchdog -Watchdog $suspendedProcessWatchdog -Action "disarm" -DeadlineUtc $handoffDeadlineUtc
    } catch {
      if ($suspendedProcessWatchdog.terminalCompletion -eq "missing-completion") {
        $watchdogCompletionFailure = $_
        $watchdogCompletionAction = "disarm"
      }
      throw
    }
    Write-HarnessStage $Stage "suspended-process-watchdog-disarmed" "processId=$($nativeProcess.ProcessId) completion=$watchdogCompletion"
    $suspendedProcessWatchdog = $null
    if ([DateTime]::UtcNow -ge $normalExecutionLatestStartDeadlineUtc) {
      $cleanupDeadlineUtc = $harnessBudgetDeadlineUtc
      throw "fixture stage '$Stage' cannot resume with its requested execution timeout and Job cleanup reserve after watchdog handoff"
    }
    $nativeProcess.Resume()
    $cleanupState.processOwnership = "resumed-job-assigned"
    $executionStartUtc = [DateTime]::UtcNow
    $executionMilliseconds = $requestedExecutionMilliseconds
    $executionDeadlineUtc = $executionStartUtc.AddMilliseconds($requestedExecutionMilliseconds)
    $requestedCleanupDeadlineUtc = $executionDeadlineUtc.AddMilliseconds($confirmationReserveMilliseconds)
    if ($requestedCleanupDeadlineUtc -gt $harnessBudgetDeadlineUtc) {
      $cleanupDeadlineUtc = $harnessBudgetDeadlineUtc
      throw "fixture stage '$Stage' cannot preserve its requested execution timeout and Job cleanup reserve after watchdog handoff"
    }
    $cleanupDeadlineUtc = $requestedCleanupDeadlineUtc
    $effectiveTimeoutSeconds = [Math]::Max(1, [int][Math]::Ceiling($executionMilliseconds / 1000.0))
    Write-HarnessStage $Stage "process-ownership" "state=resumed-job-assigned processId=$($nativeProcess.ProcessId)"
    Write-HarnessStage $Stage "started" "timeoutSeconds=$effectiveTimeoutSeconds processId=$($nativeProcess.ProcessId) termination=job-object"

    $timeoutMilliseconds = [Math]::Min($executionMilliseconds, (Get-HarnessRemainingMilliseconds -DeadlineUtc $executionDeadlineUtc))
    if (-not $nativeProcess.WaitForExit([uint32]$timeoutMilliseconds)) {
      Write-HarnessStage $Stage "timed-out" "timeoutSeconds=$effectiveTimeoutSeconds termination=job-object"
      throw "fixture stage '$Stage' exceeded $effectiveTimeoutSeconds seconds; cleanup will terminate the assigned Job Object"
    }

    $stdout = if (Test-Path -LiteralPath $stdoutPath) { Get-Content -LiteralPath $stdoutPath -Raw } else { "" }
    $stderr = if (Test-Path -LiteralPath $stderrPath) { Get-Content -LiteralPath $stderrPath -Raw } else { "" }
    if ($nativeProcess.ExitCode -ne 0) {
      Write-HarnessStage $Stage "failed" "exitCode=$($nativeProcess.ExitCode)"
      throw "fixture stage '$Stage' failed with exit code $($nativeProcess.ExitCode): command=$nativeCommand stdout=$stdout stderr=$stderr"
    }
    Write-HarnessStage $Stage "completed"
    $result = [pscustomobject]@{ stdout=$stdout; stderr=$stderr; diagnosticsPath=$stageRoot }
  } catch {
    if ($null -ne $nativeProcess -and $nativeProcess.IsResumed) {
      $cleanupState.processOwnership = "resumed-job-assigned"
    }
    $cleanupState.exceptionalExit = $true
    $operationFailure = $_
  } finally {
    $nativeCleanupFailure = $null
    $targetTerminationConfirmationFailures = New-Object 'System.Collections.Generic.List[System.Exception]'
    $nativeCleanupConfirmed = $null -eq $nativeProcess -or $nativeProcess.IsResumed
    $nativeTargetTerminationConfirmed = $null -eq $nativeProcess
    try {
      if ($null -ne $nativeProcess -and -not $nativeProcess.IsResumed) {
        Write-HarnessStage $Stage "suspended-process-termination-requested" "processId=$($nativeProcess.ProcessId)"
        try {
          $nativeProcess.TerminateUnresumed([uint32](Get-HarnessRemainingMilliseconds -DeadlineUtc $cleanupDeadlineUtc))
          Write-HarnessStage $Stage "suspended-process-termination-confirmed" "processId=$($nativeProcess.ProcessId)"
          $nativeCleanupConfirmed = $true
          $nativeTargetTerminationConfirmed = $true
        } catch {
          Write-HarnessStage $Stage "suspended-process-termination-failed" (Get-HarnessTerminationFailureDetail -Operation "terminate-suspended-process" -ErrorRecord $_)
          $targetTerminationConfirmationFailures.Add($_.Exception)
        }
        if ($null -ne $suspendedProcessWatchdog) {
          if ($null -eq $watchdogCompletionFailure) {
            $watchdogCompletion = $null
            try {
              $watchdogAction = if ($nativeCleanupConfirmed) { "disarm" } else { "terminate" }
              $watchdogCompletion = Complete-HarnessSuspendedProcessWatchdog -Watchdog $suspendedProcessWatchdog -Action $watchdogAction -DeadlineUtc $cleanupDeadlineUtc
            } catch {
              if ($suspendedProcessWatchdog.terminalCompletion -eq "missing-completion") {
                $watchdogCompletionFailure = $_
                $watchdogCompletionAction = $watchdogAction
              } else {
                $cleanupFailures.Add($_.Exception)
                try {
                  Close-HarnessSuspendedProcessWatchdog -Watchdog $suspendedProcessWatchdog
                  Write-HarnessStage $Stage "suspended-process-watchdog-closed" "reason=completion-failed"
                } catch {
                  $cleanupFailures.Add($_.Exception)
                }
                $suspendedProcessWatchdog = $null
              }
            }
            if ($null -ne $watchdogCompletion) {
              if (-not $nativeCleanupConfirmed) {
                try {
                  if (-not $nativeProcess.WaitForExit([uint32](Get-HarnessRemainingMilliseconds -DeadlineUtc $cleanupDeadlineUtc))) { throw "suspended-process watchdog reported '$watchdogCompletion' without a signaled original process handle" }
                  $nativeCleanupConfirmed = $true
                  $nativeTargetTerminationConfirmed = $true
                  Write-HarnessStage $Stage "suspended-process-watchdog-terminated" "processId=$($nativeProcess.ProcessId) completion=$watchdogCompletion identity=original-process-handle"
                } catch {
                  $targetTerminationConfirmationFailures.Add($_.Exception)
                }
              } else {
                Write-HarnessStage $Stage "suspended-process-watchdog-disarmed" "processId=$($nativeProcess.ProcessId) completion=$watchdogCompletion"
              }
              $suspendedProcessWatchdog = $null
            }
          }
        }
      }
    } catch {
      if ($null -eq $nativeCleanupFailure) { $nativeCleanupFailure = $_ }
      else { $cleanupFailures.Add($_.Exception) }
    } finally {
      try {
        if ($null -ne $nativeProcess -and $nativeCleanupConfirmed) { $nativeProcess.Dispose() }
      } catch {
        if ($null -eq $nativeCleanupFailure) { $nativeCleanupFailure = $_ } else { $cleanupFailures.Add($_.Exception) }
      } finally {
        $jobCleanupConfirmed = $false
        try {
          Invoke-HarnessJobCleanup -Stage $Stage -Job $job -CleanupState $cleanupState -CleanupDeadlineUtc $cleanupDeadlineUtc -ConfirmationReserveMilliseconds $confirmationReserveMilliseconds
          $jobCleanupConfirmed = $true
        } catch {
          $cleanupFailures.Add($_.Exception)
        }
        $authoritativeTargetTerminationConfirmed = $nativeTargetTerminationConfirmed -or ($jobCleanupConfirmed -and $cleanupState.processOwnership -in @("job-assigned-suspended", "resumed-job-assigned"))
        if ($null -ne $watchdogCompletionFailure) {
          if ($authoritativeTargetTerminationConfirmed) {
            $terminationAuthority = if ($nativeTargetTerminationConfirmed) { "native-process-handle" } else { "job-object" }
            Write-HarnessStage $Stage "suspended-process-watchdog-completion-ignored" "action=$watchdogCompletionAction completion=missing-completion authority=$terminationAuthority"
            $suspendedProcessWatchdog = $null
          } else {
            $targetTerminationConfirmationFailures.Add($watchdogCompletionFailure.Exception)
          }
        }
        if ($authoritativeTargetTerminationConfirmed) {
          if ($targetTerminationConfirmationFailures.Count -gt 0) {
            $terminationAuthority = if ($nativeTargetTerminationConfirmed) { "native-process-handle" } else { "job-object" }
            Write-HarnessStage $Stage "suspended-process-termination-fallback-confirmed" "authority=$terminationAuthority failures=$($targetTerminationConfirmationFailures.Count)"
          }
        } else {
          foreach ($targetTerminationConfirmationFailure in $targetTerminationConfirmationFailures) { $cleanupFailures.Add($targetTerminationConfirmationFailure) }
        }
        if ($null -ne $nativeProcess -and -not $nativeCleanupConfirmed) {
          if ($jobCleanupConfirmed -and $cleanupState.processOwnership -in @("job-assigned-suspended", "resumed-job-assigned")) {
            try {
              $nativeProcess.Dispose()
              $nativeCleanupConfirmed = $true
              Write-HarnessStage $Stage "suspended-process-handle-released" "reason=job-cleanup-confirmed"
            } catch {
              if ($null -eq $nativeCleanupFailure) { $nativeCleanupFailure = $_ } else { $cleanupFailures.Add($_.Exception) }
            }
          } else {
            Write-HarnessStage $Stage "suspended-process-handle-retained" "processId=$($nativeProcess.ProcessId) reason=cleanup-unconfirmed"
          }
        }
      }
    }
    if ($null -ne $nativeCleanupFailure) { $cleanupFailures.Add($nativeCleanupFailure.Exception) }
  }
  if ($null -ne $operationFailure -and $cleanupFailures.Count -gt 0) {
    $failures = New-Object 'System.Collections.Generic.List[System.Exception]'
    $failures.Add($operationFailure.Exception)
    foreach ($cleanupFailure in $cleanupFailures) { $failures.Add($cleanupFailure) }
    throw [AggregateException]::new("fixture stage '$Stage' failed and cleanup could not confirm the suspended process was terminated", $failures)
  }
  if ($null -ne $operationFailure) { throw $operationFailure }
  if ($cleanupFailures.Count -gt 0) { throw [AggregateException]::new("fixture stage '$Stage' cleanup failed", $cleanupFailures) }
  return $result
}

if ($Library) { return }
if ($env:OS -ne "Windows_NT" -or $env:CI -ne "true") { throw "Windows CI only" }
if ([string]::IsNullOrWhiteSpace($InstallerPath)) { throw "InstallerPath is required" }

$root = Join-Path $env:RUNNER_TEMP ("vem-vision-installer-" + [guid]::NewGuid().ToString("N"))
$media = Join-Path $root "media"
$visionMediaRoot = Join-Path $media "VEM"
$delivery = Join-Path $media "VEM\VISION-RELEASE"
$trust = Join-Path $media "VEM\VISION-TRUST"
$installerMedia = Join-Path $media "VEM\VISION-INSTALLER"
$factoryRoot = "C:\ProgramData\VEM\factory"
$stateRoot = "C:\ProgramData\VEM\vision"
$evidencePath = "C:\ProgramData\VEM\evidence\vision-release-install.json"
$csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$assetPowerShellPath = (Get-Command pwsh -ErrorAction Stop).Source
$corePowerShellPathInputs = if ($CorePowerShellPaths.Count -eq 0) { @($assetPowerShellPath) } else { $CorePowerShellPaths }
$corePowerShellPaths = @($corePowerShellPathInputs | ForEach-Object { (Get-Command $_ -CommandType Application -ErrorAction Stop | Select-Object -First 1 -ExpandProperty Source) } | Select-Object -Unique)
Assert-True ($corePowerShellPaths.Count -gt 0) "at least one core PowerShell executable is required"
$harnessContextPath = Join-Path $root "harness-context.json"
$certificateCleanupMarkerPath = Join-Path $root "fixture-certificate-cleanup.json"
$certificateSubject = "CN=VEM Vision CI Fixture " + [guid]::NewGuid().ToString("N")
$HarnessDeadlineSeconds = 480
$CleanupReserveSeconds = 75
Initialize-HarnessNativeTypes
$deadlineStartUtc = [DateTime]::UtcNow
$harnessDeadlineUtc = $deadlineStartUtc.AddSeconds($HarnessDeadlineSeconds)
$watchdogMessage = "vision installer harness exceeded its $HarnessDeadlineSeconds-second hard deadline"
$watchdog = Arm-HarnessFailFastWatchdog -Message $watchdogMessage -DeadlineUtc $harnessDeadlineUtc
$harnessContext = [ordered]@{
  root = $root
  media = $media
  visionMediaRoot = $visionMediaRoot
  delivery = $delivery
  trust = $trust
  installerMedia = $installerMedia
  factoryRoot = $factoryRoot
  stateRoot = $stateRoot
  evidencePath = $evidencePath
  harnessScriptRoot = $PSScriptRoot
  installerPath = [IO.Path]::GetFullPath($InstallerPath)
  childPowerShellPath = $assetPowerShellPath
  runtimePath = $null
  certificateSubject = $certificateSubject
  certificateThumbprint = $null
  certificateExportPath = $null
}

try {
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  Assert-True (Test-Path -LiteralPath $csc -PathType Leaf) "C# compiler missing from Windows runner"
  $script:HarnessSuspendedProcessWatchdogPath = Initialize-HarnessSuspendedProcessWatchdog -HarnessRoot $root
  $watchdogPreflightDeadlineUtc = [DateTime]::UtcNow.AddSeconds(35)
  $harnessPreflightDeadlineUtc = $harnessDeadlineUtc.AddSeconds(-$CleanupReserveSeconds)
  if ($watchdogPreflightDeadlineUtc -gt $harnessPreflightDeadlineUtc) { $watchdogPreflightDeadlineUtc = $harnessPreflightDeadlineUtc }
  Invoke-HarnessSuspendedProcessWatchdogPreflight -WatchdogPath $script:HarnessSuspendedProcessWatchdogPath -DeadlineUtc $watchdogPreflightDeadlineUtc
  Write-HarnessStage "harness" "suspended-process-watchdog-preflight-completed"
  Write-Json $certificateCleanupMarkerPath @{ schemaVersion="vem-vision-harness-certificate-cleanup/v1"; certificateSubject=$certificateSubject; certificateThumbprint=$null }
  Write-Json $harnessContextPath $harnessContext
  Write-HarnessStage "harness" "started"
  Invoke-BoundedPowerShell -Stage "fixture.cleanup" -TimeoutSeconds 30 -CleanupReserveSeconds $CleanupReserveSeconds -HarnessRoot $root -HarnessContextPath $harnessContextPath -ChildPowerShellPath $assetPowerShellPath -HarnessDeadlineUtc $harnessDeadlineUtc -ScriptBody @'
Remove-Item -LiteralPath "C:\VEM", "C:\ProgramData\VEM" -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $context.delivery, $context.trust, $context.installerMedia | Out-Null
'@ | Out-Null
  Invoke-BoundedPowerShell -Stage "fixture.create-kiosk-account" -TimeoutSeconds 30 -CleanupReserveSeconds $CleanupReserveSeconds -HarnessRoot $root -HarnessContextPath $harnessContextPath -ChildPowerShellPath $assetPowerShellPath -HarnessDeadlineUtc $harnessDeadlineUtc -ScriptBody @'
if ($null -ne (Get-LocalUser -Name "VEMKiosk" -ErrorAction SilentlyContinue)) { throw "fixture VEMKiosk account already exists" }
$password = ConvertTo-SecureString ("Vem!" + [guid]::NewGuid().ToString("N") + "aA1") -AsPlainText -Force
New-LocalUser -Name "VEMKiosk" -Password $password -AccountNeverExpires -PasswordNeverExpires -UserMayNotChangePassword | Out-Null
New-Item -ItemType File -Path (Join-Path $context.root "kiosk-account-created") -Force | Out-Null
'@ | Out-Null
  $runtimeSource = @'
using System; using System.IO; using System.Net; using System.Net.WebSockets; using System.Diagnostics; using System.Security.Cryptography; using System.Text; using System.Threading;
class VisionFixture {
 static string Field(string text,string name) { var key="\""+name+"\":\""; var start=text.IndexOf(key)+key.Length; return start<key.Length?"":text.Substring(start,text.IndexOf("\"",start)-start); }
 static string Hash(string p) { using(var s=SHA256.Create()) using(var f=File.OpenRead(p)) return "sha256:"+BitConverter.ToString(s.ComputeHash(f)).Replace("-","").ToLowerInvariant(); }
 static void Main() { var listener=new HttpListener(); listener.Prefixes.Add("http://127.0.0.1:18992/"); listener.Start(); for (;;) { var c=listener.GetContext(); if(c.Request.IsWebSocketRequest) { var ws=c.AcceptWebSocketAsync(null).Result.WebSocket; var b=new byte[8192]; try { ws.ReceiveAsync(new ArraySegment<byte>(b),CancellationToken.None).Wait(); var ready="{\"protocol\":\"vem.vision.v1\",\"type\":\"vision.ready\",\"messageId\":\"fixture-ready\",\"timestamp\":\"2026-01-01T00:00:00.000Z\",\"payload\":{\"serverName\":\"signed-fixture\",\"serverVersion\":\"1.0.0\",\"cameraReady\":true,\"modelReady\":true,\"capabilities\":[]}}"; var rb=Encoding.UTF8.GetBytes(ready); ws.SendAsync(new ArraySegment<byte>(rb),WebSocketMessageType.Text,true,CancellationToken.None).Wait(); try { ws.ReceiveAsync(new ArraySegment<byte>(b),CancellationToken.None).Wait(); } catch {} } finally { ws.Dispose(); } continue; } var body="{\"status\":\"ok\",\"module\":\"vision\",\"protocol\":\"vem.vision.v1\",\"version\":\"1.0.0\",\"mockScenario\":\"off\",\"cameraReady\":true,\"modelReady\":true}"; var bytes=Encoding.UTF8.GetBytes(body); c.Response.StatusCode=200; c.Response.OutputStream.Write(bytes,0,bytes.Length); c.Response.Close(); } }
}
'@
  $runtimeSourcePath = Join-Path $root "VisionFixture.cs"
  $runtimePath = Join-Path $root "runtime.exe"
  Write-Utf8 $runtimeSourcePath $runtimeSource
  $certificateExportPath = Join-Path $root "fixture-signing-root.cer"
  $harnessContext.runtimePath = $runtimePath
  $harnessContext.certificateExportPath = $certificateExportPath
  Write-Json $harnessContextPath $harnessContext
  Invoke-BoundedPowerShell -Stage "fixture.compile-runtime" -TimeoutSeconds 30 -CleanupReserveSeconds $CleanupReserveSeconds -HarnessRoot $root -HarnessContextPath $harnessContextPath -ChildPowerShellPath $assetPowerShellPath -HarnessDeadlineUtc $harnessDeadlineUtc -ScriptBody @'
$csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
& $csc /nologo /target:exe ("/out:{0}" -f $context.runtimePath) (Join-Path $context.root "VisionFixture.cs")
if ($LASTEXITCODE -ne 0) { throw "fixture runtime compilation failed" }
'@ | Out-Null
  $certificateResultPath = Join-Path $root "certificate.json"
  Invoke-BoundedPowerShell -Stage "fixture.create-certificate" -TimeoutSeconds 30 -CleanupReserveSeconds $CleanupReserveSeconds -HarnessRoot $root -HarnessContextPath $harnessContextPath -ChildPowerShellPath $assetPowerShellPath -HarnessDeadlineUtc $harnessDeadlineUtc -ScriptBody @'
$certificate = New-SelfSignedCertificate -Type CodeSigningCert -Subject $context.certificateSubject -KeyUsage DigitalSignature -HashAlgorithm SHA256 -CertStoreLocation "Cert:\CurrentUser\My"
[IO.File]::WriteAllText((Join-Path $context.root "certificate.json"), (@{thumbprint=$certificate.Thumbprint;psPath=$certificate.PSPath}|ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
'@ | Out-Null
  $certificate = Get-Content -LiteralPath $certificateResultPath -Raw | ConvertFrom-Json
  Assert-True (-not [string]::IsNullOrWhiteSpace([string]$certificate.thumbprint)) "fixture certificate creation returned no thumbprint"
  $harnessContext.certificateThumbprint = [string]$certificate.thumbprint
  Write-Json $certificateCleanupMarkerPath @{ schemaVersion="vem-vision-harness-certificate-cleanup/v1"; certificateSubject=$certificateSubject; certificateThumbprint=[string]$certificate.thumbprint }
  Write-Json $harnessContextPath $harnessContext
  Invoke-BoundedPowerShell -Stage "fixture.export-certificate" -TimeoutSeconds 30 -CleanupReserveSeconds $CleanupReserveSeconds -HarnessRoot $root -HarnessContextPath $harnessContextPath -ChildPowerShellPath $assetPowerShellPath -HarnessDeadlineUtc $harnessDeadlineUtc -ScriptBody @'
$certificate = Get-Item -LiteralPath ("Cert:\CurrentUser\My\{0}" -f $context.certificateThumbprint)
Export-Certificate -Cert $certificate -FilePath $context.certificateExportPath -Force | Out-Null
'@ | Out-Null
  Invoke-BoundedPowerShell -Stage "fixture.trust-root" -TimeoutSeconds 30 -CleanupReserveSeconds $CleanupReserveSeconds -HarnessRoot $root -HarnessContextPath $harnessContextPath -ChildPowerShellPath $assetPowerShellPath -HarnessDeadlineUtc $harnessDeadlineUtc -ScriptBody @'
$certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new($context.certificateExportPath)
$store = [Security.Cryptography.X509Certificates.X509Store]::new("Root", "LocalMachine")
try {
  $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
  $store.Add($certificate)
} finally {
  $store.Dispose()
  $certificate.Dispose()
}
'@ | Out-Null
  $signatureResultPath = Join-Path $root "signature.json"
  Invoke-BoundedPowerShell -Stage "fixture.sign-runtime" -TimeoutSeconds 30 -CleanupReserveSeconds $CleanupReserveSeconds -HarnessRoot $root -HarnessContextPath $harnessContextPath -ChildPowerShellPath $assetPowerShellPath -HarnessDeadlineUtc $harnessDeadlineUtc -ScriptBody @'
$certificate = Get-Item -LiteralPath ("Cert:\CurrentUser\My\{0}" -f $context.certificateThumbprint)
$signature = Set-AuthenticodeSignature -FilePath $context.runtimePath -Certificate $certificate -HashAlgorithm SHA256
[IO.File]::WriteAllText((Join-Path $context.root "signature.json"), (@{status=[string]$signature.Status;statusMessage=[string]$signature.StatusMessage}|ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
'@ | Out-Null
  $signature = Get-Content -LiteralPath $signatureResultPath -Raw | ConvertFrom-Json
  $verificationResultPath = Join-Path $root "verification.json"
  Invoke-BoundedPowerShell -Stage "fixture.verify-authenticode" -TimeoutSeconds 30 -CleanupReserveSeconds $CleanupReserveSeconds -HarnessRoot $root -HarnessContextPath $harnessContextPath -ChildPowerShellPath $assetPowerShellPath -HarnessDeadlineUtc $harnessDeadlineUtc -ScriptBody @'
$verification = Get-AuthenticodeSignature -FilePath $context.runtimePath
$chain = [Security.Cryptography.X509Certificates.X509Chain]::new()
$chain.ChainPolicy.RevocationMode = [Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck
$localChainValid = $null -ne $verification.SignerCertificate -and $chain.Build($verification.SignerCertificate)
[IO.File]::WriteAllText((Join-Path $context.root "verification.json"), (@{status=[string]$verification.Status;statusMessage=[string]$verification.StatusMessage;localChainValid=$localChainValid}|ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
'@ | Out-Null
  $verification = Get-Content -LiteralPath $verificationResultPath -Raw | ConvertFrom-Json
  Write-Host "fixture Authenticode status: sign=$($signature.status); verify=$($verification.status); signerThumbprint=$($certificate.thumbprint)"
  Assert-True ($signature.status -eq "Valid") "fixture runtime signing status was $($signature.status): $($signature.statusMessage)"
  Assert-True ($verification.status -eq "Valid") "fixture runtime verification status was $($verification.status): $($verification.statusMessage)"
  Assert-True ($verification.localChainValid -eq $true) "fixture runtime certificate chain did not validate from local trust"

  Invoke-BoundedPowerShell -Stage "fixture.assemble-release" -TimeoutSeconds 30 -CleanupReserveSeconds $CleanupReserveSeconds -HarnessRoot $root -HarnessContextPath $harnessContextPath -ChildPowerShellPath $assetPowerShellPath -HarnessDeadlineUtc $harnessDeadlineUtc -ScriptBody @'
$release = Join-Path $context.root "release"
New-Item -ItemType Directory -Force -Path $release | Out-Null
Copy-Item -LiteralPath $context.runtimePath -Destination (Join-Path $release "runtime.exe")
$bundle = Join-Path $context.delivery "bundle.bin"
Compress-Archive -Path (Join-Path $release "*") -DestinationPath $bundle
Copy-Item -LiteralPath $bundle -Destination (Join-Path $context.root "approved-bundle.bin")
$bundleDigest = Get-Digest $bundle
Write-Json (Join-Path $context.delivery "sbom.json") @{ format="spdx"; fixture=$true }
Write-Json (Join-Path $context.delivery "provenance.json") @{ predicate="fixture"; fixture=$true }
$sbomDigest = Get-Digest (Join-Path $context.delivery "sbom.json")
$provenanceDigest = Get-Digest (Join-Path $context.delivery "provenance.json")
$descriptorIdentity = "sha256:" + ("d" * 64)
$signer = "spki-sha256:" + ("a" * 64)
$descriptor = [ordered]@{ schemaVersion="vem-vision-release-descriptor/v1"; kind="vision-release-descriptor"; identity=$descriptorIdentity; releaseVersion="1.0.0"; bundle=[ordered]@{ digest=$bundleDigest; bytes=(Get-Item $bundle).Length; platform=@{os="windows";architecture="x86_64"};format="zip";extractor=@{contractVersion="vem-vision-extractor/v1";handler="zip-safe-v1"} }; entrypoint=@{command="runtime.exe";arguments=@()}; lifecycle=@{requiresInteractiveSession=$true;shutdownTimeoutMs=5000}; configuration=@{format="json";schemaVersion="fixture/v1";argument="--config"}; health=@{port=18992;path="/health";expectedStatus=200;timeoutMs=15000}; protocol=@{version="vem.vision.v1";webSocketPath="/ws"}; sbom=@{identity=(Evidence-Identity $sbomDigest);digest=$sbomDigest;format="spdx-json"}; provenance=@{identity=(Evidence-Identity $provenanceDigest);digest=$provenanceDigest;predicateType="https://slsa.dev/provenance/v1"} }
Write-Json (Join-Path $context.delivery "descriptor.json") $descriptor
$attestation = @{ schemaVersion="vem-vision-artifact-attestation/v1";kind="vision-artifact-attestation";bundleDigest=$bundleDigest;descriptorDigest=$descriptorIdentity;sbomDigest=$sbomDigest;provenanceDigest=$provenanceDigest;signerIdentity=$signer }
Write-Json (Join-Path $context.delivery "attestation.json") $attestation
$attestationDigest = Get-Digest (Join-Path $context.delivery "attestation.json")
$conformance = @{ schemaVersion="vem-vision-conformance/v1";kind="vision-release-conformance";bundleDigest=$bundleDigest;descriptorDigest=$descriptorIdentity;protocolVersion="vem.vision.v1" }
Write-Json (Join-Path $context.delivery "conformance.json") $conformance
$conformanceDigest = Get-Digest (Join-Path $context.delivery "conformance.json")
$approval = @{ schemaVersion="vem-vision-release-approval/v1";kind="vision-release-approval";identity=("sha256:" + ("e" * 64));releaseVersion="1.0.0";bundleDigest=$bundleDigest;descriptorDigest=$descriptorIdentity;attestationDigest=$attestationDigest;conformanceEvidenceDigest=$conformanceDigest;approverIdentity="vem-release-approval:ci" }
Write-Json (Join-Path $context.delivery "approval.json") $approval
$approvalDigest = Get-Digest (Join-Path $context.delivery "approval.json")
$factoryManifest = @{ assets=@(@{role="vision-release";digest=$bundleDigest;version="1.0.0";release=@{descriptorIdentity=(Evidence-Identity $descriptorIdentity);descriptorDigest=$descriptorIdentity;attestationIdentity=(Evidence-Identity $attestationDigest);attestationDigest=$attestationDigest;approvalIdentity=(Evidence-Identity $approvalDigest);approvalDigest=$approvalDigest;conformanceEvidenceIdentity=(Evidence-Identity $conformanceDigest);conformanceEvidenceDigest=$conformanceDigest}}) }
Write-Json (Join-Path $context.delivery "factory-manifest.json") $factoryManifest
Write-Json (Join-Path $context.root "release-context.json") @{ bundleDigest=$bundleDigest; signer=$signer }
'@ | Out-Null
  Invoke-BoundedPowerShell -Stage "fixture.compile-verifier" -TimeoutSeconds 30 -CleanupReserveSeconds $CleanupReserveSeconds -HarnessRoot $root -HarnessContextPath $harnessContextPath -ChildPowerShellPath $assetPowerShellPath -HarnessDeadlineUtc $harnessDeadlineUtc -ScriptBody @'
$releaseContext = Get-Content -LiteralPath (Join-Path $context.root "release-context.json") -Raw | ConvertFrom-Json
$signer = [string]$releaseContext.signer
$verifierSource = @"
using System; class V { static void Main(){ Console.Write("{\"schemaVersion\":\"vem-vision-release-verification/v1\",\"kind\":\"vision-release-verification\",\"verified\":true,\"identities\":{\"descriptor\":\"$signer\",\"attestation\":\"$signer\",\"sbom\":\"$signer\",\"provenance\":\"$signer\",\"conformance\":\"$signer\",\"approval\":\"$signer\"}}"); }}
"@
$verifierPath = Join-Path $context.trust "vision-release-verifier.exe"
Write-Utf8 (Join-Path $context.root "Verifier.cs") $verifierSource
$csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
& $csc /nologo /target:exe ("/out:{0}" -f $verifierPath) (Join-Path $context.root "Verifier.cs")
if ($LASTEXITCODE -ne 0) { throw "fixture verifier compilation failed" }
$verifierDigest = Get-Digest $verifierPath
$policy = @{ schemaVersion="vem-vision-release-trust-policy/v1";kind="vision-release-trust-policy";verifierDigest=$verifierDigest;approvedIdentities=@{descriptor=@($signer);attestation=@($signer);sbom=@($signer);provenance=@($signer);conformance=@($signer);approval=@($signer)} }
Write-Json (Join-Path $context.trust "vision-release-trust-policy.json") $policy
$policyDigest = Get-Digest (Join-Path $context.trust "vision-release-trust-policy.json")
Write-Json (Join-Path $context.trust "vision-release-trust-anchor.json") @{schemaVersion="vem-factory-vision-trust-anchor/v1";kind="factory-vision-trust-anchor";trustPolicyDigest=$policyDigest;verifierDigest=$verifierDigest}
'@ | Out-Null
  $bundleDigest = (Get-Content -LiteralPath (Join-Path $root "release-context.json") -Raw | ConvertFrom-Json).bundleDigest
  $harnessContext.bundleDigest = $bundleDigest
  Write-Json $harnessContextPath $harnessContext
  foreach ($corePowerShellPath in $corePowerShellPaths) {
    $corePowerShellName = [IO.Path]::GetFileNameWithoutExtension($corePowerShellPath).ToLowerInvariant()
    $provisionDiagnosticPath = Join-Path $root "provision-error.txt"
    Remove-Item -LiteralPath $provisionDiagnosticPath -Force -ErrorAction SilentlyContinue
    try {
      Invoke-BoundedPowerShell -Stage "fixture.provision.$corePowerShellName" -TimeoutSeconds 45 -CleanupReserveSeconds $CleanupReserveSeconds -HarnessRoot $root -HarnessContextPath $harnessContextPath -ChildPowerShellPath $corePowerShellPath -HarnessDeadlineUtc $harnessDeadlineUtc -ScriptBody @'
try {
Copy-Item -LiteralPath $context.installerPath -Destination (Join-Path $context.installerMedia "install-vision-release.ps1")
Copy-Item -LiteralPath (Join-Path (Split-Path -Parent $context.installerPath) "vision-release-materialization.psm1") -Destination (Join-Path $context.installerMedia "vision-release-materialization.psm1")
Copy-Item -LiteralPath (Join-Path (Split-Path -Parent $context.installerPath) "vision-diagnostic-redaction.psm1") -Destination (Join-Path $context.installerMedia "vision-diagnostic-redaction.psm1")
Copy-Item -LiteralPath (Join-Path (Split-Path -Parent $context.installerPath) "provision-vision-factory-release.ps1") -Destination (Join-Path $context.installerMedia "provision-vision-factory-release.ps1")
$provisioningManifestPath = Join-Path $context.visionMediaRoot "VISION-FACTORY-PROVISIONING.JSON"
$files = @{}; Get-ChildItem -LiteralPath $context.visionMediaRoot -Recurse -File | Where-Object { $_.FullName -ine $provisioningManifestPath } | ForEach-Object { $relative=$_.FullName.Substring($context.visionMediaRoot.Length+1).Replace("\","/"); $files[$relative]=Get-Digest $_.FullName }
Write-Json $provisioningManifestPath @{schemaVersion="vem-vision-factory-provisioning/v1";kind="vision-factory-provisioning";files=$files}
  $wrongParentFailed = $false
  try {
  & (Join-Path $context.installerMedia "provision-vision-factory-release.ps1") -FactoryMediaRoot $context.media
  } catch {
    $wrongParentFailed = $true
  }
  Assert-True $wrongParentFailed "Vision provisioner accepted the Factory Media parent instead of the VEM root"
& (Join-Path $context.installerMedia "provision-vision-factory-release.ps1") -FactoryMediaRoot $context.visionMediaRoot
New-Item -ItemType Directory -Force -Path (Join-Path $context.stateRoot "config") | Out-Null
Write-Utf8 (Join-Path $context.stateRoot "config\fixture.json") "{}"
} catch {
  [IO.File]::WriteAllText((Join-Path $context.root "provision-error.txt"), ($_ | Out-String), [Text.UTF8Encoding]::new($false))
  throw
}
'@ | Out-Null
    } catch {
      if (Test-Path -LiteralPath $provisionDiagnosticPath -PathType Leaf) {
        throw "fixture provisioning failed under ${corePowerShellName}: $(Get-Content -LiteralPath $provisionDiagnosticPath -Raw)"
      }
      throw
    }
    $signedInstallDiagnosticPath = Join-Path $root "signed-install-error.txt"
    Remove-Item -LiteralPath $signedInstallDiagnosticPath -Force -ErrorAction SilentlyContinue
    try {
      Invoke-BoundedPowerShell -Stage "fixture.signed-install.$corePowerShellName" -TimeoutSeconds 45 -CleanupReserveSeconds $CleanupReserveSeconds -HarnessRoot $root -HarnessContextPath $harnessContextPath -ChildPowerShellPath $corePowerShellPath -HarnessDeadlineUtc $harnessDeadlineUtc -ScriptBody @'
try {
$factoryDelivery = Join-Path $context.factoryRoot "vision-release"
& "C:\VEM\bringup\install-vision-release.ps1" -BundlePath (Join-Path $factoryDelivery "bundle.bin") -DescriptorPath (Join-Path $factoryDelivery "descriptor.json") -AttestationPath (Join-Path $factoryDelivery "attestation.json") -SbomPath (Join-Path $factoryDelivery "sbom.json") -ProvenancePath (Join-Path $factoryDelivery "provenance.json") -ConformanceEvidencePath (Join-Path $factoryDelivery "conformance.json") -ApprovalPath (Join-Path $factoryDelivery "approval.json") -FactoryManifestPath (Join-Path $factoryDelivery "factory-manifest.json") -ConfigurationPath (Join-Path $context.stateRoot "config\fixture.json") -EvidencePath $context.evidencePath -TaskUser $env:USERNAME
$evidence = Get-Content -LiteralPath $context.evidencePath -Raw | ConvertFrom-Json
Assert-True ($evidence.healthOk -and $evidence.webSocketOk -and $evidence.installedDigest -eq $context.bundleDigest) "signed install did not reach approved runtime"
Assert-True (Test-Path -LiteralPath "C:\ProgramData\VEM\vision\current.json") "selection missing after signed install"
Assert-True ($null -ne (Get-ScheduledTask -TaskName "StartVisionServer" -TaskPath "\VEM\" -ErrorAction SilentlyContinue)) "Vision task missing"
$acl = Get-Acl -LiteralPath "C:\ProgramData\VEM\vision\current.json"
Assert-True ($acl.AreAccessRulesProtected) "selection ACL is not protected"
$system = [Security.Principal.SecurityIdentifier]::new("S-1-5-18")
$administrators = [Security.Principal.SecurityIdentifier]::new("S-1-5-32-544")
$kiosk = (Get-LocalUser -Name "VEMKiosk" -ErrorAction Stop).SID
Assert-True ($acl.Owner.Translate([Security.Principal.SecurityIdentifier]).Value -ceq $system.Value) "selection ACL owner is not LocalSystem"
$expectedRules = @(
  [Security.AccessControl.FileSystemAccessRule]::new($system, "FullControl", "None", "None", "Allow"),
  [Security.AccessControl.FileSystemAccessRule]::new($administrators, "FullControl", "None", "None", "Allow"),
  [Security.AccessControl.FileSystemAccessRule]::new($kiosk, "ReadAndExecute", "None", "None", "Allow")
)
$expectedAcl = @($expectedRules | ForEach-Object { "{0}|{1}|{2}|{3}|{4}" -f $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value, [int]$_.FileSystemRights, $_.AccessControlType, $_.InheritanceFlags, $_.PropagationFlags } | Sort-Object)
$actualAcl = @($acl.Access | Where-Object { -not $_.IsInherited } | ForEach-Object { "{0}|{1}|{2}|{3}|{4}" -f $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value, [int]$_.FileSystemRights, $_.AccessControlType, $_.InheritanceFlags, $_.PropagationFlags } | Sort-Object)
Assert-True (@($actualAcl).Count -eq @($expectedAcl).Count -and $null -eq (Compare-Object -ReferenceObject $expectedAcl -DifferenceObject $actualAcl)) "selection ACL does not contain exactly the LocalSystem, Administrators, and kiosk ACEs"
} catch {
  [IO.File]::WriteAllText((Join-Path $context.root "signed-install-error.txt"), ($_ | Out-String), [Text.UTF8Encoding]::new($false))
  throw
}
'@ | Out-Null
    } catch {
      if (Test-Path -LiteralPath $signedInstallDiagnosticPath -PathType Leaf) {
        throw "fixture signed install failed under ${corePowerShellName}: $(Get-Content -LiteralPath $signedInstallDiagnosticPath -Raw)"
      }
      throw
    }
    $rollbackDiagnosticPath = Join-Path $root "rollback-reinstall-error.txt"
    Remove-Item -LiteralPath $rollbackDiagnosticPath -Force -ErrorAction SilentlyContinue
    try {
      Invoke-BoundedPowerShell -Stage "fixture.rollback-reinstall.$corePowerShellName" -TimeoutSeconds 45 -CleanupReserveSeconds $CleanupReserveSeconds -HarnessRoot $root -HarnessContextPath $harnessContextPath -ChildPowerShellPath $corePowerShellPath -HarnessDeadlineUtc $harnessDeadlineUtc -ScriptBody @'
try {
$factoryRoot = $context.factoryRoot
$stateRoot = $context.stateRoot
$evidencePath = $context.evidencePath
$bundleDigest = $context.bundleDigest
$descriptor = Get-Content -LiteralPath (Join-Path $factoryRoot "vision-release\descriptor.json") -Raw | ConvertFrom-Json
$attestation = Get-Content -LiteralPath (Join-Path $factoryRoot "vision-release\attestation.json") -Raw | ConvertFrom-Json
$conformance = Get-Content -LiteralPath (Join-Path $factoryRoot "vision-release\conformance.json") -Raw | ConvertFrom-Json
$approval = Get-Content -LiteralPath (Join-Path $factoryRoot "vision-release\approval.json") -Raw | ConvertFrom-Json
$factoryManifest = Get-Content -LiteralPath (Join-Path $factoryRoot "vision-release\factory-manifest.json") -Raw | ConvertFrom-Json
$originalBundle = Join-Path $context.root "approved-bundle.bin"
  # A newly staged release with a bad health endpoint must roll back to the
  # prior approved selection, rather than leaving the machine unbound.
  $badDescriptor = $descriptor | ConvertTo-Json -Depth 32 | ConvertFrom-Json
  $badDescriptor.releaseVersion = "1.0.1"; $badDescriptor.identity = "sha256:" + ("f" * 64); $badDescriptor.health.port = 18993
  $badAttestation = $attestation | ConvertTo-Json -Depth 32 | ConvertFrom-Json; $badAttestation.descriptorDigest = $badDescriptor.identity
  $badConformance = $conformance | ConvertTo-Json -Depth 32 | ConvertFrom-Json; $badConformance.descriptorDigest = $badDescriptor.identity
  Write-Json (Join-Path $factoryRoot "vision-release\descriptor.json") $badDescriptor
  Write-Json (Join-Path $factoryRoot "vision-release\attestation.json") $badAttestation
  Write-Json (Join-Path $factoryRoot "vision-release\conformance.json") $badConformance
  $badAttestationDigest = Get-Digest (Join-Path $factoryRoot "vision-release\attestation.json")
  $badConformanceDigest = Get-Digest (Join-Path $factoryRoot "vision-release\conformance.json")
  $badApproval = $approval | ConvertTo-Json -Depth 32 | ConvertFrom-Json; $badApproval.releaseVersion = "1.0.1"; $badApproval.descriptorDigest = $badDescriptor.identity; $badApproval.attestationDigest = $badAttestationDigest; $badApproval.conformanceEvidenceDigest = $badConformanceDigest
  Write-Json (Join-Path $factoryRoot "vision-release\approval.json") $badApproval
  $badApprovalDigest = Get-Digest (Join-Path $factoryRoot "vision-release\approval.json")
  Write-Json (Join-Path $factoryRoot "vision-release\factory-manifest.json") @{ assets=@(@{role="vision-release";digest=$bundleDigest;version="1.0.1";release=@{descriptorIdentity=(Evidence-Identity $badDescriptor.identity);descriptorDigest=$badDescriptor.identity;attestationIdentity=(Evidence-Identity $badAttestationDigest);attestationDigest=$badAttestationDigest;approvalIdentity=(Evidence-Identity $badApprovalDigest);approvalDigest=$badApprovalDigest;conformanceEvidenceIdentity=(Evidence-Identity $badConformanceDigest);conformanceEvidenceDigest=$badConformanceDigest}}) }
  $rollbackFailed = $false
  $rollbackError = ""
  try { & "C:\VEM\bringup\install-vision-release.ps1" -BundlePath (Join-Path $factoryRoot "vision-release\bundle.bin") -DescriptorPath (Join-Path $factoryRoot "vision-release\descriptor.json") -AttestationPath (Join-Path $factoryRoot "vision-release\attestation.json") -SbomPath (Join-Path $factoryRoot "vision-release\sbom.json") -ProvenancePath (Join-Path $factoryRoot "vision-release\provenance.json") -ConformanceEvidencePath (Join-Path $factoryRoot "vision-release\conformance.json") -ApprovalPath (Join-Path $factoryRoot "vision-release\approval.json") -FactoryManifestPath (Join-Path $factoryRoot "vision-release\factory-manifest.json") -ConfigurationPath (Join-Path $stateRoot "config\fixture.json") -EvidencePath $evidencePath -TaskUser $env:USERNAME } catch { $rollbackFailed = $true; $rollbackError = $_ | Out-String }
  $rollbackEvidence = Get-Content -LiteralPath $evidencePath -Raw | ConvertFrom-Json
  Assert-True ($rollbackFailed -and $rollbackEvidence.rollbackAttempted -and $rollbackEvidence.rollbackOk) "failed activation did not roll back: error=$rollbackError evidence=$($rollbackEvidence | ConvertTo-Json -Compress)"
  Assert-True (((Get-Content -LiteralPath "C:\ProgramData\VEM\vision\current.json" -Raw | ConvertFrom-Json).bundleDigest -eq $bundleDigest)) "rollback did not restore prior selection"
  Write-Json (Join-Path $factoryRoot "vision-release\descriptor.json") $descriptor; Write-Json (Join-Path $factoryRoot "vision-release\attestation.json") $attestation; Write-Json (Join-Path $factoryRoot "vision-release\conformance.json") $conformance; Write-Json (Join-Path $factoryRoot "vision-release\approval.json") $approval; Write-Json (Join-Path $factoryRoot "vision-release\factory-manifest.json") $factoryManifest
  # An orphan directory for a newly selected digest is quarantined before the
  # installer can activate it. The intentionally malformed bundle is safe here:
  # orphan rejection must happen before extraction.
  $orphanBundle = Join-Path $factoryRoot "vision-release\bundle.bin"; Copy-Item -LiteralPath $originalBundle -Destination $orphanBundle -Force; $append = [IO.File]::Open($orphanBundle, [IO.FileMode]::Append); try { $append.WriteByte(0) } finally { $append.Dispose() }
  $orphanDigest = Get-Digest $orphanBundle; $orphanDescriptor = $descriptor | ConvertTo-Json -Depth 32 | ConvertFrom-Json; $orphanDescriptor.releaseVersion="1.0.2"; $orphanDescriptor.identity="sha256:" + ("c" * 64); $orphanDescriptor.bundle.digest=$orphanDigest; $orphanDescriptor.bundle.bytes=(Get-Item $orphanBundle).Length
  $orphanAttestation = $attestation | ConvertTo-Json -Depth 32 | ConvertFrom-Json; $orphanAttestation.bundleDigest=$orphanDigest; $orphanAttestation.descriptorDigest=$orphanDescriptor.identity; $orphanConformance = $conformance | ConvertTo-Json -Depth 32 | ConvertFrom-Json; $orphanConformance.bundleDigest=$orphanDigest; $orphanConformance.descriptorDigest=$orphanDescriptor.identity
  Write-Json (Join-Path $factoryRoot "vision-release\descriptor.json") $orphanDescriptor; Write-Json (Join-Path $factoryRoot "vision-release\attestation.json") $orphanAttestation; Write-Json (Join-Path $factoryRoot "vision-release\conformance.json") $orphanConformance
  $orphanApproval = $approval | ConvertTo-Json -Depth 32 | ConvertFrom-Json; $orphanApproval.releaseVersion="1.0.2"; $orphanApproval.bundleDigest=$orphanDigest; $orphanApproval.descriptorDigest=$orphanDescriptor.identity; $orphanApproval.attestationDigest=Get-Digest (Join-Path $factoryRoot "vision-release\attestation.json"); $orphanApproval.conformanceEvidenceDigest=Get-Digest (Join-Path $factoryRoot "vision-release\conformance.json"); Write-Json (Join-Path $factoryRoot "vision-release\approval.json") $orphanApproval; $orphanApprovalDigest=Get-Digest (Join-Path $factoryRoot "vision-release\approval.json")
  Write-Json (Join-Path $factoryRoot "vision-release\factory-manifest.json") @{ assets=@(@{role="vision-release";digest=$orphanDigest;version="1.0.2";release=@{descriptorIdentity=(Evidence-Identity $orphanDescriptor.identity);descriptorDigest=$orphanDescriptor.identity;attestationIdentity=(Evidence-Identity (Get-Digest (Join-Path $factoryRoot "vision-release\attestation.json")));attestationDigest=(Get-Digest (Join-Path $factoryRoot "vision-release\attestation.json"));approvalIdentity=(Evidence-Identity $orphanApprovalDigest);approvalDigest=$orphanApprovalDigest;conformanceEvidenceIdentity=(Evidence-Identity (Get-Digest (Join-Path $factoryRoot "vision-release\conformance.json")));conformanceEvidenceDigest=(Get-Digest (Join-Path $factoryRoot "vision-release\conformance.json"))}}) }
  $orphanPath = Join-Path "C:\VEM\vision\releases" ("1.0.2-" + $orphanDigest.Substring(7,16)); New-Item -ItemType Directory -Force -Path $orphanPath | Out-Null; Write-Utf8 (Join-Path $orphanPath "runtime.exe") "orphan"
  $orphanRejected=$false; try { & "C:\VEM\bringup\install-vision-release.ps1" -BundlePath $orphanBundle -DescriptorPath (Join-Path $factoryRoot "vision-release\descriptor.json") -AttestationPath (Join-Path $factoryRoot "vision-release\attestation.json") -SbomPath (Join-Path $factoryRoot "vision-release\sbom.json") -ProvenancePath (Join-Path $factoryRoot "vision-release\provenance.json") -ConformanceEvidencePath (Join-Path $factoryRoot "vision-release\conformance.json") -ApprovalPath (Join-Path $factoryRoot "vision-release\approval.json") -FactoryManifestPath (Join-Path $factoryRoot "vision-release\factory-manifest.json") -ConfigurationPath (Join-Path $stateRoot "config\fixture.json") -EvidencePath $evidencePath -TaskUser $env:USERNAME } catch { $orphanRejected=$true }
  Assert-True ($orphanRejected -and -not (Test-Path -LiteralPath $orphanPath) -and (Test-Path -LiteralPath (Join-Path $stateRoot "quarantine"))) "orphan release was not quarantined"
  Copy-Item -LiteralPath $originalBundle -Destination $orphanBundle -Force; Write-Json (Join-Path $factoryRoot "vision-release\descriptor.json") $descriptor; Write-Json (Join-Path $factoryRoot "vision-release\attestation.json") $attestation; Write-Json (Join-Path $factoryRoot "vision-release\conformance.json") $conformance; Write-Json (Join-Path $factoryRoot "vision-release\approval.json") $approval; Write-Json (Join-Path $factoryRoot "vision-release\factory-manifest.json") $factoryManifest
  # Idempotent reinstall must preserve the approved immutable release and keep
  # the task-managed runtime healthy.
  & "C:\VEM\bringup\install-vision-release.ps1" -BundlePath (Join-Path $factoryRoot "vision-release\bundle.bin") -DescriptorPath (Join-Path $factoryRoot "vision-release\descriptor.json") -AttestationPath (Join-Path $factoryRoot "vision-release\attestation.json") -SbomPath (Join-Path $factoryRoot "vision-release\sbom.json") -ProvenancePath (Join-Path $factoryRoot "vision-release\provenance.json") -ConformanceEvidencePath (Join-Path $factoryRoot "vision-release\conformance.json") -ApprovalPath (Join-Path $factoryRoot "vision-release\approval.json") -FactoryManifestPath (Join-Path $factoryRoot "vision-release\factory-manifest.json") -ConfigurationPath (Join-Path $stateRoot "config\fixture.json") -EvidencePath $evidencePath -TaskUser $env:USERNAME
  $reinstalled = Get-Content -LiteralPath "C:\ProgramData\VEM\vision\current.json" -Raw | ConvertFrom-Json
  Assert-True ($reinstalled.bundleDigest -eq $bundleDigest) "idempotent reinstall changed the selected digest"
} catch {
  [IO.File]::WriteAllText((Join-Path $context.root "rollback-reinstall-error.txt"), ($_ | Out-String), [Text.UTF8Encoding]::new($false))
  throw
}
'@ | Out-Null
    } catch {
      if (Test-Path -LiteralPath $rollbackDiagnosticPath -PathType Leaf) {
        throw "fixture rollback/reinstall failed under ${corePowerShellName}: $(Get-Content -LiteralPath $rollbackDiagnosticPath -Raw)"
      }
      throw
    }
  }

  $runtimeDiagnosticPath = Join-Path $root "process-mutex-runtime-error.txt"
  try {
    Invoke-BoundedPowerShell -Stage "fixture.process-mutex-runtime" -TimeoutSeconds 45 -CleanupReserveSeconds $CleanupReserveSeconds -HarnessRoot $root -HarnessContextPath $harnessContextPath -ChildPowerShellPath $assetPowerShellPath -HarnessDeadlineUtc $harnessDeadlineUtc -ScriptBody @'
try {
  $factoryRoot = $context.factoryRoot
  $stateRoot = $context.stateRoot
  $evidencePath = $context.evidencePath
  $bundleDigest = $context.bundleDigest
  $reinstalled = Get-Content -LiteralPath "C:\ProgramData\VEM\vision\current.json" -Raw | ConvertFrom-Json
  # A forged process record must fail closed without authorizing termination of
  # an unrelated process. Restore the retained trusted record before continuing.
  $victim = Start-Process -FilePath "$env:WINDIR\System32\cmd.exe" -ArgumentList "/c", "timeout /t 60 /nobreak" -PassThru
  $forged = @{ bundleDigest=$bundleDigest; processId=$victim.Id; creationTimeUtcTicks=$victim.StartTime.ToUniversalTime().Ticks; executablePath=$victim.Path; executableDigest=("sha256:" + ("0" * 64)); selectionRevision=$reinstalled.revision }
  $processRecordPath = Join-Path $stateRoot "process-state\active-process.json"
  $trustedProcessRecord = Get-Content -LiteralPath $processRecordPath -Raw
  Write-Json $processRecordPath $forged
  $forgedRejected = $false
  try { & "C:\VEM\bringup\install-vision-release.ps1" -BundlePath (Join-Path $factoryRoot "vision-release\bundle.bin") -DescriptorPath (Join-Path $factoryRoot "vision-release\descriptor.json") -AttestationPath (Join-Path $factoryRoot "vision-release\attestation.json") -SbomPath (Join-Path $factoryRoot "vision-release\sbom.json") -ProvenancePath (Join-Path $factoryRoot "vision-release\provenance.json") -ConformanceEvidencePath (Join-Path $factoryRoot "vision-release\conformance.json") -ApprovalPath (Join-Path $factoryRoot "vision-release\approval.json") -FactoryManifestPath (Join-Path $factoryRoot "vision-release\factory-manifest.json") -ConfigurationPath (Join-Path $stateRoot "config\fixture.json") -EvidencePath $evidencePath -TaskUser $env:USERNAME } catch { $forgedRejected = $true }
  Assert-True ($forgedRejected -and -not $victim.HasExited) "forged process record did not fail closed"
  Write-Utf8 $processRecordPath $trustedProcessRecord
  $victim | Stop-Process -Force

  # Hold the named mutex from a second process long enough to prove that a
  # concurrent production installation waits rather than racing activation.
  $blockedScriptPath = Join-Path $context.root "concurrent-install.ps1"
  $blockedStdoutPath = Join-Path $context.root "concurrent-install.stdout.log"
  $blockedStderrPath = Join-Path $context.root "concurrent-install.stderr.log"
  $blockedScript = @(
    'param([string]$Installer,[string]$Factory,[string]$Configuration,[string]$Evidence,[string]$TaskUser,[string]$HarnessScriptRoot)',
    '$ErrorActionPreference = "Stop"',
    '$delivery = Join-Path $Factory "vision-release"',
    '& $Installer -BundlePath (Join-Path $delivery "bundle.bin") -DescriptorPath (Join-Path $delivery "descriptor.json") -AttestationPath (Join-Path $delivery "attestation.json") -SbomPath (Join-Path $delivery "sbom.json") -ProvenancePath (Join-Path $delivery "provenance.json") -ConformanceEvidencePath (Join-Path $delivery "conformance.json") -ApprovalPath (Join-Path $delivery "approval.json") -FactoryManifestPath (Join-Path $delivery "factory-manifest.json") -ConfigurationPath $Configuration -EvidencePath $Evidence -TaskUser $TaskUser',
    '& (Join-Path $HarnessScriptRoot "verify-vem-runtime.ps1") -RequireVisionOnline -VisionOnly'
  ) -join "`r`n"
  Write-Utf8 $blockedScriptPath $blockedScript
  function ConvertTo-HarnessCommandLineArgument([string]$Argument) {
    $escaped = [regex]::Replace($Argument, '(\\*)"', '$1$1\"')
    $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
    return '"' + $escaped + '"'
  }
  $blockedArguments = (@("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", $blockedScriptPath, $context.installerPath, $factoryRoot, (Join-Path $stateRoot "config\fixture.json"), $evidencePath, $env:USERNAME, $context.harnessScriptRoot) | ForEach-Object { ConvertTo-HarnessCommandLineArgument ([string]$_) }) -join " "
  $mutex = [Threading.Mutex]::new($false, "Global\VEMVisionReleaseInstaller")
  $blocked = $null
  $mutexAcquired = $false
  try {
    try {
      $mutexAcquired = $mutex.WaitOne([TimeSpan]::FromSeconds(5))
      Assert-True $mutexAcquired "could not acquire installer mutex"
      $blocked = Start-Process -FilePath ([string]$context.childPowerShellPath) -ArgumentList $blockedArguments -RedirectStandardOutput $blockedStdoutPath -RedirectStandardError $blockedStderrPath -PassThru
      Start-Sleep -Seconds 2
      Assert-True (-not $blocked.HasExited) "concurrent installer did not wait on mutex"
    } finally {
      if ($mutexAcquired) { $mutex.ReleaseMutex() }
      $mutex.Dispose()
    }
    Assert-True ($blocked.WaitForExit(30000)) "concurrent installer did not complete after mutex release"
    if ($blocked.ExitCode -ne 0) {
      throw "concurrent installer failed with exit code $($blocked.ExitCode): stdout=$(Get-Content -LiteralPath $blockedStdoutPath -Raw -ErrorAction SilentlyContinue) stderr=$(Get-Content -LiteralPath $blockedStderrPath -Raw -ErrorAction SilentlyContinue)"
    }
  } finally {
    if ($null -ne $blocked) {
      if (-not $blocked.HasExited) { $blocked.Kill(); $blocked.WaitForExit(5000) | Out-Null }
      $blocked.Dispose()
    }
  }
} catch {
  [IO.File]::WriteAllText((Join-Path $context.root "process-mutex-runtime-error.txt"), ($_ | Out-String), [Text.UTF8Encoding]::new($false))
  throw
}
'@ | Out-Null
  } catch {
    if (Test-Path -LiteralPath $runtimeDiagnosticPath -PathType Leaf) {
      throw "fixture process/mutex/runtime verification failed: $(Get-Content -LiteralPath $runtimeDiagnosticPath -Raw)"
    }
    throw
  }
  Write-HarnessStage "harness" "completed" "first-install task acl process-record mutex reinstall protocol runtime-verifier"
} finally {
  $cleanupFailure = $null
  if (Test-Path -LiteralPath (Join-Path $root "kiosk-account-created") -PathType Leaf) {
    try { Remove-LocalUser -Name "VEMKiosk" -ErrorAction Stop } catch { $cleanupFailure = $_ }
  }
  if (Test-Path -LiteralPath $certificateCleanupMarkerPath) {
    try {
      Invoke-BoundedPowerShell -Stage "fixture.cleanup-certificates" -TimeoutSeconds 30 -HarnessRoot $root -HarnessContextPath $harnessContextPath -ChildPowerShellPath $assetPowerShellPath -HarnessDeadlineUtc $harnessDeadlineUtc -ScriptBody 'Invoke-HarnessFixtureCleanup -Context $context' | Out-Null
    } catch {
      Write-HarnessStage "fixture.cleanup-certificates" "failed" $_.Exception.Message
      $cleanupFailure = $_
    }
  }
  try {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction Stop
  } catch {
    Write-HarnessStage "fixture.cleanup-files" "failed" $_.Exception.Message
    if ($null -eq $cleanupFailure) { $cleanupFailure = $_ }
  }
  $watchdog.Dispose()
  if ($null -ne $cleanupFailure) { throw $cleanupFailure }
}
