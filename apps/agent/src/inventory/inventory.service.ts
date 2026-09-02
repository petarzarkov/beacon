import {
  arch,
  cpus,
  hostname,
  networkInterfaces,
  platform,
  release,
  totalmem,
} from 'node:os';
import type {
  AgentInventory,
  InventoryDisk,
  InventoryNic,
} from '@beacon/contract';

/** Mount prefixes that are kernel/pseudo filesystems, not real storage. */
const PSEUDO_MOUNTS = ['/proc', '/sys', '/dev', '/run', '/snap'] as const;

/** Pseudo filesystem types `df -T` reports that are not disks. */
const PSEUDO_TYPES = new Set([
  'tmpfs',
  'devtmpfs',
  'squashfs',
  'overlay',
  'proc',
  'sysfs',
  'devpts',
  'cgroup',
  'cgroup2',
  'ramfs',
]);

/**
 * The hardware and OS facts of this host: what it *is*, as against a report,
 * which is what it is *doing*.
 *
 * Everything but disks comes from `node:os`, which is native and cross-platform,
 * so the core snapshot answers on any host with no shell at all. Disks need `df`,
 * which is POSIX; on a host without it the list is simply empty rather than the
 * whole snapshot failing - inventory is best-effort, and a partial answer beats
 * none.
 */
export class InventoryService {
  collect(): AgentInventory {
    const cores = cpus();
    return {
      hostname: hostname(),
      platform: platform(),
      osRelease: release(),
      arch: arch(),
      cpuModel: cores[0]?.model.trim() ?? 'unknown',
      cpuCores: cores.length,
      memTotalBytes: totalmem(),
      disks: this.#disks(),
      nics: this.#nics(),
      collectedAt: new Date().toISOString(),
    };
  }

  /**
   * Real filesystems and their usage, via `df`. `-k` gives 1024-byte blocks (so
   * the maths is exact), `-P` one line per filesystem (POSIX output), `-T` the
   * type where the platform supports it - and when it does not, the type column
   * is simply absent and the parse falls back. Pseudo filesystems are dropped so
   * the list is the disks an operator cares about, not tmpfs and cgroups.
   */
  #disks(): readonly InventoryDisk[] {
    const raw = this.#df('-kPT') ?? this.#df('-kP');
    if (raw === null) return [];
    return raw
      .split('\n')
      .slice(1) // the header
      .map((line) => this.#parseDf(line))
      .filter((disk): disk is InventoryDisk => disk !== null)
      .slice(0, 128);
  }

  #df(flags: string): string | null {
    try {
      const result = Bun.spawnSync(['df', flags], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      if (!result.success) return null;
      const out = new TextDecoder().decode(result.stdout).trim();
      return out === '' ? null : out;
    } catch {
      return null;
    }
  }

  /**
   * One `df` line to a disk, or null if it is a pseudo filesystem or unparsable.
   *
   * The columns differ by whether `-T` was honoured: with a type it is
   * `fs type 1k-blocks used avail cap mount`, without it the type is gone. The
   * type column is the one non-numeric field after the device, so its presence
   * is detected rather than assumed.
   */
  #parseDf(line: string): InventoryDisk | null {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) return null;
    const hasType = !/^\d+$/.test(parts[1] ?? '');
    const fsType = hasType ? (parts[1] ?? '') : '';
    const nums = hasType ? parts.slice(2) : parts.slice(1);
    const total = Number(nums[0]);
    const used = Number(nums[1]);
    const mount = nums.slice(4).join(' ');
    if (!Number.isFinite(total) || total <= 0 || mount === '') return null;
    if (PSEUDO_TYPES.has(fsType)) return null;
    if (PSEUDO_MOUNTS.some((p) => mount === p || mount.startsWith(`${p}/`))) {
      return null;
    }
    return {
      mount,
      fsType,
      totalBytes: total * 1024,
      usedBytes: Number.isFinite(used) ? used * 1024 : 0,
    };
  }

  /**
   * Network interfaces with their hardware address and bound IPs. Loopback and
   * other internal interfaces are dropped - an operator matching a host to a box
   * wants its real addresses, not `127.0.0.1`.
   */
  #nics(): readonly InventoryNic[] {
    const nics: InventoryNic[] = [];
    for (const [name, entries] of Object.entries(networkInterfaces())) {
      const external = (entries ?? []).filter((entry) => !entry.internal);
      if (external.length === 0) continue;
      nics.push({
        name,
        mac: external[0]?.mac ?? '',
        addresses: external.map((entry) => entry.address),
      });
    }
    return nics;
  }
}
