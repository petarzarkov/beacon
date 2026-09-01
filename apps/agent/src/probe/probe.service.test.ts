import { describe, expect, it } from 'bun:test';
import { AppFactory, Module } from '@dunx/core';
import { AgentModule } from '../agent.module';
import { ProbeService } from './probe.service';

/**
 * Through the container rather than by calling `new ProbeService(...)`: what is
 * worth testing is that the wiring resolves, since a constructor parameter that
 * the transform did not record fails at boot and nowhere else.
 */
describe('ProbeService', () => {
  it('is constructed by the container and reports this host', async () => {
    @Module({ imports: [AgentModule.withSource({}), AgentModule] })
    class Root {}

    const app = await AppFactory.create(Root);
    try {
      const report = app.get(ProbeService).collect();
      expect(report.hostname.length).toBeGreaterThan(0);
      expect(report.agentVersion).toMatch(/^\d+\.\d+\.\d+$/);
      expect(report.memTotalBytes).toBeGreaterThan(report.memFreeBytes);
      // The agent's own footprint, the honest per-process stat the console shows.
      expect(report.agentMemBytes).toBeGreaterThan(0);
      expect(() => JSON.parse(JSON.stringify(report))).not.toThrow();
    } finally {
      await app.shutdown();
    }
  });
});
