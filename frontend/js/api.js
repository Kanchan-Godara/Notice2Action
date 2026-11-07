/* api.js - the ONLY place that talks to the Flask backend. Every function returns a Promise. */

/* api.js
   Handles all communication between the frontend and Flask backend.
*/

// Mock mode is disabled because we are using the real Flask backend.
const USE_MOCK = false;

// Flask backend address.
const API_BASE = 'http://127.0.0.1:5001/api';

// Fake responses (used only if mock mode is enabled).
const MOCK = {
  '/dashboard': {
    total_notices: 0,
    open_tasks: 0,
    due_soon: 0,
    recent: []
  },
  '/notices': [],
  '/settings': {},
  '/status': { ok: true }
};

const API = {

  // Main function for sending requests to Flask.
  async req(path, opts = {}) {

    // Return fake data if mock mode is enabled.
    if (USE_MOCK) {
      const key = '/' + path.split('?')[0].split('/')[1];
      return MOCK[key] ?? [];
    }

    let res;

    try {
      res = await fetch(API_BASE + path, opts);
    } catch (error) {
      throw new Error(
        'Cannot connect to Flask. Make sure backend/app.py is running on port 5001.'
      );
    }

    let data = null;

    try {
      data = await res.json();
    } catch (error) {
      // Response does not contain JSON.
    }

    if (!res.ok) {
      throw new Error(
        (data && data.error) || `Request failed (${res.status})`
      );
    }

    return data;
  },

  // GET request.
  get: (path) => API.req(path),

  // POST, PUT and PATCH requests.
  send: (method, path, body) => API.req(path, {
    method: method,
    headers: {
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  }),

  // Analyse pasted notice text.
  analyseText: (text, title) =>
    API.send('POST', '/notices', {
      text: text,
      title: title
    }),

  // Upload PDF with progress tracking.
  uploadPdf(file, title, onProgress = () => {}) {

    return new Promise((resolve, reject) => {

      if (USE_MOCK) {
        reject(new Error('PDF upload requires the real backend.'));
        return;
      }

      const xhr = new XMLHttpRequest();

      xhr.open('POST', API_BASE + '/notices');

      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          onProgress(event.loaded / event.total);
        }
      };

      xhr.onload = () => {
        let data = null;

        try {
          data = JSON.parse(xhr.responseText);
        } catch (error) {
          // Ignore invalid JSON.
        }

        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(data);
        } else {
          reject(
            new Error(
              (data && data.error) || `Upload failed (${xhr.status})`
            )
          );
        }
      };

      xhr.onerror = () => {
        reject(new Error('Cannot connect to the Flask backend.'));
      };

      const form = new FormData();

      form.append('file', file);

      if (title) {
        form.append('title', title);
      }

      xhr.send(form);
    });
  }
};
