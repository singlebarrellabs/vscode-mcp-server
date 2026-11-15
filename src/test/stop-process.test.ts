import { type ChildProcess, spawn } from "node:child_process";
import { stopVSCodeProcess } from "./e2e/platform";

const describePosix = process.platform === "win32" ? describe.skip : describe;

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitUntilDead(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (groupAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function spawnDetached(script: string): ChildProcess {
  return spawn("sh", ["-c", script], { detached: true, stdio: "ignore" });
}

// A detached spawn resolves once the OS has started the process, but `sh` has
// not necessarily run the script yet. A test that depends on a trap being
// installed or on the background child existing must wait for the script to say
// so, otherwise the signal races the setup: on a loaded runner the shell can
// die before `trap` is in place, which leaves the helper running and turns the
// draining path into the slow SIGTERM/SIGKILL escalation.
function spawnDetachedWithReadiness(
  script: string,
  marker: string,
): { proc: ChildProcess; ready: Promise<void> } {
  const proc = spawn("sh", ["-c", script], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const ready = new Promise<void>((resolve, reject) => {
    let settled = false;
    let buffered = "";
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };
    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => {
      if (settled) return;
      buffered += chunk;
      if (buffered.includes(marker)) settle(resolve);
    });
    proc.once("exit", () =>
      settle(() => reject(new Error(`process exited before signalling ${marker}`))),
    );
    proc.once("error", (error) => settle(() => reject(error)));
  });
  return { proc, ready };
}

async function waitForPid(proc: ChildProcess): Promise<number> {
  if (proc.pid) return proc.pid;
  await new Promise((resolve) => proc.once("spawn", resolve));
  if (!proc.pid) throw new Error("process did not spawn");
  return proc.pid;
}

// These cases exercise grace windows measured in seconds: the draining-group
// path can legitimately spend 5s exiting, 5s draining the group, then up to 3s
// more escalating to SIGTERM and SIGKILL. vitest's 5s default aborts a run that
// is behaving exactly as designed, so each case declares a bound above the
// worst case of the window it tests.
const STOP_PROCESS_TEST_TIMEOUT_MS = 20_000;

describePosix("stopVSCodeProcess", () => {
  it(
    "returns promptly when the process already exited and its group is gone",
    async () => {
      const proc = spawnDetached("exit 0");
      const pid = await waitForPid(proc);
      await new Promise((resolve) => proc.once("exit", resolve));

      const started = Date.now();
      await stopVSCodeProcess(proc, true, 5000, 5000);
      const elapsed = Date.now() - started;

      expect(elapsed).toBeLessThan(2000);
      expect(groupAlive(pid)).toBe(false);
    },
    STOP_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "waits for a draining group instead of signalling it immediately",
    async () => {
      // The shell reaps its own child on SIGTERM, like VS Code's helper shutdown.
      const { proc, ready } = spawnDetachedWithReadiness(
        'sleep 60 & child=$!; trap "kill $child; wait $child; exit 0" TERM; echo ready; wait',
        "ready",
      );
      await ready;
      const pid = await waitForPid(proc);

      const started = Date.now();
      await stopVSCodeProcess(proc, true, 5000, 5000);
      const elapsed = Date.now() - started;

      await waitUntilDead(pid, 1000);
      expect(groupAlive(pid)).toBe(false);
      // Drained on its own: no need to burn the full grace window.
      expect(elapsed).toBeLessThan(4000);
    },
    STOP_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "terminates a helper that outlives its parent without SIGKILL",
    async () => {
      // The parent shell exits on SIGTERM; the background sleep stays in the
      // process group and only dies from the follow-up SIGTERM to the group.
      const { proc, ready } = spawnDetachedWithReadiness("sleep 60 & echo ready; wait", "ready");
      await ready;
      const pid = await waitForPid(proc);

      const started = Date.now();
      await stopVSCodeProcess(proc, true, 5000, 1000);
      const elapsed = Date.now() - started;

      await waitUntilDead(pid, 2000);
      expect(groupAlive(pid)).toBe(false);
      expect(elapsed).toBeLessThan(8000);
    },
    STOP_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "force-kills a parent that ignores SIGTERM, then reaps the group",
    async () => {
      const { proc, ready } = spawnDetachedWithReadiness(
        'trap "" TERM; sleep 60 & echo ready; wait',
        "ready",
      );
      await ready;
      const pid = await waitForPid(proc);

      await stopVSCodeProcess(proc, true, 300, 1000);
      await waitUntilDead(pid, 2000);

      expect(groupAlive(pid)).toBe(false);
    },
    STOP_PROCESS_TEST_TIMEOUT_MS,
  );
});
