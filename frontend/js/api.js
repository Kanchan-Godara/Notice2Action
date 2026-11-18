/* api.js - the ONLY place that talks to the Flask backend.
   Every function returns a Promise. */

// Flask backend address. Open the frontend at http://127.0.0.1:<port> (not "localhost")
// so the login cookie is treated as same-site and is sent with every request.
const API_BASE = 'http://127.0.0.1:5001/api';

const API = {

  // Main function for sending requests to Flask.
  async req(path, opts = {}) {
    let res;

    try {
      res = await fetch(API_BASE + path, {
        ...opts,
        credentials: 'include',          // send the session cookie
      });
    } catch (error) {
      throw new Error('Cannot connect to Flask. Make sure backend/app.py is running on port 5001.');
    }

    let data = null;
    try {
      data = await res.json();
    } catch (error) {
      // Response does not contain JSON (for example 204 No Content).
    }

    if (!res.ok) {
      // Session expired while using the app: send the student back to login.
      // /auth/* is excluded so a wrong password or the startup "am I logged in?" check
      // does not trigger a redirect.
      if (res.status === 401 && !path.startsWith('/auth/')) {
        if (typeof state !== 'undefined') state.user = null;
        location.hash = '#/login';
      }
      throw new Error((data && data.error) || `Request failed (${res.status})`);
    }

    return data;
  },

  // GET request.
  get: (path) => API.req(path),

  // POST, PUT, PATCH and DELETE requests.
  send: (method, path, body) => API.req(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }),

  // Analyse pasted notice text.
  analyseText: (text, title) => API.send('POST', '/notices', { text, title }),

  // Upload a PDF with progress tracking.
  uploadPdf(file, title, onProgress = () => {}) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();

      xhr.open('POST', API_BASE + '/notices');
      xhr.withCredentials = true;        // without this the session cookie is NOT sent

      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress(event.loaded / event.total);
      };

      xhr.onload = () => {
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch (error) { /* ignore invalid JSON */ }

        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(data);
        } else {
          if (xhr.status === 401) {
            if (typeof state !== 'undefined') state.user = null;
            location.hash = '#/login';
          }
          reject(new Error((data && data.error) || `Upload failed (${xhr.status})`));
        }
      };

      xhr.onerror = () => reject(new Error('Cannot connect to the Flask backend.'));

      const form = new FormData();
      form.append('file', file);
      if (title) form.append('title', title);

      xhr.send(form);
    });
  },
};