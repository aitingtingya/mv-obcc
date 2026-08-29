// Per-call workspace projection that preserves the original DSH Agent identity.

import { AsyncLocalStorage } from 'node:async_hooks';

function bindMethod(target, value) {
  return typeof value === 'function' ? value.bind(target) : value;
}

function projectedSession(session, workspacePath) {
  const header = Object.freeze({ ...session.header, cwd: workspacePath });
  return new Proxy(session, {
    get(target, property) {
      if (property === 'header') return header;
      return bindMethod(target, Reflect.get(target, property, target));
    },
  });
}

export class WorkspaceRuntimeProjection {
  constructor() {
    this.storage = new AsyncLocalStorage();
    this.records = new WeakMap();
    this.agents = new Set();
    this.disposed = false;
  }

  install(agent) {
    if (!agent || (typeof agent !== 'object' && typeof agent !== 'function')) {
      throw new Error('workspace projection requires a live DSH Agent');
    }
    const existing = this.records.get(agent);
    if (existing) return existing;
    if (this.disposed) throw new Error('workspace projection is disposed');

    const ownDescriptor = Object.getOwnPropertyDescriptor(agent, 'session');
    if (ownDescriptor && ownDescriptor.configurable !== true) {
      throw new Error('DSH Agent.session is not configurable; per-call workspace projection is unavailable');
    }
    if (!ownDescriptor && !Object.isExtensible(agent)) {
      throw new Error('DSH Agent is not extensible; per-call workspace projection is unavailable');
    }

    const baseSession = agent.session;
    if (!baseSession?.header || typeof baseSession.header !== 'object') {
      throw new Error('DSH Agent.session.header is unavailable');
    }

    const record = {
      agent,
      ownDescriptor,
      baseSession,
      sessions: new Map(),
      active: 0,
      disposeRequested: false,
      getter: null,
    };
    const getter = () => {
      const active = this.storage.getStore();
      return active?.agent === agent ? active.session : baseSession;
    };
    record.getter = getter;
    Object.defineProperty(agent, 'session', {
      configurable: true,
      enumerable: ownDescriptor?.enumerable ?? true,
      get: getter,
    });
    this.records.set(agent, record);
    this.agents.add(agent);
    return record;
  }

  workspaceSession(record, workspacePath) {
    let session = record.sessions.get(workspacePath);
    if (!session) {
      session = projectedSession(record.baseSession, workspacePath);
      record.sessions.set(workspacePath, session);
    }
    return session;
  }

  async run(agent, workspacePath, callback) {
    if (typeof workspacePath !== 'string' || workspacePath.length === 0) {
      throw new Error('workspace projection requires a non-empty root path');
    }
    const record = this.install(agent);
    if (record.disposeRequested) throw new Error('workspace projection is being disposed');
    record.active += 1;
    try {
      const session = this.workspaceSession(record, workspacePath);
      return await this.storage.run({ agent, session, workspacePath }, callback);
    } finally {
      record.active -= 1;
      if (record.active === 0 && record.disposeRequested) this.restore(record);
    }
  }

  restore(record) {
    const current = Object.getOwnPropertyDescriptor(record.agent, 'session');
    if (current?.get === record.getter) {
      if (record.ownDescriptor) Object.defineProperty(record.agent, 'session', record.ownDescriptor);
      else delete record.agent.session;
    }
    record.sessions.clear();
    this.records.delete(record.agent);
    this.agents.delete(record.agent);
  }

  disposeAgent(agent) {
    const record = this.records.get(agent);
    if (!record) return;
    record.disposeRequested = true;
    if (record.active === 0) this.restore(record);
  }

  dispose() {
    this.disposed = true;
    for (const agent of [...this.agents]) this.disposeAgent(agent);
  }
}
