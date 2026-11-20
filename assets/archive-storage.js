'use strict';

window.shoeArchiveStorage = (() => {
  let connection;
  function open() {
    return connection ||= new Promise((resolve, reject) => {
      const request = indexedDB.open('archivio-scarpe', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('archive');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Chiudi le altre schede di Archivio Scarpe e riprova.'));
    });
  }

  async function get() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const request = db.transaction('archive').objectStore('archive').get('state');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function commit(state, expectedRevision) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('archive', 'readwrite');
      const store = transaction.objectStore('archive');
      let conflict = false;
      const request = store.get('state');
      request.onsuccess = () => {
        if ((request.result?.revision ?? null) !== expectedRevision) {
          conflict = true;
          transaction.abort();
          return;
        }
        store.put(state, 'state');
      };
      transaction.oncomplete = resolve;
      transaction.onabort = () => reject(conflict
        ? new Error('L’archivio è cambiato in un’altra scheda. Ricarica la pagina prima di salvare.')
        : transaction.error || new Error('Scrittura interrotta.'));
    });
  }
  return { get, commit };
})();
