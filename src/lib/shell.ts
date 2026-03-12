import { execFile } from "node:child_process";

export function runCommand(
  command: string,
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "bash",
      ["-lc", command],
      {
        cwd: options.cwd,
        env: options.env,
        maxBuffer: 10 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        if (error) {
          const decorated = new Error(
            `Command failed: ${redactSecrets(command)}\n${redactSecrets(
              stderr || stdout || error.message
            )}`.trim()
          );
          reject(decorated);
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

function redactSecrets(value: string): string {
  return value.replace(
    /https:\/\/([^:/\s]+):([^@\s]+)@/g,
    (_match, username: string) => `https://${username}:[REDACTED]@`
  );
}
