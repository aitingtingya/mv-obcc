// DSH browser half for @mv-aide/mv-agent. This file intentionally uses DSH's
// published ModuleLoader wrapper directly: it has no runtime imports and stays
// compatible with both rc.5 and rc.6 client module graphs.

window.__ModuleLoader__.load({
  id: '@mv-aide/mv-agent',
  factory: () => {
    const module = { exports: {} };
    const exports = module.exports;

    const inject = ['sessions', 'conversation'];
    const CONTROL_PATH = '/api/mv-agent/active-session';
    const INITIAL_RECONNECT_MS = 250;
    const MAX_RECONNECT_MS = 5000;
    const ACTIVE_REPORT_INTERVAL_MS = 5000;

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

    const IMAGE_ENCODER_MARK = Symbol.for('@mv-aide/mv-agent/image-upload-preprocessor');
    const SUPPORTED_UPLOAD_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

    function installImageUploadPreprocessor(ctx) {
      const conversation = typeof ctx?.get === 'function'
        ? ctx.get('conversation')
        : ctx?.conversation;
      if (!conversation || typeof conversation.encodeImage !== 'function') return;
      const current = conversation.encodeImage;
      if (current?.[IMAGE_ENCODER_MARK]) return;
      const wrapper = async function encodeImageWithMvAideFit(file) {
        const sessionId = activeReport(ctx.sessions).sessionId;
        if (sessionId === null || typeof window.fetch !== 'function') {
          return current.call(this, file);
        }
        // Only the preprocessing contract's media types take the fit detour;
        // everything else goes straight to DSH's native admission path.
        const uploadType = typeof file?.type === 'string'
          ? file.type.split(';')[0].trim().toLowerCase()
          : '';
        if (!SUPPORTED_UPLOAD_MEDIA_TYPES.has(uploadType)) {
          return current.call(this, file);
        }
        let response;
        try {
          response = await window.fetch(
            `/api/mv-agent/image-fit?sessionId=${encodeURIComponent(sessionId)}`,
            { method: 'POST', headers: { 'Content-Type': file.type }, body: file },
          );
        } catch (error) {
          // Rejected values may come from another realm, so read `message`
          // structurally instead of relying on instanceof.
          const reason = typeof error?.message === 'string' && error.message.length > 0
            ? error.message
            : String(error);
          throw new Error(`图片自动缩放失败：${reason}`);
        }
        if (response.status === 204) return current.call(this, file);
        if (!response.ok) {
          let detail = `HTTP ${response.status}`;
          try {
            const payload = await response.json();
            if (typeof payload?.error === 'string') detail = payload.error;
          } catch {
            // Keep the stable HTTP fallback when the response is not JSON.
          }
          throw new Error(`图片自动缩放失败：${detail}`);
        }
        const bytes = await response.arrayBuffer();
        const mediaType = response.headers.get('content-type') || file.type;
        const fitted = new File([bytes], file.name, {
          type: mediaType,
          lastModified: file.lastModified,
        });
        return current.call(this, fitted);
      };
      Object.defineProperty(wrapper, IMAGE_ENCODER_MARK, { value: { original: current } });
      conversation.encodeImage = wrapper;
      ctx.effect(() => () => {
        if (conversation.encodeImage === wrapper) conversation.encodeImage = current;
      }, 'mv-agent: image upload preprocessor');
    }

    function apply(ctx) {
      installImageUploadPreprocessor(ctx);
      ctx.effect(() => {
        let disposed = false;
        let socket = null;
        let reconnectTimer = null;
        let reportTimer = null;
        let reconnectDelay = INITIAL_RECONNECT_MS;
        let reportedSessionId = null;
        let reportedCwd;

        const send = (payload) => {
          if (socket?.readyState !== WebSocket.OPEN) return false;
          socket.send(JSON.stringify(payload));
          return true;
        };

        const reportCurrent = (force = false) => {
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
          if (!force && reportedSessionId === next.sessionId && reportedCwd === next.cwd) return;
          if (send(next)) {
            reportedSessionId = next.sessionId;
            reportedCwd = next.cwd;
          }
        };

        const clearReportTimer = () => {
          if (reportTimer !== null) window.clearTimeout(reportTimer);
          reportTimer = null;
        };

        const scheduleReportHeartbeat = () => {
          if (disposed || reportTimer !== null || socket?.readyState !== WebSocket.OPEN) return;
          reportTimer = window.setTimeout(() => {
            reportTimer = null;
            if (disposed || socket?.readyState !== WebSocket.OPEN) return;
            reportCurrent(true);
            scheduleReportHeartbeat();
          }, ACTIVE_REPORT_INTERVAL_MS);
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
            scheduleReportHeartbeat();
          });
          next.addEventListener('close', () => {
            if (socket === next) socket = null;
            clearReportTimer();
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
        // BFCache restore: timers/network may have been frozen mid-life. An
        // open socket force-reports immediately; a dead socket accelerates any
        // pending reconnect (cancelling its timer) instead of racing it, so
        // two live control sockets can never coexist.
        const handlePageShow = (event) => {
          if (!event?.persisted) return;
          if (socket !== null) {
            if (socket.readyState === WebSocket.OPEN) reportCurrent(true);
            return;
          }
          if (reconnectTimer !== null) {
            window.clearTimeout(reconnectTimer);
            reconnectTimer = null;
            reconnectDelay = INITIAL_RECONNECT_MS;
          }
          connect();
        };
        window.addEventListener('pagehide', closeForPageExit);
        window.addEventListener('pageshow', handlePageShow);
        connect();

        return () => {
          disposed = true;
          unsubscribe();
          window.removeEventListener('pagehide', closeForPageExit);
          window.removeEventListener('pageshow', handlePageShow);
          if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
          reconnectTimer = null;
          clearReportTimer();
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
