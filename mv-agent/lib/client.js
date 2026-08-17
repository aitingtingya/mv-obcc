// DSH browser half for @mv-aide/mv-agent. This file intentionally uses DSH's
// published ModuleLoader wrapper directly: it has no runtime imports and stays
// compatible with both rc.5 and rc.6 client module graphs.

window.__ModuleLoader__.load({
  id: '@mv-aide/mv-agent',
  factory: () => {
    const module = { exports: {} };
    const exports = module.exports;

    const inject = ['sessions'];
    const CONTROL_PATH = '/api/mv-agent/active-session';
    const INITIAL_RECONNECT_MS = 250;
    const MAX_RECONNECT_MS = 5000;

    function controlUrl() {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${protocol}//${window.location.host}${CONTROL_PATH}`;
    }

    function activeReport(sessions) {
      const snapshot = sessions.list.getSnapshot();
      const sessionId = typeof snapshot.current === 'string' ? snapshot.current : null;
      const cwd = sessionId === null ? undefined : snapshot.byId?.[sessionId]?.cwd;
      return {
        type: 'active-session',
        sessionId,
        ...(typeof cwd === 'string' && cwd.length > 0 ? { cwd } : {}),
      };
    }

    function apply(ctx) {
      ctx.effect(() => {
        let disposed = false;
        let socket = null;
        let reconnectTimer = null;
        let reconnectDelay = INITIAL_RECONNECT_MS;
        let reportedSessionId = null;
        let reportedCwd;

        const send = (payload) => {
          if (socket?.readyState !== WebSocket.OPEN) return false;
          socket.send(JSON.stringify(payload));
          return true;
        };

        const reportCurrent = () => {
          const next = activeReport(ctx.sessions);
          if (socket?.readyState !== WebSocket.OPEN) return;
          if (reportedSessionId !== null && reportedSessionId !== next.sessionId) {
            // Revoke first. The host processes WebSocket frames in order, so a
            // switch never leaves the previous conversation connected while
            // the new one is being activated.
            send({ type: 'active-session', sessionId: null });
            reportedSessionId = null;
            reportedCwd = undefined;
          }
          if (reportedSessionId === next.sessionId && reportedCwd === next.cwd) return;
          if (send(next)) {
            reportedSessionId = next.sessionId;
            reportedCwd = next.cwd;
          }
        };

        const scheduleReconnect = () => {
          if (disposed || reconnectTimer !== null) return;
          const delay = reconnectDelay;
          reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_MS);
          reconnectTimer = window.setTimeout(() => {
            reconnectTimer = null;
            connect();
          }, delay);
        };

        const connect = () => {
          if (disposed) return;
          let next;
          try {
            next = new WebSocket(controlUrl());
          } catch {
            scheduleReconnect();
            return;
          }
          socket = next;
          next.addEventListener('open', () => {
            if (disposed || socket !== next) {
              next.close();
              return;
            }
            reconnectDelay = INITIAL_RECONNECT_MS;
            reportedSessionId = null;
            reportedCwd = undefined;
            reportCurrent();
          });
          next.addEventListener('close', () => {
            if (socket === next) socket = null;
            reportedSessionId = null;
            reportedCwd = undefined;
            scheduleReconnect();
          });
          next.addEventListener('error', () => {
            // `close` owns retry scheduling and keeps one timer per frontend.
            try {
              next.close();
            } catch {
              /* ignore */
            }
          });
        };

        const unsubscribe = ctx.sessions.list.subscribe(reportCurrent);
        const closeForPageExit = () => {
          if (socket?.readyState === WebSocket.OPEN) {
            send({ type: 'active-session', sessionId: null });
          }
          socket?.close(1000, 'frontend leaving');
        };
        window.addEventListener('pagehide', closeForPageExit);
        connect();

        return () => {
          disposed = true;
          unsubscribe();
          window.removeEventListener('pagehide', closeForPageExit);
          if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
          reconnectTimer = null;
          closeForPageExit();
          socket = null;
        };
      }, 'mv-agent: active conversation control');
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
