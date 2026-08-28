const res = await fetch('/api/info');
if (res.ok) {
  const info = await res.json();
  document.getElementById('root').textContent = info.rootPath;
  document.getElementById('port').textContent = `127.0.0.1:${info.port}`;
  document.getElementById('version').textContent = `v${info.version}`;
} else {
  document.getElementById('root').textContent = '(/api/info unavailable)';
}
