(() => {
  const panel = document.createElement('aside');
  panel.className = 'ai-panel';
  panel.hidden = true;
  panel.setAttribute('aria-label', 'Phoenix AI assistant');
  panel.innerHTML = `<div class="ai-heading"><div class="ai-orb" aria-hidden="true"></div><div><h2>Phoenix assistant</h2><p class="ai-status" id="aiStatus" role="status">Optional AI support</p></div></div>
    <details open><summary>Talk and share what you see</summary><p>You can speak with our AI assistant while showing your equipment.</p>
    <label><input type="checkbox" id="aiConsent">I agree to use Retell for voice and send camera snapshots to Google for AI analysis when requested. Voice data is processed under the agent’s recording and retention settings.</label>
    <label><input type="checkbox" id="aiCamera" checked>Allow AI camera snapshots during this conversation</label>
    <small>Your technician camera session is separate. AI reads individual requested frames, not continuous video. Confirm nameplate readings before relying on them.</small></details>
    <div class="ai-buttons"><button id="aiStart" type="button">Talk to assistant</button><button id="aiEnd" type="button" disabled>End AI</button></div><p class="ai-transcript" id="aiTranscript" aria-live="polite"></p>`;
  document.body.append(panel);
  const mediaPanel = document.createElement('section');
  mediaPanel.className = 'ai-media'; mediaPanel.hidden = true; mediaPanel.setAttribute('aria-label', 'Assistant resource');
  document.body.append(mediaPanel);
  const el = id => document.getElementById(id);
  let clientSocket, call, starting = false, live = false, generation = 0, sdkPromise;
  const attachedSockets = new WeakSet();
  const status = text => { el('aiStatus').textContent = text; };
  function controls() { el('aiStart').disabled = starting || !!call; el('aiEnd').disabled = !starting && !call; panel.dataset.live = String(live); }
  function closeMedia() { const video = mediaPanel.querySelector('video'); if (video) video.pause(); mediaPanel.replaceChildren(); mediaPanel.hidden = true; }
  function disable() { generation++; const current = call; call = null; starting = false; live = false; clientSocket?.emit('assistant-disable'); if (current) Promise.resolve(current.end()).catch(() => {}); closeMedia(); status('AI ended · Technician camera stays connected'); controls(); }
  function acknowledge(event, data, timeout = 8000) {
    return new Promise((resolve, reject) => clientSocket.timeout(timeout).emit(event, data, (error, result) => error ? reject(error) : resolve(result)));
  }
  el('aiStart').onclick = async () => {
    if (!el('aiConsent').checked) { status('Please review and select the AI sharing consent first.'); return; }
    if (starting || call || !clientSocket?.connected) return;
    const turn = ++generation;
    starting = true; controls(); status('Connecting voice assistant…');
    try {
      const config = await acknowledge('assistant-enable', {});
      if (turn !== generation) { clientSocket.emit('assistant-disable'); return; }
      if (config.error) throw new Error(config.error);
      // Pinned published SDK. Keys for Google and Retell tools remain on the server.
      sdkPromise ||= import('https://esm.sh/retell-client-js-sdk@3.0.3?bundle');
      const { RetellClient } = await sdkPromise;
      if (turn !== generation) return;
      const client = new RetellClient({ key: config.publicKey });
      call = client.createWebCall({
        agent_id: config.agentId,
        metadata: { visual_session_id: config.sessionId, visual_token: config.token },
        retell_llm_dynamic_variables: { visual_support: 'true', camera_analysis: config.visionReady ? 'available on customer consent' : 'unavailable' },
        hooks: {
          onStatus: value => { if (turn !== generation) return; live = value === 'live'; starting = false; status(live ? 'Voice connected · Camera snapshots on request' : 'Voice '+value); controls(); },
          onEnd: () => { if (turn === generation) disable(); },
          onError: () => { if (turn === generation) { disable(); status('Voice unavailable. Technician support remains connected.'); } }
        }
      });
      // Transcript monitoring is off so the private session token is not rendered in tool traces.
      starting = false; controls();
      if (!config.visionReady) status('Voice connecting · Google camera analysis is not configured');
    } catch (error) { if (turn === generation) { disable(); status(error.message || 'Could not connect the assistant.'); } }
  };
  el('aiEnd').onclick = disable;
  el('aiConsent').onchange = () => { if (!el('aiConsent').checked) disable(); };
  window.PhoenixAssistant = {
    attach(socket) {
      if (clientSocket && clientSocket !== socket) disable();
      clientSocket = socket; panel.hidden = false;
      if (attachedSockets.has(socket)) return;
      attachedSockets.add(socket);
      socket.on('disconnect', () => { disable(); status('Connection lost. Restart AI after the session reconnects.'); });
      socket.on('assistant-frame-request', (_, ack) => {
        if (typeof ack !== 'function') return;
        const video = el('localVideo');
        if (!call || !live || !el('aiConsent').checked || !el('aiCamera').checked ||
            document.visibilityState !== 'visible' || !video?.srcObject?.getVideoTracks().some(t => t.readyState === 'live') ||
            video.readyState < 2 || !video.videoWidth || video.paused) return ack({ ok: false });
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, 1280 / video.videoWidth);
        canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
        const data = canvas.toDataURL('image/jpeg', .75).split(',')[1];
        ack(data.length <= 700000 ? { ok: true, data } : { ok: false });
        status('Camera snapshot shared with Google for analysis');
      });
      socket.on('assistant-resource', (resource, ack) => {
        if (typeof ack !== 'function') return;
        if (!call || !live || !el('aiConsent').checked) return ack({ ok: false });
        try {
          const url = new URL(resource.url); if (url.protocol !== 'https:' || !['video', 'pdf'].includes(resource.type)) throw new Error('Invalid resource');
          closeMedia();
          const header = document.createElement('header'), title = document.createElement('h2'), close = document.createElement('button');
          title.textContent = resource.title; close.textContent = 'Close'; close.type = 'button'; close.onclick = closeMedia;
          header.append(title, close); mediaPanel.append(header);
          if (resource.type === 'pdf') {
            url.hash = `page=${resource.page || 1}`;
            const obj = document.createElement('object'); obj.type = 'application/pdf'; obj.data = url.href; obj.setAttribute('aria-label',resource.title); mediaPanel.append(obj);
          } else {
            const video = document.createElement('video'); video.src = url.href; video.controls = true; video.playsInline = true;
            video.addEventListener('loadedmetadata', () => { if (Number.isFinite(video.duration)) video.currentTime = Math.min(resource.seconds || 0, video.duration); }, { once: true }); mediaPanel.append(video);
          }
          const link = document.createElement('a'); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'Open resource in a new tab'; mediaPanel.append(link);
          const note = document.createElement('p'); note.textContent = 'If the resource cannot play or display here, use the link above. Videos play when you press Play.'; mediaPanel.append(note);
          mediaPanel.hidden = false; close.focus(); ack({ ok: true });
        } catch { ack({ ok: false }); }
      });
    },
    end: disable
  };
  window.addEventListener('pagehide', disable);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && (call || starting)) disable(); });
})();
