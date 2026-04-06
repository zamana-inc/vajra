import { spawn } from "node:child_process";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export interface CommandRunner {
  run(command: string, opts: {
    cwd: string;
    timeoutMs?: number;
    killGraceMs?: number;
    env?: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<CommandResult>;
}

export class ShellCommandRunner implements CommandRunner {
  async run(command: string, opts: {
    cwd: string;
    timeoutMs?: number;
    killGraceMs?: number;
    env?: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<CommandResult> {
    const start = Date.now();
    const killGraceMs = opts.killGraceMs ?? 5_000;
    const useProcessGroup = process.platform !== "win32";

    return new Promise<CommandResult>((resolve, reject) => {
      if (opts.signal?.aborted) {
        reject(new Error("command aborted"));
        return;
      }

      const child = spawn("sh", ["-lc", command], {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        detached: useProcessGroup,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let settled = false;
      let timeout: NodeJS.Timeout | undefined;
      let killTimer: NodeJS.Timeout | undefined;
      let pendingFailure: Error | null = null;

      const finish = (fn: () => void) => {
        if (settled) {
          return;
        }

        settled = true;

        if (timeout) {
          clearTimeout(timeout);
        }

        if (killTimer) {
          clearTimeout(killTimer);
        }

        opts.signal?.removeEventListener("abort", onAbort);
        fn();
      };

      const sendSignal = (signal: NodeJS.Signals) => {
        try {
          if (useProcessGroup && child.pid) {
            process.kill(-child.pid, signal);
            return;
          }

          child.kill(signal);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
            throw error;
          }
        }
      };

      const terminate = (error: Error) => {
        if (pendingFailure) {
          return;
        }

        pendingFailure = error;
        sendSignal("SIGTERM");

        if (killGraceMs <= 0) {
          sendSignal("SIGKILL");
          finish(() => reject(pendingFailure));
          return;
        }

        // Hold the rejection open until the grace window expires so descendant
        // processes have a chance to observe SIGTERM before the group is killed.
        killTimer = setTimeout(() => {
          sendSignal("SIGKILL");
          finish(() => reject(pendingFailure));
        }, killGraceMs);
      };

      const onAbort = () => {
        terminate(new Error("command aborted"));
      };

      if (opts.signal) {
        opts.signal.addEventListener("abort", onAbort);
      }

      if (opts.timeoutMs && opts.timeoutMs > 0) {
        timeout = setTimeout(() => {
          terminate(new Error(`command timed out after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs);
      }

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        finish(() => reject(error));
      });
      child.on("close", (exitCode) => {
        if (pendingFailure) {
          finish(() => reject(pendingFailure));
          return;
        }

        finish(() => {
          resolve({
            stdout,
            stderr,
            exitCode: exitCode ?? -1,
            durationMs: Date.now() - start,
          });
        });
      });
    });
  }
}
