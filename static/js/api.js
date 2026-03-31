// api.js — fetch() wrappers for all REST endpoints

const BASE = '';

async function request(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(BASE + path, opts);
  if (res.status === 204) return null;
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const api = {
  // Graph
  fetchGraph: (namespace = '') =>
    request('GET', `/api/graph${namespace ? `?namespace=${encodeURIComponent(namespace)}` : ''}`),

  // Resources
  listResources: (params = {}) => {
    const q = new URLSearchParams(params).toString();
    return request('GET', `/api/resources${q ? '?' + q : ''}`);
  },
  getResource: (id) => request('GET', `/api/resources/${encodeURIComponent(id)}`),
  createResource: (node) => request('POST', '/api/resources', node),
  updateResource: (id, node) => request('PUT', `/api/resources/${encodeURIComponent(id)}`, node),
  deleteResource: (id) => request('DELETE', `/api/resources/${encodeURIComponent(id)}`),

  // Edges
  listEdges: () => request('GET', '/api/edges'),
  createEdge: (edge) => request('POST', '/api/edges', edge),
  deleteEdge: (id) => request('DELETE', `/api/edges/${encodeURIComponent(id)}`),

  // Simulate
  scale: (resourceID, replicas) =>
    request('POST', '/api/simulate/scale', { resourceID, replicas }),
  setPodPhase: (resourceID, phase) =>
    request('POST', '/api/simulate/pod-phase', { resourceID, phase }),
  bindPVC: (pvcID, pvID) =>
    request('POST', '/api/simulate/pvc-bind', { pvcID, pvID }),
  reset: () => request('POST', '/api/simulate/reset'),
  unbindPVC: (pvcID) => request('POST', '/api/simulate/pvc-unbind', { pvcID }),
  runScenario: (name, opts = {}) => request('POST', '/api/simulate/scenario', { name, ...opts }),
  uninstall: (release) => request('POST', '/api/simulate/uninstall', { release }),
  deleteNamespace: (namespace) => request('POST', '/api/simulate/delete-namespace', { namespace }),
  bootstrap: (action, opts = {}) => request('POST', '/api/simulate/bootstrap', { action, ...opts }),
  simulateFailure: (type, resourceID) => request('POST', '/api/simulate/failure', { type, resourceID }),
  rollingUpdate: () => request('POST', '/api/simulate/rolling-update', {}),
  setSpeed: (multiplier) => request('POST', '/api/simulate/speed', { multiplier }),

  // Versions
  listVersions: () => request('GET', '/api/versions'),
  versionFeatures: (ver) => request('GET', `/api/versions/${ver}/features`),
  versionChangelog: (ver) => request('GET', `/api/versions/${ver}/changelog`),
  setVersion: (version) => request('POST', '/api/versions/set', { version }),

  // CRD Schemas
  schemaIndex: () => request('GET', '/api/schemas'),
  fetchSchema: (kind, version = '') =>
    request('GET', `/api/schemas/${encodeURIComponent(kind)}${version ? `?version=${encodeURIComponent(version)}` : ''}`),
};
