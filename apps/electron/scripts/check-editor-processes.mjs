import { execFile } from "node:child_process";

function run(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true }, (_error, stdout) => resolve(stdout ?? ""));
  });
}

async function listProcesses() {
  if (process.platform === "win32") {
    const output = await run("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('electron.exe','chrome.exe','node.exe') } | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress",
    ]);
    if (!output.trim()) return [];
    const parsed = JSON.parse(output);
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  const output = await run("ps", ["-eo", "pid=,comm=,args="]);
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    const match = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
    return match ? { ProcessId: Number(match[1]), Name: match[2], CommandLine: match[3] } : null;
  }).filter(Boolean);
}

const patterns = [
  /editor-profile/i,
  /wiring-profile/i,
  /--remote-debugging-port=(9255|9258)\b/i,
  /lightee-translator[\\/]\.click-test\.js/i,
];
const processes = (await listProcesses()).filter((processInfo) => patterns.some((pattern) => pattern.test(processInfo.CommandLine ?? "")));
console.log(JSON.stringify({ trackedProcesses: processes }, null, 2));
if (processes.length > 0) process.exitCode = 1;
