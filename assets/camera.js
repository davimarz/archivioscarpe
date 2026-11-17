/* Acquisizione dalla fotocamera per le schermate web. */
window.archivioCamera = (() => {
  const useNativeCapture = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  function takeDesktopPhoto({ gallery } = {}) {
    const dialog = document.createElement('dialog');
    const heading = document.createElement('h2');
    heading.id = 'archivio-camera-title';
    heading.textContent = 'Fotocamera';
    dialog.setAttribute('aria-labelledby', heading.id);
    dialog.className = 'archivio-camera';

    const preview = document.createElement('video');
    preview.autoplay = true;
    preview.playsInline = true;
    preview.muted = true;
    const status = document.createElement('p');
    status.setAttribute('role', 'status');
    status.textContent = 'Attendo il permesso per la fotocamera…';

    const snap = document.createElement('button');
    snap.textContent = 'Scatta foto';
    snap.disabled = true;
    const cancel = document.createElement('button');
    cancel.textContent = 'Annulla';
    const choose = document.createElement('button');
    choose.textContent = 'Scegli dalla galleria';
    choose.hidden = !gallery;
    dialog.append(heading, preview, status, snap, choose, cancel);
    document.body.append(dialog);

    return new Promise(resolve => {
      let stream;
      let closed = false;
      const stop = media => media?.getTracks().forEach(track => track.stop());
      const finish = photo => {
        if (closed) return;
        closed = true;
        stop(stream);
        preview.srcObject = null;
        dialog.remove();
        resolve(photo);
      };
      const ready = () => {
        if (!closed && preview.videoWidth && preview.videoHeight) {
          snap.disabled = false;
          status.textContent = '';
        }
      };
      preview.addEventListener('loadeddata', ready);
      preview.addEventListener('resize', ready);
      cancel.onclick = () => finish(null);
      choose.onclick = () => { finish(null); gallery(); };
      dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
      snap.onclick = () => {
        if (!preview.videoWidth || !preview.videoHeight) return;
        snap.disabled = true;
        try {
          const canvas = document.createElement('canvas');
          const scale = Math.min(1, 1024 / Math.max(preview.videoWidth, preview.videoHeight));
          canvas.width = Math.max(1, Math.round(preview.videoWidth * scale));
          canvas.height = Math.max(1, Math.round(preview.videoHeight * scale));
          canvas.getContext('2d').drawImage(preview, 0, 0, canvas.width, canvas.height);
          canvas.toBlob(blob => {
            if (blob) finish(blob);
            else {
              snap.disabled = false;
              status.textContent = 'Scatto non riuscito. Riprova o usa la galleria.';
            }
          }, 'image/jpeg', 0.86);
        } catch {
          snap.disabled = false;
          status.textContent = 'Scatto non riuscito. Riprova o usa la galleria.';
        }
      };

      dialog.showModal();
      const policy = document.permissionsPolicy || document.featurePolicy;
      if (policy?.allowsFeature('camera') === false || !navigator.mediaDevices?.getUserMedia) {
        status.textContent = 'La fotocamera non è disponibile in questa finestra. Apri il sito direttamente nel browser o usa la galleria.';
        if (window.top !== window) {
          const link = document.createElement('a');
          link.href = location.href;
          link.target = '_blank';
          link.rel = 'noopener';
          link.textContent = 'Apri in una nuova scheda';
          status.after(link);
        }
        return;
      }
      navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
        .then(async media => {
          if (closed) return stop(media);
          stream = media;
          preview.srcObject = stream;
          await preview.play();
          ready();
        })
        .catch(error => {
          if (closed) return;
          stop(stream);
          preview.srcObject = null;
          snap.disabled = true;
          status.textContent = error.name === 'NotAllowedError'
            ? 'Consenti l’uso della fotocamera nelle impostazioni del browser, poi riprova. Puoi anche scegliere una foto dalla galleria.'
            : 'La fotocamera è scollegata o occupata. Riprova o usa la galleria.';
        });
    });
  }

  return { useNativeCapture, takeDesktopPhoto };
})();
